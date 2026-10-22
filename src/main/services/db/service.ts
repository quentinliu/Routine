import type {
  CheckResult,
  CheckStatus,
  DatasourceConfig,
  DbTestResult,
  InspectionReport
} from '../../../shared/types';
import { getStorage } from '../storage';
import { createAdapter } from './connection';
import { normalizeVersion, versionGte, type DbAdapter } from './adapter';

const MAX_QUERY_ROWS = 200;

const READ_ONLY_FIRST_KEYWORDS = new Set(['select', 'show', 'explain', 'desc', 'describe']);

const FORBIDDEN_PATTERNS: Array<[RegExp, string]> = [
  [/\bfor\s+update\b/i, 'FOR UPDATE'],
  [/\block\s+in\s+share\s+mode\b/i, 'LOCK IN SHARE MODE'],
  [/\binto\s+(outfile|dumpfile)\b/i, 'INTO OUTFILE'],
  [/\bpg_sleep\s*\(/i, 'pg_sleep'],
  [/\bsleep\s*\(/i, 'sleep()']
];

/** 只读守卫：首词白名单 + 单语句 + 显式写锁/副作用关键字拒绝。校验失败抛错。 */
export function assertReadOnlySql(sql: string): void {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('SQL 不能为空');
  if (/;/.test(trimmed)) throw new Error('只读模式仅允许单条语句（不接受多语句）');
  const first = trimmed.split(/\s+/)[0]?.toLowerCase() ?? '';
  if (!READ_ONLY_FIRST_KEYWORDS.has(first)) {
    throw new Error(`只读模式不允许 ${first.toUpperCase()} 语句（仅 SELECT/SHOW/EXPLAIN/DESC）`);
  }
  for (const [pattern, label] of FORBIDDEN_PATTERNS) {
    if (pattern.test(trimmed)) throw new Error(`只读模式禁止包含 ${label}`);
  }
}

function maskDatasource(ds: DatasourceConfig): DatasourceConfig {
  return { ...ds, password: '' };
}

interface CachedConn {
  adapter: DbAdapter;
  ds: DatasourceConfig;
}

export class DbService {
  private readonly conns = new Map<string, CachedConn>();

  list(): DatasourceConfig[] {
    return getStorage().loadDatasources().map(maskDatasource);
  }

  save(input: DatasourceConfig): DatasourceConfig {
    const name = String(input.name ?? '').trim();
    const host = String(input.host ?? '').trim();
    const port = Number(input.port);
    const user = String(input.user ?? '').trim();
    if (!name) throw new Error('数据源名称不能为空');
    if (!host) throw new Error('主机地址不能为空');
    if (!Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('端口无效');
    if (!user) throw new Error('用户名不能为空');
    if (input.type !== 'mysql' && input.type !== 'postgresql') {
      throw new Error(`不支持的数据库类型: ${input.type}`);
    }

    const all = getStorage().loadDatasources();
    const existing = input.id ? all.find((d) => d.id === input.id) : undefined;
    const password = input.password || existing?.password || '';
    const ds: DatasourceConfig = {
      ...(existing ?? {}),
      ...input,
      id: existing?.id ?? crypto.randomUUID(),
      name,
      host,
      port,
      user,
      password,
      enabled: input.enabled ?? true
    };
    const next = existing ? all.map((d) => (d.id === ds.id ? ds : d)) : [...all, ds];
    getStorage().saveDatasources(next);
    return maskDatasource(ds);
  }

  remove(id: string): void {
    const all = getStorage().loadDatasources();
    getStorage().saveDatasources(all.filter((d) => d.id !== id));
    void this.dropConn(id);
  }

  private async getConn(id: string): Promise<CachedConn> {
    const cached = this.conns.get(id);
    if (cached) return cached;
    const ds = getStorage().loadDatasources().find((d) => d.id === id);
    if (!ds) throw new Error(`数据源不存在: ${id}`);
    if (!ds.enabled) throw new Error(`数据源「${ds.name}」已停用`);
    const entry: CachedConn = { adapter: await createAdapter(ds), ds };
    this.conns.set(id, entry);
    return entry;
  }

  private async dropConn(id: string): Promise<void> {
    const cached = this.conns.get(id);
    this.conns.delete(id);
    if (cached) await cached.adapter.destroy();
  }

  async test(id: string): Promise<DbTestResult> {
    const ds = getStorage().loadDatasources().find((d) => d.id === id);
    if (!ds) throw new Error(`数据源不存在: ${id}`);
    const started = Date.now();
    let adapter: DbAdapter | null = null;
    try {
      adapter = await createAdapter(ds);
      const version = await adapter.serverVersion();
      return { ok: true, version, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        version: '',
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err)
      };
    } finally {
      if (adapter) await adapter.destroy();
    }
  }

  /** 只读查询：供 Agent 工具与 skill 步骤使用，主进程强制守卫 */
  async query(id: string, sql: string): Promise<Record<string, unknown>[]> {
    assertReadOnlySql(sql);
    const { adapter } = await this.getConn(id);
    const rows = await adapter.query<Record<string, unknown>>(sql);
    return rows.slice(0, MAX_QUERY_ROWS);
  }

  /** 写操作 / 会话管理：medium 风险，调用方必须先过安全门 */
  async exec(id: string, sql: string): Promise<Record<string, unknown>[]> {
    const trimmed = sql.trim().replace(/;\s*$/, '');
    if (!trimmed) throw new Error('SQL 不能为空');
    if (/;/.test(trimmed)) throw new Error('仅允许单条语句');
    const { adapter } = await this.getConn(id);
    const rows = await adapter.query<Record<string, unknown>>(trimmed);
    return rows.slice(0, MAX_QUERY_ROWS);
  }

  async serverVersion(id: string): Promise<string> {
    const { adapter } = await this.getConn(id);
    return adapter.serverVersion();
  }

  /** 基础巡检：版本 + 连接水位。完整运维诊断由 skills 承担，这里只留既有 IPC 契约的最小实现 */
  async inspect(
    id: string,
    emitProgress?: (line: string) => void
  ): Promise<InspectionReport> {
    const ds = getStorage().loadDatasources().find((d) => d.id === id);
    if (!ds) throw new Error(`数据源不存在: ${id}`);
    const started = Date.now();
    const results: CheckResult[] = [];
    const push = (checkId: string, title: string, status: CheckStatus, value?: string) => {
      results.push({ checkId, title, status, value, detail: [], durationMs: 0 });
      emitProgress?.(`${title}: ${value ?? status}`);
    };
    let version = '';
    try {
      const { adapter } = await this.getConn(id);
      const vStart = Date.now();
      version = await adapter.serverVersion();
      const numeric = normalizeVersion(version);
      push('connectivity', '连通性', 'ok', `版本 ${version}（${Date.now() - vStart}ms）`);

      if (ds.type === 'mysql') {
        const rows = await adapter.query<Record<string, unknown>>(
          "SHOW GLOBAL STATUS WHERE Variable_name IN ('Threads_connected')"
        );
        const vars = await adapter.query<Record<string, unknown>>(
          "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections')"
        );
        const connected = Number(rows.find((r) => r.Variable_name === 'Threads_connected')?.Value ?? 0);
        const max = Number(vars.find((r) => r.Variable_name === 'max_connections')?.Value ?? 0);
        const ratio = max > 0 ? connected / max : 0;
        push(
          'connection-watermark',
          '连接水位',
          ratio > 0.85 ? 'warn' : 'ok',
          `${connected}/${max}（${Math.round(ratio * 100)}%）`
        );
      } else {
        const rows = await adapter.query<Record<string, unknown>>(
          'SELECT count(*)::int AS n FROM pg_stat_activity'
        );
        const vars = await adapter.query<Record<string, unknown>>(
          "SELECT setting FROM pg_settings WHERE name = 'max_connections'"
        );
        const connected = Number(rows[0]?.n ?? 0);
        const max = Number(vars[0]?.setting ?? 0);
        const ratio = max > 0 ? connected / max : 0;
        push(
          'connection-watermark',
          '连接水位',
          ratio > 0.85 ? 'warn' : 'ok',
          `${connected}/${max}（${Math.round(ratio * 100)}%）`
        );
      }
      if (numeric.length > 0 && versionGte(numeric, [8, 0])) {
        push('version-support', '版本支持', 'ok', '受支持的现代版本');
      } else {
        push('version-support', '版本支持', 'warn', '旧版本，部分诊断视图可能不可用');
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      push('connectivity', '连通性', 'error', msg);
    }

    return {
      id: crypto.randomUUID(),
      datasourceId: ds.id,
      datasourceName: ds.name,
      startedAt: started,
      finishedAt: Date.now(),
      ok: results.every((r) => r.status !== 'error'),
      serverVersion: version,
      results
    };
  }

  async disposeAll(): Promise<void> {
    for (const id of [...this.conns.keys()]) {
      await this.dropConn(id);
    }
  }
}

let service: DbService | null = null;

export function getDbService(): DbService {
  if (!service) service = new DbService();
  return service;
}

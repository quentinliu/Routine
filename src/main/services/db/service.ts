import type {
  DatasourceConfig,
  DbObjectsResult,
  DbOverview,
  DbQueryResult,
  DbTestResult
} from '../../../shared/types';
import { getStorage } from '../storage';
import { redactSecrets } from '../../util/redact';
import { createAdapter } from './connection';
import type { DbAdapter } from './adapter';
import { collectOverview } from './overview';
import { collectObjects } from './schema';
import { buildQueryResult, isConnectionError } from './result';

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

/** 写/管理语句只允许单条：去掉结尾分号后不得再出现分号 */
function normalizeWriteSql(sql: string): string {
  const trimmed = sql.trim().replace(/;\s*$/, '');
  if (!trimmed) throw new Error('SQL 不能为空');
  if (/;/.test(trimmed)) throw new Error('仅允许单条语句');
  return trimmed;
}

/** 对外载荷统一脱敏：含密钥字段必须过 redact（CONTRACTS 约定） */
function maskDatasource(ds: DatasourceConfig): DatasourceConfig {
  return redactSecrets(ds, ['password']);
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

  /** 连接级失败清缓存（下次请求自动重连）；普通 SQL 错误保留连接 */
  private async run<T>(
    id: string,
    fn: (adapter: DbAdapter, ds: DatasourceConfig) => Promise<T>
  ): Promise<T> {
    const { adapter, ds } = await this.getConn(id);
    try {
      return await fn(adapter, ds);
    } catch (err) {
      if (isConnectionError(err)) await this.dropConn(id);
      throw err;
    }
  }

  /** 只读查询：供 Agent 工具与 skill 步骤使用，主进程强制守卫 */
  async query(id: string, sql: string): Promise<Record<string, unknown>[]> {
    assertReadOnlySql(sql);
    return this.run(id, async (adapter) => {
      const rows = await adapter.query<Record<string, unknown>>(sql);
      return rows.slice(0, MAX_QUERY_ROWS);
    });
  }

  /** 查询台：只读 + 结果元信息（列名 / 耗时 / 是否截断） */
  async readResult(id: string, sql: string): Promise<DbQueryResult> {
    assertReadOnlySql(sql);
    return this.run(id, async (adapter) => {
      const started = Date.now();
      const rows = await adapter.query<Record<string, unknown>>(sql);
      return buildQueryResult(sql, rows, Date.now() - started);
    });
  }

  /** 写操作 / 会话管理：medium 风险，调用方必须先过安全门 */
  async exec(id: string, sql: string): Promise<Record<string, unknown>[]> {
    const trimmed = normalizeWriteSql(sql);
    return this.run(id, async (adapter) => {
      const rows = await adapter.query<Record<string, unknown>>(trimmed);
      return rows.slice(0, MAX_QUERY_ROWS);
    });
  }

  /** 工作台写操作：与 exec 同一校验，返回结果元信息（调用方已过安全门） */
  async execResult(id: string, sql: string): Promise<DbQueryResult> {
    const trimmed = normalizeWriteSql(sql);
    return this.run(id, async (adapter) => {
      const started = Date.now();
      const rows = await adapter.query<Record<string, unknown>>(trimmed);
      return buildQueryResult(trimmed, rows, Date.now() - started);
    });
  }

  async serverVersion(id: string): Promise<string> {
    return this.run(id, (adapter) => adapter.serverVersion());
  }

  /** 实时实例概览：一次性采样，不落库（工作台打开 / 手动刷新时调用） */
  async overview(id: string): Promise<DbOverview> {
    return this.run(id, async (adapter, ds) => {
      const started = Date.now();
      // 版本取不到等同不可用：直接抛出，交给 IPC 错误层
      const version = await adapter.serverVersion();
      const body = await collectOverview(adapter, ds.type, version);
      return {
        ...body,
        datasourceId: id,
        collectedAt: started,
        durationMs: Date.now() - started
      };
    });
  }

  /** 三层对象浏览：库列表 / 表列表 / 表详情 */
  async objects(id: string, database?: string, table?: string): Promise<DbObjectsResult> {
    return this.run(id, (adapter, ds) => collectObjects(adapter, ds.type, database, table));
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

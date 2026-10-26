import type { DbDialect, DbOverview, DbQueryResult } from '../../shared/types';

const PROMPT_LIMIT = 6000;
const CELL_LIMIT = 60;

export function fmtInt(value?: number): string {
  if (value === undefined || !Number.isFinite(value)) return '—';
  const rounded = Math.round(value);
  const sign = rounded < 0 ? '-' : '';
  const digits = String(Math.abs(rounded));
  let out = '';
  for (let i = 0; i < digits.length; i++) {
    if (i > 0 && (digits.length - i) % 3 === 0) out += ',';
    out += digits[i];
  }
  return sign + out;
}

export function fmtBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes)) return '—';
  if (bytes < 1024) return `${bytes}B`;
  const units = ['KB', 'MB', 'GB', 'TB', 'PB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  return `${value.toFixed(value >= 100 ? 0 : 1)}${units[unit]}`;
}

export function fmtUptime(sec?: number): string {
  if (sec === undefined || !Number.isFinite(sec) || sec <= 0) return '—';
  const days = Math.floor(sec / 86400);
  const hours = Math.floor((sec % 86400) / 3600);
  const minutes = Math.floor((sec % 3600) / 60);
  if (days > 0) return `${days}天${hours}小时`;
  if (hours > 0) return `${hours}小时${minutes}分`;
  return `${minutes}分`;
}

export function fmtMs(ms?: number): string {
  if (ms === undefined || !Number.isFinite(ms)) return '—';
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  return `${Math.round(ms)}ms`;
}

/** 方言标识符转义：MySQL 反引号、PostgreSQL 双引号；拒绝控制字符 */
export function escapeIdent(name: string, type: DbDialect): string {
  const clean = name.replace(/[\u0000-\u001f]/g, '');
  if (type === 'mysql') return `\`${clean.replace(/`/g, '``')}\``;
  return `"${clean.replace(/"/g, '""')}"`;
}

/** 「查看数据」预填：只读 SELECT，带 LIMIT 100 */
export function previewSelectSql(database: string, table: string, type: DbDialect): string {
  const db = escapeIdent(database, type);
  const tbl = escapeIdent(table, type);
  const target = type === 'mysql' ? `${db}.${tbl}` : `${db}.${tbl}`;
  return `SELECT * FROM ${target} LIMIT 100;`;
}

export interface DiagnoseContext {
  name: string;
  id: string;
  database?: string;
}

export interface DiagnoseAction {
  id: string;
  title: string;
  description: string;
  skill: string;
  buildPrompt: (ctx: DiagnoseContext) => string;
}

function skillPrompt(ctx: DiagnoseContext, skill: string, focus: string): string {
  const scope = ctx.database ? `，默认库 ${ctx.database}` : '';
  return (
    `请对数据库「${ctx.name}」（datasourceId=${ctx.id}${scope}）做一次${focus}。\n` +
    `先用 skill.run 激活技能 ${skill}（datasourceId 同上），按手册步骤用 db.query 采集证据；` +
    `同类只读查询可并行提交。缺失的维度写「未获取：缺哪一项 + 原因」，不要用其它库的数据推测。\n` +
    `最后按严重程度输出结论、证据（含关键 SQL 与数值）与可执行的处理建议。`
  );
}

function action(
  id: string,
  title: string,
  description: string,
  skill: string,
  focus: string
): DiagnoseAction {
  return {
    id,
    title,
    description,
    skill,
    buildPrompt: (ctx) => skillPrompt(ctx, skill, focus)
  };
}

/** 按方言映射内置技能；PostgreSQL 只有通用手册，按场景拆成四个入口 */
export function diagnoseActions(type: DbDialect): DiagnoseAction[] {
  if (type === 'postgresql') {
    return [
      action('pg-perf', '性能与慢查询', '执行计划、索引命中与 TOP 耗时语句分析', 'postgres', '性能与慢查询诊断'),
      action('pg-lock', '连接与锁', '连接堆积、锁等待、长事务与空闲事务排查', 'postgres', '连接与锁等待诊断'),
      action('pg-capacity', '容量与膨胀', '表与索引膨胀、空间增长与清理空间评估', 'postgres', '容量与膨胀评估'),
      action('pg-replication', '复制与高可用', '主备复制状态、延迟与切换风险评估', 'postgres', '复制状态诊断')
    ];
  }
  return [
    action('slow', '慢查询诊断', '定位 TOP 慢 SQL，给出索引与改写建议', 'mysql-slow-query-diagnose', '慢查询诊断'),
    action('replication', '复制延迟', '定位主从延迟根因，给出安全处置顺序', 'mysql-replication-lag-resolver', '复制延迟诊断'),
    action('capacity', '容量预警', '磁盘/连接/QPS 增长归因与耗尽时间预测', 'mysql-capacity-early-warning', '容量预警分析'),
    action('deadlock', '死锁分析', '解析锁链与死锁模式，定位长事务', 'mysql-deadlock-analyzer', '死锁与锁等待分析'),
    action('schema', '表结构规范', '主键、字符集、冗余索引与大表未分区检查', 'mysql-schema-linter', '表结构规范检查'),
    action('health', '单实例体检', '连接、磁盘、复制、慢查询、内存一次过', 'mysql-batch-health-check', '单实例健康体检')
  ];
}

function clamp(text: string, limit = PROMPT_LIMIT): string {
  return text.length > limit ? `${text.slice(0, limit)}\n…（已截断）` : text;
}

function metricLines(overview: DbOverview): string {
  return overview.metrics
    .map((m) => `- ${m.label}：${m.display}${m.hint ? `（${m.hint}）` : ''}`)
    .join('\n');
}

/** 概览解读草稿：指标 + 会话/慢查询/容量 Top + 未获取维度 */
export function overviewPrompt(ctx: DiagnoseContext, overview: DbOverview): string {
  const sessions = overview.sessions
    .slice(0, 10)
    .map((s) => `- ${s.user}@${s.host} · ${s.database || '—'} · ${s.timeSec}s · ${s.sql || s.command}`)
    .join('\n');
  const slow = overview.slowQueries
    .slice(0, 10)
    .map((s) => `- 调用 ${s.calls} 次，平均 ${s.avgMs}ms，累计 ${s.totalMs}ms：${s.digest}`)
    .join('\n');
  const capacity = overview.capacity
    .slice(0, 10)
    .map((c) => `- ${c.database}.${c.table}：${fmtBytes(c.totalBytes)}，约 ${fmtInt(c.rows)} 行`)
    .join('\n');
  const unavailable = overview.unavailable
    .map((u) => `- ${u.label}：${u.reason}`)
    .join('\n');
  const replication =
    overview.replication.role === 'none'
      ? '未配置复制'
      : `${overview.replication.role}${
          overview.replication.lagSec !== undefined ? ` · 延迟 ${overview.replication.lagSec}s` : ''
        }`;

  return clamp(
    `请解读数据库「${ctx.name}」（datasourceId=${ctx.id}）的实时概览，并给出优先处理建议。\n\n` +
      `采样：${new Date(overview.collectedAt).toLocaleString()} · 耗时 ${overview.durationMs}ms · 版本 ${overview.version} · 运行 ${fmtUptime(overview.uptimeSec)}\n\n` +
      `指标：\n${metricLines(overview)}\n\n` +
      `活跃会话：\n${sessions || '- 无'}\n\n` +
      `慢查询 Top：\n${slow || '- 未获取'}\n\n` +
      `锁等待：${overview.locks.waiting} 个，最长 ${overview.locks.longestWaitSec}s\n` +
      `复制：${replication}\n\n` +
      `容量 Top：\n${capacity || '- 未获取'}\n\n` +
      `未获取：\n${unavailable || '- 无'}\n\n` +
      `要求：只基于以上数据下结论；按严重程度排序；每条结论附证据，并给出下一步可执行的 SQL 或操作。`
  );
}

/** 查询结果解读草稿：SQL + 前 50 行 markdown 表 */
export function queryPrompt(ctx: DiagnoseContext, result: DbQueryResult): string {
  const head = result.columns;
  const rows = result.rows.slice(0, 50).map((row) => {
    const cells = row.map((cell) => {
      const text = cell === null ? 'NULL' : String(cell).replace(/\|/g, '\\|');
      return text.length > CELL_LIMIT ? `${text.slice(0, CELL_LIMIT)}…` : text;
    });
    return `| ${cells.join(' | ')} |`;
  });
  const table =
    head.length > 0
      ? [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows].join('\n')
      : '（无列信息）';

  return clamp(
    `请分析下面这条只读查询在数据库「${ctx.name}」（datasourceId=${ctx.id}）上的结果。\n\n` +
      `SQL：\n\`\`\`sql\n${result.sql}\n\`\`\`\n\n` +
      `返回 ${result.rowCount} 行${result.truncated ? '（已截断，仅前 200 行）' : ''}，耗时 ${result.durationMs}ms。前 50 行：\n\n` +
      `${table}\n\n` +
      `要求：说明这组数据的含义与异常点；如需更多证据，给出下一步只读 SQL（单条、带 LIMIT）。不要编造未出现在结果中的数值。`
  );
}

export function customPrompt(ctx: DiagnoseContext): string {
  const scope = ctx.database ? `，默认库 ${ctx.database}` : '';
  return (
    `请对数据库「${ctx.name}」（datasourceId=${ctx.id}${scope}）做一次运维诊断。\n` +
    `先用 db.list 确认数据源，再按需要选择内置技能（skill.run）并用 db.query 采集证据；` +
    `缺失维度写「未获取」，不要推测。最后输出结论、关键证据与处理建议。`
  );
}

/** IPC 错误文案：Electron 会包一层 remote method，必须按 [CODE] 分型 */
export function toUserError(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const hit = raw.match(/\[(E_DENIED|E_TIMEOUT|E_CANCELED|INVALID)\]\s*([\s\S]*)$/);
  if (hit) {
    const tail = hit[2].trim();
    switch (hit[1]) {
      case 'E_DENIED':
        return '已取消执行';
      case 'E_TIMEOUT':
        return '确认超时（无人响应），未执行';
      case 'E_CANCELED':
        return '操作已中止，未执行';
      default:
        return tail || '参数不合法';
    }
  }
  return raw
    .replace(/^Error invoking remote method '[^']+':\s*/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

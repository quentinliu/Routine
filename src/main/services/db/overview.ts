import type {
  DbCapacityRow,
  DbDialect,
  DbLockInfo,
  DbMetricTone,
  DbOverview,
  DbOverviewMetric,
  DbReplicationInfo,
  DbSessionRow,
  DbSlowQueryRow,
  DbUnavailable
} from '../../../shared/types';
import type { DbAdapter } from './adapter';
import { errorText } from './result';

type OverviewBody = Omit<DbOverview, 'datasourceId' | 'collectedAt' | 'durationMs'>;

interface Collected {
  uptimeSec?: number;
  connectionsUsed?: number;
  maxConnections?: number;
  activeConnections?: number;
  qps?: number;
  /** 0-1 */
  hitRatio?: number;
  slowQueries?: number;
  deadlocks?: number;
  sessions: DbSessionRow[];
  slowRows: DbSlowQueryRow[];
  locks: DbLockInfo;
  replication: DbReplicationInfo;
  capacity: DbCapacityRow[];
}

function emptyCollected(): Collected {
  return {
    sessions: [],
    slowRows: [],
    locks: { waiting: 0, longestWaitSec: 0 },
    replication: { role: 'none' },
    capacity: []
  };
}

function num(value: unknown): number | undefined {
  if (value === null || value === undefined || value === '') return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function int(value: unknown): number {
  return Math.round(num(value) ?? 0);
}

function pct(ratio: number): string {
  return `${(ratio * 100).toFixed(ratio >= 0.9995 ? 0 : 1)}%`;
}

function fmtQps(qps?: number): string {
  if (qps === undefined) return '未获取';
  if (qps >= 1000) return `${(qps / 1000).toFixed(1)}k/s`;
  return `${qps.toFixed(qps >= 100 ? 0 : 1)}/s`;
}

function metric(
  key: string,
  label: string,
  display: string,
  tone: DbMetricTone,
  hint?: string,
  ratio?: number
): DbOverviewMetric {
  const out: DbOverviewMetric = { key, label, display, tone };
  if (hint) out.hint = hint;
  if (ratio !== undefined) out.ratio = Math.max(0, Math.min(100, Math.round(ratio)));
  return out;
}

function connectionTone(ratio?: number): DbMetricTone {
  if (ratio === undefined) return 'neutral';
  if (ratio >= 0.95) return 'danger';
  if (ratio >= 0.85) return 'warn';
  return 'ok';
}

function hitTone(ratio?: number): DbMetricTone {
  if (ratio === undefined) return 'neutral';
  if (ratio < 0.9) return 'danger';
  if (ratio < 0.99) return 'warn';
  return 'ok';
}

function buildMetrics(
  type: DbDialect,
  c: Collected,
  unavailable: DbUnavailable[]
): DbOverviewMetric[] {
  const missing = (key: string): string => {
    const reason = unavailable.find((u) => u.key === key)?.reason ?? '该维度不可用';
    return reason.length > 80 ? `${reason.slice(0, 80)}…` : reason;
  };

  const ratio =
    c.connectionsUsed !== undefined && c.maxConnections
      ? c.connectionsUsed / c.maxConnections
      : undefined;

  const connections = metric(
    'connections',
    '连接水位',
    c.connectionsUsed === undefined
      ? '未获取'
      : c.maxConnections
        ? `${c.connectionsUsed}/${c.maxConnections}`
        : `${c.connectionsUsed}`,
    c.connectionsUsed === undefined ? 'neutral' : connectionTone(ratio),
    c.connectionsUsed === undefined
      ? missing('status')
      : ratio !== undefined
        ? `${pct(ratio)} · 活跃 ${c.activeConnections ?? '—'}`
        : '上限未知',
    ratio === undefined ? undefined : ratio * 100
  );

  const qps = metric(
    'qps',
    '平均 QPS',
    fmtQps(c.qps),
    'neutral',
    c.qps === undefined ? missing('status') : '启动以来平均'
  );

  const hit = metric(
    'hit',
    '缓冲池命中',
    c.hitRatio === undefined ? '未获取' : pct(c.hitRatio),
    hitTone(c.hitRatio),
    c.hitRatio === undefined
      ? missing('status')
      : type === 'mysql'
        ? 'InnoDB 读请求'
        : 'shared buffers'
  );

  const active = metric(
    'active',
    '活跃会话',
    c.activeConnections === undefined ? '未获取' : String(c.activeConnections),
    'neutral',
    c.activeConnections === undefined
      ? missing('status')
      : type === 'mysql'
        ? 'Threads_running'
        : 'state = active'
  );

  const locksFailed = unavailable.some((u) => u.key === 'locks');
  const locks = metric(
    'locks',
    '锁等待',
    locksFailed ? '未获取' : String(c.locks.waiting),
    locksFailed ? 'neutral' : c.locks.waiting > 0 ? 'warn' : 'ok',
    locksFailed
      ? missing('locks')
      : c.locks.waiting > 0
        ? `最长等待 ${c.locks.longestWaitSec}s`
        : '无阻塞'
  );

  const slow = metric(
    'slow',
    type === 'mysql' ? '慢查询累计' : '累计死锁',
    type === 'mysql'
      ? c.slowQueries === undefined
        ? '未获取'
        : String(c.slowQueries)
      : c.deadlocks === undefined
        ? '未获取'
        : String(c.deadlocks),
    'neutral',
    type === 'mysql'
      ? c.slowQueries === undefined
        ? missing('status')
        : 'Slow_queries（启动以来）'
      : c.deadlocks === undefined
        ? missing('status')
        : 'pg_stat_database（启动以来）'
  );

  return [connections, qps, hit, active, locks, slow];
}

async function collectMySql(
  adapter: DbAdapter,
  unavailable: DbUnavailable[]
): Promise<Collected> {
  const c = emptyCollected();

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      "SHOW GLOBAL STATUS WHERE Variable_name IN ('Uptime','Questions','Threads_connected','Threads_running','Innodb_buffer_pool_read_requests','Innodb_buffer_pool_reads','Slow_queries')"
    );
    const map = new Map<string, number>();
    for (const row of rows) {
      map.set(String(row.Variable_name), num(row.Value) ?? 0);
    }
    c.uptimeSec = map.get('Uptime');
    c.connectionsUsed = map.get('Threads_connected');
    c.activeConnections = map.get('Threads_running');
    const uptime = c.uptimeSec ?? 0;
    const questions = map.get('Questions');
    c.qps = questions !== undefined && uptime > 0 ? questions / uptime : undefined;
    const requests = map.get('Innodb_buffer_pool_read_requests') ?? 0;
    const reads = map.get('Innodb_buffer_pool_reads') ?? 0;
    c.hitRatio = requests > 0 ? Math.max(0, (requests - reads) / requests) : undefined;
    c.slowQueries = map.get('Slow_queries');
  } catch (err) {
    unavailable.push({ key: 'status', label: '运行指标', reason: errorText(err) });
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      "SHOW GLOBAL VARIABLES WHERE Variable_name IN ('max_connections')"
    );
    c.maxConnections = num(rows[0]?.Value);
  } catch (err) {
    unavailable.push({ key: 'connections-limit', label: '连接上限', reason: errorText(err) });
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT ID AS id, USER AS user, HOST AS host, COALESCE(DB, '') AS db, COMMAND AS command,
              COALESCE(STATE, '') AS state, TIME AS time_sec, LEFT(COALESCE(INFO, ''), 200) AS info
       FROM information_schema.PROCESSLIST
       WHERE COMMAND <> 'Sleep'
       ORDER BY TIME DESC LIMIT 10`
    );
    c.sessions = rows.map((row) => ({
      id: String(row.id ?? ''),
      user: String(row.user ?? ''),
      host: String(row.host ?? ''),
      database: String(row.db ?? ''),
      command: String(row.command ?? ''),
      state: String(row.state ?? ''),
      timeSec: int(row.time_sec),
      sql: String(row.info ?? '')
    }));
  } catch (err) {
    unavailable.push({ key: 'sessions', label: '活跃会话', reason: errorText(err) });
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT DIGEST_TEXT AS digest, COUNT_STAR AS calls,
              AVG_TIMER_WAIT / 1000000000 AS avg_ms,
              SUM_TIMER_WAIT / 1000000000 AS total_ms
       FROM performance_schema.events_statements_summary_by_digest
       WHERE DIGEST_TEXT IS NOT NULL
       ORDER BY SUM_TIMER_WAIT DESC LIMIT 10`
    );
    c.slowRows = rows.map((row) => ({
      digest: String(row.digest ?? ''),
      calls: int(row.calls),
      avgMs: Number(num(row.avg_ms)?.toFixed(2) ?? 0),
      totalMs: Number(num(row.total_ms)?.toFixed(2) ?? 0)
    }));
  } catch (err) {
    unavailable.push({
      key: 'slow-top',
      label: '慢查询 Top',
      reason: `performance_schema 摘要不可用（${errorText(err)}）`
    });
  }

  try {
    let waiting = 0;
    try {
      const rows = await adapter.query<Record<string, unknown>>(
        'SELECT COUNT(*) AS n FROM performance_schema.data_lock_waits'
      );
      waiting = int(rows[0]?.n);
    } catch {
      const rows = await adapter.query<Record<string, unknown>>(
        'SELECT COUNT(*) AS n FROM information_schema.innodb_lock_waits'
      );
      waiting = int(rows[0]?.n);
    }
    const trx = await adapter.query<Record<string, unknown>>(
      `SELECT COALESCE(MAX(TIMESTAMPDIFF(SECOND, trx_started, NOW())), 0) AS longest
       FROM information_schema.innodb_trx WHERE trx_state = 'LOCK WAIT'`
    );
    c.locks = { waiting, longestWaitSec: int(trx[0]?.longest) };
  } catch (err) {
    unavailable.push({ key: 'locks', label: '锁等待', reason: errorText(err) });
  }

  try {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await adapter.query<Record<string, unknown>>('SHOW REPLICA STATUS');
    } catch {
      rows = await adapter.query<Record<string, unknown>>('SHOW SLAVE STATUS');
    }
    if (rows.length === 0) {
      c.replication = { role: 'none', hint: '未配置复制' };
    } else {
      const row = rows[0];
      const io = String(row.Replica_IO_Running ?? row.Slave_IO_Running ?? '');
      const sql = String(row.Replica_SQL_Running ?? row.Slave_SQL_Running ?? '');
      c.replication = {
        role: 'replica',
        lagSec: num(row.Seconds_Behind_Source ?? row.Seconds_Behind_Master),
        ioRunning: io.toLowerCase() === 'yes',
        sqlRunning: sql.toLowerCase() === 'yes',
        hint: String(row.Source_Host ?? row.Master_Host ?? '')
      };
    }
  } catch (err) {
    unavailable.push({ key: 'replication', label: '复制状态', reason: errorText(err) });
    c.replication = { role: 'unknown', hint: '权限不足或版本不支持' };
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT TABLE_SCHEMA AS db, TABLE_NAME AS tbl,
              COALESCE(TABLE_ROWS, 0) AS rows_count,
              COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
       ORDER BY bytes DESC LIMIT 10`
    );
    c.capacity = rows.map((row) => ({
      database: String(row.db ?? ''),
      table: String(row.tbl ?? ''),
      rows: int(row.rows_count),
      totalBytes: int(row.bytes)
    }));
  } catch (err) {
    unavailable.push({ key: 'capacity', label: '容量 Top', reason: errorText(err) });
  }

  return c;
}

async function collectPostgres(
  adapter: DbAdapter,
  unavailable: DbUnavailable[]
): Promise<Collected> {
  const c = emptyCollected();

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM pg_stat_activity WHERE datname IS NOT NULL)::int AS total,
         (SELECT COUNT(*) FROM pg_stat_activity WHERE state = 'active')::int AS active,
         EXTRACT(EPOCH FROM now() - pg_postmaster_start_time())::float8 AS uptime,
         (SELECT COALESCE(SUM(xact_commit + xact_rollback), 0) FROM pg_stat_database)::float8 AS xacts,
         (SELECT COALESCE(SUM(blks_hit), 0) FROM pg_stat_database)::float8 AS hit,
         (SELECT COALESCE(SUM(blks_read), 0) FROM pg_stat_database)::float8 AS read,
         (SELECT COALESCE(SUM(deadlocks), 0) FROM pg_stat_database)::float8 AS deadlocks`
    );
    const row = rows[0] ?? {};
    c.connectionsUsed = num(row.total);
    c.activeConnections = num(row.active);
    c.uptimeSec = num(row.uptime);
    const xacts = num(row.xacts);
    const uptime = c.uptimeSec ?? 0;
    c.qps = xacts !== undefined && uptime > 0 ? xacts / uptime : undefined;
    const hit = num(row.hit) ?? 0;
    const read = num(row.read) ?? 0;
    c.hitRatio = hit + read > 0 ? hit / (hit + read) : undefined;
    c.deadlocks = num(row.deadlocks);
  } catch (err) {
    unavailable.push({ key: 'status', label: '运行指标', reason: errorText(err) });
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      "SELECT setting::int AS max FROM pg_settings WHERE name = 'max_connections'"
    );
    c.maxConnections = num(rows[0]?.max);
  } catch (err) {
    unavailable.push({ key: 'connections-limit', label: '连接上限', reason: errorText(err) });
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT pid, COALESCE(usename, '') AS usename, COALESCE(client_addr::text, '') AS client_addr,
              COALESCE(datname, '') AS datname, COALESCE(state, '') AS state,
              COALESCE(EXTRACT(EPOCH FROM now() - query_start), 0)::float8 AS duration,
              LEFT(COALESCE(query, ''), 200) AS query
       FROM pg_stat_activity
       WHERE state <> 'idle' AND pid <> pg_backend_pid() AND query_start IS NOT NULL
       ORDER BY duration DESC LIMIT 10`
    );
    c.sessions = rows.map((row) => ({
      id: String(row.pid ?? ''),
      user: String(row.usename ?? ''),
      host: String(row.client_addr ?? ''),
      database: String(row.datname ?? ''),
      command: String(row.state ?? ''),
      state: String(row.state ?? ''),
      timeSec: int(row.duration),
      sql: String(row.query ?? '')
    }));
  } catch (err) {
    unavailable.push({ key: 'sessions', label: '活跃会话', reason: errorText(err) });
  }

  try {
    let rows: Array<Record<string, unknown>>;
    try {
      rows = await adapter.query<Record<string, unknown>>(
        `SELECT query, calls, mean_exec_time, total_exec_time
         FROM pg_stat_statements ORDER BY total_exec_time DESC LIMIT 10`
      );
    } catch {
      rows = await adapter.query<Record<string, unknown>>(
        `SELECT query, calls, mean_time, total_time
         FROM pg_stat_statements ORDER BY total_time DESC LIMIT 10`
      );
    }
    c.slowRows = rows.map((row) => ({
      digest: String(row.query ?? ''),
      calls: int(row.calls),
      avgMs: Number(num(row.mean_exec_time ?? row.mean_time)?.toFixed(2) ?? 0),
      totalMs: Number(num(row.total_exec_time ?? row.total_time)?.toFixed(2) ?? 0)
    }));
  } catch (err) {
    unavailable.push({
      key: 'slow-top',
      label: '慢查询 Top',
      reason: `需要启用 pg_stat_statements（${errorText(err)}）`
    });
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT
         (SELECT COUNT(*) FROM pg_locks WHERE NOT granted)::int AS waiting,
         COALESCE((SELECT MAX(EXTRACT(EPOCH FROM now() - query_start))
                   FROM pg_stat_activity
                   WHERE state <> 'idle' AND query_start IS NOT NULL
                     AND pid IN (SELECT pid FROM pg_locks WHERE NOT granted)), 0)::float8 AS longest`
    );
    c.locks = {
      waiting: int(rows[0]?.waiting),
      longestWaitSec: int(rows[0]?.longest)
    };
  } catch (err) {
    unavailable.push({ key: 'locks', label: '锁等待', reason: errorText(err) });
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT application_name,
              COALESCE(EXTRACT(EPOCH FROM replay_lag), 0)::float8 AS lag
       FROM pg_stat_replication`
    );
    if (rows.length > 0) {
      const lag = Math.max(...rows.map((row) => num(row.lag) ?? 0));
      c.replication = { role: 'primary', lagSec: lag, hint: `${rows.length} 个备库` };
    } else {
      const state = await adapter.query<Record<string, unknown>>(
        `SELECT pg_is_in_recovery() AS replica,
                COALESCE(EXTRACT(EPOCH FROM now() - pg_last_xact_replay_timestamp()), 0)::float8 AS lag`
      );
      const replica = state[0]?.replica === true;
      c.replication = replica
        ? { role: 'replica', lagSec: num(state[0]?.lag) }
        : { role: 'primary', hint: '未配置备库' };
    }
  } catch (err) {
    unavailable.push({ key: 'replication', label: '复制状态', reason: errorText(err) });
    c.replication = { role: 'unknown', hint: '权限不足或版本不支持' };
  }

  try {
    const rows = await adapter.query<Record<string, unknown>>(
      `SELECT n.nspname AS db, c.relname AS tbl,
              GREATEST(c.reltuples, 0)::bigint AS rows_count,
              pg_total_relation_size(c.oid)::bigint AS bytes
       FROM pg_class c
       JOIN pg_namespace n ON n.oid = c.relnamespace
       WHERE c.relkind = 'r' AND n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
       ORDER BY bytes DESC LIMIT 10`
    );
    c.capacity = rows.map((row) => ({
      database: String(row.db ?? ''),
      table: String(row.tbl ?? ''),
      rows: int(row.rows_count),
      totalBytes: int(row.bytes)
    }));
  } catch (err) {
    unavailable.push({ key: 'capacity', label: '容量 Top', reason: errorText(err) });
  }

  return c;
}

/** 概览采集：只有版本取不到才整体失败（等同不可用），其余维度独立降级 */
export async function collectOverview(
  adapter: DbAdapter,
  type: DbDialect,
  version: string
): Promise<OverviewBody> {
  const unavailable: DbUnavailable[] = [];
  const collected =
    type === 'mysql' ? await collectMySql(adapter, unavailable) : await collectPostgres(adapter, unavailable);
  return {
    version,
    uptimeSec: Math.round(collected.uptimeSec ?? 0),
    metrics: buildMetrics(type, collected, unavailable),
    sessions: collected.sessions,
    slowQueries: collected.slowRows,
    locks: collected.locks,
    replication: collected.replication,
    capacity: collected.capacity,
    unavailable
  };
}

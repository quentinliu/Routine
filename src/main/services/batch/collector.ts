import type {
  BatchDimensionName,
  BatchDimensionResult,
  BatchDimensionStatus,
  BatchInstanceResult,
  DatasourceConfig,
  DbOverview,
  DbOverviewMetric
} from '../../../shared/types';
import { BATCH_DIMENSIONS } from '../../../shared/types';
import { getDbService } from '../db/service';
import { computeHealthScore } from './contract';

interface DimensionDraft {
  status: BatchDimensionStatus;
  value?: number;
  display?: string;
  evidence?: string;
  reason?: string;
}

/**
 * 把 DbOverview 一次性实时采样映射成技能手册的 6 个健康维度。
 * 原则：有证据才给结论；0 行 / 无基线一律 unavailable 或显式说明，
 * 绝不把「没采到」写成 ok，也不推断趋势（U13 / U4 / U7 事故链）。
 */
export function buildDimensions(o: DbOverview): BatchDimensionResult[] {
  const reasonFor = (keys: readonly string[]): string | undefined => {
    const hit = o.unavailable.find((u) => keys.includes(u.key));
    return hit ? `${hit.label}：${hit.reason}` : undefined;
  };
  const metric = (key: string): DbOverviewMetric | undefined =>
    o.metrics.find((m) => m.key === key);
  const dim = (name: BatchDimensionName, draft: DimensionDraft): BatchDimensionResult => ({
    name,
    ...draft
  });

  // 1. 连接水位：<70% ok / 70-85% warn / >85% error
  const conn = metric('connections');
  const connReason = reasonFor(['status', 'connections-limit']);
  let connections: DimensionDraft;
  if (connReason) {
    connections = { status: 'unavailable', reason: connReason };
  } else if (conn && typeof conn.ratio === 'number') {
    const v = conn.ratio;
    connections = {
      status: v > 85 ? 'error' : v >= 70 ? 'warn' : 'ok',
      value: v,
      display: conn.display,
      evidence: `db:overview metrics.connections = ${conn.display}（阈值 70% / 85%）`
    };
  } else if (conn) {
    connections = {
      status: 'ok',
      display: conn.display,
      evidence: `db:overview metrics.connections = ${conn.display}；无水位比率，不做阈值判定`
    };
  } else {
    connections = { status: 'unavailable', reason: '未获取到连接水位指标' };
  }

  // 2. 容量 / 存储：容量表 0 行必须显式复核，不能当成健康
  const capReason = reasonFor(['capacity']);
  const totalBytes = o.capacity.reduce((n, r) => n + (Number(r.totalBytes) || 0), 0);
  let disk: DimensionDraft;
  if (capReason) {
    disk = { status: 'unavailable', reason: capReason };
  } else if (o.capacity.length === 0) {
    disk = {
      status: 'unavailable',
      reason: '容量采样返回 0 行，无法区分空库与采集失败',
      evidence: 'SELECT ... FROM information_schema.TABLES 返回 0 行，需复核'
    };
  } else {
    disk = {
      status: 'ok',
      value: totalBytes,
      display: `${(totalBytes / 1024 / 1024 / 1024).toFixed(2)} GB`,
      evidence: `db:overview capacity：${o.capacity.length} 张表，合计 ${totalBytes} 字节；本期快照，无磁盘总量基线`
    };
  }

  // 3. 复制状态：none = 未配置（不是异常）；lag >60s warn / >300s error
  const replReason = reasonFor(['replication']);
  const repl = o.replication;
  let replication: DimensionDraft;
  if (replReason) {
    replication = { status: 'unavailable', reason: replReason };
  } else if (repl.role === 'none') {
    replication = { status: 'skipped', reason: '未配置复制（不是异常）' };
  } else if (repl.role === 'unknown') {
    replication = { status: 'unavailable', reason: repl.hint ?? '复制角色未知' };
  } else {
    const broken = repl.ioRunning === false || repl.sqlRunning === false;
    const lag = repl.lagSec;
    if (typeof lag !== 'number' && !broken) {
      replication = {
        status: 'unavailable',
        reason: '复制延迟未获取到',
        evidence: `db:overview replication role=${repl.role}`
      };
    } else {
      const v = typeof lag === 'number' ? lag : 0;
      replication = {
        status: broken ? 'error' : v > 300 ? 'error' : v > 60 ? 'warn' : 'ok',
        value: v,
        display: `${v}s`,
        evidence: `db:overview replication role=${repl.role}, lagSec=${v}, ioRunning=${String(repl.ioRunning)}, sqlRunning=${String(repl.sqlRunning)}（阈值 60s / 300s）`
      };
    }
  }

  // 4. 慢查询：有慢查询标 warn（需 TOP N 关注）；0 行必须带复核说明
  const slowReason = reasonFor(['slow-top']);
  const slowMetric = metric('slow');
  const slowCount = o.slowQueries.length;
  const top = o.slowQueries[0];
  let slowQueries: DimensionDraft;
  if (slowReason) {
    slowQueries = { status: 'unavailable', reason: slowReason };
  } else if (slowCount > 0 && top) {
    slowQueries = {
      status: 'warn',
      value: slowCount,
      display: `${slowCount} 条慢查询`,
      evidence: `db:overview slowQueries：${slowCount} 条；最高 avgMs=${top.avgMs}，digest=${top.digest.slice(0, 80)}`
    };
  } else if (slowMetric) {
    slowQueries = {
      status: 'ok',
      value: 0,
      display: slowMetric.display,
      evidence: `db:overview metrics.slow = ${slowMetric.display}；slowQueries 返回 0 行，需复核（0 行不等于健康）`
    };
  } else {
    slowQueries = {
      status: 'unavailable',
      reason: '未获取到慢查询统计',
      evidence: 'db:overview slowQueries = 0 行且无 slow 指标，需复核'
    };
  }

  // 5. QPS：无基线不做 ±30% 判定，只记录本期快照
  const qps = metric('qps');
  const qpsReason = reasonFor(['status']);
  const qpsDim: DimensionDraft = qps
    ? {
        status: 'ok',
        display: qps.display,
        evidence: `db:overview metrics.qps = ${qps.display}；本期快照，无基线不做趋势判定`
      }
    : { status: 'unavailable', reason: qpsReason ?? '未获取到 QPS 指标' };

  // 6. 缓冲池命中：<95% error / 95-99% warn / >99% ok
  const hit = metric('hit');
  let memory: DimensionDraft;
  if (hit && typeof hit.ratio === 'number') {
    const v = hit.ratio;
    memory = {
      status: v < 95 ? 'error' : v < 99 ? 'warn' : 'ok',
      value: v,
      display: hit.display,
      evidence: `db:overview metrics.hit = ${hit.display}（阈值 95% / 99%）`
    };
  } else if (hit) {
    memory = {
      status: 'ok',
      display: hit.display,
      evidence: `db:overview metrics.hit = ${hit.display}；无比率，不做阈值判定`
    };
  } else {
    memory = { status: 'unavailable', reason: qpsReason ?? '未获取到缓冲池命中率指标' };
  }

  return [
    dim('connections', connections),
    dim('disk', disk),
    dim('replication', replication),
    dim('slowQueries', slowQueries),
    dim('qps', qpsDim),
    dim('memory', memory)
  ];
}

function unavailableAll(reason: string): BatchDimensionResult[] {
  return BATCH_DIMENSIONS.map((name) => ({
    name,
    status: 'unavailable' as const,
    reason
  }));
}

/**
 * 单实例只读采集。全程只走 DbService.overview（等价 db.query 白名单只读路径），
 * 不触碰 medium 工具，因此批量作业没有逐窗审批。
 * signal 由 worker 池用于取消；底层查询不支持中断，超时结果会被丢弃而非写成成功。
 */
export async function collectInstance(
  jobId: string,
  workerId: string,
  ds: DatasourceConfig,
  attempt: number,
  signal: AbortSignal
): Promise<BatchInstanceResult> {
  const startedAt = Date.now();
  const base = {
    jobId,
    workerId,
    datasourceId: ds.id,
    datasourceName: ds.name,
    attempt,
    durationMs: 0
  };
  if (signal.aborted) {
    return {
      ...base,
      dimensions: unavailableAll('任务已中止'),
      ok: false,
      error: '任务已中止',
      durationMs: Date.now() - startedAt
    };
  }
  try {
    const overview = await getDbService().overview(ds.id);
    const dimensions = buildDimensions(overview);
    const hasEvidence = dimensions.some(
      (d) => d.status === 'ok' || d.status === 'warn' || d.status === 'error'
    );
    return {
      ...base,
      dimensions,
      healthScore: computeHealthScore(dimensions),
      ok: hasEvidence,
      durationMs: Date.now() - startedAt
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      ...base,
      dimensions: unavailableAll(message),
      ok: false,
      error: message,
      durationMs: Date.now() - startedAt
    };
  }
}

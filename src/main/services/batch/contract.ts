import { randomUUID } from 'node:crypto';
import {
  BATCH_DIMENSIONS,
  type BatchDimensionName,
  type BatchDimensionResult,
  type BatchEstimate,
  type BatchInstanceResult,
  type BatchJob,
  type BatchJobInput,
  type BatchJobMode,
  type BatchReport
} from '../../../shared/types';

/** 批量作业默认参数；UI 发起时可覆盖，主进程统一钳制 */
export const BATCH_DEFAULTS = {
  batchSize: 20,
  concurrency: 4,
  timeoutMs: 20 * 60_000,
  maxRetries: 1,
  llmBudget: 40
} as const;

/** 6 维权重来自 resources/skills/mysql-batch-health-check/SKILL.md 的健康分表 */
export const DIMENSION_META: Record<BatchDimensionName, { label: string; weight: number }> = {
  connections: { label: '连接水位', weight: 20 },
  disk: { label: '容量 / 存储', weight: 25 },
  replication: { label: '复制状态', weight: 20 },
  slowQueries: { label: '慢查询', weight: 15 },
  qps: { label: 'QPS / 吞吐', weight: 10 },
  memory: { label: '缓冲池命中', weight: 10 }
};

export const DIMENSION_LABELS: Record<BatchDimensionName, string> = Object.fromEntries(
  BATCH_DIMENSIONS.map((name) => [name, DIMENSION_META[name].label])
) as Record<BatchDimensionName, string>;

export type ScoreBand = 'healthy' | 'attention' | 'warning' | 'critical';

const STATUS_SCORE: Record<'ok' | 'warn' | 'error', number> = {
  ok: 100,
  warn: 60,
  error: 20
};

function clampInt(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

/** 确定性分片：派发单元是「一批 datasourceId」，不是单库 */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  const step = Math.max(1, Math.floor(size));
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/**
 * 归一化作业输入：过滤未配置 / 已禁用 / 重复的数据源，钳制全部数值。
 * 目标集走「分配」语义，不复用会话 @ 引用的 MAX_SESSION_REFS=10 限制语义。
 */
export function normalizeBatchInput(
  input: BatchJobInput,
  enabledIds: readonly string[]
): BatchJob {
  const allowed = new Set(enabledIds);
  const ids = [
    ...new Set(
      (Array.isArray(input.datasourceIds) ? input.datasourceIds : []).filter(
        (id): id is string => typeof id === 'string' && allowed.has(id)
      )
    )
  ];
  if (ids.length === 0) throw new Error('[INVALID] 没有可巡检的已启用数据源');
  const mode: BatchJobMode = input.mode === 'llm-full' ? 'llm-full' : 'hybrid';
  return {
    id: randomUUID(),
    name: String(input.name ?? '').trim() || `批量巡检 · ${new Date().toLocaleString('zh-CN')}`,
    mode,
    datasourceIds: ids,
    batchSize: clampInt(input.batchSize, BATCH_DEFAULTS.batchSize, 1, 100),
    concurrency: clampInt(input.concurrency, BATCH_DEFAULTS.concurrency, 1, 16),
    timeoutMs: clampInt(input.timeoutMs, BATCH_DEFAULTS.timeoutMs, 10_000, 60 * 60_000),
    maxRetries: clampInt(input.maxRetries, BATCH_DEFAULTS.maxRetries, 0, 3),
    llmBudget: clampInt(input.llmBudget, BATCH_DEFAULTS.llmBudget, 0, 200),
    createdAt: Date.now(),
    state: 'created'
  };
}

/** 发起前展示的成本估算（估算值，不是承诺；作业内另有真实计数） */
export function estimateJob(job: BatchJob): BatchEstimate {
  const total = job.datasourceIds.length;
  const workers = Math.ceil(total / job.batchSize);
  const llmDecisions = job.mode === 'llm-full' ? Math.min(job.llmBudget, 4) + 1 : 1;
  const sqlQueries = total * BATCH_DIMENSIONS.length;
  const estimatedSeconds = Math.ceil(workers / job.concurrency) * 8 + llmDecisions * 5;
  return { total, workers, llmDecisions, sqlQueries, estimatedSeconds };
}

/**
 * 健康分只在「无 unavailable 维度」时给出；skipped（如未配置复制）不拉低分数，
 * 权重按剩余维度归一化。对齐 U13 事故：skipped 单列，不参与通过率。
 */
export function computeHealthScore(
  dims: readonly BatchDimensionResult[]
): number | undefined {
  if (dims.length !== BATCH_DIMENSIONS.length) return undefined;
  const byName = new Map(dims.map((d) => [d.name, d]));
  let weighted = 0;
  let weight = 0;
  for (const name of BATCH_DIMENSIONS) {
    const d = byName.get(name);
    if (!d) return undefined;
    if (d.status === 'unavailable') return undefined;
    if (d.status === 'skipped') continue;
    weighted += STATUS_SCORE[d.status] * DIMENSION_META[name].weight;
    weight += DIMENSION_META[name].weight;
  }
  if (weight === 0) return undefined;
  return Math.round(weighted / weight);
}

export function scoreBand(score: number): ScoreBand {
  if (score >= 90) return 'healthy';
  if (score >= 70) return 'attention';
  if (score >= 50) return 'warning';
  return 'critical';
}

/**
 * 汇总只吃结构化结果：数字全部来自 WorkerResult，不由 LLM 生成表格。
 * topN = 有健康分且 <90 的实例（升序）+ 采集失败的实例，最多 20 条。
 */
export function buildReport(
  jobId: string,
  results: readonly BatchInstanceResult[],
  summary: string,
  summarySource: BatchReport['summarySource']
): BatchReport {
  const bands: Record<ScoreBand, number> = {
    healthy: 0,
    attention: 0,
    warning: 0,
    critical: 0
  };
  const scored = results.filter(
    (r): r is BatchInstanceResult & { healthScore: number } =>
      typeof r.healthScore === 'number'
  );
  for (const r of scored) bands[scoreBand(r.healthScore)] += 1;
  const anomalous = scored
    .filter((r) => r.healthScore < 90)
    .sort((a, b) => a.healthScore - b.healthScore);
  const failed = results.filter((r) => !r.ok && typeof r.healthScore !== 'number');
  return {
    jobId,
    generatedAt: Date.now(),
    total: results.length,
    succeeded: results.filter((r) => r.ok).length,
    failed: results.filter((r) => !r.ok).length,
    unavailableDimensions: results.reduce(
      (n, r) => n + r.dimensions.filter((d) => d.status === 'unavailable').length,
      0
    ),
    healthy: bands.healthy,
    attention: bands.attention,
    warning: bands.warning,
    critical: bands.critical,
    topN: [...anomalous, ...failed].slice(0, 20),
    summary,
    summarySource
  };
}

/** 可重试错误限定为连接 / 超时 / 临时不可达；权限、语法、取消不重试 */
export function isRetryableError(message: string): boolean {
  const m = message.toLowerCase();
  if (m.includes('abort') || m.includes('cancel') || m.includes('中止')) return false;
  if (m.includes('denied') || m.includes('permission') || m.includes('access')) return false;
  if (m.includes('syntax') || m.includes('unknown column') || m.includes('只读模式')) {
    return false;
  }
  return true;
}

/** 纯结构化摘要：LLM 不可用时报告仍完整，绝不编造数字 */
export function buildStructuredSummary(report: BatchReport): string {
  const lines = [
    `本次巡检 ${report.total} 台实例：成功 ${report.succeeded} 台，失败 ${report.failed} 台。`,
    `健康分分布：健康 ${report.healthy}、需关注 ${report.attention}、告警 ${report.warning}、严重 ${report.critical}；未获取维度 ${report.unavailableDimensions} 项。`,
    report.topN.length > 0
      ? `优先处理 ${report.topN.length} 台异常实例，详见 TOP N 表；每台结论均可下钻查看采集证据。`
      : '未发现需要优先处理的异常实例。',
    '本报告为本期实时快照，不做趋势或历史对比；标注「未获取」的维度不推断健康结论。'
  ];
  return lines.join('\n');
}

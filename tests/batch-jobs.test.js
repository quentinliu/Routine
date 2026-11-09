'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  BATCH_DEFAULTS,
  chunk,
  normalizeBatchInput,
  estimateJob,
  computeHealthScore,
  scoreBand,
  buildReport,
  isRetryableError,
  buildStructuredSummary
} = require('../dist-main/main/services/batch/contract.js');
const { buildDimensions } = require('../dist-main/main/services/batch/collector.js');

const DIM_NAMES = ['connections', 'disk', 'replication', 'slowQueries', 'qps', 'memory'];

function okDims() {
  return DIM_NAMES.map((name) => ({ name, status: 'ok' }));
}

function overview(overrides = {}) {
  return {
    datasourceId: 'ds-1',
    collectedAt: Date.now(),
    durationMs: 12,
    version: '8.0.36',
    uptimeSec: 3600,
    metrics: [
      { key: 'connections', label: '连接', display: '12/151 (8%)', ratio: 8, tone: 'ok' },
      { key: 'qps', label: 'QPS', display: '1.2k/s', tone: 'neutral' },
      { key: 'hit', label: '命中率', display: '99.8%', ratio: 99.8, tone: 'ok' },
      { key: 'slow', label: '慢查询', display: '0/s', tone: 'ok' }
    ],
    sessions: [],
    slowQueries: [],
    locks: { waiting: 0, longestWaitSec: 0 },
    replication: { role: 'none' },
    capacity: [{ database: 'app', table: 'orders', rows: 100, totalBytes: 1024 }],
    unavailable: [],
    ...overrides
  };
}

function instance(id, score, ok, dims = okDims()) {
  return {
    jobId: 'job-1',
    workerId: 'w-1',
    datasourceId: id,
    datasourceName: id,
    dimensions: dims,
    healthScore: score,
    ok,
    attempt: 1,
    durationMs: 30
  };
}

test('batch：chunk 按批大小切分，单元是一批 datasourceId', () => {
  assert.deepStrictEqual(chunk(['a', 'b', 'c', 'd', 'e'], 2), [
    ['a', 'b'],
    ['c', 'd'],
    ['e']
  ]);
  assert.deepStrictEqual(chunk([], 2), []);
});

test('batch：normalizeBatchInput 过滤未启用/重复目标并钳制全部数值', () => {
  const job = normalizeBatchInput(
    {
      mode: 'llm-full',
      datasourceIds: ['a', 'b', 'a', 'missing'],
      batchSize: 999,
      concurrency: 0,
      maxRetries: 99,
      llmBudget: -1
    },
    ['a', 'b', 'c']
  );
  assert.deepStrictEqual(job.datasourceIds, ['a', 'b']);
  assert.strictEqual(job.mode, 'llm-full');
  assert.strictEqual(job.batchSize, 100);
  assert.strictEqual(job.concurrency, 1);
  assert.strictEqual(job.maxRetries, 3);
  assert.strictEqual(job.llmBudget, 0);
  assert.strictEqual(job.state, 'created');
  assert.match(job.id, /^[A-Za-z0-9-]+$/);
});

test('batch：无可用数据源时拒绝创建作业', () => {
  assert.throws(
    () => normalizeBatchInput({ mode: 'hybrid', datasourceIds: ['x'] }, []),
    /\[INVALID\]/
  );
});

test('batch：600 台的成本估算与默认分片一致', () => {
  const ids = Array.from({ length: 600 }, (_, i) => `ds-${i}`);
  const job = normalizeBatchInput({ mode: 'hybrid', datasourceIds: ids }, ids);
  const est = estimateJob(job);
  assert.strictEqual(est.total, 600);
  assert.strictEqual(est.workers, Math.ceil(600 / BATCH_DEFAULTS.batchSize));
  assert.strictEqual(est.sqlQueries, 600 * 6);
  assert.ok(est.workers < 600, '不应按一库一个 LLM worker 建模');
  assert.ok(est.estimatedSeconds > 0);
});

test('batch：健康分只在无 unavailable 时给出，skipped 不拉低分数', () => {
  assert.strictEqual(computeHealthScore(okDims()), 100);
  const skipped = okDims().map((d) =>
    d.name === 'replication' ? { ...d, status: 'skipped' } : d
  );
  assert.strictEqual(computeHealthScore(skipped), 100);
  const missing = okDims().map((d) =>
    d.name === 'qps' ? { ...d, status: 'unavailable', reason: '未采到' } : d
  );
  assert.strictEqual(computeHealthScore(missing), undefined);
  assert.strictEqual(computeHealthScore(okDims().slice(0, 5)), undefined);
  const warn = okDims().map((d) =>
    d.name === 'connections' ? { ...d, status: 'warn' } : d
  );
  assert.ok(computeHealthScore(warn) < 100);
});

test('batch：健康分分档', () => {
  assert.strictEqual(scoreBand(95), 'healthy');
  assert.strictEqual(scoreBand(75), 'attention');
  assert.strictEqual(scoreBand(55), 'warning');
  assert.strictEqual(scoreBand(40), 'critical');
});

test('batch：汇总只吃结构化结果，TOP N 按健康分升序且失败实例单列', () => {
  const results = [
    instance('a', 95, true),
    instance('b', 62, true),
    instance('c', 41, true),
    instance('d', undefined, false, okDims().map((x) => ({ ...x, status: 'unavailable', reason: '连接失败' })))
  ];
  const report = buildReport('job-1', results, '结构化结论', 'structured');
  assert.strictEqual(report.total, 4);
  assert.strictEqual(report.succeeded, 3);
  assert.strictEqual(report.failed, 1);
  assert.strictEqual(report.healthy, 1);
  assert.strictEqual(report.attention, 0);
  assert.strictEqual(report.warning, 1);
  assert.strictEqual(report.critical, 1);
  assert.deepStrictEqual(
    report.topN.map((r) => r.datasourceId),
    ['c', 'b', 'd']
  );
  assert.strictEqual(report.unavailableDimensions, 6);
});

test('batch：结构化摘要不编造趋势，且失败时报告仍完整', () => {
  const report = buildReport('job-1', [instance('a', 88, true)], '', 'none');
  const text = buildStructuredSummary(report);
  assert.match(text, /本期实时快照/);
  assert.doesNotMatch(text, /环比|同比|趋势上升/);
  assert.match(text, /1 台实例/);
});

test('batch：可重试错误分型（取消、权限、语法不重试）', () => {
  assert.strictEqual(isRetryableError('connect ECONNREFUSED'), true);
  assert.strictEqual(isRetryableError('采集超时（20000ms）'), true);
  assert.strictEqual(isRetryableError('任务已中止'), false);
  assert.strictEqual(isRetryableError('access denied for user'), false);
  assert.strictEqual(isRetryableError('只读模式不允许 UPDATE 语句'), false);
});

test('batch：DbOverview 映射为 6 维，未配置复制标 skipped 而非异常', () => {
  const dims = buildDimensions(overview());
  assert.strictEqual(dims.length, 6);
  assert.deepStrictEqual(
    dims.map((d) => d.name),
    DIM_NAMES
  );
  assert.strictEqual(dims.find((d) => d.name === 'replication').status, 'skipped');
  assert.strictEqual(dims.find((d) => d.name === 'connections').status, 'ok');
  assert.ok(dims.every((d) => d.evidence || d.reason), '每个维度必须有证据或原因');
});

test('batch：0 行结果不得当成健康（防假阴性）', () => {
  const dims = buildDimensions(overview({ capacity: [] }));
  const disk = dims.find((d) => d.name === 'disk');
  assert.strictEqual(disk.status, 'unavailable');
  assert.match(`${disk.reason} ${disk.evidence ?? ''}`, /0 行/);
});

test('batch：概览各维失败时 6 维全部显式 unavailable，绝不静默记 ok', () => {
  const dims = buildDimensions(
    overview({
      metrics: [],
      capacity: [],
      slowQueries: [],
      replication: { role: 'unknown' },
      unavailable: [
        { key: 'status', label: '实例状态', reason: '连接被拒绝' },
        { key: 'capacity', label: '容量', reason: '权限不足' },
        { key: 'slow-top', label: '慢查询', reason: 'performance_schema 关闭' },
        { key: 'replication', label: '复制', reason: '无权限' }
      ]
    })
  );
  assert.ok(dims.every((d) => d.status === 'unavailable'));
  assert.ok(dims.every((d) => typeof d.reason === 'string' && d.reason.length > 0));
  assert.strictEqual(computeHealthScore(dims), undefined);
});

test('batch：连接水位与复制延迟按阈值判定', () => {
  const highConn = buildDimensions(
    overview({
      metrics: overview().metrics.map((m) =>
        m.key === 'connections' ? { ...m, ratio: 92 } : m
      )
    })
  );
  assert.strictEqual(highConn.find((d) => d.name === 'connections').status, 'error');
  const lag = buildDimensions(
    overview({
      replication: { role: 'replica', lagSec: 420, ioRunning: true, sqlRunning: true },
      metrics: []
    })
  );
  assert.strictEqual(lag.find((d) => d.name === 'replication').status, 'error');
});

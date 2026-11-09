import { useEffect, useMemo, useState } from 'react';
import type {
  BatchDimensionName,
  BatchEstimate,
  BatchInstanceResult,
  BatchJobMode,
  BatchJobSnapshot,
  BatchWorkerState,
  DatasourceConfig
} from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';

const PREF_KEY = 'routine.batch.mode';

const DIM_LABELS: Record<BatchDimensionName, string> = {
  connections: '连接水位',
  disk: '容量 / 存储',
  replication: '复制状态',
  slowQueries: '慢查询',
  qps: 'QPS / 吞吐',
  memory: '缓冲池命中'
};

const DIM_STATUS_LABELS: Record<string, string> = {
  ok: '正常',
  warn: '需关注',
  error: '异常',
  unavailable: '未获取',
  skipped: '不适用'
};

const WORKER_LABELS: Record<BatchWorkerState, string> = {
  pending: '等待中',
  running: '采集中',
  succeeded: '已完成',
  failed: '部分失败',
  timeout: '超时',
  canceled: '已取消'
};

const JOB_LABELS: Record<string, string> = {
  created: '待启动',
  running: '巡检中',
  aggregating: '汇总中',
  completed: '已完成',
  canceled: '已停止'
};

function errText(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const m = raw.match(/\[([A-Z_]+)\]\s*([\s\S]*)$/);
  return m ? m[2] : raw;
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

export function BatchInspectionView() {
  const setBatchOpen = useAppStore((s) => s.setBatchOpen);
  const prefillComposer = useAppStore((s) => s.prefillComposer);
  const snapshot = useAppStore((s) => s.batchSnapshot);
  const jobs = useAppStore((s) => s.batchJobs);
  const setBatchJobs = useAppStore((s) => s.setBatchJobs);
  const batchError = useAppStore((s) => s.batchError);
  const setBatchError = useAppStore((s) => s.setBatchError);
  const applyBatchProgress = useAppStore((s) => s.applyBatchProgress);

  const [datasources, setDatasources] = useState<DatasourceConfig[]>([]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>());
  const [search, setSearch] = useState('');
  const [showMode, setShowMode] = useState(false);
  const [chosenMode, setChosenMode] = useState<BatchJobMode>('hybrid');
  const [remember, setRemember] = useState(false);
  const [estimate, setEstimate] = useState<BatchEstimate | null>(null);
  const [activeJobId, setActiveJobId] = useState<string | null>(null);
  const [detail, setDetail] = useState<BatchInstanceResult | null>(null);
  const [busy, setBusy] = useState(false);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return q
      ? datasources.filter(
          (d) =>
            d.name.toLowerCase().includes(q) ||
            d.host.toLowerCase().includes(q) ||
            d.type.toLowerCase().includes(q)
        )
      : datasources;
  }, [datasources, search]);

  useEffect(() => {
    void (async () => {
      try {
        const [ds, list] = await Promise.all([api.dbList(), api.batchJobsList()]);
        const enabled = ds.filter((d) => d.enabled);
        setDatasources(enabled);
        setSelected(new Set(enabled.map((d) => d.id)));
        setBatchJobs(list);
        if (list.length > 0) {
          const s = await api.batchJobGet(list[0].id);
          if (s) {
            applyBatchProgress(s);
            setActiveJobId(s.job.id);
          }
        }
      } catch (err) {
        setBatchError(errText(err));
      }
    })();
  }, [applyBatchProgress, setBatchJobs, setBatchError]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setBatchOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setBatchOpen]);

  useEffect(() => {
    if (snapshot) setActiveJobId(snapshot.job.id);
  }, [snapshot]);

  const running = snapshot
    ? ['created', 'running', 'aggregating'].includes(snapshot.job.state)
    : false;

  function toggle(id: string): void {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function refreshJobs(): Promise<void> {
    setBatchJobs(await api.batchJobsList());
  }

  async function requestStart(): Promise<void> {
    if (selected.size === 0) {
      setBatchError('请先选择至少一个数据源');
      return;
    }
    setBusy(true);
    try {
      setEstimate(
        await api.batchJobEstimate({ mode: 'hybrid', datasourceIds: [...selected] })
      );
      const saved = localStorage.getItem(PREF_KEY);
      if (saved === 'hybrid' || saved === 'llm-full') await startJob(saved);
      else setShowMode(true);
    } catch (err) {
      setBatchError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function startJob(mode: BatchJobMode): Promise<void> {
    setBusy(true);
    try {
      if (remember) localStorage.setItem(PREF_KEY, mode);
      const s: BatchJobSnapshot = await api.batchJobStart({
        mode,
        datasourceIds: [...selected],
        name: `巡检 ${selected.size} 台 · ${new Date().toLocaleString('zh-CN')}`
      });
      applyBatchProgress(s);
      setActiveJobId(s.job.id);
      setShowMode(false);
      setDetail(null);
      setBatchError(null);
      await refreshJobs();
    } catch (err) {
      setBatchError(errText(err));
    } finally {
      setBusy(false);
    }
  }

  async function cancelJob(): Promise<void> {
    if (!activeJobId) return;
    try {
      const s = await api.batchJobCancel(activeJobId);
      if (s) applyBatchProgress(s);
    } catch (err) {
      setBatchError(errText(err));
    }
  }

  async function retryJob(): Promise<void> {
    if (!activeJobId) return;
    try {
      applyBatchProgress(await api.batchJobRetry(activeJobId));
      setDetail(null);
    } catch (err) {
      setBatchError(errText(err));
    }
  }

  async function loadJob(id: string): Promise<void> {
    try {
      const s = await api.batchJobGet(id);
      if (s) {
        applyBatchProgress(s);
        setActiveJobId(id);
        setDetail(null);
      }
    } catch (err) {
      setBatchError(errText(err));
    }
  }

  function exportReport(): void {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], {
      type: 'application/json'
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `routine-batch-${snapshot.job.id}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }

  function openInChat(): void {
    if (!snapshot?.report) return;
    const lines = snapshot.report.topN
      .slice(0, 5)
      .map((r) => `- ${r.datasourceName}：健康分 ${r.healthScore ?? '未给出'}`)
      .join('\n');
    prefillComposer(
      `请帮我分析这次批量巡检结果（${snapshot.job.name}）：\n${lines || '本次无异常实例'}\n\n只依据对话中给出的结论，不要臆测其它实例。`
    );
    setBatchOpen(false);
  }

  const allChecked = filtered.length > 0 && filtered.every((d) => selected.has(d.id));
  const progress = snapshot?.progress;
  const pct = (n: number): string =>
    progress && progress.total > 0 ? `${(n / progress.total) * 100}%` : '0%';

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal workbench-modal batch-modal">
        <div className="batch-head">
          <div>
            <h3>批量巡检</h3>
            <span className="batch-dim">super 指挥 · worker 分片 · 全程只读</span>
          </div>
          <div className="batch-head-actions">
            {jobs.length > 0 && (
              <select
                className="wbk-select"
                value={activeJobId ?? ''}
                onChange={(e) => void loadJob(e.target.value)}
                aria-label="选择历史作业"
              >
                {jobs.map((j) => (
                  <option key={j.id} value={j.id}>
                    {j.name}
                  </option>
                ))}
              </select>
            )}
            {snapshot && <span className="batch-badge">{JOB_LABELS[snapshot.job.state]}</span>}
            <button className="modal-close" onClick={() => setBatchOpen(false)} aria-label="关闭">
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="1.8" />
              </svg>
            </button>
          </div>
        </div>

        {batchError && <div className="error-banner">{batchError}</div>}

        <div className="batch-body">
          <section className="batch-section">
            <div className="batch-section-head">
              <h4>目标数据源</h4>
              <span className="batch-dim">
                已选 {selected.size} / {datasources.length}
              </span>
            </div>
            <div className="batch-targets">
              <div className="batch-targets-tools">
                <input
                  className="batch-input"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  placeholder="搜索名称 / 主机 / 类型"
                  aria-label="搜索数据源"
                />
                <label className="batch-check">
                  <input
                    type="checkbox"
                    checked={allChecked}
                    onChange={(e) =>
                      setSelected(e.target.checked ? new Set(filtered.map((d) => d.id)) : new Set())
                    }
                  />
                  全选当前结果
                </label>
                <button
                  className="btn-primary"
                  onClick={() => void requestStart()}
                  disabled={busy || running}
                >
                  {running ? '作业进行中' : '发起巡检'}
                </button>
              </div>
              <div className="batch-targets-list">
                {filtered.map((ds) => (
                  <label key={ds.id} className="batch-target">
                    <input
                      type="checkbox"
                      checked={selected.has(ds.id)}
                      onChange={() => toggle(ds.id)}
                    />
                    <span className="batch-target-name">{ds.name}</span>
                    <span className="batch-dim">
                      {ds.type} · {ds.host}:{ds.port}
                      {ds.database ? ` · ${ds.database}` : ''}
                    </span>
                  </label>
                ))}
                {filtered.length === 0 && (
                  <div className="batch-empty">没有已启用的数据源，请先在设置页添加。</div>
                )}
              </div>
            </div>
          </section>

          {snapshot && progress && (
            <section className="batch-section">
              <div className="batch-section-head">
                <h4>{snapshot.job.name}</h4>
                <span className="batch-dim">
                  {snapshot.job.mode === 'hybrid' ? '稳妥模式 · 规则调度' : '自主编排 · super 决策'}
                  {snapshot.job.degradedFrom ? '（已降级为稳妥模式）' : ''}
                </span>
              </div>
              <div className="batch-progress-bar">
                <span className="batch-seg-ok" style={{ width: pct(progress.succeeded) }} />
                <span className="batch-seg-fail" style={{ width: pct(progress.failed) }} />
              </div>
              <div className="batch-stat-grid">
                <div className="batch-stat">
                  <span>目标</span>
                  <b>{progress.total}</b>
                </div>
                <div className="batch-stat">
                  <span>成功</span>
                  <b>{progress.succeeded}</b>
                </div>
                <div className="batch-stat">
                  <span>失败</span>
                  <b>{progress.failed}</b>
                </div>
                <div className="batch-stat">
                  <span>待完成</span>
                  <b>{progress.pending}</b>
                </div>
                <div className="batch-stat">
                  <span>运行中 worker</span>
                  <b>{progress.running}</b>
                </div>
                <div className="batch-stat">
                  <span>模型调用</span>
                  <b>{progress.llmCalls}</b>
                </div>
                <div className="batch-stat">
                  <span>耗时</span>
                  <b>{formatDuration(progress.elapsedMs)}</b>
                </div>
              </div>
            </section>
          )}

          {snapshot && snapshot.workers.length > 0 && (
            <section className="batch-section">
              <div className="batch-section-head">
                <h4>Worker 泳道</h4>
                <span className="batch-dim">每批 {snapshot.job.batchSize} 台 · 并发上限 {snapshot.job.concurrency}</span>
              </div>
              <div className="batch-workers">
                {snapshot.workers.map((w) => (
                  <div key={w.id} className={`batch-worker batch-worker-${w.state}`}>
                    <div className="batch-worker-top">
                      <span className="batch-worker-dot" />
                      <b>批次 {w.index + 1}</b>
                      <span className="batch-dim">{WORKER_LABELS[w.state]}</span>
                    </div>
                    <div className="batch-dim">{w.datasourceIds.length} 台实例</div>
                    <div className="batch-dim">{w.currentStep ?? '—'}</div>
                    {w.error && <div className="batch-worker-error">{w.error}</div>}
                    {w.startedAt && (
                      <div className="batch-dim">
                        耗时 {formatDuration((w.endedAt ?? Date.now()) - w.startedAt)}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {snapshot?.report && (
            <section className="batch-section">
              <div className="batch-section-head">
                <h4>汇总报告 · TOP {snapshot.report.topN.length} 异常实例</h4>
                <span className="batch-dim">点击行下钻查看采集证据</span>
              </div>
              <div className="batch-stat-grid">
                <div className="batch-stat"><span>健康</span><b>{snapshot.report.healthy}</b></div>
                <div className="batch-stat"><span>需关注</span><b>{snapshot.report.attention}</b></div>
                <div className="batch-stat"><span>告警</span><b>{snapshot.report.warning}</b></div>
                <div className="batch-stat"><span>严重</span><b>{snapshot.report.critical}</b></div>
                <div className="batch-stat"><span>未获取维度</span><b>{snapshot.report.unavailableDimensions}</b></div>
              </div>
              <div className="wbk-table-wrap">
                <table className="wbk-table">
                  <thead>
                    <tr>
                      <th>#</th>
                      <th>实例</th>
                      <th>健康分</th>
                      <th>采集</th>
                      <th>耗时</th>
                      <th>要点</th>
                    </tr>
                  </thead>
                  <tbody>
                    {snapshot.report.topN.map((r, i) => (
                      <tr key={r.datasourceId} className="batch-row" onClick={() => setDetail(r)}>
                        <td className="num">{i + 1}</td>
                        <td>{r.datasourceName}</td>
                        <td className="num">{r.healthScore ?? '—'}</td>
                        <td>{r.ok ? '成功' : '失败'}</td>
                        <td className="num">{formatDuration(r.durationMs)}</td>
                        <td>
                          {r.error ??
                            r.dimensions
                              .filter((d) => d.status === 'error' || d.status === 'warn')
                              .map((d) => DIM_LABELS[d.name])
                              .join('、') ??
                            '需关注'}
                        </td>
                      </tr>
                    ))}
                    {snapshot.report.topN.length === 0 && (
                      <tr>
                        <td colSpan={6} className="batch-empty">本次没有需要优先处理的异常实例。</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div className="batch-summary">
                <span className="batch-dim">
                  结论来源：{snapshot.report.summarySource === 'llm' ? 'super 归因' : '结构化汇总'}
                </span>
                <pre>{snapshot.report.summary}</pre>
              </div>
            </section>
          )}

          {detail && (
            <section className="batch-section">
              <div className="batch-section-head">
                <h4>实例明细 · {detail.datasourceName}</h4>
                <button className="btn-mini" onClick={() => setDetail(null)}>收起</button>
              </div>
              <div className="batch-detail-grid">
                {detail.dimensions.map((d) => (
                  <div key={d.name} className={`batch-dim-card batch-dim-${d.status}`}>
                    <div className="batch-dim-title">
                      {DIM_LABELS[d.name]}
                      <span>{DIM_STATUS_LABELS[d.status]}</span>
                    </div>
                    <div className="batch-dim-value">
                      {d.display ?? (typeof d.value === 'number' ? String(d.value) : '未获取')}
                    </div>
                    <div className="batch-dim-evidence">{d.reason ?? d.evidence ?? '无采集证据'}</div>
                  </div>
                ))}
              </div>
              {detail.error && <div className="error-banner">{detail.error}</div>}
            </section>
          )}
        </div>

        <div className="batch-footer">
          <span className="batch-dim">
            {snapshot
              ? `${JOB_LABELS[snapshot.job.state]}${snapshot.job.partial ? ' · 部分成功' : ''}`
              : '尚未发起作业'}
          </span>
          <div className="batch-footer-actions">
            <button className="btn-secondary" onClick={() => void cancelJob()} disabled={!running}>
              停止
            </button>
            <button
              className="btn-secondary"
              onClick={() => void retryJob()}
              disabled={running || !progress || progress.failed === 0}
            >
              重试失败项
            </button>
            <button className="btn-secondary" onClick={exportReport} disabled={!snapshot?.report}>
              导出
            </button>
            <button className="btn-secondary" onClick={openInChat} disabled={!snapshot?.report}>
              在对话中诊断
            </button>
          </div>
        </div>

        {showMode && (
          <div className="batch-mode-overlay">
            <div className="batch-mode-dialog" role="dialog" aria-label="选择指挥方式">
              <h4>选择指挥方式</h4>
              <p className="batch-dim">
                本次目标 {selected.size} 台
                {estimate
                  ? ` · 预计 ${estimate.workers} 个 worker · ${estimate.llmDecisions} 次模型调用 · 约 ${estimate.estimatedSeconds} 秒`
                  : ''}
              </p>
              <div className="batch-mode-options">
                <button
                  className={`batch-mode-option ${chosenMode === 'hybrid' ? 'is-active' : ''}`}
                  onClick={() => setChosenMode('hybrid')}
                >
                  <b>稳妥模式 · 规则调度</b>
                  <span>代码确定性分片与限流，super 只做异常归因与总报告；成本可预估。</span>
                </button>
                <button
                  className={`batch-mode-option ${chosenMode === 'llm-full' ? 'is-active' : ''}`}
                  onClick={() => setChosenMode('llm-full')}
                >
                  <b>自主编排 · super 自行分片与补检</b>
                  <span>更灵活，模型调用更多；受预算与轮次护栏约束，不可用时自动降级。</span>
                </button>
              </div>
              <label className="batch-check">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
                记住我的选择（下次不再询问）
              </label>
              <div className="batch-mode-actions">
                <button className="btn-secondary" onClick={() => setShowMode(false)}>取消</button>
                <button className="btn-primary" onClick={() => void startJob(chosenMode)} disabled={busy}>
                  开始巡检
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

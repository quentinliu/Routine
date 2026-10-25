import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  CheckSeriesPoint,
  CheckStatus,
  CheckTrendRow,
  DatasourceConfig,
  InspectionReport,
  InspectionTrend
} from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';

const RANGES = [7, 30, 90, 365] as const;
type Range = (typeof RANGES)[number];

const STATUS_LABEL: Record<CheckStatus, string> = {
  ok: '正常',
  warn: '警告',
  error: '异常',
  skipped: '跳过'
};

function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 通过率分母排除 skipped（环境不适用），避免永久假红；全部跳过时返回 null（显示 —） */
function passRate(row: CheckTrendRow): number | null {
  const applicable = row.total - row.skipped;
  if (applicable <= 0) return null;
  return Math.round(((applicable - row.fails) / applicable) * 100);
}

export function DatabaseWorkbench() {
  const presetDsId = useAppStore((s) => s.dbWorkbenchDatasourceId);
  const close = useAppStore((s) => s.closeDbWorkbench);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const prefillComposer = useAppStore((s) => s.prefillComposer);
  const setNotice = useAppStore((s) => s.setNotice);

  const [datasources, setDatasources] = useState<DatasourceConfig[]>([]);
  const [dsId, setDsId] = useState('');
  const [days, setDays] = useState<Range>(30);
  const [trend, setTrend] = useState<InspectionTrend | null>(null);
  const [checks, setChecks] = useState<CheckTrendRow[]>([]);
  const [reports, setReports] = useState<InspectionReport[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedReport, setExpandedReport] = useState<string | null>(null);
  const [seriesFor, setSeriesFor] = useState<string | null>(null);
  const [series, setSeries] = useState<CheckSeriesPoint[]>([]);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState('');

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.dbList();
        setDatasources(list);
        const wanted =
          presetDsId && list.some((d) => d.id === presetDsId) ? presetDsId : list[0]?.id ?? '';
        setDsId(wanted);
      } catch (err) {
        setError(errText(err));
      }
    })();
  }, [presetDsId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [close]);

  const refreshCharts = useCallback(async () => {
    if (!dsId) return;
    setLoading(true);
    try {
      const [t, c] = await Promise.all([
        api.inspectionTrends(dsId, days),
        api.inspectionCheckTrend(dsId, days)
      ]);
      setTrend(t);
      setChecks(c);
      setError(null);
    } catch (err) {
      setError(errText(err));
    } finally {
      setLoading(false);
    }
  }, [dsId, days]);

  const refreshReports = useCallback(async () => {
    if (!dsId) return;
    try {
      setReports(await api.inspectionReports(dsId, 50));
    } catch (err) {
      setError(errText(err));
    }
  }, [dsId]);

  useEffect(() => {
    void refreshCharts();
  }, [refreshCharts]);
  useEffect(() => {
    void refreshReports();
  }, [refreshReports]);
  useEffect(() => {
    setExpandedReport(null);
    setSeriesFor(null);
    setSeries([]);
  }, [dsId]);
  useEffect(() => {
    // 时间范围变化后旧序列不再对应，收起下钻
    setSeriesFor(null);
    setSeries([]);
  }, [days]);

  useEffect(() => {
    const unsub = window.api.onInspectionProgress((e) => {
      if (e.reportId === dsId) setProgress(e.checkId);
    });
    return unsub;
  }, [dsId]);

  async function runNow() {
    if (!dsId || running) return;
    setRunning(true);
    setProgress('正在准备巡检…');
    try {
      const report = await api.inspectionRun(dsId);
      await Promise.all([refreshCharts(), refreshReports()]);
      setNotice(`巡检完成：${report.ok ? '无异常' : '存在异常项'}`);
    } catch (err) {
      setNotice(errText(err));
    } finally {
      setRunning(false);
      setProgress('');
    }
  }

  async function toggleSeries(row: CheckTrendRow) {
    if (seriesFor === row.checkId) {
      setSeriesFor(null);
      return;
    }
    setSeriesFor(row.checkId);
    setSeries([]);
    try {
      setSeries(await api.inspectionCheckSeries(dsId, row.checkId, days));
    } catch (err) {
      setNotice(errText(err));
    }
  }

  const latest = reports[0];
  const latestConnectivity = latest?.results.find((c) => c.checkId === 'connectivity');
  const runCount = trend?.days.reduce((n, d) => n + d.count, 0) ?? 0;
  const failCount = trend?.days.reduce((n, d) => n + d.failures, 0) ?? 0;
  const maxCount = Math.max(1, ...(trend?.days.map((d) => d.count) ?? []));
  const labelStep = trend && trend.days.length > 30 ? Math.ceil(trend.days.length / 8) : 1;

  const anomalies = useMemo(() => {
    const out: Array<{
      id: string;
      time: number;
      title: string;
      status: CheckStatus;
      value?: string;
    }> = [];
    for (const r of reports) {
      for (const c of r.results) {
        if (c.status === 'warn' || c.status === 'error') {
          out.push({
            id: `${r.id}:${c.checkId}`,
            time: r.startedAt,
            title: c.title,
            status: c.status,
            value: c.value
          });
        }
      }
    }
    return out.slice(0, 20);
  }, [reports]);

  function diagnose() {
    const ds = datasources.find((d) => d.id === dsId);
    const focus = anomalies
      .slice(0, 3)
      .map((a) => `${a.title}（${STATUS_LABEL[a.status]}，${a.value ?? '无值'}）`)
      .join('、');
    prefillComposer(
      `请诊断数据库「${ds?.name ?? dsId}」近 ${days} 天的巡检情况` +
        `${focus ? `，重点关注：${focus}` : '，近期未发现异常项'}。` +
        '先用 inspection.run 获取最新报告，再结合趋势分析原因并给出处理建议。'
    );
    close();
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal workbench-modal">
        <div className="modal-head">
          <h3>数据库工作台</h3>
          <button className="modal-close" onClick={close}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <path
                d="M6 6l12 12M18 6L6 18"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
              />
            </svg>
          </button>
        </div>

        {datasources.length === 0 ? (
          <div className="wb-empty">
            <p>尚未配置数据库数据源。</p>
            <button
              className="btn-primary"
              onClick={() => {
                close();
                setSettingsOpen(true);
              }}
            >
              去设置添加
            </button>
          </div>
        ) : (
          <>
            <div className="wb-toolbar">
              <select className="wb-select" value={dsId} onChange={(e) => setDsId(e.target.value)}>
                {datasources.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.name} · {d.type} · {d.host}:{d.port}
                  </option>
                ))}
              </select>
              <div className="seg-group wb-range">
                {RANGES.map((r) => (
                  <button
                    key={r}
                    className={`seg-btn ${days === r ? 'active' : ''}`}
                    onClick={() => setDays(r)}
                  >
                    {r}天
                  </button>
                ))}
              </div>
              {loading && <span className="field-hint">加载中…</span>}
            </div>

            <div className="wb-body">
              {error && (
                <div className="wb-error">
                  {error}
                  <button className="btn-mini" onClick={() => void refreshCharts()}>
                    重试
                  </button>
                </div>
              )}

              <div className="wb-grid">
                <section className="wb-card">
                  <h4>健康摘要</h4>
                  {latest ? (
                    <ul className="wb-health">
                      <li>
                        连通性：
                        <span className={`check-status ${latestConnectivity?.status ?? 'skipped'}`}>
                          {STATUS_LABEL[latestConnectivity?.status ?? 'skipped']}
                        </span>
                        {latest.serverVersion && <span className="wb-dim"> · {latest.serverVersion}</span>}
                      </li>
                      <li>
                        近 {days} 天：{runCount - failCount}/{runCount} 次无错误
                        {failCount > 0 && <span className="wb-dim">（{failCount} 次失败）</span>}
                      </li>
                      <li>
                        上次巡检：{fmtTime(latest.startedAt)}
                        <span className={`check-status ${latest.ok ? 'ok' : 'error'}`}>
                          {latest.ok ? '通过' : '失败'}
                        </span>
                      </li>
                    </ul>
                  ) : (
                    <p className="field-hint">窗口内暂无巡检报告，点击「立即巡检」生成第一份。</p>
                  )}
                </section>

                <section className="wb-card wb-card-wide">
                  <h4>巡检趋势（近 {days} 天）</h4>
                  {trend && trend.days.length > 0 ? (
                    <div className="wb-bars">
                      {trend.days.map((d, i) => {
                        const h = Math.max(3, Math.round((d.count / maxCount) * 56));
                        const failH =
                          d.failures > 0 ? Math.max(3, Math.round((d.failures / maxCount) * 56)) : 0;
                        return (
                          <div
                            key={d.date}
                            className="wb-bar-col"
                            title={`${d.date}：${d.count} 次，失败 ${d.failures}`}
                          >
                            <div className="wb-bar" style={{ height: h }}>
                              {failH > 0 && <div className="wb-bar-fail" style={{ height: failH }} />}
                            </div>
                            {i % labelStep === 0 && <span className="wb-bar-date">{d.date.slice(5)}</span>}
                          </div>
                        );
                      })}
                    </div>
                  ) : (
                    <p className="field-hint">近 {days} 天暂无巡检记录。</p>
                  )}
                  <p className="field-hint">柱高 = 当日巡检次数，红色 = 当日失败次数</p>
                </section>
              </div>

              <section className="wb-card">
                <h4>检查项通过率</h4>
                {checks.length === 0 ? (
                  <p className="field-hint">暂无检查项数据。</p>
                ) : (
                  <table className="check-trend-table wb-check-table">
                    <thead>
                      <tr>
                        <th>检查项</th>
                        <th>通过率</th>
                        <th>失败/次数</th>
                        <th>最近</th>
                      </tr>
                    </thead>
                    <tbody>
                      {checks.map((c) => {
                        const rate = passRate(c);
                        const tone =
                          rate === null ? '' : rate >= 80 ? 'ok' : rate >= 50 ? 'warn' : 'error';
                        return (
                          <tr key={c.checkId} className="wb-clickable" onClick={() => void toggleSeries(c)}>
                            <td>
                              {c.title}
                              {c.recentFails7d > 0 && (
                                <span className="wb-warn" title={`近 7 天失败 ${c.recentFails7d} 次`}>
                                  {' '}⚠
                                </span>
                              )}
                            </td>
                            <td className={`check-rate ${tone}`}>
                              {rate === null ? '—' : `${rate}%`}
                            </td>
                            <td>
                              {c.fails}/{c.total}
                              {c.skipped > 0 && <span className="wb-dim"> · 跳过 {c.skipped}</span>}
                            </td>
                            <td>
                              <span className={`check-status ${c.lastStatus}`}>
                                {STATUS_LABEL[c.lastStatus]}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                      {seriesFor && (
                        <tr>
                          <td colSpan={4}>
                            {series.length === 0 ? (
                              <span className="field-hint">近 {days} 天暂无该检查项数据。</span>
                            ) : (
                              <div className="wb-series">
                                {series.map((p) => {
                                  const max = Math.max(1, ...series.map((x) => x.total));
                                  return (
                                    <div
                                      key={p.date}
                                      className="wb-bar-col"
                                      title={`${p.date}：${p.total} 次，失败 ${p.fails}`}
                                    >
                                      <div
                                        className="wb-bar"
                                        style={{ height: Math.max(3, Math.round((p.total / max) * 28)) }}
                                      >
                                        {p.fails > 0 && (
                                          <div
                                            className="wb-bar-fail"
                                            style={{
                                              height: Math.max(
                                                2,
                                                Math.round((p.fails / max) * 28)
                                              )
                                            }}
                                          />
                                        )}
                                      </div>
                                    </div>
                                  );
                                })}
                              </div>
                            )}
                          </td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                )}
              </section>

              <section className="wb-card">
                <h4>
                  异常记录 <span className="field-hint">（最近 {reports.length} 次报告内）</span>
                </h4>
                {anomalies.length === 0 ? (
                  <p className="field-hint">没有 warn/error 记录。</p>
                ) : (
                  <ul className="wb-anomalies">
                    {anomalies.map((a) => (
                      <li key={a.id}>
                        <span className={`run-dot ${a.status === 'error' ? 'fail' : 'warn'}`} />
                        <span className="wb-anomaly-time">{fmtTime(a.time)}</span>
                        <span className="wb-anomaly-title">{a.title}</span>
                        <span className="wb-dim">{a.value ?? STATUS_LABEL[a.status]}</span>
                      </li>
                    ))}
                  </ul>
                )}
              </section>

              <section className="wb-card">
                <h4>
                  巡检报告 <span className="field-hint">（最近 50 次，点行展开明细）</span>
                </h4>
                {reports.length === 0 ? (
                  <p className="field-hint">暂无报告。</p>
                ) : (
                  <div className="wb-reports">
                    {reports.map((r) => {
                      const bad = r.results.filter((c) => c.status !== 'ok').length;
                      return (
                        <div key={r.id} className="wb-report">
                          <button
                            className="wb-report-row"
                            onClick={() => setExpandedReport(expandedReport === r.id ? null : r.id)}
                          >
                            <span className={`run-dot ${r.ok ? 'ok' : 'fail'}`} />
                            <span className="wb-report-time">{fmtTime(r.startedAt)}</span>
                            <span className="wb-report-ver">{r.serverVersion || '—'}</span>
                            <span className="wb-report-sum">
                              {bad === 0 ? `${r.results.length} 项通过` : `${bad} 项异常`}
                            </span>
                            <span className="wb-chevron">{expandedReport === r.id ? '▾' : '▸'}</span>
                          </button>
                          {expandedReport === r.id && (
                            <div className="wb-report-detail">
                              {r.results.map((c) => (
                                <div key={c.checkId} className="wb-check-detail">
                                  <span className={`check-status ${c.status}`}>
                                    {STATUS_LABEL[c.status]}
                                  </span>
                                  <span className="wb-check-title">{c.title}</span>
                                  <span className="wb-dim">{c.value ?? ''}</span>
                                  {c.detail.length > 0 && (
                                    <ul>
                                      {c.detail.map((line, i) => (
                                        <li key={i}>{line}</li>
                                      ))}
                                    </ul>
                                  )}
                                  {c.suggestion && (
                                    <p className="wb-suggestion">建议：{c.suggestion}</p>
                                  )}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>

            <div className="wb-actions">
              <button className="btn-secondary" onClick={diagnose} disabled={!dsId}>
                在对话中诊断…
              </button>
              <button className="btn-primary" onClick={() => void runNow()} disabled={running || !dsId}>
                {running ? progress || '巡检中…' : '立即巡检'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

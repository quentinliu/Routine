import { useCallback, useEffect, useRef, useState } from 'react';
import type { DatasourceConfig, DbOverview, DbReplicationInfo } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import {
  fmtBytes,
  fmtInt,
  fmtMs,
  fmtUptime,
  overviewPrompt,
  toUserError
} from '../lib/dbWorkbench';

interface Props {
  ds: DatasourceConfig;
}

function replicationLabel(r: DbReplicationInfo): { text: string; tone: 'ok' | 'warn' | 'danger' | 'neutral' } {
  if (r.role === 'none') return { text: '未配置复制', tone: 'neutral' };
  if (r.role === 'unknown') return { text: r.hint ?? '状态未知', tone: 'warn' };
  if (r.role === 'primary') {
    return { text: `主库${r.hint ? ` · ${r.hint}` : ''}`, tone: 'ok' };
  }
  const lag = r.lagSec ?? 0;
  const threadsDown = r.ioRunning === false || r.sqlRunning === false;
  return {
    text: `备库 · 延迟 ${lag}s${threadsDown ? ' · 复制线程异常' : ''}`,
    tone: threadsDown || lag > 60 ? 'danger' : lag > 5 ? 'warn' : 'ok'
  };
}

export function DbWorkbenchOverview({ ds }: Props) {
  const [data, setData] = useState<DbOverview | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);
  const prefillComposer = useAppStore((s) => s.prefillComposer);
  const close = useAppStore((s) => s.closeDbWorkbench);

  const load = useCallback(async () => {
    const seq = ++requestId.current;
    setLoading(true);
    try {
      const next = await api.dbOverview(ds.id);
      if (seq !== requestId.current) return;
      setData(next);
      setError(null);
    } catch (err) {
      if (seq !== requestId.current) return;
      setError(toUserError(err));
    } finally {
      if (seq === requestId.current) setLoading(false);
    }
  }, [ds.id]);

  useEffect(() => {
    void load();
  }, [load]);

  function handoff() {
    if (!data) return;
    prefillComposer(overviewPrompt({ name: ds.name, id: ds.id, database: ds.database }, data));
    close();
  }

  const maxBytes = Math.max(1, ...(data?.capacity.map((c) => c.totalBytes) ?? [0]));
  const repl = data ? replicationLabel(data.replication) : null;

  return (
    <div className="wbk-stack">
      <div className="wbk-row wbk-row-between">
        <div className="wbk-row">
          <span className="wbk-kicker">实时概览</span>
          {data && (
            <>
              <span className="wbk-badge">{data.version}</span>
              <span className="wbk-dim">运行 {fmtUptime(data.uptimeSec)}</span>
              <span className="wbk-dim">
                采样 {new Date(data.collectedAt).toLocaleTimeString()} · {fmtMs(data.durationMs)}
              </span>
            </>
          )}
          {loading && <span className="wbk-dim">采集中…</span>}
        </div>
        <div className="wbk-row">
          <button className="btn-secondary btn-mini" onClick={() => void load()} disabled={loading}>
            刷新
          </button>
          <button className="btn-secondary btn-mini" onClick={handoff} disabled={!data}>
            让 AI 解读
          </button>
        </div>
      </div>

      {error && (
        <div className="wbk-banner error">
          {error}
          <button className="btn-mini" onClick={() => void load()}>
            重试
          </button>
        </div>
      )}

      {!data && loading && <div className="wbk-placeholder">正在采集实例指标…</div>}

      {data && (
        <>
          <div className="wbk-metrics">
            {data.metrics.map((m) => (
              <div key={m.key} className={`wbk-metric tone-${m.tone}`}>
                <span className="wbk-metric-label">{m.label}</span>
                <span className="wbk-metric-value">{m.display}</span>
                {m.ratio !== undefined && (
                  <div className="wbk-meter" aria-hidden>
                    <i style={{ width: `${m.ratio}%` }} />
                  </div>
                )}
                {m.hint && <span className="wbk-metric-hint">{m.hint}</span>}
              </div>
            ))}
          </div>

          <div className="wbk-facts">
            {repl && (
              <span className={`wbk-fact tone-${repl.tone}`}>
                <b>复制</b> {repl.text}
              </span>
            )}
            <span className="wbk-fact">
              <b>锁等待</b> {data.locks.waiting} 个
              {data.locks.longestWaitSec > 0 ? ` · 最长 ${data.locks.longestWaitSec}s` : ' · 无阻塞'}
            </span>
            <span className="wbk-fact">
              <b>慢查询摘要</b>{' '}
              {data.slowQueries.length > 0
                ? `${data.slowQueries.length} 条`
                : data.unavailable.some((u) => u.key === 'slow-top')
                  ? '未获取'
                  : '暂无样本'}
            </span>
            <span className="wbk-fact">
              <b>容量</b> {data.capacity.length > 0 ? `Top ${data.capacity.length}` : '未获取'}
            </span>
          </div>

          {data.unavailable.length > 0 && (
            <div className="wbk-unavailable">
              <strong>未获取</strong>
              <ul>
                {data.unavailable.map((u) => (
                  <li key={`${u.key}:${u.label}`}>
                    {u.label}：{u.reason}
                  </li>
                ))}
              </ul>
            </div>
          )}

          <div className="wbk-split">
            <section className="wbk-card">
              <h4>
                活跃会话 <span className="wbk-dim">非 idle · {data.sessions.length}</span>
              </h4>
              {data.sessions.length === 0 ? (
                <p className="wbk-empty-hint">当前没有活跃会话。</p>
              ) : (
                <div className="wbk-table-wrap">
                  <table className="wbk-table">
                    <thead>
                      <tr>
                        <th>用户</th>
                        <th>来源</th>
                        <th>库</th>
                        <th className="num">持续</th>
                        <th>SQL</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.sessions.map((s) => (
                        <tr key={`${s.id}:${s.timeSec}`}>
                          <td>{s.user || '—'}</td>
                          <td className="wbk-mono-dim">{s.host || '—'}</td>
                          <td>{s.database || '—'}</td>
                          <td className="num">{s.timeSec}s</td>
                          <td className="wbk-sql-cell" title={s.sql}>
                            {s.sql || s.state || s.command || '—'}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>

            <section className="wbk-card">
              <h4>
                慢查询 Top <span className="wbk-dim">平均耗时降序</span>
              </h4>
              {data.slowQueries.length === 0 ? (
                <p className="wbk-empty-hint">
                  {data.unavailable.some((u) => u.key === 'slow-top')
                    ? '未获取慢查询摘要（原因见上方）。'
                    : '暂无慢查询样本。'}
                </p>
              ) : (
                <div className="wbk-table-wrap">
                  <table className="wbk-table">
                    <thead>
                      <tr>
                        <th className="num">调用</th>
                        <th className="num">平均</th>
                        <th>摘要</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.slowQueries.map((s, i) => (
                        <tr key={`${i}:${s.digest.slice(0, 24)}`}>
                          <td className="num">{fmtInt(s.calls)}</td>
                          <td className="num">{fmtMs(s.avgMs)}</td>
                          <td className="wbk-sql-cell" title={s.digest}>
                            {s.digest}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </section>
          </div>

          <section className="wbk-card">
            <h4>
              容量 Top <span className="wbk-dim">估算行数 · 数据+索引</span>
            </h4>
            {data.capacity.length === 0 ? (
              <p className="wbk-empty-hint">没有可展示的表容量数据。</p>
            ) : (
              <ul className="wbk-capacity">
                {data.capacity.map((c) => (
                  <li key={`${c.database}.${c.table}`}>
                    <span className="wbk-cap-name">
                      {c.database}.{c.table}
                    </span>
                    <span className="wbk-cap-bar" aria-hidden>
                      <i style={{ width: `${Math.max(2, (c.totalBytes / maxBytes) * 100)}%` }} />
                    </span>
                    <span className="wbk-cap-meta">
                      {fmtBytes(c.totalBytes)} · 约 {fmtInt(c.rows)} 行
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

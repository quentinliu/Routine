import { useEffect, useState, type KeyboardEvent } from 'react';
import type { DatasourceConfig, DbQueryResult } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { fmtInt, fmtMs, queryPrompt, toUserError } from '../lib/dbWorkbench';

interface Props {
  ds: DatasourceConfig;
  seed: { sql: string; token: number } | null;
}

type Mode = 'read' | 'write';

interface HistoryItem {
  sql: string;
  mode: Mode;
  ok: boolean;
  rowCount: number;
  at: number;
}

export function DbWorkbenchQuery({ ds, seed }: Props) {
  const [mode, setMode] = useState<Mode>('read');
  const [sql, setSql] = useState(seed?.sql ?? '');
  const [reason, setReason] = useState('');
  const [result, setResult] = useState<DbQueryResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [history, setHistory] = useState<HistoryItem[]>([]);
  const prefillComposer = useAppStore((s) => s.prefillComposer);
  const setNotice = useAppStore((s) => s.setNotice);

  useEffect(() => {
    if (!seed) return;
    setSql(seed.sql);
    setResult(null);
    setError(null);
  }, [seed]);

  async function run() {
    const text = sql.trim();
    if (!text || running) return;
    setRunning(true);
    setError(null);
    try {
      const next = mode === 'read' ? await api.dbQuery(ds.id, text) : await api.dbExec(ds.id, text, reason);
      setResult(next);
      setHistory((prev) =>
        [{ sql: text, mode, ok: true, rowCount: next.rowCount, at: Date.now() }, ...prev].slice(0, 10)
      );
    } catch (err) {
      const message = toUserError(err);
      setError(message);
      setHistory((prev) =>
        [{ sql: text, mode, ok: false, rowCount: 0, at: Date.now() }, ...prev].slice(0, 10)
      );
    } finally {
      setRunning(false);
    }
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      void run();
    }
  }

  function handoff() {
    if (!result) return;
    prefillComposer(queryPrompt({ name: ds.name, id: ds.id, database: ds.database }, result));
    setNotice('已写入对话草稿，补充问题后发送即可');
  }

  return (
    <div className="wbk-stack">
      <div className="wbk-row wbk-row-between">
        <div className="wbk-seg" role="group" aria-label="执行模式">
          <button
            type="button"
            className={`wbk-seg-btn ${mode === 'read' ? 'active' : ''}`}
            onClick={() => setMode('read')}
          >
            只读
          </button>
          <button
            type="button"
            className={`wbk-seg-btn ${mode === 'write' ? 'active' : ''}`}
            onClick={() => setMode('write')}
          >
            写入 / 管理
          </button>
        </div>
        <div className="wbk-row">
          <span className="wbk-dim">⌘ / Ctrl + Enter 执行</span>
          <button className="btn-primary btn-mini" onClick={() => void run()} disabled={running || !sql.trim()}>
            {running ? '执行中…' : '执行'}
          </button>
        </div>
      </div>

      {mode === 'write' && (
        <div className="wbk-write-hint">
          写入与管理语句会触发安全确认，审批通过后才执行；拒绝、超时或取消都不会落库。
        </div>
      )}

      <textarea
        className="wbk-editor"
        value={sql}
        onChange={(e) => setSql(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={
          mode === 'read'
            ? 'SELECT * FROM your_table LIMIT 100;'
            : 'KILL 12345;  -- 写/管理语句需经安全确认'
        }
        spellCheck={false}
        rows={6}
        aria-label="SQL 编辑器"
      />

      {mode === 'write' && (
        <label className="wbk-field">
          <span>执行原因（写入审批记录）</span>
          <input
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="如：结束阻塞主从复制的长事务"
          />
        </label>
      )}

      {error && (
        <div className="wbk-banner error">
          {error}
          <button className="btn-mini" onClick={() => setError(null)}>
            关闭
          </button>
        </div>
      )}

      {result && (
        <section className="wbk-card wbk-result">
          <div className="wbk-row wbk-row-between">
            <div className="wbk-row">
              <span className="wbk-kicker">结果</span>
              <span className="wbk-dim">
                {fmtInt(result.rowCount)} 行 · {fmtMs(result.durationMs)}
              </span>
              {result.truncated && <span className="wbk-badge warn">仅前 200 行</span>}
            </div>
            <button className="btn-secondary btn-mini" onClick={handoff}>
              让 AI 分析结果
            </button>
          </div>

          {result.rowCount === 0 || result.columns.length === 0 ? (
            <p className="wbk-empty-hint">已执行，0 行。</p>
          ) : (
            <div className="wbk-table-wrap wbk-result-wrap">
              <table className="wbk-table">
                <thead>
                  <tr>
                    {result.columns.map((col) => (
                      <th key={col}>{col}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {result.rows.map((row, i) => (
                    <tr key={i}>
                      {row.map((cell, j) => (
                        <td key={j} className={typeof cell === 'number' ? 'num' : undefined}>
                          {cell === null ? <span className="wbk-null">NULL</span> : String(cell)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}

      {history.length > 0 && (
        <section className="wbk-card">
          <h4>
            最近查询 <span className="wbk-dim">本次工作台会话</span>
          </h4>
          <ul className="wbk-history">
            {history.map((h) => (
              <li key={`${h.at}:${h.sql.slice(0, 16)}`}>
                <button type="button" className="wbk-history-row" onClick={() => setSql(h.sql)}>
                  <span className={`wbk-dot ${h.ok ? 'ok' : 'fail'}`} aria-hidden />
                  <span className="wbk-badge">{h.mode === 'read' ? '只读' : '写入'}</span>
                  <span className="wbk-history-sql">{h.sql.replace(/\s+/g, ' ').slice(0, 120)}</span>
                  <span className="wbk-dim">{h.ok ? `${h.rowCount} 行` : '失败'}</span>
                </button>
              </li>
            ))}
          </ul>
          <p className="wbk-footnote">点击历史项可回填 SQL，不会自动执行。</p>
        </section>
      )}
    </div>
  );
}

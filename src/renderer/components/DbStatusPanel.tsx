import { useCallback, useEffect, useState } from 'react';
import type { DbTestResult, DatasourceConfig, InspectionReport } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { buildStatusRows, type DbStatusRow } from '../lib/dbStatus';

function failedTest(err: unknown): DbTestResult {
  return {
    ok: false,
    version: '',
    latencyMs: 0,
    error: err instanceof Error ? err.message : String(err)
  };
}

export function DbStatusPanel() {
  const [rows, setRows] = useState<DbStatusRow[]>([]);
  const [probing, setProbing] = useState(true);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const openDbWorkbench = useAppStore((s) => s.openDbWorkbench);

  const refresh = useCallback(async () => {
    setProbing(true);
    const list = await api.dbList().catch(() => [] as DatasourceConfig[]);
    const testById = new Map<string, DbTestResult>();
    const reportById = new Map<string, InspectionReport | undefined>();
    // 先渲染探测态占位，每个结果到达即落位重排
    setRows(buildStatusRows(list, testById, reportById));
    const enabled = list.filter((d) => d.enabled);
    await Promise.all(
      enabled.map(async (ds) => {
        const [test, reports] = await Promise.all([
          api.dbTest(ds.id).catch(failedTest),
          api.inspectionReports(ds.id, 1).catch(() => [])
        ]);
        testById.set(ds.id, test);
        reportById.set(ds.id, reports[0]);
        setRows(buildStatusRows(list, testById, reportById));
      })
    );
    setProbing(false);
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  function metaOf(row: DbStatusRow): string {
    switch (row.health) {
      case 'probing':
        return '检测中…';
      case 'down':
        return row.error ?? '无法访问';
      case 'issues':
        return `最近巡检 ${row.issueCount} 项异常`;
      case 'ok':
        return `${row.latencyMs ?? 0}ms`;
      case 'disabled':
        return '已停用';
    }
  }

  const abnormal = rows.filter((r) => r.health === 'down' || r.health === 'issues').length;

  return (
    <div className="db-status">
      <div className="db-status-head">
        <h3 className="panel-title">
          {rows.length > 0 ? `数据库状态${abnormal > 0 ? ` · ${abnormal} 异常` : ''}` : '数据库状态'}
        </h3>
        <button
          type="button"
          className="db-refresh"
          title="重新检测"
          aria-label="重新检测"
          onClick={() => void refresh()}
        >
          <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
            <path
              d="M20 12a8 8 0 1 1-2.34-5.66M20 4v4h-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      </div>

      {rows.length === 0 ? (
        <div className="db-status-empty">
          <p>尚未配置数据源</p>
          <button className="btn-mini" onClick={() => setSettingsOpen(true)}>
            去配置
          </button>
        </div>
      ) : (
        <ul className="db-status-list">
          {rows.map((row) => (
            <li key={row.ds.id}>
              <div
                className={`db-row is-${row.health}`}
                role="button"
                tabIndex={0}
                title={`${row.ds.type} · ${row.ds.host}:${row.ds.port}${
                  row.error ? `\n${row.error}` : ''
                }`}
                onClick={() => openDbWorkbench(row.ds.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    openDbWorkbench(row.ds.id);
                  }
                }}
              >
                <span className="db-dot" aria-hidden />
                <span className="db-name">{row.ds.name}</span>
                <span className="db-meta">{metaOf(row)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {probing && rows.length > 0 && <p className="db-status-hint">正在检测连通性…</p>}
    </div>
  );
}

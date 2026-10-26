import { useEffect, useState } from 'react';
import type { DatasourceConfig } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { DbWorkbenchOverview } from './DbWorkbenchOverview';
import { DbWorkbenchQuery } from './DbWorkbenchQuery';
import { DbWorkbenchObjects } from './DbWorkbenchObjects';
import { DbWorkbenchDiagnose } from './DbWorkbenchDiagnose';
import { toUserError } from '../lib/dbWorkbench';

const TABS = [
  { id: 'overview', label: '概览' },
  { id: 'query', label: '查询' },
  { id: 'objects', label: '对象' },
  { id: 'diagnose', label: '诊断' }
] as const;

type TabId = (typeof TABS)[number]['id'];

export function DatabaseWorkbench() {
  const presetDsId = useAppStore((s) => s.dbWorkbenchDatasourceId);
  const close = useAppStore((s) => s.closeDbWorkbench);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [datasources, setDatasources] = useState<DatasourceConfig[]>([]);
  const [dsId, setDsId] = useState('');
  const [tab, setTab] = useState<TabId>('overview');
  const [visited, setVisited] = useState<Set<TabId>>(() => new Set<TabId>(['overview']));
  const [seed, setSeed] = useState<{ sql: string; token: number } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const list = await api.dbList();
        setDatasources(list);
        const wanted =
          presetDsId && list.some((d) => d.id === presetDsId) ? presetDsId : list[0]?.id ?? '';
        setDsId(wanted);
      } catch (err) {
        setError(toUserError(err));
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

  useEffect(() => {
    setVisited((prev) => (prev.has(tab) ? prev : new Set(prev).add(tab)));
  }, [tab]);

  useEffect(() => {
    // 切换数据源：清空跨页预填，避免把 A 库的表名带进 B 库
    setSeed(null);
  }, [dsId]);

  const ds = datasources.find((d) => d.id === dsId);

  function openPreview(sql: string) {
    setSeed({ sql, token: Date.now() });
    setTab('query');
  }

  return (
    <div className="modal-overlay" role="dialog" aria-modal="true">
      <div className="modal workbench-modal">
        <div className="wbk-head">
          <h3>数据库工作台</h3>
          {datasources.length > 0 && (
            <select
              className="wbk-select"
              value={dsId}
              onChange={(e) => setDsId(e.target.value)}
              aria-label="选择数据源"
            >
              {datasources.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name} · {d.type} · {d.host}:{d.port}
                </option>
              ))}
            </select>
          )}
          {ds && (
            <span className="wbk-dim">
              {ds.type === 'mysql' ? 'MySQL' : 'PostgreSQL'}
              {ds.database ? ` · ${ds.database}` : ''}
            </span>
          )}
          {ds && !ds.enabled && <span className="wbk-badge warn">已停用</span>}
          <button className="modal-close" onClick={close} aria-label="关闭">
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
          <div className="wbk-empty">
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
            <div className="wbk-tabs" role="tablist" aria-label="工作台视图">
              {TABS.map((t) => (
                <button
                  key={t.id}
                  type="button"
                  role="tab"
                  aria-selected={tab === t.id}
                  className={`wbk-tab ${tab === t.id ? 'active' : ''}`}
                  onClick={() => setTab(t.id)}
                >
                  {t.label}
                </button>
              ))}
            </div>

            {error && (
              <div className="wbk-banner error">
                {error}
                <button className="btn-mini" onClick={() => setError(null)}>
                  关闭
                </button>
              </div>
            )}

            <div className="wbk-body">
              {ds && visited.has('overview') && (
                <div
                  className={`wbk-panel ${tab === 'overview' ? 'active' : ''}`}
                  role="tabpanel"
                  aria-hidden={tab !== 'overview'}
                >
                  <DbWorkbenchOverview key={ds.id} ds={ds} />
                </div>
              )}
              {ds && visited.has('query') && (
                <div
                  className={`wbk-panel ${tab === 'query' ? 'active' : ''}`}
                  role="tabpanel"
                  aria-hidden={tab !== 'query'}
                >
                  <DbWorkbenchQuery key={ds.id} ds={ds} seed={seed} />
                </div>
              )}
              {ds && visited.has('objects') && (
                <div
                  className={`wbk-panel ${tab === 'objects' ? 'active' : ''}`}
                  role="tabpanel"
                  aria-hidden={tab !== 'objects'}
                >
                  <DbWorkbenchObjects key={ds.id} ds={ds} onPreview={openPreview} />
                </div>
              )}
              {ds && visited.has('diagnose') && (
                <div
                  className={`wbk-panel ${tab === 'diagnose' ? 'active' : ''}`}
                  role="tabpanel"
                  aria-hidden={tab !== 'diagnose'}
                >
                  <DbWorkbenchDiagnose key={ds.id} ds={ds} onClose={close} />
                </div>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

import { useEffect, useMemo, useState } from 'react';
import type {
  DatasourceConfig,
  DbDatabaseInfo,
  DbTableDetail,
  DbTableInfo
} from '../../shared/types';
import { api } from '../ipc';
import { fmtBytes, fmtInt, previewSelectSql, toUserError } from '../lib/dbWorkbench';

interface Props {
  ds: DatasourceConfig;
  onPreview: (sql: string) => void;
}

interface Selection {
  database: string;
  table: string;
}

export function DbWorkbenchObjects({ ds, onPreview }: Props) {
  const [databases, setDatabases] = useState<DbDatabaseInfo[]>([]);
  const [tablesByDb, setTablesByDb] = useState<Record<string, DbTableInfo[]>>({});
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [selection, setSelection] = useState<Selection | null>(null);
  const [detail, setDetail] = useState<DbTableDetail | null>(null);
  const [filter, setFilter] = useState('');
  const [loading, setLoading] = useState(true);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [detailError, setDetailError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const result = await api.dbObjects(ds.id);
        if (!alive || result.level !== 'databases') return;
        setDatabases(result.databases);
      } catch (err) {
        if (alive) setTreeError(toUserError(err));
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => {
      alive = false;
    };
  }, [ds.id]);

  async function toggleDatabase(name: string) {
    const next = new Set(expanded);
    if (next.has(name)) {
      next.delete(name);
      setExpanded(next);
      return;
    }
    next.add(name);
    setExpanded(next);
    if (tablesByDb[name]) return;
    try {
      const result = await api.dbObjects(ds.id, name);
      if (result.level !== 'tables') return;
      setTablesByDb((prev) => ({ ...prev, [name]: result.tables }));
    } catch (err) {
      setTreeError(toUserError(err));
    }
  }

  async function selectTable(database: string, table: string) {
    setSelection({ database, table });
    setDetail(null);
    setDetailError(null);
    try {
      const result = await api.dbObjects(ds.id, database, table);
      if (result.level !== 'table') return;
      setDetail(result.table);
    } catch (err) {
      setDetailError(toUserError(err));
    }
  }

  const keyword = filter.trim().toLowerCase();
  const visibleDatabases = useMemo(
    () =>
      databases.filter(
        (d) =>
          !keyword ||
          d.name.toLowerCase().includes(keyword) ||
          (tablesByDb[d.name] ?? []).some((t) => t.name.toLowerCase().includes(keyword))
      ),
    [databases, tablesByDb, keyword]
  );

  return (
    <div className="wbk-objects">
      <aside className="wbk-tree">
        <div className="wbk-tree-head">
          <input
            className="wbk-search"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="搜索库 / 表"
            aria-label="搜索库或表"
          />
        </div>
        {treeError && (
          <div className="wbk-banner error">
            {treeError}
            <button className="btn-mini" onClick={() => setTreeError(null)}>
              关闭
            </button>
          </div>
        )}
        {loading ? (
          <p className="wbk-empty-hint">正在读取库列表…</p>
        ) : visibleDatabases.length === 0 ? (
          <p className="wbk-empty-hint">没有匹配的对象（系统库已隐藏）。</p>
        ) : (
          <ul className="wbk-tree-list">
            {visibleDatabases.map((db) => {
              const isOpen = expanded.has(db.name);
              const tables = (tablesByDb[db.name] ?? []).filter(
                (t) => !keyword || t.name.toLowerCase().includes(keyword)
              );
              return (
                <li key={db.name}>
                  <button
                    type="button"
                    className="wbk-tree-row"
                    onClick={() => void toggleDatabase(db.name)}
                    aria-expanded={isOpen}
                  >
                    <span className="wbk-chevron">{isOpen ? '▾' : '▸'}</span>
                    <span className="wbk-tree-name">{db.name}</span>
                    <span className="wbk-dim">
                      {db.tableCount} 表 · {fmtBytes(db.totalBytes)}
                    </span>
                  </button>
                  {isOpen && (
                    <ul className="wbk-tree-children">
                      {tablesByDb[db.name] === undefined ? (
                        <li className="wbk-empty-hint">正在读取表清单…</li>
                      ) : tables.length === 0 ? (
                        <li className="wbk-empty-hint">该库没有表。</li>
                      ) : (
                        tables.map((t) => (
                          <li key={t.name}>
                            <button
                              type="button"
                              className={`wbk-tree-row child ${
                                selection?.database === db.name && selection.table === t.name
                                  ? 'active'
                                  : ''
                              }`}
                              onClick={() => void selectTable(db.name, t.name)}
                            >
                              <span className="wbk-tree-name">{t.name}</span>
                              <span className="wbk-dim">
                                约 {fmtInt(t.rows)} 行 · {fmtBytes(t.totalBytes)}
                              </span>
                            </button>
                          </li>
                        ))
                      )}
                    </ul>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </aside>

      <section className="wbk-detail">
        {!selection ? (
          <div className="wbk-placeholder">从左侧选择一张表查看字段与索引。</div>
        ) : detailError ? (
          <div className="wbk-banner error">
            {detailError}
            <button
              className="btn-mini"
              onClick={() => void selectTable(selection.database, selection.table)}
            >
              重试
            </button>
          </div>
        ) : !detail ? (
          <div className="wbk-placeholder">读取表结构中…</div>
        ) : (
          <>
            <div className="wbk-row wbk-row-between">
              <div>
                <h4 className="wbk-detail-title">
                  {detail.database}.{detail.table}
                </h4>
                <p className="wbk-dim">
                  {detail.engine} · 约 {fmtInt(detail.rows)} 行 · {fmtBytes(detail.totalBytes)}
                  {detail.comment ? ` · ${detail.comment}` : ''}
                </p>
              </div>
              <button
                className="btn-secondary btn-mini"
                onClick={() => onPreview(previewSelectSql(detail.database, detail.table, ds.type))}
              >
                查看数据
              </button>
            </div>

            <h4 className="wbk-subtitle">字段 · {detail.columns.length}</h4>
            <div className="wbk-table-wrap">
              <table className="wbk-table">
                <thead>
                  <tr>
                    <th>名称</th>
                    <th>类型</th>
                    <th>可空</th>
                    <th>默认值</th>
                    <th>键</th>
                    <th>备注</th>
                  </tr>
                </thead>
                <tbody>
                  {detail.columns.map((c) => (
                    <tr key={c.name}>
                      <td className="wbk-mono">{c.name}</td>
                      <td className="wbk-mono-dim">{c.type}</td>
                      <td>{c.nullable ? 'YES' : 'NO'}</td>
                      <td className="wbk-mono-dim">{c.defaultValue ?? '—'}</td>
                      <td>{c.key || '—'}</td>
                      <td className="wbk-mono-dim">{c.extra || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>

            <h4 className="wbk-subtitle">索引 · {detail.indexes.length}</h4>
            {detail.indexes.length === 0 ? (
              <p className="wbk-empty-hint">这张表没有索引。</p>
            ) : (
              <div className="wbk-table-wrap">
                <table className="wbk-table">
                  <thead>
                    <tr>
                      <th>名称</th>
                      <th>唯一</th>
                      <th>列顺序</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.indexes.map((idx) => (
                      <tr key={idx.name}>
                        <td className="wbk-mono">{idx.name}</td>
                        <td>{idx.unique ? '是' : '否'}</td>
                        <td className="wbk-mono-dim">{idx.columns.join(' → ') || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

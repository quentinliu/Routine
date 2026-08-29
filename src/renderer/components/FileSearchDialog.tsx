import { useState } from 'react';
import type { FileSearchResult } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { dateStr, fileSize, middleTruncate } from '../lib/format';

function extIcon(ext: string): string {
  if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(ext)) return 'IMG';
  if (['pdf'].includes(ext)) return 'PDF';
  if (['zip', 'rar', '7z', 'dmg', 'tar', 'gz'].includes(ext)) return 'ZIP';
  if (['mp4', 'mov', 'avi', 'mkv'].includes(ext)) return 'VID';
  if (['mp3', 'wav', 'flac', 'aac'].includes(ext)) return 'AUD';
  if (['md', 'txt'].includes(ext)) return 'TXT';
  if (['ts', 'tsx', 'js', 'py', 'go', 'java', 'c', 'cpp', 'rs', 'rb'].includes(ext)) return 'CODE';
  if (['doc', 'docx'].includes(ext)) return 'DOC';
  if (['xls', 'xlsx', 'csv'].includes(ext)) return 'XLS';
  if (['ppt', 'pptx'].includes(ext)) return 'PPT';
  return ext ? ext.slice(0, 3).toUpperCase() : 'FILE';
}

export function FileSearchDialog() {
  const setFileDialogOpen = useAppStore((s) => s.setFileDialogOpen);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<FileSearchResult[] | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function search() {
    if (!query.trim()) return;
    setSearching(true);
    setError(null);
    try {
      setResults(await api.fileSearch(query.trim(), 50));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSearching(false);
    }
  }

  const emptyIndex = results !== null && results.length === 0;

  return (
    <div className="modal-overlay">
      <div className="modal file-modal">
        <div className="modal-head">
          <h3>文件搜索</h3>
          <button className="modal-close" onClick={() => setFileDialogOpen(false)}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="file-search-row">
          <input
            autoFocus
            value={query}
            placeholder="按文件名、类型、目录搜索…"
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void search();
            }}
          />
          <button className="btn-primary" disabled={searching || !query.trim()} onClick={() => void search()}>
            {searching ? '搜索中' : '搜索'}
          </button>
        </div>

        {error && <p className="file-error">{error}</p>}

        {emptyIndex && (
          <div className="file-empty">
            <p>没有匹配结果。索引可能尚未建立，先去设置页重建索引？</p>
            <button
              className="btn-secondary"
              onClick={() => {
                setFileDialogOpen(false);
                setSettingsOpen(true);
              }}
            >
              去重建索引
            </button>
          </div>
        )}

        {results && results.length > 0 && (
          <div className="file-results">
            {results.map((r) => (
              <div key={r.record.path} className="file-row">
                <span className={`file-ext ext-${extIcon(r.record.ext).toLowerCase()}`}>
                  {extIcon(r.record.ext)}
                </span>
                <div className="file-info">
                  <span className="file-name">{r.record.name}</span>
                  <span className="file-dir" title={r.record.dir}>
                    {middleTruncate(r.record.dir, 42)} · {fileSize(r.record.size)} · {dateStr(r.record.mtime)}
                  </span>
                  {r.snippet && <span className="file-snippet">{middleTruncate(r.snippet, 80)}</span>}
                </div>
                <button
                  className="btn-mini"
                  title="在 Finder 中显示"
                  onClick={() => void api.openExternal(`file://${r.record.dir}`)}
                >
                  Finder
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

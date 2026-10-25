import { useState } from 'react';
import { useAppStore } from '../store';

export function Topbar() {
  const providerMode = useAppStore((s) => s.settings.providerMode);
  const cloudProfiles = useAppStore((s) => s.settings.cloudProfiles);
  const activeCloudId = useAppStore((s) => s.settings.activeCloudId);
  const cloudHealth = useAppStore((s) => s.cloudHealth);
  const refreshCloudHealth = useAppStore((s) => s.refreshCloudHealth);
  const switchCloud = useAppStore((s) => s.switchCloud);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);
  const setFileDialogOpen = useAppStore((s) => s.setFileDialogOpen);
  const setTodoDialogOpen = useAppStore((s) => s.setTodoDialogOpen);
  const openDbWorkbench = useAppStore((s) => s.openDbWorkbench);
  const [modelOpen, setModelOpen] = useState(false);

  const activeProfile = cloudProfiles.find((p) => p.id === activeCloudId) ?? cloudProfiles[0];

  return (
    <header className="topbar">
      <div className="brand-mark">
        <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden>
          <path
            d="M12 2 21 7v10l-9 5-9-5V7z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="3.2" fill="currentColor" />
        </svg>
      </div>
      <span className="brand-name">Routine</span>
      <span className={`mode-badge ${providerMode === 'cloud' ? 'mode-cloud' : 'mode-local'}`}>
        {providerMode === 'cloud' ? '效率模式' : '隐私模式'}
      </span>

      {providerMode === 'cloud' && (
        <div className="model-switcher">
          <button className="model-pill" onClick={() => {
            setModelOpen((v) => !v);
            void refreshCloudHealth();
          }}>
            <span
              className={`health-dot ${
                cloudHealth[activeProfile.id] === undefined
                  ? 'unknown'
                  : cloudHealth[activeProfile.id]
                    ? 'ok'
                    : 'fail'
              }`}
            />
            {activeProfile.label || activeProfile.model || '选择模型'}
            <svg viewBox="0 0 24 24" width="10" height="10" aria-hidden>
              <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </button>
          {modelOpen && (
            <>
              <div className="model-menu-backdrop" onClick={() => setModelOpen(false)} />
              <div className="model-menu">
                {cloudProfiles.map((p) => (
                  <button
                    key={p.id}
                    className={`model-menu-item ${p.id === activeCloudId ? 'selected' : ''}`}
                    onClick={() => {
                      setModelOpen(false);
                      if (p.id !== activeCloudId) void switchCloud(p.id);
                    }}
                  >
                    <span
                      className={`health-dot ${
                        cloudHealth[p.id] === undefined ? 'unknown' : cloudHealth[p.id] ? 'ok' : 'fail'
                      }`}
                    />
                    <span className="model-menu-label">{p.label || p.model || '未命名模型'}</span>
                    <span className="model-menu-model">{p.model}</span>
                    {p.id === activeCloudId && <span className="profile-active">使用中</span>}
                  </button>
                ))}
                <button
                  className="model-menu-manage"
                  onClick={() => {
                    setModelOpen(false);
                    setSettingsOpen(true);
                  }}
                >
                  管理模型…
                </button>
              </div>
            </>
          )}
        </div>
      )}

      <div className="topbar-actions">
        <button className="topbar-btn" onClick={() => setFileDialogOpen(true)}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
          </svg>
          文件搜索
        </button>
        <button className="topbar-btn" onClick={() => openDbWorkbench()}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <ellipse
              cx="12"
              cy="5.5"
              rx="7"
              ry="3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M5 5.5v13c0 1.7 3.1 3 7 3s7-1.3 7-3v-13"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
            <path
              d="M5 12c0 1.7 3.1 3 7 3s7-1.3 7-3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
            />
          </svg>
          数据库
        </button>
        <button className="topbar-btn" onClick={() => setTodoDialogOpen(true)}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <rect x="4" y="5" width="16" height="15" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path d="M8 3v4M16 3v4M4 10h16" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
            <path
              d="M9 14.5l2 2 4-4"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          定时任务
        </button>
        <button className="topbar-btn" onClick={() => setSettingsOpen(true)}>
          <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
            <circle cx="12" cy="12" r="3" fill="none" stroke="currentColor" strokeWidth="1.8" />
            <path
              d="M12 3.5v2.2M12 18.3v2.2M3.5 12h2.2M18.3 12h2.2M5.9 5.9l1.6 1.6M16.5 16.5l1.6 1.6M18.1 5.9l-1.6 1.6M7.5 16.5l-1.6 1.6"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
            />
          </svg>
          设置
        </button>
        <span className="version">v{__APP_VERSION__}</span>
      </div>
    </header>
  );
}

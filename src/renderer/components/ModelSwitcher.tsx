import { useEffect, useRef, useState } from 'react';
import { useAppStore } from '../store';

interface Props {
  /** 任务执行中锁定模型（M1 契约：单次任务全程锁定同一模型） */
  disabled?: boolean;
}

function healthClass(health: Record<string, boolean>, id: string): string {
  if (health[id] === undefined) return 'health-dot unknown';
  return health[id] ? 'health-dot ok' : 'health-dot fail';
}

/**
 * 输入框控制行的模型胶囊：点击向上弹出档案列表，切换即生效。
 * 从 Topbar 迁入（M6 界面契约变更），隐私模式下退化为静态标签，点击进入设置页。
 */
export function ModelSwitcher({ disabled }: Props) {
  const providerMode = useAppStore((s) => s.settings.providerMode);
  const ollamaModel = useAppStore((s) => s.settings.ollama.model);
  const cloudProfiles = useAppStore((s) => s.settings.cloudProfiles);
  const activeCloudId = useAppStore((s) => s.settings.activeCloudId);
  const cloudHealth = useAppStore((s) => s.cloudHealth);
  const refreshCloudHealth = useAppStore((s) => s.refreshCloudHealth);
  const switchCloud = useAppStore((s) => s.switchCloud);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [open, setOpen] = useState(false);
  /** 切换中的档案 id：置灰胶囊并显示微型 spinner，避免连点造成竞态 */
  const [switching, setSwitching] = useState<string | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  const activeProfile = cloudProfiles.find((p) => p.id === activeCloudId) ?? cloudProfiles[0];

  useEffect(() => {
    if (!open) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  function choose(id: string) {
    if (id === activeCloudId) {
      setOpen(false);
      return;
    }
    setSwitching(id);
    void switchCloud(id)
      .catch((err) => console.error('[model-switcher] 切换模型失败', err))
      .finally(() => {
        setSwitching(null);
        setOpen(false);
      });
  }

  if (providerMode === 'local') {
    return (
      <button
        type="button"
        className="model-pill is-local"
        title="隐私模式使用本地模型，点击前往设置"
        onClick={() => setSettingsOpen(true)}
      >
        <span className="health-dot ok" />
        本地 · {ollamaModel || '未配置'}
      </button>
    );
  }

  return (
    <div className="model-switcher">
      <button
        ref={triggerRef}
        type="button"
        className={`model-pill${open ? ' is-open' : ''}${switching ? ' is-switching' : ''}`}
        disabled={disabled || switching !== null}
        aria-haspopup="menu"
        aria-expanded={open}
        title={
          disabled ? '执行中不可切换模型' : `当前模型：${activeProfile?.label || activeProfile?.model || '未命名'}`
        }
        onClick={() => {
          const next = !open;
          setOpen(next);
          if (next) void refreshCloudHealth();
        }}
      >
        {switching ? (
          <span className="model-spinner" aria-hidden />
        ) : (
          <span className={healthClass(cloudHealth, activeProfile?.id ?? '')} />
        )}
        <span className="model-pill-label">
          {activeProfile?.label || activeProfile?.model || '选择模型'}
        </span>
        <svg className="model-chevron" viewBox="0 0 24 24" width="10" height="10" aria-hidden>
          <path
            d="M6 9l6 6 6-6"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>

      {open && (
        <>
          <div className="model-menu-backdrop" onClick={() => setOpen(false)} />
          <div className="model-menu" role="menu" aria-label="选择模型">
            {cloudProfiles.map((p) => (
              <button
                key={p.id}
                type="button"
                role="menuitemradio"
                aria-checked={p.id === activeCloudId}
                className={`model-menu-item ${p.id === activeCloudId ? 'selected' : ''}`}
                disabled={switching !== null}
                onClick={() => choose(p.id)}
              >
                <span className={healthClass(cloudHealth, p.id)} />
                <span className="model-menu-label">{p.label || p.model || '未命名模型'}</span>
                <span className="model-menu-model">{p.model}</span>
                {p.id === activeCloudId && <span className="profile-active">使用中</span>}
              </button>
            ))}
            <button
              type="button"
              className="model-menu-manage"
              onClick={() => {
                setOpen(false);
                setSettingsOpen(true);
              }}
            >
              管理模型…
            </button>
          </div>
        </>
      )}
    </div>
  );
}

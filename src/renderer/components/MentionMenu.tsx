import { useEffect, useMemo, useRef } from 'react';
import type { ResourceRef } from '../../shared/types';
import type { ResourceCache } from '../store';

export interface MenuEntry {
  key: string;
  group: 'datasource' | 'sshHost';
  ref: ResourceRef;
  label: string;
  detail: string;
  disabled: boolean;
  note?: string;
}

interface Props {
  entries: MenuEntry[];
  resources: ResourceCache | null;
  loading: boolean;
  activeIndex: number;
  onPick(ref: ResourceRef): void;
  onManage(): void;
  onClose(): void;
}

const GROUP_LABELS: Record<MenuEntry['group'], string> = {
  datasource: '数据源',
  sshHost: 'SSH 主机'
};

function matches(query: string, parts: readonly string[]): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return parts.some((p) => p.toLowerCase().includes(q));
}

/**
 * 选择器条目：分组展示，但 flat 顺序即键盘 ↑↓ 轨迹。
 * 已引用的条目保持可见但不可选，避免「点了没反应」。
 */
export function buildMentionEntries(
  resources: ResourceCache | null,
  query: string,
  selected: readonly ResourceRef[]
): MenuEntry[] {
  if (!resources) return [];
  const picked = (kind: ResourceRef['kind'], id: string): boolean =>
    selected.some((r) => r.kind === kind && r.id === id);

  const datasources: MenuEntry[] = resources.datasources
    .filter((ds) => matches(query, [ds.name, ds.host, ds.database ?? '', ds.type]))
    .map((ds) => {
      const isPicked = picked('datasource', ds.id);
      return {
        key: `datasource:${ds.id}`,
        group: 'datasource',
        ref: { kind: 'datasource', id: ds.id, label: ds.name },
        label: ds.name,
        detail: `${ds.type} · ${ds.host}:${ds.port}${ds.database ? `/${ds.database}` : ''}`,
        disabled: !ds.enabled || isPicked,
        note: !ds.enabled ? '已禁用' : isPicked ? '已引用' : undefined
      };
    });

  const hosts: MenuEntry[] = resources.sshHosts
    .filter((h) => matches(query, [h.name, h.host, h.user]))
    .map((h) => {
      const isPicked = picked('sshHost', h.id);
      return {
        key: `sshHost:${h.id}`,
        group: 'sshHost',
        ref: { kind: 'sshHost', id: h.id, label: h.name },
        label: h.name,
        detail: `${h.user}@${h.host}:${h.port}`,
        disabled: !h.enabled || isPicked,
        note: !h.enabled ? '已禁用' : isPicked ? '已引用' : undefined
      };
    });

  return [...datasources, ...hosts];
}

/** 输入框上方的 `@` 资源选择器：向上弹出、分组、键盘导航 */
export function MentionMenu({
  entries,
  resources,
  loading,
  activeIndex,
  onPick,
  onManage,
  onClose
}: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  const navIndex = useMemo(() => {
    const map = new Map<string, number>();
    let i = 0;
    for (const entry of entries) {
      if (entry.disabled) continue;
      map.set(entry.key, i);
      i += 1;
    }
    return map;
  }, [entries]);

  // 键盘移到可视区外时跟随滚动（面板最高 260px，主机多时才需要）
  useEffect(() => {
    const active = menuRef.current?.querySelector('.mention-item.is-active');
    active?.scrollIntoView({ block: 'nearest' });
  }, [activeIndex]);

  const grouped: Array<{ group: MenuEntry['group']; items: MenuEntry[] }> = [
    { group: 'datasource', items: entries.filter((e) => e.group === 'datasource') },
    { group: 'sshHost', items: entries.filter((e) => e.group === 'sshHost') }
  ].filter((g) => g.items.length > 0) as Array<{ group: MenuEntry['group']; items: MenuEntry[] }>;

  const configured = (resources?.datasources.length ?? 0) + (resources?.sshHosts.length ?? 0) > 0;

  function emptyText(): string {
    if (loading) return '正在读取资源清单…';
    if (!resources) return '未能读取资源清单，请检查设置页';
    if (!configured) return '尚未配置数据源或 SSH 主机';
    return '没有匹配的资源';
  }

  return (
    <>
      <div className="mention-backdrop" onClick={onClose} />
      <div className="mention-menu" role="menu" aria-label="引用已配置的资源" ref={menuRef}>
        {grouped.length === 0 ? (
          <div className="mention-empty">
            <span>{emptyText()}</span>
            {!loading && (
              <button type="button" className="mention-manage" onClick={onManage}>
                {configured ? '重新读取' : '去设置页添加'}
              </button>
            )}
          </div>
        ) : (
          grouped.map((g) => (
            <div className="mention-group" key={g.group}>
              <div className="mention-group-title">{GROUP_LABELS[g.group]}</div>
              {g.items.map((entry) => {
                const index = navIndex.get(entry.key);
                const active = index !== undefined && index === activeIndex;
                return (
                  <button
                    key={entry.key}
                    type="button"
                    role="menuitem"
                    className={`mention-item${active ? ' is-active' : ''}`}
                    disabled={entry.disabled}
                    // 防止点击时 textarea 先失焦导致 mousedown 后的选区丢失
                    onMouseDown={(e) => e.preventDefault()}
                    onClick={() => onPick(entry.ref)}
                  >
                    <span className={`mention-dot ${entry.group}`} aria-hidden />
                    <span className="mention-label">{entry.label}</span>
                    <span className="mention-detail">{entry.detail}</span>
                    {entry.note && <span className="mention-note">{entry.note}</span>}
                  </button>
                );
              })}
            </div>
          ))
        )}
        <div className="mention-hint">↑↓ 选择 · Enter 确认 · Esc 关闭</div>
      </div>
    </>
  );
}

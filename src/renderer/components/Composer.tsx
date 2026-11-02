import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import type { ResourceRef } from '../../shared/types';
import { useAppStore } from '../store';
import { ModelSwitcher } from './ModelSwitcher';
import { MentionMenu, buildMentionEntries } from './MentionMenu';

interface MentionState {
  /** `@` 在文本里的位置；选中后整段 `@query` 被移除 */
  start: number;
  query: string;
}

/**
 * 光标前是否是一个未完成的 `@` 片段。
 * 必须按光标位置判断而不是整段文本末尾——在中间补写时不能误触发。
 */
function detectMention(value: string, cursor: number): MentionState | null {
  const before = value.slice(0, cursor);
  const matched = /(^|[\s(（])@([^\s@]*)$/.exec(before);
  if (!matched) return null;
  const query = matched[2];
  return { start: before.length - query.length - 1, query };
}

export function Composer() {
  const runningSessionId = useAppStore((s) => s.runningSessionId);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const sessions = useAppStore((s) => s.sessions);
  const sendText = useAppStore((s) => s.sendText);
  const stopChat = useAppStore((s) => s.stopChat);
  const composerDraft = useAppStore((s) => s.composerDraft);
  const consumeComposerDraft = useAppStore((s) => s.consumeComposerDraft);
  const resources = useAppStore((s) => s.resources);
  const resourcesLoading = useAppStore((s) => s.resourcesLoading);
  const refreshResources = useAppStore((s) => s.refreshResources);
  const addSessionRef = useAppStore((s) => s.addSessionRef);
  const removeSessionRef = useAppStore((s) => s.removeSessionRef);
  const setSettingsOpen = useAppStore((s) => s.setSettingsOpen);

  const [text, setText] = useState('');
  const [mention, setMention] = useState<MentionState | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const runningHere = runningSessionId !== null && runningSessionId === currentSessionId;

  /** 会话级引用：切换会话后自动跟随；新会话为空 */
  const refs = sessions.find((s) => s.id === currentSessionId)?.refs;
  const mentionOpen = mention !== null;

  const entries = useMemo(
    () => (mention ? buildMentionEntries(resources, mention.query, refs ?? []) : []),
    [mention, resources, refs]
  );
  const selectable = useMemo(() => entries.filter((e) => !e.disabled), [entries]);

  // 外部预填（数据库工作台「在对话中诊断」）：只写入草稿并聚焦，不自动发送
  useEffect(() => {
    if (!composerDraft) return;
    setText(composerDraft);
    setMention(null);
    consumeComposerDraft();
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(composerDraft.length, composerDraft.length);
      ta.style.height = 'auto';
      ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
    });
  }, [composerDraft, consumeComposerDraft]);

  // 只在打开 @ 菜单时拉清单（顺带刷新，设置页刚改完资源也能立刻选到）；
  // 输入过程中不产生 IPC
  useEffect(() => {
    if (mentionOpen) void refreshResources(true);
  }, [mentionOpen, refreshResources]);

  // 关键词变化回到首项；条目增减时把高亮钳在范围内
  useEffect(() => {
    setActiveIndex(0);
  }, [mention?.query]);

  useEffect(() => {
    setActiveIndex((i) => (selectable.length === 0 ? 0 : Math.min(i, selectable.length - 1)));
  }, [selectable.length]);

  function autoResize(): void {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function syncMention(value: string, cursor: number): void {
    setMention(detectMention(value, cursor));
  }

  function focusAt(pos: number): void {
    requestAnimationFrame(() => {
      const ta = taRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(pos, pos);
    });
  }

  /** 选中资源：移除 `@query` 片段（含多余空格），再挂一枚会话引用标签 */
  function pickMention(ref: ResourceRef): void {
    const active = mention;
    addSessionRef(ref);
    setMention(null);
    if (!active) return;
    const at = active.start;
    const end = at + 1 + active.query.length;
    const head = text.slice(0, at);
    const tail = text.slice(end);
    const next = /\s$/.test(head) && /^\s/.test(tail)
      ? `${head.replace(/\s$/, '')} ${tail.replace(/^\s+/, '')}`
      : `${head}${tail}`;
    setText(next);
    focusAt(at);
  }

  function removeRef(ref: ResourceRef): void {
    removeSessionRef(ref);
    taRef.current?.focus();
  }

  function send(): void {
    const value = text.trim();
    if (!value || runningHere) return;
    setText('');
    setMention(null);
    if (taRef.current) taRef.current.style.height = 'auto';
    void sendText(value);
  }

  function manageResources(): void {
    // 取数失败时先重试一次，不清空菜单；成功后再引导到设置页
    if (!resources) {
      void refreshResources(true);
      return;
    }
    setMention(null);
    setSettingsOpen(true);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>): void {
    if (mention) {
      if (e.key === 'ArrowDown' && selectable.length > 0) {
        e.preventDefault();
        setActiveIndex((i) => (i + 1) % selectable.length);
        return;
      }
      if (e.key === 'ArrowUp' && selectable.length > 0) {
        e.preventDefault();
        setActiveIndex((i) => (i - 1 + selectable.length) % selectable.length);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setMention(null);
        return;
      }
      if (e.key === 'Enter' && !e.shiftKey && selectable.length > 0) {
        e.preventDefault();
        const target = selectable[activeIndex];
        if (target) pickMention(target.ref);
        return;
      }
    }
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="composer">
      <div className="composer-box">
        {refs && refs.length > 0 && (
          <div className="composer-refs" role="list" aria-label="本会话引用的资源">
            {refs.map((ref) => (
              <span className="ref-chip" role="listitem" key={`${ref.kind}:${ref.id}`}>
                <span className={`ref-dot ${ref.kind}`} aria-hidden />
                <span className="ref-chip-label">{ref.label}</span>
                <button
                  type="button"
                  className="ref-chip-remove"
                  title={`移除引用：${ref.label}`}
                  aria-label={`移除引用：${ref.label}`}
                  onClick={() => removeRef(ref)}
                >
                  ×
                </button>
              </span>
            ))}
          </div>
        )}

        <textarea
          ref={taRef}
          value={text}
          placeholder="输入任务，@ 引用数据源/主机；Enter 发送，Shift+Enter 换行"
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
            syncMention(e.target.value, e.target.selectionStart ?? e.target.value.length);
          }}
          onKeyDown={onKeyDown}
          onBlur={() => setMention(null)}
        />

        {mention && (
          <MentionMenu
            entries={entries}
            resources={resources}
            loading={resourcesLoading}
            activeIndex={activeIndex}
            onPick={pickMention}
            onManage={manageResources}
            onClose={() => {
              setMention(null);
              taRef.current?.focus();
            }}
          />
        )}

        <div className="composer-controls">
          <ModelSwitcher disabled={runningHere} />
          {runningHere ? (
            <button className="send-btn stop" title="停止" onClick={stopChat}>
              <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
                <rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" />
              </svg>
            </button>
          ) : (
            <button
              className="send-btn"
              title="发送"
              disabled={!text.trim()}
              onClick={send}
            >
              <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
                <path
                  d="M4 12h13M12 5.5 18.5 12 12 18.5"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            </button>
          )}
        </div>
      </div>
      <p className="composer-hint">AI 可能出错，高风险操作前会请求你的确认</p>
    </div>
  );
}

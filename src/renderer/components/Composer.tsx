import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useAppStore } from '../store';
import { ModelSwitcher } from './ModelSwitcher';

export function Composer() {
  const runningSessionId = useAppStore((s) => s.runningSessionId);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const sendText = useAppStore((s) => s.sendText);
  const stopChat = useAppStore((s) => s.stopChat);
  const composerDraft = useAppStore((s) => s.composerDraft);
  const consumeComposerDraft = useAppStore((s) => s.consumeComposerDraft);
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const runningHere = runningSessionId !== null && runningSessionId === currentSessionId;

  // 外部预填（数据库工作台「在对话中诊断」）：只写入草稿并聚焦，不自动发送
  useEffect(() => {
    if (!composerDraft) return;
    setText(composerDraft);
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

  function autoResize() {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = 'auto';
    ta.style.height = `${Math.min(ta.scrollHeight, 160)}px`;
  }

  function send() {
    const value = text.trim();
    if (!value || runningHere) return;
    setText('');
    if (taRef.current) taRef.current.style.height = 'auto';
    void sendText(value);
  }

  function onKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  return (
    <div className="composer">
      <div className="composer-box">
        <textarea
          ref={taRef}
          value={text}
          placeholder="输入任务，Enter 发送，Shift+Enter 换行"
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            autoResize();
          }}
          onKeyDown={onKeyDown}
        />
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

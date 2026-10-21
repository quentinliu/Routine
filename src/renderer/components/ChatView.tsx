import { useEffect, useRef } from 'react';
import { useAppStore, EMPTY_TRACES } from '../store';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { TraceTimeline } from './TraceTimeline';

const SUGGESTIONS = [
  '查一下我的电脑配置',
  '帮我搜索桌面上和报告相关的文件',
  '搜索最近的 AI 新闻并总结',
  '打开 github.com 并截图保存到桌面'
];

function EmptyState() {
  const sendText = useAppStore((s) => s.sendText);
  return (
    <div className="empty-state">
      <div className="empty-logo">
        <svg viewBox="0 0 24 24" width="34" height="34" aria-hidden>
          <path
            d="M12 2 21 7v10l-9 5-9-5V7z"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinejoin="round"
          />
          <circle cx="12" cy="12" r="3.4" fill="currentColor" />
        </svg>
      </div>
      <h2>有什么可以帮你？</h2>
      <p className="empty-sub">我是运行在你 Mac 上的 AI 助手，可以调度文件、系统、搜索和浏览器完成任务</p>
      <div className="suggestion-grid">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="suggestion-chip" onClick={() => void sendText(s)}>
            {s}
          </button>
        ))}
      </div>
    </div>
  );
}

export function ChatView() {
  const messages = useAppStore((s) => s.messages);
  const streamingMsg = useAppStore((s) => s.streamingMsg);
  const chatError = useAppStore((s) => s.chatError);
  const setChatError = useAppStore((s) => s.setChatError);
  const sessions = useAppStore((s) => s.sessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const sending = useAppStore((s) => s.sending);
  const traces = useAppStore((s) => s.tracesBySession[currentSessionId] ?? EMPTY_TRACES);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const current = sessions.find((s) => s.id === currentSessionId);
  const total = messages.length + (streamingMsg ? 1 : 0);

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [total, streamingMsg?.content, traces.length]);

  function onScroll() {
    const el = scrollRef.current;
    if (!el) return;
    stickBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - 80;
  }

  return (
    <main className="chat-view">
      <header className="chat-header">
        <h1>{current?.title || '新会话'}</h1>
      </header>

      {chatError && (
        <div className="error-banner">
          <span>{chatError}</span>
          <button onClick={() => setChatError(null)}>知道了</button>
        </div>
      )}

      <div className="chat-scroll" ref={scrollRef} onScroll={onScroll}>
        {total === 0 ? (
          <EmptyState />
        ) : (
          <div className="chat-list">
            {messages.map((m) => (
              <MessageBubble key={m.id} message={m} />
            ))}
            {traces.length > 0 && <TraceTimeline traces={traces} live={sending} />}
            {streamingMsg && (
              <MessageBubble
                message={{
                  id: streamingMsg.id,
                  role: 'assistant',
                  content: streamingMsg.content,
                  createdAt: Date.now()
                }}
                streaming
              />
            )}
          </div>
        )}
      </div>

      <Composer />
    </main>
  );
}

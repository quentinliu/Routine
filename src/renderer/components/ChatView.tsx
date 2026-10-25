import { Fragment, useEffect, useRef } from 'react';
import { useAppStore, EMPTY_TURNS, type TurnTrace } from '../store';
import { durationText } from '../lib/format';
import { useNow } from '../lib/useNow';
import { MessageBubble } from './MessageBubble';
import { Composer } from './Composer';
import { TurnProcess } from './TurnProcess';

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

/** 任务已提交、首个步骤尚未到达时的状态行，避免发送后界面毫无动静 */
function RunningHint({ startedAt }: { startedAt: number | null }) {
  const now = useNow(true);
  const elapsed = startedAt ? durationText(now - startedAt) : '';
  return (
    <div className="running-hint" role="status">
      <span className="running-pulse" aria-hidden />
      <span className="running-label">正在准备…</span>
      {elapsed && (
        <span className="running-clock" aria-hidden>
          {elapsed}
        </span>
      )}
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
  const runningSessionId = useAppStore((s) => s.runningSessionId);
  const runningStartedAt = useAppStore((s) => s.runningStartedAt);
  const turns = useAppStore((s) => s.turnsBySession[currentSessionId] ?? EMPTY_TURNS);

  const scrollRef = useRef<HTMLDivElement>(null);
  const stickBottom = useRef(true);

  const current = sessions.find((s) => s.id === currentSessionId);
  const total = messages.length + (streamingMsg ? 1 : 0);
  const runningHere = runningSessionId !== null && runningSessionId === currentSessionId;

  // 结算后的轮次跟随它所属的回答消息；仍在执行、以及找不到对应回答的轮次落在消息流末尾
  const settled = new Map<string, TurnTrace>();
  const orphans: TurnTrace[] = [];
  let liveTurn: TurnTrace | undefined;
  for (const turn of turns) {
    if (turn.endedAt === null) {
      liveTurn = turn;
      continue;
    }
    settled.set(turn.msgId, turn);
    if (!messages.some((m) => m.id === turn.msgId)) orphans.push(turn);
  }
  const trailing = liveTurn ? [...orphans, liveTurn] : orphans;
  const hasTrailing = trailing.length > 0;

  useEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [total, streamingMsg?.content, turns.length, liveTurn?.traces.length]);

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
            {messages.map((m) => {
              const turn = m.role === 'assistant' ? settled.get(m.id) : undefined;
              return (
                <Fragment key={m.id}>
                  {turn && <TurnProcess turn={turn} live={false} />}
                  <MessageBubble message={m} />
                </Fragment>
              );
            })}

            {trailing.map((t) => (
              <TurnProcess key={t.msgId} turn={t} live={runningHere && t === liveTurn} />
            ))}

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

            {runningHere && !hasTrailing && !streamingMsg && (
              <RunningHint startedAt={runningStartedAt} />
            )}
          </div>
        )}
      </div>

      <Composer />
    </main>
  );
}

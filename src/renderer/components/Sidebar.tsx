import { useAppStore } from '../store';
import { relativeTime } from '../lib/format';

export function Sidebar() {
  const sessions = useAppStore((s) => s.sessions);
  const currentSessionId = useAppStore((s) => s.currentSessionId);
  const selectSession = useAppStore((s) => s.selectSession);
  const createSession = useAppStore((s) => s.createSession);
  const removeSession = useAppStore((s) => s.removeSession);

  return (
    <aside className="sidebar">
      <button className="new-session-btn" onClick={() => void createSession()}>
        <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
          <path d="M12 5v14M5 12h14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
        </svg>
        新会话
      </button>

      <div className="session-list">
        {sessions.map((s) => (
          <div
            key={s.id}
            className={`session-item ${s.id === currentSessionId ? 'active' : ''}`}
            onClick={() => void selectSession(s.id)}
          >
            <span className="session-title">{s.title || '新会话'}</span>
            <span className="session-time">{relativeTime(s.updatedAt)}</span>
            <button
              className="session-delete"
              title="删除会话"
              onClick={(e) => {
                e.stopPropagation();
                if (confirm(`删除会话「${s.title}」？`)) void removeSession(s.id);
              }}
            >
              <svg viewBox="0 0 24 24" width="12" height="12" aria-hidden>
                <path
                  d="M6 6l12 12M18 6L6 18"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                />
              </svg>
            </button>
          </div>
        ))}
      </div>
    </aside>
  );
}

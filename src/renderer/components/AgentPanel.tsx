import type { JSX } from 'react';
import { useAppStore } from '../store';
import { clockTime } from '../lib/format';
import { AGENT_LABELS, type AgentName, type AgentStatus } from '../../shared/types';

const STATE_LABELS: Record<AgentStatus['state'], string> = {
  idle: '空闲',
  thinking: '思考中',
  acting: '执行中',
  'waiting-approval': '等待确认',
  done: '完成',
  error: '错误'
};

const AGENT_ICONS: Record<AgentName, JSX.Element> = {
  main: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path d="M12 2 21 7v10l-9 5-9-5V7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <circle cx="12" cy="12" r="2.8" fill="currentColor" />
    </svg>
  ),
  file: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <path d="M7 3h7l4 4v14H7z" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M14 3v4h4" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinejoin="round" />
      <path d="M9.5 12h5M9.5 15.5h5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  ),
  computer: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <rect x="7" y="7" width="10" height="10" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <rect x="10" y="10" width="4" height="4" fill="currentColor" />
      <path d="M12 3.5V7M12 17v3.5M3.5 12H7M17 12h3.5M6 6l1.8 1.8M18 6l-1.8 1.8M6 18l1.8-1.8M18 18l-1.8-1.8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  ),
  search: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <circle cx="11" cy="11" r="6.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M16 16l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" />
    </svg>
  ),
  browser: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <ellipse cx="12" cy="12" rx="3.8" ry="8.5" fill="none" stroke="currentColor" strokeWidth="1.5" />
      <path d="M3.5 12h17" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  ),
  ssh: (
    <svg viewBox="0 0 24 24" width="15" height="15" aria-hidden>
      <rect x="3" y="4" width="18" height="16" rx="2" fill="none" stroke="currentColor" strokeWidth="1.8" />
      <path d="M7 9.5l3 2.5-3 2.5M12.5 15H17" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
};

function AgentCard({ status }: { status: AgentStatus }) {
  return (
    <div className={`agent-card state-${status.state}`}>
      <div className="agent-head">
        <span className="agent-icon">{AGENT_ICONS[status.agent]}</span>
        <span className="agent-name">{AGENT_LABELS[status.agent]}</span>
        <span className={`agent-dot dot-${status.state}`} />
      </div>
      <div className="agent-state-line">
        <span className={`state-tag tag-${status.state}`}>{STATE_LABELS[status.state]}</span>
      </div>
      {status.detail && <p className="agent-detail">{status.detail}</p>}
    </div>
  );
}

function LogPanel() {
  const logs = useAppStore((s) => s.logs);
  return (
    <div className="log-panel">
      <details>
        <summary>执行日志（{logs.length}）</summary>
        <div className="log-list">
          {logs.length === 0 ? (
            <p className="log-empty">暂无日志</p>
          ) : (
            [...logs].reverse().map((l) => (
              <div key={l.id} className={`log-line level-${l.level}`}>
                <span className="log-time">{clockTime(l.ts)}</span>
                <span className="log-agent">[{l.agent}]</span>
                <span className="log-text">{l.text}</span>
              </div>
            ))
          )}
        </div>
      </details>
    </div>
  );
}

export function AgentPanel() {
  const agents = useAppStore((s) => s.agents);
  return (
    <aside className="agent-panel">
      <h3 className="panel-title">Agent 团队</h3>
      <div className="agent-cards">
        {(['main', 'file', 'computer', 'search', 'browser', 'ssh'] as AgentName[]).map((name) => (
          <AgentCard key={name} status={agents[name]} />
        ))}
      </div>
      <LogPanel />
    </aside>
  );
}

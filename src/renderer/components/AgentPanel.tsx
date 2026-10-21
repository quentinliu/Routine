import { useAppStore } from '../store';
import { clockTime } from '../lib/format';
import { TaskTodoPanel } from './TaskTodoPanel';

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
  return (
    <aside className="agent-panel">
      <TaskTodoPanel />
      <LogPanel />
    </aside>
  );
}

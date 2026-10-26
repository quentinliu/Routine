import { useMemo } from 'react';
import { useAppStore } from '../store';
import { clockTime } from '../lib/format';
import { DbStatusPanel } from './DbStatusPanel';

/**
 * 执行日志只承载基础设施事件（MCP 连接 / 浏览器 Agent / 定时调度 / 审批超时与取消）。
 * 任务内过程（协议降级、重写、中止、工具失败）改由「执行过程」时间线与「对话日志」承担，
 * 避免同一件事在三个入口重复出现，也避免挤占 500 条环形缓冲。
 */
function LogPanel() {
  const logs = useAppStore((s) => s.logs);
  const infra = useMemo(() => logs.filter((l) => l.scope === 'infra'), [logs]);
  return (
    <div className="log-panel">
      <details>
        <summary title="仅显示基础设施类事件：MCP / 浏览器 / 定时任务 / 审批超时与取消">
          执行日志（{infra.length}）
        </summary>
        <div className="log-list">
          {infra.length === 0 ? (
            <p className="log-empty">暂无基础设施事件</p>
          ) : (
            [...infra].reverse().map((l) => (
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
      <DbStatusPanel />
      <LogPanel />
    </aside>
  );
}

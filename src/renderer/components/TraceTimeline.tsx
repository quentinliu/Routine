import { useEffect, useRef } from 'react';
import { type AgentTraceEvent } from '../../shared/types';

type TraceLine =
  | { kind: 'thought'; text: string }
  | { kind: 'tool-start'; e: AgentTraceEvent }
  | { kind: 'tool-end'; e: AgentTraceEvent };

/** 连续的 thought 流式增量合并为一行；todo.write 的调用条目走右侧专属面板，此处过滤 */
function toLines(traces: AgentTraceEvent[]): TraceLine[] {
  const lines: TraceLine[] = [];
  for (const e of traces) {
    if (e.phase === 'thought') {
      const last = lines[lines.length - 1];
      if (last?.kind === 'thought') last.text += e.thought ?? '';
      else lines.push({ kind: 'thought', text: e.thought ?? '' });
      continue;
    }
    if (e.tool === 'todo.write') continue;
    if (e.phase === 'tool-start') lines.push({ kind: 'tool-start', e });
    else lines.push({ kind: 'tool-end', e });
  }
  return lines;
}

function ToolLine({ e }: { e: AgentTraceEvent }) {
  const ok = !e.error;
  return (
    <div className={`trace-item trace-tool ${ok ? 'trace-ok' : 'trace-err'}`}>
      <span className="trace-mark">{ok ? '✓' : '✗'}</span>
      <span className="trace-tool-name">{e.tool}</span>
      {e.resultDigest && <span className="trace-digest">{e.resultDigest}</span>}
      {typeof e.durationMs === 'number' && (
        <span className="trace-meta">{(e.durationMs / 1000).toFixed(1)}s</span>
      )}
    </div>
  );
}

export function TraceTimeline({ traces, live }: { traces: AgentTraceEvent[]; live: boolean }) {
  const lines = toLines(traces);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  // 执行期间强制展开（实时可见）；结束后自动折叠，用户可手动展开回看
  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = live;
  }, [live]);

  if (lines.length === 0) return null;
  return (
    <details className="trace-timeline" ref={detailsRef}>
      <summary>思考与执行过程（{lines.length}）</summary>
      <div className="trace-list">
        {lines.map((line, i) =>
          line.kind === 'thought' ? (
            <div key={i} className="trace-thought">{line.text}</div>
          ) : line.kind === 'tool-start' ? (
            <div key={i} className="trace-item trace-tool trace-start">
              <span className="trace-mark">▶</span>
              <span className="trace-tool-name">{line.e.tool}</span>
              {line.e.argsDigest && <span className="trace-digest">{line.e.argsDigest}</span>}
            </div>
          ) : (
            <ToolLine key={i} e={line.e} />
          )
        )}
      </div>
    </details>
  );
}

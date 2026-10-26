import { useState, type ReactNode } from 'react';
import type { AgentTraceEvent } from '../../shared/types';
import type { TurnTrace } from '../store';
import { durationText } from '../lib/format';
import { useNow } from '../lib/useNow';
import { summarizeArgs, summarizeResult, toolMeta, type ToolKind } from '../lib/tools';

/* ===== 过程模型：把事件流折叠成「思考块 + 工具调用」两类行 ===== */

interface ThinkItem {
  kind: 'think';
  key: string;
  text: string;
}

interface ToolItem {
  kind: 'tool';
  key: string;
  name: string;
  args?: string;
  result?: string;
  error?: boolean;
  durationMs?: number;
  running: boolean;
}

interface NoticeItem {
  kind: 'notice';
  key: string;
  text: string;
  error?: boolean;
}

type ProcItem = ThinkItem | ToolItem | NoticeItem;

function buildItems(traces: AgentTraceEvent[]): ProcItem[] {
  const items: ProcItem[] = [];
  for (const e of traces) {
    if (e.phase === 'notice') {
      const text = e.notice ?? '';
      if (!text) continue;
      items.push({ kind: 'notice', key: `notice-${items.length}`, text, error: e.error });
      continue;
    }
    if (e.phase === 'thought') {
      const text = e.thought ?? '';
      if (!text) continue;
      const last = items[items.length - 1];
      if (last?.kind === 'think') last.text += text;
      else items.push({ kind: 'think', key: `think-${items.length}`, text });
      continue;
    }
    if (e.phase === 'tool-start') {
      items.push({
        kind: 'tool',
        key: `tool-${items.length}`,
        name: e.tool ?? 'tool',
        args: e.argsDigest,
        running: true
      });
      continue;
    }
    // tool-end：匹配最近一个同名、尚未结束的调用（同名工具可连续出现）
    for (let i = items.length - 1; i >= 0; i--) {
      const item = items[i];
      if (item.kind === 'tool' && item.running && item.name === (e.tool ?? 'tool')) {
        item.running = false;
        item.result = e.resultDigest;
        item.error = e.error;
        item.durationMs = e.durationMs;
        break;
      }
    }
  }
  return items;
}

/** 思考块的折叠摘要：取最后一段的首行，避免长文本把过程行撑开 */
function thinkSummary(text: string): string {
  const paragraphs = text.split(/\n\s*\n/);
  const last = paragraphs[paragraphs.length - 1] ?? '';
  const firstLine = last.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return firstLine.replaceAll('**', '').slice(0, 120);
}

/* ===== 图标 ===== */

function ToolGlyph({ kind }: { kind: ToolKind }) {
  switch (kind) {
    case 'file':
      return (
        <>
          <path d="M7 3h6l4 4v14H7z" />
          <path d="M13 3v4h4" />
        </>
      );
    case 'search':
      return (
        <>
          <circle cx="11" cy="11" r="5.5" />
          <path d="M15.2 15.2 20 20" />
        </>
      );
    case 'terminal':
      return (
        <>
          <rect x="3.5" y="5" width="17" height="14" rx="2.5" />
          <path d="M7.5 10l2.6 2.5-2.6 2.5M13 15h4" />
        </>
      );
    case 'browser':
      return (
        <>
          <circle cx="12" cy="12" r="8.5" />
          <path d="M3.5 12h17M12 3.5c2.4 2.3 3.6 5.2 3.6 8.5s-1.2 6.2-3.6 8.5c-2.4-2.3-3.6-5.2-3.6-8.5S9.6 5.8 12 3.5z" />
        </>
      );
    case 'db':
      return (
        <>
          <ellipse cx="12" cy="6" rx="7.5" ry="2.8" />
          <path d="M4.5 6v12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8V6" />
          <path d="M4.5 12c0 1.5 3.4 2.8 7.5 2.8s7.5-1.3 7.5-2.8" />
        </>
      );
    case 'ssh':
      return (
        <>
          <rect x="3.5" y="4" width="17" height="6.5" rx="1.8" />
          <rect x="3.5" y="13.5" width="17" height="6.5" rx="1.8" />
          <path d="M7 7.2h.01M7 16.8h.01" />
        </>
      );
    case 'skill':
      return <path d="M12 3.5l1.9 4.6 4.6 1.9-4.6 1.9L12 16.5l-1.9-4.6L5.5 10l4.6-1.9zM18 16l.9 2.1L21 19l-2.1.9L18 22l-.9-2.1L15 19l2.1-.9z" />;
    case 'todo':
      return (
        <>
          <path d="M4 7l2 2 3.5-3.5M4 17l2 2 3.5-3.5" />
          <path d="M12.5 7.5H20M12.5 17.5H20" />
        </>
      );
    case 'mcp':
      return (
        <>
          <path d="M9 3v5M15 3v5" />
          <rect x="5.5" y="8" width="13" height="7" rx="2.2" />
          <path d="M12 15v6" />
        </>
      );
    default:
      return (
        <>
          <rect x="8" y="8" width="8" height="8" rx="1.6" />
          <path d="M12 3.5v4.5M12 16v4.5M3.5 12H8M16 12h4.5" />
        </>
      );
  }
}

function Chevron({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" aria-hidden>
      <path
        d="M9.5 6l6 6-6 6"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/* ===== 行 ===== */

interface RowProps {
  glyph: ReactNode;
  running?: boolean;
  error?: boolean;
  /** 告警（非失败）：用 warn 色区分于工具失败 */
  warn?: boolean;
  label: string;
  summary: string;
  meta?: string;
  open?: boolean;
  expandable?: boolean;
  onToggle?: () => void;
}

function ProcRow({
  glyph,
  running,
  error,
  warn,
  label,
  summary,
  meta,
  open,
  expandable,
  onToggle
}: RowProps) {
  return (
    <div
      className={`proc-row${error ? ' is-error' : warn ? ' is-notice' : ''}`}
      data-expandable={expandable || undefined}
      role={expandable ? 'button' : undefined}
      tabIndex={expandable ? 0 : undefined}
      aria-expanded={expandable ? !!open : undefined}
      onClick={expandable ? onToggle : undefined}
      onKeyDown={
        expandable
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle?.();
              }
            }
          : undefined
      }
    >
      <span className="proc-glyph">
        {running ? (
          <span className="proc-spinner" aria-hidden />
        ) : (
          <>
            <span className="proc-glyph-idle">
              <svg
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden
              >
                {glyph}
              </svg>
            </span>
            {expandable && <Chevron className="proc-chevron proc-glyph-hover" />}
          </>
        )}
      </span>
      <span className="proc-label">{label}</span>
      {summary && (
        <>
          <span className="proc-dot" aria-hidden />
          <span className="proc-sum">{summary}</span>
        </>
      )}
      {meta && <span className="proc-meta">{meta}</span>}
    </div>
  );
}

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(item.name);
  const argsSummary = summarizeArgs(item.args);
  const resultSummary = summarizeResult(item.result);
  const expandable = Boolean(item.args || item.result);
  const summary = item.error ? resultSummary || argsSummary : argsSummary || resultSummary;
  return (
    <>
      <ProcRow
        glyph={<ToolGlyph kind={meta.kind} />}
        running={item.running}
        error={item.error}
        label={meta.label}
        summary={summary}
        meta={
          item.running
            ? undefined
            : typeof item.durationMs === 'number'
              ? `${(item.durationMs / 1000).toFixed(1)}s`
              : undefined
        }
        open={open}
        expandable={expandable}
        onToggle={() => setOpen((v) => !v)}
      />
      {open && expandable && (
        <div className="proc-io">
          {item.args && (
            <div className="proc-io-row">
              <span className="proc-io-label">输入</span>
              <span className="proc-io-text">{item.args}</span>
            </div>
          )}
          {item.result && (
            <div className="proc-io-row">
              <span className="proc-io-label">输出</span>
              <span className={`proc-io-text${item.error ? ' is-error' : ''}`}>{item.result}</span>
            </div>
          )}
        </div>
      )}
    </>
  );
}

/** 任务内告警行：与对话日志的 event 行同源，实时呈现，不可展开 */
function NoticeRow({ item }: { item: NoticeItem }) {
  return (
    <ProcRow
      glyph={
        <>
          <path d="M12 4.5 21 20H3z" />
          <path d="M12 10v4.6M12 17.4h.01" />
        </>
      }
      error={item.error}
      warn={!item.error}
      label={item.error ? '失败' : '告警'}
      summary={item.text}
    />
  );
}

/* ===== 一轮任务的执行过程 ===== */

export function TurnProcess({ turn, live }: { turn: TurnTrace; live: boolean }) {
  // 用户手动开合过的行不再被自动状态覆盖
  const [overrides, setOverrides] = useState<Record<string, boolean>>({});
  const items = buildItems(turn.traces);
  const [open, setOpen] = useState(live);
  const [manualHead, setManualHead] = useState(false);
  const [prevLive, setPrevLive] = useState(live);

  // 执行中展开、结算后自动收起；用户点过表头后以用户选择为准
  if (prevLive !== live) {
    setPrevLive(live);
    if (!manualHead) setOpen(live);
  }

  const now = useNow(live);
  /** 最后一段思考：运行中默认展开并显示为运行态 */
  const lastThink = items.findLast((i) => i.kind === 'think');
  const toolCount = items.filter((i) => i.kind === 'tool').length;
  const failed =
    items.some((i) => i.kind === 'tool' && i.error) ||
    items.some((i) => i.kind === 'notice' && i.error);
  const elapsed = Math.max(0, (turn.endedAt ?? now) - turn.startedAt);
  const duration = durationText(elapsed);

  const headLabel = live ? '执行中' : failed ? '执行结束（有失败）' : '已工作';
  const headMeta = [duration, toolCount > 0 ? `${toolCount} 步` : ''].filter(Boolean).join(' · ');

  function toggleItem(key: string, fallback: boolean) {
    setOverrides((prev) => ({ ...prev, [key]: !(prev[key] ?? fallback) }));
  }

  return (
    <div className="proc" data-open={open || undefined}>
      <button
        type="button"
        className="proc-head"
        aria-expanded={open}
        onClick={() => {
          setManualHead(true);
          setOpen((v) => !v);
        }}
      >
        {live ? (
          <span className="proc-pulse" aria-hidden />
        ) : (
          <span className={`proc-state${failed ? ' is-error' : ''}`} aria-hidden />
        )}
        <span className={`proc-head-label${live ? ' proc-shimmer' : ''}`}>{headLabel}</span>
        {headMeta && <span className="proc-head-meta">{headMeta}</span>}
        <Chevron className="proc-head-chevron" />
      </button>

      {open && items.length > 0 && (
        <div className="proc-list">
          {items.map((item) => {
            if (item.kind === 'think') {
              const fallback = live && item.key === lastThink?.key;
              const itemOpen = overrides[item.key] ?? fallback;
              return (
                <div key={item.key} className="proc-item">
                  <ProcRow
                    glyph={
                      <>
                        <path d="M12 4.5a5 5 0 0 1 5 5c0 1.8-1 2.9-1.7 3.9-.5.7-.8 1.4-.8 2.1h-5c0-.7-.3-1.4-.8-2.1C7.9 12.4 7 11.3 7 9.5a5 5 0 0 1 5-5z" />
                        <path d="M10 18.5h4M10.5 21h3" />
                      </>
                    }
                    running={live && item.key === lastThink?.key}
                    label="思考"
                    summary={thinkSummary(item.text)}
                    open={itemOpen}
                    expandable
                    onToggle={() => toggleItem(item.key, fallback)}
                  />
                  {itemOpen && <div className="proc-think">{item.text}</div>}
                </div>
              );
            }
            if (item.kind === 'notice') return <NoticeRow key={item.key} item={item} />;
            return <ToolRow key={item.key} item={item} />;
          })}
        </div>
      )}
    </div>
  );
}

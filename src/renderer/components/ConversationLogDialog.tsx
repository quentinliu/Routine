import { useCallback, useEffect, useState } from 'react';
import type {
  ConversationLogLine,
  ConversationLogView,
  ConversationTaskMeta
} from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { clockTime } from '../lib/format';

function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  try {
    return JSON.stringify(content, null, 2);
  } catch {
    return String(content);
  }
}

function stepSummary(line: ConversationLogLine): string {
  const step = line.step as
    | { type: string; thought?: string; reason?: string; calls?: Array<{ name: string }> }
    | undefined;
  if (!step) return '';
  if (step.type === 'tool_calls') {
    return `${(step.calls ?? []).map((c) => c.name).join(', ') || '无调用'}`;
  }
  if (step.type === 'answer') return step.reason ? `answer(${step.reason})` : 'answer';
  return step.type;
}

function RoundBlock({ line }: { line: ConversationLogLine }) {
  const [open, setOpen] = useState(false);
  // read() 已把增量 msgs / systemRef 物化成完整数组，这里只做防空
  const messages = Array.isArray(line.messages)
    ? (line.messages as Array<{ role: string; content: unknown }>)
    : [];
  return (
    <div className="convlog-round">
      <button type="button" className="convlog-round-head" onClick={() => setOpen((v) => !v)}>
        <span className="convlog-round-title">
          第 {(line.i as number) + 1} 轮 · {String(line.strategy)} · {String(line.ms)}ms ·{' '}
          {stepSummary(line)}
        </span>
        <span className="convlog-round-meta">
          {clockTime(line.at)} · 输出 {textOf(line.content).length} 字符
        </span>
      </button>
      {open && (
        <div className="convlog-round-body">
          <details>
            <summary>system（{textOf(line.system).length} 字符）</summary>
            <pre className="convlog-pre">{textOf(line.system)}</pre>
          </details>
          <details open>
            <summary>messages（{messages.length} 条）</summary>
            {messages.map((m, i) => (
              <div key={i} className="convlog-msg">
                <span className={`convlog-role is-${m.role}`}>{m.role}</span>
                <pre className="convlog-pre">{textOf(m.content)}</pre>
              </div>
            ))}
          </details>
          <details>
            <summary>模型输出（finish: {String(line.finishReason)}）</summary>
            <pre className="convlog-pre">{textOf(line.content)}</pre>
            {line.step ? (
              <pre className="convlog-pre">{`step = ${textOf(line.step)}`}</pre>
            ) : null}
            {line.usage ? (
              <pre className="convlog-pre">{`tokens = ${textOf(line.usage)}`}</pre>
            ) : null}
          </details>
        </div>
      )}
    </div>
  );
}

function SafetyBlock({ line }: { line: ConversationLogLine }) {
  const outcome = String(line.outcome);
  const label =
    outcome === 'approved'
      ? '已同意'
      : outcome === 'denied'
        ? '已拒绝'
        : outcome === 'canceled'
          ? '已取消（未送达/任务中止）'
          : '确认超时（未执行）';
  return (
    <div className={`convlog-eventline is-${outcome === 'approved' ? 'info' : 'warn'}`}>
      确认 · {String(line.tool)} · {String(line.risk)} · {label} · 决策耗时 {String(line.waitMs)}ms
      <pre className="convlog-pre">{textOf(line.detail)}</pre>
    </div>
  );
}

function ToolBlock({ line }: { line: ConversationLogLine }) {
  const [open, setOpen] = useState(false);
  const ok = line.ok !== false;
  const state =
    line.denied === true
      ? '被拒绝'
      : line.timedOut === true
        ? '确认超时'
        : line.canceled === true
          ? '已取消'
          : ok
            ? '成功'
            : '失败';
  const approval = typeof line.approvalMs === 'number' ? ` · 审批 ${line.approvalMs}ms` : '';
  return (
    <div className={`convlog-toolline${ok ? '' : ' is-error'}`}>
      <button type="button" className="convlog-toolline-head" onClick={() => setOpen((v) => !v)}>
        <span className="convlog-toolline-title">
          工具 · {String(line.name)} · {state} · {String(line.durationMs)}ms{approval}
        </span>
        <span className="convlog-round-meta">
          {clockTime(line.at)} · 结果 {String(line.resultChars)} 字符
        </span>
      </button>
      {open && (
        <div className="convlog-round-body">
          <details open>
            <summary>参数（已脱敏）</summary>
            <pre className="convlog-pre">{textOf(line.argsDigest)}</pre>
          </details>
          <details>
            <summary>结果摘要</summary>
            <pre className="convlog-pre">{textOf(line.resultDigest)}</pre>
          </details>
        </div>
      )}
    </div>
  );
}

function LineBlock({ line }: { line: ConversationLogLine }) {
  if (line.type === 'round') return <RoundBlock line={line} />;
  if (line.type === 'tool') return <ToolBlock line={line} />;
  if (line.type === 'safety') return <SafetyBlock line={line} />;
  if (line.type === 'final') {
    return (
      <div className="convlog-final">
        <span className="convlog-role is-assistant">final</span>
        <pre className="convlog-pre">{textOf(line.text)}</pre>
      </div>
    );
  }
  if (line.type === 'error') {
    // 新日志的 error 行已自带「任务失败:」前缀，旧日志只有原始错误，两者都保证可读
    const text = textOf(line.text);
    return (
      <div className="convlog-eventline is-error">
        {text.startsWith('任务失败') ? text : `任务失败：${text}`}
      </div>
    );
  }
  if (line.type === 'event') {
    return (
      <div className={`convlog-eventline is-${String(line.level)}`}>
        事件：{textOf(line.text)}
      </div>
    );
  }
  return null;
}

export function ConversationLogDialog() {
  const setConvLogOpen = useAppStore((s) => s.setConvLogOpen);
  const requestConfirm = useAppStore((s) => s.requestConfirm);
  const setNotice = useAppStore((s) => s.setNotice);
  const [list, setList] = useState<ConversationTaskMeta[]>([]);
  const [selected, setSelected] = useState<ConversationLogView | null>(null);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setList(await api.conversationList(50).catch(() => []));
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  async function open(id: string): Promise<void> {
    setLoading(true);
    try {
      setSelected(await api.conversationGet(id));
    } finally {
      setLoading(false);
    }
  }

  function copyJson(): void {
    if (selected) void navigator.clipboard.writeText(JSON.stringify(selected, null, 2));
  }

  /** 删除单个任务日志：清掉详情区选中态，避免仍展示已消失的文件内容 */
  async function doRemove(id: string): Promise<void> {
    try {
      await api.conversationDelete(id);
      if (selected?.meta.id === id) setSelected(null);
      await refresh();
    } catch (err) {
      setNotice(`删除日志失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  async function doClear(): Promise<void> {
    try {
      await api.conversationClear();
      setSelected(null);
      await refresh();
    } catch (err) {
      setNotice(`清空日志失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function remove(t: ConversationTaskMeta): void {
    requestConfirm({
      message: `删除对话日志「${t.task}」？\n\n仅删除该任务的模型调用记录，不可恢复；不影响会话内容。`,
      danger: true,
      onConfirm: () => {
        void doRemove(t.id);
      }
    });
  }

  function clearAll(): void {
    requestConfirm({
      message: `清空全部 ${list.length} 条对话日志？\n\n不可恢复；不影响会话内容与正在生成的回答。`,
      danger: true,
      onConfirm: () => {
        void doClear();
      }
    });
  }

  return (
    <div className="modal-overlay" onClick={() => setConvLogOpen(false)}>
      <div className="modal convlog-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-head">
          <h3>完整对话日志</h3>
          <div className="convlog-head-actions">
            {selected && (
              <button className="btn-mini" onClick={copyJson}>
                复制 JSON
              </button>
            )}
            <button className="btn-mini" onClick={() => void refresh()}>
              刷新
            </button>
            <button className="btn-mini danger" onClick={clearAll} disabled={list.length === 0}>
              清空全部
            </button>
            <button className="modal-close" onClick={() => setConvLogOpen(false)}>
              ×
            </button>
          </div>
        </div>

        <div className="convlog-layout">
          <div className="convlog-list">
            {list.length === 0 && <p className="convlog-empty">暂无任务日志</p>}
            {list.map((t) => (
              // 用 div 承载行，内部才能放删除按钮（button 不能嵌套 button）
              <div
                key={t.id}
                role="button"
                tabIndex={0}
                className={`convlog-item${selected?.meta.id === t.id ? ' active' : ''}`}
                onClick={() => void open(t.id)}
                onKeyDown={(e) => {
                  if (e.key !== 'Enter' && e.key !== ' ') return;
                  e.preventDefault();
                  void open(t.id);
                }}
              >
                <span className="convlog-item-task">{t.task}</span>
                <span className="convlog-item-meta">
                  {clockTime(t.ts)} · {t.provider}
                </span>
                <button
                  type="button"
                  className="convlog-item-delete"
                  title="删除该任务日志"
                  onClick={(e) => {
                    e.stopPropagation();
                    remove(t);
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

          <div className="convlog-detail">
            {loading && <p className="convlog-empty">加载中…</p>}
            {!loading && !selected && <p className="convlog-empty">选择左侧任务查看完整对话</p>}
            {!loading &&
              selected &&
              selected.lines.map((line, i) => <LineBlock key={i} line={line} />)}
          </div>
        </div>
      </div>
    </div>
  );
}

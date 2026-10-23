import { useCallback, useEffect, useState } from 'react';
import type { RecurrenceType, TodoRunRecord, TodoTask } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

interface TodoForm {
  title: string;
  instruction: string;
  type: RecurrenceType;
  time: string;
  weekday: number;
  day: number;
}

const EMPTY_FORM: TodoForm = {
  title: '',
  instruction: '',
  type: 'daily',
  time: '09:00',
  weekday: 1,
  day: 1
};

function fmtDateTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getMonth() + 1}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function dateLocal(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function recurrenceLabel(t: TodoTask): string {
  const r = t.recurrence;
  if (r.type === 'anytime') return '每日 · 不定时';
  if (r.type === 'daily') return `每天 ${(r.time ?? '').trim() || '09:00'}`;
  if (r.type === 'weekly') return `每${WEEKDAYS[(r.weekday ?? 1) - 1]} ${(r.time ?? '').trim() || '09:00'}`;
  return `每月 ${r.day ?? 1} 日 ${(r.time ?? '').trim() || '09:00'}`;
}

function todayStatus(t: TodoTask, runs: TodoRunRecord[]): { text: string; cls: string } {
  if (t.recurrence.type !== 'anytime') return { text: '', cls: '' };
  const today = dateLocal(Date.now());
  const doneToday = runs.some((r) => r.taskId === t.id && r.ok && dateLocal(r.startedAt) === today);
  if (doneToday) return { text: '今日已完成', cls: 'chip-done' };
  if (t.lastChecklistDate === today) return { text: '今日已尝试', cls: 'chip-tried' };
  return { text: '今日待执行', cls: 'chip-pending' };
}

export function TodoDialog() {
  const setTodoDialogOpen = useAppStore((s) => s.setTodoDialogOpen);
  const selectSession = useAppStore((s) => s.selectSession);
  const requestConfirm = useAppStore((s) => s.requestConfirm);

  const [tasks, setTasks] = useState<TodoTask[]>([]);
  const [runs, setRuns] = useState<TodoRunRecord[]>([]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState<TodoForm>(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(async () => {
    try {
      const data = await api.todoList();
      setTasks(data.tasks);
      setRuns(data.runs);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void reload();
    return api.onTodoRunsChanged(() => void reload());
  }, [reload]);

  function openCreate(): void {
    setEditingId(null);
    setForm(EMPTY_FORM);
    setShowForm(true);
    setError(null);
  }

  function openEdit(task: TodoTask): void {
    setEditingId(task.id);
    setForm({
      title: task.title,
      instruction: task.instruction,
      type: task.recurrence.type,
      time: task.recurrence.time ?? '09:00',
      weekday: task.recurrence.weekday ?? 1,
      day: task.recurrence.day ?? 1
    });
    setShowForm(true);
    setError(null);
  }

  async function save(): Promise<void> {
    if (!form.title.trim() || !form.instruction.trim()) {
      setError('标题和执行指令不能为空');
      return;
    }
    const task: TodoTask = {
      id: editingId ?? crypto.randomUUID(),
      title: form.title.trim(),
      instruction: form.instruction.trim(),
      recurrence: {
        type: form.type,
        time: form.type === 'anytime' ? undefined : form.time,
        weekday: form.type === 'weekly' ? form.weekday : undefined,
        day: form.type === 'monthly' ? form.day : undefined
      },
      enabled: true,
      nextRunAt: 0,
      createdAt: 0,
      updatedAt: 0
    };
    try {
      await api.todoSave(task);
      setShowForm(false);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function toggle(task: TodoTask): Promise<void> {
    setBusy(task.id);
    try {
      await api.todoToggle(task.id, !task.enabled);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  async function runNow(task: TodoTask): Promise<void> {
    setBusy(task.id);
    try {
      await api.todoRun(task.id);
      await reload();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  }

  function remove(task: TodoTask): void {
    requestConfirm({
      message: `删除定时任务「${task.title}」及其运行历史？`,
      danger: true,
      onConfirm: () => {
        void doRemove(task);
      }
    });
  }

  async function doRemove(task: TodoTask): Promise<void> {
    setBusy(task.id);
    try {
      await api.todoDelete(task.id);
      await reload();
    } finally {
      setBusy(null);
    }
  }

  function openRunSession(run: TodoRunRecord): void {
    if (!run.sessionId) return;
    setTodoDialogOpen(false);
    void selectSession(run.sessionId);
  }

  return (
    <div className="modal-overlay">
      <div className="modal todo-modal">
        <div className="modal-head">
          <h3>定时任务</h3>
          <button className="btn-primary todo-new" onClick={openCreate}>
            + 新建任务
          </button>
          <button className="modal-close" onClick={() => setTodoDialogOpen(false)}>
            <svg viewBox="0 0 24 24" width="14" height="14" aria-hidden>
              <path d="M6 6l12 12M18 6L6 18" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        {showForm && (
          <div className="todo-form">
            <label className="field">
              <span>任务标题</span>
              <input
                autoFocus
                value={form.title}
                placeholder="例如：每日 AI 资讯速览"
                onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
              />
            </label>
            <label className="field">
              <span>执行指令（交给 Agent 团队执行）</span>
              <textarea
                rows={3}
                value={form.instruction}
                placeholder="例如：搜索今天的 AI 领域重要新闻，挑 5 条总结成简报"
                onChange={(e) => setForm((f) => ({ ...f, instruction: e.target.value }))}
              />
            </label>
            <div className="field">
              <span>重复周期</span>
              <div className="recurrence-row">
                <div className="seg-group">
                  {(['daily', 'weekly', 'monthly', 'anytime'] as RecurrenceType[]).map((t) => (
                    <button
                      key={t}
                      className={`seg-btn ${form.type === t ? 'active' : ''}`}
                      onClick={() => setForm((f) => ({ ...f, type: t }))}
                    >
                      {t === 'daily' ? '每天' : t === 'weekly' ? '每周' : t === 'monthly' ? '每月' : '每日待办'}
                    </button>
                  ))}
                </div>
                {form.type === 'weekly' && (
                  <select
                    value={form.weekday}
                    onChange={(e) => setForm((f) => ({ ...f, weekday: Number(e.target.value) }))}
                  >
                    {WEEKDAYS.map((w, i) => (
                      <option key={w} value={i + 1}>
                        {w}
                      </option>
                    ))}
                  </select>
                )}
                {form.type === 'monthly' && (
                  <select
                    value={form.day}
                    onChange={(e) => setForm((f) => ({ ...f, day: Number(e.target.value) }))}
                  >
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d} 日
                      </option>
                    ))}
                  </select>
                )}
                {form.type !== 'anytime' && (
                  <input
                    type="time"
                    value={form.time}
                    onChange={(e) => setForm((f) => ({ ...f, time: e.target.value }))}
                  />
                )}
              </div>
              {form.type === 'anytime' && (
                <p className="field-hint">不绑定时间：应用启动后检查当日是否完成，未完成将自动排队执行</p>
              )}
            </div>
            <div className="form-actions">
              <button className="btn-secondary" onClick={() => setShowForm(false)}>
                取消
              </button>
              <button className="btn-primary" onClick={() => void save()}>
                保存
              </button>
            </div>
          </div>
        )}

        {error && <p className="file-error">{error}</p>}

        <div className="todo-body">
          {tasks.length === 0 && !showForm && (
            <div className="file-empty">
              <p>还没有定时任务。创建一个，让 Agent 团队每天/每周/每月到点自动干活。</p>
            </div>
          )}
          {tasks.map((task) => (
            <div key={task.id} className={`todo-row ${task.enabled ? '' : 'disabled'}`}>
              <button
                className={`todo-switch ${task.enabled ? 'on' : ''}`}
                disabled={busy === task.id}
                title={task.enabled ? '点击暂停' : '点击启用'}
                onClick={() => void toggle(task)}
              >
                <span className="switch-knob" />
              </button>
              <div className="todo-info">
                <span className="todo-title">{task.title}</span>
                <span className="todo-meta">
                  {recurrenceLabel(task)}
                  {task.recurrence.type !== 'anytime' && task.nextRunAt > 0
                    ? ` · 下次 ${fmtDateTime(task.nextRunAt)}`
                    : ''}
                  {task.lastRunAt && task.recurrence.type !== 'anytime' && ` · 上次 ${fmtDateTime(task.lastRunAt)}`}
                </span>
                {task.recurrence.type === 'anytime' && (() => {
                  const st = todayStatus(task, runs);
                  return <span className={`todo-chip ${st.cls}`}>{st.text}</span>;
                })()}
              </div>
              <div className="todo-actions">
                <button
                  className="btn-mini"
                  disabled={busy === task.id}
                  onClick={() => void runNow(task)}
                >
                  立即运行
                </button>
                <button className="btn-mini" onClick={() => openEdit(task)}>
                  编辑
                </button>
                <button
                  className="btn-mini danger"
                  disabled={busy === task.id}
                  onClick={() => remove(task)}
                >
                  删除
                </button>
              </div>
            </div>
          ))}

          {runs.length > 0 && (
            <details className="todo-runs">
              <summary>运行历史（{runs.length}）</summary>
              <div className="run-list">
                {runs.slice(0, 30).map((run) => (
                  <button key={run.id} className="run-row" onClick={() => openRunSession(run)}>
                    <span className={`run-dot ${run.ok ? 'ok' : 'fail'}`} />
                    <span className="run-time">{fmtDateTime(run.startedAt)}</span>
                    <span className="run-summary">{run.summary || '（无输出）'}</span>
                  </button>
                ))}
              </div>
            </details>
          )}
        </div>
      </div>
    </div>
  );
}

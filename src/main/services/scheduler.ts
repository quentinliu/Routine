import type { LogEntry, TodoRecurrence, TodoRunRecord, TodoTask } from '../../shared/types';
import { getStorage } from './storage';
import { notify } from './notifier';

export type ScheduleRunner = (
  task: TodoTask,
  emitLog: (line: string) => void
) => Promise<{ sessionId: string; ok: boolean; summary: string }>;

export interface SchedulerHooks {
  runner: ScheduleRunner;
  emitLog: (l: LogEntry) => void;
  onRunsChanged: () => void;
}

interface QueueItem {
  task: TodoTask;
  resolve: () => void;
}

const TICK_MS = 30_000;
const CATCH_UP_WINDOW_MS = 24 * 3600_000;
const RETRY_DELAY_MS = 15 * 60_000;

export function todayLocal(ts = Date.now()): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

export function parseTimeToNumbers(time?: string): { hour: number; minute: number } {
  const m = (time ?? '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return { hour: 9, minute: 0 };
  return {
    hour: Math.min(23, Math.max(0, Number(m[1]))),
    minute: Math.min(59, Math.max(0, Number(m[2])))
  };
}

function atTimeOfDay(base: Date, hour: number, minute: number): Date {
  const d = new Date(base);
  d.setHours(hour, minute, 0, 0);
  return d;
}

export function computeNextRun(rec: TodoRecurrence, from: Date): number {
  if (rec.type === 'anytime') {
    const midnight = new Date(from);
    midnight.setHours(0, 0, 0, 0);
    midnight.setDate(midnight.getDate() + 1);
    return midnight.getTime();
  }

  const { hour, minute } = parseTimeToNumbers(rec.time);

  if (rec.type === 'daily') {
    const candidate = atTimeOfDay(from, hour, minute);
    if (candidate.getTime() > from.getTime()) return candidate.getTime();
    candidate.setDate(candidate.getDate() + 1);
    return candidate.getTime();
  }

  if (rec.type === 'weekly') {
    const target = Math.min(7, Math.max(1, rec.weekday ?? 1));
    const currentDay = from.getDay() === 0 ? 7 : from.getDay();
    let delta = target - currentDay;
    if (delta < 0) delta += 7;
    const candidate = atTimeOfDay(from, hour, minute);
    if (delta === 0 && candidate.getTime() <= from.getTime()) delta = 7;
    candidate.setDate(candidate.getDate() + delta);
    return candidate.getTime();
  }

  const day = Math.min(28, Math.max(1, rec.day ?? 1));
  const candidate = atTimeOfDay(from, hour, minute);
  candidate.setDate(day);
  if (candidate.getTime() <= from.getTime()) {
    candidate.setMonth(candidate.getMonth() + 1);
    candidate.setDate(day);
  }
  return candidate.getTime();
}

export function advance(rec: TodoRecurrence, fromTs: number): number {
  let next = computeNextRun(rec, new Date(fromTs));
  let guard = 0;
  while (next <= fromTs && guard < 400) {
    next = computeNextRun(rec, new Date(next + 60_000));
    guard++;
  }
  return next;
}

export class Scheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private hooks: SchedulerHooks | null = null;
  private readonly queue: QueueItem[] = [];
  private readonly queuedIds = new Set<string>();
  private activeCount = 0;
  private paused = false;
  private readonly retriedIds = new Set<string>();

  /** 暂停自动触发（手动 runTaskNow 不受影响） */
  setPaused(value: boolean): void {
    this.paused = value;
  }

  isPaused(): boolean {
    return this.paused;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  bindRunner(hooks: SchedulerHooks): void {
    this.hooks = hooks;
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.checkNow(), TICK_MS);
    setTimeout(() => void this.checkNow(), 3000);
  }

  async checkNow(): Promise<void> {
    if (!this.hooks || this.paused) return;

    const storage = getStorage();
    const now = Date.now();
    const today = todayLocal();
    const { tasks, runs } = storage.loadTodos();
    let dirty = false;

    for (const task of tasks) {
      if (!task.enabled) continue;

      if (task.recurrence.type === 'anytime') {
        if (task.lastChecklistDate === today) continue;
        if (this.queuedIds.has(task.id)) continue;
        task.lastChecklistDate = today;
        task.nextRunAt = computeNextRun(task.recurrence, new Date(now));
        dirty = true;
        void this.enqueue(task);
        continue;
      }

      if (task.nextRunAt > now) continue;
      const missedRecently = now - task.nextRunAt < CATCH_UP_WINDOW_MS;
      task.nextRunAt = advance(task.recurrence, now);
      dirty = true;
      if (missedRecently && !this.queuedIds.has(task.id)) {
        void this.enqueue(task);
      }
    }

    if (dirty) storage.saveTodos(tasks, runs);
  }

  async runTaskNow(taskId: string): Promise<void> {
    if (this.queuedIds.has(taskId)) throw new Error('任务正在排队或执行中');
    const { tasks } = getStorage().loadTodos();
    const task = tasks.find((t) => t.id === taskId);
    if (!task) throw new Error('任务不存在');
    await this.enqueue(task);
  }

  private enqueue(task: TodoTask): Promise<void> {
    this.queuedIds.add(task.id);
    return new Promise<void>((resolve) => {
      this.queue.push({ task, resolve });
      this.pump();
    });
  }

  /** M3：编排器单飞（busy 锁），并发固定为 1；maxConcurrent 配置项已废弃 */
  private maxConcurrent(): number {
    return 1;
  }

  private pump(): void {
    while (this.activeCount < this.maxConcurrent() && this.queue.length > 0) {
      const item = this.queue.shift();
      if (!item) break;
      this.activeCount++;
      void this.execute(item.task)
        .catch((err) => {
          this.hooks?.emitLog({
            id: crypto.randomUUID(),
            ts: Date.now(),
            agent: 'system',
            level: 'error',
            text: `任务执行异常: ${err instanceof Error ? err.message : String(err)}`,
            scope: 'infra'
          });
        })
        .finally(() => {
          this.activeCount--;
          this.queuedIds.delete(item.task.id);
          item.resolve();
          this.pump();
        });
    }
  }

  private async execute(task: TodoTask): Promise<void> {
    if (!this.hooks) return;

    const storage = getStorage();
    const run: TodoRunRecord = {
      id: crypto.randomUUID(),
      taskId: task.id,
      sessionId: '',
      startedAt: Date.now(),
      summary: ''
    };

    try {
      this.hooks.emitLog({
        id: crypto.randomUUID(),
        ts: Date.now(),
        agent: 'system',
        level: 'info',
        text: `定时任务触发: ${task.title}`,
        scope: 'infra'
      });
      const result = await this.hooks.runner(task, (line) =>
        this.hooks?.emitLog({
          id: crypto.randomUUID(),
          ts: Date.now(),
          agent: 'system',
          level: 'info',
          text: line,
          scope: 'infra'
        })
      );
      run.sessionId = result.sessionId;
      run.ok = result.ok;
      run.summary = result.summary;
    } catch (err) {
      run.ok = false;
      run.summary = err instanceof Error ? err.message : String(err);
    } finally {
      run.finishedAt = Date.now();
      const saved = storage.loadTodos();
      const updatedTask = saved.tasks.find((t) => t.id === task.id);
      if (updatedTask) {
        updatedTask.lastRunAt = run.startedAt;
        if (updatedTask.recurrence.type === 'anytime') {
          updatedTask.lastChecklistDate = todayLocal(run.startedAt);
        }
        if (updatedTask.nextRunAt <= Date.now()) {
          updatedTask.nextRunAt = advance(updatedTask.recurrence, Date.now());
        }
      }
      saved.runs.push(run);
      storage.saveTodos(saved.tasks, saved.runs);
      this.hooks.onRunsChanged();
      notify(
        `定时任务${run.ok ? '完成' : '失败'}：${task.title}`,
        run.summary || (run.ok ? '执行成功' : '执行失败')
      );
      // 失败重试语义：首个失败 15 分钟后补跑一次，连续失败不再重试；成功即复位
      if (run.ok) {
        this.retriedIds.delete(task.id);
      } else if (!this.retriedIds.has(task.id)) {
        this.retriedIds.add(task.id);
        this.hooks.emitLog({
          id: crypto.randomUUID(),
          ts: Date.now(),
          agent: 'system',
          level: 'warn',
          text: `任务失败，${RETRY_DELAY_MS / 60_000} 分钟后自动重试: ${task.title}`,
          scope: 'infra'
        });
        setTimeout(() => {
          void this.enqueue(task);
        }, RETRY_DELAY_MS);
      }
    }
  }
}

let scheduler: Scheduler | null = null;

export function getScheduler(): Scheduler {
  if (!scheduler) scheduler = new Scheduler();
  return scheduler;
}

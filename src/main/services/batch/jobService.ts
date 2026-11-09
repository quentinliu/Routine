import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  BATCH_DIMENSIONS,
  type BatchEstimate,
  type BatchInstanceResult,
  type BatchJob,
  type BatchJobInput,
  type BatchJobSnapshot,
  type BatchProgress,
  type BatchReport,
  type BatchWorker,
  type DatasourceConfig
} from '../../../shared/types';
import { getDbService } from '../db/service';
import { getStorage } from '../storage';
import { collectInstance } from './collector';
import {
  buildReport,
  chunk,
  estimateJob,
  isRetryableError,
  normalizeBatchInput
} from './contract';
import { runSuper } from './superAgent';

/** 与 conversationLog.ts 同款白名单，防路径穿越 */
const SAFE_ID = /^[A-Za-z0-9_-]{1,128}$/;

interface JobRuntime {
  snapshot: BatchJobSnapshot;
  controller: AbortController;
  running: boolean;
  lastPersistAt: number;
  lastEmitAt: number;
}

/** 逐实例进度事件的最小间隔：600 台时避免 O(N²) 的全量快照传输 */
const EMIT_THROTTLE_MS = 200;

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function unavailableDimensions(reason: string): BatchInstanceResult['dimensions'] {
  return BATCH_DIMENSIONS.map((name) => ({ name, status: 'unavailable' as const, reason }));
}

/**
 * 批量巡检独立运行时：super 占一个轻量 LLM 会话，worker 是并发的确定性只读采集单元。
 * 刻意不复用单例 Orchestrator——现有 busy 单飞锁会让批量作业与用户对话互相抢占，
 * 且定时任务 maxConcurrent() 恒为 1。本服务自带 per-worker abort / 白名单 / 日志 / 落盘，
 * 因此既有 chat:send 与定时任务路径零改动。
 */
export class BatchService {
  private readonly runtimes = new Map<string, JobRuntime>();
  private emit: (snapshot: BatchJobSnapshot) => void = () => {};
  private dsCache: DatasourceConfig[] = [];

  /** 由 ipc.ts 注入进度发播，避免 services → ipc 的反向依赖 */
  configure(emit: (snapshot: BatchJobSnapshot) => void): void {
    this.emit = emit;
  }

  private enabledIds(): string[] {
    return getDbService()
      .list()
      .filter((d) => d.enabled)
      .map((d) => d.id);
  }

  private datasourceById(id: string): DatasourceConfig | undefined {
    return this.dsCache.find((d) => d.id === id && d.enabled);
  }

  private stateDir(): string {
    return path.join(getStorage().dataDir, 'batch-state');
  }

  private logsDir(): string {
    return path.join(getStorage().dataDir, 'batch-logs');
  }

  private statePath(id: string): string {
    if (!SAFE_ID.test(id)) throw new Error('[INVALID] 非法作业 id');
    return path.join(this.stateDir(), `${id}.json`);
  }

  private writeState(rt: JobRuntime): void {
    fs.mkdirSync(this.stateDir(), { recursive: true });
    const target = this.statePath(rt.snapshot.job.id);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(rt.snapshot), 'utf-8');
    fs.renameSync(tmp, target);
    const jobs = getStorage()
      .loadBatchJobs()
      .filter((j) => j.id !== rt.snapshot.job.id);
    jobs.unshift(rt.snapshot.job);
    getStorage().saveBatchJobs(jobs);
    rt.lastPersistAt = Date.now();
  }

  private readState(id: string): BatchJobSnapshot | null {
    try {
      const raw = fs.readFileSync(this.statePath(id), 'utf-8');
      const parsed: unknown = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? (parsed as BatchJobSnapshot) : null;
    } catch {
      return null;
    }
  }

  /** 节流落盘：按实例更新内存 + 发事件，每秒最多写一次；关键节点强制写 */
  private persist(rt: JobRuntime, force = false): void {
    if (!force && Date.now() - rt.lastPersistAt < 1000) return;
    try {
      this.writeState(rt);
    } catch (err) {
      console.warn(`[batch] 作业状态落盘失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 作业级日志目录独立，避免 30+ worker 挤掉 ConversationLog 的 50 文件保留窗口 */
  private appendLog(rt: JobRuntime, entry: Record<string, unknown>): void {
    const id = rt.snapshot.job.id;
    if (!SAFE_ID.test(id)) return;
    try {
      fs.mkdirSync(this.logsDir(), { recursive: true });
      fs.appendFileSync(
        path.join(this.logsDir(), `${id}.jsonl`),
        `${JSON.stringify({ ts: Date.now(), jobId: id, ...entry })}\n`,
        'utf-8'
      );
    } catch (err) {
      console.warn(`[batch] 作业日志写入失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private computeProgress(s: BatchJobSnapshot): BatchProgress {
    const total = s.job.datasourceIds.length;
    const running = s.workers.filter((w) => w.state === 'running').length;
    return {
      jobId: s.job.id,
      state: s.job.state,
      total,
      succeeded: s.results.filter((r) => r.ok).length,
      failed: s.results.filter((r) => !r.ok).length,
      running,
      pending: Math.max(0, total - s.results.length),
      activeConcurrency: running,
      llmCalls: s.progress.llmCalls,
      elapsedMs: s.job.startedAt ? Date.now() - s.job.startedAt : 0
    };
  }

  private emitSnapshot(rt: JobRuntime): void {
    rt.snapshot.progress = this.computeProgress(rt.snapshot);
    try {
      this.emit(clone(rt.snapshot));
    } catch (err) {
      console.warn(`[batch] 进度事件发送失败: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** 高频点（每个实例采集前后）走节流；作业状态变化与收尾仍全量发播 */
  private emitThrottled(rt: JobRuntime): void {
    const now = Date.now();
    if (now - rt.lastEmitAt < EMIT_THROTTLE_MS) return;
    rt.lastEmitAt = now;
    this.emitSnapshot(rt);
  }

  private makeWorkers(jobId: string, groups: readonly string[][]): BatchWorker[] {
    return groups.map((ids, index) => ({
      id: randomUUID(),
      jobId,
      index,
      datasourceIds: [...ids],
      state: 'pending',
      attempt: 0
    }));
  }

  private upsertResult(rt: JobRuntime, result: BatchInstanceResult): void {
    const list = rt.snapshot.results;
    const idx = list.findIndex((r) => r.datasourceId === result.datasourceId);
    if (idx >= 0) list[idx] = result;
    else list.push(result);
  }

  list(): BatchJob[] {
    const merged = new Map(getStorage().loadBatchJobs().map((j) => [j.id, j]));
    for (const rt of this.runtimes.values()) merged.set(rt.snapshot.job.id, rt.snapshot.job);
    return [...merged.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  estimate(input: BatchJobInput): BatchEstimate {
    return estimateJob(normalizeBatchInput(input, this.enabledIds()));
  }

  get(id: string): BatchJobSnapshot | null {
    const rt = this.runtimes.get(id);
    return rt ? clone(rt.snapshot) : this.readState(id);
  }

  report(id: string): BatchReport | null {
    return this.get(id)?.report ?? null;
  }

  start(input: BatchJobInput): BatchJobSnapshot {
    const job = normalizeBatchInput(input, this.enabledIds());
    if ([...this.runtimes.values()].some((r) => r.running)) {
      throw new Error('[INVALID] 已有批量巡检作业正在运行，请先等待完成或取消');
    }
    const groups = chunk(job.datasourceIds, job.batchSize);
    const total = job.datasourceIds.length;
    const snapshot: BatchJobSnapshot = {
      job,
      workers: this.makeWorkers(job.id, groups),
      results: [],
      progress: {
        jobId: job.id,
        state: 'created',
        total,
        succeeded: 0,
        failed: 0,
        running: 0,
        pending: total,
        activeConcurrency: 0,
        llmCalls: 0,
        elapsedMs: 0
      },
      report: null
    };
    const rt: JobRuntime = {
      snapshot,
      controller: new AbortController(),
      running: true,
      lastPersistAt: 0,
      lastEmitAt: 0
    };
    this.runtimes.set(job.id, rt);
    this.persist(rt, true);
    this.emitSnapshot(rt);
    void this.run(rt, groups).catch((err) => this.fail(rt, err));
    return clone(snapshot);
  }

  cancel(id: string): BatchJobSnapshot | null {
    const rt = this.runtimes.get(id);
    if (!rt || !rt.running) return this.get(id);
    rt.controller.abort();
    rt.snapshot.job.state = 'canceled';
    rt.snapshot.job.endedAt = Date.now();
    this.emitSnapshot(rt);
    return clone(rt.snapshot);
  }

  /** 只重试失败实例：成功结果原样保留，按同一 jobId 续跑（幂等去重） */
  retry(id: string): BatchJobSnapshot {
    const rt = this.runtimes.get(id) ?? this.restore(id);
    if (!rt) throw new Error('[INVALID] 作业不存在');
    if (rt.running) throw new Error('[INVALID] 作业正在运行，无法重试');
    const failedIds = rt.snapshot.results.filter((r) => !r.ok).map((r) => r.datasourceId);
    if (failedIds.length === 0) throw new Error('[INVALID] 没有需要重试的实例');
    rt.snapshot.results = rt.snapshot.results.filter((r) => r.ok);
    const groups = chunk(failedIds, rt.snapshot.job.batchSize);
    rt.snapshot.workers = this.makeWorkers(rt.snapshot.job.id, groups);
    rt.snapshot.report = null;
    rt.controller = new AbortController();
    rt.running = true;
    this.runtimes.set(id, rt);
    this.persist(rt, true);
    this.emitSnapshot(rt);
    void this.run(rt, groups).catch((err) => this.fail(rt, err));
    return clone(rt.snapshot);
  }

  private restore(id: string): JobRuntime | null {
    const snapshot = this.readState(id);
    if (!snapshot) return null;
    return {
      snapshot,
      controller: new AbortController(),
      running: false,
      lastPersistAt: 0,
      lastEmitAt: 0
    };
  }

  private fail(rt: JobRuntime, err: unknown): void {
    const message = err instanceof Error ? err.message : String(err);
    rt.snapshot.job.state = 'canceled';
    rt.snapshot.job.error = message;
    rt.snapshot.job.endedAt = Date.now();
    rt.running = false;
    this.appendLog(rt, { level: 'error', message });
    this.persist(rt, true);
    this.emitSnapshot(rt);
  }

  private async collectWithTimeout(
    jobId: string,
    workerId: string,
    ds: DatasourceConfig,
    attempt: number,
    timeoutMs: number,
    signal: AbortSignal
  ): Promise<BatchInstanceResult> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<BatchInstanceResult>((resolve) => {
      timer = setTimeout(() => {
        resolve({
          jobId,
          workerId,
          datasourceId: ds.id,
          datasourceName: ds.name,
          dimensions: unavailableDimensions(`采集超时（${timeoutMs}ms），结果已丢弃`),
          ok: false,
          attempt,
          durationMs: timeoutMs,
          error: `采集超时（${timeoutMs}ms）`
        });
      }, timeoutMs);
    });
    try {
      return await Promise.race([
        collectInstance(jobId, workerId, ds, attempt, signal),
        timeout
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private async runWorker(
    rt: JobRuntime,
    worker: BatchWorker,
    ids: readonly string[]
  ): Promise<void> {
    const signal = rt.controller.signal;
    const job = rt.snapshot.job;
    worker.state = 'running';
    worker.startedAt = Date.now();
    worker.endedAt = undefined;
    worker.error = undefined;
    this.emitSnapshot(rt);

    let hadFailure = false;
    for (const dsId of ids) {
      if (signal.aborted) break;
      const ds = this.datasourceById(dsId);
      if (!ds) {
        hadFailure = true;
        this.upsertResult(rt, {
          jobId: job.id,
          workerId: worker.id,
          datasourceId: dsId,
          datasourceName: dsId,
          dimensions: unavailableDimensions('数据源已删除或未启用'),
          ok: false,
          attempt: 0,
          durationMs: 0,
          error: '数据源已删除或未启用'
        });
        continue;
      }
      worker.currentStep = `采集 ${ds.name}`;
      this.emitThrottled(rt);
      let attempt = 1;
      let result = await this.collectWithTimeout(
        job.id,
        worker.id,
        ds,
        attempt,
        job.timeoutMs,
        signal
      );
      while (
        !result.ok &&
        attempt <= job.maxRetries &&
        !signal.aborted &&
        isRetryableError(result.error ?? '')
      ) {
        attempt += 1;
        result = await this.collectWithTimeout(
          job.id,
          worker.id,
          ds,
          attempt,
          job.timeoutMs,
          signal
        );
      }
      result.attempt = attempt;
      this.upsertResult(rt, result);
      if (!result.ok) hadFailure = true;
      this.appendLog(rt, {
        workerId: worker.id,
        datasourceId: ds.id,
        ok: result.ok,
        attempt,
        durationMs: result.durationMs,
        error: result.error ?? null
      });
      this.persist(rt);
      this.emitThrottled(rt);
    }

    worker.currentStep = undefined;
    worker.endedAt = Date.now();
    worker.attempt = 1;
    worker.state = signal.aborted ? 'canceled' : hadFailure ? 'failed' : 'succeeded';
    this.emitSnapshot(rt);
  }

  private async aggregate(rt: JobRuntime): Promise<void> {
    const job = rt.snapshot.job;
    const signal = rt.controller.signal;
    const outcome = await runSuper({
      mode: job.mode,
      jobId: job.id,
      results: rt.snapshot.results,
      llmBudget: job.llmBudget,
      signal,
      onLlmCall: () => {
        rt.snapshot.progress.llmCalls += 1;
        this.emitSnapshot(rt);
      },
      recheck: async (ids: string[]) => {
        const known = new Set(job.datasourceIds);
        const targets = [...new Set(ids)].filter((id) => known.has(id)).slice(0, 10);
        const out: BatchInstanceResult[] = [];
        for (const id of targets) {
          if (signal.aborted) break;
          const ds = this.datasourceById(id);
          if (!ds) continue;
          const result = await this.collectWithTimeout(
            job.id,
            'super-recheck',
            ds,
            2,
            job.timeoutMs,
            signal
          );
          this.upsertResult(rt, result);
          out.push(result);
        }
        this.persist(rt, true);
        this.emitSnapshot(rt);
        return out;
      }
    });
    if (outcome.degradedFrom) {
      job.degradedFrom = outcome.degradedFrom;
      job.mode = 'hybrid';
      this.appendLog(rt, {
        level: 'warn',
        message: outcome.degradedReason ?? 'B 模式降级为规则化汇总'
      });
    }
    rt.snapshot.report = buildReport(
      job.id,
      rt.snapshot.results,
      outcome.summary,
      outcome.summarySource
    );
  }

  private async run(rt: JobRuntime, groups: string[][]): Promise<void> {
    const job = rt.snapshot.job;
    const signal = rt.controller.signal;
    this.dsCache = getDbService().list();
    job.state = 'running';
    job.startedAt = job.startedAt ?? Date.now();
    job.endedAt = undefined;
    job.error = undefined;
    job.partial = undefined;
    this.emitSnapshot(rt);

    let cursor = 0;
    const pump = async (): Promise<void> => {
      while (!signal.aborted) {
        const index = cursor;
        cursor += 1;
        if (index >= groups.length) return;
        const worker = rt.snapshot.workers[index];
        if (!worker) return;
        await this.runWorker(rt, worker, groups[index]);
      }
    };
    const lanes = Math.max(1, Math.min(job.concurrency, groups.length));
    await Promise.all(Array.from({ length: lanes }, () => pump()));

    if (signal.aborted) {
      job.state = 'canceled';
      job.endedAt = Date.now();
      rt.running = false;
      this.persist(rt, true);
      this.emitSnapshot(rt);
      return;
    }

    job.state = 'aggregating';
    this.emitSnapshot(rt);
    await this.aggregate(rt);
    job.state = 'completed';
    job.endedAt = Date.now();
    job.partial = rt.snapshot.results.some((r) => !r.ok);
    rt.running = false;
    this.persist(rt, true);
    this.emitSnapshot(rt);
  }
}

let service: BatchService | null = null;

export function getBatchService(): BatchService {
  if (!service) service = new BatchService();
  return service;
}

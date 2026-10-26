import fs from 'node:fs';
import path from 'node:path';
import type { ConversationLogLine, ConversationTaskMeta } from '../../shared/types';

const MAX_FILES = 50;
const META_SNIPPET_BYTES = 4096;

export interface TaskBeginInput {
  /** LLM 任务轮次的 msgId，同任务所有条目共用 */
  id: string;
  sessionId: string;
  task: string;
  provider: string;
}

export interface RoundInput {
  i: number;
  ms: number;
  strategy: string;
  /** 与上一轮 system 逐字节相同：不重复落盘，读取时回填（任务内 system 按策略冻结） */
  systemRef?: boolean;
  /** systemRef=true 时可省略 */
  system?: string;
  /**
   * 增量消息：以 base 为起点替换尾段（base 之前的消息沿用上一轮）。
   * 追加、历史归档替换、运行时快照替换都能被这一种表达覆盖。
   */
  msgs?: { base: number; items: unknown[] };
  /** 旧格式全量数组：读取侧兼容，编排器不再写入 */
  messages?: unknown[];
  toolNames?: string[];
  content: string;
  finishReason: string;
  /** 上游流被提前关闭或命中输出上限：该轮 content 可能只是半截 */
  truncated?: boolean;
  usage?: { prompt: number; completion: number };
  step?: unknown;
}

/**
 * 工具调用行：一次 executeCall 对应一行。
 * 参数与结果都脱敏后截断，既能支撑「回答里的数值从哪来」的核对，又不会把完整 stdout 落盘。
 */
export interface ToolLogInput {
  name: string;
  /** 已脱敏的参数 JSON（截断上限见 TOOL_LOG_ARGS_LIMIT，需容纳完整远程命令） */
  argsDigest: string;
  ok: boolean;
  /** 用户拒绝（与执行失败区分：拒绝属策略性失败，不计入连续失败钳制） */
  denied?: boolean;
  /** 确认超时（与拒绝区分：超时是无人响应，不是用户不同意） */
  timedOut?: boolean;
  /** 任务被中止导致未执行（与拒绝、超时都不同） */
  canceled?: boolean;
  /** 总耗时（含审批等待）；命令本身的耗时 ≈ durationMs - approvalMs */
  durationMs: number;
  /** 审批等待耗时，未触发审批时缺省 */
  approvalMs?: number;
  resultChars: number;
  /** 渲染后结果的前 800 字符 */
  resultDigest: string;
}

/** 审批行：确认请求与用户决策必须落盘，否则事后无法证明「执行前确认过」 */
export interface SafetyLogInput {
  tool: string;
  risk: string;
  /** approved=同意 / denied=拒绝 / timeout=无人响应 / canceled=请求不可达或任务中止 */
  outcome: 'approved' | 'denied' | 'timeout' | 'canceled';
  /** 用户决策耗时；与工具执行耗时分开，便于区分「人慢」和「命令慢」 */
  waitMs: number;
  /** 审批时展示的完整内容（命令 / SQL 原文） */
  detail: string;
}

/** 最终回答的来源标记：decision=决策轮直接给出，answer=作答阶段，digest=轮次耗尽后的兜底摘要 */
export type AnswerSource = 'decision' | 'answer' | 'digest';

export interface FinalMeta {
  /** true 表示这次回答经过降级（截断抢救 / 轮次耗尽 / 一致性重写） */
  degraded?: boolean;
  answeredBy?: AnswerSource;
}

function appendLine(file: string, line: object): void {
  fs.appendFileSync(file, `${JSON.stringify(line)}\n`, 'utf-8');
}

/** 只读每个文件的首行（task 元数据），避免 list 时全量载入所有任务 */
function readMeta(file: string): ConversationTaskMeta | null {
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(META_SNIPPET_BYTES);
    const bytes = fs.readSync(fd, buf, 0, META_SNIPPET_BYTES, 0);
    const head = buf.toString('utf-8', 0, bytes);
    const nl = head.indexOf('\n');
    if (nl < 0) return null;
    const meta = JSON.parse(head.slice(0, nl)) as ConversationTaskMeta & { type: string };
    return meta.type === 'task' ? meta : null;
  } catch {
    return null;
  } finally {
    fs.closeSync(fd);
  }
}

export class ConversationLog {
  constructor(private readonly root: string) {
    fs.mkdirSync(root, { recursive: true });
  }

  private file(id: string): string {
    return path.join(this.root, `${id}.jsonl`);
  }

  begin(input: TaskBeginInput): void {
    const meta: ConversationTaskMeta & { type: 'task' } = {
      type: 'task',
      id: input.id,
      sessionId: input.sessionId,
      task: input.task.slice(0, 200),
      provider: input.provider,
      ts: Date.now()
    };
    appendLine(this.file(input.id), meta);
    this.prune();
  }

  round(id: string, r: RoundInput): void {
    const file = this.file(id);
    if (!fs.existsSync(file)) return;
    appendLine(file, { type: 'round', at: Date.now(), ...r });
  }

  event(id: string, level: 'info' | 'warn' | 'error', text: string): void {
    const file = this.file(id);
    if (!fs.existsSync(file)) return;
    appendLine(file, { type: 'event', at: Date.now(), level, text });
  }

  tool(id: string, input: ToolLogInput): void {
    const file = this.file(id);
    if (!fs.existsSync(file)) return;
    appendLine(file, { type: 'tool', at: Date.now(), ...input });
  }

  safety(id: string, input: SafetyLogInput): void {
    const file = this.file(id);
    if (!fs.existsSync(file)) return;
    appendLine(file, { type: 'safety', at: Date.now(), ...input });
  }

  final(id: string, text: string, meta: FinalMeta = {}): void {
    const file = this.file(id);
    if (!fs.existsSync(file)) return;
    appendLine(file, { type: 'final', at: Date.now(), text, ...meta });
  }

  fatal(id: string, text: string): void {
    const file = this.file(id);
    if (!fs.existsSync(file)) return;
    appendLine(file, { type: 'error', at: Date.now(), text });
  }

  list(limit = 50): ConversationTaskMeta[] {
    const files = fs
      .readdirSync(this.root)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(this.root, f));
    const metas: ConversationTaskMeta[] = [];
    for (const f of files) {
      const meta = readMeta(f);
      if (meta) metas.push(meta);
    }
    return metas.sort((a, b) => b.ts - a.ts).slice(0, limit);
  }

  read(id: string): { meta: ConversationTaskMeta; lines: ConversationLogLine[] } | null {
    const file = this.file(id);
    if (!fs.existsSync(file)) return null;
    const lines: ConversationLogLine[] = [];
    let meta: ConversationTaskMeta | null = null;
    // 增量物化状态：上一轮的 system 与完整 messages
    let lastSystem = '';
    let lastMessages: unknown[] = [];
    for (const raw of fs.readFileSync(file, 'utf-8').split('\n')) {
      if (!raw.trim()) continue;
      try {
        const line = JSON.parse(raw) as ConversationLogLine;
        if (line.type === 'task') {
          meta = line as unknown as ConversationTaskMeta;
          continue;
        }
        if (line.type === 'round') {
          // system 复用：回填上一轮（任务内 system 按策略冻结，逐轮重复写是纯冗余）
          if (line.systemRef === true) {
            line.system = lastSystem;
          } else {
            lastSystem = String(line.system ?? '');
          }
          const delta = line.msgs as { base: number; items: unknown[] } | undefined;
          if (delta) {
            const rawBase = Number(delta.base);
            const base = Number.isFinite(rawBase)
              ? Math.max(0, Math.min(rawBase, lastMessages.length))
              : 0;
            line.messages = [...lastMessages.slice(0, base), ...(delta.items ?? [])];
            delete line.msgs;
            delete line.systemRef;
          }
          if (Array.isArray(line.messages)) lastMessages = line.messages;
        }
        lines.push(line);
      } catch {
        // 跳过无法解析的残行（如写入中途崩溃），不影响其余日志
      }
    }
    return meta ? { meta, lines } : null;
  }

  private prune(): void {
    const files = fs
      .readdirSync(this.root)
      .filter((f) => f.endsWith('.jsonl'))
      .map((f) => path.join(this.root, f));
    if (files.length <= MAX_FILES) return;
    const byAge = files
      .map((f) => ({ f, m: fs.statSync(f).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    for (const { f } of byAge.slice(0, files.length - MAX_FILES)) {
      fs.rmSync(f, { force: true });
    }
  }
}

export interface TaskRunLog {
  begin(input: TaskBeginInput): void;
  round(id: string, r: RoundInput): void;
  event(id: string, level: 'info' | 'warn' | 'error', text: string): void;
  tool(id: string, input: ToolLogInput): void;
  safety(id: string, input: SafetyLogInput): void;
  final(id: string, text: string, meta?: FinalMeta): void;
  fatal(id: string, text: string): void;
  list(limit?: number): ConversationTaskMeta[];
  read(id: string): { meta: ConversationTaskMeta; lines: ConversationLogLine[] } | null;
}

const NULL_LOG: TaskRunLog = {
  begin: () => {},
  round: () => {},
  event: () => {},
  tool: () => {},
  safety: () => {},
  final: () => {},
  fatal: () => {},
  list: () => [],
  read: () => null
};

let instance: ConversationLog | null = null;

export function initConversationLog(root: string): ConversationLog {
  instance = new ConversationLog(root);
  return instance;
}

/** 未初始化（如单元测试）时返回空实现，编排器无需判空 */
export function getConversationLog(): TaskRunLog {
  return instance ?? NULL_LOG;
}

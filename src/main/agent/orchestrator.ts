import type {
  AgentName,
  AgentStatus,
  LogEntry,
  SafetyRequest,
  AgentTraceEvent,
  TaskTodoItem
} from '../../shared/types';
import type { LLMRouter } from '../llm/router';
import type { LLMChatMessage, LLMProvider, LLMResponse } from '../llm/provider';
import { LlmHttpError } from '../llm/openaiCompat';
import { getMemoryStore } from '../services/memory';
import { getConversationLog, type AnswerSource } from '../services/conversationLog';
import type { SkillRegistry } from '../skills/registry';
import type { SafetyGate } from './safety';
import type { ToolRegistry } from './tools/registry';
import { approvalErrorCode } from './tools/registry';
import type { ApprovalInfo, ToolContext } from './tools/types';
import type { AgentLoopStrategy, LoopCall, LoopObservation } from './loop/types';
import type { PromptStrategyId } from './prompt/registry';
import { createPromptRegistry, answerSystemPrompt } from './prompt/sections';
import { TextJsonStrategy } from './loop/textJson';
import { FunctionCallingStrategy } from './loop/functionCalling';
import { validateArgs, formatArgIssues } from './loop/validateArgs';
import { findUnsupportedNumbers } from './loop/grounding';
import { buildAnswerDigest, describeCallArgs, type AnswerDigestItem } from './loop/answerDigest';
import { buildArgsDigest, buildResultDigest } from './loop/toolDigest';

export type OrchestratorEvent =
  | { type: 'agent-status'; status: AgentStatus }
  | { type: 'log'; entry: LogEntry }
  | { type: 'chat-delta'; sessionId: string; msgId: string; delta: string; done?: boolean }
  | { type: 'safety'; request: SafetyRequest }
  | { type: 'trace'; event: AgentTraceEvent }
  | { type: 'todo'; sessionId: string; todos: TaskTodoItem[] };

export interface OrchestratorDeps {
  router: LLMRouter;
  safety: SafetyGate;
  registry: ToolRegistry;
  /** 可选：技能注册表，提供时向系统提示词注入技能目录（S1） */
  skills?: SkillRegistry;
}

const MAX_ITERATIONS_FALLBACK = 12;
const DEFAULT_RESULT_LIMIT = 4000;
const FAIL_CLAMP_THRESHOLD = 2;
/** 解析纠正轮上限：纠正轮不消耗工具轮预算，但必须有上限 */
const MAX_PARSE_RETRIES = 2;
/** 作答阶段单次请求的输出上限（字符≈token 的中文场景下，2048 装不下 11 节巡检报告） */
const DEFAULT_ANSWER_MAX_TOKENS = 4096;
const ANSWER_MAX_TOKENS_LIMIT = 8192;
const ANSWER_MIN_MAX_TOKENS = 1024;
/** 作答分段续写上限：每段一次请求，段数用尽即如实告知用户「建议部分未完成」 */
const ANSWER_MAX_SEGMENTS = 3;
/** 续写时用于消除重复开头的回看窗口（字符） */
const CONTINUATION_OVERLAP_WINDOW = 240;
const ANSWER_CONTINUE_HINT =
  '请紧接上文继续输出剩余部分：从断点处接续，不要重复已输出的内容，不要重新写标题或开头，也不要重新总结已写过的段落。';
/** 截断时追加给用户的显式告知（正文里也要能看到，不能只写进日志） */
const ANSWER_TRUNCATION_NOTICE =
  '\n\n---\n\n> 说明：本次回答已达到模型输出上限，后续内容（例如「问题与建议」部分）**未完成**。回复「继续」可让我接着补写剩余部分。';
/**
 * 历史工具结果的上下文预算（字符）：超出后从最旧的开始归档为缩略占位。
 * 没有这一步，工具结果会随轮次线性复利，5 轮就能把 prompt 推到上万 token。
 */
const HISTORY_TOOL_RESULT_BUDGET = 16_000;
/** 归档时保留的原文前缀：足够模型认出「这是哪条查询」，不至于整条丢失 */
const ARCHIVE_KEEP_CHARS = 240;
/** 运行时上下文快照标记：整句作为识别依据，避免误伤用户输入 */
const SNAPSHOT_MARKER = '[运行时上下文]（本快照取代此前所有运行时上下文）';

/**
 * 最后一轮决策的收敛提示（只随请求发送，不写进会话历史）。
 * 实测小模型容易把轮次全耗在工具调用上，始终不标记 done，逼得每次巡检都走兜底作答。
 */
const LAST_ROUND_HINT =
  '（这是本次任务的最后一轮：信息已足够就立刻结束决策（文本协议输出 {"action": null, "done": true}），' +
  '仍有缺口就留到最终回答里如实说明，不要再用完剩余轮次。）';

/**
 * 倒数第二轮的提示：最后一轮的调用不会被采纳，所以缺的数据必须现在补。
 * 与 LAST_ROUND_HINT 分开写，避免把「最后一轮」说成假话。
 */
const PENULTIMATE_ROUND_HINT =
  '（只剩最后一轮规划机会：本轮就要补齐关键维度，同类只读查询可用 actions 一次性提交；' +
  '下一轮只允许收敛作答，不会再执行任何工具调用。）';

/** 旧版本把这句话直接当回答落盘；回灌历史等于给模型「这任务本来就做不了」的示例 */
const LEGACY_GIVE_UP_PLACEHOLDER = '抱歉，我暂时无法完成这个任务。';

export function isLegacyGiveUpPlaceholder(text: string): boolean {
  return text.trim() === LEGACY_GIVE_UP_PLACEHOLDER;
}

function truncateResult(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '(空结果)';
  return text.length > limit ? `${text.slice(0, limit)}…(已截断)` : text;
}

function isToolsUnsupportedError(err: unknown): boolean {
  return err instanceof LlmHttpError && [400, 404, 422].includes(err.status);
}

/**
 * 放弃式回答识别：短文本 + 明确的放弃措辞。用于任务已有工具产出时触发一次性重写；
 * 正常报告远超该长度阈值，不会误伤（报告中标注个别子项失败不受影响）。
 */
export function isAbandonmentText(text: string): boolean {
  const t = text.trim();
  if (t.length === 0 || t.length > 300) return false;
  return /无法完成|无法执行|暂时无法|不能完成|爱莫能助|做不到/.test(t) || /^(抱歉|对不起|很抱歉)/.test(t);
}

/**
 * 零产出声明：整体性断言「什么都没拿到」。与「个别子项无法完成」严格区分——
 * 后者是正常报告的一部分，前者与已收集的工具结果直接矛盾。
 * v0.5.1 事故里 1062 字符的假报告正是靠长度阈值绕过了放弃式识别。
 */
const ZERO_YIELD_PATTERNS: readonly RegExp[] = [
  /未(?:能)?(?:采集|获取|拿到|取到)到任何/,
  /无任何(?:实际)?(?:指标)?数据/,
  /未实际执行/,
  /(?:巡检|检查|任务)(?:实际)?未(?:执行|开展)/,
  /(?:六|6)?个维度(?:均无数据|均未采集|全部缺失)/,
  /均无数据/,
  /无法计算(?:健康)?(?:评分|得分)/
];

export function claimsZeroYield(text: string): boolean {
  return ZERO_YIELD_PATTERNS.some((re) => re.test(text));
}

/**
 * 最终回答一致性守卫：任务已有成功工具结果时，禁止结论声称「零产出」。
 * 返回重写原因（null 表示放行）。
 */
export function needsAnswerRewrite(text: string, hasProductiveResult: boolean): string | null {
  if (!hasProductiveResult) return null;
  if (claimsZeroYield(text)) return '结论声称未采集到任何数据，但本任务已有成功的工具结果';
  if (isAbandonmentText(text)) return '整体放弃式回答，但本任务已有成功的工具结果';
  return null;
}

function isRuntimeSnapshot(message: LLMChatMessage): boolean {
  return typeof message.content === 'string' && message.content.startsWith(SNAPSHOT_MARKER);
}

/**
 * 续写去重：模型常常把断点前的最后一段（或小标题）重写一遍。
 * 只裁掉与新段开头重复的那一小截，正文其余部分原样拼接。
 */
export function stripContinuationOverlap(base: string, next: string): string {
  // 只去行首空白，保留换行：断点往往在段落中间，吃掉换行会把两段粘在一起
  const head = next.replace(/^[ \t]+/, '');
  if (!base || !head) return head;
  const max = Math.min(head.length, CONTINUATION_OVERLAP_WINDOW);
  for (let k = max; k >= 8; k--) {
    if (base.endsWith(head.slice(0, k))) return head.slice(k);
  }
  return head;
}

/** 工具结果消息：文本协议是 user+`工具结果:`，FC 是 role=tool */
function isToolResultMessage(message: LLMChatMessage): boolean {
  if (typeof message.content !== 'string') return false;
  if (message.role === 'tool') return true;
  return message.role === 'user' && message.content.startsWith('工具结果: <tool_result>');
}

export class Orchestrator {
  aborted = false;
  private abortController: AbortController | null = null;
  private busy = false;
  /** 分段提示词注册表（工具守则由工具定义自带，装配时收集） */
  private readonly prompts = createPromptRegistry();

  constructor(public readonly deps: OrchestratorDeps) {}

  abort(): void {
    this.aborted = true;
    this.abortController?.abort();
    // 未决审批必须一起终结：否则「停止」后 busy 锁仍被白白占满整个超时窗口，
    // 弹窗也会一直挂着（用户以为已经停了）
    // 取消结果会经审批回调写入会话日志（outcome=timeout，审计记为 canceled）
    this.deps.safety.cancelAll('用户中止任务');
  }

  isBusy(): boolean {
    return this.busy;
  }

  private status(
    emit: (e: OrchestratorEvent) => void,
    agent: AgentName,
    state: AgentStatus['state'],
    detail: string
  ): void {
    emit({ type: 'agent-status', status: { agent, state, detail, updatedAt: Date.now() } });
  }

  /**
   * 基础设施事件（审批超时/取消）：走 IPC.LogEntry 进右侧「执行日志」。
   * 任务内事件一律走 report()，不再写这里——两处同文是 U 系列重构要消除的重复。
   */
  private infra(
    emit: (e: OrchestratorEvent) => void,
    agent: AgentName | 'system',
    text: string,
    level: LogEntry['level'] = 'info'
  ): void {
    emit({
      type: 'log',
      entry: { id: crypto.randomUUID(), ts: Date.now(), agent, level, text, scope: 'infra' }
    });
  }

  /**
   * 任务内事件单一出口：写入对话日志（按 msgId 归属），warn/error 额外发一条 notice
   * trace 让「执行过程」实时可见。info 级只落盘，避免时间线被常规提示刷屏。
   */
  private report(
    emit: (e: OrchestratorEvent) => void,
    sessionId: string,
    msgId: string,
    text: string,
    level: LogEntry['level'] = 'info',
    fatal = false
  ): void {
    const log = getConversationLog();
    if (fatal) log.fatal(msgId, text);
    else log.event(msgId, level, text);
    if (level === 'info') return;
    this.trace(emit, sessionId, msgId, {
      phase: 'notice',
      notice: text,
      error: level === 'error' || undefined
    });
  }

  private toolContext(
    sessionId: string,
    msgId: string,
    emit: (e: OrchestratorEvent) => void,
    agent: AgentName,
    onApproval?: (info: ApprovalInfo) => void
  ): ToolContext {
    return {
      sessionId,
      msgId,
      emit,
      status: (state, detail) => this.status(emit, agent, state, detail),
      // 工具的进度提示属任务内事件：落对话日志，warn/error 同步进「执行过程」
      log: (text, level) => this.report(emit, sessionId, msgId, text, level),
      signal: this.abortController?.signal ?? new AbortController().signal,
      approval: onApproval
    };
  }

  /** 工具定义可贡献易变运行时事实（当前仅 ssh 主机清单），无内容返回空串 */
  private promptContextBlocks(): string {
    return this.deps.registry
      .all()
      .map((d) => d.promptContext?.() ?? '')
      .filter(Boolean)
      .join('\n');
  }

  /** 长期记忆块；无记忆返回空串（避免空占位撑出无意义的快照消息） */
  private memoryBlock(): string {
    const raw = getMemoryStore().load().trim();
    if (!raw) return '';
    const text = raw.length > 4000 ? `${raw.slice(0, 4000)}\n…（已截断）` : raw;
    return `长期记忆（跨会话保留的用户偏好与项目背景，供参考）：\n${text}`;
  }

  /**
   * 运行时上下文快照：易变事实不进 system prompt（保住供应商前缀缓存），
   * 以 user 消息追加在消息尾部，并声明取代此前快照。
   */
  runtimeSnapshot(): string {
    const blocks = [this.promptContextBlocks(), this.memoryBlock()].filter(Boolean);
    if (blocks.length === 0) return '';
    return `${SNAPSHOT_MARKER}\n${blocks.join('\n')}`;
  }

  /** 追加最新快照并剔除旧快照：只作用于拷贝，不污染会话消息历史 */
  private withRuntimeSnapshot(messages: LLMChatMessage[]): LLMChatMessage[] {
    const kept = messages.filter((m) => !isRuntimeSnapshot(m));
    const snapshot = this.runtimeSnapshot();
    return snapshot ? [...kept, { role: 'user', content: snapshot }] : kept;
  }

  /**
   * 历史工具结果归档：总字符超预算时从最旧的开始替换成缩略占位（保留开头一小段便于识别），
   * 让「轮次增加」不再等价于「prompt 线性上涨」。最后一轮的结果默认保留原文。
   * 返回是否发生了归档。
   */
  private compactContext(messages: LLMChatMessage[]): boolean {
    const indexes = messages.map((m, i) => (isToolResultMessage(m) ? i : -1)).filter((i) => i >= 0);
    if (indexes.length <= 1) return false;
    const lengthOf = (i: number): number => String(messages[i].content).length;
    let total = indexes.reduce((sum, i) => sum + lengthOf(i), 0);
    if (total <= HISTORY_TOOL_RESULT_BUDGET) return false;

    const archive = (i: number): void => {
      const text = String(messages[i].content);
      if (text.length <= ARCHIVE_KEEP_CHARS * 2) return;
      const archived =
        `${text.slice(0, ARCHIVE_KEEP_CHARS)}…（该工具结果共 ${text.length} 字符，` +
        '为控制上下文长度已归档；需要细节请重新执行该工具或 skill.read 对应章节）';
      total -= text.length - archived.length;
      messages[i] = { ...messages[i], content: archived };
    };

    const lastIndex = indexes[indexes.length - 1];
    for (const i of indexes) {
      if (total <= HISTORY_TOOL_RESULT_BUDGET) break;
      if (i === lastIndex) continue;
      archive(i);
    }
    // 只有归档完历史仍然严重超标（>1.5 倍预算）才动最后一轮
    if (total > HISTORY_TOOL_RESULT_BUDGET * 1.5) archive(lastIndex);
    return true;
  }

  /** MCP 扩展工具清单（仅文本协议注入；FC 模式由 tools 数组下发） */
  private mcpToolsBlock(): string {
    const mcpTools = this.deps.registry.all().filter((d) => d.agent === 'mcp');
    if (mcpTools.length === 0) return '（当前没有已连接的 MCP 扩展工具）';
    return mcpTools.map((d) => `- ${d.name} — ${d.description.slice(0, 200)}`).join('\n');
  }

  /** 技能目录块：仅注入 name + description（渐进披露，正文由 skill.run 激活时加载） */
  private skillsCatalog(): string {
    const skills = this.deps.skills?.list() ?? [];
    if (skills.length === 0) return '运维技能目录：（当前没有已安装的运维技能）';
    return `运维技能（用户需求匹配以下场景时，先用 skill.run 激活对应技能）：\n${skills
      .map((s) => {
        const ver = s.version ? ` v${s.version}` : '';
        const engine = s.engine ? ` [${s.engine}]` : '';
        return `- ${s.name}${ver}${engine} — ${s.description.slice(0, 160)}`;
      })
      .join('\n')}`;
  }

  private promptVars(): Record<string, string> {
    return { mcp_tools: this.mcpToolsBlock(), skills_catalog: this.skillsCatalog() };
  }

  private assemblePrompt(strategy: PromptStrategyId): string {
    return this.prompts.assemble(strategy, this.deps.registry.all(), this.promptVars());
  }

  /** 文本协议系统提示词（兼容既有调用与测试） */
  planningSystem(): string {
    return this.assemblePrompt('text-json');
  }

  /** 任务内冻结：同一策略只装配一次，避免轮间漂移破坏前缀缓存 */
  private systemFor(strategy: AgentLoopStrategy, cache: Map<PromptStrategyId, string>): string {
    const hit = cache.get(strategy.id);
    if (hit !== undefined) return hit;
    const text = this.assemblePrompt(strategy.id);
    cache.set(strategy.id, text);
    return text;
  }

  private maxSteps(): number {
    const raw = Number(this.deps.router.settings?.agent?.maxSteps);
    if (!Number.isFinite(raw)) return MAX_ITERATIONS_FALLBACK;
    return Math.min(30, Math.max(2, Math.floor(raw)));
  }

  private pickStrategy(): AgentLoopStrategy {
    return this.deps.router.settings?.providerMode === 'cloud'
      ? new FunctionCallingStrategy()
      : new TextJsonStrategy();
  }

  private trace(
    emit: (e: OrchestratorEvent) => void,
    sessionId: string,
    msgId: string,
    event: Omit<AgentTraceEvent, 'sessionId' | 'msgId'>
  ): void {
    emit({ type: 'trace', event: { sessionId, msgId, ...event } });
  }

  /** 历史只取最近对话，且剔除旧版兜底话术（否则成了「这任务做不了」的 few-shot） */
  private historyMessages(history: ChatMessageLite[] | undefined): LLMChatMessage[] {
    return (history ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .filter((m) => !(m.role === 'assistant' && isLegacyGiveUpPlaceholder(m.content)))
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
  }

  private async executeCall(
    emit: (e: OrchestratorEvent) => void,
    sessionId: string,
    msgId: string,
    call: LoopCall,
    failState: { key: string | null; count: number }
  ): Promise<LoopObservation> {
    const def = this.deps.registry.get(call.name);
    // 参数摘要与落盘共用同一份构造（脱敏在前、截断在后）
    const argsDigest = buildArgsDigest(call.args);
    this.trace(emit, sessionId, msgId, { phase: 'tool-start', tool: call.name, argsDigest });

    let resultText: string;
    let failed = false;
    let denied = false;
    let timedOut = false;
    let canceled = false;
    let invalidArgs = false;
    /** 审批等待耗时：与命令执行耗时分开落盘，否则「用户想了 2 秒」会被算进「命令跑了 2 秒」 */
    let approvalMs: number | undefined;
    const started = Date.now();

    const onApproval = (info: ApprovalInfo): void => {
      approvalMs = info.waitMs;
      // 确认请求与决策必须进会话日志：审计文件只留摘要，无法还原具体命令
      getConversationLog().safety(msgId, {
        tool: info.tool,
        risk: info.risk,
        outcome: info.outcome,
        waitMs: info.waitMs,
        detail: info.detail
      });
      if (info.outcome === 'timeout') {
        this.infra(emit, 'system', `${info.tool} 确认超时（${info.waitMs}ms 无响应），未执行`, 'warn');
      } else if (info.outcome === 'canceled') {
        this.infra(emit, 'system', `${info.tool} 的确认请求已取消（任务中止或窗口不可用）`, 'warn');
      }
    };

    try {
      if (!def) throw new Error(`未知工具 ${call.name}，请从白名单中选择`);
      // 参数不合法时不进工具：直接给出字段路径，避免「执行失败」这种无法自纠的错误
      const issues = validateArgs(def.inputSchema, call.args);
      if (issues.length > 0) {
        invalidArgs = true;
        throw new Error(
          `参数不合法：${formatArgIssues(issues)}。请按工具清单里的参数签名重新提交，不要猜字段名`
        );
      }
      const result = await this.deps.registry.execute(
        call.name,
        call.args,
        this.toolContext(sessionId, msgId, emit, def.agent, onApproval)
      );
      // 统一渲染入口：工具可自带 render，缺省 JSON 序列化；渲染后再截断
      const rendered = def.render ? def.render(result) : result;
      resultText = truncateResult(rendered, def.maxResultChars ?? DEFAULT_RESULT_LIMIT);
      this.status(emit, def.agent, 'done', `${call.name} 完成`);
    } catch (err) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      // 用错误码判定，不用中文子串：拒绝与超时是两种事实，不能混为一谈
      const code = approvalErrorCode(err);
      denied = code === 'E_DENIED';
      timedOut = code === 'E_TIMEOUT';
      canceled = code === 'E_CANCELED';
      resultText = denied
        ? `用户拒绝了该工具调用（${msg}）。不要原样重试，改用其他思路`
        : timedOut
          ? `该工具调用等待确认超时（无人响应），未执行：${msg}。如需执行请重新发起`
          : canceled
            ? `任务已被中止，该工具调用未执行：${msg}`
            : invalidArgs
              ? `工具参数不合法，未执行：${msg}`
              : `工具执行失败: ${msg}`;
      if (def) this.status(emit, def.agent, 'error', msg);
      // 失败事实已由 tool-end 的 error 标记与对话日志的 tool 行（ok=false）双重保留，
      // 不再额外写执行日志——那是基础设施面板，任务内事件不进。
    }

    const durationMs = Date.now() - started;
    const digest = buildResultDigest(resultText);
    this.trace(emit, sessionId, msgId, {
      phase: 'tool-end',
      tool: call.name,
      resultDigest: digest.trace,
      error: failed || undefined,
      durationMs
    });
    // 落盘工具事件：此前日志只有轮次快照，最后一轮执行的调用完全没有痕迹，
    // 最终回答里引用的数据无法回溯（见 sessionlog.txt 的 ssh.exec 一例）
    getConversationLog().tool(msgId, {
      name: call.name,
      argsDigest,
      ok: !failed,
      denied: denied || undefined,
      timedOut: timedOut || undefined,
      canceled: canceled || undefined,
      durationMs,
      approvalMs,
      resultChars: digest.chars,
      resultDigest: digest.log
    });

    const key = JSON.stringify([call.name, call.args]);
    if (failed) {
      if (denied) {
        // 用户拒绝属策略性失败：不计入连续失败钳制
        failState.key = null;
        failState.count = 0;
      } else {
        failState.count = failState.key === key ? failState.count + 1 : 1;
        failState.key = key;
        if (failState.count >= FAIL_CLAMP_THRESHOLD) {
          resultText += `（提示：该调用已连续失败 ${failState.count} 次，请更换思路或工具）`;
        }
      }
    } else {
      failState.key = null;
      failState.count = 0;
    }

    return { call, resultText, failed, denied, invalidArgs };
  }

  /** 作答阶段的输入消息：任务 + 完整工具结果清单（+ 可选纠正要求） */
  private answerMessages(
    taskText: string,
    items: readonly AnswerDigestItem[],
    correction?: string
  ): LLMChatMessage[] {
    const digest = buildAnswerDigest(items);
    const tail = [`已执行的工具与结果：\n${digest}`, correction].filter(Boolean).join('\n\n');
    return [
      { role: 'user', content: taskText },
      { role: 'user', content: tail }
    ];
  }

  /** 单次作答请求的输出上限（可由 Settings.agent.answerMaxTokens 覆盖） */
  private answerMaxTokens(): number {
    const raw = Number(this.deps.router.settings?.agent?.answerMaxTokens);
    if (!Number.isFinite(raw) || raw <= 0) return DEFAULT_ANSWER_MAX_TOKENS;
    return Math.min(ANSWER_MAX_TOKENS_LIMIT, Math.max(ANSWER_MIN_MAX_TOKENS, Math.floor(raw)));
  }

  /**
   * 纯文本作答：无 tools、无 jsonMode，流式回传（长报告不再进 JSON 字段）。
   * 命中输出上限时自动分段续写（最多 ANSWER_MAX_SEGMENTS 段）；仍被截断则把
   * 「建议部分未完成」写进正文，而不是只在日志里留一行 warn。
   */
  private async streamAnswer(
    provider: LLMProvider,
    taskText: string,
    items: readonly AnswerDigestItem[],
    emit: (e: OrchestratorEvent) => void,
    sessionId: string,
    msgId: string,
    opts: { correction?: string; header?: string } = {}
  ): Promise<{ text: string; truncated: boolean; segments: number }> {
    if (opts.header) {
      emit({ type: 'chat-delta', sessionId, msgId, delta: opts.header });
    }
    const base = this.answerMessages(taskText, items, opts.correction);
    const maxTokens = this.answerMaxTokens();
    const signal = this.abortController?.signal ?? new AbortController().signal;
    let text = '';
    let segments = 0;

    for (let seg = 0; seg < ANSWER_MAX_SEGMENTS; seg++) {
      segments = seg + 1;
      const messages: LLMChatMessage[] =
        seg === 0
          ? base
          : [
              ...base,
              { role: 'assistant', content: text },
              { role: 'user', content: ANSWER_CONTINUE_HINT }
            ];

      // 续写段先缓冲开头一小截，确认没有重复上文后再推流，避免界面上出现重复段落
      let held = '';
      let flushed = seg === 0;
      let addition = '';
      const push = (delta: string): void => {
        addition += delta;
        emit({ type: 'chat-delta', sessionId, msgId, delta });
      };
      const flushHeld = (final: boolean): void => {
        if (flushed) return;
        if (!final && held.length < CONTINUATION_OVERLAP_WINDOW) return;
        flushed = true;
        const tail = stripContinuationOverlap(text, held);
        if (tail) push(tail);
      };

      const res = await provider.chatStream(
        { system: answerSystemPrompt(), messages, temperature: 0.5, maxTokens, signal },
        (d) => {
          if (flushed) {
            push(d);
          } else {
            held += d;
            flushHeld(false);
          }
        }
      );
      if (!flushed) {
        // provider 未推送增量时（异常实现）以整体内容兜底
        if (!held && res.content) held = res.content;
        flushHeld(true);
      } else if (addition !== res.content) {
        // 增量与整体不一致（或完全没有增量）：以整体内容为准，保证落盘文本完整
        const rest =
          addition && res.content.startsWith(addition) ? res.content.slice(addition.length) : res.content;
        if (!addition || rest) push(rest);
        addition = res.content;
      }
      text += addition;

      if (res.truncated !== true) return { text, truncated: false, segments };
    }

    text += ANSWER_TRUNCATION_NOTICE;
    emit({ type: 'chat-delta', sessionId, msgId, delta: ANSWER_TRUNCATION_NOTICE });
    return { text, truncated: true, segments };
  }

  /** 一致性重写要求：把「不得声称零产出」写死进纠正消息 */
  private rewriteCorrection(reason: string): string {
    return [
      `你上一条回答有问题：${reason}。`,
      '请基于上面的工具结果重写最终回答：已完成的部分汇总成报告与结论，并引用具体数值；',
      '确实缺失的维度单独标注「未获取：缺哪一项 + 原因」。',
      '严禁声称「未采集到任何数据」「未实际执行」「无法计算」，也禁止整体放弃式回答。'
    ].join('');
  }

  /** 数值溯源重写要求：只保留工具结果里出现过的数值，缺失就写明未获取 */
  private groundingCorrection(numbers: readonly string[]): string {
    return [
      `你上一条回答里的这些数值无法在工具结果中找到来源：${numbers.join('、')}。`,
      '请重写最终回答：只保留工具结果中确实出现过的数值；无法溯源的指标要么删除，要么写「未获取：缺哪一项 + 原因」。',
      '不要用估算值、记忆里的旧数据或常识替代本期实测。'
    ].join('');
  }

  async handleUserMessage(
    sessionId: string,
    text: string,
    emit: (e: OrchestratorEvent) => void,
    history?: ChatMessageLite[]
  ): Promise<string> {
    // 单飞：并发任务会互相破坏 aborted/abortController 状态
    if (this.busy) throw new Error('当前有任务正在执行，请等待完成或先停止');
    this.busy = true;
    try {
      return await this.runTask(sessionId, text, emit, history);
    } finally {
      this.busy = false;
    }
  }

  private async runTask(
    sessionId: string,
    text: string,
    emit: (e: OrchestratorEvent) => void,
    history?: ChatMessageLite[]
  ): Promise<string> {
    this.aborted = false;
    this.abortController = new AbortController();
    const msgId = crypto.randomUUID();

    for (const agent of this.deps.registry.agents()) {
      this.status(emit, agent, 'idle', '');
    }
    this.status(emit, 'main', 'thinking', '正在理解你的需求');

    // 任务级锁定模型：单次任务全程使用同一档案，任务失败/结束后方可切换
    const provider = await this.deps.router.getActive();
    // 日志文件必须先建：各写方法以「文件存在」为守卫，否则「收到任务」会被静默丢弃
    const runLog = getConversationLog();
    runLog.begin({ id: msgId, sessionId, task: text, provider: provider.id });
    this.report(emit, sessionId, msgId, `收到任务: ${text.slice(0, 100)}`);

    const messages: LLMChatMessage[] = this.historyMessages(history);
    messages.push({ role: 'user', content: text });

    const tools = this.deps.registry.all();
    const steps = this.maxSteps();
    let strategy = this.pickStrategy();
    const failState = { key: null as string | null, count: 0 };
    // 系统提示词按策略冻结：同任务内逐字节稳定，命中供应商前缀缓存
    const systemCache = new Map<PromptStrategyId, string>();
    let finalText: string | null = null;
    /** 模型主动标记「可以作答」或被截断/预算耗尽时的作答意图 */
    let answerIntent: 'done' | 'truncated' | 'budget' | 'invalid' | null = null;
    // 一致性重写每任务至多一次，防止模型与拦截器互相拉扯
    let rescued = false;
    // 兜底摘要的数据源：运行态工具结果，与 LLM 消息格式（策略内部实现）解耦
    const taskObservations: Array<{
      tool: string;
      resultText: string;
      failed?: boolean;
      detail: string;
    }> = [];
    /** 历史工具结果归档只提示一次，避免每轮刷日志 */
    let archivedNotified = false;
    /**
     * 上一轮已落盘的消息快照与 system：用于增量写入（引用比较求最早分歧点）。
     * 完整 messages 逐轮落盘会让单任务文件随轮次近似平方增长。
     */
    let prevMessages: LLMChatMessage[] = [];
    let prevSystem = '';

    try {
      let parseRetries = 0;
      for (let round = 0; round < steps && !this.aborted; round++) {
        this.status(emit, 'main', 'thinking', `规划第 ${round + 1} 轮`);

        let roundDeltaEmitted = false;
        let res: LLMResponse;
        // 历史工具结果超预算就归档为缩略占位：轮次增加不再线性推高 prompt
        if (round > 0 && this.compactContext(messages) && !archivedNotified) {
          archivedNotified = true;
          this.report(emit, sessionId, msgId, '历史工具结果已归档为缩略占位，控制上下文长度');
        }
        const requestMessages = this.withRuntimeSnapshot(messages);
        const isLastRound = round === steps - 1;
        if (isLastRound) {
          requestMessages.push({ role: 'user', content: LAST_ROUND_HINT });
        } else if (round === steps - 2 && taskObservations.length > 0) {
          requestMessages.push({ role: 'user', content: PENULTIMATE_ROUND_HINT });
        }
        const req = strategy.buildRequest(
          this.systemFor(strategy, systemCache),
          requestMessages,
          tools,
          this.abortController.signal
        );
        const roundStartedAt = Date.now();
        try {
          res = await provider.chatStream(
            req,
            strategy.id === 'function-calling'
              ? (d) => {
                  roundDeltaEmitted = true;
                  this.trace(emit, sessionId, msgId, { phase: 'thought', thought: d });
                }
              : () => {}
          );
        } catch (err) {
          if (this.aborted) break;
          if (strategy.id === 'function-calling' && isToolsUnsupportedError(err)) {
            this.report(emit, sessionId, msgId, '当前云端接口不支持 function calling，已切换文本协议', 'warn');
            strategy = new TextJsonStrategy();
            round--;
            continue;
          }
          throw err;
        }

        const step = strategy.parseStep(res);
        // 增量：从最早分歧点开始写尾段（追加 / 归档替换 / 快照替换都能覆盖）
        let base = 0;
        while (
          base < req.messages.length &&
          base < prevMessages.length &&
          req.messages[base] === prevMessages[base]
        ) {
          base += 1;
        }
        const systemRef = req.system === prevSystem;
        prevMessages = req.messages;
        prevSystem = req.system;
        runLog.round(msgId, {
          i: round,
          ms: Date.now() - roundStartedAt,
          strategy: strategy.id,
          systemRef,
          system: systemRef ? undefined : req.system,
          msgs: { base, items: req.messages.slice(base) },
          toolNames: req.tools?.map((t) => t.function.name),
          content: res.content,
          finishReason: res.finishReason,
          truncated: res.truncated === true,
          usage: res.usage,
          step:
            step.type === 'final'
              ? { type: 'final' }
              : step.type === 'answer'
                ? { type: 'answer', reason: step.reason }
                : step.type === 'retry'
                  ? { type: 'retry' }
                  : { type: 'tool_calls', thought: step.thought, calls: step.calls }
        });

        if (step.type === 'final') {
          finalText = step.text;
          break;
        }

        if (step.type === 'answer') {
          answerIntent = step.reason;
          break;
        }

        if (step.type === 'retry') {
          strategy.commitStep(messages, step, []);
          parseRetries += 1;
          if (parseRetries > MAX_PARSE_RETRIES) {
            answerIntent = 'truncated';
            this.report(emit, sessionId, msgId, '决策输出连续不可解析，改用已收集的工具结果作答', 'warn');
            break;
          }
          // 纠正轮不消耗工具轮预算：否则最后几轮全被格式纠正吃掉，最终只能走兜底
          round--;
          continue;
        }

        if (step.thought) {
          // 思考只进「执行过程」时间线，不再写执行日志：同一段文本两处出现毫无价值
          // FC 轮次已流式推送 thought 增量；provider 未产生增量时补发整合文本
          if (strategy.id === 'text-json' || !roundDeltaEmitted) {
            this.trace(emit, sessionId, msgId, { phase: 'thought', thought: step.thought });
          }
        }

        // —— 最后一轮收敛：本轮观测无法再被任何决策轮消费，却会触发确认弹窗并在断流后
        // 只能靠兜底摘要转述（sessionlog.txt 的 ssh.exec 就是这样落空的）
        if (isLastRound && taskObservations.length > 0) {
          const ignored = step.calls.map((c) => c.name).join(', ') || '（无）';
          const why = `已到最后一轮，未执行工具调用：${ignored}；改用已收集的结果作答`;
          this.report(emit, sessionId, msgId, why, 'warn');
          answerIntent = 'budget';
          break;
        }

        const observations: LoopObservation[] = [];
        for (const call of step.calls) {
          if (this.aborted) break;
          const def = this.deps.registry.get(call.name);
          if (def) {
            this.status(emit, 'main', 'acting', `调度 ${call.name}`);
            this.status(
              emit,
              def.agent,
              'acting',
              `${call.name} ${JSON.stringify(call.args ?? {})}`
            );
          }
          observations.push(await this.executeCall(emit, sessionId, msgId, call, failState));
        }
        for (const o of observations) {
          taskObservations.push({
            tool: o.call.name,
            resultText: o.resultText,
            failed: o.failed,
            // 关键参数随结果一起带进作答阶段：0 行提示文案完全相同，缺了它无法区分是哪条查询
            detail: describeCallArgs(o.call.args)
          });
        }

        strategy.commitStep(messages, step, observations);

        // 整轮参数都不合法：错误已回灌给模型，原地重试不消耗工具轮预算
        if (observations.length > 0 && observations.every((o) => o.invalidArgs)) {
          parseRetries += 1;
          if (parseRetries > MAX_PARSE_RETRIES) {
            answerIntent = 'invalid';
            break;
          }
          round--;
          continue;
        }
      }

      if (this.aborted) {
        this.emitAborted(emit, sessionId, msgId);
        return '';
      }

      const answerItems: AnswerDigestItem[] = taskObservations.map((o, i) => ({
        tool: o.tool,
        resultText: o.resultText,
        failed: o.failed,
        detail: o.detail,
        // 序号按执行顺序固定：内容完全相同的多次调用也必须各自保留，不得去重
        seq: i + 1
      }));
      const productive = answerItems.some((item) => !item.failed);

      let answerSource: AnswerSource = 'decision';
      let degraded = false;
      let streamed = false;

      // —— 作答阶段：决策轮没有直接给出最终回答时，用工具结果单独生成纯文本回答
      if (finalText === null) {
        answerSource = answerIntent === 'done' ? 'answer' : 'digest';
        degraded = answerIntent !== 'done';
        if (degraded) {
          const why =
            answerIntent === 'truncated'
              ? '模型决策输出被截断/不可解析，已改用已收集的工具结果作答'
              : answerIntent === 'invalid'
                ? '工具参数连续不合法，已改用已收集的工具结果作答'
                : '轮次预算用尽，已改用已收集的工具结果作答';
          this.report(emit, sessionId, msgId, why, 'warn');
        }
        this.status(emit, 'main', 'thinking', '正在生成回答');
        const produced = await this.streamAnswer(provider, text, answerItems, emit, sessionId, msgId);
        finalText = produced.text;
        streamed = true;
        if (produced.segments > 1) {
          this.report(emit, sessionId, msgId, `作答内容较长，已自动分 ${produced.segments} 段续写`);
        }
        if (produced.truncated) {
          degraded = true;
          // 正文里已追加 ANSWER_TRUNCATION_NOTICE，这里同步一条可检索的告警
          const why = '作答输出达到输出上限，建议部分未完成（已在回答末尾标注）';
          this.report(emit, sessionId, msgId, why, 'warn');
        }
      }

      // —— 一致性守卫：任何出口都必须过（每任务至多重写一次）
      const rewriteReason = needsAnswerRewrite(finalText, productive);
      if (rewriteReason && !rescued) {
        rescued = true;
        degraded = true;
        this.report(
          emit,
          sessionId,
          msgId,
          `回答与工具产出一致性不符（${rewriteReason}），已重写`,
          'warn'
        );
        const produced = await this.streamAnswer(provider, text, answerItems, emit, sessionId, msgId, {
          correction: this.rewriteCorrection(rewriteReason),
          header: streamed ? '\n\n---\n\n（以上结论与工具结果不符，已按真实数据重写）\n\n' : undefined
        });
        finalText = produced.text;
        streamed = true;
        answerSource = 'answer';
      }

      // —— 数值溯源守卫：回答里的数字必须来自任务原文或工具结果
      // 与一致性守卫共用 rescued：每任务至多重写一次，避免两套拦截互相拉扯
      const groundingSources = [text, ...answerItems.filter((i) => !i.failed).map((i) => i.resultText)];
      const unsupported = productive ? findUnsupportedNumbers(finalText, groundingSources) : [];
      if (unsupported.length > 0 && !rescued) {
        rescued = true;
        degraded = true;
        const why = `回答含无法溯源的数值（${unsupported.join('、')}），已重写`;
        this.report(emit, sessionId, msgId, why, 'warn');
        const produced = await this.streamAnswer(provider, text, answerItems, emit, sessionId, msgId, {
          correction: this.groundingCorrection(unsupported),
          header: streamed ? '\n\n---\n\n（以上数值无法核对来源，已按工具结果重写）\n\n' : undefined
        });
        finalText = produced.text;
        streamed = true;
        answerSource = 'answer';
        const still = findUnsupportedNumbers(finalText, groundingSources);
        if (still.length > 0) {
          // 只提示不拦截：再重写会陷入模型与守卫的循环
          this.report(
            emit,
            sessionId,
            msgId,
            `重写后仍有无法溯源的数值：${still.join('、')}（已放行）`,
            'warn'
          );
        }
      }

      if (streamed) {
        emit({ type: 'chat-delta', sessionId, msgId, delta: '', done: true });
      } else {
        const chunks = finalText.match(/[\s\S]{1,40}/g) ?? [finalText];
        for (const c of chunks) {
          if (this.aborted) break;
          emit({ type: 'chat-delta', sessionId, msgId, delta: c });
          await new Promise((r) => setTimeout(r, 20));
        }
        emit({ type: 'chat-delta', sessionId, msgId, delta: '', done: true });
      }

      this.status(emit, 'main', 'done', '任务完成');
      runLog.final(msgId, finalText, { degraded, answeredBy: answerSource });
      return finalText;
    } catch (err) {
      if (this.aborted) {
        this.emitAborted(emit, sessionId, msgId);
        return '';
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.status(emit, 'main', 'error', msg);
      this.report(emit, sessionId, msgId, `任务失败: ${msg}`, 'error', true);
      throw err;
    }
  }

  private emitAborted(
    emit: (e: OrchestratorEvent) => void,
    sessionId: string,
    msgId: string
  ): void {
    // 中止是任务内事实：对话日志留痕 + 执行过程可见，两侧同时有记录
    this.report(emit, sessionId, msgId, '任务已被用户中止', 'warn');
    emit({
      type: 'chat-delta',
      sessionId,
      msgId,
      delta: '\n\n（任务已被用户中止）',
      done: true
    });
    this.status(emit, 'main', 'done', '已中止');
  }
}

export interface ChatMessageLite {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

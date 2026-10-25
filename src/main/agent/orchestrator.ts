import type {
  AgentName,
  AgentStatus,
  LogEntry,
  SafetyRequest,
  AgentTraceEvent,
  TaskTodoItem
} from '../../shared/types';
import type { LLMRouter } from '../llm/router';
import type { LLMChatMessage, LLMResponse } from '../llm/provider';
import { LlmHttpError } from '../llm/openaiCompat';
import { getMemoryStore } from '../services/memory';
import type { SkillRegistry } from '../skills/registry';
import type { SafetyGate } from './safety';
import type { ToolRegistry } from './tools/registry';
import type { ToolContext } from './tools/types';
import type { AgentLoopStrategy, LoopCall, LoopObservation } from './loop/types';
import type { PromptStrategyId } from './prompt/registry';
import { createPromptRegistry } from './prompt/sections';
import { TextJsonStrategy } from './loop/textJson';
import { FunctionCallingStrategy } from './loop/functionCalling';

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
/** 运行时上下文快照标记：整句作为识别依据，避免误伤用户输入 */
const SNAPSHOT_MARKER = '[运行时上下文]（本快照取代此前所有运行时上下文）';

const FINAL_SYSTEM =
  '你是 Routine 主 Agent。用中文直接、简洁地回答用户，合理利用已获得的工具结果。使用 Markdown 格式，重点信息可用列表呈现。';

function truncateResult(value: unknown, limit: number): string {
  const text = typeof value === 'string' ? value : JSON.stringify(value);
  if (!text) return '(空结果)';
  return text.length > limit ? `${text.slice(0, limit)}…(已截断)` : text;
}

function isToolsUnsupportedError(err: unknown): boolean {
  return err instanceof LlmHttpError && [400, 404, 422].includes(err.status);
}

function isRuntimeSnapshot(message: LLMChatMessage): boolean {
  return typeof message.content === 'string' && message.content.startsWith(SNAPSHOT_MARKER);
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

  private log(
    emit: (e: OrchestratorEvent) => void,
    agent: AgentName | 'system',
    text: string,
    level: LogEntry['level'] = 'info'
  ): void {
    emit({
      type: 'log',
      entry: { id: crypto.randomUUID(), ts: Date.now(), agent, level, text }
    });
  }

  private toolContext(
    sessionId: string,
    emit: (e: OrchestratorEvent) => void,
    agent: AgentName
  ): ToolContext {
    return {
      sessionId,
      emit,
      status: (state, detail) => this.status(emit, agent, state, detail),
      log: (text, level) => this.log(emit, agent, text, level),
      signal: this.abortController?.signal ?? new AbortController().signal
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

  private async executeCall(
    emit: (e: OrchestratorEvent) => void,
    sessionId: string,
    msgId: string,
    call: LoopCall,
    failState: { key: string | null; count: number }
  ): Promise<LoopObservation> {
    const def = this.deps.registry.get(call.name);
    const argsDigest = JSON.stringify(call.args ?? {}).slice(0, 200);
    this.trace(emit, sessionId, msgId, { phase: 'tool-start', tool: call.name, argsDigest });

    let resultText: string;
    let failed = false;
    let denied = false;
    const started = Date.now();
    try {
      if (!def) throw new Error(`未知工具 ${call.name}，请从白名单中选择`);
      const result = await this.deps.registry.execute(
        call.name,
        call.args,
        this.toolContext(sessionId, emit, def.agent)
      );
      // 统一渲染入口：工具可自带 render，缺省 JSON 序列化；渲染后再截断
      const rendered = def.render ? def.render(result) : result;
      resultText = truncateResult(rendered, def.maxResultChars ?? DEFAULT_RESULT_LIMIT);
      this.status(emit, def.agent, 'done', `${call.name} 完成`);
    } catch (err) {
      failed = true;
      const msg = err instanceof Error ? err.message : String(err);
      denied = msg.includes('拒绝');
      resultText = denied
        ? `用户拒绝了该工具调用（${msg}）。不要原样重试，改用其他思路`
        : `工具执行失败: ${msg}`;
      if (def) {
        this.status(emit, def.agent, 'error', msg);
        this.log(emit, def.agent, `${call.name} 失败: ${msg}`, 'error');
      }
    }

    const durationMs = Date.now() - started;
    this.trace(emit, sessionId, msgId, {
      phase: 'tool-end',
      tool: call.name,
      resultDigest: resultText.slice(0, 160),
      error: failed || undefined,
      durationMs
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

    return { call, resultText };
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
    this.log(emit, 'system', `收到任务: ${text.slice(0, 100)}`);

    const baseMessages: LLMChatMessage[] = (history ?? [])
      .filter((m) => m.role === 'user' || m.role === 'assistant')
      .slice(-12)
      .map((m) => ({ role: m.role, content: m.content }));
    baseMessages.push({ role: 'user', content: text });

    const messages = [...baseMessages];
    const tools = this.deps.registry.all();
    const steps = this.maxSteps();
    let strategy = this.pickStrategy();
    const failState = { key: null as string | null, count: 0 };
    // 系统提示词按策略冻结：同任务内逐字节稳定，命中供应商前缀缓存
    const systemCache = new Map<PromptStrategyId, string>();
    let finalText: string | null = null;
    // 任务级锁定模型：单次任务全程使用同一档案，任务失败/结束后方可切换
    const provider = await this.deps.router.getActive();
    // 兜底摘要的数据源：运行态工具结果，与 LLM 消息格式（策略内部实现）解耦
    const taskObservations: { tool: string; resultText: string }[] = [];

    try {
      for (let round = 0; round < steps && !this.aborted; round++) {
        this.status(emit, 'main', 'thinking', `规划第 ${round + 1} 轮`);

        let roundDeltaEmitted = false;
        let res: LLMResponse;
        try {
          res = await provider.chatStream(
            strategy.buildRequest(
              this.systemFor(strategy, systemCache),
              this.withRuntimeSnapshot(messages),
              tools,
              this.abortController.signal
            ),
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
            this.log(emit, 'main', '当前云端接口不支持 function calling，已切换文本协议', 'warn');
            strategy = new TextJsonStrategy();
            round--;
            continue;
          }
          throw err;
        }

        const step = strategy.parseStep(res);

        if (step.type === 'final') {
          finalText = step.text;
          break;
        }

        if (step.type === 'retry') {
          strategy.commitStep(messages, step, []);
          continue;
        }

        if (step.thought) {
          this.log(emit, 'main', step.thought);
          // FC 轮次已流式推送 thought 增量；provider 未产生增量时补发整合文本
          if (strategy.id === 'text-json' || !roundDeltaEmitted) {
            this.trace(emit, sessionId, msgId, { phase: 'thought', thought: step.thought });
          }
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
          taskObservations.push({ tool: o.call.name, resultText: o.resultText });
        }

        strategy.commitStep(messages, step, observations);
      }

      if (this.aborted) {
        this.emitAborted(emit, sessionId, msgId);
        return '';
      }

      if (!finalText) {
        this.status(emit, 'main', 'thinking', '正在生成回答');
        let digest = taskObservations.map((o) => `${o.tool}: ${o.resultText}`).join('\n');
        if (digest.length > 12000) digest = `${digest.slice(0, 12000)}\n…（已截断）`;
        const res = await provider.chatStream(
          {
            system: FINAL_SYSTEM,
            messages: [
              { role: 'user', content: text },
              { role: 'user', content: `已执行的工具与结果：\n${digest || '（无）'}` }
            ],
            temperature: 0.5,
            signal: this.abortController.signal
          },
          (d) => emit({ type: 'chat-delta', sessionId, msgId, delta: d })
        );
        finalText = res.content;
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
      return finalText;
    } catch (err) {
      if (this.aborted) {
        this.emitAborted(emit, sessionId, msgId);
        return '';
      }
      const msg = err instanceof Error ? err.message : String(err);
      this.status(emit, 'main', 'error', msg);
      this.log(emit, 'system', `任务失败: ${msg}`, 'error');
      throw err;
    }
  }

  private emitAborted(
    emit: (e: OrchestratorEvent) => void,
    sessionId: string,
    msgId: string
  ): void {
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

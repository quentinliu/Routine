import type { LLMChatMessage, LLMRequest, LLMResponse } from '../../llm/provider';
import type { AgentLoopStep, AgentLoopStrategy, LoopObservation } from './types';
import { extractJsonObject, salvageJsonObject } from '../../util/jsonExtract';
import { TEXT_JSON_DECISION_MAX_TOKENS } from './limits';

interface PlanAction {
  tool: string;
  args: Record<string, unknown>;
}

interface PlanOutput {
  thought?: string;
  /** 单个调用（兼容旧格式） */
  action?: PlanAction | null;
  /** 一次提交多个调用：todo 刷新与只读查询可同轮并行，不再互相抢轮次 */
  actions?: PlanAction[] | null;
  final?: string | null;
  done?: boolean | null;
}

/** 合并 action 与 actions，过滤空项并按「工具名 + 参数」去重（模型常把同一个调用写两遍） */
export function collectPlanCalls(plan: PlanOutput): PlanAction[] {
  const raw: unknown[] = [];
  if (plan.action) raw.push(plan.action);
  if (Array.isArray(plan.actions)) raw.push(...plan.actions);

  const calls: PlanAction[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'object' || item === null) continue;
    const tool = (item as { tool?: unknown }).tool;
    if (typeof tool !== 'string' || !tool.trim()) continue;
    const args = (item as { args?: unknown }).args;
    const normalized = typeof args === 'object' && args !== null && !Array.isArray(args) ? args : {};
    const key = JSON.stringify([tool, normalized]);
    if (seen.has(key)) continue;
    seen.add(key);
    calls.push({ tool: tool.trim(), args: normalized as Record<string, unknown> });
  }
  return calls;
}

/** 从可能夹带代码块标记的文本中提取第一个完整 JSON 对象 */
export function extractJson(raw: string): PlanOutput | null {
  return extractJsonObject<PlanOutput>(raw);
}

const PARSE_FAILURE_LIMIT = 2;

/** 文本是否看起来已经讲完（用于判断被抢救出来的 final 能否直接交付） */
const COMPLETE_TAIL = /[。！？；;：:）)」』】\]]$/;

function looksComplete(text: string): boolean {
  const trimmed = text.trimEnd();
  if (trimmed.length < 80) return false;
  return COMPLETE_TAIL.test(trimmed) || trimmed.endsWith('```') || trimmed.endsWith('\n');
}

/**
 * 文本 JSON 协议策略：本地 Ollama 小模型等 function calling 不可靠场景的兜底。
 *
 * 决策与作答分层（v0.5.2）：
 * - 决策轮只输出轻量 JSON（调工具 / done），最终报告不再写进 `final` 字段；
 * - 模型标记 done 后由编排器的作答阶段以纯文本生成回答，避免长 Markdown 被
 *   上限截断后整份丢弃（v0.5.1 巡检事故的直接诱因）；
 * - 仍兼容旧的 `final` 写法，但只在内容「看起来讲完」时直接交付，否则转作答阶段。
 */
export class TextJsonStrategy implements AgentLoopStrategy {
  readonly id = 'text-json' as const;
  private parseFailures = 0;

  buildRequest(
    system: string,
    messages: LLMChatMessage[],
    _tools: unknown,
    signal: AbortSignal
  ): LLMRequest {
    return {
      system,
      messages,
      jsonMode: true,
      temperature: 0.2,
      // 决策 JSON 很短，但 thought 常被写长；2048 会在写 JSON 途中被切断
      maxTokens: TEXT_JSON_DECISION_MAX_TOKENS,
      signal
    };
  }

  parseStep(res: LLMResponse): AgentLoopStep {
    const strict = extractJson(res.content);
    const plan = strict ?? salvageJsonObject<PlanOutput>(res.content);

    if (!plan) {
      this.parseFailures += 1;
      if (this.parseFailures >= PARSE_FAILURE_LIMIT) {
        // 不再把原始 JSON 或「抱歉无法完成」当回答：交给作答阶段用已收集结果兜底
        return { type: 'answer', reason: 'truncated' };
      }
      return {
        type: 'retry',
        assistantRaw: res.content,
        reason: res.truncated ? 'truncated' : 'parse',
        correction: res.truncated
          ? '上一条输出被截断（未收到结束标记）。请重新只输出一个短小的 JSON 对象：调工具用 action，可作答用 {"action": null, "done": true}；不要在 JSON 里写回答正文'
          : 'JSON 格式错误，请重新只输出一个严格的 JSON 对象'
      };
    }

    // 解析成功即清零：失败次数衡量的是「连续」失败，而非累计
    this.parseFailures = 0;

    const calls = collectPlanCalls(plan);
    if (calls.length > 0) {
      return {
        type: 'calls',
        thought: plan.thought,
        assistantRaw: res.content,
        calls: calls.map((c) => ({ name: c.tool, args: c.args }))
      };
    }

    if (typeof plan.final === 'string' && plan.final.trim()) {
      // legacy 协议：只有在内容完整时才直接交付，被切断的报告改走作答阶段
      if (strict || looksComplete(plan.final)) {
        return { type: 'final', text: plan.final };
      }
      return { type: 'answer', reason: 'truncated' };
    }

    if (plan.done === true) {
      return { type: 'answer', reason: 'done' };
    }

    return {
      type: 'retry',
      assistantRaw: res.content,
      reason: 'parse',
      correction: '请给出 action（调用工具）或 done: true（可以作答），二者必须有其一'
    };
  }

  commitStep(
    messages: LLMChatMessage[],
    step: AgentLoopStep,
    observations: LoopObservation[]
  ): void {
    if (step.type === 'retry') {
      messages.push({ role: 'assistant', content: step.assistantRaw });
      messages.push({ role: 'user', content: step.correction });
      return;
    }
    if (step.type !== 'calls') return;
    messages.push({ role: 'assistant', content: step.assistantRaw });
    for (const o of observations) {
      messages.push({
        role: 'user',
        content: `工具结果: <tool_result>${o.resultText}</tool_result>`
      });
    }
  }
}

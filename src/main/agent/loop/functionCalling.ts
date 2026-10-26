import type { LLMChatMessage, LLMRequest, LLMResponse } from '../../llm/provider';
import type { ToolDefinition } from '../tools/types';
import type {
  AgentLoopStep,
  AgentLoopStrategy,
  LoopCall,
  LoopObservation
} from './types';
import { DECISION_MAX_TOKENS } from './limits';

/** 截断时的纠正话术：把输出压到「只提交工具调用」，别再把说明当正文写 */
const TRUNCATION_CORRECTION =
  '上一条输出被输出上限截断，未产生可执行的工具调用。请立刻重新提交：只输出工具调用，不要写解释、不要写回答正文；' +
  '调用较多时拆成这一轮能写完的几个（同类只读查询尽量并行）。';

/** 原生 function calling 策略：云端 OpenAI 兼容接口，支持并行 tool_calls */
export class FunctionCallingStrategy implements AgentLoopStrategy {
  readonly id = 'function-calling' as const;

  buildRequest(
    system: string,
    messages: LLMChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal
  ): LLMRequest {
    return {
      system,
      messages,
      temperature: 0.2,
      // 决策轮必须留足输出空间：见 limits.ts 里 2026-10-26 巡检截断事故
      maxTokens: DECISION_MAX_TOKENS,
      signal,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }))
    };
  }

  parseStep(res: LLMResponse): AgentLoopStep {
    if (res.toolCalls && res.toolCalls.length > 0) {
      const calls: LoopCall[] = [];
      for (const [i, tc] of res.toolCalls.entries()) {
        let args: Record<string, unknown> = {};
        let parsed = true;
        try {
          args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
        } catch {
          parsed = false;
        }
        // 截断流里的最后一个调用参数可能只写了一半：宁可这一轮不执行，
        // 也不能把半截 SQL 打到达库上（参数非法与「参数被切断」是两件事）
        if (!parsed && res.truncated) continue;
        if (!parsed) args = {};
        calls.push({ id: tc.id || `call_${i}`, name: tc.name, args });
      }
      if (calls.length > 0) {
        return {
          type: 'calls',
          thought: res.content.trim() || undefined,
          assistantRaw: res.content,
          calls
        };
      }
      // 全被丢弃：拿不到任何可执行调用，按截断重试而不是直接降级作答
      return {
        type: 'retry',
        assistantRaw: res.content,
        correction: TRUNCATION_CORRECTION,
        reason: 'truncated'
      };
    }
    if (res.content.trim()) {
      // 半截正文不能当最终回答交付：交给作答阶段基于工具结果重新成文
      if (res.truncated) return { type: 'answer', reason: 'truncated' };
      return { type: 'final', text: res.content.trim() };
    }
    // 空内容不再是「可以作答」，而是本轮什么都没拿到：
    // 截断时先纠正重试一轮（编排器有 MAX_PARSE_RETRIES 兜底），
    // 否则会像 2026-10-26 巡检那样从「读手册」直接跳到降级作答。
    if (res.truncated) {
      return {
        type: 'retry',
        assistantRaw: res.content,
        correction: TRUNCATION_CORRECTION,
        reason: 'truncated'
      };
    }
    return { type: 'answer', reason: 'done' };
  }

  commitStep(
    messages: LLMChatMessage[],
    step: AgentLoopStep,
    observations: LoopObservation[]
  ): void {
    // 纠正轮必须真的回灌：fc 早期版本在这里直接 return，纠正话术被静默丢弃，
    // 下一轮带着同样的上下文再撞一次上限
    if (step.type === 'retry') {
      messages.push({
        role: 'assistant',
        content: step.assistantRaw.trim() || '（上一轮没有产生任何输出）'
      });
      messages.push({ role: 'user', content: step.correction });
      return;
    }
    if (step.type !== 'calls') return;
    messages.push({
      role: 'assistant',
      content: step.assistantRaw,
      toolCalls: step.calls.map((c) => ({
        id: c.id ?? c.name,
        name: c.name,
        arguments: JSON.stringify(c.args)
      }))
    });
    for (const o of observations) {
      messages.push({
        role: 'tool',
        toolCallId: o.call.id ?? o.call.name,
        content: `<tool_result>${o.resultText}</tool_result>`
      });
    }
  }
}

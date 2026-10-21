import type { LLMChatMessage, LLMRequest, LLMResponse } from '../../llm/provider';
import type { ToolDefinition } from '../tools/types';
import type {
  AgentLoopStep,
  AgentLoopStrategy,
  LoopObservation
} from './types';

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
      signal,
      tools: tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.inputSchema }
      }))
    };
  }

  parseStep(res: LLMResponse): AgentLoopStep {
    if (res.toolCalls && res.toolCalls.length > 0) {
      const calls = res.toolCalls.map((tc, i) => {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.arguments || '{}') as Record<string, unknown>;
        } catch {
          args = {};
        }
        return { id: tc.id || `call_${i}`, name: tc.name, args };
      });
      return {
        type: 'calls',
        thought: res.content.trim() || undefined,
        assistantRaw: res.content,
        calls
      };
    }
    return {
      type: 'final',
      text: res.content.trim() || '抱歉，我暂时无法完成这个任务。'
    };
  }

  commitStep(
    messages: LLMChatMessage[],
    step: AgentLoopStep,
    observations: LoopObservation[]
  ): void {
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

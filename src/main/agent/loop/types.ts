import type { LLMChatMessage, LLMRequest, LLMResponse } from '../../llm/provider';
import type { ToolDefinition } from '../tools/types';

export interface LoopCall {
  id?: string;
  name: string;
  args: Record<string, unknown>;
}

export interface LoopObservation {
  call: LoopCall;
  resultText: string;
}

export type AgentLoopStep =
  | { type: 'final'; text: string }
  | { type: 'retry'; assistantRaw: string; correction: string }
  | { type: 'calls'; thought?: string; assistantRaw: string; calls: LoopCall[] };

/**
 * ReAct 循环策略：屏蔽「原生 function calling」与「文本 JSON 协议」的差异。
 * 策略实例为单次任务运行内的有状态对象（如解析失败计数）。
 */
export interface AgentLoopStrategy {
  readonly id: 'function-calling' | 'text-json';
  buildRequest(
    system: string,
    messages: LLMChatMessage[],
    tools: ToolDefinition[],
    signal: AbortSignal
  ): LLMRequest;
  parseStep(res: LLMResponse): AgentLoopStep;
  /** 将该轮 assistant 原文与全部观察结果提交进消息历史 */
  commitStep(
    messages: LLMChatMessage[],
    step: AgentLoopStep,
    observations: LoopObservation[]
  ): void;
}

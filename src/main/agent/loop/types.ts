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
  /** 该次调用是否失败（用户拒绝也算失败）；用于判定「是否还有效产出」 */
  failed?: boolean;
  /** 用户拒绝执行（策略性失败，不计入连续失败钳制，也不消耗规划轮次） */
  denied?: boolean;
  /** 参数 schema 校验未通过：整轮都非法时可原地重试，不消耗规划轮次 */
  invalidArgs?: boolean;
}

/**
 * `answer`：模型认为可以作答，但正文**不在决策 JSON 里**，由编排器的作答阶段
 * 以纯文本单独生成。长报告不再塞进 JSON 字符串，从根本上避免转义/截断丢答案。
 * - done：模型主动表示信息已足够
 * - truncated：决策 JSON 被截断且无法抢救（改用已收集的工具结果兜底）
 * - budget：轮次预算耗尽
 */
export type AgentLoopStep =
  | { type: 'final'; text: string }
  | { type: 'answer'; reason: 'done' | 'truncated' | 'budget' }
  | {
      type: 'retry';
      assistantRaw: string;
      correction: string;
      /** truncated：上游输出被截断（可重试）；parse：格式/协议不合法 */
      reason?: 'truncated' | 'parse';
    }
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

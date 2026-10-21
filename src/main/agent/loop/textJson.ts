import type { LLMChatMessage, LLMRequest, LLMResponse } from '../../llm/provider';
import type {
  AgentLoopStep,
  AgentLoopStrategy,
  LoopObservation
} from './types';

interface PlanAction {
  tool: string;
  args: Record<string, unknown>;
}

interface PlanOutput {
  thought?: string;
  action?: PlanAction | null;
  final?: string | null;
}

/** 从可能夹带代码块标记的文本中提取第一个完整 JSON 对象 */
export function extractJson(raw: string): PlanOutput | null {
  const stripped = raw.replace(/```(?:json)?/g, '').trim();
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as PlanOutput;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

const PARSE_FAILURE_LIMIT = 2;

/** 文本 JSON 协议策略：本地 Ollama 小模型等 function calling 不可靠场景的兜底 */
export class TextJsonStrategy implements AgentLoopStrategy {
  readonly id = 'text-json' as const;
  private parseFailures = 0;

  buildRequest(
    system: string,
    messages: LLMChatMessage[],
    _tools: unknown,
    signal: AbortSignal
  ): LLMRequest {
    return { system, messages, jsonMode: true, temperature: 0.2, signal };
  }

  parseStep(res: LLMResponse): AgentLoopStep {
    const plan = extractJson(res.content);

    if (!plan) {
      this.parseFailures++;
      if (this.parseFailures >= PARSE_FAILURE_LIMIT) {
        return { type: 'final', text: res.content.trim() || '抱歉，我暂时无法完成这个任务。' };
      }
      return {
        type: 'retry',
        assistantRaw: res.content,
        correction: 'JSON 格式错误，请重新只输出一个严格的 JSON 对象'
      };
    }

    if (plan.final) return { type: 'final', text: plan.final };

    if (!plan.action?.tool) {
      return {
        type: 'retry',
        assistantRaw: res.content,
        correction: '请给出 action（调用工具）或 final（最终回答），二者必须有其一'
      };
    }

    return {
      type: 'calls',
      thought: plan.thought,
      assistantRaw: res.content,
      calls: [{ name: plan.action.tool, args: plan.action.args ?? {} }]
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

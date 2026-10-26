import type {
  LLMChatMessage,
  LLMProvider,
  LLMRequest,
  LLMResponse,
  LLMToolCall
} from './provider';

interface SseToolCallDelta {
  index?: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}

interface SseChoiceDelta {
  delta?: { content?: string; tool_calls?: SseToolCallDelta[] };
  finish_reason?: string | null;
}

interface SseChunk {
  choices?: SseChoiceDelta[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

interface ToolCallAccumulator {
  id: string;
  name: string;
  arguments: string;
}

/** 带 HTTP 状态码的 LLM 错误：调用方按 status 做结构化判定（如 FC 降级），不再解析消息文本 */
export class LlmHttpError extends Error {
  constructor(
    message: string,
    readonly status: number
  ) {
    super(message);
    this.name = 'LlmHttpError';
  }
}

export async function* sseLines(res: Response): AsyncGenerator<string> {
  const reader = res.body?.getReader();
  if (!reader) throw new Error('响应无内容流');
  const decoder = new TextDecoder();
  let buffer = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx: number;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (line) yield line;
    }
  }
  const rest = buffer.trim();
  if (rest) yield rest;
}

export class OpenAICompatProvider implements LLMProvider {
  readonly id: string;

  constructor(
    public readonly baseURL: string,
    public readonly apiKey: string,
    public readonly model: string
  ) {
    this.id = `cloud:${model}`;
  }

  async chatStream(req: LLMRequest, onDelta: (d: string) => void): Promise<LLMResponse> {
    const messages: LLMChatMessage[] = [{ role: 'system', content: req.system }, ...req.messages];
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      temperature: req.temperature ?? 0.3,
      max_tokens: req.maxTokens ?? 2048
    };
    if (req.jsonMode) body.response_format = { type: 'json_object' };
    if (req.tools && req.tools.length > 0) body.tools = req.tools;
    Object.assign(body, req.extraBody ?? {});

    const res = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body),
      signal: req.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new LlmHttpError(
        `${this.id} 请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`,
        res.status
      );
    }

    let content = '';
    let finishReason = '';
    /** 是否收到明确的收尾信号（finish_reason 或 [DONE]）：缺失说明流被提前关闭 */
    let sawTerminator = false;
    let usage: LLMResponse['usage'];
    const toolAcc = new Map<number, ToolCallAccumulator>();
    for await (const line of sseLines(res)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        sawTerminator = true;
        break;
      }
      try {
        const chunk = JSON.parse(payload) as SseChunk;
        const choice = chunk.choices?.[0];
        const delta = choice?.delta?.content;
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        for (const tc of choice?.delta?.tool_calls ?? []) {
          const idx = Number(tc.index ?? 0);
          const acc = toolAcc.get(idx) ?? { id: '', name: '', arguments: '' };
          if (tc.id) acc.id = tc.id;
          if (tc.function?.name) acc.name += tc.function.name;
          if (tc.function?.arguments) acc.arguments += tc.function.arguments;
          toolAcc.set(idx, acc);
        }
        const fr = choice?.finish_reason;
        if (fr) {
          finishReason = fr;
          sawTerminator = true;
        }
        if (chunk.usage) {
          usage = {
            prompt: chunk.usage.prompt_tokens ?? 0,
            completion: chunk.usage.completion_tokens ?? 0
          };
        }
      } catch {
        // SSE 心跳/不完整行，跳过
      }
    }

    let toolCalls: LLMToolCall[] | undefined;
    let truncated = false;
    if (toolAcc.size > 0) {
      toolCalls = [...toolAcc.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([, acc], n) => ({
          id: acc.id || `call_${n}`,
          name: acc.name,
          arguments: acc.arguments || '{}'
        }));
      finishReason = 'tool_calls';
    } else if (!sawTerminator) {
      // 上游提前关闭连接：content 可能只是半截，不能让调用方误以为是正常结束
      truncated = true;
      finishReason = 'incomplete';
    } else if (finishReason === 'length') {
      truncated = true;
    } else if (!finishReason) {
      finishReason = 'stop';
    }
    return { content, finishReason, usage, toolCalls, truncated };
  }
}

import type { LLMChatMessage, LLMProvider, LLMRequest, LLMResponse } from './provider';

interface SseChoiceDelta {
  delta?: { content?: string };
  finish_reason?: string | null;
}

interface SseChunk {
  choices?: SseChoiceDelta[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
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
    Object.assign(body, req.extraBody ?? {});

    const res = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`
      },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${this.id} 请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    let content = '';
    let finishReason = 'stop';
    let usage: LLMResponse['usage'];
    for await (const line of sseLines(res)) {
      if (!line.startsWith('data:')) continue;
      const payload = line.slice(5).trim();
      if (payload === '[DONE]') break;
      try {
        const chunk = JSON.parse(payload) as SseChunk;
        const delta = chunk.choices?.[0]?.delta?.content;
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        const fr = chunk.choices?.[0]?.finish_reason;
        if (fr) finishReason = fr;
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
    return { content, finishReason, usage };
  }
}

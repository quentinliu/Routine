import type { LLMChatMessage, LLMProvider, LLMRequest, LLMResponse } from './provider';
import { sseLines } from './openaiCompat';

interface OllamaChatLine {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
}

export class OllamaProvider implements LLMProvider {
  readonly id: string;

  constructor(
    public readonly baseURL: string,
    public readonly model: string
  ) {
    this.id = `local:${model}`;
  }

  async chatStream(req: LLMRequest, onDelta: (d: string) => void): Promise<LLMResponse> {
    const messages: LLMChatMessage[] = [{ role: 'system', content: req.system }, ...req.messages];
    const body: Record<string, unknown> = {
      model: this.model,
      messages,
      stream: true,
      options: {
        temperature: req.temperature ?? 0.3,
        num_predict: req.maxTokens ?? 2048
      }
    };
    if (req.jsonMode) body.format = 'json';

    const res = await fetch(`${this.baseURL.replace(/\/$/, '')}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: req.signal
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`${this.id} 请求失败 HTTP ${res.status}: ${text.slice(0, 200)}`);
    }

    let content = '';
    let finishReason = 'stop';
    for await (const line of sseLines(res)) {
      try {
        const chunk = JSON.parse(line) as OllamaChatLine;
        const delta = chunk.message?.content;
        if (delta) {
          content += delta;
          onDelta(delta);
        }
        if (chunk.done) {
          finishReason = chunk.done_reason || 'stop';
          break;
        }
      } catch {
        // NDJSON 不完整行，跳过
      }
    }
    return { content, finishReason };
  }

  async listModels(): Promise<string[]> {
    const res = await fetch(`${this.baseURL.replace(/\/$/, '')}/api/tags`);
    if (!res.ok) return [];
    const data = (await res.json()) as { models?: Array<{ name?: string }> };
    return (data.models ?? []).map((m) => m.name ?? '').filter(Boolean);
  }
}

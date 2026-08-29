/** OpenAI 兼容多模态内容片段；image_url.url 接受 data URL（data:image/jpeg;base64,...）或 https 链接 */
export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string | LLMContentPart[];
}

export interface LLMRequest {
  system: string;
  messages: LLMChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  extraBody?: Record<string, unknown>;
}

export interface LLMUsage {
  prompt: number;
  completion: number;
}

export interface LLMResponse {
  content: string;
  finishReason: string;
  usage?: LLMUsage;
}

export interface LLMProvider {
  readonly id: string;
  chatStream(req: LLMRequest, onDelta: (d: string) => void): Promise<LLMResponse>;
  listModels?(): Promise<string[]>;
}

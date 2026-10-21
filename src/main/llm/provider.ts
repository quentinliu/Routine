/** OpenAI 兼容多模态内容片段；image_url.url 接受 data URL（data:image/jpeg;base64,...）或 https 链接 */
export type LLMContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

export interface LLMToolCall {
  id: string;
  name: string;
  /** JSON 字符串形式的参数（OpenAI 惯例） */
  arguments: string;
}

export interface LLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | LLMContentPart[];
  /** role=assistant 时携带的工具调用（function calling） */
  toolCalls?: LLMToolCall[];
  /** role=tool 时对应的调用 id */
  toolCallId?: string;
}

export interface LLMToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    /** JSON Schema */
    parameters: Record<string, unknown>;
  };
}

export interface LLMRequest {
  system: string;
  messages: LLMChatMessage[];
  temperature?: number;
  maxTokens?: number;
  jsonMode?: boolean;
  tools?: LLMToolSchema[];
  /** 中止信号，贯穿到 HTTP 请求 */
  signal?: AbortSignal;
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
  /** finish_reason=tool_calls 时为解析后的调用清单 */
  toolCalls?: LLMToolCall[];
}

export interface LLMProvider {
  readonly id: string;
  chatStream(req: LLMRequest, onDelta: (d: string) => void): Promise<LLMResponse>;
  listModels?(): Promise<string[]>;
}

import type { Settings } from '../../shared/types';
import { OpenAICompatProvider } from './openaiCompat';
import { OllamaProvider } from './ollama';
import type { LLMProvider } from './provider';

export interface LlmHealthState {
  cloud: boolean;
  local: boolean;
}

async function probe(url: string, init?: RequestInit): Promise<boolean> {
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 3000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      return res.ok;
    } finally {
      clearTimeout(timer);
    }
  } catch {
    return false;
  }
}

export class LLMRouter {
  settings: Settings | null = null;

  configure(settings: Settings): void {
    this.settings = settings;
  }

  async getActive(): Promise<LLMProvider> {
    if (!this.settings) throw new Error('LLM 路由未配置');
    if (this.settings.providerMode === 'cloud') {
      const { baseURL, apiKey, model } = this.settings.cloud;
      if (!apiKey) {
        throw new Error('云端模式需要 API Key，请在设置页填写并保存');
      }
      return new OpenAICompatProvider(baseURL, apiKey, model);
    }
    const { baseURL, model } = this.settings.ollama;
    return new OllamaProvider(baseURL, model);
  }

  async checkHealth(): Promise<LlmHealthState> {
    const s = this.settings;
    const cloud =
      !!s &&
      !!s.cloud.apiKey &&
      (await probe(`${s.cloud.baseURL.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${s.cloud.apiKey}` }
      }));
    const local = !!s && (await probe(`${s.ollama.baseURL.replace(/\/$/, '')}/api/tags`));
    return { cloud, local };
  }
}

let router: LLMRouter | null = null;

export function getRouter(): LLMRouter {
  if (!router) router = new LLMRouter();
  return router;
}

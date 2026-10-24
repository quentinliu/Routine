import type { CloudProfile, Settings } from '../../shared/types';
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

  private activeProfile(): CloudProfile {
    const s = this.settings as Settings;
    return s.cloudProfiles.find((p) => p.id === s.activeCloudId) ?? s.cloudProfiles[0];
  }

  async getActive(): Promise<LLMProvider> {
    if (!this.settings) throw new Error('LLM 路由未配置');
    if (this.settings.providerMode === 'cloud') {
      const { baseURL, apiKey, model } = this.activeProfile();
      if (!apiKey) {
        throw new Error('云端模式需要 API Key，请在设置页填写并保存');
      }
      return new OpenAICompatProvider(baseURL, apiKey, model);
    }
    const { baseURL, model } = this.settings.ollama;
    return new OllamaProvider(baseURL, model);
  }

  /** 逐个探测全部云端档案（并行，3s 超时）；key = profile.id */
  async healthClouds(): Promise<Record<string, boolean>> {
    const s = this.settings;
    const result: Record<string, boolean> = {};
    if (!s) return result;
    await Promise.all(
      s.cloudProfiles.map(async (p) => {
        result[p.id] =
          !!p.apiKey &&
          (await probe(`${p.baseURL.replace(/\/$/, '')}/models`, {
            headers: { Authorization: `Bearer ${p.apiKey}` }
          }));
      })
    );
    return result;
  }

  async checkHealth(): Promise<LlmHealthState> {
    const s = this.settings;
    const p = s ? this.activeProfile() : null;
    const cloud =
      !!s &&
      !!p?.apiKey &&
      (await probe(`${p.baseURL.replace(/\/$/, '')}/models`, {
        headers: { Authorization: `Bearer ${p.apiKey}` }
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

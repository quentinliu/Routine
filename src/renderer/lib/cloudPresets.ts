// ===== 云端模型预设（OpenAI 兼容接口）=====
// 仅渲染层 UI 便捷填充使用；配置形状仍为 CloudProviderConfig { baseURL, apiKey, model }，
// 不改共享类型与持久化格式。模型列表仅作 datalist 候选，用户始终可手输任意模型。

export interface CloudPreset {
  id: string;
  label: string;
  baseURL: string;
  models: string[];
  /** API Key 申请入口（平台控制台） */
  keyUrl: string;
}

export const CLOUD_PRESETS: CloudPreset[] = [
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4.6', 'glm-4.5-air'],
    keyUrl: 'https://open.bigmodel.cn'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    baseURL: 'https://api.deepseek.com/v1',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    keyUrl: 'https://platform.deepseek.com'
  },
  {
    id: 'qwen',
    label: '通义千问',
    baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen3-max', 'qwen-plus', 'qwen-turbo'],
    keyUrl: 'https://bailian.console.aliyun.com'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    baseURL: 'https://api.moonshot.cn/v1',
    models: ['kimi-k2-0905-preview', 'kimi-k2-turbo-preview'],
    keyUrl: 'https://platform.moonshot.cn'
  }
];

/** 按 baseURL 匹配预设（忽略首尾空白与末尾斜杠），无匹配返回 null（即自定义） */
export function matchPreset(baseURL: string): CloudPreset | null {
  const normalized = baseURL.trim().replace(/\/+$/, '');
  return (
    CLOUD_PRESETS.find((p) => p.baseURL.replace(/\/+$/, '') === normalized) ?? null
  );
}

import type { Settings } from '../../shared/types';

/** 入参守卫（M3）：坏数据在 IPC 边界拒绝，不再静默落盘 */
export function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`[INVALID] ${field} 不能为空`);
  }
  return value;
}

export function assertValidSettings(s: Settings): void {
  if (
    s.appearance &&
    s.appearance.theme !== 'system' &&
    s.appearance.theme !== 'light' &&
    s.appearance.theme !== 'dark'
  ) {
    throw new Error(`[INVALID] 未知主题: ${String(s.appearance.theme)}`);
  }
  if (s.providerMode !== 'cloud' && s.providerMode !== 'local') {
    throw new Error(`[INVALID] 未知工作模式: ${String(s.providerMode)}`);
  }
  if (!Array.isArray(s.cloudProfiles) || s.cloudProfiles.length === 0) {
    throw new Error('[INVALID] cloudProfiles 至少需要一条云端档案');
  }
  for (const p of s.cloudProfiles) {
    if (typeof p.id !== 'string' || !p.id) throw new Error('[INVALID] 云端档案缺少 id');
    if (typeof p.baseURL !== 'string' || !p.baseURL.trim()) {
      throw new Error(`[INVALID] 档案 ${p.id} 缺少 Base URL`);
    }
    if (typeof p.model !== 'string' || !p.model.trim()) {
      throw new Error(`[INVALID] 档案 ${p.id} 缺少模型名`);
    }
    if (typeof p.apiKey !== 'string') {
      throw new Error(`[INVALID] 档案 ${p.id} 的 API Key 格式无效`);
    }
  }
  if (
    typeof s.activeCloudId !== 'string' ||
    !s.cloudProfiles.some((p) => p.id === s.activeCloudId)
  ) {
    throw new Error('[INVALID] activeCloudId 未指向任何云端档案');
  }
}

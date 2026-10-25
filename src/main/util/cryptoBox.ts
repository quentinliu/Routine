type SafeStorageApi = {
  isEncryptionAvailable(): boolean;
  encryptString(plain: string): Buffer;
  decryptString(encoded: Buffer): string;
};

const PREFIX = 'enc:';

/**
 * Electron safeStorage 不可用（如纯 node 单测环境）时静默回退明文，
 * 加密值带 enc: 前缀，解密失败返回空串以防半字节垃圾渗入业务。
 */
function safeStorageApi(): SafeStorageApi | null {
  try {
    const mod = require('electron') as unknown;
    if (mod && typeof mod === 'object' && 'safeStorage' in mod) {
      const api = (mod as { safeStorage?: SafeStorageApi }).safeStorage;
      if (api && typeof api.isEncryptionAvailable === 'function' && api.isEncryptionAvailable()) {
        return api;
      }
    }
  } catch {
    // 无 electron 运行时，回退明文
  }
  return null;
}

export function encryptSecret(plain: string): string {
  if (!plain || plain.startsWith(PREFIX)) return plain;
  const api = safeStorageApi();
  if (!api) return plain;
  try {
    return PREFIX + api.encryptString(plain).toString('base64');
  } catch (err) {
    console.warn('[cryptoBox] 加密失败，回退明文:', err instanceof Error ? err.message : String(err));
    return plain;
  }
}

export function decryptSecret(value: string): string {
  if (!value || !value.startsWith(PREFIX)) return value;
  const api = safeStorageApi();
  if (!api) return '';
  try {
    return api.decryptString(Buffer.from(value.slice(PREFIX.length), 'base64'));
  } catch (err) {
    console.warn('[cryptoBox] 解密失败，返回空值:', err instanceof Error ? err.message : String(err));
    return '';
  }
}

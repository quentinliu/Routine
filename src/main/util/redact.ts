/**
 * 敏感字段收敛：约定「新增含密钥字段的配置/结果必须过 redact」。
 * - redactSecrets：保留字段名，值替换为空串（用于需要保持结构完整的类型/IPC 载荷）
 * - omitSecretFields：直接删除字段（用于送给模型的工具结果，避免模型把空串读成「凭据缺失」）
 */

const DEFAULT_SECRET_KEYS = [
  'password',
  'passphrase',
  'secret',
  'token',
  'apiKey',
  'privateKey'
] as const;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function walk(value: unknown, keys: ReadonlySet<string>, mode: 'mask' | 'omit'): unknown {
  if (Array.isArray(value)) return value.map((item) => walk(item, keys, mode));
  if (!isDict(value)) return value;

  const out: Dict = {};
  for (const [key, item] of Object.entries(value)) {
    if (keys.has(key)) {
      if (mode === 'mask') out[key] = '';
      continue;
    }
    out[key] = walk(item, keys, mode);
  }
  return out;
}

/** 掩码：命中的字段保留键名、值置空串；不修改入参 */
export function redactSecrets<T>(value: T, secretKeys: readonly string[] = DEFAULT_SECRET_KEYS): T {
  return walk(value, new Set(secretKeys), 'mask') as T;
}

/** 删除：命中的字段整键移除；不修改入参 */
export function omitSecretFields<T>(value: T, secretKeys: readonly string[] = DEFAULT_SECRET_KEYS): T {
  return walk(value, new Set(secretKeys), 'omit') as T;
}

export { DEFAULT_SECRET_KEYS };

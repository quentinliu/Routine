import type { SshExecOptions, SshHostConfig } from '../../../shared/types';

export const SSH_DEFAULT_PORT = 22;
export const SSH_COMMAND_MAX_CHARS = 8_192;

export const CONNECT_TIMEOUT_RANGE = { min: 1_000, max: 60_000, default: 10_000 } as const;
export const EXEC_TIMEOUT_RANGE = { min: 1_000, max: 300_000, default: 30_000 } as const;
export const MAX_OUTPUT_RANGE = { min: 1_024, max: 10_485_760, default: 524_288 } as const;

export interface NumericRange {
  min: number;
  max: number;
  default: number;
}

export interface ClampedExecOptions {
  timeoutMs: number;
  maxOutputBytes: number;
}

export function clampNumber(value: number | undefined, range: NumericRange): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return range.default;
  return Math.min(range.max, Math.max(range.min, Math.floor(n)));
}

export function clampConnectTimeoutMs(value?: number): number {
  return clampNumber(value, CONNECT_TIMEOUT_RANGE);
}

export function clampExecOptions(options?: SshExecOptions): ClampedExecOptions {
  return {
    timeoutMs: clampNumber(options?.timeoutMs, EXEC_TIMEOUT_RANGE),
    maxOutputBytes: clampNumber(options?.maxOutputBytes, MAX_OUTPUT_RANGE)
  };
}

export function targetLabel(host: Pick<SshHostConfig, 'host' | 'port' | 'user'>): string {
  return `${host.user}@${host.host}:${host.port}`;
}

export function validateSshHost(raw: SshHostConfig): SshHostConfig {
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('主机名称不能为空');
  const host = String(raw.host ?? '').trim();
  if (!host) throw new Error('主机地址不能为空');
  if (/\s/.test(host)) throw new Error('主机地址不能包含空白字符');
  const port = Number(raw.port);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error('端口必须是 1-65535 的整数');
  }
  const user = String(raw.user ?? '').trim();
  if (!user) throw new Error('用户名不能为空');
  if (raw.authType !== 'password' && raw.authType !== 'key') throw new Error('认证方式无效');
  const password = String(raw.password ?? '');
  const privateKeyPath = String(raw.privateKeyPath ?? '').trim();
  if (raw.authType === 'password' && !password) throw new Error('密码认证需要填写密码');
  if (raw.authType === 'key' && !privateKeyPath) throw new Error('密钥认证需要填写私钥路径');
  return {
    ...raw,
    id: String(raw.id ?? '').trim(),
    name,
    host,
    port,
    user,
    authType: raw.authType,
    password,
    privateKeyPath,
    passphrase: String(raw.passphrase ?? ''),
    enabled: raw.enabled ?? true,
    timeoutMs: raw.timeoutMs === undefined ? undefined : clampConnectTimeoutMs(raw.timeoutMs)
  };
}

export function validateSshCommand(command: string): string {
  const trimmed = command.trim();
  if (!trimmed) throw new Error('命令不能为空');
  if (trimmed.length > SSH_COMMAND_MAX_CHARS) {
    throw new Error(`命令过长（上限 ${SSH_COMMAND_MAX_CHARS} 字符）`);
  }
  return trimmed;
}

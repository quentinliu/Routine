import fs from 'node:fs';
import net from 'node:net';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshExecOptions, SshExecResult, SshHostConfig, SshTestResult } from '../../../shared/types';
import { expandHome } from '../../util/paths';
import { getStorage } from '../storage';
import {
  clampConnectTimeoutMs,
  clampExecOptions,
  targetLabel,
  validateSshCommand,
  validateSshHost
} from './util';

interface ClientConnection {
  client: Client;
  banner: string;
  latencyMs: number;
}

interface ExecOutcome {
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

function readPrivateKey(host: SshHostConfig): Buffer {
  const keyPath = expandHome(String(host.privateKeyPath ?? ''));
  try {
    return fs.readFileSync(keyPath);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(`无法读取私钥文件 ${keyPath}: ${reason}`);
  }
}

function buildConnectConfig(host: SshHostConfig): ConnectConfig {
  const config: ConnectConfig = {
    host: host.host,
    port: host.port,
    username: host.user,
    readyTimeout: clampConnectTimeoutMs(host.timeoutMs)
  };
  if (host.authType === 'password') {
    config.password = host.password;
  } else {
    config.privateKey = readPrivateKey(host);
    if (host.passphrase) config.passphrase = host.passphrase;
  }
  return config;
}

// RFC 4253：TCP 建立后服务端立即发送以 "SSH-" 开头的版本标识行
function probeBanner(host: SshHostConfig, timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    let settled = false;
    let data = '';
    const socket = net.connect({ host: host.host, port: host.port });
    const finish = (value: string): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(value);
    };
    socket.setTimeout(timeoutMs);
    socket.on('data', (chunk: Buffer) => {
      data += chunk.toString('utf-8');
      const nl = data.indexOf('\n');
      if (nl >= 0) {
        const line = data.slice(0, nl).trim();
        finish(line.startsWith('SSH-') ? line : '');
      } else if (data.length > 255) {
        finish('');
      }
    });
    socket.on('timeout', () => finish(''));
    socket.on('error', () => finish(''));
    socket.on('close', () => finish(''));
  });
}

async function connectClient(host: SshHostConfig): Promise<ClientConnection> {
  const timeoutMs = clampConnectTimeoutMs(host.timeoutMs);
  const banner = await probeBanner(host, timeoutMs);
  const startedAt = Date.now();
  const client = new Client();
  await new Promise<void>((resolve, reject) => {
    let settled = false;
    const fail = (reason: string): void => {
      if (settled) return;
      settled = true;
      reject(new Error(`${targetLabel(host)} 连接失败: ${reason}`));
    };
    client.on('ready', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
    client.on('error', (err: Error) => fail(err.message));
    client.on('close', () => fail('连接被关闭'));
    client.connect(buildConnectConfig(host));
  });
  return { client, banner, latencyMs: Date.now() - startedAt };
}

function execOnClient(
  client: Client,
  command: string,
  timeoutMs: number,
  maxOutputBytes: number
): Promise<ExecOutcome> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const finishResolve = (value: ExecOutcome): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const finishReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      reject(err);
    };
    timer = setTimeout(
      () => finishReject(new Error(`命令执行超时（${timeoutMs}ms）`)),
      timeoutMs
    );
    client.on('error', (err: Error) => finishReject(err));

    client.exec(command, (err, stream) => {
      if (err) {
        finishReject(new Error(`命令执行失败: ${err.message}`));
        return;
      }
      const outChunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let totalBytes = 0;
      let truncated = false;
      const cap = (chunk: Buffer): Buffer | null => {
        if (truncated) return null;
        if (totalBytes + chunk.length <= maxOutputBytes) {
          totalBytes += chunk.length;
          return chunk;
        }
        const room = Math.max(0, maxOutputBytes - totalBytes);
        truncated = true;
        totalBytes += room;
        stream.close();
        return room > 0 ? chunk.subarray(0, room) : Buffer.alloc(0);
      };
      stream.on('data', (chunk: Buffer) => {
        const piece = cap(chunk);
        if (piece && piece.length > 0) outChunks.push(piece);
      });
      stream.stderr.on('data', (chunk: Buffer) => {
        const piece = cap(chunk);
        if (piece && piece.length > 0) errChunks.push(piece);
      });
      stream.on('close', (code?: number | null, signal?: string) => {
        finishResolve({
          code: typeof code === 'number' ? code : null,
          signal: signal || undefined,
          stdout: Buffer.concat(outChunks).toString('utf-8'),
          stderr: Buffer.concat(errChunks).toString('utf-8'),
          truncated
        });
      });
    });
  });
}

export class SshService {
  listHosts(): SshHostConfig[] {
    return getStorage().loadSshHosts();
  }

  saveHost(raw: SshHostConfig): SshHostConfig {
    const normalized = validateSshHost(raw);
    const storage = getStorage();
    const list = storage.loadSshHosts();
    const existing = normalized.id ? list.find((h) => h.id === normalized.id) : undefined;
    const host: SshHostConfig = { ...normalized, id: existing?.id ?? crypto.randomUUID() };
    const next = existing
      ? list.map((h) => (h.id === host.id ? host : h))
      : [...list, host];
    storage.saveSshHosts(next);
    return host;
  }

  deleteHost(id: string): void {
    const storage = getStorage();
    const list = storage.loadSshHosts();
    if (!list.some((h) => h.id === id)) throw new Error(`主机不存在: ${id}`);
    storage.saveSshHosts(list.filter((h) => h.id !== id));
  }

  private getHost(id: string): SshHostConfig {
    const found = getStorage().loadSshHosts().find((h) => h.id === id);
    if (!found) throw new Error(`主机不存在: ${id}`);
    return found;
  }

  async testHost(id: string): Promise<SshTestResult> {
    const host = this.getHost(id);
    const { client, banner, latencyMs } = await connectClient(host);
    client.end();
    return { ok: true, banner, latencyMs };
  }

  async exec(id: string, command: string, options?: SshExecOptions): Promise<SshExecResult> {
    const host = this.getHost(id);
    if (!host.enabled) throw new Error(`主机已禁用: ${host.name}`);
    const cmd = validateSshCommand(command);
    const { timeoutMs, maxOutputBytes } = clampExecOptions(options);
    const { client } = await connectClient(host);
    const startedAt = Date.now();
    try {
      const outcome = await execOnClient(client, cmd, timeoutMs, maxOutputBytes);
      return { ok: outcome.code === 0, ...outcome, durationMs: Date.now() - startedAt };
    } finally {
      client.end();
    }
  }
}

let service: SshService | null = null;

export function getSshService(): SshService {
  if (!service) service = new SshService();
  return service;
}

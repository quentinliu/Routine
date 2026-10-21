import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type {
  McpConnState,
  McpServerConfig,
  McpServerInfo,
  McpTestResult,
  McpToolInfo
} from '../../../shared/types';
import type { ToolDefinition } from '../../agent/tools/types';
import type { ToolRegistry } from '../../agent/tools/registry';
import { getStorage } from '../storage';
import {
  extractMcpToolText,
  summarizeMcpTools,
  validateMcpServer
} from './config';

const APP_NAME = 'Routine';
const APP_VERSION = '0.2.1';
const CONNECT_TIMEOUT_MS = 15_000;

interface McpEntry {
  config: McpServerConfig;
  state: McpConnState;
  error?: string;
  client: Client | null;
  tools: McpToolInfo[];
  registeredNames: string[];
  connecting: Promise<McpServerInfo> | null;
  closingIntentionally: boolean;
}

type LogFn = (text: string, level?: 'info' | 'warn' | 'error') => void;

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超时（${ms}ms）`)), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

export class McpService {
  private readonly entries = new Map<string, McpEntry>();
  private log: LogFn = () => {};

  constructor(private readonly registry: ToolRegistry) {}

  setLogFn(fn: LogFn): void {
    this.log = fn;
  }

  private loadAll(): void {
    for (const config of getStorage().loadMcpServers()) {
      if (!this.entries.has(config.id)) {
        this.entries.set(config.id, this.blankEntry(config));
      }
    }
  }

  private blankEntry(config: McpServerConfig): McpEntry {
    return {
      config,
      state: 'disconnected',
      client: null,
      tools: [],
      registeredNames: [],
      connecting: null,
      closingIntentionally: false
    };
  }

  private info(entry: McpEntry): McpServerInfo {
    return {
      config: entry.config,
      state: entry.state,
      error: entry.error,
      tools: entry.tools
    };
  }

  list(): McpServerInfo[] {
    this.loadAll();
    return [...this.entries.values()].map((e) => this.info(e));
  }

  private buildClient(): Client {
    return new Client({ name: APP_NAME, version: APP_VERSION });
  }

  private buildTransport(config: McpServerConfig): StdioClientTransport | StreamableHTTPClientTransport {
    if (config.transport === 'stdio') {
      return new StdioClientTransport({
        command: String(config.command ?? ''),
        args: config.args ?? [],
        env: config.env
      });
    }
    return new StreamableHTTPClientTransport(new URL(String(config.url ?? '')), {
      requestInit: config.headers ? { headers: config.headers } : undefined
    });
  }

  private registerServerTools(entry: McpEntry, tools: McpToolInfo[]): void {
    for (const tool of tools) {
      let fullName = tool.fullName;
      let n = 2;
      while (this.registry.get(fullName)) fullName = `${tool.fullName}_${n++}`;
      const def = this.buildToolDefinition(entry.config, tool, fullName);
      this.registry.register(def);
      entry.registeredNames.push(fullName);
    }
  }

  private unregisterServerTools(entry: McpEntry): void {
    for (const name of entry.registeredNames) this.registry.unregister(name);
    entry.registeredNames = [];
  }

  private buildToolDefinition(
    config: McpServerConfig,
    tool: McpToolInfo,
    registeredName: string
  ): ToolDefinition {
    const clientKey = config.id;
    const rawToolName = tool.name;
    return {
      name: registeredName,
      description: `MCP·${config.name}: ${tool.description}`,
      inputSchema: tool.inputSchema ?? { type: 'object', properties: {} },
      agent: 'mcp',
      maxResultChars: 8000,
      risk: config.riskDefault,
      describe: (args) => ({
        actionSummary: `调用 MCP 工具 ${rawToolName}（服务：${config.name}）`,
        plan: [
          `服务: ${config.name}`,
          `工具: ${rawToolName}`,
          `参数: ${JSON.stringify(args).slice(0, 300)}`
        ]
      }),
      execute: async (args) => {
        const client = this.entries.get(clientKey)?.client;
        if (!client) throw new Error(`MCP 服务「${config.name}」未连接`);
        const result = await client.callTool({ name: rawToolName, arguments: args });
        return extractMcpToolText(result);
      }
    };
  }

  private async doConnect(entry: McpEntry): Promise<McpServerInfo> {
    entry.closingIntentionally = false;
    entry.state = 'connecting';
    entry.error = undefined;
    const client = this.buildClient();
    try {
      const transport = this.buildTransport(entry.config);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 ${entry.config.name}`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `发现工具 ${entry.config.name}`);
      const tools = summarizeMcpTools(listed.tools ?? [], entry.config);
      entry.client = client;
      entry.tools = tools;
      entry.state = 'connected';
      this.registerServerTools(entry, tools);
      this.log(`MCP 服务「${entry.config.name}」已连接，注册 ${tools.length} 个工具`);
      client.onclose = () => {
        if (entry.closingIntentionally) return;
        entry.client = null;
        entry.state = 'disconnected';
        entry.error = '连接已断开';
        this.unregisterServerTools(entry);
        this.log(`MCP 服务「${entry.config.name}」连接断开，工具已下线`, 'warn');
      };
      client.onerror = (err) => {
        this.log(`MCP 服务「${entry.config.name}」错误: ${err instanceof Error ? err.message : String(err)}`, 'warn');
      };
      return this.info(entry);
    } catch (err) {
      entry.client = null;
      entry.state = 'error';
      entry.error = err instanceof Error ? err.message : String(err);
      this.unregisterServerTools(entry);
      try {
        await client.close();
      } catch {
        // 连接未建立时 close 可能失败，忽略
      }
      this.log(`MCP 服务「${entry.config.name}」连接失败: ${entry.error}`, 'error');
      throw err;
    }
  }

  async connect(id: string): Promise<McpServerInfo> {
    this.loadAll();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP 服务不存在: ${id}`);
    if (entry.state === 'connected' && entry.client) return this.info(entry);
    if (!entry.connecting) {
      entry.connecting = this.doConnect(entry).finally(() => {
        entry.connecting = null;
      });
    }
    return entry.connecting;
  }

  async disconnect(id: string): Promise<McpServerInfo> {
    this.loadAll();
    const entry = this.entries.get(id);
    if (!entry) throw new Error(`MCP 服务不存在: ${id}`);
    entry.connecting = null;
    if (entry.client) {
      entry.closingIntentionally = true;
      try {
        await entry.client.close();
      } catch {
        // 已断开的连接 close 报错可忽略
      }
    }
    entry.client = null;
    entry.state = 'disconnected';
    entry.error = undefined;
    this.unregisterServerTools(entry);
    this.log(`MCP 服务「${entry.config.name}」已断开`);
    return this.info(entry);
  }

  async save(raw: McpServerConfig): Promise<McpServerConfig> {
    this.loadAll();
    const config = validateMcpServer(raw);
    const id = config.id || crypto.randomUUID();
    const saved: McpServerConfig = { ...config, id };
    const existing = this.entries.get(id);
    const wasConnected = existing?.state === 'connected';
    const list = getStorage().loadMcpServers().filter((s) => s.id !== id);
    list.push(saved);
    getStorage().saveMcpServers(list);

    if (existing) {
      await this.disconnect(id);
      const fresh = this.blankEntry(saved);
      this.entries.set(id, fresh);
      if (saved.enabled && wasConnected) {
        await this.connect(id);
      }
    } else {
      this.entries.set(id, this.blankEntry(saved));
    }
    return saved;
  }

  async remove(id: string): Promise<void> {
    this.loadAll();
    await this.disconnect(id).catch(() => {});
    this.entries.delete(id);
    const list = getStorage().loadMcpServers().filter((s) => s.id !== id);
    getStorage().saveMcpServers(list);
  }

  async test(config: McpServerConfig): Promise<McpTestResult> {
    const validated = validateMcpServer({ ...config, id: config.id || 'test' });
    const started = Date.now();
    const client = this.buildClient();
    try {
      const transport = this.buildTransport(validated);
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, `连接 ${validated.name}`);
      const listed = await withTimeout(client.listTools(), CONNECT_TIMEOUT_MS, `发现工具 ${validated.name}`);
      const tools = summarizeMcpTools(listed.tools ?? [], validated);
      return { ok: true, toolCount: tools.length, tools, latencyMs: Date.now() - started };
    } catch (err) {
      return {
        ok: false,
        toolCount: 0,
        tools: [],
        latencyMs: Date.now() - started,
        error: err instanceof Error ? err.message : String(err)
      };
    } finally {
      try {
        await client.close();
      } catch {
        // 测试连接的清理失败可忽略
      }
    }
  }

  async autoConnect(): Promise<void> {
    this.loadAll();
    const targets = [...this.entries.values()].filter(
      (e) => e.config.enabled && e.config.autoConnect && e.state === 'disconnected'
    );
    await Promise.allSettled(targets.map((e) => this.connect(e.config.id)));
  }

  async dispose(): Promise<void> {
    const ids = [...this.entries.keys()];
    await Promise.allSettled(ids.map((id) => this.disconnect(id)));
  }
}

let service: McpService | null = null;

export function initMcpService(registry: ToolRegistry): McpService {
  if (!service) service = new McpService(registry);
  return service;
}

export function getMcpService(): McpService {
  if (!service) throw new Error('MCP service not initialized');
  return service;
}

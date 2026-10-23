import { useEffect, useState, type ClipboardEvent } from 'react';
import type { McpServerConfig, McpServerInfo, McpTestResult, McpTransport } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';

type FormState = {
  id: string;
  name: string;
  transport: McpTransport;
  command: string;
  argsText: string;
  envText: string;
  url: string;
  headersText: string;
  riskDefault: 'safe' | 'medium';
  autoConnect: boolean;
  enabled: boolean;
};

const EMPTY_FORM: FormState = {
  id: '',
  name: '',
  transport: 'stdio',
  command: '',
  argsText: '',
  envText: '',
  url: '',
  headersText: '',
  riskDefault: 'medium',
  autoConnect: true,
  enabled: true
};

function toForm(config: McpServerConfig): FormState {
  return {
    id: config.id,
    name: config.name,
    transport: config.transport,
    command: config.command ?? '',
    argsText: (config.args ?? []).join('\n'),
    envText: Object.entries(config.env ?? {})
      .map(([k, v]) => `${k}=${v}`)
      .join('\n'),
    url: config.url ?? '',
    headersText: Object.entries(config.headers ?? {})
      .map(([k, v]) => `${k}: ${v}`)
      .join('\n'),
    riskDefault: config.riskDefault,
    autoConnect: config.autoConnect,
    enabled: config.enabled
  };
}

function parseKeyValue(text: string, sep: '=' | ':'): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const idx = trimmed.indexOf(sep);
    if (idx <= 0) continue;
    const key = trimmed.slice(0, idx).trim();
    const value = trimmed.slice(idx + sep.length).trim();
    if (key) out[key] = value;
  }
  return out;
}

/** 按空白拆分命令行，双/单引号包裹的内容视为一个参数 */
function splitCommandLine(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quote: '"' | "'" | null = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur) out.push(cur);
  return out;
}

interface ImportedServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

/** 解析 Claude Desktop / Cursor 的 mcpServers JSON、VS Code 的 servers JSON 或裸 server 对象 */
function parseMcpJson(text: string): { server: ImportedServer; total: number } {
  const raw: unknown = JSON.parse(text);
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('JSON 顶层必须是对象');
  }
  const obj = raw as Record<string, unknown>;
  let entries: Array<[string, unknown]> | null = null;
  for (const key of ['mcpServers', 'servers']) {
    const group = obj[key];
    if (typeof group === 'object' && group !== null && !Array.isArray(group)) {
      entries = Object.entries(group as Record<string, unknown>);
      break;
    }
  }
  let name = '';
  let server: Record<string, unknown>;
  if (entries) {
    const first = entries[0];
    if (!first) throw new Error('JSON 中没有可导入的服务');
    name = String(first[0] ?? '');
    server = (first[1] ?? {}) as Record<string, unknown>;
  } else {
    server = obj;
  }
  const command = typeof server.command === 'string' ? server.command.trim() : '';
  const url = typeof server.url === 'string' ? server.url.trim() : '';
  const args = Array.isArray(server.args) ? server.args.map(String) : [];
  const pickRecord = (v: unknown): Record<string, string> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return {};
    const out: Record<string, string> = {};
    for (const [k, val] of Object.entries(v)) out[k] = String(val);
    return out;
  };
  if (!command && !url) {
    throw new Error('JSON 缺少 command（stdio）或 url（http）字段');
  }
  if (!name) {
    name = command
      ? (args.find((a) => !a.startsWith('-') && a !== command) ?? command)
      : new URL(url).hostname;
  }
  name = name.replace(/^@[^/]+\//, '').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 64) || 'imported';
  return {
    server: {
      name,
      command: command || undefined,
      args: args.length > 0 ? args : undefined,
      env: pickRecord(server.env),
      url: url || undefined,
      headers: pickRecord(server.headers)
    },
    total: entries ? entries.length : 1
  };
}

const STATE_LABEL: Record<McpServerInfo['state'], string> = {
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '未连接',
  error: '连接失败'
};

export function McpSection() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const [form, setForm] = useState<FormState | null>(null);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<McpTestResult | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [importText, setImportText] = useState<string | null>(null);
  const setNotice = useAppStore((s) => s.setNotice);
  const requestConfirm = useAppStore((s) => s.requestConfirm);

  useEffect(() => {
    void refresh();
  }, []);

  async function refresh(): Promise<McpServerInfo[]> {
    const list = await api.mcpList().catch(() => []);
    setServers(list);
    return list;
  }

  function update(patch: Partial<FormState>): void {
    setForm((f) => (f ? { ...f, ...patch } : f));
  }

  function applyImported(server: ImportedServer): void {
    update({
      name: server.name,
      transport: server.url ? 'http' : 'stdio',
      command: server.command ?? '',
      argsText: (server.args ?? []).join('\n'),
      envText: Object.entries(server.env ?? {})
        .map(([k, v]) => `${k}=${v}`)
        .join('\n'),
      url: server.url ?? '',
      headersText: Object.entries(server.headers ?? {})
        .map(([k, v]) => `${k}: ${v}`)
        .join('\n')
    });
  }

  function importFromJson(): void {
    if (!form || importText === null) return;
    try {
      const { server, total } = parseMcpJson(importText);
      applyImported(server);
      setImportText(null);
      if (total > 1) {
        setNotice(`已导入第 1 个服务「${server.name}」（JSON 中共 ${total} 个，其余请逐个添加）`);
      }
    } catch (err) {
      setNotice(`JSON 解析失败：${err instanceof Error ? err.message : String(err)}`);
    }
  }

  function handleCommandPaste(e: ClipboardEvent<HTMLInputElement>): void {
    if (!form) return;
    const text = e.clipboardData.getData('text').trim();
    if (!text || !/\s/.test(text)) return;
    const parts = splitCommandLine(text);
    if (parts.length <= 1) return;
    requestConfirm({
      message: `检测到粘贴了完整命令行，是否自动拆分？\n\n命令：${parts[0]}\n参数：${parts.slice(1).join(' ')}\n\n（取消则原样粘贴）`,
      onConfirm: () => {
        const existingArgs = form.argsText.split('\n').map((l) => l.trim()).filter(Boolean);
        update({
          command: parts[0],
          argsText: [...parts.slice(1), ...existingArgs].join('\n')
        });
      }
    });
  }

  function toConfig(form: FormState): McpServerConfig {
    return {
      id: form.id,
      name: form.name,
      enabled: form.enabled,
      transport: form.transport,
      command: form.transport === 'stdio' ? form.command : undefined,
      args:
        form.transport === 'stdio'
          ? form.argsText.split('\n').map((l) => l.trim()).filter(Boolean)
          : undefined,
      env: form.transport === 'stdio' ? parseKeyValue(form.envText, '=') : undefined,
      url: form.transport === 'http' ? form.url : undefined,
      headers: form.transport === 'http' ? parseKeyValue(form.headersText, ':') : undefined,
      riskDefault: form.riskDefault,
      autoConnect: form.autoConnect
    };
  }

  function save(): void {
    if (!form) return;
    if (form.transport === 'stdio') {
      requestConfirm({
        message: `保存并启用 stdio 服务「${form.name}」意味着 Routine 将在本机启动并长期运行外部程序「${form.command}」。\n请确认该命令来源可信。继续？`,
        onConfirm: () => {
          void doSave();
        }
      });
      return;
    }
    void doSave();
  }

  async function doSave() {
    if (!form) return;
    setSaving(true);
    try {
      await api.mcpSave(toConfig(form));
      await refresh();
      setForm(null);
      setTestResult(null);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  }

  async function test() {
    if (!form) return;
    setTesting(true);
    setTestResult(null);
    try {
      setTestResult(await api.mcpTest(toConfig(form)));
    } catch (err) {
      setTestResult({
        ok: false,
        toolCount: 0,
        tools: [],
        latencyMs: 0,
        error: err instanceof Error ? err.message : String(err)
      });
    } finally {
      setTesting(false);
    }
  }

  async function toggleConnection(server: McpServerInfo) {
    setBusyId(server.config.id);
    try {
      if (server.state === 'connected') await api.mcpDisconnect(server.config.id);
      else await api.mcpConnect(server.config.id);
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
      await refresh();
    } finally {
      setBusyId(null);
    }
  }

  function remove(server: McpServerInfo): void {
    requestConfirm({
      message: `删除 MCP 服务「${server.config.name}」？连接将断开且配置移除。`,
      danger: true,
      onConfirm: () => {
        void doRemove(server);
      }
    });
  }

  async function doRemove(server: McpServerInfo) {
    try {
      await api.mcpDelete(server.config.id);
      await refresh();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : String(err));
    }
  }

  return (
    <section>
      <h4>MCP 服务</h4>
      <p className="field-hint">
        接入外部 MCP server 后，其工具自动注册为 Agent 可调用的扩展工具（默认每次调用需确认）
      </p>

      <div className="ssh-host-list">
        {servers.length === 0 && <div className="field-hint">尚未配置服务，点击下方按钮新增。</div>}
        {servers.map((server) => (
          <div key={server.config.id} className="ssh-host-item">
            <div className="ssh-host-main">
              <span
                className={`ssh-enabled-dot ${server.state === 'connected' ? 'on' : ''}`}
                title={STATE_LABEL[server.state]}
              />
              <span className="ssh-host-name">{server.config.name}</span>
              <span className="ssh-host-meta">
                {server.config.transport === 'stdio'
                  ? `stdio · ${server.config.command}`
                  : `http · ${server.config.url}`}{' '}
                · {STATE_LABEL[server.state]}
                {server.error ? `（${server.error}）` : ''}
              </span>
            </div>
            <div className="ssh-host-actions">
              <button
                className="btn-mini"
                disabled={busyId === server.config.id || server.state === 'connecting'}
                onClick={() => void toggleConnection(server)}
              >
                {busyId === server.config.id
                  ? '…'
                  : server.state === 'connected'
                    ? '断开'
                    : '连接'}
              </button>
              <button className="btn-mini" onClick={() => setForm(toForm(server.config))}>
                编辑
              </button>
              <button className="btn-mini danger" onClick={() => remove(server)}>
                删除
              </button>
            </div>
            {server.tools.length > 0 && (
              <div className="field-hint">
                工具（{server.tools.length}）：{server.tools.map((t) => t.name).join('、')}
              </div>
            )}
          </div>
        ))}
      </div>

      {!form && (
        <div className="index-row">
          <button className="btn-secondary" onClick={() => setForm({ ...EMPTY_FORM })}>
            新增服务
          </button>
        </div>
      )}

      {form && (
        <div className="ssh-form">
          <label className="field">
            <span>名称（英文数字连字符，用于生成工具名）</span>
            <input
              value={form.name}
              onChange={(e) => update({ name: e.target.value })}
              placeholder="filesystem"
            />
          </label>
          <div className="field">
            <span>传输类型</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${form.transport === 'stdio' ? 'active' : ''}`}
                onClick={() => update({ transport: 'stdio' })}
              >
                本地命令（stdio）
              </button>
              <button
                className={`seg-btn ${form.transport === 'http' ? 'active' : ''}`}
                onClick={() => update({ transport: 'http' })}
              >
                远程端点（HTTP）
              </button>
            </div>
          </div>

          {form.transport === 'stdio' ? (
            <>
              <label className="field">
                <span>启动命令（将在本机运行，请确认来源可信）</span>
                <input
                  value={form.command}
                  onChange={(e) => update({ command: e.target.value })}
                  onPaste={handleCommandPaste}
                  placeholder="npx"
                />
                <span className="field-hint">支持直接粘贴整行命令（如 npx -y xxx），将自动拆分到参数区</span>
              </label>
              <label className="field">
                <span>命令参数（每行一个）</span>
                <textarea
                  rows={2}
                  value={form.argsText}
                  onChange={(e) => update({ argsText: e.target.value })}
                  placeholder={'-y\n@modelcontextprotocol/server-filesystem\n~/Documents'}
                />
              </label>
              <label className="field">
                <span>环境变量（每行 KEY=VALUE，可选）</span>
                <textarea
                  rows={2}
                  value={form.envText}
                  onChange={(e) => update({ envText: e.target.value })}
                  placeholder="API_KEY=xxx"
                />
              </label>
            </>
          ) : (
            <>
              <label className="field">
                <span>端点 URL（Streamable HTTP）</span>
                <input
                  value={form.url}
                  onChange={(e) => update({ url: e.target.value })}
                  placeholder="https://example.com/mcp"
                />
              </label>
              <label className="field">
                <span>请求头（每行 KEY: VALUE，可选）</span>
                <textarea
                  rows={2}
                  value={form.headersText}
                  onChange={(e) => update({ headersText: e.target.value })}
                  placeholder="Authorization: Bearer xxx"
                />
              </label>
            </>
          )}

          <div className="field">
            <span>工具执行确认</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${form.riskDefault === 'medium' ? 'active' : ''}`}
                onClick={() => update({ riskDefault: 'medium' })}
              >
                每次确认（推荐）
              </button>
              <button
                className={`seg-btn ${form.riskDefault === 'safe' ? 'active' : ''}`}
                onClick={() => update({ riskDefault: 'safe' })}
              >
                直接执行
              </button>
            </div>
          </div>
          <div className="field">
            <span>启动选项</span>
            <div className="seg-group">
              <button
                className={`seg-btn ${form.enabled ? 'active' : ''}`}
                onClick={() => update({ enabled: true })}
              >
                启用
              </button>
              <button
                className={`seg-btn ${!form.enabled ? 'active' : ''}`}
                onClick={() => update({ enabled: false })}
              >
                停用
              </button>
              <button
                className={`seg-btn ${form.autoConnect ? 'active' : ''}`}
                onClick={() => update({ autoConnect: true })}
              >
                自动连接
              </button>
              <button
                className={`seg-btn ${!form.autoConnect ? 'active' : ''}`}
                onClick={() => update({ autoConnect: false })}
              >
                手动连接
              </button>
            </div>
          </div>

          <div className="form-actions">
            <button className="btn-secondary" onClick={() => setForm(null)}>
              取消
            </button>
            <button
              className="btn-secondary"
              onClick={() => setImportText(importText === null ? '' : null)}
            >
              {importText === null ? '从 JSON 导入' : '收起导入'}
            </button>
            <button className="btn-secondary" disabled={testing || !form.name.trim()} onClick={() => void test()}>
              {testing ? '测试中…' : '测试连接'}
            </button>
            <button className="btn-primary" disabled={saving || !form.name.trim()} onClick={() => save()}>
              {saving ? '保存中…' : '保存'}
            </button>
          </div>

          {importText !== null && (
            <div className="field">
              <span>粘贴 MCP 配置 JSON（支持 Claude Desktop / Cursor 的 mcpServers、VS Code 的 servers 或单个 server 对象）</span>
              <textarea
                rows={6}
                value={importText}
                onChange={(e) => setImportText(e.target.value)}
                placeholder={'{\n  "mcpServers": {\n    "filesystem": {\n      "command": "npx",\n      "args": ["-y", "@modelcontextprotocol/server-filesystem", "~/Documents"]\n    }\n  }\n}'}
              />
              <div className="form-actions">
                <button className="btn-primary" disabled={!importText.trim()} onClick={importFromJson}>
                  解析并填充
                </button>
              </div>
            </div>
          )}

          {testResult && (
            <div className={`ssh-test-result ${testResult.ok ? 'ok' : 'fail'}`}>
              {testResult.ok
                ? `✓ 连接成功 · ${testResult.toolCount} 个工具 · ${testResult.latencyMs}ms${
                    testResult.tools.length > 0
                      ? `：${testResult.tools.map((t) => t.name).join('、')}`
                      : ''
                  }`
                : `✗ ${testResult.error ?? '连接失败'}`}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

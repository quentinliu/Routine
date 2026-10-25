import { useEffect, useState, type ClipboardEvent } from 'react';
import type { McpServerConfig, McpServerInfo, McpTestResult, McpTransport } from '../../shared/types';
import { api } from '../ipc';
import { useAppStore } from '../store';
import { parseKeyValue, parseMcpJson, splitCommandLine, type ImportedServer } from '../lib/mcpParse';
import { useEntityForm } from '../lib/useEntityForm';

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

const STATE_LABEL: Record<McpServerInfo['state'], string> = {
  connected: '已连接',
  connecting: '连接中…',
  disconnected: '未连接',
  error: '连接失败'
};

export function McpSection() {
  const [servers, setServers] = useState<McpServerInfo[]>([]);
  const { form, setForm, update } = useEntityForm<FormState>(null);
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

      <div className="entity-list">
        {servers.length === 0 && <div className="field-hint">尚未配置服务，点击下方按钮新增。</div>}
        {servers.map((server) => (
          <div key={server.config.id} className="entity-item">
            <div className="entity-main">
              <span
                className={`entity-dot ${server.state === 'connected' ? 'on' : ''}`}
                title={STATE_LABEL[server.state]}
              />
              <span className="entity-name">{server.config.name}</span>
              <span className="entity-meta">
                {server.config.transport === 'stdio'
                  ? `stdio · ${server.config.command}`
                  : `http · ${server.config.url}`}{' '}
                · {STATE_LABEL[server.state]}
                {server.error ? `（${server.error}）` : ''}
              </span>
            </div>
            <div className="entity-actions">
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
        <div className="entity-form">
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

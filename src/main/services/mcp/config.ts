import type { McpServerConfig, McpToolInfo } from '../../../shared/types';

const NAME_MAX_CHARS = 64;

export function validateMcpServer(raw: McpServerConfig): McpServerConfig {
  const name = String(raw.name ?? '').trim();
  if (!name) throw new Error('服务名称不能为空');
  if (name.length > NAME_MAX_CHARS) throw new Error(`服务名称过长（上限 ${NAME_MAX_CHARS} 字符）`);
  if (raw.transport !== 'stdio' && raw.transport !== 'http') {
    throw new Error('传输类型无效（stdio / http）');
  }
  if (raw.transport === 'stdio') {
    const command = String(raw.command ?? '').trim();
    if (!command) throw new Error('stdio 服务必须填写启动命令');
    if (/\r|\n/.test(command)) throw new Error('启动命令不能包含换行');
  } else {
    const url = String(raw.url ?? '').trim();
    if (!/^https?:\/\//.test(url)) throw new Error('http 服务必须填写 http/https 端点 URL');
  }
  if (raw.riskDefault !== 'safe' && raw.riskDefault !== 'medium') {
    throw new Error('风险级别无效（safe / medium）');
  }
  return {
    ...raw,
    id: String(raw.id ?? '').trim(),
    name,
    enabled: raw.enabled ?? true,
    command: raw.transport === 'stdio' ? String(raw.command ?? '').trim() : undefined,
    args: Array.isArray(raw.args) ? raw.args.map(String) : undefined,
    env: raw.env && Object.keys(raw.env).length > 0 ? raw.env : undefined,
    url: raw.transport === 'http' ? String(raw.url ?? '').trim() : undefined,
    headers: raw.headers && Object.keys(raw.headers).length > 0 ? raw.headers : undefined,
    riskDefault: raw.riskDefault,
    autoConnect: raw.autoConnect ?? false
  };
}

/** function calling 名称约束（^[a-zA-Z0-9_-]{1,64}$）下的安全段 */
export function sanitizeSegment(input: string): string {
  const cleaned = input.replace(/[^a-zA-Z0-9_-]/g, '_').replace(/_{3,}/g, '__');
  return (cleaned.slice(0, 32) || 'srv').replace(/^_+|_+$/g, '') || 'srv';
}

export function mcpToolFullName(server: McpServerConfig, toolName: string): string {
  return `mcp__${sanitizeSegment(server.name)}__${sanitizeSegment(toolName)}`;
}

export function extractMcpToolText(result: unknown): string {
  const r = result as { content?: Array<{ type?: string; text?: string }> } | null;
  const parts = (r?.content ?? [])
    .filter((c) => !c.type || c.type === 'text')
    .map((c) => String(c.text ?? ''))
    .filter(Boolean);
  if (parts.length === 0) {
    const structured = (result as { structuredContent?: unknown }).structuredContent;
    return structured ? JSON.stringify(structured) : '(空结果)';
  }
  return parts.join('\n');
}

export function summarizeMcpTools(
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>,
  server: McpServerConfig
): McpToolInfo[] {
  return tools.map((t) => ({
    fullName: mcpToolFullName(server, t.name),
    name: t.name,
    description: String(t.description ?? '').slice(0, 500),
    inputSchema: isRecord(t.inputSchema) ? { ...t.inputSchema } : { type: 'object', properties: {} }
  }));
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

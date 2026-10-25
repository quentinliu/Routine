export interface ImportedServer {
  name: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

export function parseKeyValue(text: string, sep: '=' | ':'): Record<string, string> {
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
export function splitCommandLine(input: string): string[] {
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

/** 解析 Claude Desktop / Cursor 的 mcpServers JSON、VS Code 的 servers JSON 或裸 server 对象 */
export function parseMcpJson(text: string): { server: ImportedServer; total: number } {
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

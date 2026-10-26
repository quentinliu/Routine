/** 工具名的展示元数据：中文标签 + 图标类别 + 参数/结果的单行摘要 */

export type ToolKind =
  | 'file'
  | 'search'
  | 'terminal'
  | 'browser'
  | 'db'
  | 'ssh'
  | 'skill'
  | 'todo'
  | 'mcp'
  | 'system';

interface ToolMeta {
  label: string;
  kind: ToolKind;
}

const TOOL_META: Record<string, ToolMeta> = {
  'file.search': { label: '搜索文件', kind: 'file' },
  'file.read': { label: '读取文件', kind: 'file' },
  'computer.info': { label: '系统信息', kind: 'system' },
  'computer.exec': { label: '系统操作', kind: 'terminal' },
  'search.web': { label: '联网搜索', kind: 'search' },
  'browser.run': { label: '浏览器任务', kind: 'browser' },
  'ssh.hosts': { label: 'SSH 主机', kind: 'ssh' },
  'ssh.exec': { label: '远程命令', kind: 'ssh' },
  'db.list': { label: '数据源列表', kind: 'db' },
  'db.query': { label: '数据库查询', kind: 'db' },
  'db.exec': { label: '数据库变更', kind: 'db' },
  'inspection.run': { label: '数据库巡检', kind: 'db' },
  'skill.run': { label: '执行技能', kind: 'skill' },
  'skill.read': { label: '读取技能文件', kind: 'skill' },
  'todo.write': { label: '更新任务清单', kind: 'todo' }
};

export function toolMeta(name: string): ToolMeta {
  const hit = TOOL_META[name];
  if (hit) return hit;
  if (name.startsWith('mcp__')) {
    const tool = name.split('__')[2];
    return { label: tool || name, kind: 'mcp' };
  }
  return { label: name, kind: 'system' };
}

/** 摘要优先取最能说明「在做什么」的参数字段，逐级退化为首个字段/原文 */
const PRIMARY_KEYS = [
  'query',
  'path',
  'instruction',
  'command',
  'sql',
  'op',
  'url',
  'description',
  'name',
  'skill',
  'datasourceId',
  'text',
  'pattern'
];

export function summarizeArgs(raw?: string): string {
  const text = (raw ?? '').trim();
  if (!text || text === '{}' || text === '[]') return '';
  try {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    for (const key of PRIMARY_KEYS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return oneLine(value);
      if (typeof value === 'number') return String(value);
    }
    const first = Object.entries(parsed)[0];
    if (first) return oneLine(`${first[0]}: ${String(first[1])}`);
  } catch {
    // 摘要在主进程被截断（toolDigest 的 TOOL_ARGS_LIMIT），可能不是合法 JSON
  }
  return oneLine(text);
}

export function summarizeResult(raw?: string): string {
  const text = (raw ?? '').trim();
  if (!text) return '';
  const line = text.split('\n').map((s) => s.trim()).find(Boolean) ?? '';
  return oneLine(line);
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 140 ? `${flat.slice(0, 140)}…` : flat;
}

import type { TaskTodoItem, TaskTodoStatus } from '../../../../shared/types';
import type { ToolDefinition } from '../types';

const MAX_TODOS = 20;
const VALID_STATUSES: TaskTodoStatus[] = ['pending', 'in_progress', 'completed'];

/**
 * 会话内的清单状态：增量下发（只发变化的项）必须有地方做基线。
 * 渲染层事件仍是全量快照（契约不变），这里只服务于工具入参。
 */
const sessionTodos = new Map<string, TaskTodoItem[]>();

interface RawTodo {
  content?: unknown;
  title?: unknown;
  status?: unknown;
  index?: unknown;
}

function parseStatus(raw: unknown, label: string): TaskTodoStatus {
  const status = String(raw ?? '');
  if (!VALID_STATUSES.includes(status as TaskTodoStatus)) {
    throw new Error(`${label} status 无效: ${status || '（空）'}`);
  }
  return status as TaskTodoStatus;
}

function parseContent(raw: RawTodo, label: string): string {
  // 兼容 title：文本协议历史上不下发嵌套 schema，模型容易把标题写成 title
  const content = String(raw.content ?? raw.title ?? '').trim();
  if (!content) throw new Error(`${label} content 不能为空`);
  return content;
}

function asItems(raw: unknown, field: string): RawTodo[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error(`${field} 不能为空`);
  if (raw.length > MAX_TODOS) throw new Error(`子任务最多 ${MAX_TODOS} 项`);
  return raw as RawTodo[];
}

/** 全量提交：覆盖整份清单（首次制定计划时使用） */
function replaceAll(raw: unknown): TaskTodoItem[] {
  return asItems(raw, 'todos').map((item, i) => ({
    content: parseContent(item, `第 ${i + 1} 项`),
    status: parseStatus(item.status, `第 ${i + 1} 项`)
  }));
}

/** 增量提交：只带 index（1 起）+ 需要变更的字段，其余项保持原状 */
function patchExisting(raw: unknown, baseline: readonly TaskTodoItem[]): TaskTodoItem[] {
  const next = baseline.map((t) => ({ ...t }));
  asItems(raw, 'patch').forEach((item, i) => {
    const n = Number(item.index);
    if (!Number.isInteger(n) || n < 1 || n > next.length) {
      throw new Error(`第 ${i + 1} 项 index 无效: ${String(item.index ?? '（空）')}（当前共 ${next.length} 项，index 从 1 起）`);
    }
    const target = next[n - 1];
    if (item.status !== undefined && item.status !== '') {
      target.status = parseStatus(item.status, `第 ${n} 项`);
    }
    if (item.content !== undefined || item.title !== undefined) {
      target.content = parseContent(item, `第 ${n} 项`);
    }
  });
  return next;
}

export function createTodoTools(): ToolDefinition[] {
  return [
    {
      name: 'todo.write',
      description:
        '维护当前任务的子任务清单：首次制定计划用 todos 全量提交；之后只用 patch 增量提交发生变化的项（index + status），不要重发整份清单。',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '全量提交（首次制定计划时使用，覆盖整份清单）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '子任务内容（字段名固定为 content）' },
                status: { type: 'string', enum: VALID_STATUSES }
              },
              required: ['content', 'status']
            }
          },
          patch: {
            type: 'array',
            description: '增量提交：只带变化项（index 从 1 起），其余项保持不变',
            items: {
              type: 'object',
              properties: {
                index: { type: 'number', description: '目标项序号（1 起）' },
                content: { type: 'string', description: '需要改写时的新内容' },
                status: { type: 'string', enum: VALID_STATUSES }
              },
              required: ['index']
            }
          }
        },
        required: []
      },
      agent: 'main',
      maxResultChars: 200,
      risk: 'safe',
      async execute(args, ctx) {
        const hasTodos = Array.isArray(args.todos) && args.todos.length > 0;
        const hasPatch = Array.isArray(args.patch) && args.patch.length > 0;
        if (!hasTodos && !hasPatch) throw new Error('todos 与 patch 必须给其一：首次用 todos 全量提交，之后用 patch 增量提交');
        if (hasTodos && hasPatch) throw new Error('todos 与 patch 不能同时提交：全量用 todos，增量用 patch');

        const key = ctx.sessionId || 'default';
        let todos: TaskTodoItem[];
        if (hasPatch) {
          const baseline = sessionTodos.get(key);
          if (!baseline || baseline.length === 0) {
            throw new Error('还没有清单基线，无法增量更新：请先用 todos 全量提交一次');
          }
          todos = patchExisting(args.patch, baseline);
        } else {
          todos = replaceAll(args.todos);
        }
        sessionTodos.set(key, todos);
        ctx.emit({ type: 'todo', sessionId: ctx.sessionId, todos });
        return hasPatch
          ? `已更新 ${(args.patch as unknown[]).length} 项（当前共 ${todos.length} 项）`
          : `已更新 ${todos.length} 项子任务`;
      }
    }
  ];
}

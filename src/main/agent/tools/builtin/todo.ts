import type { TaskTodoItem, TaskTodoStatus } from '../../../../shared/types';
import type { ToolDefinition } from '../types';

const MAX_TODOS = 20;
const VALID_STATUSES: TaskTodoStatus[] = ['pending', 'in_progress', 'completed'];

function parseTodos(raw: unknown): TaskTodoItem[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('todos 不能为空');
  if (raw.length > MAX_TODOS) throw new Error(`子任务最多 ${MAX_TODOS} 项`);
  return raw.map((item, i) => {
    const content = String((item as { content?: unknown }).content ?? '').trim();
    const status = String((item as { status?: unknown }).status ?? '');
    if (!content) throw new Error(`第 ${i + 1} 项 content 不能为空`);
    if (!VALID_STATUSES.includes(status as TaskTodoStatus)) {
      throw new Error(`第 ${i + 1} 项 status 无效: ${status || '（空）'}`);
    }
    return { content, status: status as TaskTodoStatus };
  });
}

export function createTodoTools(): ToolDefinition[] {
  return [
    {
      name: 'todo.write',
      description:
        '维护当前任务的子任务清单：复杂任务开始时制定计划（全部 pending、首项 in_progress），每完成一项立即更新，收尾前全部 completed',
      inputSchema: {
        type: 'object',
        properties: {
          todos: {
            type: 'array',
            description: '完整的子任务清单（全量提交）',
            items: {
              type: 'object',
              properties: {
                content: { type: 'string', description: '子任务内容' },
                status: { type: 'string', enum: VALID_STATUSES }
              },
              required: ['content', 'status']
            }
          }
        },
        required: ['todos']
      },
      agent: 'main',
      maxResultChars: 60,
      risk: 'safe',
      async execute(args, ctx) {
        const todos = parseTodos(args.todos);
        ctx.emit({ type: 'todo', sessionId: ctx.sessionId, todos });
        return `已更新 ${todos.length} 项子任务`;
      }
    }
  ];
}

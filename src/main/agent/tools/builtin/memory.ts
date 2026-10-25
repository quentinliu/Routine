import { getMemoryStore } from '../../../services/memory';
import type { ToolDefinition } from '../types';

export function createMemoryTools(): ToolDefinition[] {
  return [
    {
      name: 'memory.write',
      description:
        '把值得跨会话长期记住的信息写入长期记忆（用户偏好、项目背景、重要约定、环境事实）。不要记录临时性内容或敏感凭据。每次写一条要点',
      inputSchema: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '一条记忆要点（≤500 字符）' }
        },
        required: ['content']
      },
      agent: 'main',
      maxResultChars: 60,
      risk: 'safe',
      async execute(args) {
        const content = String((args as { content?: unknown }).content ?? '');
        getMemoryStore().append(content);
        return '已写入长期记忆';
      }
    }
  ];
}

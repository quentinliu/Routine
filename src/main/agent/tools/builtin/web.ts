import type { WebSearchService } from '../../../services/webSearch';
import type { ToolDefinition } from '../types';

export function createWebTools(web: WebSearchService): ToolDefinition[] {
  return [
    {
      name: 'search.web',
      description: '联网搜索',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词' },
          limit: { type: 'number', description: '结果条数上限，默认 6' }
        },
        required: ['query']
      },
      agent: 'search',
      risk: 'safe',
      async execute(args) {
        return web.search(String(args.query ?? ''), Number(args.limit ?? 6));
      }
    }
  ];
}

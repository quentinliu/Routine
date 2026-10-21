import type { FileAgentService } from '../../../services/fileAgent';
import type { ToolDefinition } from '../types';

export function createFileTools(fileAgent: FileAgentService): ToolDefinition[] {
  return [
    {
      name: 'file.search',
      description: '本地文件搜索（桌面/文档/下载目录已建立索引）',
      inputSchema: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，可多个空格分隔' },
          limit: { type: 'number', description: '返回条数上限，默认 20' }
        },
        required: ['query']
      },
      agent: 'file',
      risk: 'safe',
      async execute(args) {
        return fileAgent.searchFiles(String(args.query ?? ''), Number(args.limit ?? 20));
      }
    },
    {
      name: 'file.read',
      description: '读取文本文件内容',
      inputSchema: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '文件绝对路径，支持 ~ 展开' },
          maxBytes: { type: 'number', description: '读取字节上限，默认 65536' }
        },
        required: ['path']
      },
      agent: 'file',
      maxResultChars: 32000,
      risk: 'safe',
      async execute(args) {
        return fileAgent.readFile(String(args.path ?? ''), Number(args.maxBytes ?? 65536));
      }
    }
  ];
}

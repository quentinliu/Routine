'use strict';
// 测试夹具：最小 MCP stdio server（echo / add 两个工具）
// 注意：stdout 是 JSON-RPC 协议通道，日志只能走 stderr
const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const {
  ListToolsRequestSchema,
  CallToolRequestSchema
} = require('@modelcontextprotocol/sdk/types.js');

const server = new Server({ name: 'echo-server', version: '1.0.0' }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'echo',
      description: '回显文本',
      inputSchema: {
        type: 'object',
        properties: { text: { type: 'string', description: '要回显的内容' } },
        required: ['text']
      }
    },
    {
      name: 'add',
      description: '两数相加',
      inputSchema: {
        type: 'object',
        properties: { a: { type: 'number' }, b: { type: 'number' } },
        required: ['a', 'b']
      }
    }
  ]
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const name = req.params.name;
  const args = req.params.arguments ?? {};
  if (name === 'echo') {
    return { content: [{ type: 'text', text: `echo:${args.text}` }] };
  }
  if (name === 'add') {
    return { content: [{ type: 'text', text: `sum:${Number(args.a) + Number(args.b)}` }] };
  }
  throw new Error(`unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
server
  .connect(transport)
  .then(() => process.stderr.write('echo-server ready\n'))
  .catch((err) => {
    process.stderr.write(`echo-server failed: ${err}\n`);
    process.exit(1);
  });

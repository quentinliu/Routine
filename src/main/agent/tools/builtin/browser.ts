import type { BrowserAgentService } from '../../../services/browser';
import { SECTION_ORDERS } from '../../prompt/registry';
import type { ToolDefinition } from '../types';

export function createBrowserTools(browser: BrowserAgentService): ToolDefinition[] {
  return [
    {
      name: 'browser.run',
      description:
        '视觉浏览器 Agent，自动完成打开页面/登录（需在设置中配置站点凭据）/点击/表单/截图等网页任务',
      inputSchema: {
        type: 'object',
        properties: {
          instruction: { type: 'string', description: '完整的自然语言任务指令' }
        },
        required: ['instruction']
      },
      agent: 'browser',
      risk: 'safe',
      promptSection: {
        name: 'tool:browser',
        order: SECTION_ORDERS.TOOL_GUIDES,
        text: '浏览器任务：把完整自然语言指令传给 browser.run，例如 "打开 github.com 截图并提取正文"；不要用搜索工具或系统操作替代网页交互'
      },
      async execute(args, ctx) {
        return browser.run(String(args.instruction ?? ''), (line) => ctx.log(line));
      }
    }
  ];
}

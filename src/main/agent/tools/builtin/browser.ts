import type { BrowserAgentService } from '../../../services/browser';
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
      async execute(args, ctx) {
        return browser.run(String(args.instruction ?? ''), (line) => ctx.log(line));
      }
    }
  ];
}

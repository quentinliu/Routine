import { COMPUTER_OPS, type ComputerService } from '../../../services/computer';
import type { RiskClass } from '../../safety';
import type { ToolDefinition } from '../types';

function resolveOpRisk(op: string): RiskClass {
  return COMPUTER_OPS.find((o) => o.op === op)?.risk ?? 'high';
}

export function createComputerTools(computer: ComputerService): ToolDefinition[] {
  return [
    {
      name: 'computer.info',
      description: '获取系统信息快照（CPU/内存/磁盘/电池）',
      inputSchema: { type: 'object', properties: {} },
      agent: 'computer',
      risk: 'safe',
      async execute() {
        return computer.snapshot();
      }
    },
    {
      name: 'computer.exec',
      description: '执行系统操作（op 白名单，medium/high 需用户确认）',
      inputSchema: {
        type: 'object',
        properties: {
          op: { type: 'string', description: '操作名，来自白名单' },
          args: { type: 'object', description: '操作参数' }
        },
        required: ['op']
      },
      agent: 'computer',
      risk: (args) => resolveOpRisk(String(args.op ?? '')),
      // op 枚举作为工具清单的补充行（原提示词即此形态；FC 模式由 schema 承接）
      promptListExtra: COMPUTER_OPS.map(
        (o) => `  - ${o.op}: ${o.description}（风险 ${o.risk}）`
      ).join('\n'),
      describe(args, risk) {
        const op = String(args.op ?? '');
        const opMeta = COMPUTER_OPS.find((o) => o.op === op);
        return {
          actionSummary: opMeta ? opMeta.description : `执行系统操作 ${op}`,
          plan: [
            `操作: ${op}`,
            `参数: ${JSON.stringify(args)}`,
            risk === 'high' ? '该操作不可逆，请谨慎确认' : '该操作会改变系统状态'
          ],
          waitingStatus: `等待确认: ${op}`,
          waitingLog: `高风险操作 ${op} 等待用户确认`,
          rejectStatus: `用户已拒绝: ${op}`,
          rejectError: `用户拒绝执行该操作: ${op}`
        };
      },
      async execute(args) {
        return computer.execWhitelisted(
          String(args.op ?? ''),
          (args.args ?? {}) as Record<string, unknown>
        );
      }
    }
  ];
}

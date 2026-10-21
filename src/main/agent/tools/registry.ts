import type { AgentName } from '../../../shared/types';
import type { SafetyGate } from '../safety';
import type { ToolContext, ToolDefinition } from './types';

/**
 * 工具注册表：编排器唯一的工具入口。
 * execute 内聚风险分级 → 安全审批 → 执行的统一管道，工具自身不再各自实现审批流。
 */
export class ToolRegistry {
  private readonly defs = new Map<string, ToolDefinition>();

  constructor(private readonly safety: SafetyGate) {}

  register(...defs: ToolDefinition[]): void {
    for (const def of defs) {
      if (this.defs.has(def.name)) throw new Error(`工具重复注册: ${def.name}`);
      if (def.risk !== 'safe' && !def.describe) {
        throw new Error(`工具 ${def.name} 声明了非 safe 风险但缺少 describe()`);
      }
      this.defs.set(def.name, def);
    }
  }

  all(): ToolDefinition[] {
    return [...this.defs.values()];
  }

  get(name: string): ToolDefinition | undefined {
    return this.defs.get(name);
  }

  unregister(name: string): boolean {
    return this.defs.delete(name);
  }

  /** 去重后的 Agent 列表（按注册顺序） */
  agents(): AgentName[] {
    return [...new Set(this.all().map((d) => d.agent))];
  }

  /** 执行工具并返回原始结果；错误一律抛出，由调用方决定如何呈现 */
  async execute(
    name: string,
    args: Record<string, unknown>,
    ctx: ToolContext
  ): Promise<unknown> {
    const def = this.defs.get(name);
    if (!def) throw new Error(`未知工具: ${name}`);

    const risk = typeof def.risk === 'function' ? def.risk(args) : def.risk;
    if (risk !== 'safe') {
      const d = def.describe
        ? def.describe(args, risk)
        : { actionSummary: def.description, plan: [] };
      const request = this.safety.createRequest(
        def.agent,
        d.actionSummary,
        d.plan.length > 0 ? d.plan : [`工具: ${name}`, `参数: ${JSON.stringify(args)}`],
        risk
      );
      ctx.status(
        'waiting-approval',
        d.waitingStatus ?? `等待确认: ${d.actionSummary.slice(0, 50)}`
      );
      ctx.log(d.waitingLog ?? `高风险操作 ${name} 等待用户确认`, 'warn');
      ctx.emit({ type: 'safety', request });
      const approved = await this.safety.awaitApproval(request);
      if (!approved) {
        ctx.status('done', d.rejectStatus ?? '用户已拒绝');
        throw new Error(d.rejectError ?? `用户拒绝执行该操作: ${name}`);
      }
    }

    return def.execute(args, ctx);
  }
}

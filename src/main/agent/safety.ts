import type { AgentName, SafetyRequest } from '../../shared/types';
import { getAuditLog } from '../services/audit';

export type RiskClass = 'safe' | 'medium' | 'high';

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

/** 审计为辅助能力：写失败（如磁盘异常）只告警，绝不阻断审批流 */
function auditSafely(action: () => void): void {
  try {
    action();
  } catch (err) {
    console.warn('[audit] 写入失败:', err instanceof Error ? err.message : String(err));
  }
}

export class SafetyGate {
  private readonly pending = new Map<string, PendingApproval>();
  private riskOverrides: Record<string, RiskClass> = {};

  /** M2：来自 Settings.riskOverrides 的工具风险级覆盖 */
  configure(overrides: Record<string, RiskClass> | undefined): void {
    this.riskOverrides = overrides ?? {};
  }

  /** 覆盖规则：基线 high 不可下调至 safe（塌缩为 medium）；未配置走基线 */
  effectiveRisk(tool: string, base: RiskClass): RiskClass {
    const override = this.riskOverrides[tool];
    if (!override || override === base) return base;
    if (base === 'high' && override === 'safe') return 'medium';
    return override;
  }

  createRequest(
    agent: AgentName,
    actionSummary: string,
    plan: string[],
    riskLevel: 'medium' | 'high',
    tool?: string
  ): SafetyRequest {
    const request: SafetyRequest = {
      id: crypto.randomUUID(),
      agent,
      actionSummary,
      plan,
      riskLevel,
      createdAt: Date.now(),
      tool
    };
    auditSafely(() =>
      getAuditLog().record({
        id: request.id,
        ts: request.createdAt,
        agent,
        tool: tool ?? 'unknown',
        summary: actionSummary,
        risk: riskLevel,
        outcome: 'pending'
      })
    );
    return request;
  }

  awaitApproval(req: SafetyRequest, timeoutMs = 120000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        auditSafely(() => getAuditLog().resolve(req.id, 'timeout'));
        resolve(false);
      }, timeoutMs);
      this.pending.set(req.id, {
        resolve: (approved) => {
          clearTimeout(timer);
          resolve(approved);
        },
        timer
      });
    });
  }

  resolveApproval(id: string, approved: boolean): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    auditSafely(() => getAuditLog().resolve(id, approved ? 'approved' : 'denied'));
    entry.resolve(approved);
    return true;
  }
}

let gate: SafetyGate | null = null;

export function getSafetyGate(): SafetyGate {
  if (!gate) gate = new SafetyGate();
  return gate;
}

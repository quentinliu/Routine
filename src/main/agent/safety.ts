import type { AgentName, SafetyRequest } from '../../shared/types';
import { getAuditLog } from '../services/audit';

export type RiskClass = 'safe' | 'medium' | 'high';

/**
 * 审批结论：denied / timeout / canceled 三者必须分开。
 * 把「没人点」「窗口关了」「用户中止」都讲成「用户拒绝」，会让复盘得出完全错误的结论。
 */
export type ApprovalOutcome = 'approved' | 'denied' | 'timeout' | 'canceled';

const RISK_RANK: Record<RiskClass, number> = { safe: 0, medium: 1, high: 2 };

export const DEFAULT_APPROVAL_TIMEOUT_MS = 120_000;

interface PendingApproval {
  resolve: (outcome: ApprovalOutcome) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface SafetyRequestInput {
  agent: AgentName;
  actionSummary: string;
  plan: string[];
  riskLevel: 'medium' | 'high';
  tool?: string;
  /** 审批详情（命令/SQL 原文）：审计留痕用，缺省只有 actionSummary 无法取证 */
  detail?: string;
  /** 触发审批的任务 id：把审计条目关联回会话日志 */
  msgId?: string;
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

  /** approvalTimeoutMs 可注入：测试用于验证「超时」与「拒绝」的可区分性 */
  constructor(private readonly approvalTimeoutMs = DEFAULT_APPROVAL_TIMEOUT_MS) {}

  /** M2：来自 Settings.riskOverrides 的工具风险级覆盖 */
  configure(overrides: Record<string, RiskClass> | undefined): void {
    this.riskOverrides = overrides ?? {};
  }

  /**
   * 覆盖规则（只允许在安全底线之上调整）：
   * 1) 基线 high 不可下调至 safe（历史行为：塌缩为 medium）
   * 2) floor 为工具自带的不可降级底线（如 ssh.exec / db.exec 恒为 medium），
   *    任何覆盖都不得低于它——否则一条设置就能把远程执行变成静默执行
   */
  effectiveRisk(tool: string, base: RiskClass, floor: RiskClass = 'safe'): RiskClass {
    const override = this.riskOverrides[tool];
    let risk: RiskClass = !override || override === base ? base : override;
    if (base === 'high' && risk === 'safe') risk = 'medium';
    return RISK_RANK[risk] < RISK_RANK[floor] ? floor : risk;
  }

  createRequest(input: SafetyRequestInput): SafetyRequest {
    const request: SafetyRequest = {
      id: crypto.randomUUID(),
      agent: input.agent,
      actionSummary: input.actionSummary,
      plan: input.plan,
      riskLevel: input.riskLevel,
      createdAt: Date.now(),
      tool: input.tool
    };
    auditSafely(() =>
      getAuditLog().record({
        id: request.id,
        ts: request.createdAt,
        agent: input.agent,
        tool: input.tool ?? 'unknown',
        summary: input.actionSummary,
        risk: input.riskLevel,
        outcome: 'pending',
        detail: input.detail,
        msgId: input.msgId
      })
    );
    return request;
  }

  awaitApproval(req: SafetyRequest, timeoutMs = this.approvalTimeoutMs): Promise<ApprovalOutcome> {
    return new Promise<ApprovalOutcome>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
        auditSafely(() => getAuditLog().resolve(req.id, 'timeout'));
        resolve('timeout');
      }, timeoutMs);
      this.pending.set(req.id, {
        resolve: (outcome) => {
          clearTimeout(timer);
          resolve(outcome);
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
    entry.resolve(approved ? 'approved' : 'denied');
    return true;
  }

  /**
   * 审批请求无法送达（窗口销毁/渲染进程重载）时立即终结，
   * 不要白等满超时，也不要把它记成「用户拒绝」。
   */
  cancelApproval(id: string, reason: string): boolean {
    const entry = this.pending.get(id);
    if (!entry) return false;
    this.pending.delete(id);
    auditSafely(() => getAuditLog().resolve(id, 'canceled'));
    console.warn(`[safety] 审批请求已取消: ${reason}`);
    entry.resolve('canceled');
    return true;
  }

  /** 用户中止任务：清空未决请求，避免 busy 锁被白占满超时 */
  cancelAll(reason: string): number {
    const ids = [...this.pending.keys()];
    for (const id of ids) this.cancelApproval(id, reason);
    return ids.length;
  }
}

let gate: SafetyGate | null = null;

export function getSafetyGate(): SafetyGate {
  if (!gate) gate = new SafetyGate();
  return gate;
}

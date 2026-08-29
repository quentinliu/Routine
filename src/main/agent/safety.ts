import type { AgentName, SafetyRequest } from '../../shared/types';
import { COMPUTER_OPS } from '../services/computer';

export type RiskClass = 'safe' | 'medium' | 'high';

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class SafetyGate {
  private readonly pending = new Map<string, PendingApproval>();

  classify(tool: string, args: unknown): RiskClass {
    if (tool === 'file.search' || tool === 'file.read' || tool === 'search.web') return 'safe';
    if (tool === 'browser.run') return 'safe';
    if (tool === 'computer.info') return 'safe';
    if (tool === 'computer.exec') {
      const op =
        typeof args === 'object' && args !== null ? (args as { op?: unknown }).op : undefined;
      const found = COMPUTER_OPS.find((o) => o.op === op);
      return found ? found.risk : 'high';
    }
    return 'high';
  }

  createRequest(
    agent: AgentName,
    actionSummary: string,
    plan: string[],
    riskLevel: 'medium' | 'high'
  ): SafetyRequest {
    return {
      id: crypto.randomUUID(),
      agent,
      actionSummary,
      plan,
      riskLevel,
      createdAt: Date.now()
    };
  }

  awaitApproval(req: SafetyRequest, timeoutMs = 120000): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(req.id);
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
    entry.resolve(approved);
    return true;
  }
}

let gate: SafetyGate | null = null;

export function getSafetyGate(): SafetyGate {
  if (!gate) gate = new SafetyGate();
  return gate;
}

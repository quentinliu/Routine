import fs from 'node:fs';
import path from 'node:path';

const AUDIT_FILE = 'audit.json';
const MAX_ENTRIES = 500;

export type AuditOutcome = 'pending' | 'approved' | 'denied' | 'timeout';

export interface AuditEntry {
  id: string;
  ts: number;
  agent: string;
  tool: string;
  summary: string;
  risk: string;
  outcome: AuditOutcome;
  resolvedAt?: number;
}

/** 安全门审计日志（M2）：仅记录 medium/high 操作，环形上限 500 条，最新在前 */
export class AuditLog {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, AUDIT_FILE);
  }

  list(): AuditEntry[] {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
      return Array.isArray(parsed) ? (parsed as AuditEntry[]) : [];
    } catch {
      return [];
    }
  }

  record(entry: AuditEntry): void {
    const all = this.list();
    all.unshift(entry);
    this.write(all.slice(0, MAX_ENTRIES));
  }

  resolve(id: string, outcome: Exclude<AuditOutcome, 'pending'>): void {
    const all = this.list();
    const found = all.find((e) => e.id === id);
    if (!found || found.outcome !== 'pending') return;
    found.outcome = outcome;
    found.resolvedAt = Date.now();
    this.write(all);
  }

  private write(entries: AuditEntry[]): void {
    fs.writeFileSync(this.file, JSON.stringify(entries), 'utf-8');
  }
}

let log: AuditLog | null = null;

export function initAudit(dir: string): void {
  log = new AuditLog(dir);
}

export function getAuditLog(): AuditLog {
  if (!log) throw new Error('audit log 未初始化');
  return log;
}

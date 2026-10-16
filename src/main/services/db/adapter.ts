export interface DbAdapter {
  serverVersion(): Promise<string>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;
  ping(): Promise<void>;
  destroy(): Promise<void>;
}

export interface CheckContext {
  adapter: DbAdapter;
  thresholds: Record<string, number>;
  emitProgress: (line: string) => void;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 10_000;

export function normalizeVersion(raw: string): number[] {
  const m = raw.trim().match(/^(\d+(?:\.\d+)*)/);
  if (!m) return [];
  return m[1].split('.').map(Number);
}

export function versionGte(actual: number[], min: number[]): boolean {
  const len = Math.max(actual.length, min.length);
  for (let i = 0; i < len; i++) {
    const a = actual[i] ?? 0;
    const b = min[i] ?? 0;
    if (a !== b) return a > b;
  }
  return true;
}

import type { DatasourceConfig } from '../../shared/types';

/**
 * 数据库连通状态：只反映「能否访问」这一层事实。
 * 已知问题（锁等待、复制延迟、命中率）属于工作台实时概览，不再混进侧栏健康度。
 */
export type DbHealth = 'probing' | 'down' | 'ok' | 'disabled';

export interface DbStatusRow {
  ds: DatasourceConfig;
  health: DbHealth;
  latencyMs?: number;
  version?: string;
  error?: string;
}

export interface DbProbeOutcome {
  ok: boolean;
  latencyMs?: number;
  version?: string;
  error?: string;
}

const RANK: Record<DbHealth, number> = {
  probing: 0,
  down: 1,
  ok: 2,
  disabled: 3
};

/** 排序：探测中置顶，其次不可达 → 正常 → 停用；组内按名称 */
export function buildStatusRows(
  list: DatasourceConfig[],
  testById: Map<string, DbProbeOutcome>
): DbStatusRow[] {
  const rows = list.map((ds): DbStatusRow => {
    if (!ds.enabled) return { ds, health: 'disabled' };
    const test = testById.get(ds.id);
    if (!test) return { ds, health: 'probing' };
    if (!test.ok) {
      return { ds, health: 'down', error: test.error, latencyMs: test.latencyMs };
    }
    return { ds, health: 'ok', latencyMs: test.latencyMs, version: test.version };
  });
  return rows.sort(
    (a, b) => RANK[a.health] - RANK[b.health] || a.ds.name.localeCompare(b.ds.name)
  );
}

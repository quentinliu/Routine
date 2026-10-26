import type { CheckResult, DatasourceConfig, InspectionReport } from '../../shared/types';

/**
 * 数据库健康度：down=无法访问（红）、issues=有已知问题（黄）、ok=正常（绿）、
 * disabled=已停用（灰，不探测）。probing 为组件探测过程中的过渡态。
 */
export type DbHealth = 'probing' | 'down' | 'issues' | 'ok' | 'disabled';

export interface DbStatusRow {
  ds: DatasourceConfig;
  health: DbHealth;
  latencyMs?: number;
  error?: string;
  issueCount?: number;
}

export interface DbProbeOutcome {
  ok: boolean;
  latencyMs?: number;
  error?: string;
}

/** 已知问题数 = 最近一次巡检报告中 warn + error 项 */
export function countCheckIssues(results: CheckResult[]): number {
  return results.filter((r) => r.status === 'warn' || r.status === 'error').length;
}

const RANK: Record<DbHealth, number> = {
  probing: 0,
  down: 1,
  issues: 2,
  ok: 3,
  disabled: 4
};

/** 排序：红 → 黄 → 绿 → 灰（探测中置顶），组内按名称 */
export function buildStatusRows(
  list: DatasourceConfig[],
  testById: Map<string, DbProbeOutcome>,
  latestReportById: Map<string, InspectionReport | undefined>
): DbStatusRow[] {
  const rows = list.map((ds): DbStatusRow => {
    if (!ds.enabled) return { ds, health: 'disabled' };
    const test = testById.get(ds.id);
    if (!test) return { ds, health: 'probing' };
    if (!test.ok) {
      return { ds, health: 'down', error: test.error, latencyMs: test.latencyMs };
    }
    const report = latestReportById.get(ds.id);
    const issueCount = report ? countCheckIssues(report.results ?? []) : 0;
    return issueCount > 0
      ? { ds, health: 'issues', issueCount }
      : { ds, health: 'ok', latencyMs: test.latencyMs };
  });
  return rows.sort(
    (a, b) => RANK[a.health] - RANK[b.health] || a.ds.name.localeCompare(b.ds.name)
  );
}

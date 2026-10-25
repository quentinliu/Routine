import type { InspectionReport } from '../../shared/types';
import { getInspectionStore } from './inspectionStore';
import { notify } from './notifier';

const BASELINE_WINDOW_DAYS = 7;
/** 当前 1 次 + 此前 ≥3 次通过才有「首现异常」判定意义 */
const MIN_BASELINE_REPORTS = 4;

/**
 * 巡检告警（M2）：失败即告警；单项检查「由正常转为异常」按 7 天基线判定。
 * 依赖报告已先落库（fails 计数含当前这次，=1 即此前全通过）。
 */
export function evaluateInspectionAlerts(report: InspectionReport): void {
  const store = getInspectionStore();
  if (!report.ok) {
    notify(
      `数据库巡检异常：${report.datasourceName}`,
      '连接失败或巡检未完成',
      { dedupeKey: `inspection:${report.datasourceId}:down` }
    );
    return;
  }
  const since = Date.now() - BASELINE_WINDOW_DAYS * 86400_000;
  for (const check of report.results) {
    if (check.status === 'ok') continue;
    const total = store.countReportsInWindow(report.datasourceId, since);
    if (total < MIN_BASELINE_REPORTS) continue;
    const fails = store.countCheckFailsInWindow(report.datasourceId, check.checkId, since);
    if (fails === 1) {
      notify(
        `数据库巡检异常：${report.datasourceName}`,
        `${check.title} 由正常转为异常（${check.value ?? check.status}）`,
        { dedupeKey: `inspection:${report.datasourceId}:${check.checkId}` }
      );
    }
  }
}

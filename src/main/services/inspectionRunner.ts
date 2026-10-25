import type { InspectionReport } from '../../shared/types';
import { getDbService } from './db/service';
import { evaluateInspectionAlerts } from './inspectionAlerts';
import { getStorage } from './storage';

/**
 * 巡检唯一执行入口（M4）：执行 → 落库 → 告警评估。
 * 设置页手动巡检与内置工具 inspection.run 共用，避免两条路径语义分叉。
 */
export async function runInspection(
  datasourceId: string,
  emitProgress?: (line: string) => void
): Promise<InspectionReport> {
  const report = await getDbService().inspect(datasourceId, emitProgress);
  getStorage().appendInspectionReport(report);
  evaluateInspectionAlerts(report);
  return report;
}

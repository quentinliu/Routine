import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';
import type { DailyPoint, InspectionReport, InspectionTrend } from '../../shared/types';

const DB_FILE = 'inspections.db';
const LEGACY_JSON = 'inspections.json';
const RETENTION_DAYS = 365;
const MAX_ROWS_PER_DATASOURCE = 50000;

/**
 * 巡检报告 SQLite 存储（M2）：原始明细全量保留（默认 365 天 + 单数据源 5 万行双上限），
 * 首次初始化时从旧 inspections.json 一次性导入并改名 .migrated。
 */
export class InspectionStore {
  private readonly db: DatabaseSync;
  private readonly legacyPath: string;

  constructor(dir: string) {
    this.db = new DatabaseSync(path.join(dir, DB_FILE));
    this.legacyPath = path.join(dir, LEGACY_JSON);
    this.db.exec('PRAGMA journal_mode = WAL');
    this.db.exec(`CREATE TABLE IF NOT EXISTS inspection_reports (
      id              TEXT PRIMARY KEY,
      datasource_id   TEXT NOT NULL,
      datasource_name TEXT NOT NULL,
      started_at      INTEGER NOT NULL,
      finished_at     INTEGER NOT NULL,
      ok              INTEGER NOT NULL,
      server_version  TEXT,
      results_json    TEXT NOT NULL
    )`);
    this.db.exec(
      'CREATE INDEX IF NOT EXISTS idx_reports_ds_time ON inspection_reports(datasource_id, started_at DESC)'
    );
    this.migrateFromJson();
  }

  /** 表为空且旧 JSON 存在时一次性导入（自愈：导入失败不改名，下次重试） */
  private migrateFromJson(): void {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM inspection_reports').get() as {
      n: number;
    };
    if (Number(row.n) > 0 || !fs.existsSync(this.legacyPath)) return;
    let legacy: InspectionReport[];
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.legacyPath, 'utf-8'));
      if (!Array.isArray(parsed)) return;
      legacy = parsed as InspectionReport[];
    } catch {
      return;
    }
    const insert = this.db.prepare(
      `INSERT OR REPLACE INTO inspection_reports
       (id, datasource_id, datasource_name, started_at, finished_at, ok, server_version, results_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    this.db.exec('BEGIN');
    try {
      for (const r of legacy) {
        insert.run(
          r.id,
          r.datasourceId,
          r.datasourceName,
          r.startedAt,
          r.finishedAt,
          r.ok ? 1 : 0,
          r.serverVersion ?? '',
          JSON.stringify(r.results ?? [])
        );
      }
      this.db.exec('COMMIT');
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
    fs.renameSync(this.legacyPath, `${this.legacyPath}.migrated`);
  }

  appendReport(report: InspectionReport): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO inspection_reports
         (id, datasource_id, datasource_name, started_at, finished_at, ok, server_version, results_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        report.id,
        report.datasourceId,
        report.datasourceName,
        report.startedAt,
        report.finishedAt,
        report.ok ? 1 : 0,
        report.serverVersion ?? '',
        JSON.stringify(report.results ?? [])
      );
    this.prune();
  }

  listReports(datasourceId?: string, limit = 10000): InspectionReport[] {
    const sql = `SELECT id, datasource_id, datasource_name, started_at, finished_at, ok, server_version, results_json
                 FROM inspection_reports ${
                   datasourceId ? 'WHERE datasource_id = ?' : ''
                 } ORDER BY started_at DESC LIMIT ?`;
    const stmt = this.db.prepare(sql);
    const rows = (
      datasourceId ? stmt.all(datasourceId, limit) : stmt.all(limit)
    ) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: String(r.id),
      datasourceId: String(r.datasource_id),
      datasourceName: String(r.datasource_name),
      startedAt: Number(r.started_at),
      finishedAt: Number(r.finished_at),
      ok: Number(r.ok) === 1,
      serverVersion: String(r.server_version ?? ''),
      results: JSON.parse(String(r.results_json)) as InspectionReport['results']
    }));
  }

  dailySeries(datasourceId: string, days: number): InspectionTrend {
    const since = Date.now() - days * 86400_000;
    const rows = this.db
      .prepare(
        `SELECT date(started_at/1000,'unixepoch','localtime') AS date,
                COUNT(*) AS count,
                SUM(CASE WHEN ok = 0 THEN 1 ELSE 0 END) AS failures,
                AVG(finished_at - started_at) AS avgDurationMs
         FROM inspection_reports
         WHERE datasource_id = ? AND started_at >= ?
         GROUP BY date ORDER BY date`
      )
      .all(datasourceId, since) as Array<Record<string, unknown>>;
    const points: DailyPoint[] = rows.map((r) => ({
      date: String(r.date),
      count: Number(r.count),
      failures: Number(r.failures),
      avgDurationMs: Math.round(Number(r.avgDurationMs ?? 0))
    }));
    return { datasourceId, days: points };
  }

  countReportsInWindow(datasourceId: string, sinceMs: number): number {
    const row = this.db
      .prepare('SELECT COUNT(*) AS n FROM inspection_reports WHERE datasource_id = ? AND started_at >= ?')
      .get(datasourceId, sinceMs) as { n: number };
    return Number(row.n);
  }

  countCheckFailsInWindow(datasourceId: string, checkId: string, sinceMs: number): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS n FROM inspection_reports
         WHERE datasource_id = ? AND started_at >= ?
           AND EXISTS (SELECT 1 FROM json_each(inspection_reports.results_json) je
                       WHERE json_extract(je.value, '$.checkId') = ?
                         AND json_extract(je.value, '$.status') != 'ok')`
      )
      .get(datasourceId, sinceMs, checkId) as { n: number };
    return Number(row.n);
  }

  deleteForDatasource(datasourceId: string): void {
    this.db.prepare('DELETE FROM inspection_reports WHERE datasource_id = ?').run(datasourceId);
  }

  private prune(): void {
    const cutoff = Date.now() - RETENTION_DAYS * 86400_000;
    this.db.prepare('DELETE FROM inspection_reports WHERE started_at < ?').run(cutoff);
    this.db.exec(
      `DELETE FROM inspection_reports WHERE id IN (
         SELECT id FROM (
           SELECT id, ROW_NUMBER() OVER (PARTITION BY datasource_id ORDER BY started_at DESC) AS rn
           FROM inspection_reports
         ) WHERE rn > ${MAX_ROWS_PER_DATASOURCE}
       )`
    );
  }

  checkpoint(): void {
    this.db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.checkpoint();
    this.db.close();
  }
}

let store: InspectionStore | null = null;

export function initInspectionStore(dir: string): void {
  store?.close();
  store = new InspectionStore(dir);
}

export function getInspectionStore(): InspectionStore {
  if (!store) throw new Error('inspection store 未初始化');
  return store;
}

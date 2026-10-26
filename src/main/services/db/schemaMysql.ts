import type {
  DbDatabaseInfo,
  DbIndexInfo,
  DbObjectsResult,
  DbTableDetail,
  DbTableInfo
} from '../../../shared/types';
import type { DbAdapter } from './adapter';

const MAX_DATABASES = 200;
const MAX_TABLES = 500;

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

export function toIndexes(rows: Array<Record<string, unknown>>): DbIndexInfo[] {
  const map = new Map<string, DbIndexInfo>();
  for (const row of rows) {
    const name = text(row.index_name);
    if (!name) continue;
    const existing = map.get(name);
    const column = text(row.column_name);
    if (existing) {
      if (column) existing.columns.push(column);
      continue;
    }
    map.set(name, {
      name,
      unique: num(row.unique_flag) === 1,
      columns: column ? [column] : []
    });
  }
  return [...map.values()];
}

export async function mysqlDatabases(adapter: DbAdapter): Promise<DbObjectsResult> {
  const rows = await adapter.query<Record<string, unknown>>(
    `SELECT s.SCHEMA_NAME AS name,
            COUNT(t.TABLE_NAME) AS table_count,
            COALESCE(SUM(COALESCE(t.DATA_LENGTH, 0) + COALESCE(t.INDEX_LENGTH, 0)), 0) AS bytes
     FROM information_schema.SCHEMATA s
     LEFT JOIN information_schema.TABLES t ON t.TABLE_SCHEMA = s.SCHEMA_NAME
     WHERE s.SCHEMA_NAME NOT IN ('mysql', 'information_schema', 'performance_schema', 'sys')
     GROUP BY s.SCHEMA_NAME
     ORDER BY bytes DESC`
  );
  const databases: DbDatabaseInfo[] = rows.slice(0, MAX_DATABASES).map((row) => ({
    name: text(row.name),
    tableCount: num(row.table_count),
    totalBytes: num(row.bytes)
  }));
  return { level: 'databases', databases, truncated: rows.length > MAX_DATABASES };
}

export async function mysqlTables(adapter: DbAdapter, database: string): Promise<DbObjectsResult> {
  const rows = await adapter.query<Record<string, unknown>>(
    `SELECT TABLE_NAME AS tbl, IFNULL(ENGINE, '') AS engine,
            COALESCE(TABLE_ROWS, 0) AS rows_count,
            COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes,
            IFNULL(TABLE_COMMENT, '') AS comment
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ?
     ORDER BY bytes DESC`,
    [database]
  );
  const tables: DbTableInfo[] = rows.slice(0, MAX_TABLES).map((row) => ({
    database,
    name: text(row.tbl),
    engine: text(row.engine),
    rows: num(row.rows_count),
    totalBytes: num(row.bytes),
    comment: text(row.comment)
  }));
  return { level: 'tables', database, tables, truncated: rows.length > MAX_TABLES };
}

export async function mysqlTable(
  adapter: DbAdapter,
  database: string,
  table: string
): Promise<DbObjectsResult> {
  const columns = await adapter.query<Record<string, unknown>>(
    `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
            COLUMN_DEFAULT AS default_value, COLUMN_KEY AS key_name, EXTRA AS extra
     FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY ORDINAL_POSITION`,
    [database, table]
  );
  if (columns.length === 0) {
    throw new Error(`[INVALID] 表不存在或无访问权限: ${database}.${table}`);
  }
  const indexes = await adapter.query<Record<string, unknown>>(
    // MySQL 的 NON_UNIQUE 与 PG 的 indisunique 语义相反，统一成 1=唯一
    `SELECT INDEX_NAME AS index_name,
            CASE WHEN NON_UNIQUE = 0 THEN 1 ELSE 0 END AS unique_flag,
            COLUMN_NAME AS column_name, SEQ_IN_INDEX AS seq
     FROM information_schema.STATISTICS
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
     ORDER BY INDEX_NAME, SEQ_IN_INDEX`,
    [database, table]
  );
  const meta = await adapter.query<Record<string, unknown>>(
    `SELECT IFNULL(ENGINE, '') AS engine, COALESCE(TABLE_ROWS, 0) AS rows_count,
            COALESCE(DATA_LENGTH, 0) + COALESCE(INDEX_LENGTH, 0) AS bytes,
            IFNULL(TABLE_COMMENT, '') AS comment
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?`,
    [database, table]
  );
  const detail: DbTableDetail = {
    database,
    table,
    engine: text(meta[0]?.engine),
    rows: num(meta[0]?.rows_count),
    totalBytes: num(meta[0]?.bytes),
    comment: text(meta[0]?.comment),
    columns: columns.map((row) => ({
      name: text(row.name),
      type: text(row.type),
      nullable: text(row.nullable).toUpperCase() === 'YES',
      defaultValue: row.default_value === null || row.default_value === undefined
        ? null
        : String(row.default_value),
      key: text(row.key_name),
      extra: text(row.extra)
    })),
    indexes: toIndexes(indexes)
  };
  return { level: 'table', table: detail };
}

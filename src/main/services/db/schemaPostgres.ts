import type {
  DbDatabaseInfo,
  DbObjectsResult,
  DbTableDetail,
  DbTableInfo
} from '../../../shared/types';
import type { DbAdapter } from './adapter';
import { toIndexes } from './schemaMysql';

const MAX_DATABASES = 200;
const MAX_TABLES = 500;

function num(value: unknown): number {
  const n = Number(value ?? 0);
  return Number.isFinite(n) ? Math.round(n) : 0;
}

function text(value: unknown, fallback = ''): string {
  return value === null || value === undefined ? fallback : String(value);
}

export async function postgresDatabases(adapter: DbAdapter): Promise<DbObjectsResult> {
  const rows = await adapter.query<Record<string, unknown>>(
    `SELECT n.nspname AS name,
            COUNT(c.oid)::int AS table_count,
            COALESCE(SUM(pg_total_relation_size(c.oid)), 0)::bigint AS bytes
     FROM pg_namespace n
     LEFT JOIN pg_class c ON c.relnamespace = n.oid AND c.relkind = 'r'
     WHERE n.nspname NOT IN ('pg_catalog', 'information_schema', 'pg_toast')
     GROUP BY n.nspname
     ORDER BY bytes DESC`
  );
  const databases: DbDatabaseInfo[] = rows.slice(0, MAX_DATABASES).map((row) => ({
    name: text(row.name),
    tableCount: num(row.table_count),
    totalBytes: num(row.bytes)
  }));
  return { level: 'databases', databases, truncated: rows.length > MAX_DATABASES };
}

export async function postgresTables(
  adapter: DbAdapter,
  database: string
): Promise<DbObjectsResult> {
  const rows = await adapter.query<Record<string, unknown>>(
    `SELECT c.relname AS tbl, 'heap' AS engine,
            GREATEST(c.reltuples, 0)::bigint AS rows_count,
            pg_total_relation_size(c.oid)::bigint AS bytes,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind = 'r' AND n.nspname = $1
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

export async function postgresTable(
  adapter: DbAdapter,
  database: string,
  table: string
): Promise<DbObjectsResult> {
  const columns = await adapter.query<Record<string, unknown>>(
    `SELECT column_name AS name,
            CASE WHEN data_type = 'USER-DEFINED' THEN udt_name
                 WHEN character_maximum_length IS NOT NULL
                      THEN data_type || '(' || character_maximum_length || ')'
                 ELSE data_type END AS type,
            is_nullable AS nullable,
            column_default AS default_value
     FROM information_schema.columns
     WHERE table_schema = $1 AND table_name = $2
     ORDER BY ordinal_position`,
    [database, table]
  );
  if (columns.length === 0) {
    throw new Error(`[INVALID] 表不存在或无访问权限: ${database}.${table}`);
  }
  const primary = await adapter.query<Record<string, unknown>>(
    `SELECT kcu.column_name AS name
     FROM information_schema.table_constraints tc
     JOIN information_schema.key_column_usage kcu
       ON kcu.constraint_name = tc.constraint_name
      AND kcu.table_schema = tc.table_schema
      AND kcu.table_name = tc.table_name
     WHERE tc.constraint_type = 'PRIMARY KEY'
       AND tc.table_schema = $1 AND tc.table_name = $2`,
    [database, table]
  );
  const primaryKeys = new Set(primary.map((row) => text(row.name)));
  // 用 pg_get_indexdef(index, 列序号) 取列顺序：int2vector 的展开在各版本行为不一致，这里绕开
  const indexes = await adapter.query<Record<string, unknown>>(
    `SELECT i.relname AS index_name, ix.indisunique AS unique_flag,
            pg_get_indexdef(ix.indexrelid, k, true) AS column_name, k AS seq
     FROM pg_index ix
     JOIN pg_class i ON i.oid = ix.indexrelid
     JOIN pg_class t ON t.oid = ix.indrelid
     JOIN pg_namespace n ON n.oid = t.relnamespace
     JOIN LATERAL generate_series(1, ix.indnatts) AS k ON true
     WHERE n.nspname = $1 AND t.relname = $2
     ORDER BY i.relname, k`,
    [database, table]
  );
  const meta = await adapter.query<Record<string, unknown>>(
    `SELECT GREATEST(c.reltuples, 0)::bigint AS rows_count,
            pg_total_relation_size(c.oid)::bigint AS bytes,
            COALESCE(obj_description(c.oid, 'pg_class'), '') AS comment
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = $1 AND c.relname = $2 AND c.relkind = 'r'`,
    [database, table]
  );
  const detail: DbTableDetail = {
    database,
    table,
    engine: 'heap',
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
      key: primaryKeys.has(text(row.name)) ? 'PRI' : '',
      extra: ''
    })),
    indexes: toIndexes(indexes)
  };
  return { level: 'table', table: detail };
}

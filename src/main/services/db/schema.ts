import type { DbDialect, DbObjectsResult } from '../../../shared/types';
import type { DbAdapter } from './adapter';
import { mysqlDatabases, mysqlTable, mysqlTables } from './schemaMysql';
import { postgresDatabases, postgresTable, postgresTables } from './schemaPostgres';

/** 库名/表名只用于参数化查询，但仍拒绝空值、控制字符与超长输入 */
export function assertObjectName(value: string, label: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`[INVALID] ${label}不能为空`);
  if (trimmed.length > 128) throw new Error(`[INVALID] ${label}过长（>128）`);
  if (/[\u0000-\u001f]/.test(trimmed)) throw new Error(`[INVALID] ${label}包含控制字符`);
  return trimmed;
}

/** 三层对象浏览：库列表 → 表列表 → 表详情 */
export async function collectObjects(
  adapter: DbAdapter,
  type: DbDialect,
  database?: string,
  table?: string
): Promise<DbObjectsResult> {
  if (table && !database) {
    throw new Error('[INVALID] 查看表详情必须同时提供 database');
  }
  const db = database ? assertObjectName(database, '库名') : '';
  const tbl = table ? assertObjectName(table, '表名') : '';

  if (!db) {
    return type === 'mysql' ? mysqlDatabases(adapter) : postgresDatabases(adapter);
  }
  if (!tbl) {
    return type === 'mysql' ? mysqlTables(adapter, db) : postgresTables(adapter, db);
  }
  return type === 'mysql' ? mysqlTable(adapter, db, tbl) : postgresTable(adapter, db, tbl);
}

import type { DatasourceConfig } from '../../../shared/types';
import { DEFAULT_CONNECT_TIMEOUT_MS, type DbAdapter } from './adapter';
import { MySqlAdapter } from './mysql';
import { PostgresAdapter } from './postgres';

export async function createAdapter(ds: DatasourceConfig): Promise<DbAdapter> {
  const timeoutMs = Math.max(1_000, Math.min(60_000, ds.timeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS));
  if (ds.type === 'mysql') return MySqlAdapter.connect(ds, timeoutMs);
  if (ds.type === 'postgresql') return PostgresAdapter.connect(ds, timeoutMs);
  throw new Error(`不支持的数据库类型: ${ds.type}`);
}

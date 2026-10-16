import { Client } from 'pg';
import type { DatasourceConfig } from '../../../shared/types';
import type { DbAdapter } from './adapter';

interface VersionRow {
  server_version: string;
}

export class PostgresAdapter implements DbAdapter {
  private client: Client | null = null;

  private constructor(private readonly ds: DatasourceConfig) {}

  static async connect(ds: DatasourceConfig, timeoutMs: number): Promise<PostgresAdapter> {
    const adapter = new PostgresAdapter(ds);
    try {
      const client = new Client({
        host: ds.host,
        port: ds.port,
        user: ds.user,
        password: ds.password,
        database: ds.database || undefined,
        ssl: ds.ssl ? { rejectUnauthorized: false } : undefined,
        connectionTimeoutMillis: timeoutMs,
        statement_timeout: timeoutMs
      });
      await client.connect();
      adapter.client = client;
    } catch (err) {
      throw new Error(
        `PostgreSQL ${ds.host}:${ds.port} 连接失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return adapter;
  }

  async serverVersion(): Promise<string> {
    const rows = await this.query<VersionRow>('SHOW server_version');
    return rows[0]?.server_version ?? '';
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1');
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const client = this.client;
    if (!client) throw new Error(`PostgreSQL ${this.ds.host}:${this.ds.port} 连接已关闭`);
    try {
      const res =
        params && params.length > 0 ? await client.query(sql, params) : await client.query(sql);
      // pg 的 rows 为 any[]，此处为类型系统边界，统一转换
      return res.rows as T[];
    } catch (err) {
      throw new Error(
        `PostgreSQL ${this.ds.host}:${this.ds.port} 查询失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async destroy(): Promise<void> {
    const client = this.client;
    this.client = null;
    if (!client) return;
    try {
      await client.end();
    } catch {
      // 尽力释放：连接已失效时 end() 的报错可安全忽略
    }
  }
}

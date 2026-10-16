import mysql from 'mysql2/promise';
import type { DatasourceConfig } from '../../../shared/types';
import type { DbAdapter } from './adapter';

interface VersionRow {
  v: string;
}

export class MySqlAdapter implements DbAdapter {
  private conn: mysql.Connection | null = null;

  private constructor(
    private readonly ds: DatasourceConfig,
    private readonly timeoutMs: number
  ) {}

  static async connect(ds: DatasourceConfig, timeoutMs: number): Promise<MySqlAdapter> {
    const adapter = new MySqlAdapter(ds, timeoutMs);
    try {
      adapter.conn = await mysql.createConnection({
        host: ds.host,
        port: ds.port,
        user: ds.user,
        password: ds.password,
        database: ds.database || undefined,
        connectTimeout: timeoutMs,
        ssl: ds.ssl ? { rejectUnauthorized: false } : undefined,
        supportBigNumbers: true
      });
    } catch (err) {
      throw new Error(
        `MySQL ${ds.host}:${ds.port} 连接失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    return adapter;
  }

  async serverVersion(): Promise<string> {
    const rows = await this.query<VersionRow>('SELECT VERSION() AS v');
    return rows[0]?.v ?? '';
  }

  async ping(): Promise<void> {
    await this.query('SELECT 1');
  }

  async query<T>(sql: string, params?: unknown[]): Promise<T[]> {
    const conn = this.conn;
    if (!conn) throw new Error(`MySQL ${this.ds.host}:${this.ds.port} 连接已关闭`);
    try {
      const [rows] = await conn.query({ sql, values: params, timeout: this.timeoutMs });
      // 驱动返回的行无静态类型，此处为类型系统边界，统一转换
      return Array.isArray(rows) ? (rows as unknown as T[]) : [];
    } catch (err) {
      throw new Error(
        `MySQL ${this.ds.host}:${this.ds.port} 查询失败: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async destroy(): Promise<void> {
    const conn = this.conn;
    this.conn = null;
    if (!conn) return;
    try {
      await conn.end();
    } catch {
      // 尽力释放：连接已失效时 end() 的报错可安全忽略
    }
  }
}

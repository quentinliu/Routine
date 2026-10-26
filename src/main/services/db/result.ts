import type { DbCell, DbQueryResult } from '../../../shared/types';

/** 渲染层结果行上限：与既有 db.query 工具口径一致 */
export const MAX_RESULT_ROWS = 200;
/** 列数上限：避免畸形查询把表格撑爆 */
const MAX_RESULT_COLUMNS = 80;
const HEX_PREVIEW_BYTES = 32;

/**
 * 连接级错误识别：这类失败说明缓存的连接已不可用，需要清缓存重连。
 * 普通 SQL 错误（语法、权限、超时语句）不销毁连接。
 */
const CONNECTION_ERROR =
  /connection (?:is )?(?:closed|terminated|lost|reset)|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|server closed the connection|Connection terminated|Client has encountered a connection error|socket hang up|connection timeout/i;

export function isConnectionError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return CONNECTION_ERROR.test(msg);
}

export function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 单元格规范化：Date/Buffer/BigInt/对象都转成可渲染标量，避免 IPC 克隆与渲染异常 */
export function toCell(value: unknown): DbCell {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'bigint') return value.toString();
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, HEX_PREVIEW_BYTES).toString('hex');
    return value.length > HEX_PREVIEW_BYTES ? `0x${hex}…(${value.length}B)` : `0x${hex}`;
  }
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

/** 列名取所有行的键并集（保持首次出现顺序），行按列名取值 */
export function buildColumns(rows: Array<Record<string, unknown>>): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (seen.has(key)) continue;
      seen.add(key);
      columns.push(key);
      if (columns.length >= MAX_RESULT_COLUMNS) return columns;
    }
  }
  return columns;
}

export function buildQueryResult(
  sql: string,
  raw: Array<Record<string, unknown>>,
  durationMs: number
): DbQueryResult {
  const truncated = raw.length > MAX_RESULT_ROWS;
  const rows = truncated ? raw.slice(0, MAX_RESULT_ROWS) : raw;
  const columns = buildColumns(rows);
  return {
    sql,
    columns,
    rows: rows.map((row) => columns.map((col) => toCell(row[col]))),
    rowCount: rows.length,
    truncated,
    durationMs
  };
}

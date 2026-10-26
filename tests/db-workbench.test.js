'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  fmtBytes,
  fmtInt,
  fmtMs,
  fmtUptime,
  escapeIdent,
  previewSelectSql,
  diagnoseActions,
  overviewPrompt,
  queryPrompt,
  toUserError
} = require('../dist-main/renderer/lib/dbWorkbench.js');

test('格式化：字节、整数、运行时长、毫秒', () => {
  assert.strictEqual(fmtBytes(512), '512B');
  assert.strictEqual(fmtBytes(1536), '1.5KB');
  assert.strictEqual(fmtBytes(5 * 1024 * 1024), '5.0MB');
  assert.strictEqual(fmtBytes(undefined), '—');
  assert.strictEqual(fmtInt(1234567), '1,234,567');
  assert.strictEqual(fmtInt(999), '999');
  assert.strictEqual(fmtUptime(90061), '1天1小时');
  assert.strictEqual(fmtUptime(3660), '1小时1分');
  assert.strictEqual(fmtMs(1500), '1.50s');
  assert.strictEqual(fmtMs(12), '12ms');
});

test('标识符转义：方言引号、内嵌引号与查看数据 SQL', () => {
  assert.strictEqual(escapeIdent('order', 'mysql'), '`order`');
  assert.strictEqual(escapeIdent('a`b', 'mysql'), '`a``b`');
  assert.strictEqual(escapeIdent('order', 'postgresql'), '"order"');
  assert.strictEqual(escapeIdent('a"b', 'postgresql'), '"a""b"');
  assert.strictEqual(escapeIdent('a\u0000b', 'mysql'), '`ab`');
  assert.strictEqual(
    previewSelectSql('app', 'orders', 'postgresql'),
    'SELECT * FROM "app"."orders" LIMIT 100;'
  );
});

test('诊断目录：MySQL 六个技能，PostgreSQL 手册拆四个场景', () => {
  const mysql = diagnoseActions('mysql');
  assert.strictEqual(mysql.length, 6);
  assert.deepStrictEqual(
    mysql.map((a) => a.skill),
    [
      'mysql-slow-query-diagnose',
      'mysql-replication-lag-resolver',
      'mysql-capacity-early-warning',
      'mysql-deadlock-analyzer',
      'mysql-schema-linter',
      'mysql-batch-health-check'
    ]
  );
  const pg = diagnoseActions('postgresql');
  assert.strictEqual(pg.length, 4);
  assert.ok(pg.every((a) => a.skill === 'postgres'));

  const prompt = mysql[0].buildPrompt({ name: '订单库', id: 'ds-1', database: 'app' });
  assert.ok(prompt.includes('订单库'));
  assert.ok(prompt.includes('datasourceId=ds-1'));
  assert.ok(prompt.includes('mysql-slow-query-diagnose'));
  assert.ok(prompt.length < 1000);
});

function overview(overrides = {}) {
  return {
    datasourceId: 'ds-1',
    collectedAt: Date.now(),
    durationMs: 42,
    version: '8.0.36',
    uptimeSec: 90061,
    metrics: [
      { key: 'connections', label: '连接水位', display: '10/100', hint: '10.0% · 活跃 3', tone: 'ok', ratio: 10 }
    ],
    sessions: [
      {
        id: '1',
        user: 'root',
        host: '10.0.0.1',
        database: 'app',
        command: 'Query',
        state: 'executing',
        timeSec: 12,
        sql: 'SELECT 1'
      }
    ],
    slowQueries: [{ digest: 'SELECT * FROM orders', calls: 3, avgMs: 12.5, totalMs: 37.5 }],
    locks: { waiting: 0, longestWaitSec: 0 },
    replication: { role: 'none', hint: '未配置复制' },
    capacity: [{ database: 'app', table: 'orders', rows: 1000, totalBytes: 2048 }],
    unavailable: [{ key: 'slow-top', label: '慢查询 Top', reason: '权限不足' }],
    ...overrides
  };
}

test('概览草稿：包含数据源、指标、Top 与未获取维度', () => {
  const text = overviewPrompt({ name: '订单库', id: 'ds-1' }, overview());
  assert.ok(text.includes('订单库'));
  assert.ok(text.includes('datasourceId=ds-1'));
  assert.ok(text.includes('连接水位：10/100'));
  assert.ok(text.includes('慢查询 Top'));
  assert.ok(text.includes('未获取'));
  assert.ok(text.includes('权限不足'));
  assert.ok(text.length <= 6100);
});

test('概览草稿超长时截断，避免把整份结果灌进输入框', () => {
  const huge = overview({
    sessions: Array.from({ length: 40 }, (_, i) => ({
      id: String(i),
      user: 'root',
      host: 'h',
      database: 'app',
      command: 'Query',
      state: 'executing',
      timeSec: 1,
      sql: 'SELECT '.repeat(200)
    }))
  });
  const text = overviewPrompt({ name: '订单库', id: 'ds-1' }, huge);
  assert.ok(text.length < 6200);
  assert.ok(text.includes('已截断'));
});

test('查询草稿：保留 SQL 与结果表，仅取前 50 行', () => {
  const rows = Array.from({ length: 300 }, (_, i) => [i, `name-${i}`]);
  const text = queryPrompt(
    { name: '订单库', id: 'ds-1' },
    {
      sql: 'SELECT id, name FROM users',
      columns: ['id', 'name'],
      rows,
      rowCount: 300,
      truncated: true,
      durationMs: 18
    }
  );
  assert.ok(text.includes('SELECT id, name FROM users'));
  assert.ok(text.includes('已截断，仅前 200 行'));
  assert.ok(text.includes('name-49'));
  assert.ok(!text.includes('name-50'));
});

test('IPC 错误文案：按 [CODE] 分型并去掉 Electron 包装', () => {
  assert.strictEqual(
    toUserError(new Error("Error invoking remote method 'db:exec': Error: [E_DENIED] 已取消执行")),
    '已取消执行'
  );
  assert.strictEqual(
    toUserError(new Error("Error invoking remote method 'db:exec': Error: [E_TIMEOUT] 确认超时")),
    '确认超时（无人响应），未执行'
  );
  assert.strictEqual(
    toUserError(new Error("Error invoking remote method 'db:query': Error: [INVALID] SQL 不能为空")),
    'SQL 不能为空'
  );
  assert.strictEqual(
    toUserError(new Error("Error invoking remote method 'db:query': Error: boom")),
    'boom'
  );
});

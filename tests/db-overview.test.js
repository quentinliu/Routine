'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { collectOverview } = require('../dist-main/main/services/db/overview.js');
const { toIndexes } = require('../dist-main/main/services/db/schemaMysql.js');

function fakeAdapter(respond) {
  return {
    serverVersion: async () => '8.0.36',
    ping: async () => {},
    destroy: async () => {},
    query: async (sql) => respond(sql)
  };
}

function metric(overview, key) {
  return overview.metrics.find((m) => m.key === key);
}

function mysqlRespond(overrides = {}) {
  return async (sql) => {
    if (sql.includes('SHOW GLOBAL STATUS')) {
      if (overrides.status) throw new Error(overrides.status);
      return [
        { Variable_name: 'Uptime', Value: '1000' },
        { Variable_name: 'Questions', Value: '5000' },
        { Variable_name: 'Threads_connected', Value: '10' },
        { Variable_name: 'Threads_running', Value: '3' },
        { Variable_name: 'Innodb_buffer_pool_read_requests', Value: '1000' },
        { Variable_name: 'Innodb_buffer_pool_reads', Value: '10' },
        { Variable_name: 'Slow_queries', Value: '7' }
      ];
    }
    if (sql.includes('SHOW GLOBAL VARIABLES')) {
      return [{ Variable_name: 'max_connections', Value: '100' }];
    }
    if (sql.includes('PROCESSLIST')) {
      return [
        {
          id: 1,
          user: 'root',
          host: 'h',
          db: 'app',
          command: 'Query',
          state: 'executing',
          time_sec: 5,
          info: 'SELECT 1'
        }
      ];
    }
    if (sql.includes('events_statements_summary_by_digest')) {
      if (overrides.slow) throw new Error(overrides.slow);
      return [{ digest: 'SELECT * FROM t', calls: 3, avg_ms: 12.5, total_ms: 37.5 }];
    }
    if (sql.includes('data_lock_waits') || sql.includes('innodb_lock_waits')) {
      if (overrides.locks) throw new Error(overrides.locks);
      return [{ n: 2 }];
    }
    if (sql.includes('innodb_trx')) return [{ longest: 4 }];
    if (sql.includes('SHOW REPLICA STATUS')) return [];
    if (sql.includes('information_schema.TABLES')) {
      return [{ db: 'app', tbl: 'orders', rows_count: 100, bytes: 2048 }];
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
}

test('MySQL 概览：指标口径、锁等待与容量 Top', async () => {
  const data = await collectOverview(fakeAdapter(mysqlRespond()), 'mysql', '8.0.36');

  assert.strictEqual(data.version, '8.0.36');
  assert.strictEqual(data.uptimeSec, 1000);
  assert.deepStrictEqual(data.unavailable, []);
  assert.strictEqual(metric(data, 'connections').display, '10/100');
  assert.strictEqual(metric(data, 'connections').ratio, 10);
  assert.strictEqual(metric(data, 'connections').tone, 'ok');
  assert.strictEqual(metric(data, 'qps').display, '5.0/s');
  assert.strictEqual(metric(data, 'hit').display, '99.0%');
  assert.strictEqual(metric(data, 'active').display, '3');
  assert.strictEqual(metric(data, 'locks').display, '2');
  assert.strictEqual(metric(data, 'locks').tone, 'warn');
  assert.strictEqual(metric(data, 'locks').hint, '最长等待 4s');
  assert.strictEqual(metric(data, 'slow').display, '7');
  assert.strictEqual(data.sessions.length, 1);
  assert.strictEqual(data.sessions[0].timeSec, 5);
  assert.strictEqual(data.slowQueries[0].avgMs, 12.5);
  assert.strictEqual(data.replication.role, 'none');
  assert.strictEqual(data.capacity[0].totalBytes, 2048);
});

test('MySQL 单维度失败：只标记未获取，其余维度继续', async () => {
  const data = await collectOverview(
    fakeAdapter(mysqlRespond({ slow: '权限不足', locks: '缺少 PROCESS 权限' })),
    'mysql',
    '8.0.36'
  );

  const keys = data.unavailable.map((u) => u.key);
  assert.ok(keys.includes('slow-top'));
  assert.ok(keys.includes('locks'));
  assert.ok(data.unavailable.find((u) => u.key === 'slow-top').reason.includes('权限不足'));
  assert.strictEqual(metric(data, 'locks').display, '未获取');
  assert.strictEqual(metric(data, 'locks').tone, 'neutral');
  assert.strictEqual(metric(data, 'connections').display, '10/100');
});

test('MySQL 运行指标失败：连接/QPS/命中率/慢查询一并标未获取', async () => {
  const data = await collectOverview(
    fakeAdapter(mysqlRespond({ status: '拒绝访问' })),
    'mysql',
    '8.0.36'
  );
  assert.strictEqual(metric(data, 'connections').display, '未获取');
  assert.strictEqual(metric(data, 'qps').display, '未获取');
  assert.strictEqual(metric(data, 'hit').display, '未获取');
  assert.strictEqual(metric(data, 'slow').display, '未获取');
  assert.ok(data.unavailable.find((u) => u.key === 'status'));
});

function postgresRespond() {
  return async (sql) => {
    if (sql.includes('xact_commit')) {
      return [
        { total: 12, active: 2, uptime: 3600, xacts: 7200, hit: 999, read: 1, deadlocks: 3 }
      ];
    }
    if (sql.includes('pg_settings')) return [{ max: 100 }];
    if (sql.includes('pg_locks')) return [{ waiting: 0, longest: 0 }];
    if (sql.includes('pg_stat_replication')) return [];
    if (sql.includes('pg_is_in_recovery')) return [{ replica: false, lag: 0 }];
    if (sql.includes('pg_stat_statements')) {
      throw new Error('relation "pg_stat_statements" does not exist');
    }
    if (sql.includes('pg_stat_activity')) {
      return [
        {
          pid: 9,
          usename: 'app',
          client_addr: '10.0.0.2',
          datname: 'app',
          state: 'active',
          duration: 3,
          query: 'SELECT 1'
        }
      ];
    }
    if (sql.includes('pg_total_relation_size')) {
      return [{ db: 'public', tbl: 'orders', rows_count: 10, bytes: 1024 }];
    }
    throw new Error(`unexpected sql: ${sql}`);
  };
}

test('索引聚合：多列顺序与唯一标记（MySQL NON_UNIQUE 已反转）', () => {
  const indexes = toIndexes([
    { index_name: 'PRIMARY', unique_flag: 1, column_name: 'id', seq: 1 },
    { index_name: 'idx_a', unique_flag: 0, column_name: 'a', seq: 1 },
    { index_name: 'idx_a', unique_flag: 0, column_name: 'b', seq: 2 }
  ]);
  assert.deepStrictEqual(
    indexes.map((i) => [i.name, i.unique, i.columns]),
    [
      ['PRIMARY', true, ['id']],
      ['idx_a', false, ['a', 'b']]
    ]
  );
});

test('PostgreSQL 概览：事务口径 QPS、死锁累计、复制未配置与扩展缺失', async () => {
  const data = await collectOverview(fakeAdapter(postgresRespond()), 'postgresql', '16.2');

  assert.strictEqual(metric(data, 'qps').display, '2.0/s');
  assert.strictEqual(metric(data, 'hit').display, '99.9%');
  assert.strictEqual(metric(data, 'slow').label, '累计死锁');
  assert.strictEqual(metric(data, 'slow').display, '3');
  assert.strictEqual(data.replication.role, 'primary');
  assert.strictEqual(data.replication.hint, '未配置备库');
  assert.strictEqual(data.sessions[0].command, 'active');
  assert.ok(data.unavailable.find((u) => u.key === 'slow-top').reason.includes('pg_stat_statements'));
});

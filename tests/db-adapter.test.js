'use strict';
const test = require('node:test');
const assert = require('node:assert');
const net = require('node:net');

const { normalizeVersion, versionGte } = require('../dist-main/main/services/db/adapter.js');
const { createAdapter } = require('../dist-main/main/services/db/connection.js');

function ds(over = {}) {
  return {
    id: 'test-ds',
    name: '测试数据源',
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: 'x',
    enabled: true,
    ...over
  };
}

function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('normalizeVersion 解析常见版本串', () => {
  assert.deepStrictEqual(normalizeVersion('8.0.34'), [8, 0, 34]);
  assert.deepStrictEqual(normalizeVersion('5.7.44-log'), [5, 7, 44]);
  assert.deepStrictEqual(normalizeVersion('10.11.6-MariaDB-log'), [10, 11, 6]);
  assert.deepStrictEqual(normalizeVersion('15.2'), [15, 2]);
  assert.deepStrictEqual(normalizeVersion('16'), [16]);
  assert.deepStrictEqual(normalizeVersion('unknown'), []);
  assert.deepStrictEqual(normalizeVersion('  8.0.34  '), [8, 0, 34]);
});

test('versionGte 数值比较语义', () => {
  assert.strictEqual(versionGte([8, 0, 34], [5, 7]), true);
  assert.strictEqual(versionGte([5, 7], [5, 7]), true);
  assert.strictEqual(versionGte([5, 6], [5, 7]), false);
  assert.strictEqual(versionGte([15], [14, 9]), true);
  assert.strictEqual(versionGte([8], [8, 0, 1]), false);
  assert.strictEqual(versionGte([], [5, 7]), false);
  assert.strictEqual(versionGte([], []), true);
});

test('MySQL 不可达端口：错误信息含主机与原因', async () => {
  const port = await closedPort();
  await assert.rejects(
    createAdapter(ds({ port })),
    (err) => err.message.includes(`127.0.0.1:${port}`) && err.message.includes('连接失败')
  );
});

test('PostgreSQL 不可达端口：错误信息含主机与原因', async () => {
  const port = await closedPort();
  await assert.rejects(
    createAdapter(ds({ type: 'postgresql', port })),
    (err) => err.message.includes(`127.0.0.1:${port}`) && err.message.includes('连接失败')
  );
});

test('连接超时路径：不可路由地址按 timeoutMs 及时中止', async () => {
  const t0 = Date.now();
  await assert.rejects(
    createAdapter(ds({ host: '10.255.255.1', timeoutMs: 1500 })),
    (err) => err.message.includes('连接失败')
  );
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 10_000, `超时应及时触发，实际耗时 ${elapsed}ms`);
});

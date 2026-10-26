'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { buildStatusRows } = require('../dist-main/renderer/lib/dbStatus.js');

function ds(id, name, enabled = true) {
  return {
    id,
    name,
    type: 'mysql',
    host: '127.0.0.1',
    port: 3306,
    user: 'root',
    password: '',
    enabled
  };
}

test('排序：不可达在前、正常次之、停用最后，组内按名称', () => {
  const list = [
    ds('ok-b', 'beta-ok'),
    ds('down-b', 'beta-down'),
    ds('off', 'alpha-off', false),
    ds('ok-a', 'alpha-ok'),
    ds('down-a', 'alpha-down')
  ];
  const tests = new Map([
    ['ok-b', { ok: true, latencyMs: 5, version: '8.0.36' }],
    ['down-b', { ok: false, error: 'ECONNREFUSED' }],
    ['ok-a', { ok: true, latencyMs: 3, version: '8.0.36' }],
    ['down-a', { ok: false, error: 'timeout' }]
  ]);

  const rows = buildStatusRows(list, tests);

  assert.deepStrictEqual(
    rows.map((r) => `${r.health}:${r.ds.name}`),
    [
      'down:alpha-down',
      'down:beta-down',
      'ok:alpha-ok',
      'ok:beta-ok',
      'disabled:alpha-off'
    ]
  );
  assert.strictEqual(rows[0].error, 'timeout');
  assert.strictEqual(rows[2].version, '8.0.36');
  assert.strictEqual(rows[2].latencyMs, 3);
});

test('无探测结果的启用数据源标记为 probing 并置顶', () => {
  const list = [ds('a', '甲'), ds('b', '乙')];
  const tests = new Map([['b', { ok: true, latencyMs: 4 }]]);
  const rows = buildStatusRows(list, tests);
  assert.strictEqual(rows[0].health, 'probing');
  assert.strictEqual(rows[0].ds.id, 'a');
  assert.strictEqual(rows[1].health, 'ok');
});

test('停用数据源不参与探测，直接标记 disabled', () => {
  const list = [ds('a', '甲', false)];
  const rows = buildStatusRows(list, new Map());
  assert.strictEqual(rows[0].health, 'disabled');
  assert.strictEqual(rows[0].error, undefined);
});

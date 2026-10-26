'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  buildStatusRows,
  countCheckIssues
} = require('../dist-main/renderer/lib/dbStatus.js');

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

function report(id, statuses) {
  return {
    id,
    datasourceId: 'ds-x',
    datasourceName: 'x',
    startedAt: 1,
    finishedAt: 2,
    ok: !statuses.includes('error'),
    serverVersion: '8.0',
    results: statuses.map((status, i) => ({
      checkId: `c${i}`,
      title: `检查 ${i}`,
      status,
      detail: [],
      durationMs: 1
    }))
  };
}

test('排序：down 在前、issues 次之、ok 再次、disabled 最后，组内按名称', () => {
  const list = [
    ds('ok-b', 'beta-ok'),
    ds('down-b', 'beta-down'),
    ds('off', 'alpha-off', false),
    ds('issues', 'beta-warn'),
    ds('ok-a', 'alpha-ok'),
    ds('down-a', 'alpha-down')
  ];
  const tests = new Map([
    ['ok-b', { ok: true, latencyMs: 5 }],
    ['down-b', { ok: false, error: 'ECONNREFUSED' }],
    ['issues', { ok: true, latencyMs: 7 }],
    ['ok-a', { ok: true, latencyMs: 3 }],
    ['down-a', { ok: false, error: 'timeout' }]
  ]);
  const reports = new Map([['issues', report('r1', ['ok', 'warn', 'error'])]]);

  const rows = buildStatusRows(list, tests, reports);

  assert.deepStrictEqual(
    rows.map((r) => `${r.health}:${r.ds.name}`),
    [
      'down:alpha-down',
      'down:beta-down',
      'issues:beta-warn',
      'ok:alpha-ok',
      'ok:beta-ok',
      'disabled:alpha-off'
    ]
  );
  assert.strictEqual(rows[2].issueCount, 2);
});

test('无探测结果的启用数据源标记为 probing 并置顶', () => {
  const list = [ds('a', '甲'), ds('b', '乙')];
  const tests = new Map([['b', { ok: true, latencyMs: 4 }]]);
  const rows = buildStatusRows(list, tests, new Map());
  assert.strictEqual(rows[0].health, 'probing');
  assert.strictEqual(rows[0].ds.id, 'a');
  assert.strictEqual(rows[1].health, 'ok');
});

test('countCheckIssues 只统计 warn 与 error', () => {
  assert.strictEqual(countCheckIssues(report('r', ['ok', 'skipped']).results), 0);
  assert.strictEqual(countCheckIssues(report('r', ['ok', 'warn', 'error', 'skipped']).results), 2);
});

test('最近巡检无告警的可达数据源为 ok', () => {
  const list = [ds('a', '甲')];
  const tests = new Map([['a', { ok: true, latencyMs: 9 }]]);
  const reports = new Map([['a', report('r', ['ok', 'skipped'])]]);
  const rows = buildStatusRows(list, tests, reports);
  assert.strictEqual(rows[0].health, 'ok');
  assert.strictEqual(rows[0].latencyMs, 9);
});

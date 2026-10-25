'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

const {
  initInspectionStore,
  getInspectionStore
} = require('../dist-main/main/services/inspectionStore.js');

const OK_CHECK = {
  checkId: 'connectivity',
  title: '连通性',
  status: 'ok',
  value: '8.0.36',
  detail: [],
  durationMs: 5
};

function report(overrides = {}) {
  const startedAt = overrides.startedAt ?? Date.now();
  return {
    id: overrides.id ?? randomUUID(),
    datasourceId: 'ds1',
    datasourceName: '生产库',
    startedAt,
    finishedAt: startedAt + 100,
    ok: overrides.ok ?? true,
    serverVersion: '8.0.36',
    results: overrides.results ?? [OK_CHECK]
  };
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-inspections-'));
  initInspectionStore(dir);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('inspection-store：追加与倒序列表', () => {
  withTmp(() => {
    const s = getInspectionStore();
    const first = report();
    s.appendReport(first);
    s.appendReport(report());
    const all = s.listReports();
    assert.strictEqual(all.length, 2);
    assert.notStrictEqual(all[0].id, first.id);
    assert.strictEqual(all[0].ok, true);
    assert.strictEqual(all[0].results[0].checkId, 'connectivity');
    const filtered = s.listReports('ds1');
    assert.strictEqual(filtered.length, 2);
    assert.strictEqual(s.listReports('other').length, 0);
  });
});

test('inspection-store：旧 inspections.json 迁移且改名、重复初始化幂等', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-inspections-mig-'));
  const legacy = [report({ id: 'legacy-1' }), report({ id: 'legacy-2', ok: false })];
  fs.writeFileSync(path.join(dir, 'inspections.json'), JSON.stringify(legacy));
  initInspectionStore(dir);
  try {
    assert.strictEqual(getInspectionStore().listReports().length, 2);
    assert.ok(fs.existsSync(path.join(dir, 'inspections.json.migrated')));
    assert.ok(!fs.existsSync(path.join(dir, 'inspections.json')));
    initInspectionStore(dir);
    assert.strictEqual(getInspectionStore().listReports().length, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('inspection-store：按日聚合与检查项失败计数', () => {
  withTmp(() => {
    const s = getInspectionStore();
    s.appendReport(report());
    s.appendReport(
      report({
        results: [
          OK_CHECK,
          {
            checkId: 'connection-watermark',
            title: '连接水位',
            status: 'warn',
            value: '9/10',
            detail: [],
            durationMs: 3
          }
        ]
      })
    );
    const trend = s.dailySeries('ds1', 30);
    assert.strictEqual(trend.datasourceId, 'ds1');
    assert.strictEqual(trend.days.length, 1);
    assert.strictEqual(trend.days[0].count, 2);
    assert.strictEqual(trend.days[0].failures, 0);
    const since = Date.now() - 7 * 86400_000;
    assert.strictEqual(s.countReportsInWindow('ds1', since), 2);
    assert.strictEqual(s.countCheckFailsInWindow('ds1', 'connection-watermark', since), 1);
    assert.strictEqual(s.countCheckFailsInWindow('ds1', 'connectivity', since), 0);
  });
});

test('inspection-store：超期报告按留存窗口清理', () => {
  withTmp(() => {
    const s = getInspectionStore();
    const stale = report({ startedAt: Date.now() - 366 * 86400_000 });
    s.appendReport(stale);
    s.appendReport(report());
    const all = s.listReports();
    assert.strictEqual(all.length, 1);
    assert.notStrictEqual(all[0].id, stale.id);
  });
});

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

test('inspection-store：检查项通过率聚合与末次状态', () => {
  withTmp(() => {
    const s = getInspectionStore();
    const day = 86400_000;
    s.appendReport(
      report({
        startedAt: Date.now() - 2 * day,
        results: [
          OK_CHECK,
          {
            checkId: 'connection-watermark',
            title: '连接水位',
            status: 'warn',
            detail: [],
            durationMs: 3
          }
        ]
      })
    );
    s.appendReport(
      report({
        startedAt: Date.now() - day,
        results: [
          OK_CHECK,
          {
            checkId: 'connection-watermark',
            title: '连接水位',
            status: 'error',
            detail: [],
            durationMs: 3
          }
        ]
      })
    );
    // 最新一次巡检未包含 connection-watermark：末次状态应沿用最近一次包含该项的报告
    s.appendReport(report({ startedAt: Date.now() - 60_000 }));
    // 窗口外报告不计入聚合
    s.appendReport(
      report({
        startedAt: Date.now() - 40 * day,
        results: [
          { checkId: 'legacy-check', title: '旧检查', status: 'error', detail: [], durationMs: 1 }
        ]
      })
    );

    const rows = s.checkTrend('ds1', 30);
    assert.deepStrictEqual(
      rows.map((r) => r.checkId),
      ['connection-watermark', 'connectivity']
    );
    assert.strictEqual(rows[0].total, 2);
    assert.strictEqual(rows[0].fails, 2);
    assert.strictEqual(rows[0].skipped, 0);
    assert.strictEqual(rows[0].recentFails7d, 2);
    assert.strictEqual(rows[0].lastStatus, 'error');
    assert.strictEqual(rows[1].total, 3);
    assert.strictEqual(rows[1].fails, 0);
    assert.strictEqual(rows[1].recentFails7d, 0);
    assert.strictEqual(rows[1].lastStatus, 'ok');
    assert.ok(!rows.some((r) => r.checkId === 'legacy-check'));
  });
});

test('inspection-store：skipped 不计入失败，recentFails7d 独立统计', () => {
  withTmp(() => {
    const s = getInspectionStore();
    s.appendReport(
      report({
        results: [
          OK_CHECK,
          {
            checkId: 'version-support',
            title: '版本支持',
            status: 'skipped',
            detail: [],
            durationMs: 1
          }
        ]
      })
    );
    s.appendReport(
      report({
        startedAt: Date.now() - 8 * 86400_000,
        results: [
          {
            checkId: 'connection-watermark',
            title: '连接水位',
            status: 'warn',
            detail: [],
            durationMs: 2
          }
        ]
      })
    );

    const rows = s.checkTrend('ds1', 30);
    const skipped = rows.find((r) => r.checkId === 'version-support');
    assert.strictEqual(skipped.total, 1);
    assert.strictEqual(skipped.fails, 0);
    assert.strictEqual(skipped.skipped, 1);
    assert.strictEqual(skipped.lastStatus, 'skipped');

    const oldFail = rows.find((r) => r.checkId === 'connection-watermark');
    assert.strictEqual(oldFail.total, 1);
    assert.strictEqual(oldFail.fails, 1);
    assert.strictEqual(oldFail.recentFails7d, 0);
  });
});

test('inspection-store：单检查项逐日序列', () => {
  withTmp(() => {
    const s = getInspectionStore();
    const day = 86400_000;
    const noon = new Date();
    noon.setHours(12, 0, 0, 0);
    const check = {
      checkId: 'connection-watermark',
      title: '连接水位',
      detail: [],
      durationMs: 1
    };
    s.appendReport(
      report({ startedAt: noon.getTime() - 2 * day, results: [{ ...check, status: 'ok' }] })
    );
    s.appendReport(
      report({ startedAt: noon.getTime() - day, results: [{ ...check, status: 'warn' }] })
    );
    s.appendReport(
      report({
        startedAt: noon.getTime() - day + 3600_000,
        results: [{ ...check, status: 'error' }]
      })
    );

    const series = s.checkSeries('ds1', 'connection-watermark', 30);
    assert.strictEqual(series.length, 2);
    assert.deepStrictEqual(series.map((p) => p.total), [1, 2]);
    assert.deepStrictEqual(series.map((p) => p.fails), [0, 2]);
  });
});

test('inspection-store：报告列表分页 limit/before', () => {
  withTmp(() => {
    const s = getInspectionStore();
    const base = Date.now();
    for (let i = 0; i < 3; i++) s.appendReport(report({ startedAt: base - i * 1000 }));

    const first = s.listReports('ds1', 2);
    assert.strictEqual(first.length, 2);
    assert.ok(first[0].startedAt > first[1].startedAt);

    const second = s.listReports('ds1', 2, first[1].startedAt);
    assert.strictEqual(second.length, 1);
    assert.ok(second[0].startedAt < first[1].startedAt);
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

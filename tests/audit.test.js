'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initAudit, getAuditLog } = require('../dist-main/main/services/audit.js');

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-audit-'));
  initAudit(dir);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('audit：记录、结果回写与幂等终结', () => {
  withTmp(() => {
    const log = getAuditLog();
    log.record({
      id: 'r1',
      ts: Date.now(),
      agent: 'main',
      tool: 'computer.exec',
      summary: '清空废纸篓',
      risk: 'high',
      outcome: 'pending'
    });
    assert.strictEqual(log.list().length, 1);
    assert.strictEqual(log.list()[0].outcome, 'pending');
    log.resolve('r1', 'approved');
    assert.strictEqual(log.list()[0].outcome, 'approved');
    assert.ok(typeof log.list()[0].resolvedAt === 'number');
    log.resolve('r1', 'denied');
    assert.strictEqual(log.list()[0].outcome, 'approved');
    log.resolve('unknown', 'denied');
    assert.strictEqual(log.list().length, 1);
  });
});

test('audit：环形上限 500 条且最新在前', () => {
  withTmp(() => {
    const log = getAuditLog();
    for (let i = 0; i < 505; i++) {
      log.record({
        id: `r${i}`,
        ts: i,
        agent: 'main',
        tool: 'ssh.exec',
        summary: `cmd ${i}`,
        risk: 'medium',
        outcome: 'pending'
      });
    }
    const all = log.list();
    assert.strictEqual(all.length, 500);
    assert.strictEqual(all[0].id, 'r504');
  });
});

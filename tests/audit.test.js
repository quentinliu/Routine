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

test('audit：审批内容与任务 id 落盘，取消也留痕', () => {
  withTmp(() => {
    const log = getAuditLog();
    log.record({
      id: 'r-cmd',
      ts: Date.now(),
      agent: 'ssh',
      tool: 'ssh.exec',
      summary: '在远程主机「192.168.1.2」（root@192.168.1.2）执行命令',
      risk: 'medium',
      outcome: 'pending',
      detail: '在远程主机「192.168.1.2」执行命令\n命令: rm -rf /tmp/demo',
      msgId: 'msg-1'
    });
    const [entry] = log.list();
    assert.match(entry.detail, /rm -rf \/tmp\/demo/, '审计必须能还原具体命令');
    assert.strictEqual(entry.msgId, 'msg-1', '审计条目应能关联回会话日志');

    log.resolve('r-cmd', 'canceled');
    assert.strictEqual(log.list()[0].outcome, 'canceled');
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

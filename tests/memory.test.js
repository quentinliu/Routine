'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  initMemory,
  getMemoryStore,
  MEMORY_LIMITS
} = require('../dist-main/main/services/memory.js');

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-memory-'));
  initMemory(dir);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('memory：空加载、追加、保存回读与清空', () => {
  withTmp(() => {
    const m = getMemoryStore();
    assert.strictEqual(m.load(), '');
    m.append('用户偏好深色主题');
    assert.ok(m.load().includes('- 用户偏好深色主题'));
    m.save('# MEMORY\n- 手动条目');
    assert.ok(m.load().startsWith('# MEMORY'));
    m.clear();
    assert.strictEqual(m.load(), '');
  });
});

test('memory：单条与总量上限钳制', () => {
  withTmp(() => {
    const m = getMemoryStore();
    assert.throws(() => m.append('x'.repeat(MEMORY_LIMITS.MAX_ENTRY + 1)), /单条记忆/);
    assert.throws(() => m.save('x'.repeat(MEMORY_LIMITS.MAX_TOTAL + 1)), /超过上限/);
    m.save('x'.repeat(MEMORY_LIMITS.MAX_TOTAL - 1));
    assert.throws(() => m.append('超出'), /超过上限/);
  });
});

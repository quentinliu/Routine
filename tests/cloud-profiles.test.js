'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStorage, getStorage } = require('../dist-main/main/services/storage.js');

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-cloud-profiles-'));
  initStorage(dir);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeSettingsFile(dir, settings) {
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify(settings));
}

test('storage：旧单配置 cloud 迁移为 cloudProfiles 单条，字段完整保留', () => {
  return withTmp((dir) => {
    writeSettingsFile(dir, {
      cloud: {
        baseURL: 'https://api.deepseek.com/v1',
        apiKey: 'sk-legacy',
        model: 'deepseek-chat'
      }
    });
    const s = getStorage().loadSettings();
    assert.strictEqual(s.cloudProfiles.length, 1);
    const p = s.cloudProfiles[0];
    assert.strictEqual(p.baseURL, 'https://api.deepseek.com/v1');
    assert.strictEqual(p.apiKey, 'sk-legacy');
    assert.strictEqual(p.model, 'deepseek-chat');
    assert.strictEqual(p.label, 'deepseek-chat');
    assert.ok(p.id.length > 0);
    assert.strictEqual(s.activeCloudId, p.id);
  });
});

test('storage：无 cloud 无 cloudProfiles 时回落默认档案', () => {
  return withTmp((dir) => {
    writeSettingsFile(dir, {});
    const s = getStorage().loadSettings();
    assert.strictEqual(s.cloudProfiles.length, 1);
    assert.strictEqual(s.cloudProfiles[0].baseURL, 'https://open.bigmodel.cn/api/paas/v4');
    assert.strictEqual(s.activeCloudId, s.cloudProfiles[0].id);
  });
});

test('storage：已有 cloudProfiles 原样保留，activeCloudId 失效归一为首条', () => {
  return withTmp((dir) => {
    const profiles = [
      { id: 'a', label: 'A', baseURL: 'https://a.example', apiKey: 'k1', model: 'm1' },
      { id: 'b', label: 'B', baseURL: 'https://b.example', apiKey: 'k2', model: 'm2' }
    ];
    writeSettingsFile(dir, { cloudProfiles: profiles, activeCloudId: 'gone' });
    const s = getStorage().loadSettings();
    assert.deepStrictEqual(s.cloudProfiles, profiles);
    assert.strictEqual(s.activeCloudId, 'a');

    writeSettingsFile(dir, { cloudProfiles: profiles, activeCloudId: 'b' });
    assert.strictEqual(getStorage().loadSettings().activeCloudId, 'b');
  });
});

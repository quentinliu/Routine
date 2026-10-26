'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStorage, getStorage } = require('../dist-main/main/services/storage.js');
const { createDbTools } = require('../dist-main/main/agent/tools/builtin/db.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routine-db-prompt-'));
}

function dbListTool() {
  return createDbTools().find((t) => t.name === 'db.list');
}

test('promptContext 注入数据源清单（含 id 与启用态），且不含凭据', () => {
  initStorage(tmpDir());
  getStorage().saveDatasources([
    {
      id: 'ds-mysql-1',
      name: 'mysql192.168.1.2',
      type: 'mysql',
      host: '192.168.1.2',
      port: 3306,
      user: 'routine',
      password: 'enc:SECRET',
      database: 'app',
      enabled: true
    },
    {
      id: 'ds-pg-1',
      name: 'pg192.168.1.2',
      type: 'postgresql',
      host: '192.168.1.2',
      port: 5432,
      user: 'postgres',
      password: 'enc:SECRET2',
      ssl: false,
      enabled: false
    }
  ]);

  const block = dbListTool().promptContext();

  assert.ok(block.includes('数据库数据源清单'));
  assert.ok(block.includes('id=ds-mysql-1'));
  assert.ok(block.includes('mysql192.168.1.2'));
  assert.ok(block.includes('[mysql]'));
  assert.ok(block.includes('/app'));
  assert.ok(block.includes('（已禁用，db.query 不可用）'));
  assert.ok(!block.includes('enc:SECRET'));
  assert.ok(!block.includes('password'));
});

test('db 工具守则：先基础巡检、同轮并行只读查询、排除系统库、0 行先复核', () => {
  const text = dbListTool().promptSection.text;
  assert.ok(text.includes('inspection.run'), '应先跑基础巡检再补维度');
  assert.ok(text.includes('actions 并行提交'), '应允许同类只读查询并行');
  assert.ok(text.includes('排除系统库'), '清单/容量查询需排除系统库');
  assert.ok(text.includes('SHOW DATABASES 复核'), '0 行结果需复核');
});

test('未配置任何数据源时输出明确的空态块（防止模型臆断）', () => {
  initStorage(tmpDir());
  const block = dbListTool().promptContext();
  assert.ok(block.includes('尚未配置任何数据源'));
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Orchestrator } = require('../dist-main/main/agent/orchestrator.js');
const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { initStorage } = require('../dist-main/main/services/storage.js');
const { initMemory } = require('../dist-main/main/services/memory.js');
const {
  initConversationLog,
  getConversationLog
} = require('../dist-main/main/services/conversationLog.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routine-log-scope-'));
}

/** 基础设施发播点必须显式打上 scope:'infra'，否则会被执行日志面板过滤掉 */
test('基础设施日志发播点带 scope: infra', () => {
  const ipcSrc = fs.readFileSync('src/main/ipc.ts', 'utf-8');
  const schedulerSrc = fs.readFileSync('src/main/services/scheduler.ts', 'utf-8');
  assert.strictEqual(
    (ipcSrc.match(/scope: 'infra'/g) ?? []).length,
    2,
    '浏览器与 MCP 两个发播点应标记 infra'
  );
  assert.strictEqual(
    (schedulerSrc.match(/scope: 'infra'/g) ?? []).length,
    4,
    '定时调度四处 emitLog 应全部标记 infra'
  );
});

function setup() {
  const dir = tmpDir();
  initStorage(dir);
  initMemory(dir);
  initConversationLog(path.join(dir, 'logs'));
  const registry = new ToolRegistry(new SafetyGate());
  return { dir, registry };
}

function makeOrch(registry, provider) {
  return new Orchestrator({
    router: {
      settings: { providerMode: 'local', agent: { maxSteps: 4 } },
      getActive: async () => provider
    },
    safety: new SafetyGate(),
    registry
  });
}

test('任务内事件不再写执行日志：info 落对话日志，思考进执行过程', async () => {
  const { dir, registry } = setup();
  try {
    const provider = {
      id: 'fake:scope',
      chatStream: async () => ({
        content: '{"thought":"先想一下","action":null,"final":"好的"}',
        finishReason: 'stop'
      })
    };
    const orch = makeOrch(registry, provider);
    const events = [];
    const final = await orch.handleUserMessage('s1', '你好', (e) => events.push(e));
    assert.strictEqual(final, '好的');

    assert.ok(
      !events.some((e) => e.type === 'log'),
      '任务内事件不得进基础设施执行日志'
    );

    const view = getConversationLog().read(getConversationLog().list()[0].id);
    assert.ok(
      view.lines.some((l) => l.type === 'event' && String(l.text).includes('收到任务')),
      '任务起始事件应落对话日志'
    );
    assert.ok(view.lines.some((l) => l.type === 'final'), '最终回答仍应落盘');
    assert.strictEqual(view.lines.filter((l) => l.type === 'round').length, 1);
    assert.ok(String(view.lines[0].system).length > 0, 'system 应可被 read 物化出来');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('任务失败：notice 告警与对话日志 error 行双侧可见', async () => {
  const { dir, registry } = setup();
  try {
    const provider = {
      id: 'fake:fail',
      chatStream: async () => {
        throw new Error('上游接口 500');
      }
    };
    const orch = makeOrch(registry, provider);
    const events = [];
    await assert.rejects(() => orch.handleUserMessage('s2', '跑一下', (e) => events.push(e)));

    assert.ok(
      events.some(
        (e) =>
          e.type === 'trace' &&
          e.event.phase === 'notice' &&
          e.event.error === true &&
          String(e.event.notice).includes('任务失败')
      ),
      '失败应作为 notice 进入执行过程'
    );
    assert.ok(!events.some((e) => e.type === 'log'), '失败也不得写基础设施日志');

    const view = getConversationLog().read(getConversationLog().list()[0].id);
    const errLine = view.lines.find((l) => l.type === 'error');
    assert.ok(errLine, '对话日志应有 error 行');
    assert.match(String(errLine.text), /任务失败/);
    assert.match(String(errLine.text), /上游接口 500/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('任务中止：执行过程与对话日志同时留痕（不再单边缺失）', async () => {
  const { dir, registry } = setup();
  try {
    let orch;
    const provider = {
      id: 'fake:abort',
      chatStream: async () => {
        orch.abort();
        return { content: '{"thought":"被打断","action":null,"final":"不会采纳"}', finishReason: 'stop' };
      }
    };
    orch = makeOrch(registry, provider);
    const events = [];
    const final = await orch.handleUserMessage('s3', '长任务', (e) => events.push(e));
    assert.strictEqual(final, '');

    assert.ok(
      events.some(
        (e) =>
          e.type === 'trace' &&
          e.event.phase === 'notice' &&
          String(e.event.notice).includes('任务已被用户中止')
      ),
      '中止应在执行过程可见'
    );
    const view = getConversationLog().read(getConversationLog().list()[0].id);
    assert.ok(
      view.lines.some((l) => l.type === 'event' && String(l.text).includes('任务已被用户中止')),
      '中止也应落对话日志'
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

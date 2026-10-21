'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { createFileTools } = require('../dist-main/main/agent/tools/builtin/file.js');
const { createComputerTools } = require('../dist-main/main/agent/tools/builtin/computer.js');
const { createWebTools } = require('../dist-main/main/agent/tools/builtin/web.js');
const { createBrowserTools } = require('../dist-main/main/agent/tools/builtin/browser.js');
const { createSshTools } = require('../dist-main/main/agent/tools/builtin/ssh.js');
const { createTodoTools } = require('../dist-main/main/agent/tools/builtin/todo.js');
const { initStorage } = require('../dist-main/main/services/storage.js');

function makeCtx(events) {
  return {
    emit: (e) => events.push(e),
    status: (state, detail) =>
      events.push({ type: 'agent-status', status: { agent: 'test', state, detail } }),
    log: (text, level) => events.push({ type: 'log', entry: { text, level } })
  };
}

function makeRegistry(over = {}) {
  const gate = new SafetyGate();
  const registry = new ToolRegistry(gate);
  const fileAgent = over.fileAgent ?? {
    searchFiles: async (q, limit) => ({ q, limit, hit: true }),
    readFile: async () => {
      throw new Error('not implemented');
    }
  };
  const computer = over.computer ?? {
    snapshot: async () => ({}),
    execWhitelisted: async (op, args) => ({ op, args, ran: true }),
    listOps: () => []
  };
  const web = over.web ?? { search: async () => [] };
  const browser = over.browser ?? { run: async () => ({}) };
  const ssh = over.ssh ?? {
    listHosts: () => [],
    exec: async () => {
      throw new Error('not implemented');
    }
  };
  registry.register(...createFileTools(fileAgent));
  registry.register(...createComputerTools(computer));
  registry.register(...createWebTools(web));
  registry.register(...createBrowserTools(browser));
  registry.register(...createSshTools(ssh));
  return { gate, registry, fileAgent, computer, ssh };
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-tool-registry-'));
  initStorage(dir);
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('safe 工具直接执行，不触发安全确认', async () => {
  await withTmp(async () => {
    const { registry, fileAgent } = makeRegistry();
    const events = [];
    const result = await registry.execute(
      'file.search',
      { query: '报告' },
      makeCtx(events)
    );
    assert.deepStrictEqual(result, { q: '报告', limit: 20, hit: true });
    assert.ok(!events.some((e) => e.type === 'safety'), 'safe 工具不应产生安全事件');
  });
});

test('computer.exec 按 op 分级：safe 直接执行，medium 需确认后执行', async () => {
  await withTmp(async () => {
    const { registry, gate, computer } = makeRegistry();
    const events = [];

    const safe = await registry.execute(
      'computer.exec',
      { op: 'set-volume', args: { volume: 30 } },
      makeCtx(events)
    );
    assert.strictEqual(safe.ran, true);
    assert.ok(!events.some((e) => e.type === 'safety'), 'safe op 不应触发确认');

    const pending = registry.execute(
      'computer.exec',
      { op: 'toggle-dark-mode', args: {} },
      makeCtx(events)
    );
    await new Promise((r) => setTimeout(r, 10));
    const safetyEv = events.find((e) => e.type === 'safety');
    assert.ok(safetyEv, 'medium op 应产生安全确认请求');
    assert.strictEqual(safetyEv.request.riskLevel, 'medium');
    assert.ok(
      events.some(
        (e) => e.type === 'log' && e.entry.text.includes('高风险操作 toggle-dark-mode 等待用户确认')
      )
    );
    gate.resolveApproval(safetyEv.request.id, true);
    const done = await pending;
    assert.strictEqual(done.op, 'toggle-dark-mode');
  });
});

test('computer.exec high op 被拒绝时不执行且抛出拒绝错误', async () => {
  await withTmp(async () => {
    const { registry, gate, computer } = makeRegistry();
    const events = [];
    let called = 0;
    const spy = { ...computer, execWhitelisted: async (...a) => { called++; return computer.execWhitelisted(...a); } };
    const reg2 = new ToolRegistry(gate);
    reg2.register(...createFileTools({ searchFiles: async () => [], readFile: async () => ({}) }));
    reg2.register(...createComputerTools(spy));
    reg2.register(...createWebTools({ search: async () => [] }));
    reg2.register(...createBrowserTools({ run: async () => ({}) }));
    reg2.register(...createSshTools({ listHosts: () => [], exec: async () => ({}) }));

    const pending = reg2.execute('computer.exec', { op: 'empty-trash', args: {} }, makeCtx(events));
    await new Promise((r) => setTimeout(r, 10));
    const safetyEv = events.find((e) => e.type === 'safety');
    assert.strictEqual(safetyEv.request.riskLevel, 'high');
    assert.ok(safetyEv.request.plan.some((l) => l.includes('该操作不可逆')));
    gate.resolveApproval(safetyEv.request.id, false);

    await assert.rejects(pending, /用户拒绝执行该操作: empty-trash/);
    assert.strictEqual(called, 0, '被拒绝后不得调用服务');
    assert.ok(
      events.some((e) => e.type === 'agent-status' && e.status.detail === '用户已拒绝: empty-trash')
    );
  });
});

test('未知工具抛错', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    await assert.rejects(
      registry.execute('no.such', {}, makeCtx([])),
      /未知工具: no\.such/
    );
  });
});

test('ssh.exec 主机解析失败在审批前抛出，不弹确认', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry({
      ssh: { listHosts: () => [], exec: async () => ({}) }
    });
    const events = [];
    await assert.rejects(
      registry.execute('ssh.exec', { host: '不存在', command: 'ls' }, makeCtx(events)),
      /尚未配置任何 SSH 主机/
    );
    assert.ok(!events.some((e) => e.type === 'safety'), '解析失败不应进入审批流');
  });
});

test('agents() 去重且按注册顺序', () => {
  return withTmp(() => {
    const { registry } = makeRegistry();
    assert.deepStrictEqual(registry.agents(), ['file', 'computer', 'search', 'browser', 'ssh']);
  });
});

test('ssh 工具的 promptContext 注入主机清单', () => {
  return withTmp(() => {
    const svc = {
      listHosts: () => [
        {
          id: 'id-1',
          name: '生产服务器',
          host: '10.1.1.1',
          port: 22,
          user: 'root',
          enabled: true
        }
      ],
      exec: async () => ({})
    };
    const { registry } = makeRegistry({ ssh: svc });
    const blocks = registry.all().map((d) => d.promptContext?.() ?? '').filter(Boolean);
    assert.strictEqual(blocks.length, 1);
    assert.ok(blocks[0].includes('生产服务器'));
    assert.ok(blocks[0].includes('root@10.1.1.1:22'));
  });
});

test('todo.write 合法更新：推送 todo 事件并返回极短确认', () => {
  return withTmp(() => {
    const gate = new SafetyGate();
    const registry = new ToolRegistry(gate);
    registry.register(...createTodoTools());
    const events = [];
    const result = registry.execute(
      'todo.write',
      {
        todos: [
          { content: '第一步', status: 'completed' },
          { content: '第二步', status: 'in_progress' },
          { content: '第三步', status: 'pending' }
        ]
      },
      makeCtx(events)
    );
    return result.then((r) => {
      assert.strictEqual(r, '已更新 3 项子任务');
      const todoEv = events.find((e) => e.type === 'todo');
      assert.ok(todoEv, '应发出 todo 事件');
      assert.deepStrictEqual(todoEv.todos[0], { content: '第一步', status: 'completed' });
      assert.strictEqual(todoEv.todos.length, 3);
    });
  });
});

test('todo.write 拒绝空清单、非法状态与超量', () => {
  return withTmp(() => {
    const gate = new SafetyGate();
    const registry = new ToolRegistry(gate);
    registry.register(...createTodoTools());
    const ctx = makeCtx([]);
    return Promise.all([
      assert.rejects(registry.execute('todo.write', { todos: [] }, ctx), /不能为空/),
      assert.rejects(
        registry.execute('todo.write', { todos: [{ content: 'x', status: 'doing' }] }, ctx),
        /status 无效/
      ),
      assert.rejects(
        registry.execute('todo.write', { todos: [{ content: '  ', status: 'pending' }] }, ctx),
        /content 不能为空/
      ),
      assert.rejects(
        registry.execute(
          'todo.write',
          { todos: Array.from({ length: 21 }, (_, i) => ({ content: `t${i}`, status: 'pending' })) },
          ctx
        ),
        /最多 20 项/
      )
    ]);
  });
});

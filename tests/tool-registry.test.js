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
    const { registry, fileAgent: _fileAgent } = makeRegistry();
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
    const { registry, gate } = makeRegistry();
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
    const { gate, computer } = makeRegistry();
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

function makeSshService() {
  let ran = 0;
  const svc = {
    listHosts: () => [
      {
        id: 'id-ssh',
        name: 'mock',
        host: '127.0.0.1',
        port: 22,
        user: 'root',
        enabled: true,
        authType: 'password',
        password: 'x'
      }
    ],
    exec: async () => {
      ran += 1;
      return { code: 0, stdout: 'ok', stderr: '', truncated: false, durationMs: 1 };
    }
  };
  return { svc, ran: () => ran };
}

test('ssh.exec 安全底线：riskOverrides 降为 safe 仍必须确认后执行', async () => {
  await withTmp(async () => {
    const gate = new SafetyGate();
    gate.configure({ 'ssh.exec': 'safe' });
    const { svc, ran } = makeSshService();
    const registry = new ToolRegistry(gate);
    registry.register(...createSshTools(svc));

    const events = [];
    const pending = registry.execute(
      'ssh.exec',
      { host: 'mock', command: 'rm -rf /tmp/demo' },
      makeCtx(events)
    );
    await new Promise((r) => setTimeout(r, 10));
    const safetyEv = events.find((e) => e.type === 'safety');
    assert.ok(safetyEv, '覆盖为 safe 后仍必须弹确认（安全底线）');
    assert.strictEqual(safetyEv.request.riskLevel, 'medium', '底线不得低于 medium');
    assert.strictEqual(ran(), 0, '确认前不得执行远程命令');
    gate.resolveApproval(safetyEv.request.id, true);
    await pending;
    assert.strictEqual(ran(), 1);
  });
});

test('审批超时抛 E_TIMEOUT，与 E_DENIED 可区分且不执行', async () => {
  await withTmp(async () => {
    const gate = new SafetyGate(20);
    const { svc, ran } = makeSshService();
    const registry = new ToolRegistry(gate);
    registry.register(...createSshTools(svc));

    await assert.rejects(
      registry.execute('ssh.exec', { host: 'mock', command: 'uptime' }, makeCtx([])),
      (err) => {
        assert.strictEqual(err.code, 'E_TIMEOUT');
        assert.match(err.message, /超时/);
        assert.doesNotMatch(err.message, /用户拒绝/);
        return true;
      }
    );
    assert.strictEqual(ran(), 0);
  });
});

test('用户的拒绝仍为 E_DENIED（不被超时文案覆盖）', async () => {
  await withTmp(async () => {
    const gate = new SafetyGate(5_000);
    const { svc } = makeSshService();
    const registry = new ToolRegistry(gate);
    registry.register(...createSshTools(svc));

    const events = [];
    const pending = registry.execute('ssh.exec', { host: 'mock', command: 'uptime' }, makeCtx(events));
    await new Promise((r) => setTimeout(r, 10));
    const safetyEv = events.find((e) => e.type === 'safety');
    gate.resolveApproval(safetyEv.request.id, false);
    await assert.rejects(pending, (err) => {
      assert.strictEqual(err.code, 'E_DENIED');
      assert.match(err.message, /用户拒绝/);
      return true;
    });
  });
});

test('中止时取消未决审批：立即结束等待，不占满超时窗口', async () => {
  await withTmp(async () => {
    const gate = new SafetyGate(60_000);
    const { svc, ran } = makeSshService();
    const registry = new ToolRegistry(gate);
    registry.register(...createSshTools(svc));

    const started = Date.now();
    const pending = registry.execute('ssh.exec', { host: 'mock', command: 'uptime' }, makeCtx([]));
    await new Promise((r) => setTimeout(r, 10));
    assert.strictEqual(gate.cancelAll('用户中止任务'), 1);
    await assert.rejects(pending, (err) => {
      assert.strictEqual(err.code, 'E_CANCELED');
      assert.match(err.message, /中止/);
      return true;
    });
    assert.ok(Date.now() - started < 1000, '取消应立即生效，而不是等满 60s 超时');
    assert.strictEqual(ran(), 0);
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

test('todo.write 兼容 title 别名（文本协议历史写法）', () => {
  return withTmp(() => {
    const registry = new ToolRegistry(new SafetyGate());
    registry.register(...createTodoTools());
    const events = [];
    return registry
      .execute('todo.write', { todos: [{ title: '第一步', status: 'pending' }] }, makeCtx(events))
      .then((r) => {
        assert.strictEqual(r, '已更新 1 项子任务');
        const todoEv = events.find((e) => e.type === 'todo');
        assert.deepStrictEqual(todoEv.todos, [{ content: '第一步', status: 'pending' }]);
      });
  });
});

test('todo.write 增量下发：只提交变化项（index + status），其余项保持不变', async () => {
  const gate = new SafetyGate();
  const registry = new ToolRegistry(gate);
  registry.register(...createTodoTools());
  const events = [];
  const ctx = { ...makeCtx(events), sessionId: 'ses-patch' };

  await registry.execute(
    'todo.write',
    {
      todos: [
        { content: '第一步', status: 'in_progress' },
        { content: '第二步', status: 'pending' },
        { content: '第三步', status: 'pending' }
      ]
    },
    ctx
  );
  const r = await registry.execute(
    'todo.write',
    { patch: [{ index: 1, status: 'completed' }, { index: 2, status: 'in_progress' }] },
    ctx
  );

  assert.strictEqual(r, '已更新 2 项（当前共 3 项）');
  const todoEv = events.filter((e) => e.type === 'todo').at(-1);
  assert.deepStrictEqual(todoEv.todos, [
    { content: '第一步', status: 'completed' },
    { content: '第二步', status: 'in_progress' },
    { content: '第三步', status: 'pending' }
  ]);
});

test('todo.write 增量下发必须有基线，且不得混用全量/增量', async () => {
  const registry = new ToolRegistry(new SafetyGate());
  registry.register(...createTodoTools());
  const ctx = { ...makeCtx([]), sessionId: 'ses-patch-none' };
  await assert.rejects(
    registry.execute('todo.write', { patch: [{ index: 1, status: 'completed' }] }, ctx),
    /还没有清单基线/
  );
  await assert.rejects(
    registry.execute(
      'todo.write',
      { todos: [{ content: 'a', status: 'pending' }], patch: [{ index: 1, status: 'completed' }] },
      ctx
    ),
    /不能同时提交/
  );
});

test('todo.write 拒绝空清单、非法状态与超量', () => {
  return withTmp(() => {
    const gate = new SafetyGate();
    const registry = new ToolRegistry(gate);
    registry.register(...createTodoTools());
    const ctx = makeCtx([]);
    return Promise.all([
      assert.rejects(registry.execute('todo.write', { todos: [] }, ctx), /必须给其一/),
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

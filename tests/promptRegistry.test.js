'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { PromptRegistry } = require('../dist-main/main/agent/prompt/registry.js');
const { createPromptRegistry } = require('../dist-main/main/agent/prompt/sections.js');
const { Orchestrator } = require('../dist-main/main/agent/orchestrator.js');
const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { createFileTools } = require('../dist-main/main/agent/tools/builtin/file.js');
const { createComputerTools } = require('../dist-main/main/agent/tools/builtin/computer.js');
const { createSshTools } = require('../dist-main/main/agent/tools/builtin/ssh.js');
const { createMemoryTools } = require('../dist-main/main/agent/tools/builtin/memory.js');
const { initStorage } = require('../dist-main/main/services/storage.js');
const { initMemory, getMemoryStore } = require('../dist-main/main/services/memory.js');

function fakeTool(name, promptSection) {
  return {
    name,
    description: '测试工具',
    inputSchema: { type: 'object', properties: {} },
    agent: 'main',
    risk: 'safe',
    promptSection,
    execute: async () => ({})
  };
}

const VARS = { mcp_tools: '（当前没有已连接的 MCP 扩展工具）', skills_catalog: '（当前没有已安装的运维技能）' };

test('分段按 order 升序拼接', () => {
  const registry = new PromptRegistry();
  registry.section({ name: 'late', order: 20, text: 'L' });
  registry.section({ name: 'early', order: -20, text: 'E' });
  assert.strictEqual(registry.assemble('text-json', [], {}), 'E\n\nL');
});

test('重复注册同名分段抛错', () => {
  const registry = new PromptRegistry();
  registry.section({ name: 'dup', order: 1, text: 'A' });
  assert.throws(() => registry.section({ name: 'dup', order: 2, text: 'B' }), /重复注册/);
});

test('未赋值变量抛错并指名分段', () => {
  const registry = new PromptRegistry();
  registry.section({ name: 'broken', order: 1, text: 'hello {{not_assigned}}' });
  assert.throws(() => registry.assemble('text-json', [], {}), /broken.*not_assigned/);
});

test('变量正常插值', () => {
  const registry = new PromptRegistry();
  registry.section({ name: 'ok', order: 1, text: '技能：{{skills_catalog}}' });
  assert.strictEqual(registry.assemble('text-json', [], VARS), '技能：（当前没有已安装的运维技能）');
});

test('工具守则重名抛错', () => {
  const registry = new PromptRegistry();
  const tools = [
    fakeTool('a', { name: 'tool:x', order: 300, text: 'A' }),
    fakeTool('b', { name: 'tool:x', order: 310, text: 'B' })
  ];
  assert.throws(() => registry.assemble('text-json', tools, VARS), /重名/);
});

test('工具守则按 order 进入装配结果', () => {
  const registry = new PromptRegistry();
  const tools = [
    fakeTool('b', { name: 'tool:b', order: 310, text: '第二个' }),
    fakeTool('a', { name: 'tool:a', order: 300, text: '第一个' })
  ];
  assert.strictEqual(registry.assemble('text-json', tools, VARS), '第一个\n\n第二个');
});

test('strategies 过滤：文本协议独有分段不进 FC', () => {
  const registry = new PromptRegistry();
  registry.section({ name: 'common', order: 1, text: 'C' });
  registry.section({ name: 'json_only', order: 2, strategies: ['text-json'], text: 'J' });
  assert.strictEqual(registry.assemble('function-calling', [], {}), 'C');
  assert.strictEqual(registry.assemble('text-json', [], {}), 'C\n\nJ');
});

test('空分段不产出多余分隔', () => {
  const registry = new PromptRegistry();
  registry.section({ name: 'a', order: 1, text: 'A' });
  registry.section({ name: 'empty', order: 2, text: '   ' });
  registry.section({ name: 'b', order: 3, text: 'B' });
  assert.strictEqual(registry.assemble('text-json', [], {}), 'A\n\nB');
});

test('工具清单从注册表生成：签名带可选标记，MCP 工具不进清单', () => {
  const tools = [
    ...createFileTools({ searchFiles: async () => [], readFile: async () => ({ content: '' }) }),
    { ...fakeTool('mcp__demo__ping', undefined), agent: 'mcp' }
  ];
  const text = createPromptRegistry().assemble('text-json', tools, VARS);
  assert.ok(text.includes('- file.search {query, limit?} — 本地文件搜索'), '清单应含生成的行');
  assert.ok(text.includes('- file.read {path, maxBytes?} — 读取文本文件内容'));
  assert.ok(!text.includes('mcp__demo__ping'), 'MCP 工具不应重复出现在清单里');
});

test('orderByStrategy：同一分段按策略落位', () => {
  const registry = new PromptRegistry();
  registry.section({ name: 'a', order: 1, text: 'A' });
  registry.section({ name: 's', order: 2, orderByStrategy: { 'function-calling': 99 }, text: 'S' });
  registry.section({ name: 'z', order: 3, text: 'Z' });
  assert.strictEqual(registry.assemble('text-json', [], {}), 'A\n\nS\n\nZ');
  assert.strictEqual(registry.assemble('function-calling', [], {}), 'A\n\nZ\n\nS');
});

test('双策略装配差异：FC 无 JSON 协议与工具清单', () => {
  const registry = createPromptRegistry();
  const tools = createFileTools({ searchFiles: async () => [], readFile: async () => ({ content: '' }) });
  const fc = registry.assemble('function-calling', tools, VARS);
  assert.ok(fc.includes('function calling'));
  assert.ok(!fc.includes('输出规则（严格遵守）'));
  assert.ok(!fc.includes('可用工具（参数中带 ? 为可选）'));
  assert.ok(fc.trim().endsWith(VARS.skills_catalog), 'FC 下技能目录位于中文收尾之后');

  const textJson = registry.assemble('text-json', tools, VARS);
  assert.ok(textJson.includes('输出规则（严格遵守）'));
  assert.ok(textJson.includes('可用工具（参数中带 ? 为可选）'));
  assert.ok(!textJson.includes('function calling'));
  assert.ok(
    textJson.indexOf('输出规则（严格遵守）') < textJson.indexOf('规则：'),
    '输出协议位于规则块之前（还原原模板顺序）'
  );
  assert.ok(textJson.trim().endsWith('回答一律使用中文'), '文本协议以中文收尾（还原原模板顺序）');
});

test('todo 规则按策略分流：文本协议用 actions 合并，FC 保留并行调用，两版都只增量下发', () => {
  const registry = createPromptRegistry();
  const tools = createFileTools({ searchFiles: async () => [], readFile: async () => ({ content: '' }) });
  const textJson = registry.assemble('text-json', tools, VARS);
  const fc = registry.assemble('function-calling', tools, VARS);

  assert.ok(textJson.includes('用 actions 带上 patch 只提交变化的项'), '文本协议应指导增量刷新');
  assert.ok(textJson.includes('不要重发整份清单'), '文本协议不得每轮重发整份清单');
  assert.ok(!textJson.includes('并行调用 todo.write'), '文本协议不应再要求无法执行的并行调用');
  assert.ok(fc.includes('并行用 patch 增量提交发生变化的项'), 'FC 保留每轮并行刷新（入参为 patch）');
  assert.ok(!fc.includes('用 actions 与其它工具'), 'FC 不应出现文本协议的 actions 说法');
});

test('文本协议解析 actions：一轮多个调用、去重、过滤空项', () => {
  const { TextJsonStrategy } = require('../dist-main/main/agent/loop/textJson.js');
  const strategy = new TextJsonStrategy();
  const step = strategy.parseStep({
    content: JSON.stringify({
      thought: '并行查询',
      actions: [
        { tool: 'todo.write', args: { todos: [{ content: 'a', status: 'in_progress' }] } },
        { tool: 'db.query', args: { datasourceId: 'd', sql: 'SELECT 1' } },
        { tool: 'db.query', args: { datasourceId: 'd', sql: 'SELECT 1' } },
        { tool: '', args: {} },
        null
      ],
      done: false
    }),
    finishReason: 'stop'
  });
  assert.strictEqual(step.type, 'calls');
  assert.deepStrictEqual(
    step.calls.map((c) => c.name),
    ['todo.write', 'db.query']
  );
  assert.match(step.calls[1].args.sql, /SELECT 1/);
});

test('文本协议兼容旧格式：单个 action 与 actions 同时出现时合并', () => {
  const { TextJsonStrategy } = require('../dist-main/main/agent/loop/textJson.js');
  const strategy = new TextJsonStrategy();
  const step = strategy.parseStep({
    content: JSON.stringify({
      action: { tool: 'db.list', args: {} },
      actions: [{ tool: 'todo.write', args: { todos: [] } }]
    }),
    finishReason: 'stop'
  });
  assert.strictEqual(step.type, 'calls');
  assert.deepStrictEqual(
    step.calls.map((c) => c.name),
    ['db.list', 'todo.write']
  );
});

test('工具清单递归渲染嵌套参数：todo.write 暴露 index/content/status 与枚举值', () => {
  const { createTodoTools } = require('../dist-main/main/agent/tools/builtin/todo.js');
  const text = createPromptRegistry().assemble('text-json', createTodoTools(), VARS);
  assert.ok(
    text.includes(
      '- todo.write {todos?:[{content, status:pending|in_progress|completed|cancelled}], patch?:[{index, content?, status?:pending|in_progress|completed|cancelled}]}'
    ),
    `todo.write 签名应展开 todos/patch 的嵌套字段，实际：${text.split('\n').find((l) => l.includes('todo.write'))}`
  );
});

test('文本协议含 actions 示例，作答规则含阈值/系统库/进度硬约束', () => {
  const { answerSystemPrompt } = require('../dist-main/main/agent/prompt/sections.js');
  const textJson = createPromptRegistry().assemble('text-json', [], VARS);
  assert.ok(textJson.includes('"actions": ['), '输出协议应给出 actions 写法');
  assert.ok(textJson.includes('action 与 actions 二选一'));

  const answer = answerSystemPrompt();
  assert.ok(answer.includes('不得用「尚可」'), '阈值判断不得用模糊措辞');
  assert.ok(answer.includes('系统库（mysql / information_schema'), '清单类结论需说明系统库过滤');
  assert.ok(answer.includes('不是任务进度'), '工具确认串不得当作任务进度');
  assert.ok(answer.includes('未获取：缺哪一项 + 原因'));
});

test('工具清单保留 computer.exec 的 op 枚举补充行', () => {
  const tools = [
    ...createFileTools({ searchFiles: async () => [], readFile: async () => ({ content: '' }) }),
    ...createComputerTools({ snapshot: async () => ({}), execWhitelisted: async () => ({}), listOps: () => [] })
  ];
  const text = createPromptRegistry().assemble('text-json', tools, VARS);
  assert.ok(text.includes('- computer.exec {op, args?} — 执行系统操作'));
  assert.ok(text.includes('  - empty-trash: 清空废纸篓（不可恢复）（风险 high）'));
});

function makeRouter(provider) {
  return { settings: {}, getActive: async () => provider };
}

function scriptedProvider(scripts) {
  const requests = [];
  let step = 0;
  return {
    id: 'fake:scripted',
    requests,
    chatStream: async (req) => {
      requests.push({ ...req, messages: [...req.messages] });
      const next = scripts[Math.min(step++, scripts.length - 1)];
      return { content: next, finishReason: 'stop' };
    }
  };
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-prompt-'));
  initStorage(dir);
  initMemory(dir);
  return Promise.resolve(fn()).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function makeRegistry(hosts) {
  const registry = new ToolRegistry(new SafetyGate());
  registry.register(
    ...createFileTools({ searchFiles: async () => [], readFile: async () => ({ content: '' }) })
  );
  registry.register(...createSshTools({ listHosts: () => hosts, exec: async () => ({}) }));
  registry.register(...createMemoryTools());
  return registry;
}

const HOST = { id: 'id-1', name: '生产服务器', host: '10.1.1.1', port: 22, user: 'root', enabled: true };

test('运行时上下文快照：不进系统提示词，追加在消息尾部且只保留最新一条', () =>
  withTmp(async () => {
    getMemoryStore().append('偏好：回答用中文');
    const provider = scriptedProvider([
      '{"thought":"看一眼主机","action":{"tool":"ssh.hosts","args":{}},"final":null}',
      '{"thought":"完成","action":null,"final":"已确认"}'
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry: makeRegistry([HOST])
    });

    assert.ok(!orch.planningSystem().includes('生产服务器'), '主机清单不应常驻系统提示词');

    await orch.handleUserMessage('ses-snap', '看下有哪些主机', () => {});

    const first = provider.requests[0];
    const firstSnap = first.messages.at(-1);
    assert.strictEqual(firstSnap.role, 'user');
    assert.ok(firstSnap.content.startsWith('[运行时上下文]'));
    assert.ok(firstSnap.content.includes('生产服务器'));
    assert.ok(firstSnap.content.includes('偏好：回答用中文'));

    const second = provider.requests[1];
    const snaps = second.messages.filter(
      (m) => typeof m.content === 'string' && m.content.startsWith('[运行时上下文]')
    );
    assert.strictEqual(snaps.length, 1, '每轮只保留最新一条快照');
    assert.strictEqual(second.messages.at(-1), snaps[0], '快照始终在消息尾部');
    assert.ok(second.system === first.system, '任务内系统提示词应逐字节稳定');
  }));

test('任务内记忆写入：系统提示词逐字节不变，快照紧随刷新', () =>
  withTmp(async () => {
    const provider = scriptedProvider([
      '{"thought":"记住偏好","action":{"tool":"memory.write","args":{"content":"偏好：回答简短"}},"final":null}',
      '{"thought":"完成","action":null,"final":"已记住"}'
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry: makeRegistry([])
    });
    await orch.handleUserMessage('ses-freeze', '记住我喜欢简短回答', () => {});

    const [first, second] = provider.requests;
    assert.strictEqual(second.system, first.system, '任务内系统提示词应冻结');
    assert.ok(
      !first.messages.some(
        (m) => typeof m.content === 'string' && m.content.startsWith('[运行时上下文]')
      ),
      '写入前无记忆、无主机 → 首轮不追加快照'
    );
    const snapshot = second.messages.at(-1);
    assert.ok(snapshot.content.startsWith('[运行时上下文]'));
    assert.ok(snapshot.content.includes('偏好：回答简短'), '快照应反映刚写入的记忆');
    assert.ok(!second.system.includes('偏好：回答简短'));
  }));

test('快照为空时不追加消息', () =>
  withTmp(async () => {
    const provider = scriptedProvider(['{"thought":"直接答","action":null,"final":"好的"}']);
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry: makeRegistry([])
    });
    await orch.handleUserMessage('ses-empty', '你好', () => {});
    const req = provider.requests[0];
    assert.strictEqual(req.messages.length, 1);
    assert.strictEqual(req.messages[0].role, 'user');
    assert.ok(!String(req.messages[0].content).startsWith('[运行时上下文]'));
  }));

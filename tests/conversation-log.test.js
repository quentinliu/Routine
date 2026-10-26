'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { ConversationLog } = require('../dist-main/main/services/conversationLog.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routine-convlog-'));
}

test('任务日志往返：begin/round/event/final 落盘，list 与 read 完整还原', () => {
  const log = new ConversationLog(tmpDir());
  log.begin({ id: 'task-1', sessionId: 's1', task: '巡检 mysql 数据库并给出报告', provider: 'fake:glm' });
  log.round('task-1', {
    i: 0,
    ms: 1200,
    strategy: 'function-calling',
    system: '你是 Routine 主 Agent',
    messages: [{ role: 'user', content: '巡检任务' }],
    toolNames: ['db.query'],
    content: '我来巡检',
    finishReason: 'tool_calls',
    usage: { prompt: 100, completion: 20 },
    step: { type: 'tool_calls', calls: [{ name: 'db.query', args: {} }] }
  });
  log.event('task-1', 'warn', '回答呈放弃式');
  log.final('task-1', '巡检报告：一切正常');

  const metas = log.list();
  assert.strictEqual(metas.length, 1);
  assert.strictEqual(metas[0].id, 'task-1');
  assert.strictEqual(metas[0].sessionId, 's1');

  const view = log.read('task-1');
  assert.strictEqual(view.meta.task, '巡检 mysql 数据库并给出报告');
  assert.strictEqual(view.lines.length, 3);
  assert.strictEqual(view.lines[0].type, 'round');
  assert.strictEqual(view.lines[0].strategy, 'function-calling');
  assert.strictEqual(view.lines[1].type, 'event');
  assert.strictEqual(view.lines[2].type, 'final');
  assert.match(view.lines[2].text, /巡检报告/);
});

test('tool 行往返：记录工具名、脱敏参数摘要、耗时与结果摘要', () => {
  const log = new ConversationLog(tmpDir());
  log.begin({ id: 'task-tool', sessionId: 's1', task: '巡检', provider: 'fake' });
  log.tool('task-tool', {
    name: 'ssh.exec',
    argsDigest: '{"host":"192.168.1.2","command":"df -h"}',
    ok: true,
    durationMs: 812,
    resultChars: 1200,
    resultDigest: 'Filesystem Size Used Avail Use%'
  });
  log.tool('task-tool', {
    name: 'todo.write',
    argsDigest: '{"todos":[]}',
    ok: false,
    denied: false,
    durationMs: 3,
    resultChars: 24,
    resultDigest: '工具执行失败: 第 1 项 content 不能为空'
  });

  const view = log.read('task-tool');
  const tools = view.lines.filter((l) => l.type === 'tool');
  assert.strictEqual(tools.length, 2);
  assert.strictEqual(tools[0].name, 'ssh.exec');
  assert.strictEqual(tools[0].ok, true);
  assert.strictEqual(tools[0].durationMs, 812);
  assert.strictEqual(tools[0].resultChars, 1200);
  assert.match(tools[0].resultDigest, /Filesystem/);
  assert.strictEqual(typeof tools[0].at, 'number');
  assert.strictEqual(tools[1].ok, false);
  assert.match(tools[1].resultDigest, /content 不能为空/);
});

test('safety 行往返：落盘审批结论、决策耗时与命令原文', () => {
  const log = new ConversationLog(tmpDir());
  log.begin({ id: 'task-safety', sessionId: 's1', task: '巡检', provider: 'fake' });
  log.safety('task-safety', {
    tool: 'ssh.exec',
    risk: 'medium',
    outcome: 'approved',
    waitMs: 2179,
    detail: '在远程主机「192.168.1.2」执行命令\n命令: df -hT | grep -Ev tmpfs'
  });
  const view = log.read('task-safety');
  const line = view.lines.find((l) => l.type === 'safety');
  assert.ok(line, '确认请求与决策必须留下 safety 行');
  assert.strictEqual(line.tool, 'ssh.exec');
  assert.strictEqual(line.outcome, 'approved');
  assert.strictEqual(line.waitMs, 2179);
  assert.match(line.detail, /df -hT/, '应能看到被确认的具体命令');
  assert.strictEqual(typeof line.at, 'number');
});

test('老日志（无 tool 行）仍可读取，新增行类型不影响解析', () => {
  const dir = tmpDir();
  const log = new ConversationLog(dir);
  const raw = [
    { type: 'task', id: 'legacy', sessionId: 's', task: '旧任务', provider: 'p', ts: 1 },
    { type: 'round', at: 2, i: 0, ms: 10, strategy: 'text-json', system: 's', messages: [], content: '{}', finishReason: 'stop' },
    { type: 'final', at: 3, text: '旧回答' }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
  fs.writeFileSync(path.join(dir, 'legacy.jsonl'), `${raw}\n`, 'utf-8');

  const view = log.read('legacy');
  assert.strictEqual(view.lines.length, 2);
  assert.strictEqual(view.lines[0].type, 'round');
  assert.strictEqual(view.lines[1].type, 'final');
});

test('未初始化日志时 tool/NULL_LOG 为空实现，不抛错', () => {
  const { getConversationLog } = require('../dist-main/main/services/conversationLog.js');
  const log = getConversationLog();
  assert.doesNotThrow(() =>
    log.tool('nope', {
      name: 'db.query',
      argsDigest: '{}',
      ok: true,
      durationMs: 1,
      resultChars: 0,
      resultDigest: ''
    })
  );
  assert.strictEqual(log.read('nope'), null);
});

test('未 begin 的任务写入被忽略，read 不存在的任务返回 null', () => {
  const log = new ConversationLog(tmpDir());
  log.round('ghost', { i: 0, ms: 1, strategy: 'x', system: '', messages: [], content: '', finishReason: '' });
  assert.strictEqual(log.read('ghost'), null);
  assert.strictEqual(log.list().length, 0);
});

test('prune：超过 50 个任务文件时淘汰最旧', () => {
  const log = new ConversationLog(tmpDir());
  for (let i = 0; i < 53; i += 1) {
    log.begin({ id: `t-${String(i).padStart(3, '0')}`, sessionId: 's', task: `任务 ${i}`, provider: 'p' });
  }
  const files = fs.readdirSync(log['root']).filter((f) => f.endsWith('.jsonl'));
  assert.strictEqual(files.length, 50);
  assert.strictEqual(log.list().length, 50);
  assert.ok(!files.includes('t-000.jsonl'), '最旧的 t-000 应被淘汰');
  assert.ok(files.includes('t-052.jsonl'), '最新的 t-052 应保留');
});

test('编排器集成：一次真实任务写入完整轮次与最终回答', async () => {
  const { Orchestrator } = require('../dist-main/main/agent/orchestrator.js');
  const { SafetyGate } = require('../dist-main/main/agent/safety.js');
  const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
  const { createWebTools } = require('../dist-main/main/agent/tools/builtin/web.js');
  const { createTodoTools } = require('../dist-main/main/agent/tools/builtin/todo.js');
  const { initStorage } = require('../dist-main/main/services/storage.js');
  const { initMemory } = require('../dist-main/main/services/memory.js');
  const { initConversationLog, getConversationLog } = require('../dist-main/main/services/conversationLog.js');

  const dir = tmpDir();
  initStorage(dir);
  initMemory(dir);
  initConversationLog(path.join(dir, 'logs'));

  const registry = new ToolRegistry(new SafetyGate());
  registry.register(
    ...createWebTools({
      search: async () => [{ title: '结果', url: 'https://x', snippet: '数据 42' }]
    })
  );
  registry.register(...createTodoTools());

  let step = 0;
  const scripts = [
    {
      content: '先搜索',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c1', name: 'search.web', arguments: '{"query":"巡检"}' }]
    },
    { content: '巡检结论：数据 42。', finishReason: 'stop' }
  ];
  const provider = {
    id: 'fake:convlog',
    chatStream: async () => scripts[Math.min(step++, scripts.length - 1)]
  };
  const orch = new Orchestrator({
    router: {
      settings: { providerMode: 'cloud', agent: { maxSteps: 8 } },
      getActive: async () => provider
    },
    safety: new SafetyGate(),
    registry
  });

  await orch.handleUserMessage('s-conv', '巡检任务', () => {});

  const metas = getConversationLog().list();
  assert.strictEqual(metas.length, 1);
  const view = getConversationLog().read(metas[0].id);
  const rounds = view.lines.filter((l) => l.type === 'round');
  assert.ok(rounds.length >= 2, `expected >=2 rounds, got ${rounds.length}`);
  assert.ok(rounds[0].system.length > 0, 'system prompt should be recorded');
  assert.ok(Array.isArray(rounds[0].messages) && rounds[0].messages.length > 0);
  assert.strictEqual(view.meta.provider, 'fake:convlog');
  const final = view.lines.find((l) => l.type === 'final');
  assert.ok(final && String(final.text).includes('数据 42'));
  const toolLines = view.lines.filter((l) => l.type === 'tool');
  assert.strictEqual(toolLines.length, 1, '执行过的工具调用应留下可追溯的 tool 行');
  assert.strictEqual(toolLines[0].name, 'search.web');
  assert.strictEqual(toolLines[0].ok, true);
  assert.ok(String(toolLines[0].resultDigest).includes('数据 42'), '结果摘要应含工具返回的数值');
});

test('增量轮次：system 复用与消息尾段替换在 read 时物化', () => {
  const dir = tmpDir();
  const log = new ConversationLog(dir);
  log.begin({ id: 't-delta', sessionId: 's', task: '巡检', provider: 'p' });

  const m1 = [{ role: 'user', content: '任务' }];
  log.round('t-delta', {
    i: 0,
    ms: 10,
    strategy: 'text-json',
    system: 'SYS',
    msgs: { base: 0, items: m1 },
    content: '{"thought":"a"}',
    finishReason: 'stop'
  });
  const m2 = [...m1, { role: 'assistant', content: 'a' }, { role: 'user', content: 'b' }];
  log.round('t-delta', {
    i: 1,
    ms: 20,
    strategy: 'text-json',
    systemRef: true,
    msgs: { base: 1, items: m2.slice(1) },
    content: '{"thought":"b"}',
    finishReason: 'stop'
  });

  // 落盘结构：system 只出现一次，且不再写全量 messages（体积随轮次近似线性）
  const raw = fs
    .readFileSync(path.join(dir, 't-delta.jsonl'), 'utf-8')
    .trim()
    .split('\n')
    .map((l) => JSON.parse(l));
  const rounds = raw.filter((l) => l.type === 'round');
  assert.strictEqual(rounds.length, 2);
  assert.strictEqual(rounds[0].system, 'SYS');
  assert.ok(!rounds[0].systemRef, '首轮写完整 system');
  assert.strictEqual(rounds[1].system, undefined, '次轮复用 system 不重复落盘');
  assert.strictEqual(rounds[1].systemRef, true);
  assert.ok(rounds.every((r) => r.messages === undefined), '增量格式不再写全量 messages');

  const view = log.read('t-delta');
  assert.strictEqual(view.lines[0].system, 'SYS');
  assert.strictEqual(view.lines[1].system, 'SYS');
  assert.deepStrictEqual(view.lines[1].messages, m2);
  assert.strictEqual(view.lines[1].msgs, undefined);
  assert.strictEqual(view.lines[1].systemRef, undefined);
});

test('混合格式：旧全量轮次后接增量轮次仍可物化', () => {
  const dir = tmpDir();
  const log = new ConversationLog(dir);
  const base = [{ role: 'user', content: '任务' }];
  const raw = [
    { type: 'task', id: 't-mix', sessionId: 's', task: '旧', provider: 'p', ts: 1 },
    {
      type: 'round',
      at: 2,
      i: 0,
      ms: 1,
      strategy: 'text-json',
      system: 'SYS',
      messages: base,
      content: '{}',
      finishReason: 'stop'
    }
  ]
    .map((l) => JSON.stringify(l))
    .join('\n');
  fs.writeFileSync(path.join(dir, 't-mix.jsonl'), `${raw}\n`, 'utf-8');

  log.round('t-mix', {
    i: 1,
    ms: 2,
    strategy: 'text-json',
    systemRef: true,
    msgs: { base: 1, items: [{ role: 'assistant', content: 'a' }] },
    content: '{}',
    finishReason: 'stop'
  });

  const rounds = log.read('t-mix').lines.filter((l) => l.type === 'round');
  assert.deepStrictEqual(rounds[0].messages, base);
  assert.strictEqual(rounds[1].system, 'SYS');
  assert.deepStrictEqual(rounds[1].messages, [...base, { role: 'assistant', content: 'a' }]);
});

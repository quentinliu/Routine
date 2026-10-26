'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { Orchestrator } = require('../dist-main/main/agent/orchestrator.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { createFileTools } = require('../dist-main/main/agent/tools/builtin/file.js');
const { createComputerTools } = require('../dist-main/main/agent/tools/builtin/computer.js');
const { createWebTools } = require('../dist-main/main/agent/tools/builtin/web.js');
const { createBrowserTools } = require('../dist-main/main/agent/tools/builtin/browser.js');
const { createSshTools } = require('../dist-main/main/agent/tools/builtin/ssh.js');
const { createTodoTools } = require('../dist-main/main/agent/tools/builtin/todo.js');
const { OpenAICompatProvider } = require('../dist-main/main/llm/openaiCompat.js');
const { initStorage } = require('../dist-main/main/services/storage.js');
const { initMemory } = require('../dist-main/main/services/memory.js');

function scriptedProvider(scripts) {
  const requests = [];
  let step = 0;
  return {
    requests,
    id: 'fake:scripted',
    chatStream: async (req) => {
      requests.push({ ...req, messages: [...req.messages] });
      const next = scripts[Math.min(step++, scripts.length - 1)];
      return typeof next === 'function' ? next(req) : next;
    }
  };
}

function makeRouter(provider, settings) {
  return {
    settings: { providerMode: 'cloud', agent: { maxSteps: 12 }, ...settings },
    getActive: async () => provider
  };
}

function makeRegistry(over = {}) {
  const gate = new SafetyGate();
  const registry = new ToolRegistry(gate);
  const calls = { web: [], files: [] };
  registry.register(
    ...createFileTools({
      searchFiles: async (q) => {
        calls.files.push(q);
        if (over.failFileSearch) throw new Error('boom');
        return [];
      },
      readFile: async () => ({ content: '', truncated: false })
    })
  );
  registry.register(
    ...createComputerTools({
      snapshot: async () => ({}),
      execWhitelisted: async () => ({ summary: '' }),
      listOps: () => []
    })
  );
  registry.register(
    ...createWebTools({
      search: async (q, max) => {
        calls.web.push([q, max]);
        return [{ title: 't', url: 'https://x', snippet: 's' }];
      }
    })
  );
  registry.register(...createBrowserTools({ run: async () => ({ ok: true, outputs: [], summary: '' }) }));
  registry.register(...createSshTools({ listHosts: () => [], exec: async () => ({}) }));
  registry.register(...createTodoTools());
  return { gate, registry, calls };
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-react-loop-'));
  initStorage(dir);
  initMemory(dir);
  try {
    return fn();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('FC 全链路：tools 下发 → tool_calls 执行 → tool 角色回灌 → final', async () => {
  await withTmp(async () => {
    const { registry, calls } = makeRegistry();
    const provider = scriptedProvider([
      {
        content: '我先搜索',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'search.web', arguments: '{"query":"AI 新闻"}' }]
      },
      { content: '已汇总搜索结果', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry
    });
    const events = [];
    const final = await orch.handleUserMessage('ses-a', '搜下 AI 新闻', (e) => events.push(e));

    assert.strictEqual(final, '已汇总搜索结果');
    assert.deepStrictEqual(calls.web, [['AI 新闻', 6]]);

    assert.ok(provider.requests[0].tools, 'FC 请求应携带 tools');
    assert.ok(provider.requests[0].tools.length === 9, 'FC 工具数应与测试注册表一致');
    assert.ok(!provider.requests[0].jsonMode, 'FC 请求不应带 jsonMode');
    assert.ok(provider.requests[0].system.includes('function calling'));

    const msgs = provider.requests[1].messages;
    assert.strictEqual(msgs.length, 3);
    assert.strictEqual(msgs[1].role, 'assistant');
    assert.deepStrictEqual(msgs[1].toolCalls, [
      { id: 'c1', name: 'search.web', arguments: '{"query":"AI 新闻"}' }
    ]);
    assert.strictEqual(msgs[2].role, 'tool');
    assert.strictEqual(msgs[2].toolCallId, 'c1');
    assert.ok(msgs[2].content.includes('<tool_result>'));

    const traces = events.filter((e) => e.type === 'trace').map((e) => e.event);
    assert.ok(traces.some((t) => t.phase === 'thought' && t.thought === '我先搜索'));
    assert.ok(traces.some((t) => t.phase === 'tool-start' && t.tool === 'search.web'));
    assert.ok(traces.some((t) => t.phase === 'tool-end' && t.tool === 'search.web' && !t.error));
    assert.ok(
      events.some((e) => e.type === 'agent-status' && e.status.agent === 'search' && e.status.state === 'done')
    );
  });
});

test('FC 请求 4xx 自动降级文本协议并继续完成任务', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    let call = 0;
    const provider = {
      id: 'fake:cloud',
      requests: [],
      chatStream: async (req) => {
        provider.requests.push({ ...req, messages: [...req.messages] });
        call++;
        if (call === 1) {
          const { LlmHttpError } = require('../dist-main/main/llm/openaiCompat.js');
          throw new LlmHttpError('fake 请求失败 HTTP 400: tools is not supported', 400);
        }
        return {
          content: '{"thought":"直接回答","action":null,"final":"文本协议完成"}',
          finishReason: 'stop'
        };
      }
    };
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry
    });
    const events = [];
    const final = await orch.handleUserMessage('ses-b', '你好', (e) => events.push(e));

    assert.strictEqual(final, '文本协议完成');
    assert.ok(
      events.some(
        (e) =>
          e.type === 'trace' &&
          e.event.phase === 'notice' &&
          String(e.event.notice).includes('已切换文本协议')
      ),
      '协议降级应经 notice 进执行过程'
    );
    assert.ok(provider.requests[0].tools, '首次请求带 tools');
    assert.ok(!provider.requests[1].tools, '降级后请求不再带 tools');
    assert.ok(provider.requests[1].jsonMode, '降级后走 JSON 模式');
  });
});

test('FC 多轮并行 tool_calls 与每轮多调用', async () => {
  await withTmp(async () => {
    const { registry, calls } = makeRegistry();
    const provider = scriptedProvider([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 'c1', name: 'search.web', arguments: '{"query":"a"}' },
          { id: 'c2', name: 'search.web', arguments: '{"query":"b"}' }
        ]
      },
      { content: '两个都完成了', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry
    });
    const final = await orch.handleUserMessage('ses-c', '并行搜索', () => {});
    assert.strictEqual(final, '两个都完成了');
    assert.deepStrictEqual(calls.web, [['a', 6], ['b', 6]]);
    const msgs = provider.requests[1].messages;
    assert.strictEqual(msgs[2].role, 'tool');
    assert.strictEqual(msgs[3].role, 'tool');
  });
});

test('同一调用连续失败达阈值后注入换思路提示', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry({ failFileSearch: true });
    const provider = scriptedProvider([
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'file.search', arguments: '{"query":"x"}' }]
      },
      {
        content: '',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c2', name: 'file.search', arguments: '{"query":"x"}' }]
      },
      { content: '放弃该思路', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry
    });
    const final = await orch.handleUserMessage('ses-d', '找文件', () => {});
    assert.strictEqual(final, '放弃该思路');
    const msgs = provider.requests[2].messages;
    const lastObs = msgs.filter((m) => m.role === 'tool').at(-1);
    assert.ok(lastObs.content.includes('连续失败 2 次'), '第二次失败应带换思路提示');
    assert.ok(lastObs.content.includes('boom'));
  });
});

test('FC 调用 todo.write 推送任务进度事件且回灌短确认', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    const todos = [
      { content: '搜索资料', status: 'in_progress' },
      { content: '整理汇总', status: 'pending' }
    ];
    const provider = scriptedProvider([
      {
        content: '先制定计划',
        finishReason: 'tool_calls',
        toolCalls: [
          { id: 't1', name: 'todo.write', arguments: JSON.stringify({ todos }) }
        ]
      },
      { content: '计划完成', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry
    });
    const events = [];
    const final = await orch.handleUserMessage('ses-todo', '做个复杂任务', (e) => events.push(e));

    assert.strictEqual(final, '计划完成');
    const todoEv = events.find((e) => e.type === 'todo');
    assert.ok(todoEv, '应发出 todo 事件');
    assert.strictEqual(todoEv.sessionId, 'ses-todo');
    assert.deepStrictEqual(todoEv.todos, [
      { content: '搜索资料', status: 'in_progress' },
      { content: '整理汇总', status: 'pending' }
    ]);
    const msgs = provider.requests[1].messages;
    const obs = msgs.find((m) => m.role === 'tool');
    assert.ok(obs.content.includes('已更新 2 项子任务'), '工具结果应为极短确认');
  });
});

test('orchestrator 单飞：运行中再次调用被拒绝，结束后恢复', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    const provider = {
      id: 'fake:slow',
      chatStream: async () => {
        await new Promise((r) => setTimeout(r, 150));
        return { content: '第一轮就完成', finishReason: 'stop' };
      }
    };
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry
    });
    const first = orch.handleUserMessage('ses-busy-1', '任务一', () => {});
    await new Promise((r) => setTimeout(r, 30));
    await assert.rejects(
      orch.handleUserMessage('ses-busy-2', '任务二', () => {}),
      /当前有任务正在执行/
    );
    const final = await first;
    assert.strictEqual(final, '第一轮就完成');
    const again = await orch.handleUserMessage('ses-busy-3', '任务三', () => {});
    assert.strictEqual(again, '第一轮就完成');
  });
});

test('maxSteps 用尽后走 digest 兜底生成回答', async () => {  await withTmp(async () => {
    const { registry } = makeRegistry();
    const toolCall = {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c', name: 'computer.info', arguments: '{}' }]
    };
    const provider = scriptedProvider([toolCall, toolCall, { content: '兜底总结', finishReason: 'stop' }]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { agent: { maxSteps: 2 } }),
      safety: new SafetyGate(),
      registry
    });
    const final = await orch.handleUserMessage('ses-e', '看系统', () => {});
    assert.strictEqual(final, '兜底总结');
    assert.strictEqual(provider.requests.length, 3, '2 轮规划 + 1 次 digest 生成');
    assert.ok(!provider.requests[2].tools, 'digest 生成不带 tools');
  });
});

test('abort 立即中止进行中的 LLM 请求并输出中止文案', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    const provider = {
      id: 'fake:slow',
      chatStream: async (req) => {
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => resolve({ content: '{}', finishReason: 'stop' }), 10_000);
          req.signal.addEventListener('abort', () => {
            clearTimeout(timer);
            const err = new Error('This operation was aborted');
            err.name = 'AbortError';
            reject(err);
          });
        });
      }
    };
    const orch = new Orchestrator({
      router: makeRouter(provider),
      safety: new SafetyGate(),
      registry
    });
    const events = [];
    const pending = orch.handleUserMessage('ses-f', '慢任务', (e) => events.push(e));
    setTimeout(() => orch.abort(), 50);
    const final = await pending;
    assert.strictEqual(final, '');
    assert.ok(
      events.some(
        (e) => e.type === 'chat-delta' && e.delta.includes('任务已被用户中止') && e.done
      )
    );
  });
});

test('文本协议 actions：同轮并行刷新清单与查询，不互相抢轮次', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    const provider = scriptedProvider([
      {
        content: JSON.stringify({
          thought: '先并行建清单并查系统信息',
          actions: [
            {
              tool: 'todo.write',
              args: { todos: [{ content: '查连接', status: 'in_progress' }, { content: '汇总', status: 'pending' }] }
            },
            { tool: 'computer.info', args: {} }
          ],
          done: false
        }),
        finishReason: 'stop'
      },
      {
        content: JSON.stringify({ thought: '可以作答', action: null, done: true }),
        finishReason: 'stop'
      },
      { content: '已完成巡检', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { providerMode: 'local' }),
      safety: new SafetyGate(),
      registry
    });
    const events = [];
    const final = await orch.handleUserMessage('ses-actions', '巡检', (e) => events.push(e));

    assert.strictEqual(final, '已完成巡检');
    assert.strictEqual(provider.requests.length, 3, '2 轮决策 + 1 次作答');

    const todoEv = events.find((e) => e.type === 'todo');
    assert.ok(todoEv, '同轮的 todo.write 应被执行');
    assert.strictEqual(todoEv.todos[0].content, '查连接');

    const roles = provider.requests[1].messages.slice(-2).map((m) => m.role);
    assert.deepStrictEqual(roles, ['user', 'user'], '两个工具结果都应回灌');
    assert.ok(
      String(provider.requests[1].messages.at(-2).content).includes('已更新 2 项子任务'),
      'todo 结果在前'
    );
  });
});

test('openaiCompat 流式聚合分片 tool_calls 并透传 signal', async () => {
  const chunks = [
    'data: {"choices":[{"delta":{"content":"查一下"}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c9","function":{"name":"file.search","arguments":"{\\"que"}}]}}]}',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"ry\\":\\"a\\"}"}}]}}]}',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}',
    'data: [DONE]'
  ];
  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    start(controller) {
      for (const c of chunks) {
        controller.enqueue(encoder.encode(`${c}\n\n`));
      }
      controller.close();
    }
  });
  const originalFetch = globalThis.fetch;
  let capturedSignal = null;
  globalThis.fetch = async (_url, init) => {
    capturedSignal = init.signal;
    return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
  };
  try {
    const provider = new OpenAICompatProvider('http://x', 'k', 'm');
    const controller = new AbortController();
    const res = await provider.chatStream(
      {
        system: 's',
        messages: [{ role: 'user', content: 'u' }],
        tools: [
          {
            type: 'function',
            function: { name: 'file.search', description: 'd', parameters: { type: 'object' } }
          }
        ],
        signal: controller.signal
      },
      () => {}
    );
    assert.strictEqual(res.finishReason, 'tool_calls');
    assert.deepStrictEqual(res.toolCalls, [
      { id: 'c9', name: 'file.search', arguments: '{"query":"a"}' }
    ]);
    assert.strictEqual(capturedSignal, controller.signal, 'signal 应透传到 fetch');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('最后一轮不再执行工具调用：忽略调用、记 warn、兜底携带已有观测', async () => {
  await withTmp(async () => {
    const { registry, calls } = makeRegistry();
    const toolCall = {
      content: '再搜一次',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c2', name: 'search.web', arguments: '{"query":"AI 新闻 2"}' }]
    };
    const provider = scriptedProvider([
      {
        content: '先搜索',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'search.web', arguments: '{"query":"AI 新闻"}' }]
      },
      toolCall,
      { content: '兜底回答', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { agent: { maxSteps: 2 } }),
      safety: new SafetyGate(),
      registry
    });
    const events = [];
    const final = await orch.handleUserMessage('ses-last-round', '查新闻', (e) => events.push(e));

    assert.strictEqual(final, '兜底回答');
    assert.deepStrictEqual(calls.web, [['AI 新闻', 6]], '最后一轮的调用不应被执行');
    assert.ok(
      events.some(
        (e) =>
          e.type === 'trace' &&
          e.event.phase === 'notice' &&
          String(e.event.notice).includes('已到最后一轮') &&
          String(e.event.notice).includes('search.web')
      ),
      '被忽略的调用应经 notice 进执行过程'
    );

    const fallbackReq = provider.requests[2];
    const digestMsg = fallbackReq.messages.find((m) => String(m.content).includes('已执行的工具与结果'));
    assert.ok(digestMsg, '兜底请求应携带工具结果摘要');
    assert.ok(String(digestMsg.content).includes('search.web'), '摘要应含工具名');
    assert.ok(String(digestMsg.content).includes('t'), '摘要应含第一轮的返回内容');
  });
});

test('收敛提示出现在倒数第二轮，最后一轮使用最终提示', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    const toolCall = {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [{ id: 'c', name: 'computer.info', arguments: '{}' }]
    };
    const provider = scriptedProvider([toolCall, toolCall, toolCall, { content: '完成', finishReason: 'stop' }]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { agent: { maxSteps: 3 } }),
      safety: new SafetyGate(),
      registry
    });
    await orch.handleUserMessage('ses-hint', '看系统', () => {});

    const texts = provider.requests.map((r) => String(r.messages.at(-1).content));
    assert.ok(texts[1].includes('只剩最后一轮规划机会'), '第 2 轮应为倒数第二轮提示');
    assert.ok(texts[2].includes('这是本次任务的最后一轮'), '第 3 轮应为最后一轮提示');
    assert.ok(!texts[0].includes('最后一轮'), '第 1 轮不注入收敛提示');
  });
});

test('参数不合法：给出字段路径、不执行工具、不消耗规划轮次', async () => {
  await withTmp(async () => {
    const { registry } = makeRegistry();
    const badTodo = {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        { id: 't1', name: 'todo.write', arguments: '{"todos":[{"title":"搜索资料","status":"pending"}]}' }
      ]
    };
    const goodTodo = {
      content: '',
      finishReason: 'tool_calls',
      toolCalls: [
        {
          id: 't2',
          name: 'todo.write',
          arguments: '{"todos":[{"content":"搜索资料","status":"in_progress"}]}'
        }
      ]
    };
    const provider = scriptedProvider([badTodo, goodTodo, { content: '计划完成', finishReason: 'stop' }]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { agent: { maxSteps: 2 } }),
      safety: new SafetyGate(),
      registry
    });
    const events = [];
    const final = await orch.handleUserMessage('ses-args', '做个计划', (e) => events.push(e));

    assert.strictEqual(final, '计划完成');
    assert.strictEqual(provider.requests.length, 3, '参数错误不应占用 2 轮预算后直接兜底');
    const correction = provider.requests[1].messages.filter((m) => m.role === 'tool').at(-1);
    assert.ok(correction.content.includes('todos[0].content'), '错误应指向字段路径');
    assert.ok(correction.content.includes('为必填项'), '错误应说明原因');
    assert.ok(!events.some((e) => e.type === 'todo' && e.todos.length === 0));
    const todoEv = events.find((e) => e.type === 'todo');
    assert.deepStrictEqual(todoEv.todos, [{ content: '搜索资料', status: 'in_progress' }], '修正后才真正写清单');
  });
});

test('FC 兜底：步数耗尽时最终回答携带全部工具结果（不丢 observations）', async () => {
  await withTmp(async () => {
    const { registry, calls } = makeRegistry();
    const provider = scriptedProvider([
      {
        content: '我先搜索',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c1', name: 'search.web', arguments: '{"query":"AI 新闻"}' }]
      },
      {
        content: '我再搜一次',
        finishReason: 'tool_calls',
        toolCalls: [{ id: 'c2', name: 'search.web', arguments: '{"query":"AI 新闻 2"}' }]
      },
      { content: '', finishReason: 'stop' },
      { content: '兜底总结', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { agent: { maxSteps: 3 } }),
      safety: new SafetyGate(),
      registry
    });
    await orch.handleUserMessage('ses-fallback', '查两轮新闻', () => {});

    assert.strictEqual(calls.web.length, 2, '前两轮工具都应执行（第三轮收敛不再执行）');
    const fallbackReq = provider.requests[3];
    assert.ok(fallbackReq, '应触发兜底请求');
    const digestMsg = fallbackReq.messages.find((m) =>
      String(m.content).includes('已执行的工具与结果')
    );
    assert.ok(digestMsg, '兜底请求应携带工具结果摘要');
    assert.ok(String(digestMsg.content).includes('search.web'), '摘要应含工具名');
    assert.ok(!String(digestMsg.content).includes('（无）'), '摘要不应为空');
  });
});

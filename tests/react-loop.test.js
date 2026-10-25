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
    assert.ok(events.some((e) => e.type === 'log' && e.entry.text.includes('已切换文本协议')));
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
      { content: '兜底回答', finishReason: 'stop' }
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { agent: { maxSteps: 2 } }),
      safety: new SafetyGate(),
      registry
    });
    await orch.handleUserMessage('ses-fallback', '查两轮新闻', () => {});

    assert.strictEqual(calls.web.length, 2, '两轮工具都应执行');
    const fallbackReq = provider.requests[2];
    assert.ok(fallbackReq, '应触发兜底请求');
    const digestMsg = fallbackReq.messages.find((m) =>
      String(m.content).includes('已执行的工具与结果')
    );
    assert.ok(digestMsg, '兜底请求应携带工具结果摘要');
    assert.ok(String(digestMsg.content).includes('search.web'), '摘要应含工具名');
    assert.ok(!String(digestMsg.content).includes('（无）'), '摘要不应为空');
  });
});

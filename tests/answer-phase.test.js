'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  Orchestrator,
  claimsZeroYield,
  needsAnswerRewrite,
  isLegacyGiveUpPlaceholder
} = require('../dist-main/main/agent/orchestrator.js');
const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { buildAnswerDigest } = require('../dist-main/main/agent/loop/answerDigest.js');
const {
  extractJsonObject,
  salvageJsonObject
} = require('../dist-main/main/util/jsonExtract.js');
const { OpenAICompatProvider } = require('../dist-main/main/llm/openaiCompat.js');
const { initStorage } = require('../dist-main/main/services/storage.js');
const { initMemory } = require('../dist-main/main/services/memory.js');
const { initConversationLog } = require('../dist-main/main/services/conversationLog.js');

/** 复刻 sessionlog.txt：技能手册 11888 字符 + 巡检指标 */
const SKILL_BODY = 'S'.repeat(11888);
const METRICS = {
  rowCount: 2,
  rows: [
    { Variable_name: 'Max_used_connections', Value: '151' },
    { Variable_name: 'Uptime', Value: '16575' }
  ]
};

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
    settings: {
      // local 走文本 JSON 协议；cloud 走原生 function calling
      providerMode: 'local',
      agent: { maxSteps: 12 },
      ...settings
    },
    getActive: async () => provider
  };
}

function makeRegistry() {
  const { createTodoTools } = require('../dist-main/main/agent/tools/builtin/todo.js');
  const registry = new ToolRegistry(new SafetyGate());
  registry.register(...createTodoTools());
  registry.register(
    {
      name: 'skill.run',
      description: '激活技能',
      inputSchema: { type: 'object', properties: {} },
      agent: 'main',
      maxResultChars: 16000,
      risk: 'safe',
      execute: async () => ({ skill: 'mysql-batch-health-check', content: SKILL_BODY })
    },
    {
      name: 'db.query',
      description: '只读 SQL',
      inputSchema: { type: 'object', properties: {} },
      agent: 'db',
      maxResultChars: 8000,
      risk: 'safe',
      execute: async () => METRICS
    }
  );
  return registry;
}

function makeOrchestrator(provider, settings) {
  return new Orchestrator({
    router: makeRouter(provider, settings),
    safety: new SafetyGate(),
    registry: makeRegistry()
  });
}

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-answer-phase-'));
  initStorage(dir);
  initMemory(dir);
  const log = initConversationLog(dir);
  try {
    return await fn({ dir, log });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** 决策轮回复：文本 JSON 协议返回的是 { content } 对象（content 里是 JSON 字符串） */
const decision = (plan) => ({ content: JSON.stringify(plan), finishReason: 'stop' });
const decisionSkill = (done) => decision({ thought: '激活技能', action: { tool: 'skill.run', args: {} }, done });
const decisionQuery = decision({
  thought: '查指标',
  action: { tool: 'db.query', args: {} },
  done: false
});

test('事故复现：末轮决策 JSON 被截断后不再产出「未采集数据」，改用真实指标作答', async () => {
  await withTmp(async ({ log }) => {
    const provider = scriptedProvider([
      decisionSkill(false),
      decisionQuery,
      // 上游把流切断：缺少收尾的 '}'（与 sessionlog.txt round 11 完全同型）
      { content: '{"thought":"信息足够","action":null,"done":true', finishReason: 'stop' },
      {
        content: '## 巡检报告\n\n- max_connections：151\n- Uptime：16575s\n- 结论：健康',
        finishReason: 'stop'
      }
    ]);
    const orch = makeOrchestrator(provider);
    const final = await orch.handleUserMessage('ses-accident', '巡检 mysql', () => {});

    assert.match(final, /151/, '最终回答必须包含真实指标');
    assert.match(final, /16575/);
    assert.ok(!/未采集到任何/.test(final), '不得出现零产出结论');
    assert.strictEqual(provider.requests.length, 4, '3 轮决策 + 1 次作答');

    const answerReq = provider.requests[3];
    assert.ok(!answerReq.tools, '作答阶段不带 tools');
    assert.ok(!answerReq.jsonMode, '作答阶段不走 JSON 模式');
    assert.ok(answerReq.system.includes('不等于未执行'), '作答提示词须声明截断≠未执行');

    const digest = String(answerReq.messages.at(-1).content);
    assert.ok(digest.includes('151') && digest.includes('16575'), '摘要必须包含真实指标');
    assert.ok(digest.includes('#1 skill.run'), '每次调用都带序号逐条列出，不做同文案去重');
    assert.strictEqual(answerReq.maxTokens, 4096, '作答阶段应提高输出上限');

    const meta = log.list()[0];
    const view = log.read(meta.id);
    const finalLine = view.lines.find((l) => l.type === 'final');
    assert.strictEqual(finalLine.answeredBy, 'answer');
    assert.strictEqual(finalLine.degraded, false, '决策标记 done 的正常作答不算降级');
  });
});

test('截断的 legacy final 不再直接交付，转作答阶段并标记降级', async () => {
  await withTmp(async ({ log }) => {
    const provider = scriptedProvider([
      decisionQuery,
      { content: '{"thought":"汇总","action":null,"final":"## 巡检报告\\n- 连接 151\\n（这里被切断', finishReason: 'stop' },
      { content: '完整报告：连接 151 / Uptime 16575', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider);
    const final = await orch.handleUserMessage('ses-truncated-final', '巡检 mysql', () => {});

    assert.strictEqual(final, '完整报告：连接 151 / Uptime 16575');
    assert.strictEqual(provider.requests.length, 3, '2 轮决策 + 1 次作答');

    const meta = log.list()[0];
    const view = log.read(meta.id);
    const finalLine = view.lines.find((l) => l.type === 'final');
    assert.strictEqual(finalLine.answeredBy, 'digest');
    assert.strictEqual(finalLine.degraded, true);
  });
});

test('轮次耗尽时兜底清单逐条保留：技能结果在前、真实指标不被挤掉', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([
      decisionSkill(false),
      decisionQuery,
      decision({ thought: '还要再查', action: { tool: 'db.query', args: {} }, done: false }),
      { content: '兜底作答', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider, { agent: { maxSteps: 3 } });
    const final = await orch.handleUserMessage('ses-budget', '巡检 mysql', () => {});

    assert.strictEqual(final, '兜底作答');
    const fallbackReq = provider.requests.at(-1);
    assert.ok(!fallbackReq.tools, '兜底作答不带 tools');
    const digest = String(fallbackReq.messages.at(-1).content);
    assert.ok(digest.includes('#1 skill.run'), '技能条目仍应出现');
    assert.ok(digest.includes('#2 db.query'), '每次调用按执行顺序编号');
    assert.ok(digest.includes('151'), '真实指标不能被手册挤掉');
    assert.ok(digest.length <= 48_000 + 500, '清单必须落在总预算内');
  });
});

test('buildAnswerDigest：逐条保留（含同文案重复）、带序号与关键参数、附截断语义说明', () => {
  const emptyRow = JSON.stringify({
    ok: true,
    sql: 'SHOW REPLICA STATUS',
    rowCount: 0,
    rows: [],
    note: '该 SQL 已成功执行但返回 0 行'
  });
  const digest = buildAnswerDigest([
    { tool: 'db.query', resultText: emptyRow, detail: 'sql: SHOW SLAVE STATUS', seq: 1 },
    { tool: 'db.query', resultText: emptyRow, detail: 'sql: SHOW REPLICA STATUS', seq: 2 },
    { tool: 'db.query', resultText: 'Q'.repeat(30_000), detail: 'sql: SELECT 1', seq: 3 },
    { tool: 'ssh.exec', resultText: 'df 9%', seq: 4 },
    { tool: 'db.query', resultText: '工具执行失败: boom', failed: true, seq: 5 }
  ]);
  assert.ok(digest.includes('#1 db.query（sql: SHOW SLAVE STATUS）'), '调用参数用于消除同文案歧义');
  assert.ok(digest.includes('#2 db.query（sql: SHOW REPLICA STATUS）'), '同文案结果必须各自保留');
  assert.ok(digest.includes('#4 ssh.exec'), '后面的条目不得被砍掉');
  assert.ok(digest.includes('#5') && digest.includes('执行失败'));
  assert.ok(digest.includes('已压缩'), '超长条目应压缩而非丢弃');
  assert.ok(digest.includes('未做去重'), '必须声明逐条保留');
  assert.ok(digest.includes('不代表未执行'), '必须声明截断≠未执行');
  assert.ok(digest.length <= 48_000 + 500, '总量必须受预算约束');
  assert.strictEqual(buildAnswerDigest([]), '（无）');
});

test('db.query 的 0 行结果必须带 sql，便于逐条复核', () => {
  const { createDbTools } = require('../dist-main/main/agent/tools/builtin/db.js');
  const tool = createDbTools().find((t) => t.name === 'db.query');
  const rendered = JSON.parse(
    tool.render({ ok: true, sql: 'SHOW REPLICA STATUS', rowCount: 0, rows: [] })
  );
  assert.strictEqual(rendered.sql, 'SHOW REPLICA STATUS', '0 行结果必须回填 SQL');
  assert.strictEqual(rendered.rowCount, 0);

  const nonEmpty = JSON.parse(tool.render({ ok: true, sql: 'SELECT 1', rowCount: 1, rows: [{ a: 1 }] }));
  assert.strictEqual(nonEmpty.sql, 'SELECT 1', '非空结果同样带 SQL');
});

test('作答截断：自动分段续写；仍到上限时正文标注「建议部分未完成」', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([
      decisionQuery,
      decision({ thought: '信息足够', action: null, done: true }),
      { content: '## 一、基础可用性\n', finishReason: 'length', truncated: true },
      { content: '## 二、连接与负载\n', finishReason: 'length', truncated: true },
      { content: '## 三、问题与建议\n', finishReason: 'length', truncated: true }
    ]);
    const orch = makeOrchestrator(provider, { agent: { maxSteps: 4 } });
    const final = await orch.handleUserMessage('ses-continue', '巡检 mysql', () => {});

    assert.ok(final.includes('## 一、基础可用性'), '第一段保留');
    assert.ok(final.includes('## 三、问题与建议'), '第三段续写成功');
    assert.ok(final.includes('未完成'), '必须显式告知后续部分未完成');
    assert.ok(final.includes('继续'), '应给出补写方式');
    assert.strictEqual(provider.requests.length, 5, '1 轮决策 + 3 段作答');

    // 续写请求必须携带上文与续写指令，且不再重复下发 tools
    const second = provider.requests[3];
    assert.ok(!second.tools, '续写不带 tools');
    assert.strictEqual(second.messages.at(-1).content.includes('紧接上文继续输出'), true);
    assert.ok(second.messages.at(-2).content.includes('## 一、基础可用性'), '续写要带已输出正文');
  });
});

test('作答分段续写成功时不追加「未完成」提示', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([
      decisionQuery,
      decision({ thought: '信息足够', action: null, done: true }),
      { content: '## 一、基础可用性\n', finishReason: 'length', truncated: true },
      { content: '## 二、结论\n健康。', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider, { agent: { maxSteps: 4 } });
    const final = await orch.handleUserMessage('ses-continue-ok', '巡检 mysql', () => {});
    assert.strictEqual(final, '## 一、基础可用性\n## 二、结论\n健康。');
    assert.ok(!final.includes('未完成'));
  });
});

test('上下文预算：多轮大结果被归档，prompt 不随轮次线性上涨', async () => {
  await withTmp(async () => {
    const bigTool = {
      name: 'big.query',
      description: '返回大结果',
      inputSchema: { type: 'object', properties: {} },
      agent: 'db',
      maxResultChars: 9000,
      risk: 'safe',
      execute: async () => ({ rows: 'R'.repeat(9000) })
    };
    const registry = new ToolRegistry(new SafetyGate());
    registry.register(bigTool);
    const provider = scriptedProvider([
      decision({ thought: '取数', action: { tool: 'big.query', args: {} }, done: false })
    ]);
    const orch = new Orchestrator({
      router: makeRouter(provider, { agent: { maxSteps: 6 } }),
      safety: new SafetyGate(),
      registry
    });
    await orch.handleUserMessage('ses-ctx-budget', '巡检 mysql', () => {});

    const sizes = provider.requests
      .slice(0, 6)
      .map((r) => r.messages.reduce((sum, m) => sum + String(m.content).length, 0));
    // 6 轮 × 9k 若不复用归档，prompt 会涨到 5 万字符以上
    assert.ok(sizes.at(-1) < 30_000, `末轮上下文 ${sizes.at(-1)} 字符，应被归档压住`);
    assert.ok(
      sizes.at(-1) - sizes[0] < 16_000 + 2_000,
      `上下文增长 ${sizes.at(-1) - sizes[0]} 应落在预算窗口内`
    );
  });
});

test('todo 增量下发：只带变化项，历史清单不再逐轮重发', async () => {
  await withTmp(async () => {
    const todoCall = (items, field = 'todos') => ({
      content:
        '{"thought":"刷新清单","action":{"tool":"todo.write","args":{"' +
        field +
        '":' +
        JSON.stringify(items) +
        '}},"done":false}',
      finishReason: 'stop'
    });
    const provider = scriptedProvider([
      todoCall([
        { content: '采集指标', status: 'in_progress' },
        { content: '汇总报告', status: 'pending' }
      ]),
      todoCall([{ index: 1, status: 'completed' }, { index: 2, status: 'in_progress' }], 'patch'),
      { content: '{"thought":"答","action":null,"done":true}', finishReason: 'stop' },
      { content: '报告', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider, { agent: { maxSteps: 4 } });
    await orch.handleUserMessage('ses-todo-inc', '巡检 mysql', () => {});

    // requests[2] = 第三轮请求，其历史里应有第二轮增量 patch 的回执
    const patchResult = provider.requests[2].messages
      .map((m) => String(m.content))
      .find((c) => c.includes('当前共')) || '';
    assert.ok(
      patchResult.includes('已更新 2 项') && patchResult.includes('当前共 2 项'),
      `增量结果应只回执变更项，实际：${patchResult}`
    );
  });
});

test('salvageJsonObject：补齐未闭合对象 / 抢救字符串字段 / 非法输入返回 null', () => {
  const truncated = '{"thought":"汇总","action":null,"done":true';
  assert.strictEqual(extractJsonObject(truncated), null, '严格解析应失败');
  assert.deepStrictEqual(salvageJsonObject(truncated), {
    thought: '汇总',
    action: null,
    done: true
  });

  // 截断在字符串内部：补引号后仍能捞出已生成的内容
  const cutString = '{"thought":"a","final":"半截的回答';
  assert.strictEqual(salvageJsonObject(cutString).final, '半截的回答');

  assert.strictEqual(salvageJsonObject('完全不是 JSON'), null);
  assert.deepStrictEqual(salvageJsonObject('{"a":1}'), { a: 1 });
});

test('零产出声明：长文本假报告也触发一致性重写，正常长报告不误伤', async () => {
  const toolCall = {
    content: '',
    finishReason: 'tool_calls',
    toolCalls: [{ id: 'c1', name: 'db.query', arguments: '{}' }]
  };
  const fakeReport =
    '# MySQL 巡检报告\n\n' +
    '本次巡检未能采集到任何实际指标数据，六个维度均无数据，健康评分无法计算。\n'.repeat(12);
  assert.ok(fakeReport.length > 300, '假报告超过放弃式识别的长度阈值');
  assert.strictEqual(claimsZeroYield(fakeReport), true);
  assert.strictEqual(needsAnswerRewrite(fakeReport, false), null, '无产出时不拦');

  await withTmp(async () => {
    const provider = scriptedProvider([
      toolCall,
      { content: fakeReport, finishReason: 'stop' },
      { content: '真实报告：Max_used_connections=151', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider, { providerMode: 'cloud' });
    const final = await orch.handleUserMessage('ses-zero-yield', '巡检 mysql', () => {});

    assert.strictEqual(final, '真实报告：Max_used_connections=151');
    assert.strictEqual(provider.requests.length, 3, '1 轮工具 + 1 次假报告 + 1 次重写');
    const correction = String(provider.requests[2].messages.at(-1).content);
    assert.ok(correction.includes('重写最终回答'));
    assert.ok(correction.includes('151'), '纠正消息必须带上真实数值');
  });

  await withTmp(async () => {
    const normalReport =
      '# 巡检报告\n\n' + '- 连接水位正常，max_connections=151\n'.repeat(20) + '个别子项因权限不足无法完成。';
    const provider = scriptedProvider([toolCall, { content: normalReport, finishReason: 'stop' }]);
    const orch = makeOrchestrator(provider, { providerMode: 'cloud' });
    const final = await orch.handleUserMessage('ses-normal', '巡检 mysql', () => {});
    assert.strictEqual(final, normalReport);
    assert.strictEqual(provider.requests.length, 2, '正常长报告不得触发重写');
  });
});

test('历史中的旧版兜底话术不再回灌给模型', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([
      { content: '{"thought":"答","action":null,"final":"好的"}', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider);
    const history = [
      { role: 'user', content: '巡检 mysql' },
      { role: 'assistant', content: '抱歉，我暂时无法完成这个任务。' },
      { role: 'user', content: '巡检 mysql' }
    ];
    assert.strictEqual(isLegacyGiveUpPlaceholder('抱歉，我暂时无法完成这个任务。'), true);
    await orch.handleUserMessage('ses-history', '再巡检一次', () => {}, history);

    const contents = provider.requests[0].messages.map((m) => String(m.content).trim());
    assert.ok(
      !contents.includes('抱歉，我暂时无法完成这个任务。'),
      '兜底话术不得作为 few-shot 示例回灌'
    );
    assert.ok(contents.includes('再巡检一次'));
  });
});

test('openaiCompat：流未收到 finish_reason/[DONE] 时标记 truncated', async () => {
  const encoder = new TextEncoder();
  const originalFetch = globalThis.fetch;

  const makeStream = (chunks) =>
    new ReadableStream({
      start(controller) {
        for (const c of chunks) controller.enqueue(encoder.encode(`${c}\n\n`));
        controller.close();
      }
    });

  try {
    globalThis.fetch = async () =>
      new Response(
        makeStream(['data: {"choices":[{"delta":{"content":"{\\"thought\\":\\"x\\""}}]}']),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    const cut = await new OpenAICompatProvider('http://x', 'k', 'm').chatStream(
      { system: 's', messages: [{ role: 'user', content: 'u' }] },
      () => {}
    );
    assert.strictEqual(cut.truncated, true);
    assert.strictEqual(cut.finishReason, 'incomplete');

    globalThis.fetch = async () =>
      new Response(
        makeStream([
          'data: {"choices":[{"delta":{"content":"ok"}}]}',
          'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}',
          'data: [DONE]'
        ]),
        { headers: { 'content-type': 'text/event-stream' } }
      );
    const normal = await new OpenAICompatProvider('http://x', 'k', 'm').chatStream(
      { system: 's', messages: [{ role: 'user', content: 'u' }] },
      () => {}
    );
    assert.strictEqual(normal.truncated, false);
    assert.strictEqual(normal.finishReason, 'stop');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

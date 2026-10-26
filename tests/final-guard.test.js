'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { Orchestrator, isAbandonmentText } = require('../dist-main/main/agent/orchestrator.js');
const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { createWebTools } = require('../dist-main/main/agent/tools/builtin/web.js');
const { createTodoTools } = require('../dist-main/main/agent/tools/builtin/todo.js');
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

function makeOrchestrator(provider) {
  const registry = new ToolRegistry(new SafetyGate());
  registry.register(
    ...createWebTools({
      search: async () => [{ title: '结果', url: 'https://x', snippet: '关键数据 42' }]
    })
  );
  registry.register(...createTodoTools());
  return new Orchestrator({
    router: {
      settings: { providerMode: 'cloud', agent: { maxSteps: 12 } },
      getActive: async () => provider
    },
    safety: new SafetyGate(),
    registry
  });
}

function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-final-guard-'));
  initStorage(dir);
  initMemory(dir);
  return fn();
}

const TOOL_CALL = {
  content: '先搜索',
  finishReason: 'tool_calls',
  toolCalls: [{ id: 'c1', name: 'search.web', arguments: '{"query":"AI"}' }]
};

test('放弃式识别：短文本+放弃措辞命中，长报告/正常回答不误伤', () => {
  assert.strictEqual(isAbandonmentText('抱歉，我暂时无法完成这个任务。'), true);
  assert.strictEqual(isAbandonmentText('无法完成'), true);
  assert.strictEqual(isAbandonmentText(''), false);
  assert.strictEqual(isAbandonmentText('已写入文件。'), false);
  const longReport = `${'巡检结论：'.repeat(60)}个别子项因权限不足无法完成。`;
  assert.strictEqual(isAbandonmentText(longReport), false);
});

test('已有工具产出时，放弃式回答触发一次性重写并产出报告', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([
      TOOL_CALL,
      { content: '抱歉，我暂时无法完成这个任务。', finishReason: 'stop' },
      { content: '巡检报告：搜索已返回关键数据 42，任务完成。', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider);
    const events = [];
    const final = await orch.handleUserMessage('ses-rescue', '任务', (e) => events.push(e));
    assert.strictEqual(final, '巡检报告：搜索已返回关键数据 42，任务完成。');
    assert.strictEqual(provider.requests.length, 3);
    const correction = provider.requests[2].messages.at(-1);
    assert.ok(correction.content.includes('重写最终回答'));
    assert.ok(correction.content.includes('search.web'));
  });
});

test('重写后仍是放弃式则放行（每任务至多拦截一次，不死循环）', async () => {
  await withTmp(async () => {
    const giveUp = { content: '抱歉，我暂时无法完成这个任务。', finishReason: 'stop' };
    const provider = scriptedProvider([TOOL_CALL, giveUp, giveUp]);
    const orch = makeOrchestrator(provider);
    const final = await orch.handleUserMessage('ses-rescue-2', '任务', () => {});
    assert.match(final, /无法完成/);
    assert.strictEqual(provider.requests.length, 3);
  });
});

test('无工具产出时放弃式回答直接放行（不触发重写）', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([{ content: '抱歉，无法完成。', finishReason: 'stop' }]);
    const orch = makeOrchestrator(provider);
    const final = await orch.handleUserMessage('ses-rescue-3', '任务', () => {});
    assert.match(final, /无法完成/);
    assert.strictEqual(provider.requests.length, 1);
  });
});

test('回答含无法溯源的数值时触发一次性重写并记事件', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([
      TOOL_CALL,
      { content: '磁盘使用率 92.5%，缓冲池命中率 88.8%，实例健康。', finishReason: 'stop' },
      { content: '搜索已返回关键数据 42，巡检完成。', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider);
    const events = [];
    const final = await orch.handleUserMessage('ses-grounding', '任务', (e) => events.push(e));

    assert.strictEqual(final, '搜索已返回关键数据 42，巡检完成。');
    assert.strictEqual(provider.requests.length, 3, '应恰好重写一次');
    const correction = provider.requests[2].messages.at(-1);
    assert.match(correction.content, /无法在工具结果中找到来源/);
    assert.match(correction.content, /92\.5/);
    assert.ok(
      events.some(
        (e) =>
          e.type === 'trace' &&
          e.event.phase === 'notice' &&
          String(e.event.notice).includes('无法溯源的数值')
      ),
      '守卫事件应经 notice 进执行过程'
    );
  });
});

test('数值全部可溯源时不触发重写', async () => {
  await withTmp(async () => {
    const provider = scriptedProvider([
      TOOL_CALL,
      { content: '搜索返回关键数据 42，任务完成。', finishReason: 'stop' }
    ]);
    const orch = makeOrchestrator(provider);
    const final = await orch.handleUserMessage('ses-grounded', '任务', () => {});
    assert.strictEqual(final, '搜索返回关键数据 42，任务完成。');
    assert.strictEqual(provider.requests.length, 2, '不应产生额外重写请求');
  });
});

test('零产出声明识别：整体性断言命中，个别子项失败不命中', () => {
  const { claimsZeroYield, needsAnswerRewrite } = require('../dist-main/main/agent/orchestrator.js');

  // sessionlog.txt 里的假报告原话：超过放弃式识别的 300 字符阈值，但仍须被拦住
  const fake = '本次巡检**未能采集到任何实际指标数据**，六个维度均无数据，健康评分无法计算。';
  assert.strictEqual(fake.length > 300, false);
  assert.strictEqual(claimsZeroYield(fake), true);
  assert.strictEqual(needsAnswerRewrite(fake, true), '结论声称未采集到任何数据，但本任务已有成功的工具结果');
  assert.strictEqual(needsAnswerRewrite(fake, false), null, '无工具产出时不拦');

  // 正常报告里标注个别子项失败属于合法内容
  const partial = '连接水位 151 正常。个别子项因权限不足未获取，已在下方注明原因。';
  assert.strictEqual(claimsZeroYield(partial), false);
  assert.strictEqual(needsAnswerRewrite(partial, true), null);
});

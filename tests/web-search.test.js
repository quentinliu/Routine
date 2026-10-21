'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  WebSearchServiceImpl,
  bingSearch,
  resetEngineMemory
} = require('../dist-main/main/services/webSearch.js');
const { initStorage, getStorage } = require('../dist-main/main/services/storage.js');

const BING_HTML = `
<html><body>
<li class="b_algo"><h2><a href="https://weather.com.cn/nj">南京天气预报</a></h2><div class="c-abstract"><p>南京明天晴，气温 12-22 度</p></div></li>
<li class="b_algo"><h2><a href="https://tianqi.com/nanjing">南京天气网</a></h2><p>未来一周南京天气趋势</p></li>
</body></html>`;



function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-websearch-'));
  initStorage(dir);
  try {
    return fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function writeSettings(dir, search) {
  fs.writeFileSync(
    path.join(dir, 'settings.json'),
    JSON.stringify({ search })
  );
}

function sseBody(text) {
  const encoder = new TextEncoder();
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(text));
        controller.close();
      }
    }),
    { status: 200, headers: { 'content-type': 'text/html' } }
  );
}

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), { status: 200 });
}

function stubFetch(handler) {
  const calls = [];
  globalThis.fetch = async (url, init) => {
    calls.push(String(url));
    return handler(url, init, calls);
  };
  return calls;
}

test('bingSearch 从结果页解析标题/链接/摘要', async () => {
  const restore = globalThis.fetch;
  globalThis.fetch = async () => sseBody(BING_HTML);
  try {
    const results = await bingSearch('南京天气', 5);
    assert.strictEqual(results.length, 2);
    assert.deepStrictEqual(results[0], {
      title: '南京天气预报',
      url: 'https://weather.com.cn/nj',
      snippet: '南京明天晴，气温 12-22 度'
    });
    assert.strictEqual(results[1].url, 'https://tianqi.com/nanjing');
  } finally {
    globalThis.fetch = restore;
  }
});

test('auto：无 Key 时使用必应且成功直接返回', async () => {
  resetEngineMemory();
  await withTmp(async (dir) => {
    writeSettings(dir, { provider: 'auto', tavilyApiKey: '' });
    const restore = globalThis.fetch;
    const calls = stubFetch((url) => {
      if (String(url).includes('cn.bing.com')) return sseBody(BING_HTML);
      return new Response('not found', { status: 404 });
    });
    try {
      const results = await new WebSearchServiceImpl().search('南京天气', 5);
      assert.strictEqual(results[0].title, '南京天气预报');
      assert.ok(calls.every((u) => u.includes('cn.bing.com')), '无 Key 的 auto 链只含必应');
    } finally {
      globalThis.fetch = restore;
    }
  });
});

test('auto：配置 Tavily Key 时优先使用 Tavily', async () => {
  resetEngineMemory();
  await withTmp(async (dir) => {
    writeSettings(dir, { provider: 'auto', tavilyApiKey: 'tvly-test' });
    const restore = globalThis.fetch;
    const calls = stubFetch((url) => {
      if (String(url).includes('api.tavily.com')) {
        return jsonResponse({ results: [{ title: 'T', url: 'https://t.com/1', content: 'C' }] });
      }
      return new Response('should not reach', { status: 500 });
    });
    try {
      const results = await new WebSearchServiceImpl().search('query', 5);
      assert.strictEqual(results[0].url, 'https://t.com/1');
      assert.ok(calls.every((u) => u.includes('api.tavily.com')), 'Tavily 成功后不应再调必应');
    } finally {
      globalThis.fetch = restore;
    }
  });
});

test('auto 链全部失败：错误信息指名各端点', async () => {
  await withTmp(async (dir) => {
    writeSettings(dir, { provider: 'auto', tavilyApiKey: '' });
    const restore = globalThis.fetch;
    globalThis.fetch = async () => new Response('err', { status: 500 });
    try {
      await assert.rejects(
        new WebSearchServiceImpl().search('query', 5),
        (err) => err.message.includes('cn.bing.com') && err.message.includes('Tavily')
      );
    } finally {
      globalThis.fetch = restore;
    }
  });
});

test('显式指定 bing 时只使用必应，不回退', async () => {
  await withTmp(async (dir) => {
    writeSettings(dir, { provider: 'bing', tavilyApiKey: '' });
    const restore = globalThis.fetch;
    const calls = stubFetch(() => new Response('err', { status: 500 }));
    try {
      await assert.rejects(new WebSearchServiceImpl().search('query', 5));
      assert.ok(calls.every((u) => u.includes('cn.bing.com')), '指定引擎失败后不得回退其他引擎');
      assert.strictEqual(calls.length, 1);
    } finally {
      globalThis.fetch = restore;
    }
  });
});

test('storage：旧配置 duckduckgo 与非法值迁移为 auto，tavily 保留', () => {
  return withTmp((dir) => {
    writeSettings(dir, { provider: 'duckduckgo', tavilyApiKey: '' });
    assert.strictEqual(getStorage().loadSettings().search.provider, 'auto');

    writeSettings(dir, { provider: 'whatever', tavilyApiKey: '' });
    assert.strictEqual(getStorage().loadSettings().search.provider, 'auto');

    writeSettings(dir, { provider: 'tavily', tavilyApiKey: 'k' });
    assert.strictEqual(getStorage().loadSettings().search.provider, 'tavily');
  });
});

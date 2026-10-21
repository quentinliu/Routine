'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { McpService } = require('../dist-main/main/services/mcp/manager.js');
const { initStorage } = require('../dist-main/main/services/storage.js');
const { validateMcpServer, mcpToolFullName, sanitizeSegment } = require('../dist-main/main/services/mcp/config.js');

const FIXTURE = path.join(__dirname, 'fixtures', 'mcp-echo-server.js');

function makeCtx(events) {
  return {
    emit: (e) => events.push(e),
    status: () => {},
    log: () => {},
    signal: new AbortController().signal
  };
}

function makeAutoApproveCtx(gate, events) {
  return {
    emit: (e) => {
      events.push(e);
      if (e.type === 'safety') {
        setTimeout(() => gate.resolveApproval(e.request.id, true), 5);
      }
    },
    status: () => {},
    log: () => {},
    signal: new AbortController().signal
  };
}

async function withTmp(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-mcp-'));
  initStorage(dir);
  const gate = new SafetyGate();
  const registry = new ToolRegistry(gate);
  const mcp = new McpService(registry);
  const logs = [];
  mcp.setLogFn((text, level) => logs.push({ text, level }));
  try {
    return await fn({ gate, registry, mcp, logs, dir });
  } finally {
    await mcp.dispose().catch(() => {});
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function echoServerConfig(over = {}) {
  return validateMcpServer({
    id: '',
    name: 'EchoSrv',
    enabled: true,
    transport: 'stdio',
    command: process.execPath,
    args: [FIXTURE],
    riskDefault: 'medium',
    autoConnect: false,
    ...over
  });
}

test('sanitizeSegment 满足 function calling 命名约束', () => {
  assert.strictEqual(sanitizeSegment('文件服务'), 'srv');
  assert.strictEqual(sanitizeSegment('fs server#1'), 'fs_server_1');
  assert.strictEqual(mcpToolFullName({ name: 'fs server' }, 'read.file'), 'mcp__fs_server__read_file');
});

test('validateMcpServer：stdio 必填命令、http 必填合法 URL', () => {
  assert.throws(
    () => validateMcpServer({ id: '', name: 'x', enabled: true, transport: 'stdio', command: '', riskDefault: 'medium', autoConnect: false }),
    /必须填写启动命令/
  );
  assert.throws(
    () => validateMcpServer({ id: '', name: 'x', enabled: true, transport: 'http', url: 'ftp://x', riskDefault: 'medium', autoConnect: false }),
    /http\/https/
  );
});

test('MCP 全链路：保存 → 连接发现工具 → 注册 → 经安全门执行 → 断开注销', async () => {
  await withTmp(async ({ gate, registry, mcp }) => {
    const saved = await mcp.save(echoServerConfig());
    assert.ok(saved.id, '保存时应生成 id');

    const info = await mcp.connect(saved.id);
    assert.strictEqual(info.state, 'connected');
    assert.deepStrictEqual(
      info.tools.map((t) => t.name).sort(),
      ['add', 'echo']
    );

    const fullName = mcpToolFullName(saved, 'echo');
    assert.ok(registry.get(fullName), '工具应注册进注册表');
    const def = registry.get(fullName);
    assert.strictEqual(def.agent, 'mcp');
    assert.strictEqual(def.risk, 'medium');
    assert.ok(def.inputSchema.properties.text, 'inputSchema 应来自 MCP server');

    const events = [];
    const pending = registry.execute(fullName, { text: 'hello' }, makeAutoApproveCtx(gate, events));
    await new Promise((r) => setTimeout(r, 30));
    const safetyEv = events.find((e) => e.type === 'safety');
    assert.ok(safetyEv, 'medium 工具应触发安全确认');
    assert.ok(safetyEv.request.actionSummary.includes('echo'));
    const result = await pending;
    assert.strictEqual(result, 'echo:hello');

    const addEvents = [];
    const addResult = await registry.execute(
      mcpToolFullName(saved, 'add'),
      { a: 2, b: 40 },
      makeAutoApproveCtx(gate, addEvents)
    );
    assert.strictEqual(addResult, 'sum:42');
    assert.ok(addEvents.some((e) => e.type === 'safety'), '每次调用均需确认');

    const after = await mcp.disconnect(saved.id);
    assert.strictEqual(after.state, 'disconnected');
    assert.ok(!registry.get(fullName), '断开后工具应注销');
    await assert.rejects(
      registry.execute(fullName, { text: 'x' }, makeCtx(events)),
      /未知工具/
    );
  });
});

test('riskDefault=safe 的 MCP 工具直接执行，不触发确认', async () => {
  await withTmp(async ({ registry, mcp }) => {
    const saved = await mcp.save(echoServerConfig({ name: 'SafeSrv', riskDefault: 'safe' }));
    await mcp.connect(saved.id);
    const events = [];
    const fullName = mcpToolFullName(saved, 'echo');
    const result = await registry.execute(fullName, { text: 'free' }, makeCtx(events));
    assert.strictEqual(result, 'echo:free');
    assert.ok(!events.some((e) => e.type === 'safety'), 'safe 工具不应触发确认');
  });
});

test('test() 对未保存配置做临时连接并返回工具清单', async () => {
  await withTmp(async ({ mcp }) => {
    const result = await mcp.test(echoServerConfig({ name: 'ProbeSrv' }));
    assert.strictEqual(result.ok, true);
    assert.strictEqual(result.toolCount, 2);
    assert.ok(result.latencyMs >= 0);
    assert.ok(result.tools.every((t) => t.fullName.startsWith('mcp__ProbeSrv__')));
  });
});

test('连接失败：错误命令进入 error 状态且不注册工具', async () => {
  await withTmp(async ({ registry, mcp, logs }) => {
    const saved = await mcp.save(
      echoServerConfig({ name: 'BrokenSrv', command: process.execPath, args: ['/nonexistent/mcp-server.js'] })
    );
    await assert.rejects(mcp.connect(saved.id), /Connection closed|MCP error|nonexistent|Cannot find module|失败/i);
    const info = mcp.list().find((s) => s.config.id === saved.id);
    assert.strictEqual(info.state, 'error');
    assert.ok(info.error);
    assert.strictEqual(
      registry.all().filter((d) => d.agent === 'mcp').length,
      0,
      '失败不得注册任何工具'
    );
    assert.ok(logs.some((l) => l.level === 'error'));
  });
});

test('删除服务：断连并移除配置', async () => {
  await withTmp(async ({ mcp }) => {
    const saved = await mcp.save(echoServerConfig());
    await mcp.connect(saved.id);
    await mcp.remove(saved.id);
    const list = mcp.list();
    assert.strictEqual(list.length, 0);
    await assert.rejects(mcp.connect(saved.id), /不存在/);
  });
});

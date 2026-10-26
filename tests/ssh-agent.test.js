'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');

const { resolveHostRef } = require('../dist-main/main/services/ssh/util.js');
const { SshService } = require('../dist-main/main/services/ssh/service.js');
const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { Orchestrator } = require('../dist-main/main/agent/orchestrator.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { createFileTools } = require('../dist-main/main/agent/tools/builtin/file.js');
const { createComputerTools } = require('../dist-main/main/agent/tools/builtin/computer.js');
const { createWebTools } = require('../dist-main/main/agent/tools/builtin/web.js');
const { createBrowserTools } = require('../dist-main/main/agent/tools/builtin/browser.js');
const { createSshTools } = require('../dist-main/main/agent/tools/builtin/ssh.js');
const { initStorage } = require('../dist-main/main/services/storage.js');
const { initMemory } = require('../dist-main/main/services/memory.js');
const {
  initConversationLog,
  getConversationLog
} = require('../dist-main/main/services/conversationLog.js');

const HOST_KEY = utils.generateKeyPairSync('ed25519');
const PASSWORD = 'pw-agent';

function hostRefs(over = []) {
  return [
    { id: 'id-a', name: '生产服务器', host: '10.0.0.1', port: 22, user: 'root', enabled: true },
    { id: 'id-b', name: 'NAS', host: '192.168.1.50', port: 22, user: 'admin', enabled: true },
    { id: 'id-c', name: '备用机', host: '10.0.0.9', port: 2222, user: 'ops', enabled: false },
    ...over
  ];
}

test('resolveHostRef 按 id / 名称（忽略大小写）/ user@host / 唯一模糊匹配解析', () => {
  const hosts = hostRefs();
  assert.strictEqual(resolveHostRef(hosts, 'id-b').name, 'NAS');
  assert.strictEqual(resolveHostRef(hosts, ' 生产服务器 ').name, '生产服务器');
  assert.strictEqual(resolveHostRef(hosts, 'nas').name, 'NAS');
  assert.strictEqual(resolveHostRef(hosts, 'root@10.0.0.1').name, '生产服务器');
  assert.strictEqual(resolveHostRef(hosts, '服务').name, '生产服务器');
});

test('resolveHostRef 拒绝空引用、多义匹配与未知主机', () => {
  const hosts = hostRefs([
    { id: 'id-d', name: '生产服务器2', host: '10.0.0.2', port: 22, user: 'root', enabled: true }
  ]);
  assert.throws(() => resolveHostRef(hosts, ''), /未指定主机/);
  assert.throws(() => resolveHostRef(hosts, '生产'), /匹配到多台/);
  assert.throws(() => resolveHostRef(hosts, '不存在'), /找不到主机/);
  assert.throws(() => resolveHostRef([], 'x'), /尚未配置任何 SSH 主机/);
});

function startFakeSshd() {
  const executed = [];
  const server = new Server({ hostKeys: [HOST_KEY.private] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.password === PASSWORD) ctx.accept();
      else ctx.reject(['password'], false);
    });
    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept();
        session.once('exec', (accept2, reject, info) => {
          executed.push(info.command);
          const stream = accept2();
          stream.write(`ran:${info.command}\n`);
          stream.exit(0);
          stream.end();
        });
      });
    });
  });
  server.on('error', () => {});
  server.listen(0, '127.0.0.1');
  return { server, executed };
}

function makeOrchestrator(svc, gate, script) {
  let step = 0;
  const events = [];
  const router = {
    getActive: async () => ({
      chatStream: async (_opts, _onDelta) => {
        const next = script[Math.min(step++, script.length - 1)];
        return { content: next };
      }
    })
  };
  const noop = {};
  const registry = new ToolRegistry(gate);
  registry.register(...createFileTools(noop));
  registry.register(...createComputerTools(noop));
  registry.register(...createWebTools(noop));
  registry.register(...createBrowserTools(noop));
  registry.register(...createSshTools(svc));
  const orch = new Orchestrator({ router, safety: gate, registry });
  return { orch, events };
}

async function runAgent(svc, gate, script) {
  const { orch, events } = makeOrchestrator(svc, gate, script);
  setTimeout(() => {
    const safetyEv = events.find((e) => e.type === 'safety');
    if (safetyEv) gate.resolveApproval(safetyEv.request.id, true);
  }, 20);
  const final = await orch.handleUserMessage('ses-test', '帮我在服务器上执行命令', (e) =>
    events.push(e)
  );
  return { final, events };
}

test('SSH Agent 全链路：规划 → 确认 → 远程执行 → 最终回答', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-agent-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-log-'));
  initStorage(dir);
  initMemory(dir);
  initConversationLog(logDir);
  const gate = new SafetyGate();
  const svc = new SshService();
  const { server, executed } = startFakeSshd();
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  svc.saveHost({
    id: '', name: '测试主机', host: '127.0.0.1', port, user: 'tester',
    authType: 'password', password: PASSWORD, enabled: true
  });

  try {
    const script = [
      '{"thought":"查看主机","action":{"tool":"ssh.hosts","args":{}},"final":null}',
      '{"thought":"执行命令","action":{"tool":"ssh.exec","args":{"host":"测试主机","command":"echo agent-ok"}},"final":null}',
      '{"thought":"完成","action":null,"final":"已在测试主机执行完毕"}'
    ];
    const { final, events } = await runAgent(svc, gate, script);

    assert.strictEqual(final, '已在测试主机执行完毕');
    assert.deepStrictEqual(executed, ['echo agent-ok']);

    const safetyEv = events.find((e) => e.type === 'safety');
    assert.ok(safetyEv, '应发出安全确认请求');
    assert.strictEqual(safetyEv.request.agent, 'ssh');
    assert.strictEqual(safetyEv.request.riskLevel, 'medium');
    assert.ok(safetyEv.request.actionSummary.includes('测试主机'));
    assert.ok(safetyEv.request.plan[0].includes('echo agent-ok'));

    const sshStatus = events.filter((e) => e.type === 'agent-status' && e.status.agent === 'ssh');
    assert.ok(sshStatus.some((s) => s.status.state === 'waiting-approval'));
    assert.ok(sshStatus.some((s) => s.status.state === 'acting'));

    // 留痕核查：确认决策与命令原文必须能在会话日志里复原
    const metas = getConversationLog().list();
    assert.strictEqual(metas.length, 1);
    const view = getConversationLog().read(metas[0].id);
    assert.ok(
      view.lines.some((l) => l.type === 'event' && String(l.text).includes('执行: echo agent-ok')),
      '工具进度提示应落对话日志，而不是挤进执行日志'
    );
    const safetyLine = view.lines.find((l) => l.type === 'safety');
    assert.ok(safetyLine, '审批结论必须落会话日志（此前完全没有 safety 行）');
    assert.strictEqual(safetyLine.tool, 'ssh.exec');
    assert.strictEqual(safetyLine.risk, 'medium');
    assert.strictEqual(safetyLine.outcome, 'approved');
    assert.ok(typeof safetyLine.waitMs === 'number', '应记录用户决策耗时');
    assert.ok(String(safetyLine.detail).includes('echo agent-ok'), '审批详情应含完整命令');

    const toolLine = view.lines.find((l) => l.type === 'tool' && l.name === 'ssh.exec');
    assert.ok(toolLine, '工具执行行应存在');
    assert.ok(typeof toolLine.approvalMs === 'number', '工具行应把审批耗时与执行耗时分开');
    assert.ok(
      String(toolLine.argsDigest).includes('echo agent-ok'),
      '参数摘要不得把命令截断掉'
    );
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('SSH Agent：用户拒绝确认后不执行且流程继续', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-agent-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-log-'));
  initStorage(dir);
  initMemory(dir);
  initConversationLog(logDir);
  const gate = new SafetyGate();
  const svc = new SshService();
  const { server, executed } = startFakeSshd();
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  svc.saveHost({
    id: '', name: '测试主机', host: '127.0.0.1', port, user: 'tester',
    authType: 'password', password: PASSWORD, enabled: true
  });

  try {
    const { orch, events } = makeOrchestrator(svc, gate, [
      '{"thought":"执行危险命令","action":{"tool":"ssh.exec","args":{"host":"测试主机","command":"rm -rf /tmp/x"}},"final":null}',
      '{"thought":"用户拒绝，改口","action":null,"final":"好的，已取消该操作"}'
    ]);
    setTimeout(() => {
      const safetyEv = events.find((e) => e.type === 'safety');
      if (safetyEv) gate.resolveApproval(safetyEv.request.id, false);
    }, 20);
    const final = await orch.handleUserMessage('ses-test', '删掉远端文件', (e) => events.push(e));

    assert.strictEqual(final, '好的，已取消该操作');
    assert.deepStrictEqual(executed, [], '被拒绝的命令不应到达远程主机');
    const failEv = events.find(
      (e) => e.type === 'trace' && e.event.phase === 'tool-end' && e.event.error === true
    );
    assert.ok(failEv, '工具失败应由执行过程的 tool-end error 标记（不再另写一条执行日志）');

    const metas = getConversationLog().list();
    const view = getConversationLog().read(metas[0].id);
    const safetyLine = view.lines.find((l) => l.type === 'safety');
    assert.ok(safetyLine, '拒绝也要留痕');
    assert.strictEqual(safetyLine.outcome, 'denied');
    const toolLine = view.lines.find((l) => l.type === 'tool' && l.name === 'ssh.exec');
    assert.strictEqual(toolLine.denied, true);
    assert.strictEqual(toolLine.ok, false);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('SSH Agent：确认超时不得伪装成「用户拒绝」', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-agent-'));
  const logDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-log-'));
  initStorage(dir);
  initMemory(dir);
  initConversationLog(logDir);
  const gate = new SafetyGate(30);
  const svc = new SshService();
  const { server, executed } = startFakeSshd();
  await new Promise((r) => server.on('listening', r));
  const port = server.address().port;
  svc.saveHost({
    id: '', name: '测试主机', host: '127.0.0.1', port, user: 'tester',
    authType: 'password', password: PASSWORD, enabled: true
  });

  try {
    const { orch } = makeOrchestrator(svc, gate, [
      '{"thought":"执行命令","action":{"tool":"ssh.exec","args":{"host":"测试主机","command":"uptime"}},"final":null}',
      '{"thought":"超时了","action":null,"final":"确认已超时，未执行"}'
    ]);
    await orch.handleUserMessage('ses-timeout', '看下负载', () => {});

    assert.deepStrictEqual(executed, [], '超时后不得执行远程命令');
    const metas = getConversationLog().list();
    const view = getConversationLog().read(metas[0].id);
    const safetyLine = view.lines.find((l) => l.type === 'safety');
    assert.strictEqual(safetyLine.outcome, 'timeout', '无人响应应记为 timeout 而不是 denied');
    const toolLine = view.lines.find((l) => l.type === 'tool' && l.name === 'ssh.exec');
    assert.strictEqual(toolLine.timedOut, true);
    assert.notStrictEqual(toolLine.denied, true, '超时不能被打上 denied 标记');
    assert.match(String(toolLine.resultDigest), /等待确认超时/, '回灌给模型的应是超时文案');
    assert.doesNotMatch(String(toolLine.resultDigest), /用户拒绝了该工具调用/);
  } finally {
    server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(logDir, { recursive: true, force: true });
  }
});

test('主机清单不常驻系统提示词，改为运行时上下文快照', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-agent-'));
  initStorage(dir);
  initMemory(dir);
  const svc = new SshService();
  svc.saveHost({
    id: '', name: '生产服务器', host: '10.1.1.1', port: 22, user: 'root',
    authType: 'password', password: 'x', enabled: true
  });
  const { orch } = makeOrchestrator(svc, new SafetyGate(), []);
  const sys = orch.planningSystem();
  assert.ok(sys.includes('ssh.exec'), '工具清单仍应包含 ssh.exec');
  assert.ok(!sys.includes('生产服务器'), '易变主机清单不应进入系统提示词');

  const snapshot = orch.runtimeSnapshot();
  assert.ok(snapshot.startsWith('[运行时上下文]'));
  assert.ok(snapshot.includes('生产服务器'));
  assert.ok(snapshot.includes('root@10.1.1.1:22'));
  fs.rmSync(dir, { recursive: true, force: true });
});

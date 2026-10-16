'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');

const {
  clampConnectTimeoutMs,
  clampExecOptions,
  targetLabel,
  validateSshCommand,
  validateSshHost
} = require('../dist-main/main/services/ssh/util.js');
const { SshService } = require('../dist-main/main/services/ssh/service.js');
const { initStorage } = require('../dist-main/main/services/storage.js');

function host(over = {}) {
  return {
    id: '',
    name: '测试主机',
    host: '127.0.0.1',
    port: 22,
    user: 'root',
    authType: 'password',
    password: 'secret',
    enabled: true,
    ...over
  };
}

function closedPort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

test('clampConnectTimeoutMs 钳制与默认值', () => {
  assert.strictEqual(clampConnectTimeoutMs(undefined), 10_000);
  assert.strictEqual(clampConnectTimeoutMs(Number.NaN), 10_000);
  assert.strictEqual(clampConnectTimeoutMs(0), 1_000);
  assert.strictEqual(clampConnectTimeoutMs(1_500.9), 1_500);
  assert.strictEqual(clampConnectTimeoutMs(999_999), 60_000);
});

test('clampExecOptions 钳制与默认值', () => {
  assert.deepStrictEqual(clampExecOptions(), { timeoutMs: 30_000, maxOutputBytes: 524_288 });
  assert.deepStrictEqual(clampExecOptions({ timeoutMs: 1, maxOutputBytes: 1 }), {
    timeoutMs: 1_000,
    maxOutputBytes: 1_024
  });
  assert.deepStrictEqual(clampExecOptions({ timeoutMs: 10 ** 9, maxOutputBytes: 10 ** 9 }), {
    timeoutMs: 300_000,
    maxOutputBytes: 10_485_760
  });
});

test('targetLabel 输出 user@host:port', () => {
  assert.strictEqual(targetLabel(host()), 'root@127.0.0.1:22');
});

test('validateSshHost 校验必填字段', () => {
  assert.throws(() => validateSshHost(host({ name: '  ' })), /名称不能为空/);
  assert.throws(() => validateSshHost(host({ host: '' })), /地址不能为空/);
  assert.throws(() => validateSshHost(host({ host: 'a b' })), /空白字符/);
  assert.throws(() => validateSshHost(host({ port: 0 })), /端口/);
  assert.throws(() => validateSshHost(host({ port: 70_000 })), /端口/);
  assert.throws(() => validateSshHost(host({ port: Number.NaN })), /端口/);
  assert.throws(() => validateSshHost(host({ user: '' })), /用户名/);
  assert.throws(() => validateSshHost(host({ authType: 'agent' })), /认证方式/);
  assert.throws(() => validateSshHost(host({ password: '' })), /密码/);
  assert.throws(() => validateSshHost(host({ authType: 'key', password: 'x' })), /私钥路径/);
});

test('validateSshHost 归一化字段并保留合法值', () => {
  const v = validateSshHost(
    host({ name: ' 主机 A ', user: ' admin ', timeoutMs: 1, enabled: undefined })
  );
  assert.strictEqual(v.name, '主机 A');
  assert.strictEqual(v.user, 'admin');
  assert.strictEqual(v.timeoutMs, 1_000);
  assert.strictEqual(v.enabled, true);
  const key = validateSshHost(
    host({ authType: 'key', password: '', privateKeyPath: '~/.ssh/id_rsa' })
  );
  assert.strictEqual(key.privateKeyPath, '~/.ssh/id_rsa');
});

test('validateSshCommand 去空白、拒绝空与超长命令', () => {
  assert.strictEqual(validateSshCommand('  uname -a  '), 'uname -a');
  assert.throws(() => validateSshCommand('   '), /命令不能为空/);
  assert.throws(() => validateSshCommand('x'.repeat(8_193)), /命令过长/);
  assert.strictEqual(validateSshCommand('x'.repeat(8_192)), 'x'.repeat(8_192));
});

test('SshService.saveHost 新增与更新（持久化到 ssh-hosts.json）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-test-'));
  initStorage(dir);
  const service = new SshService();

  assert.strictEqual(service.listHosts().length, 0);

  const saved = service.saveHost(host({ name: 'A' }));
  assert.ok(saved.id);
  const saved2 = service.saveHost(host({ name: 'B' }));
  assert.notStrictEqual(saved.id, saved2.id);
  assert.strictEqual(service.listHosts().length, 2);

  service.saveHost(host({ id: saved.id, name: 'A2' }));
  const after = service.listHosts();
  assert.strictEqual(after.length, 2);
  assert.strictEqual(after.find((h) => h.id === saved.id).name, 'A2');

  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'ssh-hosts.json'), 'utf-8'));
  assert.strictEqual(onDisk.length, 2);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SshService.deleteHost 删除不存在的主机报错', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-test-'));
  initStorage(dir);
  const service = new SshService();
  const saved = service.saveHost(host());
  service.deleteHost(saved.id);
  assert.strictEqual(service.listHosts().length, 0);
  assert.throws(() => service.deleteHost('missing'), /主机不存在/);
  fs.rmSync(dir, { recursive: true, force: true });
});

test('SSH 不可达端口：错误信息含 user@host:port 与原因', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-test-'));
  initStorage(dir);
  const service = new SshService();
  const port = await closedPort();
  const saved = service.saveHost(host({ port }));
  await assert.rejects(
    service.testHost(saved.id),
    (err) => err.message.includes(`root@127.0.0.1:${port}`) && err.message.includes('连接失败')
  );
  await assert.rejects(
    service.exec(saved.id, 'uname -a'),
    (err) => err.message.includes(`root@127.0.0.1:${port}`)
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

test('exec 拒绝禁用主机与空命令', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-test-'));
  initStorage(dir);
  const service = new SshService();
  const saved = service.saveHost(host({ enabled: false }));
  await assert.rejects(service.exec(saved.id, 'ls'), /已禁用/);
  const enabled = service.saveHost(host({ name: '启用' }));
  await assert.rejects(service.exec(enabled.id, '  '), /命令不能为空/);
  fs.rmSync(dir, { recursive: true, force: true });
});

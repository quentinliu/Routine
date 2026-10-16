'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Server, utils } = require('ssh2');

const { initStorage } = require('../dist-main/main/services/storage.js');
const { getSshService } = require('../dist-main/main/services/ssh/service.js');

const HOST_KEY = utils.generateKeyPairSync('ed25519');
const PASSWORD = 'pw-12345';

function startFakeSshd(handler) {
  return new Promise((resolve) => {
    const server = new Server({ hostKeys: [HOST_KEY.private] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.password === PASSWORD) ctx.accept();
        else ctx.reject(['password'], false);
      });
      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept();
          session.once('exec', (accept2, reject, info) => handler(accept2, info.command));
        });
      });
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

function withService(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-ssh-e2e-'));
  initStorage(dir);
  const svc = getSshService();
  return run(svc).finally(() => fs.rmSync(dir, { recursive: true, force: true }));
}

function saveHost(svc, over = {}) {
  return svc.saveHost({
    id: '', name: '伪 sshd', host: '127.0.0.1', port: 0, user: 'tester',
    authType: 'password', password: PASSWORD, enabled: true,
    ...over
  });
}

test('SSH E2E：连接测试返回远端标识', async () => {
  await withService(async (svc) => {
    const { server, port } = await startFakeSshd((accept2) => {
      const stream = accept2();
      stream.exit(0);
      stream.end();
    });
    try {
      const saved = saveHost(svc, { port });
      const t = await svc.testHost(saved.id);
      assert.strictEqual(t.ok, true);
      assert.ok(t.banner.startsWith('SSH-2.0-'), `banner: ${t.banner}`);
    } finally {
      server.close();
    }
  });
});

test('SSH E2E：exec 捕获 stdout/stderr 与退出码', async () => {
  await withService(async (svc) => {
    const { server, port } = await startFakeSshd((accept2, command) => {
      const stream = accept2();
      if (command.includes('fail-me')) {
        stream.stderr.write('boom\n');
        stream.exit(7);
        stream.end();
        return;
      }
      stream.write('hello\n');
      stream.stderr.write('warn\n');
      stream.exit(0);
      stream.end();
    });
    try {
      const saved = saveHost(svc, { port });
      const ok = await svc.exec(saved.id, 'echo hi');
      assert.deepStrictEqual(
        { ok: ok.ok, code: ok.code, stdout: ok.stdout, stderr: ok.stderr, truncated: ok.truncated },
        { ok: true, code: 0, stdout: 'hello\n', stderr: 'warn\n', truncated: false }
      );
      const bad = await svc.exec(saved.id, 'fail-me');
      assert.strictEqual(bad.ok, false);
      assert.strictEqual(bad.code, 7);
      assert.strictEqual(bad.stderr, 'boom\n');
    } finally {
      server.close();
    }
  });
});

test('SSH E2E：输出超过 maxOutputBytes 被截断', async () => {
  await withService(async (svc) => {
    const big = 'x'.repeat(2048);
    const { server, port } = await startFakeSshd((accept2) => {
      const stream = accept2();
      for (let i = 0; i < 16; i++) stream.write(big);
      stream.exit(0);
      stream.end();
    });
    try {
      const saved = saveHost(svc, { port });
      const r = await svc.exec(saved.id, 'cat big', { maxOutputBytes: 4096 });
      assert.strictEqual(r.truncated, true);
      assert.strictEqual(Buffer.byteLength(r.stdout), 4096);
    } finally {
      server.close();
    }
  });
});

test('SSH E2E：错误密码与不可达端口均明确报错', async () => {
  await withService(async (svc) => {
    const { server, port } = await startFakeSshd((accept2) => {
      const stream = accept2();
      stream.exit(0);
      stream.end();
    });
    try {
      const wrong = saveHost(svc, { name: '错误密码', port, password: 'wrong' });
      await assert.rejects(
        svc.testHost(wrong.id),
        (err) => err.message.includes('连接失败') && err.message.includes('authentication')
      );
      const dead = saveHost(svc, { name: '不可达', port: 1 });
      await assert.rejects(
        svc.exec(dead.id, 'ls'),
        (err) => err.message.includes('tester@127.0.0.1:1') && err.message.includes('连接失败')
      );
    } finally {
      server.close();
    }
  });
});

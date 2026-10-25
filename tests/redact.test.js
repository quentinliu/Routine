'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { redactSecrets, omitSecretFields } = require('../dist-main/main/util/redact.js');
const { initStorage } = require('../dist-main/main/services/storage.js');
const { getDbService } = require('../dist-main/main/services/db/service.js');
const { createDbTools } = require('../dist-main/main/agent/tools/builtin/db.js');

test('redactSecrets：命中字段置空串，且不修改入参', () => {
  const source = { id: 'a', user: 'root', password: 'secret' };
  const masked = redactSecrets(source, ['password']);
  assert.deepStrictEqual(masked, { id: 'a', user: 'root', password: '' });
  assert.strictEqual(source.password, 'secret', '不应改动原对象');
});

test('redactSecrets：默认密钥清单覆盖 token/apiKey 等字段', () => {
  const masked = redactSecrets({ token: 't', apiKey: 'k', name: 'n' });
  assert.deepStrictEqual(masked, { token: '', apiKey: '', name: 'n' });
});

test('omitSecretFields：整键移除，深层与数组同样生效', () => {
  const source = {
    hosts: [{ name: 'h1', password: 'p', nested: { passphrase: 'x', port: 22 } }],
    keep: true
  };
  const safe = omitSecretFields(source);
  assert.deepStrictEqual(safe, { hosts: [{ name: 'h1', nested: { port: 22 } }], keep: true });
  assert.strictEqual(source.hosts[0].password, 'p', '不应改动原对象');
});

test('db.list 工具结果不含密码字段（避免模型误读为空凭据）', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-redact-'));
  initStorage(dir);
  try {
    getDbService().save({
      id: '',
      name: '生产库',
      type: 'mysql',
      host: '10.0.0.1',
      port: 3306,
      user: 'root',
      password: 'pw',
      enabled: true
    });
    const tool = createDbTools().find((d) => d.name === 'db.list');
    return tool.execute({}, {}).then((rows) => {
      assert.strictEqual(rows.length, 1);
      assert.ok(!('password' in rows[0]), '工具结果不应携带 password 字段');
      assert.strictEqual(rows[0].name, '生产库');
      assert.ok(tool.render(rows).includes('生产库'), '渲染结果应可读');
    });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert');

const {
  normalizeRefs,
  resolveRefs,
  assertDatasourceAllowed,
  assertSshHostAllowed,
  sshScopeTarget
} = require('../dist-main/main/agent/resources.js');
const { SafetyGate } = require('../dist-main/main/agent/safety.js');
const { ToolRegistry } = require('../dist-main/main/agent/tools/registry.js');
const { createDbTools } = require('../dist-main/main/agent/tools/builtin/db.js');
const { createSshTools } = require('../dist-main/main/agent/tools/builtin/ssh.js');

const DATASOURCES = [
  {
    id: 'ds-prod',
    name: '生产库',
    type: 'mysql',
    host: '10.0.8.12',
    port: 3306,
    user: 'routine',
    password: 'enc:SECRET',
    database: 'orders',
    enabled: true
  },
  {
    id: 'ds-off',
    name: '停用库',
    type: 'postgresql',
    host: '10.0.8.21',
    port: 5432,
    user: 'readonly',
    password: 'enc:SECRET2',
    enabled: false
  }
];

const HOSTS = [
  {
    id: 'ssh-web1',
    name: 'web-01',
    host: '10.0.8.31',
    port: 22,
    user: 'root',
    authType: 'key',
    privateKeyPath: '~/.ssh/id_ed25519',
    enabled: true
  },
  {
    id: 'ssh-off',
    name: '旧主机',
    host: '10.0.8.41',
    port: 22,
    user: 'ops',
    authType: 'password',
    password: 'enc:SSH',
    enabled: false
  }
];

const LOOKUP = { datasources: DATASOURCES, sshHosts: HOSTS };

function ctx(scope, events = []) {
  return {
    sessionId: 's1',
    msgId: 'm1',
    emit: (e) => events.push(e),
    status: () => {},
    log: () => {},
    signal: new AbortController().signal,
    scope
  };
}

test('normalizeRefs：非法形状丢弃、按 kind+id 去重、label 回退 id、上限 10 条', () => {
  const raw = [
    { kind: 'datasource', id: 'ds-1', label: '库一' },
    { kind: 'datasource', id: 'ds-1', label: '重复项' },
    { kind: 'nope', id: 'x', label: '非法类别' },
    { kind: 'sshHost', id: '  ', label: '空 id' },
    { kind: 'sshHost', id: 'ssh-1' },
    null,
    'string'
  ];
  const refs = normalizeRefs(raw);
  assert.equal(refs.length, 2);
  assert.deepEqual(refs[0], { kind: 'datasource', id: 'ds-1', label: '库一' });
  assert.equal(refs[1].label, 'ssh-1', 'label 缺省回退 id');

  const many = Array.from({ length: 15 }, (_, i) => ({
    kind: 'datasource',
    id: `ds-${i}`,
    label: `库${i}`
  }));
  assert.equal(normalizeRefs(many).length, 10);
  assert.deepEqual(normalizeRefs('not-array'), []);
});

test('resolveRefs：按当前配置过滤已删除/已禁用，只保留有效目标进 scope', () => {
  const refs = normalizeRefs([
    { kind: 'datasource', id: 'ds-prod', label: '生产库' },
    { kind: 'datasource', id: 'ds-off', label: '停用库' },
    { kind: 'datasource', id: 'ds-gone', label: '已删库' },
    { kind: 'sshHost', id: 'ssh-web1', label: 'web-01' }
  ]);
  const resolved = resolveRefs(refs, LOOKUP);

  assert.deepEqual(
    resolved.scope.datasources.map((t) => t.id),
    ['ds-prod']
  );
  assert.deepEqual(
    resolved.scope.sshHosts.map((t) => t.id),
    ['ssh-web1']
  );
  const reasons = resolved.invalid.map((i) => `${i.ref.id}:${i.reason}`).sort();
  assert.deepEqual(reasons, ['ds-gone:数据源已删除', 'ds-off:数据源已禁用']);

  assert.ok(resolved.block.includes('生产库'), '有效项应出现在快照块');
  assert.ok(resolved.block.includes('id=ds-prod'));
  assert.ok(resolved.block.includes('web-01'));
  assert.ok(resolved.block.includes('datasourceId 只能取上面的数据源 id'));
  assert.ok(resolved.block.includes('host 只能取上面的主机名称或 id'));
  assert.ok(resolved.block.includes('已失效的引用'));
  assert.ok(!resolved.block.includes('enc:SECRET'), '快照块不得含凭据');
  assert.ok(!resolved.block.includes('privateKeyPath'));

  const onlyHost = resolveRefs(normalizeRefs([{ kind: 'sshHost', id: 'ssh-web1' }]), LOOKUP);
  assert.ok(!onlyHost.block.includes('datasourceId'), '未引用数据源时不得声明数据源限制');
});

test('resolveRefs：某类引用全部失效时该类不限制，并给出显式说明', () => {
  const resolved = resolveRefs(
    normalizeRefs([{ kind: 'datasource', id: 'ds-gone', label: '已删库' }]),
    LOOKUP
  );
  assert.deepEqual(resolved.scope.datasources, []);
  assert.deepEqual(resolved.scope.sshHosts, []);
  assert.ok(resolved.block.includes('均已失效'));
  assert.ok(resolved.block.includes('不限制'));
});

test('assertDatasourceAllowed：未引用 = 放行；引用越界抛可自纠错误', () => {
  assert.doesNotThrow(() => assertDatasourceAllowed(undefined, 'any-id'));
  assert.doesNotThrow(() => assertDatasourceAllowed({ datasources: [] }, 'any-id'));

  const scope = { datasources: [{ id: 'ds-prod', label: '生产库' }] };
  assert.doesNotThrow(() => assertDatasourceAllowed(scope, 'ds-prod'));
  assert.throws(
    () => assertDatasourceAllowed(scope, 'ds-other'),
    (err) => {
      assert.ok(err.message.includes('ds-other'));
      assert.ok(err.message.includes('ds-prod'), '错误文案要列出允许项');
      assert.ok(err.message.includes('未执行'));
      return true;
    }
  );
});

test('assertSshHostAllowed：按解析后的主机 id 比对（名称/模糊匹配不能绕过）', () => {
  const scope = { sshHosts: [{ id: 'ssh-web1', label: 'web-01 root@10.0.8.31:22' }] };
  const allowed = sshScopeTarget(HOSTS[0]);
  assert.doesNotThrow(() => assertSshHostAllowed(scope, allowed));
  assert.doesNotThrow(() => assertSshHostAllowed(undefined, sshScopeTarget(HOSTS[1])));

  assert.throws(
    () => assertSshHostAllowed(scope, sshScopeTarget(HOSTS[1])),
    /旧主机[\s\S]*不在引用范围内/
  );
});

test('registry：scope 越界在校验阶段直接失败，不产生审批请求', async () => {
  const gate = new SafetyGate();
  const registry = new ToolRegistry(gate);
  registry.register(...createDbTools());
  const events = [];
  const base = ctx({ datasources: [{ id: 'ds-prod', label: '生产库' }] }, events);

  await assert.rejects(
    () => registry.execute('db.exec', { datasourceId: 'ds-other', sql: 'KILL 1', reason: 't' }, base),
    /不在引用范围内/
  );
  await assert.rejects(
    () => registry.execute('db.query', { datasourceId: 'ds-other', sql: 'SELECT 1' }, base),
    /不在引用范围内/
  );
  assert.equal(events.length, 0, 'safe 工具同样被拦住，且不进入执行');
});

test('ssh.exec 校验：非引用主机在审批前报错（不产生确认请求）', async () => {
  const gate = new SafetyGate();
  const registry = new ToolRegistry(gate);
  const ssh = { listHosts: () => HOSTS, exec: async () => ({}) };
  registry.register(...createSshTools(ssh));

  const scope = { sshHosts: [sshScopeTarget(HOSTS[0])] };
  await assert.rejects(
    () => registry.execute('ssh.exec', { host: '旧主机', command: 'uptime' }, ctx(scope)),
    /不在引用范围内/
  );
});

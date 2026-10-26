const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseSkillMd, loadSkillDir, scanSkillRoot, resolveSkillFile } = require('../dist-main/main/skills/loader');
const { SkillRegistry } = require('../dist-main/main/skills/registry');
const { assertReadOnlySql } = require('../dist-main/main/services/db/service');

function mkSkillDir(root, name, { version, engine, scripts, refs } = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(dir, { recursive: true });
  const meta = [];
  if (version) meta.push(`  version: "${version}"`);
  if (engine) meta.push(`  engine: "${engine}"`);
  const frontmatter = [
    '---',
    `name: ${name}`,
    `description: Test skill ${name} for slow query diagnosis. Use when tuning databases.`,
    ...(meta.length ? ['metadata:'] : []),
    ...meta,
    '---',
    '',
    `# ${name}`,
    '',
    'Step 1. Run SELECT 1.'
  ].join('\n');
  fs.writeFileSync(path.join(dir, 'SKILL.md'), frontmatter);
  if (scripts) fs.mkdirSync(path.join(dir, 'scripts'));
  for (const ref of refs ?? []) {
    fs.mkdirSync(path.join(dir, path.dirname(ref)), { recursive: true });
    fs.writeFileSync(path.join(dir, ref), 'ref content');
  }
  return dir;
}

test('parseSkillMd: 合法 frontmatter 与正文分离', () => {
  const raw = '---\nname: slow-query\ndescription: Diagnose slow queries.\n---\n\n# Body\nstep 1';
  const { frontmatter, body } = parseSkillMd(raw, 'slow-query');
  assert.strictEqual(frontmatter.name, 'slow-query');
  assert.match(body, /# Body/);
  assert.doesNotMatch(body, /^---/);
});

test('parseSkillMd: name 与目录不一致抛错', () => {
  const raw = '---\nname: other-name\ndescription: x\n---\nbody';
  assert.throws(() => parseSkillMd(raw, 'slow-query'), /必须与目录名/);
});

test('parseSkillMd: 大写或非法 name 抛错', () => {
  assert.throws(
    () => parseSkillMd('---\nname: Bad--Name\ndescription: x\n---\n', 'Bad--Name'),
    /不符合规范/
  );
});

test('parseSkillMd: 缺 description 抛错', () => {
  assert.throws(
    () => parseSkillMd('---\nname: ok-name\n---\nbody', 'ok-name'),
    /缺少 description/
  );
});

test('loadSkillDir: version/engine/partial/files 解析', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const dir = mkSkillDir(root, 'my-db-skill', {
    version: '1.2.0',
    engine: 'mysql',
    scripts: true,
    refs: ['references/lock.md']
  });
  const skill = loadSkillDir(dir, 'builtin');
  assert.strictEqual(skill.info.version, '1.2.0');
  assert.strictEqual(skill.info.engine, 'mysql');
  assert.strictEqual(skill.info.partial, true);
  assert.deepStrictEqual(skill.files, ['references/lock.md']);
  fs.rmSync(root, { recursive: true, force: true });
});

test('loadSkillDir: 顶层 version 作为 metadata.version 的回退', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const dir = path.join(root, 'flat-version');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    '---\nname: flat-version\nversion: 2.3.0\ndescription: Flat version skill.\n---\n\n# body'
  );
  assert.strictEqual(loadSkillDir(dir, 'builtin').info.version, '2.3.0');
  fs.rmSync(root, { recursive: true, force: true });
});

test('scanSkillRoot: 跳过非法目录并上报，合法目录正常收集', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  mkSkillDir(root, 'good-skill', {});
  fs.mkdirSync(path.join(root, 'bad-skill'));
  fs.writeFileSync(path.join(root, 'bad-skill', 'SKILL.md'), 'no frontmatter');
  const { skills, errors } = scanSkillRoot(root, 'user');
  assert.strictEqual(skills.length, 1);
  assert.strictEqual(skills[0].info.name, 'good-skill');
  assert.strictEqual(errors.length, 1);
  assert.strictEqual(errors[0].dir, 'bad-skill');
  fs.rmSync(root, { recursive: true, force: true });
});

test('SkillRegistry: 用户根覆盖内置根，overrides 控制启停', () => {
  const builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-builtin-'));
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-user-'));
  mkSkillDir(builtinRoot, 'mysql', { version: '1.0.0' });
  mkSkillDir(userRoot, 'mysql', { version: '2.0.0' });
  mkSkillDir(userRoot, 'custom', {});
  const registry = new SkillRegistry(builtinRoot, userRoot, () => ({ mysql: false }));
  const list = registry.list();
  assert.strictEqual(list.length, 2);
  const mysql = list.find((s) => s.name === 'mysql');
  assert.strictEqual(mysql.source, 'user');
  assert.strictEqual(mysql.version, '2.0.0');
  assert.strictEqual(mysql.enabled, false);
  const custom = list.find((s) => s.name === 'custom');
  assert.strictEqual(custom.enabled, true);
  assert.throws(() => registry.requireEnabled('mysql'), /已停用/);
  assert.strictEqual(registry.requireEnabled('custom').info.name, 'custom');
  fs.rmSync(builtinRoot, { recursive: true, force: true });
  fs.rmSync(userRoot, { recursive: true, force: true });
});

test('SkillRegistry: remove 仅允许用户技能', () => {
  const builtinRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-builtin-'));
  const userRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-user-'));
  mkSkillDir(builtinRoot, 'builtin-skill', {});
  mkSkillDir(userRoot, 'user-skill', {});
  const registry = new SkillRegistry(builtinRoot, userRoot, () => ({}));
  assert.throws(() => registry.remove('builtin-skill'), /不可删除/);
  registry.remove('user-skill');
  assert.strictEqual(registry.get('user-skill'), null);
  fs.rmSync(builtinRoot, { recursive: true, force: true });
  fs.rmSync(userRoot, { recursive: true, force: true });
});

test('resolveSkillFile: 拒绝路径穿越与非普通文件', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-'));
  const dir = mkSkillDir(root, 's', { refs: ['references/a.md'] });
  assert.throws(() => resolveSkillFile(dir, '../escape.md'), /非法路径/);
  assert.throws(() => resolveSkillFile(dir, '/abs.md'), /非法路径/);
  assert.throws(() => resolveSkillFile(dir, 'SKILL.md'), /skill\.run/);
  assert.doesNotThrow(() => resolveSkillFile(dir, 'references/a.md'));
  fs.rmSync(root, { recursive: true, force: true });
});

test('assertReadOnlySql: 白名单首词 + 多语句 + 写锁拒绝', () => {
  assert.doesNotThrow(() => assertReadOnlySql('SELECT * FROM t'));
  assert.doesNotThrow(() => assertReadOnlySql('  show global status;'));
  assert.doesNotThrow(() => assertReadOnlySql('explain analyze select 1'));
  assert.throws(() => assertReadOnlySql('update t set a=1'), /只读模式不允许/);
  assert.throws(() => assertReadOnlySql('kill 12'), /只读模式不允许/);
  assert.throws(() => assertReadOnlySql('select 1; drop table t'), /单条语句/);
  assert.throws(() => assertReadOnlySql('select * from t for update'), /FOR UPDATE/);
  assert.throws(() => assertReadOnlySql('select * from t lock in share mode'), /LOCK IN SHARE MODE/);
  assert.throws(() => assertReadOnlySql("select * into outfile '/tmp/x' from t"), /INTO OUTFILE/);
  assert.throws(() => assertReadOnlySql('select sleep(100)'), /sleep/);
  assert.throws(() => assertReadOnlySql('   '), /不能为空/);
});

test('内置资源包: resources/skills 下技能均通过规范校验', () => {
  const root = path.join(__dirname, '..', 'resources', 'skills');
  const { skills, errors } = scanSkillRoot(root, 'builtin');
  assert.deepStrictEqual(errors, []);
  const names = skills.map((s) => s.info.name).sort();
  assert.deepStrictEqual(names, [
    'mysql-batch-health-check',
    'mysql-capacity-early-warning',
    'mysql-deadlock-analyzer',
    'mysql-replication-lag-resolver',
    'mysql-schema-linter',
    'mysql-slow-query-diagnose',
    'postgres'
  ]);
  // PlanetScale 的通用 mysql 手册已移除，避免与 OpenOcta DB Ops 技能包语义重叠
  assert.ok(!names.includes('mysql'));

  const postgres = skills.find((s) => s.info.name === 'postgres');
  assert.strictEqual(postgres.info.version, '1.0.0');
  assert.ok(postgres.files.length >= 20, `postgres references 应不少于 20 个，实际 ${postgres.files.length}`);

  for (const skill of skills.filter((s) => s.info.name.startsWith('mysql-'))) {
    assert.strictEqual(skill.info.version, '1.0.0', `${skill.info.name} 版本应取自顶层 version`);
    assert.strictEqual(skill.info.partial, false, `${skill.info.name} 不含 scripts，不应标记部分兼容`);
    assert.ok(skill.body.includes('##'), `${skill.info.name} 正文应含章节标题`);
  }
});

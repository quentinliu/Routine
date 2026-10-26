'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { initStorage, getStorage } = require('../dist-main/main/services/storage.js');
const { createSkillTools } = require('../dist-main/main/agent/tools/builtin/skill.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routine-skill-tools-'));
}

const SKILL = {
  info: { name: 'demo', version: '1.0.0', partial: false },
  body: '# 手册正文\n第一步：采集指标。',
  files: ['references/a.md']
};

function fakeRegistry(over = {}) {
  return {
    requireEnabled(name) {
      if (name === 'demo') return SKILL;
      throw new Error(`技能不存在: ${name}`);
    },
    list: () => [{ name: 'demo' }, { name: 'other' }],
    ...over
  };
}

function runTool(tools, name, args) {
  const def = tools.find((t) => t.name === name);
  return def.execute(args, { log: () => {} });
}

test('D 校验顺序：技能名错误时优先报技能不存在并附可用清单（即使缺 datasourceId）', async () => {
  initStorage(tmpDir());
  const tools = createSkillTools(fakeRegistry());
  await assert.rejects(
    () => runTool(tools, 'skill.run', { skill: 'nope' }),
    /技能不存在: nope.*可用技能：demo、other/s
  );
});

test('技能存在但缺 datasourceId 时报参数缺失', async () => {
  initStorage(tmpDir());
  const tools = createSkillTools(fakeRegistry());
  await assert.rejects(() => runTool(tools, 'skill.run', { skill: 'demo' }), /缺少 datasourceId/);
});

test('F 适配头含术语映射、\\G 禁令、单实例指引与不放弃规约', async () => {
  initStorage(tmpDir());
  getStorage().saveDatasources([
    {
      id: 'ds-1',
      name: 'mysql',
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'r',
      password: '',
      enabled: true
    }
  ]);
  const tools = createSkillTools(fakeRegistry());
  const result = await runTool(tools, 'skill.run', { skill: 'demo', datasourceId: 'ds-1' });
  assert.ok(result.content.includes('db_query、db_get_status、db_get_variable'));
  assert.ok(result.content.includes('\\G'));
  assert.ok(result.content.includes('单数据源执行'));
  assert.ok(result.content.includes('不要整体放弃'));
  assert.ok(result.content.includes('【技能正文】'));
  assert.deepStrictEqual(result.references, ['references/a.md']);
});

test('F2 适配头：主机指标用 ssh.exec 采集，不再断言「没有 shell」，并给出并行与基线约束', async () => {
  initStorage(tmpDir());
  getStorage().saveDatasources([
    {
      id: 'ds-1',
      name: 'mysql',
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'r',
      password: '',
      enabled: true
    }
  ]);
  const tools = createSkillTools(fakeRegistry());
  const result = await runTool(tools, 'skill.run', { skill: 'demo', datasourceId: 'ds-1' });
  assert.ok(result.content.includes('ssh.exec'), '磁盘/内存等主机指标应明确用 ssh.exec');
  assert.ok(!result.content.includes('本环境没有 shell'), '不应再给「完全没有 shell」的绝对结论');
  assert.ok(result.content.includes('actions 在同一轮并行提交'), '应允许同类只读查询并行');
  assert.ok(result.content.includes('系统库（mysql、information_schema'), '清单类查询需排除系统库');
  assert.ok(result.content.includes('没有历史基线时只做本期快照判断'), '禁止编造趋势');
  assert.ok(result.content.includes('0 行'), '0 行结果需先复核');
});

test('E 长手册只返回开篇概览 + 章节清单，正文用 skill.read 按章取用', async () => {
  initStorage(tmpDir());
  getStorage().saveDatasources([
    {
      id: 'ds-1',
      name: 'mysql',
      type: 'mysql',
      host: '127.0.0.1',
      port: 3306,
      user: 'r',
      password: '',
      enabled: true
    }
  ]);
  const bigSkill = {
    info: { name: 'big', version: '1.0.0', partial: false },
    body: `# 大手册\n## 一、采集\n${'X'.repeat(20_000)}\n## 二、判读\n${'Y'.repeat(5_000)}`,
    files: []
  };
  const registry = fakeRegistry();
  registry.requireEnabled = (name) => (name === 'big' ? bigSkill : SKILL);
  const tools = createSkillTools(registry);
  const result = await runTool(tools, 'skill.run', { skill: 'big', datasourceId: 'ds-1' });

  assert.ok(result.content.includes('章节清单'), '应给章节清单');
  assert.ok(result.content.includes('skill.read'), '应给按章取用方式');
  assert.ok(result.content.includes('一、采集'), '清单里要有章节标题');
  assert.ok(!result.content.includes('X'.repeat(5_000)), '正文不得一次性塞进上下文');
  const rendered = JSON.stringify(result);
  assert.ok(rendered.length <= 8_000, `rendered ${rendered.length} should fit maxResultChars`);

  // 按序号取章节
  const byIndex = await runTool(tools, 'skill.read', { skill: 'big', path: 'SKILL.md', section: '2' });
  assert.ok(byIndex.content.includes('一、采集'));
  assert.ok(byIndex.content.includes('X'.repeat(5_000)), '取到的是该章正文');

  // 按标题关键词取章节
  const byTitle = await runTool(tools, 'skill.read', { skill: 'big', path: 'SKILL.md', section: '判读' });
  assert.ok(byTitle.content.includes('二、判读'));

  // 不带 section 只回摘要，不回全文
  const noSection = await runTool(tools, 'skill.read', { skill: 'big', path: 'SKILL.md' });
  assert.ok(noSection.content.includes('章节清单'));
  assert.ok(!noSection.content.includes('X'.repeat(5_000)));
});

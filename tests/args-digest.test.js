'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { summarizeArgs } = require('../dist-main/renderer/lib/tools.js');

test('skill.run 的 trace 摘要优先显示技能名（而非 datasourceId）', () => {
  const digest = summarizeArgs(
    '{"skill":"mysql-batch-health-check","datasourceId":"0349072d-73d2-41d3-94e0-507d34750655"}'
  );
  assert.strictEqual(digest, 'mysql-batch-health-check');
});

test('其他工具的摘要键序不受影响', () => {
  assert.strictEqual(
    summarizeArgs('{"datasourceId":"ds-1","sql":"SELECT 1"}'),
    'SELECT 1'
  );
  assert.strictEqual(summarizeArgs('{"path":"references/indexing.md"}'), 'references/indexing.md');
});

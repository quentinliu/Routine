'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { findUnsupportedNumbers } = require('../dist-main/main/agent/loop/grounding.js');

test('字面量命中：来源里出现过的整数/小数直接放行', () => {
  assert.deepStrictEqual(
    findUnsupportedNumbers('Uptime 18935 秒，缓冲池 134217728 字节', [
      '{"Variable_name":"Uptime","Value":"18935"}',
      '{"Variable_name":"innodb_buffer_pool_size","Value":"134217728"}'
    ]),
    []
  );
});

test('子串命中：IP / 版本这类复合写法不误判', () => {
  const answer = '主机 192.168.1.2，端口 3306，版本 8.0.46。';
  assert.deepStrictEqual(findUnsupportedNumbers(answer, ['mysql192.168.1.2:3306 8.0.46']), []);
});

test('派生百分比不误伤：96.9% 可由 906/29296 推导', () => {
  const answer = '缓冲池命中率约 96.9%（计算式：1 - 906/29296）。';
  assert.deepStrictEqual(findUnsupportedNumbers(answer, ['read_requests=29296 reads=906']), []);
});

test('派生比值不误伤：12.5% 可由 7/56 推导', () => {
  assert.deepStrictEqual(findUnsupportedNumbers('磁盘使用率 12.5%。', ['used=7 total=56']), []);
});

test('白名单：年份、系统端口、HTTP 状态码不做溯源', () => {
  assert.deepStrictEqual(findUnsupportedNumbers('端口 3306 正常，接口返回 502，年份 2026。', []), []);
});

test('无来源数值被识别，短值/版本号跳过', () => {
  const out = findUnsupportedNumbers('磁盘 92% 已用，命中率 88.8%，版本 8.0.46。', ['使用率 9%']);
  assert.deepStrictEqual(out, ['88.8']);
});

test('limit 截断：最多返回指定条数', () => {
  const out = findUnsupportedNumbers('111.1、222.2、333.3 均为估算值。', [], 2);
  assert.deepStrictEqual(out, ['111.1', '222.2']);
});

test('空回答与空来源不报错', () => {
  assert.deepStrictEqual(findUnsupportedNumbers('', ['x']), []);
  assert.deepStrictEqual(findUnsupportedNumbers('任务完成。', []), []);
});

test('与来源数值接近（四舍五入）视为有来源', () => {
  assert.deepStrictEqual(findUnsupportedNumbers('命中率 96.91%。', ['计算值 96.9075']), []);
});

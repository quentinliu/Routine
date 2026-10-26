'use strict';
const test = require('node:test');
const assert = require('node:assert');

const { validateArgs, formatArgIssues } = require('../dist-main/main/agent/loop/validateArgs.js');

const TODO_SCHEMA = {
  type: 'object',
  properties: {
    todos: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          content: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] }
        },
        required: ['content', 'status']
      }
    }
  },
  required: ['todos']
};

test('必填缺失：路径精确到嵌套字段（复现 sessionlog 的 title/content 事故）', () => {
  const issues = validateArgs(TODO_SCHEMA, {
    todos: [{ title: '查询版本', status: 'pending' }]
  });
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].path, 'todos[0].content');
  assert.match(formatArgIssues(issues), /todos\[0\]\.content 为必填项/);
});

test('数组元素多条错误按顺序报告并带下标', () => {
  const issues = validateArgs(TODO_SCHEMA, {
    todos: [{ status: 'pending' }, { content: '汇总', status: 'pending' }]
  });
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].path, 'todos[0].content');
});

test('枚举越界与空串必填均被拦截', () => {
  const issues = validateArgs(TODO_SCHEMA, {
    todos: [{ content: '', status: 'done' }]
  });
  const paths = issues.map((i) => i.path);
  assert.ok(paths.includes('todos[0].content'));
  assert.ok(paths.includes('todos[0].status'));
  assert.match(formatArgIssues(issues), /可选：pending \/ in_progress \/ completed/);
});

test('顶层必填缺失', () => {
  const issues = validateArgs(TODO_SCHEMA, {});
  assert.strictEqual(issues.length, 1);
  assert.strictEqual(issues[0].path, 'todos');
});

test('形状不符：数组/对象给出可读描述', () => {
  const asObj = validateArgs(TODO_SCHEMA, { todos: { content: 'x' } });
  assert.strictEqual(asObj.length, 1);
  assert.strictEqual(asObj[0].path, 'todos');
  assert.match(asObj[0].message, /应为数组/);

  const root = validateArgs(TODO_SCHEMA, 'not-an-object');
  assert.strictEqual(root.length, 1);
  assert.match(root[0].message, /应为对象/);
});

test('合法参数返回空数组；标量类型不误伤（"30000" 视作可强转）', () => {
  assert.deepStrictEqual(
    validateArgs(TODO_SCHEMA, {
      todos: [{ content: '查询版本', status: 'in_progress' }]
    }),
    []
  );
  const sshSchema = {
    type: 'object',
    properties: {
      host: { type: 'string' },
      command: { type: 'string' },
      timeoutMs: { type: 'number' }
    },
    required: ['host', 'command']
  };
  assert.deepStrictEqual(validateArgs(sshSchema, { host: 'h', command: 'df -h', timeoutMs: '30000' }), []);
});

test('深度截断：第 2 层必填仍校验，第 3 层不再递归', () => {
  const deep = {
    type: 'object',
    properties: {
      a: {
        type: 'object',
        required: ['d'],
        properties: {
          d: { type: 'string' },
          b: {
            type: 'object',
            required: ['z'],
            properties: { c: { type: 'object', required: ['deep'], properties: {} } }
          }
        }
      }
    },
    required: ['a']
  };
  // a 是第 1 层（required d 校验），b 是第 2 层（required z 校验），c 是第 3 层（不再递归）
  const issues = validateArgs(deep, { a: { b: { c: {} } } });
  assert.deepStrictEqual(
    issues.map((i) => i.path),
    ['a.d', 'a.b.z'],
    '第 2 层的必填要校验，第 3 层的 required(deep) 不再检查'
  );
});

test('问题数量上限：最多报告 maxIssues 条', () => {
  const issues = validateArgs(TODO_SCHEMA, { todos: [{}, {}, {}, {}, {}, {}, {}] }, 3);
  assert.strictEqual(issues.length, 3);
});

test('无 schema 或空 schema 直接放行', () => {
  assert.deepStrictEqual(validateArgs({}, { anything: 1 }), []);
  assert.deepStrictEqual(validateArgs(undefined, { anything: 1 }), []);
});

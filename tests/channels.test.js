'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');

// M3：IPC 通道双表（shared/ipc.ts 的 IPC 与 preload.ts 的 CH）一致性机械化校验。
// preload 依赖 electron 无法在纯 node 下加载，故扫描 TS 源码比对。
const sharedSrc = fs.readFileSync('src/shared/ipc.ts', 'utf-8');
const preloadSrc = fs.readFileSync('src/main/preload.ts', 'utf-8');

function stripCommentLines(src) {
  return src
    .split('\n')
    .filter((line) => !line.trim().startsWith('//'))
    .join('\n');
}

function tableEntries(src, start) {
  const i = src.indexOf(start);
  assert.ok(i >= 0, `找不到 ${start}`);
  const seg = src.slice(src.indexOf('{', i));
  let depth = 0;
  let cur = '';
  const entries = [];
  for (const ch of seg) {
    if (ch === '{') {
      depth++;
      continue;
    }
    if (ch === '}') {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1) {
      if (ch === ',') {
        entries.push(cur.trim());
        cur = '';
        continue;
      }
      cur += ch;
    }
  }
  if (cur.trim()) entries.push(cur.trim());
  return entries;
}

function mapOf(entries) {
  const map = {};
  for (const e of entries) {
    const m = e.match(/^(\w+)\s*:\s*'([^']+)'/);
    assert.ok(m, `通道条目格式异常: ${e}`);
    map[m[1]] = m[2];
  }
  return map;
}

test('IPC 与 preload.CH 键集与通道值逐字一致', () => {
  const ipcMap = mapOf(tableEntries(stripCommentLines(sharedSrc), 'export const IPC'));
  const chMap = mapOf(tableEntries(stripCommentLines(preloadSrc), 'const CH'));
  assert.deepStrictEqual(
    Object.keys(ipcMap).sort(),
    Object.keys(chMap).sort(),
    '两表键集不一致'
  );
  for (const k of Object.keys(ipcMap)) {
    assert.strictEqual(chMap[k], ipcMap[k], `通道 ${k} 值不一致`);
  }
});

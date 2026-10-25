const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CSS_PATH = path.join(__dirname, '../src/renderer/styles.css');

test('styles.css：颜色只允许出现在令牌块内', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  // 令牌块（:root 与 :root[data-theme='light']）是唯一允许裸色的地方；
  // 用换行占位保持行号，便于报错定位。
  const stripped = css.replace(/:root[^{]*\{[^}]*\}/g, (block) =>
    block.replace(/[^\n]/g, '')
  );

  const offenders = [];
  stripped.split(/\r?\n/).forEach((line, i) => {
    if (/#[0-9a-fA-F]{3,8}\b|rgba?\(/.test(line)) {
      offenders.push(`${i + 1}: ${line.trim()}`);
    }
  });

  assert.deepEqual(offenders, [], `发现令牌块之外的裸色：\n${offenders.join('\n')}`);
});

test('styles.css：浅色主题令牌块完整', () => {
  const css = fs.readFileSync(CSS_PATH, 'utf8');
  const light = css.match(/:root\[data-theme='light'\]\s*\{([^}]*)\}/);
  assert.ok(light, '缺少 :root[data-theme="light"] 令牌块');
  for (const token of ['color-scheme: light', '--bg:', '--fg:', '--border:', '--accent:']) {
    assert.ok(light[1].includes(token), `浅色令牌块缺少 ${token}`);
  }
});

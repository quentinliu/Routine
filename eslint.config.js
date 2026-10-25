const tseslint = require('typescript-eslint');
const globals = require('globals');

module.exports = [
  { ignores: ['dist-main/**', 'dist-renderer/**', 'release/**', 'node_modules/**'] },
  ...tseslint.configs.recommended,
  {
    rules: {
      // 项目为 CJS（tsc 编译 + node:test require），require 属既定模块形态
      '@typescript-eslint/no-require-imports': 'off',
      // 项目契约已强制 strict + 禁 any，recommended 之外暂不加严
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }
      ],
      '@typescript-eslint/no-explicit-any': 'error'
    }
  },
  {
    files: ['**/*.js', '**/*.cjs'],
    languageOptions: { globals: { ...globals.node } }
  },
  {
    files: ['**/*.tsx'],
    languageOptions: { globals: { ...globals.browser } }
  }
];

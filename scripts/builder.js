#!/usr/bin/env node
'use strict';

/**
 * electron-builder 包装入口：默认通过国内镜像下载其二进制工具集。
 *
 * 背景：首次打包要从 GitHub Releases 拉 icons-bundle / winCodeSign / nsis 等工具包，
 * 国内直连常常只有几十 KB/s（icons-bundle.tar.gz 只有 3MB，却可能跑一小时）。
 * npmmirror 完整镜像了 electron-builder-binaries 与 electron 发行版。
 *
 * 若显式设置了 ELECTRON_BUILDER_BINARIES_MIRROR（海外环境、自建镜像或想用官方源），
 * 一律尊重用户设置，不做覆盖。
 */

const { spawnSync } = require('node:child_process');

const env = { ...process.env };

if (env.ELECTRON_BUILDER_BINARIES_MIRROR == null) {
  env.ELECTRON_BUILDER_BINARIES_MIRROR =
    'https://npmmirror.com/mirrors/electron-builder-binaries/';
}
if (env.ELECTRON_MIRROR == null) {
  env.ELECTRON_MIRROR = 'https://npmmirror.com/mirrors/electron/';
}

// 直接跑包内 CLI：不依赖 node_modules/.bin 是否在 PATH（`node scripts/builder.js` 也能用）
const cli = require.resolve('electron-builder/cli.js');
const result = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env
});

if (result.error) {
  console.error(`[builder] 启动 electron-builder 失败: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);

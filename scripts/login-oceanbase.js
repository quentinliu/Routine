const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const ROOT = path.join(__dirname, '..', 'dist-main', 'main');
const { initStorage } = require(path.join(ROOT, 'services', 'storage.js'));

const dataDir = path.join(os.homedir(), 'Library', 'Application Support', 'routine');
initStorage(dataDir);
const profileDir = path.join(
  require(path.join(ROOT, 'services', 'storage.js')).getStorage().dataDir,
  'browser-profile'
);

const pw = require(path.join(__dirname, '..', 'node_modules', 'playwright-core'));

(async () => {
  if (!fs.existsSync('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')) {
    console.error('未找到系统 Chrome，无法打开登录窗口');
    process.exit(1);
  }

  console.log(`使用浏览器 Profile: ${profileDir}`);
  console.log('即将打开 Chrome 并访问 OceanBase 官网...');
  console.log('请在打开的窗口中完成登录（扫码 / 短信 / 密码均可，账号信息不会保存）。');
  console.log('确认右上角出现你的头像后，直接关闭该窗口即可。');
  console.log('');

  const context = await pw.chromium.launchPersistentContext(profileDir, {
    channel: 'chrome',
    headless: false,
    viewport: { width: 1280, height: 900 },
    locale: 'zh-CN'
  });
  const page = context.pages()[0] ?? (await context.newPage());
  await page.goto('https://www.oceanbase.com/', { waitUntil: 'domcontentloaded' });

  await new Promise((resolve) => {
    context.on('close', resolve);
  });

  console.log('登录窗口已关闭。浏览器 Agent 将自动复用此登录态，之后可触发签到任务。');
  process.exit(0);
})().catch((err) => {
  console.error('启动失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});

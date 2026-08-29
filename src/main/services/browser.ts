import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import type { BrowserTaskResult, SiteCredential } from '../../shared/types';
import type { LLMRouter } from '../llm/router';
import type { LLMChatMessage, LLMContentPart } from '../llm/provider';
import { getStorage } from './storage';

export interface BrowserAgentService {
  run(instruction: string, onLog: (line: string) => void): Promise<BrowserTaskResult>;
  isAvailable(): Promise<boolean>;
  configureLLM(router: LLMRouter): void;
}

interface BrowserAction {
  type:
    | 'open'
    | 'click_text'
    | 'click_xy'
    | 'fill'
    | 'fill_credential'
    | 'press'
    | 'drag'
    | 'scroll'
    | 'wait'
    | 'extract'
    | 'done'
    | 'fail';
  url?: string;
  text?: string;
  x?: number;
  y?: number;
  toX?: number;
  toY?: number;
  field?: string;
  value?: string;
  which?: 'username' | 'password';
  key?: string;
  direction?: 'up' | 'down' | 'top' | 'bottom';
  ms?: number;
  reason?: string;
  evidence?: string;
  tabText?: string;
}

interface AgentDecision {
  thought?: string;
  action?: BrowserAction | null;
  done?: string | null;
  fail?: string | null;
}

const MAX_ACTION_STEPS = 20;
const MAX_LLM_ROUNDS = 30;
const MAX_EMPTY_DECISIONS = 3;
const DEADLINE_MS = 300_000;
const HISTORY_LIMIT = 12;
const PAGE_TEXT_LIMIT = 2500;
const CLICK_TIMEOUT_MS = 8000;
const PRESS_KEY_WHITELIST = new Set(['Enter', 'Tab', 'Escape', 'ArrowDown', 'ArrowUp']);

const CHROME_PATHS = [
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  `${os.homedir()}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`
];

const AGENT_SYSTEM = `你是 Routine 的浏览器自动化 Agent。你会收到当前页面的截图（视口 1280x900，截图坐标即页面坐标，左上角为 0,0）和页面文本，目标是完成用户任务。

每轮只输出一个 JSON 对象，不要输出其他文字：
{"thought":"简短中文推理","action":{...}} — 执行下一步
{"thought":"...","done":"证据文本"} — 任务完成，done 必须填页面上实际看到的确认信息（如"今日已签到"）
{"thought":"...","fail":"原因"} — 无法完成

输出示例：
{"thought":"页面已打开，需要先登录才能看到积分","action":{"type":"click_text","text":"登录 / 注册"}}

禁止：只输出 thought 而不带 action/done/fail 的 JSON 是无效回答，每轮必须三选一，不要单纯描述页面。

可用 action（type 及参数）：
- open {url} — 打开网址
- click_text {text} — 点击包含该文本的可见元素
- click_xy {x, y} — 点击截图上的坐标
- fill {field, value} — 向输入框填文本，field 填输入框的 placeholder/标签关键词
- fill_credential {tabText?} — 自动把账号和密码填入登录表单。tabText 填登录方式切换标签的文字（如"密码登录"）：动作内会先点击标签再填入，并在页面于验证码/密码间跳变时自动重试，不要手动填密码
- press {key} — Enter/Tab/Escape/ArrowDown/ArrowUp
- drag {x, y, toX, toY} — 鼠标拖拽。滑块验证码：从滑块按钮中心拖到缺口位置，可小幅超出再回拉
- scroll {direction: "up"|"down"|"top"|"bottom"}
- wait {ms} — 等待页面变化（最多 5000）
- extract — 提取页面全文

规则：
- 任务开始先确认登录状态：页面右上角有头像/用户名即已登录，直接做业务操作，不要重复登录
- 需要登录时：用 fill_credential 并带 tabText（登录方式标签文字）；填好后点击登录按钮，再确认页面状态
- 出现滑块验证码时用 drag 完成
- 完成任务必须有页面可见证据才输出 done；没有证据就继续操作，确实走不通才输出 fail
- 优先用 click_text；坐标点击仅用于验证码或 click_text 失败的场景；若页面在两种登录方式间反复跳变，用 fill_credential 的重试机制而不是反复手点`;

function extractDecision(raw: string): AgentDecision | null {
  const stripped = raw.replace(/```(?:json)?/g, '').trim();
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < stripped.length; i++) {
    const ch = stripped[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') inString = !inString;
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(stripped.slice(start, i + 1)) as AgentDecision;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

function extractFirstUrl(instruction: string): string | null {
  const m = instruction.match(/https?:\/\/[^\s，。,；;）)]+/);
  if (m) return m[0];
  const bare = instruction.match(/(?:^|\s)([\w-]+\.(?:com|cn|net|org|io)(?:\/\S*)?)/i);
  return bare ? `https://${bare[1]}` : null;
}

function hostOf(url: string): string | null {
  try {
    return new URL(url).hostname;
  } catch {
    return null;
  }
}

function findCredential(host: string | null): SiteCredential | null {
  if (!host) return null;
  const entries = Object.entries(getStorage().loadSettings().siteCredentials ?? {});
  for (const [key, cred] of entries) {
    if (!cred?.username || !cred?.password) continue;
    if (host === key || host.endsWith(`.${key}`) || key.endsWith(`.${host}`) || host.includes(key)) {
      return cred;
    }
  }
  return null;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function looksLikeVisionUnsupportedError(msg: string): boolean {
  return /image|vision|多模态|multimodal|modalit|不支持图片|picture/i.test(msg);
}

export class BrowserAgentServiceImpl implements BrowserAgentService {
  private availabilityCache: { value: boolean; at: number } | null = null;
  private router: LLMRouter | null = null;
  private visionDisabled = false;

  configureLLM(router: LLMRouter): void {
    this.router = router;
  }

  async isAvailable(): Promise<boolean> {
    if (this.availabilityCache && Date.now() - this.availabilityCache.at < 60000) {
      return this.availabilityCache.value;
    }
    const value = CHROME_PATHS.some((p) => {
      try {
        fs.accessSync(p);
        return true;
      } catch {
        return false;
      }
    });
    this.availabilityCache = { value, at: Date.now() };
    return value;
  }

  async run(instruction: string, onLog: (line: string) => void): Promise<BrowserTaskResult> {
    if (!(await this.isAvailable())) {
      return { ok: false, outputs: [], summary: '未检测到系统 Chrome，浏览器 Agent 不可用' };
    }
    if (!this.router) {
      return { ok: false, outputs: [], summary: '浏览器 Agent 未接入 LLM 路由' };
    }
    let provider;
    try {
      provider = await this.router.getActive();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, outputs: [], summary: `LLM 未就绪: ${msg}` };
    }

    const startedAt = Date.now();
    const profileDir = path.join(getStorage().dataDir, 'browser-profile');
    const outputs: string[] = [];

    const pw = require('playwright-core') as typeof import('playwright-core');
    let context: import('playwright-core').BrowserContext | null = null;

    try {
      context = await pw.chromium.launchPersistentContext(profileDir, {
        channel: 'chrome',
        headless: true,
        viewport: { width: 1280, height: 900 },
        locale: 'zh-CN'
      });
      let page = context.pages()[0] ?? (await context.newPage());
      page.setDefaultTimeout(30000);

      const startUrl = extractFirstUrl(instruction);
      if (startUrl) {
        await page.goto(startUrl, { waitUntil: 'domcontentloaded' });
        onLog(`已打开页面: ${page.url()}`);
      }

      const history: LLMChatMessage[] = [];
      let lastStepResult = '';
      let badJsonCount = 0;
      let emptyDecisionStreak = 0;
      let executedActions = 0;

      for (let round = 0; round < MAX_LLM_ROUNDS; round++) {
        if (Date.now() - startedAt > DEADLINE_MS) {
          return { ok: false, outputs, summary: `浏览器任务超时（${DEADLINE_MS / 1000}s）` };
        }

        const openPages = context.pages().filter((p) => !p.isClosed());
        const newest = openPages.at(-1);
        if (newest && newest !== page && newest.url() !== 'about:blank') {
          page = newest;
          onLog(`检测到新标签页，切换焦点: ${page.url()}`);
        }

        const pageText = await page
          .evaluate(() => document.body.innerText)
          .then((t) => t.replace(/\s+/g, ' ').trim().slice(0, PAGE_TEXT_LIMIT))
          .catch(() => '');
        const links = await page
          .evaluate(() => {
            const seen = new Set<string>();
            const out: string[] = [];
            for (const a of Array.from(document.querySelectorAll('a[href]'))) {
              const t = ((a as HTMLAnchorElement).innerText || '').trim().replace(/\s+/g, ' ').slice(0, 24);
              const h = (a as HTMLAnchorElement).href;
              if (!t || !h.startsWith('http') || seen.has(h)) continue;
              seen.add(h);
              out.push(`${t} → ${h}`);
              if (out.length >= 30) break;
            }
            return out;
          })
          .catch(() => [] as string[]);
        const cred = findCredential(hostOf(page.url()));
        const credHint = cred
          ? `该站点已配置凭据：用户名 ${cred.username}（密码不要手填，用 fill_credential 注入）`
          : '该站点未配置凭据';

        const obsLines = [
          `用户任务: ${instruction}`,
          `当前URL: ${page.url()}`,
          credHint,
          lastStepResult ? `上一步结果: ${lastStepResult}` : '',
          `页面文本: ${pageText || '（空）'}`,
          links.length ? `页面链接（可直接 open 跳转）:\n${links.join('\n')}` : ''
        ];
        const obsText = obsLines.filter(Boolean).join('\n');

        const parts: LLMContentPart[] = [{ type: 'text', text: obsText }];
        if (!this.visionDisabled) {
          const shot = await page.screenshot({ type: 'jpeg', quality: 70 });
          parts.push({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${shot.toString('base64')}` }
          });
        }

        let raw = '';
        try {
          const res = await provider.chatStream(
            {
              system: AGENT_SYSTEM,
              messages: [...history, { role: 'user', content: parts }],
              temperature: 0.1,
              maxTokens: 2048,
              extraBody: { thinking: { type: 'disabled' } }
            },
            () => {}
          );
          raw = res.content;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          if (!this.visionDisabled && looksLikeVisionUnsupportedError(msg)) {
            this.visionDisabled = true;
            onLog('当前模型不支持图片输入，降级为纯文本模式');
            continue;
          }
          throw err;
        }

        history.push({ role: 'user', content: obsText });
        history.push({ role: 'assistant', content: raw });
        while (history.length > HISTORY_LIMIT) history.shift();

        const decision = extractDecision(raw);
        if (decision?.action && (decision.action.type === 'fail' || decision.action.type === 'done')) {
          if (decision.action.type === 'fail' && !decision.fail) {
            decision.fail = decision.action.reason ?? decision.action.text ?? decision.thought ?? '模型报告无法完成';
          }
          if (decision.action.type === 'done' && !decision.done) {
            decision.done = decision.action.evidence ?? decision.action.text ?? '';
          }
          decision.action = null;
        }
        if (!decision) {
          badJsonCount++;
          if (badJsonCount >= 3) {
            return { ok: false, outputs, summary: `浏览器 Agent 连续 ${badJsonCount} 次输出无法解析` };
          }
          lastStepResult = '你上一轮的输出不是合法 JSON，请重新只输出一个 JSON 对象';
          continue;
        }

        if (decision.thought) onLog(decision.thought);

        if (decision.done) {
          const evidence = decision.done.trim();
          if (!evidence) {
            lastStepResult = 'done 不能为空，必须在页面上找到证据文本';
            continue;
          }
          const file = await saveScreenshot(page);
          if (file) outputs.push(file);
          return { ok: true, outputs, summary: `浏览器任务完成，页面证据：${evidence}` };
        }

        if (decision.fail) {
          return { ok: false, outputs, summary: `浏览器任务失败: ${decision.fail.trim().slice(0, 200)}` };
        }

        if (!decision.action?.type) {
          emptyDecisionStreak++;
          if (emptyDecisionStreak >= MAX_EMPTY_DECISIONS) {
            return {
              ok: false,
              outputs,
              summary: `模型连续 ${MAX_EMPTY_DECISIONS} 轮未给出动作，任务中止`
            };
          }
          history.push({
            role: 'user',
            content: `你上一轮只输出了 thought，这是无效回答。现在必须输出一个包含 action（或 done/fail）的 JSON。用户任务: ${instruction}`
          });
          lastStepResult = '';
          continue;
        }
        emptyDecisionStreak = 0;

        executedActions++;
        if (executedActions > MAX_ACTION_STEPS) {
          return { ok: false, outputs, summary: `达到最大动作步数 ${MAX_ACTION_STEPS}，任务未确认完成` };
        }

        try {
          const executed = await this.executeAction(page, decision.action, onLog);
          lastStepResult = executed ?? '已执行';
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          onLog(`动作失败 ${decision.action.type}: ${msg.slice(0, 120)}`);
          lastStepResult = `动作 ${decision.action.type} 失败: ${msg.slice(0, 200)}`;
        }
      }

      return { ok: false, outputs, summary: `达到轮次上限 ${MAX_LLM_ROUNDS}，任务未确认完成` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { ok: false, outputs, summary: `浏览器任务失败: ${msg.slice(0, 200)}` };
    } finally {
      await context?.close().catch(() => {});
    }
  }

  private async executeAction(
    page: import('playwright-core').Page,
    action: BrowserAction,
    onLog: (line: string) => void
  ): Promise<string | null> {
    switch (action.type) {
      case 'open': {
        const url = action.url ?? '';
        if (!/^https?:\/\//.test(url)) throw new Error(`无效网址: ${url}`);
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        return `已打开 ${page.url()}`;
      }
      case 'click_text': {
        const text = (action.text ?? '').trim();
        if (!text) throw new Error('click_text 缺少 text 参数');
        await page.getByText(text).first().click({ timeout: CLICK_TIMEOUT_MS });
        onLog(`已点击: ${text}`);
        return `已点击 "${text}"`;
      }
      case 'click_xy': {
        const { x, y } = assertCoords(action.x, action.y);
        await page.mouse.click(x, y);
        onLog(`已点击坐标 (${x}, ${y})`);
        return `已点击坐标 (${x}, ${y})`;
      }
      case 'fill': {
        if (action.value === undefined) throw new Error('fill 缺少 value 参数');
        const locator = await findFieldLocator(page, action.field, null);
        await locator.fill(action.value, { timeout: CLICK_TIMEOUT_MS });
        onLog(`已向输入框填入 ${action.value.length} 字`);
        return '已填入文本';
      }
      case 'fill_credential': {
        const cred = findCredential(hostOf(page.url()));
        if (!cred) throw new Error('当前站点未配置凭据（settings.json 的 siteCredentials）');
        const tabText = (action.tabText ?? '').trim();
        let lastErr: unknown = new Error('fill_credential 未能完成');
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            if (tabText) {
              await page.getByText(tabText).first().click({ timeout: 3000 }).catch(() => {});
              await sleep(900);
            }
            const pwd = page.locator('input[type="password"]:visible');
            if ((await pwd.count()) > 0) {
              const userIdx = await findUsernameInputIndex(page);
              if (userIdx >= 0) {
                await page
                  .locator('input, textarea')
                  .nth(userIdx)
                  .fill(cred.username, { timeout: CLICK_TIMEOUT_MS });
              }
              await pwd.first().fill(cred.password, { timeout: CLICK_TIMEOUT_MS });
              const stored = await pwd.first().inputValue();
              if (stored === cred.password) {
                onLog(`已注入凭据: 账号+密码（第 ${attempt} 次尝试，值不记录）`);
                return '已填入账号和密码';
              }
              lastErr = new Error('密码填入后丢失（页面跳变），重试中');
              continue;
            }
            const loc = await findFieldLocator(page, action.field, action.which === 'password' ? 'password' : null);
            await loc.fill(cred.username, { timeout: CLICK_TIMEOUT_MS });
            onLog('已填入账号（当前页面无密码框，值不记录）');
            return '已填入账号（当前页面无密码框）';
          } catch (err) {
            lastErr = err;
          }
        }
        throw lastErr;
      }
      case 'press': {
        const key = action.key ?? 'Enter';
        if (!PRESS_KEY_WHITELIST.has(key)) throw new Error(`按键不在白名单: ${key}`);
        await page.keyboard.press(key);
        return `已按下 ${key}`;
      }
      case 'drag': {
        const { x, y } = assertCoords(action.x, action.y);
        const { x: toX, y: toY } = assertCoords(action.toX, action.toY);
        await page.mouse.move(x, y);
        await page.mouse.down();
        const steps = 15;
        const overshoot = Math.max(4, Math.round(Math.abs(toX - x) * 0.04));
        const endX = toX + (toX >= x ? overshoot : -overshoot);
        for (let i = 1; i <= steps; i++) {
          const t = i / steps;
          await page.mouse.move(x + (endX - x) * t, y + (toY - y) * t + Math.sin(t * Math.PI) * 3);
          await sleep(30);
        }
        await page.mouse.move(toX, toY);
        await sleep(120);
        await page.mouse.up();
        await sleep(600);
        onLog(`已拖拽 (${x},${y}) → (${toX},${toY})`);
        return '已拖拽';
      }
      case 'scroll': {
        const map: Record<string, string> = {
          up: 'window.scrollBy(0,-600)',
          down: 'window.scrollBy(0,600)',
          top: 'window.scrollTo(0,0)',
          bottom: 'window.scrollTo(0,document.body.scrollHeight)'
        };
        await page.evaluate(map[action.direction ?? 'down']);
        return `已滚动 ${action.direction ?? 'down'}`;
      }
      case 'wait': {
        const ms = Math.min(Math.max(action.ms ?? 1500, 200), 5000);
        await sleep(ms);
        return `已等待 ${ms}ms`;
      }
      case 'extract': {
        const text = await page.evaluate(() => document.body.innerText);
        const trimmed = text.replace(/\s+/g, ' ').trim().slice(0, 6000);
        return `页面全文: ${trimmed}`;
      }
      default:
        throw new Error(`未知动作: ${(action as { type: string }).type}`);
    }
  }
}

function assertCoords(x: unknown, y: unknown): { x: number; y: number } {
  const nx = Number(x);
  const ny = Number(y);
  if (!Number.isFinite(nx) || !Number.isFinite(ny)) {
    throw new Error('坐标参数无效，需要数字 x/y');
  }
  return { x: Math.round(nx), y: Math.round(ny) };
}

async function findUsernameInputIndex(page: import('playwright-core').Page): Promise<number> {
  return page.evaluate(() => {
    const all = Array.from(document.querySelectorAll('input, textarea'));
    const visible = (el: Element) => (el as HTMLInputElement).offsetParent !== null;
    const pwd = all.find((el) => (el as HTMLInputElement).type === 'password' && visible(el));
    if (!pwd) return -1;
    const scope = pwd.closest('form') ?? document;
    const scoped = all.findIndex(
      (el) => scope.contains(el) && (el as HTMLInputElement).type === 'text' && visible(el)
    );
    if (scoped >= 0) return scoped;
    return all.findIndex(
      (el) => (el as HTMLInputElement).type === 'text' && visible(el)
    );
  });
}

async function findFieldLocator(
  page: import('playwright-core').Page,
  field: string | undefined,
  prefer: 'username' | 'password' | null
): Promise<import('playwright-core').Locator> {
  if (prefer === 'password') {
    const pwd = page.locator('input[type="password"]');
    if ((await pwd.count()) > 0) return pwd.first();
  }
  if (!field) {
    return page.locator('input:visible, textarea:visible').first();
  }
  const keyword = field.toLowerCase();
  const idx = await page.evaluate((kw: string) => {
    const inputs = Array.from(document.querySelectorAll('input, textarea')).filter(
      (el) => (el as HTMLInputElement).offsetParent !== null
    );
    return inputs.findIndex((el) => {
      const input = el as HTMLInputElement;
      const hay = [input.placeholder, input.name, input.id, input.getAttribute('aria-label')]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();
      return hay.includes(kw);
    });
  }, keyword);
  if (idx >= 0) {
    return page.locator('input, textarea').nth(idx);
  }
  return page.locator('input:visible, textarea:visible').first();
}

async function saveScreenshot(page: import('playwright-core').Page): Promise<string | null> {
  try {
    const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 13).replace(/(\d{8})(\d{4})/, '$1-$2');
    const file = path.join(os.homedir(), 'Desktop', `routine-shot-${stamp}.png`);
    await page.screenshot({ path: file, fullPage: false });
    return file;
  } catch {
    return null;
  }
}

let browser: BrowserAgentService | null = null;

export function getBrowserAgentService(): BrowserAgentService {
  if (!browser) browser = new BrowserAgentServiceImpl();
  return browser;
}

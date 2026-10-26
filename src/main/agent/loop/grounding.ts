/**
 * 数值溯源守卫：最终回答里的数字必须能在「任务文本 + 工具结果」里找到出处。
 *
 * 背景（sessionlog.txt）：最后一轮 ssh.exec 的返回没有进入任何决策轮，回答却带着
 * 磁盘/内存数值；日志里也查不到这些数字。作答提示词已禁止编造，但没有程序化校验。
 *
 * 设计取向：**宁可漏报，不可误伤**——
 * - 只校验 3 位以上整数、整数部分 ≥2 位的小数（跳过 42、70、8.0.46、5.26 这类短值/版本号）；
 * - 放行来源文本里的字面量、系统端口与年份白名单、两位来源数的常见运算结果（比值/百分比/差值）；
 * - 与来源数值接近（四舍五入）也算有来源。
 * 命中后只触发一次重写，重写完仍不通过就放行并记事件，避免与模型互相拉扯。
 */

/** 整数最小位数：3 位以上才校验（端口、年份之外的短值误伤率高） */
const MIN_INT_DIGITS = 3;
/** 小数的最小整数位数：96.9 / 12.7 校验，8.0 / 5.26 跳过 */
const MIN_DECIMAL_INT_DIGITS = 2;
/** 参与运算推导的来源数值上限：防止大段 stdout 让 O(n²) 推导失控 */
const MAX_SOURCE_NUMBERS = 400;
const DEFAULT_LIMIT = 3;
/** 最多检查的回答数值个数：推导是 O(n²)，长报告里没必要全量扫 */
const MAX_CANDIDATES = 40;

/** 系统端口白名单：这些值常来自运行时上下文而非工具结果 */
const PORT_WHITELIST = new Set([
  22, 80, 443, 1521, 3000, 3306, 5173, 5432, 6379, 8000, 8080, 8443, 9000, 9090, 9222, 27017
]);

/** 常见 HTTP 状态码：回答里描述报错时会用到 */
const HTTP_WHITELIST = new Set([
  200, 201, 204, 301, 302, 304, 400, 401, 403, 404, 409, 422, 429, 500, 502, 503, 504
]);

/** 千分位与普通数字统一抽取（1,234 / 96.9 / 18935） */
const NUMBER_RE = /\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?/g;

interface Candidate {
  /** 原始写法（用于报告给模型） */
  raw: string;
  /** 去千分位后的数值 */
  value: number;
  isInteger: boolean;
  intDigits: number;
}

function extractCandidates(text: string): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const match of text.matchAll(NUMBER_RE)) {
    const raw = match[0];
    const normalized = raw.replace(/,/g, '');
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    const [intPart] = normalized.split('.');
    const isInteger = !normalized.includes('.');
    out.push({
      raw: normalized,
      value: Number(normalized),
      isInteger,
      intDigits: intPart.length
    });
  }
  return out;
}

function isWorthChecking(c: Candidate): boolean {
  if (!Number.isFinite(c.value)) return false;
  if (c.isInteger) {
    if (c.intDigits < MIN_INT_DIGITS) return false;
    // 年份（1900-2099）与端口、HTTP 状态码不做溯源
    if (c.intDigits === 4 && c.value >= 1900 && c.value <= 2099) return false;
    return !PORT_WHITELIST.has(c.value) && !HTTP_WHITELIST.has(c.value);
  }
  return c.intDigits >= MIN_DECIMAL_INT_DIGITS;
}

function extractSourceNumbers(text: string): number[] {
  const values = new Set<number>();
  for (const match of text.matchAll(NUMBER_RE)) {
    const value = Number(match[0].replace(/,/g, ''));
    if (!Number.isFinite(value)) continue;
    values.add(value);
    if (values.size >= MAX_SOURCE_NUMBERS) break;
  }
  return [...values];
}

/** 相对容差：大数放宽到 0.5%，小数固定 0.01 绝对值 */
function tolerance(value: number): number {
  return Math.max(Math.abs(value) * 0.005, 0.01);
}

function close(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  return Math.abs(a - b) <= Math.max(tolerance(b), tolerance(a));
}

function derivableFromSources(value: number, sources: readonly number[]): boolean {
  for (const a of sources) {
    if (close(a, value)) return true;
    for (const b of sources) {
      if (b === 0) continue;
      const ratio = a / b;
      if (
        close(ratio, value) ||
        close(ratio * 100, value) ||
        close(1 - ratio, value) ||
        close((1 - ratio) * 100, value) ||
        close(a - b, value) ||
        close(a + b, value) ||
        close(a * b, value)
      ) {
        return true;
      }
    }
  }
  return false;
}

/**
 * 返回回答里「无法溯源」的数值（最多 limit 个）。
 * sources 建议传：任务原文 + 全部成功的工具结果（已渲染文本）。
 */
export function findUnsupportedNumbers(
  answer: string,
  sources: readonly string[],
  limit = DEFAULT_LIMIT
): string[] {
  if (!answer.trim()) return [];
  const sourceText = sources.join('\n');
  const sourceNumbers = extractSourceNumbers(sourceText);
  const unsupported: string[] = [];
  let checked = 0;

  for (const candidate of extractCandidates(answer)) {
    if (!isWorthChecking(candidate)) continue;
    if (checked >= MAX_CANDIDATES) break;
    checked += 1;
    if (sourceText.includes(candidate.raw)) continue;
    if (sourceText.includes(String(candidate.value))) continue;
    if (derivableFromSources(candidate.value, sourceNumbers)) continue;
    unsupported.push(candidate.raw);
    if (unsupported.length >= Math.max(1, limit)) break;
  }
  return unsupported;
}

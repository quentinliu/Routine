/**
 * 作答阶段的工具结果清单：把决策阶段真实拿到（模型看到）的工具结果原文带到作答阶段。
 *
 * 事故背景（v0.5.1 mysql192.168.1.2 巡检）：
 * 1. 摘要由 `taskObservations` 全量拼接后硬截断 12000 字符，而 `skill.run` 返回的技能手册
 *    就占 11888 字符，截断点落在 `inspection.run` 结果内部，作答模型只看到「手册 + 半截巡检」
 *    并断言「未采集到任何数据」；
 * 2. 0 行结果的提示文案在每条查询上完全一致，作答阶段无法区分「这条 0 行是哪条 SQL」，
 *    于是把已执行的 `SHOW REPLICA STATUS` 说成「本轮未包含该工具结果」。
 *
 * 因此现在必须做到：
 * 1. 每条调用逐条保留（带序号 + 关键参数），**不做同文案去重/合并**；
 * 2. 单条只按自身字符上限裁剪，绝不因为后面还有别的工具就整条丢弃；
 * 3. 末尾显式声明「压缩 ≠ 未执行」，把结论约束写进上下文。
 */

export interface AnswerDigestItem {
  tool: string;
  resultText: string;
  failed?: boolean;
  /** 调用序号（1 起，按执行顺序）：同文案结果也靠它区分，禁止合并去重 */
  seq?: number;
  /** 关键调用参数摘要（db.query 的 sql、ssh.exec 的 host 等），用于消除同文案歧义 */
  detail?: string;
}

export interface AnswerDigestOptions {
  /** 清单总字符预算 */
  totalBudget?: number;
  /** 单条结果的初始上限 */
  perToolBudget?: number;
}

export const ANSWER_DIGEST_DEFAULTS = {
  totalBudget: 48_000,
  perToolBudget: 16_000
};

export const DIGEST_TRUNCATION_NOTE =
  '（以上为决策阶段全部工具调用的结果，逐条列出、未做去重。标注「已压缩」只表示该条为控制上下文长度截短了尾部，' +
  '不代表未执行；同一段文案出现在多条调用里时按序号区分。严禁据此声称「未采集到任何数据」「未实际执行」「无法计算」。）';

const DIGEST_HEADER = '【工具调用明细】（按执行顺序逐条列出，同文案结果不合并）';
/** 压缩收缩的下限：低于这个长度条目就失去判读价值，宁可超预算也不砍到无意义 */
const MIN_ITEM_BUDGET = 400;

/** 从调用参数里挑出能区分同类调用的关键字段，供作答阶段标注来源 */
const DETAIL_KEYS = ['sql', 'command', 'host', 'skill', 'path', 'query', 'url', 'name'] as const;
const DETAIL_VALUE_MAX = 160;

export function describeCallArgs(args: Record<string, unknown> | undefined): string {
  if (!args) return '';
  const parts: string[] = [];
  for (const key of DETAIL_KEYS) {
    const value = args[key];
    if (typeof value !== 'string') continue;
    const flat = value.replace(/\s+/g, ' ').trim();
    if (!flat) continue;
    parts.push(`${key}: ${flat.length > DETAIL_VALUE_MAX ? `${flat.slice(0, DETAIL_VALUE_MAX)}…` : flat}`);
  }
  return parts.join('；');
}

function clip(text: string, limit: number): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= limit) return flat;
  return `${flat.slice(0, Math.max(limit, 0))}…(已压缩 ${flat.length - limit} 字符)`;
}

function renderItem(item: AnswerDigestItem, index: number, cap: number): string {
  const seq = item.seq ?? index + 1;
  const detail = item.detail ? `（${item.detail}）` : '';
  const status = item.failed ? '（执行失败）' : '';
  return `- #${seq} ${item.tool}${detail}${status}: ${clip(item.resultText, cap)}`;
}

/**
 * 生成作答阶段使用的工具结果清单。
 * 保证每条调用都出现（含内容完全相同的多条），超预算时按同一比例收缩单条上限。
 */
export function buildAnswerDigest(
  items: readonly AnswerDigestItem[],
  opts: AnswerDigestOptions = {}
): string {
  if (items.length === 0) return '（无）';

  const totalBudget = opts.totalBudget ?? ANSWER_DIGEST_DEFAULTS.totalBudget;
  const perToolBudget = opts.perToolBudget ?? ANSWER_DIGEST_DEFAULTS.perToolBudget;

  const reserved =
    DIGEST_HEADER.length + DIGEST_TRUNCATION_NOTE.length + items.length * 40 + 8;
  const available = Math.max(totalBudget - reserved, MIN_ITEM_BUDGET * items.length);
  let cap = Math.max(MIN_ITEM_BUDGET, Math.min(perToolBudget, Math.floor(available / items.length)));

  const render = (limit: number): string[] =>
    items.map((item, i) => renderItem(item, i, limit));

  let lines = render(cap);
  while (cap > MIN_ITEM_BUDGET && reserved + lines.join('\n').length > totalBudget) {
    cap = Math.max(MIN_ITEM_BUDGET, Math.floor(cap * 0.8));
    lines = render(cap);
  }

  return `${DIGEST_HEADER}\n${lines.join('\n')}\n\n${DIGEST_TRUNCATION_NOTE}`;
}

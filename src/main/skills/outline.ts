/**
 * 技能手册的「摘要注入 + 按需取章节」。
 *
 * 事故背景：`skill.run` 一次性返回 12k 字符手册，而这 12k 会在后续**每一轮**决策请求里
 * 重复出现（prompt 从 2553 → 9692 token 只用了 5 轮），既推高成本，又把上下文挤到
 * 作答阶段溢出。现在激活技能只返回「开篇概览 + 章节清单」，具体章节用
 * `skill.read {skill, path:"SKILL.md", section}` 按需取。
 */

export interface SkillSection {
  /** 1 起的章节序号 */
  index: number;
  /** 标题文本（不含 # 号） */
  title: string;
  level: number;
  /** 章节正文字符数 */
  chars: number;
  text: string;
}

/** 开篇概览保留的字符数：通常覆盖「适用场景 / 执行步骤总览 / 阈值表」 */
const HEAD_CHARS = 1200;
/** 摘要里章节清单的字符上限，防止章节极多的手册把摘要撑大 */
const OUTLINE_CHARS = 2400;

function headingLevels(body: string): number[] {
  const levels = new Set<number>();
  for (const line of body.split('\n')) {
    const m = /^(#{1,6})\s+\S/.exec(line);
    if (m) levels.add(m[1].length);
  }
  return [...levels].sort((a, b) => a - b);
}

/** 选章节切分粒度：优先二级标题，没有二级就用三级 */
function splitLevel(body: string): number {
  const levels = headingLevels(body);
  const deeper = levels.filter((l) => l > 1);
  return deeper[0] ?? 0;
}

/** 按标题切分正文；切分管线之前的正文算作开篇（不进章节清单） */
export function splitSkillSections(body: string): SkillSection[] {
  const level = splitLevel(body);
  if (level === 0) return [];
  const lines = body.split('\n');
  const sections: SkillSection[] = [];
  let current: { title: string; level: number; lines: string[] } | null = null;
  for (const line of lines) {
    const m = new RegExp(`^(#{1,6})\\s+(.+)$`).exec(line);
    if (m && m[1].length <= level) {
      if (current) sections.push({ ...current, index: sections.length + 1, chars: current.lines.join('\n').length, text: current.lines.join('\n').trim() });
      current = { title: m[2].trim(), level: m[1].length, lines: [line] };
      continue;
    }
    if (current) current.lines.push(line);
  }
  if (current) sections.push({ ...current, index: sections.length + 1, chars: current.lines.join('\n').length, text: current.lines.join('\n').trim() });
  return sections;
}

function outlineLines(sections: readonly SkillSection[]): string[] {
  const lines: string[] = [];
  let used = 0;
  for (const s of sections) {
    const line = `  ${s.index}. ${s.title}（${s.chars} 字）`;
    if (used + line.length > OUTLINE_CHARS) {
      lines.push(`  …（其余 ${sections.length - s.index + 1} 个章节见 skill.read，按序号取）`);
      break;
    }
    used += line.length;
    lines.push(line);
  }
  return lines;
}

/**
 * 技能激活时返回的正文：开篇概览（超过阈值就截断）+ 章节清单 + 取用说明。
 * 短手册（≤ 开篇阈值）直接给全文，避免小技能被迫多跑一轮 skill.read。
 */
export function buildSkillSummary(body: string, skillName: string): string {
  const flat = body.trim();
  if (flat.length <= HEAD_CHARS) return flat;

  const sections = splitSkillSections(body);
  const head = flat.slice(0, HEAD_CHARS).trimEnd();
  const parts = [`【开篇概览（前 ${HEAD_CHARS} 字，完整章节见下方清单）】`, head];

  if (sections.length > 0) {
    parts.push(
      '',
      '【章节清单（正文按需加载，禁止一次要全文）】',
      ...outlineLines(sections),
      '',
      `【取用方式】需要某章细节时调用 skill.read {skill:"${skillName}", path:"SKILL.md", section:"序号或标题关键词"}；` +
        '一次只取当前步骤需要的章节，不要预取全部。'
    );
  } else {
    parts.push(
      '',
      '【继续阅读】手册无二级标题，剩余正文请用 skill.read {skill:"' +
        skillName +
        '", path:"SKILL.md", section:"rest"} 获取。'
    );
  }
  return parts.join('\n');
}

export interface SkillSectionResult {
  title: string;
  content: string;
}

/**
 * 按序号或标题关键词取章节；`rest` 取开篇之后的全部剩余内容。
 * 找不到时抛出带可用章节清单的错误，避免模型反复猜。
 */
export function readSkillSection(body: string, selector: string): SkillSectionResult {
  const flat = selector.trim();
  if (!flat) throw new Error('缺少 section 参数（章节序号或标题关键词）');

  const sections = splitSkillSections(body);
  if (sections.length === 0) {
    if (/^(rest|all|全文)$/i.test(flat)) return { title: '全文', content: body.trim() };
    throw new Error('该手册没有可切分的章节，请用 section:"rest" 或省略 section 读取全文');
  }

  if (/^(rest|all|全文)$/i.test(flat)) {
    return { title: '剩余正文', content: body.trim().slice(HEAD_CHARS).trim() };
  }

  if (/^\d+$/.test(flat)) {
    const n = Number(flat);
    const hit = sections.find((s) => s.index === n);
    if (!hit) throw new Error(`章节序号超出范围（共 ${sections.length} 章）`);
    return { title: hit.title, content: hit.text };
  }

  const needle = flat.toLowerCase();
  const hit =
    sections.find((s) => s.title.toLowerCase().includes(needle)) ??
    sections.find((s) => s.text.toLowerCase().includes(needle));
  if (!hit) {
    const list = sections.map((s) => `${s.index}. ${s.title}`).join('；');
    throw new Error(`未找到匹配「${flat}」的章节。可用章节：${list}`);
  }
  return { title: hit.title, content: hit.text };
}

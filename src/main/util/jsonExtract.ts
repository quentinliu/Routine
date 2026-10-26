/**
 * 从 LLM 自由文本中提取第一个括号平衡的 JSON 对象：
 * 剥 ``` 代码围栏、忽略字符串内的花括号与引号转义。
 * textJson 策略与 browser 决策循环共用，避免解析逻辑双份漂移。
 */
export function extractJsonObject<T = Record<string, unknown>>(raw: string): T | null {
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
          return JSON.parse(stripped.slice(start, i + 1)) as T;
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

interface TailState {
  depth: number;
  inString: boolean;
  danglingEscape: boolean;
}

/** 扫描到文本末尾，得到未闭合状态（用于补齐被截断的 JSON） */
function scanTail(text: string): TailState {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (const ch of text) {
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
    if (ch === '}') depth--;
  }
  return { depth, inString, danglingEscape: escaped };
}

/**
 * 宽松解析：上游流被提前切断时，`extractJsonObject` 因括号不平衡返回 null，
 * 已生成的完整内容会整体丢弃（v0.5.1 巡检事故根因）。此函数先补齐未闭合的
 * 引号/花括号再解析；仍失败则按 key 抢救完整的字符串字段（如 final）。
 */
export function salvageJsonObject<T = Record<string, unknown>>(
  raw: string,
  keys: readonly string[] = ['final', 'thought']
): T | null {
  const strict = extractJsonObject<T>(raw);
  if (strict) return strict;

  const stripped = raw.replace(/```(?:json)?/g, '').trim();
  const start = stripped.indexOf('{');
  if (start < 0) return null;
  const tail = stripped.slice(start);
  const state = scanTail(tail);
  const closing = '}'.repeat(Math.max(state.depth, 0));

  const candidates: string[] = [];
  if (state.inString) {
    candidates.push(`${tail}${state.danglingEscape ? '\\' : ''}"${closing}`);
  }
  candidates.push(`${tail}${closing}`);
  if (!state.inString && tail.trimEnd().endsWith(':')) {
    candidates.push(`${tail} null${closing}`);
  }
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as T;
    } catch {
      // 继续尝试下一个补全方案
    }
  }

  // 结构性抢救：对象补不齐时，至少把已经写完整的字符串字段捞回来
  const picked: Record<string, string> = {};
  for (const key of keys) {
    const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`);
    const m = re.exec(tail);
    if (!m) continue;
    try {
      picked[key] = JSON.parse(`"${m[1]}"`) as string;
    } catch {
      picked[key] = m[1];
    }
  }
  return Object.keys(picked).length > 0 ? (picked as unknown as T) : null;
}

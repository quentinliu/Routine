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

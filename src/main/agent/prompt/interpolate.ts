/**
 * 提示词变量插值：只认 `{{snake_case}}`。
 * 与字符串 replace 链的差别在于失败可见——未赋值的变量、非法变量名都直接抛错并指名分段。
 */

const PLACEHOLDER = /\{\{\s*([^{}]*?)\s*\}\}/g;
const VAR_NAME = /^[a-z][a-z0-9_]*$/;

export type InterpolationVars = Readonly<Record<string, string>>;

export function interpolate(text: string, vars: InterpolationVars, sectionName: string): string {
  const filled = text.replace(PLACEHOLDER, (raw, rawName: string) => {
    const name = rawName.trim();
    if (!VAR_NAME.test(name)) {
      throw new Error(
        `提示词分段 ${sectionName} 含非法变量名 ${raw}（只允许 {{snake_case}}，小写字母开头）`
      );
    }
    if (!(name in vars)) {
      throw new Error(`提示词分段 ${sectionName} 引用了未赋值变量 ${raw}`);
    }
    return vars[name];
  });
  if (filled.includes('{{')) {
    throw new Error(`提示词分段 ${sectionName} 存在未闭合的变量占位符 {{`);
  }
  return filled;
}

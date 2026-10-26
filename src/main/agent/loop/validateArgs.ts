/**
 * 工具参数校验（JSON Schema 子集）：只拦「结构性错误」——必填缺失、对象/数组形状不符、
 * 枚举越界。标量类型不做强校验：模型常把数字写成字符串（"30000"），而工具侧本来就会
 * 自行 Number()/String() 强转，误判的代价远高于漏判。
 *
 * 触发场景见 sessionlog.txt：todo.write 的嵌套字段 content 在文本协议下不可见，
 * 模型写成 title，工具报「第 1 项 content 不能为空」但错误不指向字段路径，还消耗了一整轮。
 */

export interface ArgIssue {
  /** 出错字段路径，如 todos[0].content */
  path: string;
  message: string;
}

const MAX_ISSUES = 5;
/** 递归深度上限：todo.write 这类两层结构足够，避免深层 schema 拖慢每轮校验 */
const MAX_DEPTH = 2;
/** 数组校验元素上限：防止超大数组把校验变成性能问题 */
const MAX_ARRAY_SAMPLES = 20;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function join(parent: string, key: string): string {
  return parent ? `${parent}.${key}` : key;
}

function push(issues: ArgIssue[], path: string, message: string, maxIssues: number): void {
  if (issues.length >= maxIssues) return;
  issues.push({ path, message });
}

function check(
  schema: unknown,
  value: unknown,
  path: string,
  depth: number,
  issues: ArgIssue[],
  maxIssues: number
): void {
  if (issues.length >= maxIssues || !isDict(schema)) return;

  const type = typeof schema.type === 'string' ? schema.type : undefined;

  if (type === 'object') {
    if (!isDict(value)) {
      push(issues, path || '参数', `应为对象，实际是 ${describe(value)}`, maxIssues);
      return;
    }
    const required = Array.isArray(schema.required)
      ? schema.required.filter((k): k is string => typeof k === 'string')
      : [];
    for (const key of required) {
      const child = value[key];
      if (child === undefined || child === null || child === '') {
        push(issues, join(path, key), '为必填项，不能为空', maxIssues);
      }
    }
    const props = isDict(schema.properties) ? schema.properties : {};
    for (const [key, propSchema] of Object.entries(props)) {
      const child = value[key];
      if (child === undefined || child === null) continue;
      const childType =
        isDict(propSchema) && typeof propSchema.type === 'string' ? propSchema.type : undefined;
      // 只对「更深一层的结构」截断；本层字段的 enum/必填仍然检查
      const structural = childType === 'object' || childType === 'array';
      if (structural && depth + 1 > MAX_DEPTH) continue;
      check(propSchema, child, join(path, key), depth + 1, issues, maxIssues);
    }
    return;
  }

  if (type === 'array') {
    if (!Array.isArray(value)) {
      push(issues, path || '参数', `应为数组，实际是 ${describe(value)}`, maxIssues);
      return;
    }
    if (depth >= MAX_DEPTH) return;
    if (schema.items !== undefined) {
      value
        .slice(0, MAX_ARRAY_SAMPLES)
        .forEach((item, i) => check(schema.items, item, `${path}[${i}]`, depth + 1, issues, maxIssues));
    }
    return;
  }

  const enumValues = Array.isArray(schema.enum) ? schema.enum : [];
  if (enumValues.length > 0 && !enumValues.some((v) => v === value)) {
    push(
      issues,
      path || '参数',
      `取值不合法，可选：${enumValues.map((v) => String(v)).join(' / ')}`,
      maxIssues
    );
  }
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (Array.isArray(value)) return '数组';
  return typeof value === 'object' ? '对象' : `${typeof value}（${String(value).slice(0, 20)}）`;
}

/** 返回参数问题清单；空数组表示通过。默认最多报告 5 条，便于模型一次改对。 */
export function validateArgs(
  schema: Readonly<Record<string, unknown>> | undefined,
  args: unknown,
  maxIssues = MAX_ISSUES
): ArgIssue[] {
  const issues: ArgIssue[] = [];
  check(schema, args, '', 0, issues, Math.max(1, maxIssues));
  return issues;
}

/** 把问题清单压成一行提示：路径在前，模型才能定位到嵌套字段 */
export function formatArgIssues(issues: readonly ArgIssue[]): string {
  return issues.map((i) => `${i.path} ${i.message}`).join('；');
}

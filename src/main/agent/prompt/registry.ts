import type { ToolDefinition } from '../tools/types';
import { interpolate, type InterpolationVars } from './interpolate';

export type PromptStrategyId = 'function-calling' | 'text-json';

export interface AssembleContext {
  readonly strategy: PromptStrategyId;
  readonly tools: readonly ToolDefinition[];
  readonly vars: InterpolationVars;
}

/**
 * 提示词分段：order 升序拼接，strategies 缺省表示两种循环策略都注入。
 * text 为函数时按上下文现算（如工具清单、技能目录），为字符串时走严格 `{{var}}` 插值。
 */
export interface PromptSection {
  readonly name: string;
  readonly order: number;
  /** 按策略覆盖 order：两版模板相对顺序冲突时使用（如技能目录在 FC 位于结尾） */
  readonly orderByStrategy?: Partial<Record<PromptStrategyId, number>>;
  readonly strategies?: readonly PromptStrategyId[];
  readonly text: string | ((ctx: AssembleContext) => string);
}

/** 中央槽位：新增分段时在此登记，避免各段 order 互相撞车 */
export const SECTION_ORDERS = {
  IDENTITY: -100,
  /** 文本协议专用的工具清单（FC 模式由 tools 数组自带 schema） */
  TOOL_LIST: 0,
  MCP_TOOLS: 50,
  /** 技能目录：FC 覆盖为 850（原模板位于结尾） */
  SKILLS: 100,
  MEMORY: 200,
  SSH_HOSTS: 300,
  /** 文本协议的输出格式（原模板位于规则之前） */
  OUTPUT_PROTOCOL: 400,
  RULES: 500,
  /** 工具守则区起点，按工具逐个 +10 */
  TOOL_GUIDES: 550,
  INJECTION_RULE: 600,
  TODO_RULE: 700,
  CLOSING_ZH: 800,
  /** FC 下技能目录的落点：原模板在中文收尾之后 */
  SKILLS_FC: 850
} as const;

/**
 * 分段注册表：编排器唯一提示词装配入口。
 * 每次 assemble 现算——MCP 工具会运行期 register/unregister，分发时收集会产生残留段落。
 */
export class PromptRegistry {
  private readonly sections = new Map<string, PromptSection>();

  /** 注册分段，返回 disposer */
  section(section: PromptSection): () => void {
    if (this.sections.has(section.name)) {
      throw new Error(`提示词分段重复注册: ${section.name}`);
    }
    this.sections.set(section.name, section);
    return () => {
      if (this.sections.get(section.name) === section) this.sections.delete(section.name);
    };
  }

  names(): string[] {
    return [...this.sections.keys()];
  }

  assemble(
    strategy: PromptStrategyId,
    tools: readonly ToolDefinition[],
    vars: InterpolationVars = {}
  ): string {
    const ctx: AssembleContext = { strategy, tools, vars };
    const seen = new Set<string>();
    const parts: { order: number; index: number; text: string }[] = [];

    // 工具分段在装配时从工具定义现算，与 MCP 动态注册解耦
    [...this.sections.values(), ...toolSections(tools)].forEach((section, index) => {
      if (seen.has(section.name)) throw new Error(`提示词分段重名: ${section.name}`);
      seen.add(section.name);
      if (section.strategies && !section.strategies.includes(strategy)) return;

      const raw = typeof section.text === 'function' ? section.text(ctx) : section.text;
      const text = interpolate(raw, vars, section.name).trim();
      if (!text) return;
      const order = section.orderByStrategy?.[strategy] ?? section.order;
      parts.push({ order, index, text });
    });

    return parts
      .sort((a, b) => a.order - b.order || a.index - b.index)
      .map((p) => p.text)
      .join('\n\n');
  }
}

function toolSections(tools: readonly ToolDefinition[]): PromptSection[] {
  const out: PromptSection[] = [];
  for (const tool of tools) {
    const guide = tool.promptSection;
    if (!guide) continue;
    out.push({
      name: guide.name,
      order: guide.order,
      strategies: guide.strategies,
      text: guide.text
    });
  }
  return out;
}

import type { AgentName, AgentStatus, LogEntry } from '../../../shared/types';
import type { OrchestratorEvent } from '../orchestrator';
import type { PromptStrategyId } from '../prompt/registry';
import type { ApprovalOutcome, RiskClass } from '../safety';

/** 一次审批的结果：由 registry 在等待结束后回调，供编排器落会话日志 */
export interface ApprovalInfo {
  tool: string;
  risk: RiskClass;
  outcome: ApprovalOutcome;
  /** 用户决策耗时（ms）：与命令执行耗时分开记录 */
  waitMs: number;
  /** 审批时展示的完整内容（命令/SQL 原文） */
  detail: string;
}

/** 工具执行上下文：由编排器按次构建，status/log 已绑定工具所属 Agent */
export interface ToolContext {
  sessionId: string;
  /** 所属任务 id（写入审计，便于与会话日志关联） */
  msgId?: string;
  /** 原始事件通道（如推送 safety 确认请求） */
  emit: (e: OrchestratorEvent) => void;
  /** 以本工具所属 Agent 名义推送状态 */
  status: (state: AgentStatus['state'], detail: string) => void;
  /** 以本工具所属 Agent 名义写日志 */
  log: (text: string, level?: LogEntry['level']) => void;
  /** 用户中止信号，长耗时工具应响应 */
  signal: AbortSignal;
  /** 审批结束回调（仅非 safe 工具会触发） */
  approval?: (info: ApprovalInfo) => void;
}

/** 非安全级工具在审批前必须给出的确认文案；缺省字段走 registry 通用兜底 */
export interface SafetyDescriptor {
  actionSummary: string;
  plan: string[];
  /** 等待确认时的状态详情，缺省 `等待确认: ${actionSummary 前 50 字}` */
  waitingStatus?: string;
  /** 等待确认时的日志文本（warn 级），缺省 `高风险操作 ${name} 等待用户确认` */
  waitingLog?: string;
  /** 拒绝后的状态详情，缺省 `用户已拒绝` */
  rejectStatus?: string;
  /** 拒绝后抛出的错误文案，缺省 `用户拒绝执行该操作: ${name}` */
  rejectError?: string;
  /** 确认超时后的状态详情，缺省 `确认超时，未执行` */
  timeoutStatus?: string;
  /** 确认超时后抛出的错误文案，缺省 `确认超时（无人响应），未执行该操作: ${name}` */
  timeoutError?: string;
}

/**
 * 统一工具定义：内置工具与未来的 MCP 工具共用同一形态。
 * risk 为函数时可按参数分级（如 computer.exec 按 op 白名单）。
 */
export interface ToolDefinition {
  name: string;
  description: string;
  /** JSON Schema（A2 起供 function calling 映射） */
  inputSchema: Record<string, unknown>;
  /** 状态面板归属的 Agent */
  agent: AgentName;
  /** 工具结果送入模型的字符上限，缺省用编排器默认值（4000） */
  maxResultChars?: number;
  risk: RiskClass | ((args: Record<string, unknown>) => RiskClass);
  /**
   * 风险底线：Settings.riskOverrides 不得把该工具降到 floor 以下。
   * 远程执行/写库类工具（ssh.exec、db.exec）应为 medium——否则一条设置即可静默执行。
   */
  riskFloor?: RiskClass;
  /** risk 非 safe 时由 registry 调用，产出审批文案；校验类错误应在此抛出（早于审批） */
  describe?: (args: Record<string, unknown>, risk: RiskClass) => SafetyDescriptor;
  /**
   * 动态提示词上下文（如 SSH 主机清单）：不进 system prompt，
   * 由编排器拼成消息尾部的「运行时上下文」快照。无内容返回空串。
   */
  promptContext?(): string;
  /**
   * 跨调用行为守则（与工具定义同文件就近维护），装配系统提示词时收集。
   * 单次调用说明写进 inputSchema 字段描述，不要放这里。
   */
  promptSection?: {
    name: string;
    order: number;
    text: string;
    /** 缺省两种循环策略都注入 */
    strategies?: readonly PromptStrategyId[];
  };
  /** 文本协议工具清单里的补充行（如 computer.exec 的 op 枚举），FC 模式不使用 */
  promptListExtra?: string;
  /** 工具结果渲染（缺省 JSON.stringify）；渲染后仍受 maxResultChars 截断 */
  render?(result: unknown): string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

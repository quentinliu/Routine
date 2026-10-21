import type { AgentName, AgentStatus, LogEntry } from '../../../shared/types';
import type { OrchestratorEvent } from '../orchestrator';
import type { RiskClass } from '../safety';

/** 工具执行上下文：由编排器按次构建，status/log 已绑定工具所属 Agent */
export interface ToolContext {
  sessionId: string;
  /** 原始事件通道（如推送 safety 确认请求） */
  emit: (e: OrchestratorEvent) => void;
  /** 以本工具所属 Agent 名义推送状态 */
  status: (state: AgentStatus['state'], detail: string) => void;
  /** 以本工具所属 Agent 名义写日志 */
  log: (text: string, level?: LogEntry['level']) => void;
  /** 用户中止信号，长耗时工具应响应 */
  signal: AbortSignal;
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
  /** risk 非 safe 时由 registry 调用，产出审批文案；校验类错误应在此抛出（早于审批） */
  describe?: (args: Record<string, unknown>, risk: RiskClass) => SafetyDescriptor;
  /** 动态提示词上下文（如 SSH 主机清单），无则不贡献 */
  promptContext?(): string;
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<unknown>;
}

import { redactSecrets } from '../../util/redact';

/**
 * 工具摘要的单一事实源：执行过程（内存态 trace）与对话日志（落盘 JSONL）都从这里取值，
 * 只在使用处按各自显示需要截断，避免两套常量与逻辑漂移。
 */

/** 参数摘要上限：需容纳一条完整远程命令/管理 SQL，否则事后无法还原「执行了什么」 */
export const TOOL_ARGS_LIMIT = 1000;
/** 对话日志里工具结果摘要上限：够核对数值来源，又不把完整 stdout 落盘 */
export const TOOL_RESULT_LOG_LIMIT = 800;
/** 执行过程一行能装下的结果摘要上限 */
export const TOOL_RESULT_TRACE_LIMIT = 160;

/** 参数摘要：先脱敏再截断——日志可回放，但不能把密码/密钥写进磁盘 */
export function buildArgsDigest(args: unknown): string {
  return JSON.stringify(redactSecrets(args ?? {})).slice(0, TOOL_ARGS_LIMIT);
}

export interface ResultDigest {
  /** 执行过程用（一行） */
  trace: string;
  /** 对话日志用（较长，供事后核对） */
  log: string;
  /** 渲染后结果的完整字符数 */
  chars: number;
}

export function buildResultDigest(text: string): ResultDigest {
  return {
    trace: text.slice(0, TOOL_RESULT_TRACE_LIMIT),
    log: text.slice(0, TOOL_RESULT_LOG_LIMIT),
    chars: text.length
  };
}

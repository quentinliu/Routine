/**
 * 决策轮的输出上限。
 *
 * 早期取值 2048 是按「一句话决策」估的，实际一轮输出里常混着三样东西：
 * 中文说明、多路并行 tool_calls 的 JSON、以及推理模型的思维链（reasoning 也计入
 * completion）。2026-10-26 巡检日志就是活证据：glm-5.3-flash 第 3 轮 completion
 * 正好 2048 被截断，content 与 tool_calls 双双为空，一个查询都没发出去。
 */
export const DECISION_MAX_TOKENS = 8192;

/**
 * 文本协议决策 JSON 本身很短，但小模型也爱写长 thought；
 * 4096 足够，再高对本地 Ollama 的上下文不友好。
 */
export const TEXT_JSON_DECISION_MAX_TOKENS = 4096;

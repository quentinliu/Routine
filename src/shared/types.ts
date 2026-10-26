// ===== Routine 共享领域类型（FROZEN — 修改需经编排者批准）=====

export interface CloudProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

// 云端模型档案：支持多配置与主界面切换；旧单配置 cloud 读取时迁移为单条 profile（M1 契约批准 2026-10-24）
export interface CloudProfile extends CloudProviderConfig {
  id: string;
  label: string;
}

export interface OllamaConfig {
  baseURL: string;
  model: string;
}

// ===== 联网搜索（T2 契约批准 2026-10-21，见 CONTRACTS.md 变更记录）=====

/**
 * auto = 自动回退链：Tavily(配置 Key 时) → 必应，首个成功即返回；
 * DuckDuckGo 已移除（在受限网络不可达），旧配置的 duckduckgo 读取时归一为 auto
 */
export type SearchProvider = 'auto' | 'bing' | 'tavily';

export interface SearchConfig {
  provider: SearchProvider;
  tavilyApiKey: string;
}

export interface SiteCredential {
  username: string;
  password: string;
}

export interface SchedulerConfig {
  /** 定时任务最大并发执行数（1 = 串行执行，与历史行为一致） */
  maxConcurrent: number;
}

export interface AgentConfig {
  /** ReAct 循环最大轮数，范围 [2, 30]（A2 契约批准 2026-10-21） */
  maxSteps: number;
  /**
   * 作答阶段单次请求的输出上限（token），范围 [1024, 8192]，缺省 4096。
   * 命中上限后编排器会自动分段续写，仍被截断时在回答末尾显式标注「未完成」。
   */
  answerMaxTokens?: number;
}

/** 界面主题：system 跟随操作系统（M5 契约批准 2026-10-25） */
export type ThemeMode = 'system' | 'light' | 'dark';

export interface Settings {
  providerMode: 'cloud' | 'local';
  /** 云端模型档案列表（≥1 条）；activeCloudId 失效时由主进程归一为首条 */
  cloudProfiles: CloudProfile[];
  /** 主界面当前使用的云端 profile id */
  activeCloudId: string;
  ollama: OllamaConfig;
  search: SearchConfig;
  indexDirs: string[];
  excludeGlobs: string[];
  scheduler: SchedulerConfig;
  siteCredentials?: Record<string, SiteCredential>;
  agent: AgentConfig;
  /** 技能启用状态覆盖（key = skill name；缺省视为启用；S1 契约） */
  skillOverrides?: Record<string, boolean>;
  /** 托盘行为；缺省 closeToTray: true（M2 契约批准 2026-10-24，见 CONTRACTS.md 变更记录） */
  tray?: { closeToTray: boolean };
  /** 系统通知开关；缺省 enabled: true（M2） */
  notifications?: { enabled: boolean };
  /** 工具风险级覆盖（key = 工具名；基线 high 不可下调至 safe，未知工具忽略；M2） */
  riskOverrides?: Record<string, 'safe' | 'medium' | 'high'>;
  /** 界面主题；缺省 system（M5 契约批准 2026-10-25） */
  appearance?: { theme: ThemeMode };
}

// indexDirs 中的 "~" 由主进程在读取后展开为 os.homedir()
const DEFAULT_CLOUD_PROFILE: CloudProfile = {
  id: 'default',
  label: '智谱 GLM · glm-4.6',
  baseURL: 'https://open.bigmodel.cn/api/paas/v4',
  apiKey: '',
  model: 'glm-4.6'
};

export const DEFAULT_SETTINGS: Settings = {
  providerMode: 'cloud',
  cloudProfiles: [DEFAULT_CLOUD_PROFILE],
  activeCloudId: DEFAULT_CLOUD_PROFILE.id,
  ollama: {
    baseURL: 'http://localhost:11434',
    model: 'qwen2.5:3b'
  },
  search: {
    provider: 'auto',
    tavilyApiKey: ''
  },
  indexDirs: ['~/Desktop', '~/Documents', '~/Downloads'],
  excludeGlobs: ['node_modules/**', '.git/**', 'Library/**', '*.app/**', '**/*.dmg', '**/*.zip'],
  scheduler: { maxConcurrent: 1 },
  siteCredentials: {},
  agent: { maxSteps: 12 },
  appearance: { theme: 'system' }
};

export interface ChatMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  createdAt: number;
}

export interface ChatSession {
  id: string;
  title: string;
  messages: ChatMessage[];
  createdAt: number;
  updatedAt: number;
}

export type AgentName =
  | 'main'
  | 'file'
  | 'computer'
  | 'search'
  | 'browser'
  | 'ssh'
  | 'db'
  | 'mcp';

export const AGENT_NAMES: AgentName[] = [
  'main',
  'file',
  'computer',
  'search',
  'browser',
  'ssh',
  'db',
  'mcp'
];

export const AGENT_LABELS: Record<AgentName, string> = {
  main: '主 Agent',
  file: '文件 Agent',
  computer: '系统 Agent',
  search: '搜索 Agent',
  browser: '浏览器 Agent',
  ssh: 'SSH Agent',
  db: '数据库 Agent',
  mcp: 'MCP'
};

export type AgentState = 'idle' | 'thinking' | 'acting' | 'waiting-approval' | 'done' | 'error';

export interface AgentStatus {
  agent: AgentName;
  state: AgentState;
  detail: string;
  updatedAt: number;
}

export interface FileRecord {
  path: string;
  name: string;
  ext: string;
  dir: string;
  size: number;
  mtime: number;
  isText: boolean;
}

export interface FileSearchResult {
  record: FileRecord;
  score: number;
  snippet?: string;
}

export interface IndexProgress {
  phase: 'idle' | 'scanning' | 'indexing' | 'done';
  scanned: number;
  indexed: number;
  totalEstimate?: number;
  currentDir?: string;
}

export interface SystemSnapshot {
  osVersion: string;
  cpuModel: string;
  cpuCores: number;
  memoryTotalMB: number;
  memoryFreeMB: number;
  diskTotalGB: number;
  diskFreeGB: number;
  battery?: { percent: number; charging: boolean };
  hostname: string;
}

export interface SafetyRequest {
  id: string;
  agent: AgentName;
  actionSummary: string;
  plan: string[];
  riskLevel: 'medium' | 'high';
  createdAt: number;
  /** 触发审批的工具名（M2 契约批准 2026-10-24，审计归因用） */
  tool?: string;
}

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
}

export interface BrowserTaskResult {
  ok: boolean;
  outputs: string[];
  summary: string;
}

export interface LogEntry {
  id: string;
  ts: number;
  agent: AgentName | 'system';
  level: 'info' | 'warn' | 'error';
  text: string;
  /**
   * 归属域：`infra` = 基础设施事件（MCP / 浏览器 / 定时调度 / 审批超时与取消），
   * 只有这类事件进右侧「执行日志」面板；缺省按 `task` 处理（任务内事件只出现在
   * 「执行过程」与「对话日志」，避免同一事件三处重复）。
   */
  scope?: 'task' | 'infra';
}

export interface ChatDeltaEvent {
  sessionId: string;
  msgId: string;
  delta: string;
  done?: boolean;
}

export interface ChatErrorEvent {
  sessionId: string;
  error: string;
}

export interface ComputerExecResult {
  summary: string;
  details?: string[];
}

export interface ComputerOp {
  op: string;
  description: string;
  risk: 'safe' | 'medium' | 'high';
}

export interface FileReadResult {
  content: string;
  truncated: boolean;
}

export type RecurrenceType = 'daily' | 'weekly' | 'monthly' | 'anytime';

export interface TodoRecurrence {
  type: RecurrenceType;
  time?: string;
  weekday?: number;
  day?: number;
}

export interface TodoTask {
  id: string;
  title: string;
  instruction: string;
  recurrence: TodoRecurrence;
  enabled: boolean;
  nextRunAt: number;
  lastRunAt?: number;
  lastChecklistDate?: string;
  createdAt: number;
  updatedAt: number;
}

export interface TodoRunRecord {
  id: string;
  taskId: string;
  sessionId: string;
  startedAt: number;
  finishedAt?: number;
  ok?: boolean;
  summary: string;
}

// ===== 数据库巡检（P1 契约批准 2026-08-31，见 CONTRACTS.md 变更记录）=====

export type DbDialect = 'mysql' | 'postgresql';

export interface DatasourceConfig {
  id: string;
  name: string;
  type: DbDialect;
  host: string;
  port: number;
  user: string;
  password: string;
  database?: string;
  ssl?: boolean;
  enabled: boolean;
  timeoutMs?: number;
  thresholds?: Record<string, number>;
}

export interface DbTestResult {
  ok: boolean;
  version: string;
  latencyMs: number;
  error?: string;
}

export type CheckStatus = 'ok' | 'warn' | 'error' | 'skipped';

export interface CheckResult {
  checkId: string;
  title: string;
  status: CheckStatus;
  value?: string;
  metrics?: Record<string, number>;
  threshold?: string;
  detail: string[];
  suggestion?: string;
  durationMs: number;
}

export interface InspectionReport {
  id: string;
  datasourceId: string;
  datasourceName: string;
  startedAt: number;
  finishedAt: number;
  ok: boolean;
  serverVersion: string;
  results: CheckResult[];
}

export interface InspectionProgressEvent {
  reportId: string;
  checkId: string;
  status: CheckStatus;
}

// 巡检趋势（M2 契约批准 2026-10-24，见 CONTRACTS.md 变更记录）
export interface DailyPoint {
  /** 'YYYY-MM-DD'（本地时区） */
  date: string;
  /** 巡检次数 */
  count: number;
  /** 失败次数 */
  failures: number;
  avgDurationMs: number;
}

export interface InspectionTrend {
  datasourceId: string;
  days: DailyPoint[];
}

// 检查项通过率行（M4 契约批准 2026-10-24，见 CONTRACTS.md 变更记录）
export interface CheckTrendRow {
  checkId: string;
  title: string;
  /** 窗口内该检查项出现的报告次数（含 skipped） */
  total: number;
  /** 其中 warn/error 次数（skipped 不计入失败） */
  fails: number;
  /** 其中因环境不适用被跳过的次数 */
  skipped: number;
  /** 近 7 天（固定窗口）该检查项的失败次数，用于「正在恶化」标记 */
  recentFails7d: number;
  lastStatus: CheckStatus;
}

/** 单检查项逐日序列点（M4 契约批准 2026-10-24，见 CONTRACTS.md 变更记录） */
export interface CheckSeriesPoint {
  /** 'YYYY-MM-DD'（本地时区） */
  date: string;
  total: number;
  fails: number;
}

// ===== SSH 远程主机（P1.5 契约批准 2026-10-16，见 CONTRACTS.md 变更记录）=====

export type SshAuthType = 'password' | 'key';

export interface SshHostConfig {
  id: string;
  name: string;
  host: string;
  port: number;
  user: string;
  authType: SshAuthType;
  password?: string;
  /** authType === 'key' 时必填，支持 ~ 展开 */
  privateKeyPath?: string;
  passphrase?: string;
  enabled: boolean;
  /** 毫秒，默认 10000，范围 [1000, 60000] */
  timeoutMs?: number;
}

export interface SshTestResult {
  ok: boolean;
  /** 远端版本横幅，如 SSH-2.0-OpenSSH_9.8 */
  banner: string;
  latencyMs: number;
}

export interface SshExecResult {
  ok: boolean;
  /** null = 被信号终止或流异常关闭 */
  code: number | null;
  signal?: string;
  stdout: string;
  stderr: string;
  truncated: boolean;
  durationMs: number;
}

export interface SshExecOptions {
  /** 毫秒，默认 30000，范围 [1000, 300000] */
  timeoutMs?: number;
  /** stdout+stderr 合计上限字节，默认 524288，范围 [1024, 10485760] */
  maxOutputBytes?: number;
}

// ===== Agent ReAct 循环（A2 契约批准 2026-10-21，见 CONTRACTS.md 变更记录）=====

/** `notice` = 任务内告警（协议降级 / 重写 / 中止 / 失败），与思考、工具调用并列展示 */
export type TracePhase = 'thought' | 'tool-start' | 'tool-end' | 'notice';

export interface AgentTraceEvent {
  sessionId: string;
  msgId: string;
  phase: TracePhase;
  /** phase=thought：推理文本；FC 流式模式下为增量片段 */
  thought?: string;
  tool?: string;
  argsDigest?: string;
  resultDigest?: string;
  error?: boolean;
  durationMs?: number;
  /** phase=notice：任务内告警文案（协议降级 / 重写 / 中止 / 失败），与对话日志中的 event 行同源 */
  notice?: string;
}

// ===== MCP 客户端（A3 契约批准 2026-10-21，见 CONTRACTS.md 变更记录）=====

export type McpTransport = 'stdio' | 'http';

export interface McpServerConfig {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpTransport;
  /** transport=stdio 时必填：可执行命令（如 npx / uvx / 绝对路径） */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** transport=http 时必填：Streamable HTTP 端点 URL */
  url?: string;
  headers?: Record<string, string>;
  /** 该服务工具的默认风险级：medium 走安全门确认；safe 直接执行 */
  riskDefault: 'safe' | 'medium';
  /** 应用启动时自动连接 */
  autoConnect: boolean;
}

export interface McpToolInfo {
  /** 注册进工具注册表的完整名称：mcp__{server}__{tool} */
  fullName: string;
  /** MCP server 侧原始工具名 */
  name: string;
  description: string;
  /** 工具参数 JSON Schema（映射 function calling 用） */
  inputSchema?: Record<string, unknown>;
}

export type McpConnState = 'disconnected' | 'connecting' | 'connected' | 'error';

export interface McpServerInfo {
  config: McpServerConfig;
  state: McpConnState;
  error?: string;
  tools: McpToolInfo[];
}

export interface McpTestResult {
  ok: boolean;
  toolCount: number;
  tools: McpToolInfo[];
  error?: string;
  latencyMs: number;
}

// ===== 任务子任务清单（T1 契约批准 2026-10-21，见 CONTRACTS.md 变更记录）=====
// 命名避开既有定时任务 TodoTask / TodoTaskStatus

export type TaskTodoStatus = 'pending' | 'in_progress' | 'completed';

export interface TaskTodoItem {
  content: string;
  status: TaskTodoStatus;
}

export interface TodoUpdateEvent {
  sessionId: string;
  /** 全量快照，渲染端整表替换 */
  todos: TaskTodoItem[];
}

// ===== Skills（S1 契约扩展，见 CONTRACTS.md 变更记录）=====
// 格式遵循 Agent Skills 开放标准（agentskills.io）：目录 + SKILL.md（YAML frontmatter + 正文）

export interface SkillInfo {
  /** SKILL.md frontmatter name（与目录同名，全局唯一标识） */
  name: string;
  /** frontmatter description（≤1024 字符，注入规划提示词的目录行） */
  description: string;
  /** metadata.version，未声明时为空串 */
  version: string;
  /** 来源根：builtin = 随应用分发（只读），user = userData/skills（可删） */
  source: 'builtin' | 'user';
  /** 有效启用状态（settings.skillOverrides 覆盖后） */
  enabled: boolean;
  /** 检测到 scripts/ 目录：本机宿主无法执行，激活时按适配层规则降级为手动步骤 */
  partial: boolean;
  /** 引擎适配标签（约定读取 metadata.engine），供 UI 过滤展示 */
  engine?: string;
}

export interface SkillDetail extends SkillInfo {
  /** SKILL.md 正文（frontmatter 之后），激活时进入模型上下文的同一份内容 */
  body: string;
  /** 技能目录内相对于技能根的附加文件清单（references 等） */
  files: string[];
}


// 完整对话日志（U5 契约批准 2026-10-26，见 CONTRACTS.md 变更记录）
export interface ConversationTaskMeta {
  /** 任务 msgId，同任务全部轮次共用 */
  id: string;
  sessionId: string;
  /** 用户任务文本（≤200 字符摘要） */
  task: string;
  provider: string;
  ts: number;
}

/**
 * JSONL 单行；round/tool/event/final/error 的专有字段见 conversationLog.ts。
 * tool 行：name / argsDigest / ok / denied / durationMs / resultChars / resultDigest
 * （参数与结果均已脱敏并按长度截断，用于回答中数值的可追溯性）
 * round 行：增量落盘，`msgs` 为「以 base 为起点替换尾段」，`systemRef` 表示复用上一轮 system；
 * read() 负责物化成完整 messages/system，旧格式（全量 `messages`）继续可直接读取。
 */
export interface ConversationLogLine {
  type: 'task' | 'round' | 'tool' | 'safety' | 'event' | 'final' | 'error';
  at: number;
  /** final 行：该回答是否经过降级（截断抢救 / 轮次耗尽 / 一致性重写） */
  degraded?: boolean;
  /** final 行：回答来源（decision=决策轮 / answer=作答阶段 / digest=兜底摘要） */
  answeredBy?: 'decision' | 'answer' | 'digest';
  /** round 行：与上一轮相同的 system 未重复落盘，读取时回填 */
  systemRef?: boolean;
  /** round 行：增量消息（base 之前的消息沿用上一轮） */
  msgs?: { base: number; items: unknown[] };
  [key: string]: unknown;
}

export interface ConversationLogView {
  meta: ConversationTaskMeta;
  lines: ConversationLogLine[];
}

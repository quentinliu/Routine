// ===== Routine 共享领域类型（FROZEN — 修改需经编排者批准）=====

export interface CloudProviderConfig {
  baseURL: string;
  apiKey: string;
  model: string;
}

export interface OllamaConfig {
  baseURL: string;
  model: string;
}

export interface SearchConfig {
  provider: 'duckduckgo' | 'tavily';
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

export interface Settings {
  providerMode: 'cloud' | 'local';
  cloud: CloudProviderConfig;
  ollama: OllamaConfig;
  search: SearchConfig;
  indexDirs: string[];
  excludeGlobs: string[];
  scheduler: SchedulerConfig;
  siteCredentials?: Record<string, SiteCredential>;
}

// indexDirs 中的 "~" 由主进程在读取后展开为 os.homedir()
export const DEFAULT_SETTINGS: Settings = {
  providerMode: 'cloud',
  cloud: {
    baseURL: 'https://open.bigmodel.cn/api/paas/v4',
    apiKey: '',
    model: 'glm-4.6'
  },
  ollama: {
    baseURL: 'http://localhost:11434',
    model: 'qwen2.5:3b'
  },
  search: {
    provider: 'duckduckgo',
    tavilyApiKey: ''
  },
  indexDirs: ['~/Desktop', '~/Documents', '~/Downloads'],
  excludeGlobs: ['node_modules/**', '.git/**', 'Library/**', '*.app/**', '**/*.dmg', '**/*.zip'],
  scheduler: { maxConcurrent: 1 },
  siteCredentials: {}
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

export type AgentName = 'main' | 'file' | 'computer' | 'search' | 'browser';

export const AGENT_NAMES: AgentName[] = ['main', 'file', 'computer', 'search', 'browser'];

export const AGENT_LABELS: Record<AgentName, string> = {
  main: '主 Agent',
  file: '文件 Agent',
  computer: '系统 Agent',
  search: '搜索 Agent',
  browser: '浏览器 Agent'
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

// ===== IPC 通道常量 + preload 桥接类型（FROZEN — 修改需经编排者批准）=====
import type {
  AgentStatus,
  AgentTraceEvent,
  BrowserTaskResult,
  ChatDeltaEvent,
  ChatErrorEvent,
  ChatSession,
  ComputerExecResult,
  ComputerOp,
  DatasourceConfig,
  DbObjectsResult,
  DbOverview,
  DbQueryResult,
  DbTestResult,
  FileReadResult,
  FileSearchResult,
  IndexProgress,
  LogEntry,
  McpServerInfo,
  McpServerConfig,
  McpTestResult,
  ConversationLogView,
  ConversationTaskMeta,
  SafetyRequest,
  Settings,
  SkillDetail,
  SkillInfo,
  SshExecOptions,
  SshExecResult,
  SshHostConfig,
  SshTestResult,
  SystemSnapshot,
  TodoRunRecord,
  TodoTask,
  TodoUpdateEvent,
  WebSearchResult
} from './types';

export const IPC = {
  // invoke (renderer → main)
  ChatSend: 'chat:send',
  ChatStop: 'chat:stop',
  SafetyRespond: 'safety:respond',
  SessionsList: 'sessions:list',
  SessionsLoad: 'sessions:load',
  SessionsNew: 'sessions:new',
  SessionsDelete: 'sessions:delete',
  SettingsGet: 'settings:get',
  SettingsSet: 'settings:set',
  FileSearch: 'file:search',
  FileRead: 'file:read',
  FileIndexStart: 'file:index:start',
  ComputerSnapshot: 'computer:snapshot',
  ComputerExec: 'computer:exec',
  ComputerListOps: 'computer:list-ops',
  SearchWeb: 'search:web',
  BrowserRun: 'browser:run',
  BrowserAvailable: 'browser:available',
  LlmHealth: 'llm:health',
  // 云端模型档案逐个可用性检测（M1 契约批准 2026-10-24，见 CONTRACTS.md 变更记录）
  LlmHealthClouds: 'llm:health-clouds',
  // 长期记忆（M2 契约批准 2026-10-24，见 CONTRACTS.md 变更记录）
  MemoryGet: 'memory:get',
  MemorySave: 'memory:save',
  OpenExternal: 'app:open-external',
  TodoList: 'todo:list',
  TodoSave: 'todo:save',
  TodoDelete: 'todo:delete',
  TodoToggle: 'todo:toggle',
  TodoRun: 'todo:run',
  // invoke (renderer → main) — 数据库（P1 契约批准；工作台 2026-10-26 重设计）
  DbList: 'db:list',
  DbSave: 'db:save',
  DbDelete: 'db:delete',
  DbTest: 'db:test',
  DbOverview: 'db:overview',
  DbQuery: 'db:query',
  DbExec: 'db:exec',
  DbObjects: 'db:objects',
  // invoke (renderer → main) — SSH 远程主机（P1.5 契约批准）
  SshList: 'ssh:list',
  SshSave: 'ssh:save',
  SshDelete: 'ssh:delete',
  SshTest: 'ssh:test',
  SshExec: 'ssh:exec',
  // invoke (renderer → main) — MCP 服务（A3 契约批准）
  McpList: 'mcp:list',
  McpSave: 'mcp:save',
  McpDelete: 'mcp:delete',
  McpTest: 'mcp:test',
  McpConnect: 'mcp:connect',
  McpDisconnect: 'mcp:disconnect',
  // invoke (renderer → main) — Skills（S1 契约批准，见 CONTRACTS.md 变更记录）
  SkillList: 'skill:list',
  SkillRead: 'skill:read',
  SkillInstall: 'skill:install',
  SkillRemove: 'skill:remove',
  SkillPickDir: 'skill:pick-dir',
  // invoke (renderer → main) — 完整对话日志（U5 契约批准 2026-10-26，见 CONTRACTS.md 变更记录）
  ConversationList: 'conversation:list',
  ConversationGet: 'conversation:get',
  ConversationDelete: 'conversation:delete',
  ConversationClear: 'conversation:clear',
  // events (main → renderer)
  ChatDelta: 'chat:delta',
  ChatError: 'chat:error',
  AgentStatus: 'agent:status',
  AgentTrace: 'agent:trace',
  TodoUpdate: 'agent:todo',
  SafetyRequest: 'safety:request',
  LogEntry: 'log:entry',
  IndexProgress: 'index:progress',
  TodoRunsChanged: 'todo:runs-changed'
} as const;

export interface LlmHealth {
  cloud: boolean;
  local: boolean;
}

/** 事件通道 → 载荷类型映射（M3 契约批准 2026-10-24，见 CONTRACTS.md 变更记录） */
export interface EventPayloadMap {
  [IPC.ChatDelta]: ChatDeltaEvent;
  [IPC.ChatError]: ChatErrorEvent;
  [IPC.AgentStatus]: AgentStatus;
  [IPC.AgentTrace]: AgentTraceEvent;
  [IPC.TodoUpdate]: TodoUpdateEvent;
  [IPC.SafetyRequest]: SafetyRequest;
  [IPC.LogEntry]: LogEntry;
  [IPC.IndexProgress]: IndexProgress;
  [IPC.TodoRunsChanged]: undefined;
}

/**
 * preload 暴露到 window.api 的完整客户端接口。
 * 事件订阅函数返回取消订阅函数。
 */
export interface RoutineApi {
  chatSend(sessionId: string, text: string): Promise<void>;
  chatStop(): Promise<void>;
  safetyRespond(requestId: string, approved: boolean): Promise<void>;
  sessionsList(): Promise<ChatSession[]>;
  sessionsLoad(id: string): Promise<ChatSession>;
  sessionsNew(): Promise<ChatSession>;
  sessionsDelete(id: string): Promise<void>;
  settingsGet(): Promise<Settings>;
  settingsSet(settings: Settings): Promise<Settings>;
  fileSearch(query: string, limit?: number): Promise<FileSearchResult[]>;
  fileRead(path: string, maxBytes?: number): Promise<FileReadResult>;
  fileIndexStart(): Promise<void>;
  computerSnapshot(): Promise<SystemSnapshot>;
  computerExec(op: string, args: Record<string, unknown>): Promise<ComputerExecResult>;
  computerListOps(): Promise<ComputerOp[]>;
  searchWeb(query: string, maxResults?: number): Promise<WebSearchResult[]>;
  browserRun(instruction: string): Promise<BrowserTaskResult>;
  browserAvailable(): Promise<boolean>;
  llmHealth(): Promise<LlmHealth>;
  /** 逐个探测全部云端档案可用性（key = profile.id）；不含本地 Ollama */
  llmHealthClouds(): Promise<Record<string, boolean>>;
  memoryGet(): Promise<string>;
  memorySave(content: string): Promise<void>;
  openExternal(url: string): Promise<void>;
  todoList(): Promise<{ tasks: TodoTask[]; runs: TodoRunRecord[] }>;
  todoSave(task: TodoTask): Promise<TodoTask>;
  todoDelete(id: string): Promise<void>;
  todoToggle(id: string, enabled: boolean): Promise<TodoTask>;
  todoRun(id: string): Promise<void>;
  dbList(): Promise<DatasourceConfig[]>;
  dbSave(datasource: DatasourceConfig): Promise<DatasourceConfig>;
  dbDelete(id: string): Promise<void>;
  dbTest(id: string): Promise<DbTestResult>;
  /** 实时实例概览：打开工作台时采样一次，不落库 */
  dbOverview(id: string): Promise<DbOverview>;
  /** 只读查询（SELECT/SHOW/EXPLAIN/DESC，单语句，最多 200 行） */
  dbQuery(id: string, sql: string): Promise<DbQueryResult>;
  /** 写/管理语句：先经安全门确认，拒绝、超时、取消均不执行 */
  dbExec(id: string, sql: string, reason?: string): Promise<DbQueryResult>;
  /** 三层对象浏览：无 database=库列表；有 database 无 table=表列表；两者都有=表详情 */
  dbObjects(id: string, database?: string, table?: string): Promise<DbObjectsResult>;

  sshList(): Promise<SshHostConfig[]>;
  sshSave(host: SshHostConfig): Promise<SshHostConfig>;
  sshDelete(id: string): Promise<void>;
  sshTest(id: string): Promise<SshTestResult>;
  sshExec(id: string, command: string, options?: SshExecOptions): Promise<SshExecResult>;

  mcpList(): Promise<McpServerInfo[]>;
  mcpSave(server: McpServerConfig): Promise<McpServerConfig>;
  mcpDelete(id: string): Promise<void>;
  mcpTest(server: McpServerConfig): Promise<McpTestResult>;
  mcpConnect(id: string): Promise<McpServerInfo>;
  mcpDisconnect(id: string): Promise<McpServerInfo>;

  skillList(): Promise<SkillInfo[]>;
  skillRead(name: string): Promise<SkillDetail>;
  /** 弹出原生目录选择器；取消返回 null */
  skillPickDir(): Promise<string | null>;
  skillInstall(dir: string): Promise<SkillInfo>;
  skillRemove(name: string): Promise<void>;

  /** 完整对话日志：按开始时间倒序的任务元数据（U5） */
  conversationList(limit?: number): Promise<ConversationTaskMeta[]>;
  conversationGet(id: string): Promise<ConversationLogView | null>;
  /** 删除单个任务日志；id 非法或文件不存在返回 false */
  conversationDelete(id: string): Promise<boolean>;
  /** 清空全部任务日志，返回实际删除的条数 */
  conversationClear(): Promise<number>;

  onChatDelta(cb: (e: ChatDeltaEvent) => void): () => void;
  onChatError(cb: (e: ChatErrorEvent) => void): () => void;
  onAgentStatus(cb: (s: AgentStatus) => void): () => void;
  onAgentTrace(cb: (e: AgentTraceEvent) => void): () => void;
  onTodoUpdate(cb: (e: TodoUpdateEvent) => void): () => void;
  onSafetyRequest(cb: (r: SafetyRequest) => void): () => void;
  onLogEntry(cb: (l: LogEntry) => void): () => void;
  onIndexProgress(cb: (p: IndexProgress) => void): () => void;
  onTodoRunsChanged(cb: () => void): () => void;
}

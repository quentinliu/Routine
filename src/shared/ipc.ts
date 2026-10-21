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
  DbTestResult,
  FileReadResult,
  FileSearchResult,
  IndexProgress,
  InspectionProgressEvent,
  InspectionReport,
  LogEntry,
  McpServerInfo,
  McpServerConfig,
  McpTestResult,
  SafetyRequest,
  Settings,
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
  OpenExternal: 'app:open-external',
  TodoList: 'todo:list',
  TodoSave: 'todo:save',
  TodoDelete: 'todo:delete',
  TodoToggle: 'todo:toggle',
  TodoRun: 'todo:run',
  // invoke (renderer → main) — 数据库巡检（P1 契约批准）
  DbList: 'db:list',
  DbSave: 'db:save',
  DbDelete: 'db:delete',
  DbTest: 'db:test',
  InspectionRun: 'inspection:run',
  InspectionReports: 'inspection:reports',
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
  // events (main → renderer)
  ChatDelta: 'chat:delta',
  ChatError: 'chat:error',
  AgentStatus: 'agent:status',
  AgentTrace: 'agent:trace',
  TodoUpdate: 'agent:todo',
  SafetyRequest: 'safety:request',
  LogEntry: 'log:entry',
  IndexProgress: 'index:progress',
  TodoRunsChanged: 'todo:runs-changed',
  InspectionProgress: 'inspection:progress'
} as const;

export interface LlmHealth {
  cloud: boolean;
  local: boolean;
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
  inspectionRun(datasourceId: string): Promise<InspectionReport>;
  inspectionReports(datasourceId?: string): Promise<InspectionReport[]>;

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

  onChatDelta(cb: (e: ChatDeltaEvent) => void): () => void;
  onChatError(cb: (e: ChatErrorEvent) => void): () => void;
  onAgentStatus(cb: (s: AgentStatus) => void): () => void;
  onAgentTrace(cb: (e: AgentTraceEvent) => void): () => void;
  onTodoUpdate(cb: (e: TodoUpdateEvent) => void): () => void;
  onSafetyRequest(cb: (r: SafetyRequest) => void): () => void;
  onLogEntry(cb: (l: LogEntry) => void): () => void;
  onIndexProgress(cb: (p: IndexProgress) => void): () => void;
  onTodoRunsChanged(cb: () => void): () => void;
  onInspectionProgress(cb: (e: InspectionProgressEvent) => void): () => void;
}

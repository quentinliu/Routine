import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type { RoutineApi } from '../shared/ipc';

// 沙箱化 preload 无法 require 相对模块，通道名须自包含（与 src/shared/ipc.ts 的 IPC 常量保持一致）
const CH = {
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
  ChatDelta: 'chat:delta',
  ChatError: 'chat:error',
  AgentStatus: 'agent:status',
  SafetyRequest: 'safety:request',
  LogEntry: 'log:entry',
  IndexProgress: 'index:progress',
  TodoRunsChanged: 'todo:runs-changed'
} as const;

function subscribe<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: RoutineApi = {
  chatSend: (sessionId, text) => ipcRenderer.invoke(CH.ChatSend, { sessionId, text }),
  chatStop: () => ipcRenderer.invoke(CH.ChatStop),
  safetyRespond: (requestId, approved) =>
    ipcRenderer.invoke(CH.SafetyRespond, { requestId, approved }),
  sessionsList: () => ipcRenderer.invoke(CH.SessionsList),
  sessionsLoad: (id) => ipcRenderer.invoke(CH.SessionsLoad, { id }),
  sessionsNew: () => ipcRenderer.invoke(CH.SessionsNew),
  sessionsDelete: (id) => ipcRenderer.invoke(CH.SessionsDelete, { id }),
  settingsGet: () => ipcRenderer.invoke(CH.SettingsGet),
  settingsSet: (settings) => ipcRenderer.invoke(CH.SettingsSet, { settings }),
  fileSearch: (query, limit) => ipcRenderer.invoke(CH.FileSearch, { query, limit }),
  fileRead: (path, maxBytes) => ipcRenderer.invoke(CH.FileRead, { path, maxBytes }),
  fileIndexStart: () => ipcRenderer.invoke(CH.FileIndexStart),
  computerSnapshot: () => ipcRenderer.invoke(CH.ComputerSnapshot),
  computerExec: (op, args) => ipcRenderer.invoke(CH.ComputerExec, { op, args }),
  computerListOps: () => ipcRenderer.invoke(CH.ComputerListOps),
  searchWeb: (query, maxResults) => ipcRenderer.invoke(CH.SearchWeb, { query, maxResults }),
  browserRun: (instruction) => ipcRenderer.invoke(CH.BrowserRun, { instruction }),
  browserAvailable: () => ipcRenderer.invoke(CH.BrowserAvailable),
  llmHealth: () => ipcRenderer.invoke(CH.LlmHealth),
  openExternal: (url) => ipcRenderer.invoke(CH.OpenExternal, { url }),
  todoList: () => ipcRenderer.invoke(CH.TodoList),
  todoSave: (task) => ipcRenderer.invoke(CH.TodoSave, { task }),
  todoDelete: (id) => ipcRenderer.invoke(CH.TodoDelete, { id }),
  todoToggle: (id, enabled) => ipcRenderer.invoke(CH.TodoToggle, { id, enabled }),
  todoRun: (id) => ipcRenderer.invoke(CH.TodoRun, { id }),

  onChatDelta: (cb) => subscribe(CH.ChatDelta, cb),
  onChatError: (cb) => subscribe(CH.ChatError, cb),
  onAgentStatus: (cb) => subscribe(CH.AgentStatus, cb),
  onSafetyRequest: (cb) => subscribe(CH.SafetyRequest, cb),
  onLogEntry: (cb) => subscribe(CH.LogEntry, cb),
  onIndexProgress: (cb) => subscribe(CH.IndexProgress, cb),
  onTodoRunsChanged: (cb) => subscribe(CH.TodoRunsChanged, cb)
};

contextBridge.exposeInMainWorld('api', api);

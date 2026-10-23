import { create } from 'zustand';
import { AGENT_NAMES,
  type AgentName,
  type AgentStatus,
  type AgentTraceEvent,
  type ChatMessage,
  type ChatSession,
  type IndexProgress,
  type LogEntry,
  type SafetyRequest,
  type Settings,
  type TaskTodoItem,
  type TodoUpdateEvent,
  DEFAULT_SETTINGS
} from '../shared/types';
import { api } from './ipc';

const now = () => Date.now();

const EMPTY_TRACES: AgentTraceEvent[] = [];
const EMPTY_TODOS: TaskTodoItem[] = [];

/** 应用内确认请求，替代原生 window.confirm（原生对话框在 Windows 上会吞掉后续键盘焦点） */
export interface ConfirmRequest {
  message: string;
  danger?: boolean;
  onConfirm(): void;
}

function idleAgents(): Record<AgentName, AgentStatus> {
  const map = {} as Record<AgentName, AgentStatus>;
  for (const a of AGENT_NAMES) map[a] = { agent: a, state: 'idle', detail: '', updatedAt: now() };
  return map;
}

export interface StreamingMsg {
  id: string;
  content: string;
}

export { EMPTY_TRACES, EMPTY_TODOS };

interface AppState {
  settings: Settings;
  sessions: ChatSession[];
  currentSessionId: string;
  messages: ChatMessage[];
  streamingMsg: StreamingMsg | null;
  agents: Record<AgentName, AgentStatus>;
  logs: LogEntry[];
  tracesBySession: Record<string, AgentTraceEvent[]>;
  todosBySession: Record<string, TaskTodoItem[]>;
  pendingSafety: SafetyRequest | null;
  indexProgress: IndexProgress | null;
  chatError: string | null;
  settingsOpen: boolean;
  fileDialogOpen: boolean;
  todoDialogOpen: boolean;
  runningSessionId: string | null;
  notice: string | null;
  confirmRequest: ConfirmRequest | null;

  bootstrap(): Promise<void>;
  refreshSessions(): Promise<void>;
  selectSession(id: string): Promise<void>;
  createSession(): Promise<void>;
  removeSession(id: string): Promise<void>;
  sendText(text: string): Promise<void>;
  stopChat(): void;
  setAgentStatus(s: AgentStatus): void;
  pushLog(l: LogEntry): void;
  pushTrace(e: AgentTraceEvent): void;
  pushTodoUpdate(e: TodoUpdateEvent): void;
  receiveDelta(sessionId: string, msgId: string, delta: string, done: boolean): void;
  setChatError(e: string | null): void;
  setPendingSafety(r: SafetyRequest | null): void;
  setIndexProgress(p: IndexProgress): void;
  setSettingsOpen(open: boolean): void;
  setFileDialogOpen(open: boolean): void;
  setTodoDialogOpen(open: boolean): void;
  applySettings(s: Settings): void;
  setNotice(message: string | null): void;
  requestConfirm(request: ConfirmRequest): void;
  resolveConfirm(ok: boolean): void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  sessions: [],
  currentSessionId: '',
  messages: [],
  streamingMsg: null,
  agents: idleAgents(),
  logs: [],
  tracesBySession: {},
  todosBySession: {},
  pendingSafety: null,
  indexProgress: null,
  chatError: null,
  settingsOpen: false,
  fileDialogOpen: false,
  todoDialogOpen: false,
  runningSessionId: null,
  notice: null,
  confirmRequest: null,

  bootstrap: async () => {
    const settings = await api.settingsGet();
    set({ settings });
    let sessions = await api.sessionsList();
    if (sessions.length === 0) {
      await api.sessionsNew();
      sessions = await api.sessionsList();
    }
    const current = sessions[0];
    set({ sessions, currentSessionId: current.id, messages: current.messages });
  },

  refreshSessions: async () => {
    const sessions = await api.sessionsList();
    set({ sessions });
  },

  selectSession: async (id) => {
    const session = await api.sessionsLoad(id);
    set({ currentSessionId: id, messages: session.messages, chatError: null });
  },

  createSession: async () => {
    const session = await api.sessionsNew();
    set((s) => ({
      sessions: [session, ...s.sessions],
      currentSessionId: session.id,
      messages: []
    }));
  },

  removeSession: async (id) => {
    await api.sessionsDelete(id);
    const sessions = await api.sessionsList();
    if (sessions.length === 0) {
      await get().createSession();
      return;
    }
    if (get().currentSessionId === id) {
      const next = sessions[0];
      set({ sessions, currentSessionId: next.id, messages: next.messages });
    } else {
      set({ sessions });
    }
  },

  sendText: async (text) => {
    const { currentSessionId, messages, runningSessionId } = get();
    if (!text.trim()) return;
    if (runningSessionId !== null) {
      set({ chatError: '当前有任务正在执行，请等待完成或先停止' });
      return;
    }
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: now()
    };
    set({
      messages: [...messages, userMsg],
      runningSessionId: currentSessionId,
      chatError: null,
      streamingMsg: null,
      tracesBySession: { ...get().tracesBySession, [currentSessionId]: [] },
      todosBySession: { ...get().todosBySession, [currentSessionId]: [] }
    });
    try {
      await api.chatSend(currentSessionId, text);
    } catch {
      set({ runningSessionId: null });
    }
  },

  stopChat: () => {
    void api.chatStop();
  },

  setAgentStatus: (s) => set((state) => ({ agents: { ...state.agents, [s.agent]: s } })),

  pushLog: (l) => set((state) => ({ logs: [...state.logs.slice(-499), l] })),

  pushTrace: (e) => {
    set((state) => {
      const list = state.tracesBySession[e.sessionId] ?? EMPTY_TRACES;
      // 思考流式增量并入末条事件：每 token 一条会撑爆环形缓冲、丢早期过程
      if (e.phase === 'thought' && list.length > 0) {
        const last = list[list.length - 1];
        if (last.phase === 'thought') {
          const merged = list.slice(0, -1);
          merged.push({ ...last, thought: (last.thought ?? '') + (e.thought ?? '') });
          return {
            tracesBySession: { ...state.tracesBySession, [e.sessionId]: merged.slice(-499) }
          };
        }
      }
      return {
        tracesBySession: { ...state.tracesBySession, [e.sessionId]: [...list.slice(-499), e] }
      };
    });
  },

  pushTodoUpdate: (e) => {
    set((state) => ({
      todosBySession: { ...state.todosBySession, [e.sessionId]: e.todos }
    }));
  },

  receiveDelta: (sessionId, msgId, delta, done) => {
    const current = get().streamingMsg;
    const viewing = sessionId === get().currentSessionId;

    if (done) {
      const patch: Partial<AppState> = {};
      // 执行态复位只看运行中会话，与用户当前停留在哪个视图无关
      if (get().runningSessionId === sessionId) patch.runningSessionId = null;
      if (viewing && current && current.id === msgId) {
        const finalMsg: ChatMessage = {
          id: msgId,
          role: 'assistant',
          content: current.content,
          createdAt: now()
        };
        patch.messages = [...get().messages, finalMsg];
        patch.streamingMsg = null;
      }
      if (Object.keys(patch).length > 0) set(patch);
      void get().refreshSessions();
      return;
    }

    if (!viewing) return;
    if (!current) {
      set({ streamingMsg: { id: msgId, content: delta } });
    } else if (current.id === msgId) {
      set({ streamingMsg: { id: msgId, content: current.content + delta } });
    }
  },

  setChatError: (e) => set({ chatError: e, runningSessionId: null, streamingMsg: null }),
  setPendingSafety: (r) => set({ pendingSafety: r }),
  setIndexProgress: (p) => set({ indexProgress: p }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setFileDialogOpen: (open) => set({ fileDialogOpen: open }),
  setTodoDialogOpen: (open) => set({ todoDialogOpen: open }),
  applySettings: (s) => set({ settings: s }),
  setNotice: (message) => set({ notice: message }),
  requestConfirm: (request) => set({ confirmRequest: request }),
  resolveConfirm: (ok) => {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    if (ok && request) request.onConfirm();
  }
}));

import { create } from 'zustand';
import { AGENT_NAMES,
  type AgentName,
  type AgentStatus,
  type ChatMessage,
  type ChatSession,
  type IndexProgress,
  type LogEntry,
  type SafetyRequest,
  type Settings,
  DEFAULT_SETTINGS
} from '../shared/types';
import { api } from './ipc';

const now = () => Date.now();

function idleAgents(): Record<AgentName, AgentStatus> {
  const map = {} as Record<AgentName, AgentStatus>;
  for (const a of AGENT_NAMES) map[a] = { agent: a, state: 'idle', detail: '', updatedAt: now() };
  return map;
}

export interface StreamingMsg {
  id: string;
  content: string;
}

interface AppState {
  settings: Settings;
  sessions: ChatSession[];
  currentSessionId: string;
  messages: ChatMessage[];
  streamingMsg: StreamingMsg | null;
  agents: Record<AgentName, AgentStatus>;
  logs: LogEntry[];
  pendingSafety: SafetyRequest | null;
  indexProgress: IndexProgress | null;
  chatError: string | null;
  settingsOpen: boolean;
  fileDialogOpen: boolean;
  todoDialogOpen: boolean;
  sending: boolean;

  bootstrap(): Promise<void>;
  refreshSessions(): Promise<void>;
  selectSession(id: string): Promise<void>;
  createSession(): Promise<void>;
  removeSession(id: string): Promise<void>;
  sendText(text: string): Promise<void>;
  stopChat(): void;
  setAgentStatus(s: AgentStatus): void;
  pushLog(l: LogEntry): void;
  receiveDelta(sessionId: string, msgId: string, delta: string, done: boolean): void;
  setChatError(e: string | null): void;
  setPendingSafety(r: SafetyRequest | null): void;
  setIndexProgress(p: IndexProgress): void;
  setSettingsOpen(open: boolean): void;
  setFileDialogOpen(open: boolean): void;
  setTodoDialogOpen(open: boolean): void;
  applySettings(s: Settings): void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  sessions: [],
  currentSessionId: '',
  messages: [],
  streamingMsg: null,
  agents: idleAgents(),
  logs: [],
  pendingSafety: null,
  indexProgress: null,
  chatError: null,
  settingsOpen: false,
  fileDialogOpen: false,
  todoDialogOpen: false,
  sending: false,

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
    const { currentSessionId, messages } = get();
    if (!text.trim()) return;
    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: now()
    };
    set({
      messages: [...messages, userMsg],
      sending: true,
      chatError: null,
      streamingMsg: null
    });
    try {
      await api.chatSend(currentSessionId, text);
    } catch {
      set({ sending: false });
    }
  },

  stopChat: () => {
    void api.chatStop();
  },

  setAgentStatus: (s) => set((state) => ({ agents: { ...state.agents, [s.agent]: s } })),

  pushLog: (l) => set((state) => ({ logs: [...state.logs.slice(-499), l] })),

  receiveDelta: (sessionId, msgId, delta, done) => {
    const current = get().streamingMsg;

    if (sessionId !== get().currentSessionId) {
      if (done) void get().refreshSessions();
      return;
    }

    if (done) {
      if (current && current.id === msgId) {
        const finalMsg: ChatMessage = {
          id: msgId,
          role: 'assistant',
          content: current.content,
          createdAt: now()
        };
        set((s) => ({
          messages: [...s.messages, finalMsg],
          streamingMsg: null,
          sending: false
        }));
      } else {
        set({ sending: false });
      }
      void get().refreshSessions();
      return;
    }
    if (!current) {
      set({ streamingMsg: { id: msgId, content: delta } });
    } else if (current.id === msgId) {
      set({ streamingMsg: { id: msgId, content: current.content + delta } });
    }
  },

  setChatError: (e) => set({ chatError: e, sending: false, streamingMsg: null }),
  setPendingSafety: (r) => set({ pendingSafety: r }),
  setIndexProgress: (p) => set({ indexProgress: p }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setFileDialogOpen: (open) => set({ fileDialogOpen: open }),
  setTodoDialogOpen: (open) => set({ todoDialogOpen: open }),
  applySettings: (s) => set({ settings: s })
}));

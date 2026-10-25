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
import { setThemeMode } from './theme';

const now = () => Date.now();

const EMPTY_TURNS: TurnTrace[] = [];
const EMPTY_TODOS: TaskTodoItem[] = [];

/** 单轮执行过程：主进程一次任务只生成一个 msgId，思考与工具事件都挂在同一轮下 */
export interface TurnTrace {
  msgId: string;
  startedAt: number;
  /** null = 仍在执行；done / 失败 / 中止时结算 */
  endedAt: number | null;
  traces: AgentTraceEvent[];
}

/** 每轮事件上限沿用原环形缓冲策略，每会话只保留最近若干轮 */
const MAX_TRACES = 499;
const MAX_TURNS = 20;

/** 思考流式增量并入末条事件：每 token 一条会撑爆缓冲、丢早期过程 */
function appendTrace(traces: AgentTraceEvent[], e: AgentTraceEvent): AgentTraceEvent[] {
  if (e.phase === 'thought' && traces.length > 0) {
    const last = traces[traces.length - 1];
    if (last.phase === 'thought') {
      const merged = { ...last, thought: (last.thought ?? '') + (e.thought ?? '') };
      return [...traces.slice(0, -1), merged];
    }
  }
  return [...traces.slice(-(MAX_TRACES - 1)), e];
}

function settleTurns(turns: TurnTrace[], at: number): TurnTrace[] {
  if (!turns.some((t) => t.endedAt === null)) return turns;
  return turns.map((t) => (t.endedAt === null ? { ...t, endedAt: at } : t));
}

/** 结算某会话仍在执行的轮次（幂等） */
function settleSession(
  turnsBySession: Record<string, TurnTrace[]>,
  sessionId: string
): Record<string, TurnTrace[]> {
  const turns = turnsBySession[sessionId];
  if (!turns) return turnsBySession;
  return { ...turnsBySession, [sessionId]: settleTurns(turns, now()) };
}

function dropSessionTurns(
  turnsBySession: Record<string, TurnTrace[]>,
  sessionId: string
): Record<string, TurnTrace[]> {
  if (!turnsBySession[sessionId]) return turnsBySession;
  const next = { ...turnsBySession };
  delete next[sessionId];
  return next;
}

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

export { EMPTY_TURNS, EMPTY_TODOS };

interface AppState {
  settings: Settings;
  /** 云端档案可用性（key = profile.id）；undefined = 未测。失败时保留上次结果 */
  cloudHealth: Record<string, boolean>;
  sessions: ChatSession[];
  currentSessionId: string;
  messages: ChatMessage[];
  streamingMsg: StreamingMsg | null;
  agents: Record<AgentName, AgentStatus>;
  logs: LogEntry[];
  /** 按会话的轮次执行过程（内存态，重载会话不恢复） */
  turnsBySession: Record<string, TurnTrace[]>;
  todosBySession: Record<string, TaskTodoItem[]>;
  pendingSafety: SafetyRequest | null;
  indexProgress: IndexProgress | null;
  chatError: string | null;
  settingsOpen: boolean;
  fileDialogOpen: boolean;
  todoDialogOpen: boolean;
  dbWorkbenchOpen: boolean;
  /** 打开工作台时预设的数据源（缺省取列表首条） */
  dbWorkbenchDatasourceId: string | null;
  /** 待写入 Composer 的草稿（工作台「在对话中诊断」预填） */
  composerDraft: string;
  runningSessionId: string | null;
  /** 当前任务提交时间；用于首个步骤到达前的运行状态行秒表 */
  runningStartedAt: number | null;
  notice: string | null;
  confirmRequest: ConfirmRequest | null;

  bootstrap(): Promise<void>;
  refreshCloudHealth(): Promise<void>;
  switchCloud(id: string): Promise<void>;
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
  openDbWorkbench(datasourceId?: string): void;
  closeDbWorkbench(): void;
  prefillComposer(text: string): void;
  consumeComposerDraft(): void;
  applySettings(s: Settings): void;
  setNotice(message: string | null): void;
  requestConfirm(request: ConfirmRequest): void;
  resolveConfirm(ok: boolean): void;
}

export const useAppStore = create<AppState>()((set, get) => ({
  settings: DEFAULT_SETTINGS,
  cloudHealth: {},
  sessions: [],
  currentSessionId: '',
  messages: [],
  streamingMsg: null,
  agents: idleAgents(),
  logs: [],
  turnsBySession: {},
  todosBySession: {},
  pendingSafety: null,
  indexProgress: null,
  chatError: null,
  settingsOpen: false,
  fileDialogOpen: false,
  todoDialogOpen: false,
  dbWorkbenchOpen: false,
  dbWorkbenchDatasourceId: null,
  composerDraft: '',
  runningSessionId: null,
  runningStartedAt: null,
  notice: null,
  confirmRequest: null,

  bootstrap: async () => {
    const settings = await api.settingsGet();
    setThemeMode(settings.appearance?.theme ?? 'system');
    set({ settings });
    void get().refreshCloudHealth();
    let sessions = await api.sessionsList();
    if (sessions.length === 0) {
      await api.sessionsNew();
      sessions = await api.sessionsList();
    }
    const current = sessions[0];
    set({ sessions, currentSessionId: current.id, messages: current.messages });
  },

  refreshCloudHealth: async () => {
    try {
      set({ cloudHealth: await api.llmHealthClouds() });
    } catch {
      // 探测失败（如主进程忙）保留上次结果，状态徽标按未测/旧值展示
    }
  },

  switchCloud: async (id) => {
    const s = await api.settingsSet({ ...get().settings, activeCloudId: id });
    get().applySettings(s);
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
    // 会话删除后同步丢弃它的过程与进度，避免内存常驻
    set((s) => {
      const turnsBySession = dropSessionTurns(s.turnsBySession, id);
      const todosBySession = { ...s.todosBySession };
      delete todosBySession[id];
      return { turnsBySession, todosBySession };
    });
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
      runningStartedAt: now(),
      chatError: null,
      streamingMsg: null,
      turnsBySession: { ...get().turnsBySession, [currentSessionId]: [] },
      todosBySession: { ...get().todosBySession, [currentSessionId]: [] }
    });
    try {
      await api.chatSend(currentSessionId, text);
    } catch {
      set({ runningSessionId: null, runningStartedAt: null });
    }
  },

  stopChat: () => {
    void api.chatStop();
  },

  setAgentStatus: (s) => set((state) => ({ agents: { ...state.agents, [s.agent]: s } })),

  pushLog: (l) => set((state) => ({ logs: [...state.logs.slice(-499), l] })),

  pushTrace: (e) => {
    set((state) => {
      const turns = state.turnsBySession[e.sessionId] ?? EMPTY_TURNS;
      const index = turns.findIndex((t) => t.msgId === e.msgId);
      const next =
        index === -1
          ? [...turns, { msgId: e.msgId, startedAt: now(), endedAt: null, traces: [e] }].slice(
              -MAX_TURNS
            )
          : turns.map((t, i) =>
              i === index ? { ...t, traces: appendTrace(t.traces, e) } : t
            );
      return { turnsBySession: { ...state.turnsBySession, [e.sessionId]: next } };
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
      if (get().runningSessionId === sessionId) {
        patch.runningSessionId = null;
        patch.runningStartedAt = null;
        patch.turnsBySession = settleSession(get().turnsBySession, sessionId);
      }
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

  setChatError: (e) => {
    const { runningSessionId, turnsBySession } = get();
    // 失败路径主进程不会补发 done，这里必须结算轮次，否则轮头永远停在流光态
    set({
      chatError: e,
      runningSessionId: null,
      runningStartedAt: null,
      streamingMsg: null,
      ...(runningSessionId
        ? { turnsBySession: settleSession(turnsBySession, runningSessionId) }
        : {})
    });
  },
  setPendingSafety: (r) => set({ pendingSafety: r }),
  setIndexProgress: (p) => set({ indexProgress: p }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setFileDialogOpen: (open) => set({ fileDialogOpen: open }),
  setTodoDialogOpen: (open) => set({ todoDialogOpen: open }),
  // 工作台与设置同为弹窗：打开工作台时先收起设置，避免双层遮罩
  openDbWorkbench: (datasourceId) =>
    set({
      dbWorkbenchOpen: true,
      dbWorkbenchDatasourceId: datasourceId ?? null,
      settingsOpen: false
    }),
  closeDbWorkbench: () => set({ dbWorkbenchOpen: false }),
  prefillComposer: (text) => set({ composerDraft: text }),
  consumeComposerDraft: () => set({ composerDraft: '' }),
  applySettings: (s) => {
    setThemeMode(s.appearance?.theme ?? 'system');
    set({ settings: s });
  },
  setNotice: (message) => set({ notice: message }),
  requestConfirm: (request) => set({ confirmRequest: request }),
  resolveConfirm: (ok) => {
    const request = get().confirmRequest;
    set({ confirmRequest: null });
    if (ok && request) request.onConfirm();
  }
}));

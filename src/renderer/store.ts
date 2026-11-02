import { create } from 'zustand';
import { AGENT_NAMES,
  MAX_SESSION_REFS,
  type AgentName,
  type AgentStatus,
  type AgentTraceEvent,
  type ChatMessage,
  type ChatSession,
  type DatasourceConfig,
  type IndexProgress,
  type LogEntry,
  type ResourceRef,
  type SafetyRequest,
  type Settings,
  type SshHostConfig,
  DEFAULT_SETTINGS
} from '../shared/types';
import { api } from './ipc';
import { setThemeMode } from './theme';

const now = () => Date.now();

const EMPTY_TURNS: TurnTrace[] = [];

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

/** `@` 选择器用的资源清单缓存：只在首次打开菜单时拉取，避免每次击键发 IPC */
export interface ResourceCache {
  datasources: DatasourceConfig[];
  sshHosts: SshHostConfig[];
}

/**
 * 引用写入串行化：连续增删时保证 IPC 顺序与最终状态一致。
 * 落盘失败只记日志，不回滚界面——下一次修改会带着完整数组重写。
 */
let refsWriteChain: Promise<void> = Promise.resolve();

function persistSessionRefs(sessionId: string, refs: ResourceRef[]): void {
  refsWriteChain = refsWriteChain.then(async () => {
    try {
      const updated = await api.sessionsSetRefs(sessionId, refs);
      useAppStore.setState((state) => ({
        sessions: state.sessions.map((s) =>
          s.id === sessionId ? { ...s, refs: updated.refs ?? [] } : s
        )
      }));
    } catch (err) {
      console.error('[refs] 保存会话引用失败', err);
    }
  });
}

function patchSessionRefs(sessions: ChatSession[], sessionId: string, refs: ResourceRef[]): ChatSession[] {
  return sessions.map((s) => (s.id === sessionId ? { ...s, refs } : s));
}

export { EMPTY_TURNS };

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
  pendingSafety: SafetyRequest | null;
  indexProgress: IndexProgress | null;
  chatError: string | null;
  settingsOpen: boolean;
  fileDialogOpen: boolean;
  todoDialogOpen: boolean;
  convLogOpen: boolean;
  dbWorkbenchOpen: boolean;
  /** 打开工作台时预设的数据源（缺省取列表首条） */
  dbWorkbenchDatasourceId: string | null;
  /** 待写入 Composer 的草稿（工作台「在对话中诊断」预填） */
  composerDraft: string;
  /** `@` 资源清单缓存：null = 尚未成功加载 */
  resources: ResourceCache | null;
  resourcesLoading: boolean;
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
  receiveDelta(sessionId: string, msgId: string, delta: string, done: boolean): void;
  setChatError(e: string | null, sessionId?: string): void;
  setPendingSafety(r: SafetyRequest | null): void;
  setIndexProgress(p: IndexProgress): void;
  setSettingsOpen(open: boolean): void;
  setFileDialogOpen(open: boolean): void;
  setTodoDialogOpen(open: boolean): void;
  setConvLogOpen(open: boolean): void;
  openDbWorkbench(datasourceId?: string): void;
  closeDbWorkbench(): void;
  prefillComposer(text: string): void;
  consumeComposerDraft(): void;
  refreshResources(force?: boolean): Promise<void>;
  addSessionRef(ref: ResourceRef): void;
  removeSessionRef(ref: ResourceRef): void;
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
  pendingSafety: null,
  indexProgress: null,
  chatError: null,
  settingsOpen: false,
  fileDialogOpen: false,
  todoDialogOpen: false,
  convLogOpen: false,
  dbWorkbenchOpen: false,
  dbWorkbenchDatasourceId: null,
  composerDraft: '',
  resources: null,
  resourcesLoading: false,
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
      return { turnsBySession };
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
      // 保留历史轮次、只结算残留 live：过程块吸附在各自回答上，不因重发而清空
      turnsBySession: {
        ...get().turnsBySession,
        [currentSessionId]: settleTurns(
          get().turnsBySession[currentSessionId] ?? EMPTY_TURNS,
          now()
        )
      }
    });
    try {
      // 刚选完资源就回车：先等引用落盘，主进程才能读到本轮 scope
      await refsWriteChain;
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

  receiveDelta: (sessionId, msgId, delta, done) => {
    const current = get().streamingMsg;
    const viewing = sessionId === get().currentSessionId;

    if (done) {
      const patch: Partial<AppState> = {};
      // 执行态复位只看运行中会话，与用户当前停留在哪个视图无关
      if (get().runningSessionId === sessionId) {
        patch.runningSessionId = null;
        patch.runningStartedAt = null;
      }
      // 前台与后台/定时任务统一在 done 时结算轮次，否则后台轮次永远停在执行态
      patch.turnsBySession = settleSession(get().turnsBySession, sessionId);
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

  setChatError: (e, sessionId) => {
    // 仅关闭错误横幅：不动运行态，避免误杀进行中的任务守卫
    if (e === null) {
      set({ chatError: null });
      return;
    }
    const { runningSessionId, turnsBySession, currentSessionId } = get();
    const target = sessionId ?? runningSessionId ?? currentSessionId;
    // 后台/定时会话的错误不得打断当前正在执行任务的界面状态
    const foreground =
      sessionId == null || sessionId === runningSessionId || sessionId === currentSessionId;
    set({
      chatError: e,
      ...(foreground
        ? { runningSessionId: null, runningStartedAt: null, streamingMsg: null }
        : {}),
      ...(target ? { turnsBySession: settleSession(turnsBySession, target) } : {})
    });
  },
  setPendingSafety: (r) => set({ pendingSafety: r }),
  setIndexProgress: (p) => set({ indexProgress: p }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setFileDialogOpen: (open) => set({ fileDialogOpen: open }),
  setTodoDialogOpen: (open) => set({ todoDialogOpen: open }),
  setConvLogOpen: (open) => set({ convLogOpen: open }),
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

  refreshResources: async (force = false) => {
    // 进行中的请求不重复发；非强制且已有缓存则直接复用
    if (get().resourcesLoading) return;
    if (!force && get().resources !== null) return;
    set({ resourcesLoading: true });
    try {
      const [datasources, sshHosts] = await Promise.all([api.dbList(), api.sshList()]);
      set({ resources: { datasources, sshHosts }, resourcesLoading: false });
    } catch (err) {
      // 预览页没有 window.api：保留 null 让菜单显示空态，不能因取数失败白屏
      console.error('[refs] 读取资源清单失败', err);
      set({ resourcesLoading: false });
    }
  },

  addSessionRef: (ref) => {
    const { currentSessionId, sessions } = get();
    const session = sessions.find((s) => s.id === currentSessionId);
    if (!session) return;
    const current = session.refs ?? [];
    if (current.some((r) => r.kind === ref.kind && r.id === ref.id)) return;
    if (current.length >= MAX_SESSION_REFS) {
      set({ notice: `最多引用 ${MAX_SESSION_REFS} 个资源，请先移除一个` });
      return;
    }
    const next = [...current, ref];
    set({ sessions: patchSessionRefs(sessions, currentSessionId, next) });
    persistSessionRefs(currentSessionId, next);
  },

  removeSessionRef: (ref) => {
    const { currentSessionId, sessions } = get();
    const session = sessions.find((s) => s.id === currentSessionId);
    if (!session) return;
    const current = session.refs ?? [];
    const next = current.filter((r) => !(r.kind === ref.kind && r.id === ref.id));
    if (next.length === current.length) return;
    set({ sessions: patchSessionRefs(sessions, currentSessionId, next) });
    persistSessionRefs(currentSessionId, next);
  },
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

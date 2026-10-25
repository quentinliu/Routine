import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  nativeTheme,
  shell as electronShell
} from 'electron';
import { EventPayloadMap, IPC } from '../shared/ipc';
import {
  AGENT_NAMES,
  type ChatSession,
  type DatasourceConfig,
  type Settings,
  type SshExecOptions,
  type SshHostConfig,
  type TodoTask
} from '../shared/types';
import { OrchestratorEvent } from './agent/orchestrator';
import { getSafetyGate } from './agent/safety';
import { getRegistry, getOrchestrator, getSkillRegistry } from './composition';
import { ChatService } from './services/chatService';
import { getRouter } from './llm/router';
import { initMcpService } from './services/mcp/manager';
import type { McpServerConfig } from '../shared/types';
import { getBrowserAgentService } from './services/browser';
import { getComputerService, COMPUTER_OPS } from './services/computer';
import { getDbService } from './services/db/service';
import { getFileAgentService } from './services/fileAgent';
import { getFileIndexService } from './services/fileIndexer';
import { getInspectionStore } from './services/inspectionStore';
import { runInspection } from './services/inspectionRunner';
import { advance, getScheduler } from './services/scheduler';
import { getStorage, initStorage } from './services/storage';
import { initAudit } from './services/audit';
import { initMemory, getMemoryStore } from './services/memory';
import { notify } from './services/notifier';
import { isQuitting } from './tray';
import { getSshService } from './services/ssh/service';
import { getWebSearchService } from './services/webSearch';
import { expandHome } from './util/paths';
import { assertValidSettings } from './util/guards';

let mainWindow: BrowserWindow | null = null;

/** 主题切换后同步窗口底色，避免缩放/切换瞬间闪出另一套背景 */
function syncWindowBackground(): void {
  const color = nativeTheme.shouldUseDarkColors ? '#0d1117' : '#ffffff';
  for (const win of BrowserWindow.getAllWindows()) win.setBackgroundColor(color);
}

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
  if (win) {
    win.on('close', (e) => {
      const closeToTray = getStorage().loadSettings().tray?.closeToTray ?? true;
      if (!isQuitting() && closeToTray) {
        e.preventDefault();
        win.hide();
      }
    });
  }
}

export function sendToRenderer<C extends keyof EventPayloadMap>(
  channel: C,
  payload: EventPayloadMap[C]
): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function resetAgentStatuses(): void {
  const now = Date.now();
  for (const agent of AGENT_NAMES) {
    sendToRenderer(IPC.AgentStatus, { agent, state: 'idle', detail: '', updatedAt: now });
  }
}

function orchestratorEmit(ev: OrchestratorEvent, assistantSink: { text: string }): void {
  switch (ev.type) {
    case 'agent-status':
      sendToRenderer(IPC.AgentStatus, ev.status);
      break;
    case 'trace':
      sendToRenderer(IPC.AgentTrace, ev.event);
      break;
    case 'todo':
      sendToRenderer(IPC.TodoUpdate, { sessionId: ev.sessionId, todos: ev.todos });
      break;
    case 'log':
      sendToRenderer(IPC.LogEntry, ev.entry);
      break;
    case 'chat-delta':
      assistantSink.text += ev.delta;
      sendToRenderer(IPC.ChatDelta, {
        sessionId: ev.sessionId,
        msgId: ev.msgId,
        delta: ev.delta,
        done: ev.done ?? false
      });
      break;
    case 'safety':
      sendToRenderer(IPC.SafetyRequest, ev.request);
      break;
  }
}

let chatService: ChatService | null = null;

function getChatService(): ChatService {
  if (!chatService) {
    chatService = new ChatService(getOrchestrator(), orchestratorEmit, resetAgentStatuses);
  }
  return chatService;
}

export function registerIpc(): void {
  initStorage(app.getPath('userData'));
  initMemory(app.getPath('userData'));
  initAudit(app.getPath('userData'));
  const storage = getStorage();
  const initialSettings = storage.loadSettings();
  // M5：原生控件/对话框跟随设置主题；窗口底色在 index.ts 创建时按此取色
  nativeTheme.themeSource = initialSettings.appearance?.theme ?? 'system';
  nativeTheme.on('updated', syncWindowBackground);
  getRouter().configure(initialSettings);
  getSafetyGate().configure(initialSettings.riskOverrides);
  getBrowserAgentService().configureLLM(getRouter());

  ipcMain.handle(IPC.SettingsGet, () => {
    const s = storage.loadSettings();
    getRouter().configure(s);
    getSafetyGate().configure(s.riskOverrides);
    return s;
  });
  ipcMain.handle(IPC.SettingsSet, (_e, p: { settings: Settings }) => {
    assertValidSettings(p.settings);
    storage.saveSettings(p.settings);
    nativeTheme.themeSource = p.settings.appearance?.theme ?? 'system';
    syncWindowBackground();
    getRouter().configure(p.settings);
    getSafetyGate().configure(p.settings.riskOverrides);
    return storage.loadSettings();
  });

  ipcMain.handle(IPC.SessionsList, () => storage.listSessions());
  ipcMain.handle(IPC.SessionsLoad, (_e, p: { id: string }) => {
    const found = storage.listSessions().find((s) => s.id === p.id);
    if (!found) throw new Error(`会话不存在: ${p.id}`);
    return found;
  });
  ipcMain.handle(IPC.SessionsNew, (): ChatSession => {
    const now = Date.now();
    const session: ChatSession = {
      id: crypto.randomUUID(),
      title: '新会话',
      messages: [],
      createdAt: now,
      updatedAt: now
    };
    storage.saveSession(session);
    return session;
  });
  ipcMain.handle(IPC.SessionsDelete, (_e, p: { id: string }) => {
    storage.deleteSession(p.id);
  });

  ipcMain.handle(IPC.OpenExternal, (_e, p: { url: string }) => {
    if (/^https?:\/\//.test(p.url) || p.url.startsWith('file://')) {
      void electronShell.openExternal(p.url);
    }
  });

  ipcMain.handle(IPC.ChatSend, async (_e, p: { sessionId: string; text: string }) => {
    const text = (p.text ?? '').trim();
    if (!text) throw new Error('[INVALID] 消息不能为空');

    const result = await getChatService().runTurn({
      sessionId: p.sessionId,
      text,
      source: 'chat'
    });
    if (!result.ok) {
      sendToRenderer(IPC.ChatError, { sessionId: result.sessionId, error: result.summary });
      notify('对话执行失败', result.summary, { dedupeKey: `chat-error:${result.summary}` });
      throw new Error(`[TURN_FAILED] ${result.summary}`);
    }
  });

  ipcMain.handle(IPC.ChatStop, () => {
    getOrchestrator().abort();
  });

  ipcMain.handle(IPC.SafetyRespond, (_e, p: { requestId: string; approved: boolean }) => {
    getSafetyGate().resolveApproval(p.requestId, p.approved);
  });

  ipcMain.handle(IPC.LlmHealth, () => getRouter().checkHealth());

  ipcMain.handle(IPC.LlmHealthClouds, () => getRouter().healthClouds());

  ipcMain.handle(IPC.MemoryGet, () => getMemoryStore().load());
  ipcMain.handle(IPC.MemorySave, (_e, p: { content: string }) => {
    getMemoryStore().save(typeof p.content === 'string' ? p.content : '');
  });

  ipcMain.handle(IPC.FileSearch, (_e, p: { query: string; limit?: number }) =>
    getFileAgentService().searchFiles(p.query, p.limit)
  );
  ipcMain.handle(IPC.FileRead, (_e, p: { path: string; maxBytes?: number }) =>
    getFileAgentService().readFile(p.path, p.maxBytes)
  );
  ipcMain.handle(IPC.FileIndexStart, async () => {
    const settings = storage.loadSettings();
    const dirs = settings.indexDirs.map(expandHome);
    const count = await getFileIndexService().startIndex(dirs, settings.excludeGlobs, (prog) =>
      sendToRenderer(IPC.IndexProgress, prog)
    );
    return count;
  });

  ipcMain.handle(IPC.ComputerSnapshot, () => getComputerService().snapshot());
  ipcMain.handle(IPC.ComputerExec, (_e, p: { op: string; args: Record<string, unknown> }) => {
    if (!COMPUTER_OPS.some((o) => o.op === p.op)) {
      throw new Error(`未知操作: ${p.op}，请从白名单中选择`);
    }
    return getComputerService().execWhitelisted(p.op, p.args);
  });
  ipcMain.handle(IPC.ComputerListOps, () => getComputerService().listOps());

  ipcMain.handle(IPC.SearchWeb, (_e, p: { query: string; maxResults?: number }) =>
    getWebSearchService().search(p.query, p.maxResults)
  );

  ipcMain.handle(IPC.BrowserRun, (_e, p: { instruction: string }) =>
    getBrowserAgentService().run(p.instruction, (line) =>
      sendToRenderer(IPC.LogEntry, {
        id: crypto.randomUUID(),
        ts: Date.now(),
        agent: 'browser',
        level: 'info',
        text: line
      })
    )
  );
  ipcMain.handle(IPC.BrowserAvailable, () => getBrowserAgentService().isAvailable());

  ipcMain.handle(IPC.TodoList, () => storage.loadTodos());

  ipcMain.handle(IPC.TodoSave, (_e, p: { task: TodoTask }) => {
    const incoming = p.task;
    const title = (incoming.title ?? '').trim();
    const instruction = (incoming.instruction ?? '').trim();
    if (!title || !instruction) throw new Error('标题和执行指令不能为空');
    if (!['daily', 'weekly', 'monthly', 'anytime'].includes(incoming.recurrence?.type)) {
      throw new Error('无效的重复周期');
    }

    const { tasks, runs } = storage.loadTodos();
    const now = Date.now();
    const existing = tasks.find((t) => t.id === incoming.id);
    const task: TodoTask = {
      id: existing?.id ?? crypto.randomUUID(),
      title,
      instruction,
      recurrence: incoming.recurrence,
      enabled: incoming.enabled ?? true,
      nextRunAt: advance(incoming.recurrence, now),
      lastRunAt: existing?.lastRunAt,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    };
    const next = existing ? tasks.map((t) => (t.id === task.id ? task : t)) : [...tasks, task];
    storage.saveTodos(next, runs);
    return task;
  });

  ipcMain.handle(IPC.TodoDelete, (_e, p: { id: string }) => {
    const { tasks, runs } = storage.loadTodos();
    storage.saveTodos(
      tasks.filter((t) => t.id !== p.id),
      runs.filter((r) => r.taskId !== p.id)
    );
  });

  ipcMain.handle(IPC.TodoToggle, (_e, p: { id: string; enabled: boolean }) => {
    const { tasks, runs } = storage.loadTodos();
    const task = tasks.find((t) => t.id === p.id);
    if (!task) throw new Error('任务不存在');
    task.enabled = p.enabled;
    task.updatedAt = Date.now();
    if (task.enabled && task.nextRunAt <= Date.now()) {
      task.nextRunAt = advance(task.recurrence, Date.now());
    }
    storage.saveTodos(tasks, runs);
    return task;
  });

  ipcMain.handle(IPC.TodoRun, async (_e, p: { id: string }) => {
    await getScheduler().runTaskNow(p.id);
    sendToRenderer(IPC.TodoRunsChanged, undefined);
  });

  ipcMain.handle(IPC.SshList, () => getSshService().listHosts());
  ipcMain.handle(IPC.SshSave, (_e, p: { host: SshHostConfig }) => getSshService().saveHost(p.host));
  ipcMain.handle(IPC.SshDelete, (_e, p: { id: string }) => getSshService().deleteHost(p.id));
  ipcMain.handle(IPC.SshTest, (_e, p: { id: string }) => getSshService().testHost(p.id));
  ipcMain.handle(
    IPC.SshExec,
    (_e, p: { id: string; command: string; options?: SshExecOptions }) =>
      getSshService().exec(p.id, p.command, p.options)
  );

  ipcMain.handle(IPC.DbList, () => getDbService().list());
  ipcMain.handle(IPC.DbSave, (_e, p: { datasource: DatasourceConfig }) =>
    getDbService().save(p.datasource)
  );
  ipcMain.handle(IPC.DbDelete, (_e, p: { id: string }) => {
    getDbService().remove(p.id);
    getInspectionStore().deleteForDatasource(p.id);
  });
  ipcMain.handle(IPC.DbTest, (_e, p: { id: string }) => getDbService().test(p.id));
  ipcMain.handle(IPC.InspectionRun, (_e, p: { datasourceId: string }) =>
    runInspection(p.datasourceId, (line) =>
      sendToRenderer(IPC.InspectionProgress, {
        reportId: p.datasourceId,
        checkId: line,
        status: 'ok'
      })
    )
  );
  ipcMain.handle(
    IPC.InspectionReports,
    (_e, p: { datasourceId?: string; limit?: number; before?: number }) => {
      const limit = Math.min(200, Math.max(1, Math.floor(Number(p.limit) || 50)));
      const before = Number.isFinite(Number(p.before)) ? Number(p.before) : undefined;
      return getInspectionStore().listReports(p.datasourceId, limit, before);
    }
  );
  ipcMain.handle(IPC.InspectionTrends, (_e, p: { datasourceId: string; days: number }) => {
    const days = Math.min(365, Math.max(7, Math.floor(Number(p.days) || 90)));
    return getInspectionStore().dailySeries(p.datasourceId, days);
  });
  ipcMain.handle(IPC.InspectionCheckTrend, (_e, p: { datasourceId: string; days: number }) => {
    const days = Math.min(365, Math.max(7, Math.floor(Number(p.days) || 90)));
    return getInspectionStore().checkTrend(p.datasourceId, days);
  });
  ipcMain.handle(
    IPC.InspectionCheckSeries,
    (_e, p: { datasourceId: string; checkId: string; days: number }) => {
      const days = Math.min(365, Math.max(7, Math.floor(Number(p.days) || 90)));
      return getInspectionStore().checkSeries(p.datasourceId, String(p.checkId ?? ''), days);
    }
  );

  const skills = getSkillRegistry();
  ipcMain.handle(IPC.SkillList, () => skills.list());
  ipcMain.handle(IPC.SkillRead, (_e, p: { name: string }) => skills.read(p.name));
  ipcMain.handle(IPC.SkillPickDir, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择技能目录（内含 SKILL.md）',
      properties: ['openDirectory']
    });
    return result.canceled || result.filePaths.length === 0 ? null : result.filePaths[0];
  });
  ipcMain.handle(IPC.SkillInstall, (_e, p: { dir: string }) => skills.installFromDir(p.dir));
  ipcMain.handle(IPC.SkillRemove, (_e, p: { name: string }) => {
    skills.remove(p.name);
  });

  const mcp = initMcpService(getRegistry());
  mcp.setLogFn((text, level) =>
    sendToRenderer(IPC.LogEntry, {
      id: crypto.randomUUID(),
      ts: Date.now(),
      agent: 'mcp',
      level: level ?? 'info',
      text
    })
  );
  ipcMain.handle(IPC.McpList, () => mcp.list());
  ipcMain.handle(IPC.McpSave, (_e, p: { server: McpServerConfig }) => mcp.save(p.server));
  ipcMain.handle(IPC.McpDelete, (_e, p: { id: string }) => mcp.remove(p.id));
  ipcMain.handle(IPC.McpTest, (_e, p: { server: McpServerConfig }) => mcp.test(p.server));
  ipcMain.handle(IPC.McpConnect, (_e, p: { id: string }) => mcp.connect(p.id));
  ipcMain.handle(IPC.McpDisconnect, (_e, p: { id: string }) => mcp.disconnect(p.id));

  app.on('will-quit', () => {
    getScheduler().stop();
    void mcp.dispose();
    void getDbService().disposeAll();
    getInspectionStore().checkpoint();
  });

  void mcp.autoConnect();

  getScheduler().bindRunner({
    runner: async (task, emitLog) => {
      const result = await getChatService().runTurn({
        text: task.instruction,
        source: 'scheduled',
        emitLog
      });
      if (!result.ok) emitLog(`执行失败: ${result.summary}`);
      return {
        sessionId: result.sessionId,
        ok: result.ok,
        summary: result.ok ? result.summary : '执行失败，详见运行历史'
      };
    },
    emitLog: (l) => sendToRenderer(IPC.LogEntry, l),
    onRunsChanged: () => sendToRenderer(IPC.TodoRunsChanged, undefined)
  });
  getScheduler().start();
}

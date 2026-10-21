import { app, ipcMain, shell as electronShell, type BrowserWindow } from 'electron';
import { IPC } from '../shared/ipc';
import {
  AGENT_NAMES,
  type ChatMessage,
  type ChatSession,
  type Settings,
  type SshExecOptions,
  type SshHostConfig,
  type TodoTask
} from '../shared/types';
import { Orchestrator, type OrchestratorEvent } from './agent/orchestrator';
import { getSafetyGate } from './agent/safety';
import { ToolRegistry } from './agent/tools/registry';
import { createBrowserTools } from './agent/tools/builtin/browser';
import { createComputerTools } from './agent/tools/builtin/computer';
import { createFileTools } from './agent/tools/builtin/file';
import { createSshTools } from './agent/tools/builtin/ssh';
import { createTodoTools } from './agent/tools/builtin/todo';
import { createWebTools } from './agent/tools/builtin/web';
import { getRouter } from './llm/router';
import { initMcpService } from './services/mcp/manager';
import type { McpServerConfig } from '../shared/types';
import { getBrowserAgentService } from './services/browser';
import { getComputerService, COMPUTER_OPS } from './services/computer';
import { getFileAgentService } from './services/fileAgent';
import { getFileIndexService } from './services/fileIndexer';
import { advance, getScheduler } from './services/scheduler';
import { getStorage, initStorage } from './services/storage';
import { getSshService } from './services/ssh/service';
import { getWebSearchService } from './services/webSearch';
import { expandHome } from './util/paths';

let mainWindow: BrowserWindow | null = null;
let orchestrator: Orchestrator | null = null;
let toolRegistry: ToolRegistry | null = null;

export function setMainWindow(win: BrowserWindow | null): void {
  mainWindow = win;
}

export function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

function getRegistry(): ToolRegistry {
  if (!toolRegistry) {
    const registry = new ToolRegistry(getSafetyGate());
    registry.register(...createFileTools(getFileAgentService()));
    registry.register(...createComputerTools(getComputerService()));
    registry.register(...createWebTools(getWebSearchService()));
    registry.register(...createBrowserTools(getBrowserAgentService()));
    registry.register(...createSshTools(getSshService()));
    registry.register(...createTodoTools());
    toolRegistry = registry;
  }
  return toolRegistry;
}

function getOrchestrator(): Orchestrator {
  if (!orchestrator) {
    orchestrator = new Orchestrator({
      router: getRouter(),
      safety: getSafetyGate(),
      registry: getRegistry()
    });
  }
  return orchestrator;
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

export function registerIpc(): void {
  initStorage(app.getPath('userData'));
  const storage = getStorage();
  getRouter().configure(storage.loadSettings());
  getBrowserAgentService().configureLLM(getRouter());

  ipcMain.handle(IPC.SettingsGet, () => {
    const s = storage.loadSettings();
    getRouter().configure(s);
    return s;
  });
  ipcMain.handle(IPC.SettingsSet, (_e, p: { settings: Settings }) => {
    storage.saveSettings(p.settings);
    getRouter().configure(p.settings);
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
    if (!text) throw new Error('消息不能为空');

    let session = storage.listSessions().find((s) => s.id === p.sessionId);
    if (!session) {
      const now = Date.now();
      session = { id: p.sessionId, title: '新会话', messages: [], createdAt: now, updatedAt: now };
    }

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      createdAt: Date.now()
    };
    session.messages.push(userMsg);
    if (session.messages.filter((m) => m.role === 'user').length === 1) {
      session.title = text.slice(0, 20);
    }
    session.updatedAt = Date.now();
    storage.saveSession(session);

    resetAgentStatuses();

    const sink = { text: '' };
    try {
      await getOrchestrator().handleUserMessage(
        session.id,
        text,
        (ev) => orchestratorEmit(ev, sink),
        session.messages.slice(0, -1)
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      sendToRenderer(IPC.ChatError, { sessionId: session.id, error: msg });
      throw err;
    } finally {
      if (sink.text.trim()) {
        session.messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: sink.text,
          createdAt: Date.now()
        });
        session.updatedAt = Date.now();
        storage.saveSession(session);
      }
    }
  });

  ipcMain.handle(IPC.ChatStop, () => {
    orchestrator?.abort();
  });

  ipcMain.handle(IPC.SafetyRespond, (_e, p: { requestId: string; approved: boolean }) => {
    getSafetyGate().resolveApproval(p.requestId, p.approved);
  });

  ipcMain.handle(IPC.LlmHealth, () => getRouter().checkHealth());

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
    void mcp.dispose();
  });

  void mcp.autoConnect();

  getScheduler().bindRunner({
    runner: async (task, emitLog) => {
      const now = Date.now();
      const session: ChatSession = {
        id: crypto.randomUUID(),
        title: `[定时] ${task.title}`.slice(0, 24),
        messages: [],
        createdAt: now,
        updatedAt: now
      };
      storage.saveSession(session);
      emitLog(`创建执行会话: ${session.title}`);

      const sink = { text: '' };
      resetAgentStatuses();
      let ok = true;
      try {
        await getOrchestrator().handleUserMessage(session.id, task.instruction, (ev) =>
          orchestratorEmit(ev, sink)
        );
      } catch (err) {
        ok = false;
        emitLog(`执行失败: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (sink.text.trim()) {
        session.messages.push({
          id: crypto.randomUUID(),
          role: 'user',
          content: task.instruction,
          createdAt: now
        });
        session.messages.push({
          id: crypto.randomUUID(),
          role: 'assistant',
          content: sink.text,
          createdAt: Date.now()
        });
        session.updatedAt = Date.now();
        storage.saveSession(session);
      }
      return {
        sessionId: session.id,
        ok,
        summary: ok ? sink.text.slice(0, 200) : '执行失败，详见运行历史'
      };
    },
    emitLog: (l) => sendToRenderer(IPC.LogEntry, l),
    onRunsChanged: () => sendToRenderer(IPC.TodoRunsChanged, undefined)
  });
  getScheduler().start();
}

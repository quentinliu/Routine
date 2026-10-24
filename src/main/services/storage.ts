import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {
  DEFAULT_SETTINGS,
  type ChatSession,
  type CloudProfile,
  type CloudProviderConfig,
  type DatasourceConfig,
  type FileRecord,
  type InspectionReport,
  type McpServerConfig,
  type SearchProvider,
  type Settings,
  type SshHostConfig,
  type TodoRunRecord,
  type TodoTask
} from '../../shared/types';

const SEARCH_PROVIDERS: SearchProvider[] = ['auto', 'bing', 'tavily'];

const SETTINGS_FILE = 'settings.json';
const SESSIONS_FILE = 'sessions.json';
const INDEX_FILE = 'file-index.json';
const TODOS_FILE = 'todos.json';
const DATASOURCES_FILE = 'datasources.json';
const INSPECTIONS_FILE = 'inspections.json';
const SSH_HOSTS_FILE = 'ssh-hosts.json';
const MCP_SERVERS_FILE = 'mcp-servers.json';

const MAX_TODO_RUNS = 300;
const MAX_REPORTS_PER_DATASOURCE = 200;

interface TodosFileShape {
  tasks: TodoTask[];
  runs: TodoRunRecord[];
}

interface IndexFileShape {
  files: FileRecord[];
  savedAt: number;
}

export class StorageService {
  private readonly dir: string;
  private indexWriteTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingIndex: FileRecord[] | null = null;

  constructor(dir: string) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
  }

  get dataDir(): string {
    return this.dir;
  }

  private filePath(name: string): string {
    return path.join(this.dir, name);
  }

  private readJson<T>(name: string, fallback: T): T {
    try {
      const raw = fs.readFileSync(this.filePath(name), 'utf-8');
      return JSON.parse(raw) as T;
    } catch {
      return fallback;
    }
  }

  private writeJson(name: string, data: unknown): void {
    const target = this.filePath(name);
    const tmp = `${target}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data), 'utf-8');
    fs.renameSync(tmp, target);
  }

  loadSettings(): Settings {
    // cloud 为 M1 前的旧字段，仅在迁移时读取
    const saved = this.readJson<Partial<Settings> & { cloud?: CloudProviderConfig }>(
      SETTINGS_FILE,
      {}
    );
    const rawConcurrent = Number(saved.scheduler?.maxConcurrent);
    const rawMaxSteps = Number(saved.agent?.maxSteps);
    // 旧默认值 duckduckgo（受限网络不可用，引擎已移除）：读取时归一为 auto 并随下次保存落盘
    const savedProvider = saved.search?.provider as SearchProvider | 'duckduckgo' | undefined;
    const provider: SearchProvider =
      savedProvider && savedProvider !== 'duckduckgo' && SEARCH_PROVIDERS.includes(savedProvider)
        ? savedProvider
        : 'auto';
    // M1：旧单配置 cloud 读取时包装为 cloudProfiles 首条（label 取模型名），下次保存落盘
    const legacy = saved.cloud;
    const migrated: CloudProfile[] = legacy
      ? [
          {
            id: randomUUID(),
            label: legacy.model || '云端模型',
            baseURL: legacy.baseURL || DEFAULT_SETTINGS.cloudProfiles[0].baseURL,
            apiKey: legacy.apiKey || '',
            model: legacy.model || DEFAULT_SETTINGS.cloudProfiles[0].model
          }
        ]
      : [];
    const cloudProfiles =
      saved.cloudProfiles && saved.cloudProfiles.length > 0
        ? saved.cloudProfiles
        : migrated.length > 0
          ? migrated
          : [DEFAULT_SETTINGS.cloudProfiles[0]];
    const activeCloudId = cloudProfiles.some((p) => p.id === saved.activeCloudId)
      ? (saved.activeCloudId as string)
      : cloudProfiles[0].id;
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      cloudProfiles,
      activeCloudId,
      ollama: { ...DEFAULT_SETTINGS.ollama, ...(saved.ollama ?? {}) },
      search: {
        provider,
        tavilyApiKey: saved.search?.tavilyApiKey ?? DEFAULT_SETTINGS.search.tavilyApiKey
      },
      indexDirs: saved.indexDirs?.length ? saved.indexDirs : DEFAULT_SETTINGS.indexDirs,
      excludeGlobs: saved.excludeGlobs?.length ? saved.excludeGlobs : DEFAULT_SETTINGS.excludeGlobs,
      scheduler: {
        maxConcurrent: Number.isFinite(rawConcurrent)
          ? Math.min(8, Math.max(1, Math.floor(rawConcurrent)))
          : DEFAULT_SETTINGS.scheduler.maxConcurrent
      },
      siteCredentials: saved.siteCredentials ?? DEFAULT_SETTINGS.siteCredentials,
      agent: {
        maxSteps: Number.isFinite(rawMaxSteps)
          ? Math.min(30, Math.max(2, Math.floor(rawMaxSteps)))
          : DEFAULT_SETTINGS.agent.maxSteps
      }
    };
  }

  saveSettings(settings: Settings): void {
    this.writeJson(SETTINGS_FILE, settings);
  }

  listSessions(): ChatSession[] {
    const sessions = this.readJson<ChatSession[]>(SESSIONS_FILE, []);
    return [...sessions].sort((a, b) => b.updatedAt - a.updatedAt);
  }

  saveSession(session: ChatSession): void {
    const sessions = this.readJson<ChatSession[]>(SESSIONS_FILE, []);
    const idx = sessions.findIndex((s) => s.id === session.id);
    if (idx >= 0) {
      sessions[idx] = session;
    } else {
      sessions.push(session);
    }
    this.writeJson(SESSIONS_FILE, sessions);
  }

  deleteSession(id: string): void {
    const sessions = this.readJson<ChatSession[]>(SESSIONS_FILE, []).filter((s) => s.id !== id);
    this.writeJson(SESSIONS_FILE, sessions);
  }

  loadIndex(): FileRecord[] {
    return this.readJson<IndexFileShape>(INDEX_FILE, { files: [], savedAt: 0 }).files;
  }

  loadTodos(): TodosFileShape {
    const saved = this.readJson<Partial<TodosFileShape>>(TODOS_FILE, {});
    return {
      tasks: Array.isArray(saved.tasks) ? saved.tasks : [],
      runs: Array.isArray(saved.runs) ? saved.runs : []
    };
  }

  saveTodos(tasks: TodoTask[], runs: TodoRunRecord[]): void {
    const trimmed = runs
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, MAX_TODO_RUNS);
    this.writeJson(TODOS_FILE, { tasks, runs: trimmed });
  }

  loadDatasources(): DatasourceConfig[] {
    const saved = this.readJson<DatasourceConfig[]>(DATASOURCES_FILE, []);
    return Array.isArray(saved) ? saved : [];
  }

  saveDatasources(list: DatasourceConfig[]): void {
    this.writeJson(DATASOURCES_FILE, list);
  }

  loadInspections(): InspectionReport[] {
    const saved = this.readJson<InspectionReport[]>(INSPECTIONS_FILE, []);
    return Array.isArray(saved) ? saved : [];
  }

  appendInspectionReport(report: InspectionReport): void {
    const all = this.loadInspections();
    all.push(report);
    const byDatasource = new Map<string, InspectionReport[]>();
    for (const r of all) {
      const bucket = byDatasource.get(r.datasourceId) ?? [];
      bucket.push(r);
      byDatasource.set(r.datasourceId, bucket);
    }
    const trimmed: InspectionReport[] = [];
    for (const bucket of byDatasource.values()) {
      trimmed.push(
        ...bucket
          .sort((a, b) => b.startedAt - a.startedAt)
          .slice(0, MAX_REPORTS_PER_DATASOURCE)
      );
    }
    this.writeJson(INSPECTIONS_FILE, trimmed);
  }

  loadSshHosts(): SshHostConfig[] {
    const saved = this.readJson<SshHostConfig[]>(SSH_HOSTS_FILE, []);
    return Array.isArray(saved) ? saved : [];
  }

  saveSshHosts(list: SshHostConfig[]): void {
    this.writeJson(SSH_HOSTS_FILE, list);
  }

  loadMcpServers(): McpServerConfig[] {
    const saved = this.readJson<McpServerConfig[]>(MCP_SERVERS_FILE, []);
    return Array.isArray(saved) ? saved : [];
  }

  saveMcpServers(list: McpServerConfig[]): void {
    this.writeJson(MCP_SERVERS_FILE, list);
  }

  saveIndex(files: FileRecord[]): void {
    this.pendingIndex = files;
    if (this.indexWriteTimer) return;
    this.indexWriteTimer = setTimeout(() => {
      this.indexWriteTimer = null;
      if (this.pendingIndex) {
        this.writeJson(INDEX_FILE, { files: this.pendingIndex, savedAt: Date.now() });
        this.pendingIndex = null;
      }
    }, 3000);
    this.indexWriteTimer.unref?.();
  }

  flushIndex(): void {
    if (this.indexWriteTimer) {
      clearTimeout(this.indexWriteTimer);
      this.indexWriteTimer = null;
    }
    if (this.pendingIndex) {
      this.writeJson(INDEX_FILE, { files: this.pendingIndex, savedAt: Date.now() });
      this.pendingIndex = null;
    }
  }
}

let storage: StorageService | null = null;

export function initStorage(dir: string): StorageService {
  storage = new StorageService(dir);
  return storage;
}

export function getStorage(): StorageService {
  if (!storage) throw new Error('storage not initialized');
  return storage;
}

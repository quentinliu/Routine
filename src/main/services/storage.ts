import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_SETTINGS,
  type ChatSession,
  type DatasourceConfig,
  type FileRecord,
  type InspectionReport,
  type Settings,
  type TodoRunRecord,
  type TodoTask
} from '../../shared/types';

const SETTINGS_FILE = 'settings.json';
const SESSIONS_FILE = 'sessions.json';
const INDEX_FILE = 'file-index.json';
const TODOS_FILE = 'todos.json';
const DATASOURCES_FILE = 'datasources.json';
const INSPECTIONS_FILE = 'inspections.json';

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
    const saved = this.readJson<Partial<Settings>>(SETTINGS_FILE, {});
    const rawConcurrent = Number(saved.scheduler?.maxConcurrent);
    return {
      ...DEFAULT_SETTINGS,
      ...saved,
      cloud: { ...DEFAULT_SETTINGS.cloud, ...(saved.cloud ?? {}) },
      ollama: { ...DEFAULT_SETTINGS.ollama, ...(saved.ollama ?? {}) },
      search: { ...DEFAULT_SETTINGS.search, ...(saved.search ?? {}) },
      indexDirs: saved.indexDirs?.length ? saved.indexDirs : DEFAULT_SETTINGS.indexDirs,
      excludeGlobs: saved.excludeGlobs?.length ? saved.excludeGlobs : DEFAULT_SETTINGS.excludeGlobs,
      scheduler: {
        maxConcurrent: Number.isFinite(rawConcurrent)
          ? Math.min(8, Math.max(1, Math.floor(rawConcurrent)))
          : DEFAULT_SETTINGS.scheduler.maxConcurrent
      },
      siteCredentials: saved.siteCredentials ?? DEFAULT_SETTINGS.siteCredentials
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

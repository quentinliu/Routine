import fs from 'node:fs';
import path from 'node:path';
import type { FileRecord, FileSearchResult, IndexProgress } from '../../shared/types';
import { expandHome } from '../util/paths';
import { getStorage } from './storage';

export type IndexProgressCallback = (p: IndexProgress) => void;

export const TEXT_EXTS = [
  'txt', 'md', 'markdown', 'json', 'csv', 'log',
  'ts', 'tsx', 'js', 'jsx', 'py', 'go', 'java', 'c', 'cpp', 'h', 'rb', 'rs',
  'xml', 'yaml', 'yml', 'toml', 'ini', 'sh', 'bash', 'zsh',
  'html', 'htm', 'css', 'sql', 'conf', 'env', 'properties'
];

const MAX_FILE_SIZE = 100 * 1024 * 1024;
const MAX_RECORDS = 150000;
const MAX_DEPTH = 15;
const PROGRESS_INTERVAL_MS = 400;
const PERSIST_EVERY = 5000;

export function globToRegex(glob: string): RegExp {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i];
    if (ch === '*') {
      if (glob[i + 1] === '*') {
        re += '.*';
        i++;
        if (glob[i + 1] === '/') i++;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`, 'i');
}

interface WalkState {
  records: FileRecord[];
  scanned: number;
  lastEmit: number;
  lastPersist: number;
}

async function walk(
  dir: string,
  base: string,
  depth: number,
  excludes: RegExp[],
  progress: IndexProgressCallback,
  state: WalkState
): Promise<void> {
  if (depth > MAX_DEPTH || state.records.length >= MAX_RECORDS) return;

  let entries: fs.Dirent[];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (state.records.length >= MAX_RECORDS) return;

    const full = path.join(dir, entry.name);
    const rel = path.relative(base, full);

    if (entry.isDirectory()) {
      if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
      if (excludes.some((re) => re.test(rel))) continue;
      if (/\.app$/i.test(entry.name)) continue;
      await walk(full, base, depth + 1, excludes, progress, state);
    } else if (entry.isFile()) {
      state.scanned++;
      if (excludes.some((re) => re.test(rel))) continue;

      let stat: fs.Stats;
      try {
        stat = await fs.promises.stat(full);
      } catch {
        continue;
      }
      if (stat.size > MAX_FILE_SIZE) continue;

      const ext = path.extname(entry.name).slice(1).toLowerCase();
      state.records.push({
        path: full,
        name: entry.name,
        ext,
        dir,
        size: stat.size,
        mtime: Math.round(stat.mtimeMs),
        isText: TEXT_EXTS.includes(ext)
      });

      const now = Date.now();
      if (now - state.lastEmit > PROGRESS_INTERVAL_MS) {
        state.lastEmit = now;
        progress({
          phase: 'indexing',
          scanned: state.scanned,
          indexed: state.records.length,
          currentDir: dir
        });
      }
      if (state.records.length - state.lastPersist >= PERSIST_EVERY) {
        state.lastPersist = state.records.length;
        getStorage().saveIndex(state.records);
      }
    }
  }
}

export class FileIndexService {
  private recordsCache: FileRecord[] | null = null;
  private loaded = false;
  private inflight: Promise<number> | null = null;

  private ensureLoaded(): FileRecord[] {
    if (!this.loaded) {
      this.recordsCache = getStorage().loadIndex();
      this.loaded = true;
    }
    return this.recordsCache ?? [];
  }

  startIndex(
    dirs: string[],
    excludeGlobs: string[],
    onProgress: IndexProgressCallback
  ): Promise<number> {
    if (this.inflight) return this.inflight;

    this.inflight = (async () => {
      const excludes = excludeGlobs.map(globToRegex);
      const state: WalkState = {
        records: [],
        scanned: 0,
        lastEmit: 0,
        lastPersist: 0
      };

      const validDirs: Array<{ abs: string; base: string }> = [];
      for (const d of dirs) {
        const abs = expandHome(d);
        try {
          const stat = await fs.promises.stat(abs);
          if (stat.isDirectory()) validDirs.push({ abs, base: abs });
        } catch {
          onProgress({ phase: 'scanning', scanned: 0, indexed: 0, currentDir: abs });
        }
      }

      onProgress({
        phase: 'scanning',
        scanned: 0,
        indexed: 0,
        totalEstimate: validDirs.length,
        currentDir: validDirs.map((v) => v.abs).join(', ')
      });

      for (const v of validDirs) {
        if (state.records.length >= MAX_RECORDS) break;
        await walk(v.abs, v.base, 0, excludes, onProgress, state);
      }

      this.recordsCache = state.records;
      this.loaded = true;
      getStorage().saveIndex(state.records);
      getStorage().flushIndex();
      onProgress({ phase: 'done', scanned: state.scanned, indexed: state.records.length });
      return state.records.length;
    })().finally(() => {
      this.inflight = null;
    });

    return this.inflight;
  }

  async search(query: string, limit = 20): Promise<FileSearchResult[]> {
    const records = this.ensureLoaded();
    const tokens = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (tokens.length === 0 || records.length === 0) return [];

    const scored: FileSearchResult[] = [];
    for (const r of records) {
      const nameLower = r.name.toLowerCase();
      const dirLower = r.dir.toLowerCase();
      let score = 0;
      let allHit = true;

      for (const t of tokens) {
        let tokenScore = 0;
        if (nameLower === t) tokenScore += 10;
        else if (nameLower.startsWith(t)) tokenScore += 4;
        else if (nameLower.includes(t)) tokenScore += 5;
        if (dirLower.includes(t)) tokenScore += 2;
        if (r.ext === t) tokenScore += 3;
        if (tokenScore === 0) allHit = false;
        score += tokenScore;
      }
      if (score > 0) {
        scored.push({ record: r, score: allHit ? score + 5 : score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    const top = scored.slice(0, limit);

    for (const item of top.slice(0, 5)) {
      const r = item.record;
      if (!r.isText || r.size > 200 * 1024) continue;
      try {
        const content = await fs.promises.readFile(r.path, 'utf-8');
        const lower = content.toLowerCase();
        const pos = lower.indexOf(tokens[0]);
        if (pos >= 0) {
          const start = Math.max(0, pos - 120);
          const end = Math.min(content.length, pos + 120);
          const snippet =
            (start > 0 ? '…' : '') +
            content.slice(start, end).replace(/\s+/g, ' ') +
            (end < content.length ? '…' : '');
          item.snippet = snippet;
        }
      } catch {
        // 不可读文件跳过摘要
      }
    }

    return top;
  }

  records(): FileRecord[] {
    return this.ensureLoaded();
  }
}

let indexer: FileIndexService | null = null;

export function getFileIndexService(): FileIndexService {
  if (!indexer) indexer = new FileIndexService();
  return indexer;
}

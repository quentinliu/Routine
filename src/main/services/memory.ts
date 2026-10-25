import fs from 'node:fs';
import path from 'node:path';

const MEMORY_FILE = 'MEMORY.md';
const MAX_TOTAL = 8000;
const MAX_ENTRY = 500;

export const MEMORY_LIMITS = { MAX_TOTAL, MAX_ENTRY };

export class MemoryStore {
  private readonly file: string;

  constructor(dir: string) {
    this.file = path.join(dir, MEMORY_FILE);
  }

  load(): string {
    try {
      return fs.readFileSync(this.file, 'utf-8');
    } catch {
      return '';
    }
  }

  save(content: string): void {
    const text = content.trim();
    if (text.length > MAX_TOTAL) {
      throw new Error(`记忆内容超过上限 ${MAX_TOTAL} 字符`);
    }
    this.write(text);
  }

  append(entry: string): void {
    const text = entry.trim();
    if (!text) throw new Error('记忆内容不能为空');
    if (text.length > MAX_ENTRY) {
      throw new Error(`单条记忆超过上限 ${MAX_ENTRY} 字符，请精简后重试`);
    }
    const current = this.load();
    const next = current ? `${current}\n- ${text}` : `- ${text}`;
    if (next.length > MAX_TOTAL) {
      throw new Error(`记忆总量将超过上限 ${MAX_TOTAL} 字符，请先在设置中精简旧记忆`);
    }
    this.write(next);
  }

  clear(): void {
    this.write('');
  }

  private write(text: string): void {
    fs.writeFileSync(this.file, text, 'utf-8');
  }
}

let store: MemoryStore | null = null;

export function initMemory(dir: string): void {
  store = new MemoryStore(dir);
}

export function getMemoryStore(): MemoryStore {
  if (!store) throw new Error('Memory store 未初始化');
  return store;
}

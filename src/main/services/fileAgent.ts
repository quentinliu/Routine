import fs from 'node:fs';
import type { FileReadResult, FileSearchResult } from '../../shared/types';
import { expandHome } from '../util/paths';
import { getFileIndexService, TEXT_EXTS } from './fileIndexer';
import { getStorage } from './storage';

export interface FileAgentService {
  searchFiles(query: string, limit?: number): Promise<FileSearchResult[]>;
  readFile(path: string, maxBytes?: number): Promise<FileReadResult>;
}

export class FileAgentServiceImpl implements FileAgentService {
  async searchFiles(query: string, limit?: number): Promise<FileSearchResult[]> {
    const indexer = getFileIndexService();
    if (indexer.records().length === 0) {
      const settings = getStorage().loadSettings();
      void indexer
        .startIndex(settings.indexDirs, settings.excludeGlobs, () => {})
        .catch(() => {});
    }
    return indexer.search(query, limit);
  }

  async readFile(filePath: string, maxBytes = 65536): Promise<FileReadResult> {
    const abs = expandHome(filePath);
    const stat = await fs.promises.stat(abs);
    if (!stat.isFile()) throw new Error('路径不是文件');
    const ext = abs.split('.').pop()?.toLowerCase() ?? '';
    if (!TEXT_EXTS.includes(ext)) throw new Error('暂不支持读取该文件类型（仅支持文本类文件）');

    const fh = await fs.promises.open(abs, 'r');
    try {
      const length = Math.min(stat.size, maxBytes);
      const buf = Buffer.alloc(length);
      await fh.read(buf, 0, length, 0);
      return {
        content: buf.toString('utf-8'),
        truncated: stat.size > maxBytes
      };
    } finally {
      await fh.close();
    }
  }
}

let fileAgent: FileAgentService | null = null;

export function getFileAgentService(): FileAgentService {
  if (!fileAgent) fileAgent = new FileAgentServiceImpl();
  return fileAgent;
}

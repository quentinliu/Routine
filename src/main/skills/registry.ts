import fs from 'node:fs';
import path from 'node:path';
import type { SkillDetail, SkillInfo } from '../../shared/types';
import {
  loadSkillDir,
  resolveSkillFile,
  scanSkillRoot,
  toDetail,
  type LoadedSkill
} from './loader';

/**
 * 技能注册表：合并内置根（随应用分发，只读）与用户根（userData/skills，可写）。
 * 同名冲突时用户根覆盖内置根。启停状态由 Settings.skillOverrides 决定（缺省启用）。
 */
export class SkillRegistry {
  private cache: LoadedSkill[] | null = null;
  private errors: Array<{ dir: string; error: string; source: 'builtin' | 'user' }> = [];

  constructor(
    private readonly builtinRoot: string,
    private readonly userRoot: string,
    private readonly getOverrides: () => Record<string, boolean>
  ) {
    fs.mkdirSync(userRoot, { recursive: true });
  }

  private scan(): LoadedSkill[] {
    if (this.cache) return this.cache;
    this.errors = [];
    const byName = new Map<string, LoadedSkill>();
    for (const [root, source] of [
      [this.builtinRoot, 'builtin'],
      [this.userRoot, 'user']
    ] as const) {
      const { skills, errors } = scanSkillRoot(root, source);
      for (const skill of skills) byName.set(skill.info.name, skill);
      for (const e of errors) this.errors.push({ ...e, source });
    }
    this.cache = [...byName.values()];
    return this.cache;
  }

  invalidate(): void {
    this.cache = null;
  }

  list(): SkillInfo[] {
    const overrides = this.getOverrides();
    return this.scan()
      .map((s) => ({
        ...s.info,
        enabled: overrides[s.info.name] ?? true
      }))
      .sort((a, b) => a.source.localeCompare(b.source) || a.name.localeCompare(b.name));
  }

  scanErrors(): Array<{ dir: string; error: string; source: 'builtin' | 'user' }> {
    this.scan();
    return [...this.errors];
  }

  enabledNames(): string[] {
    return this.list()
      .filter((s) => s.enabled)
      .map((s) => s.name);
  }

  get(name: string): LoadedSkill | null {
    return this.scan().find((s) => s.info.name === name) ?? null;
  }

  /** 激活校验：不存在 / 已停用均抛错，供 skill.run 使用 */
  requireEnabled(name: string): LoadedSkill {
    const skill = this.get(name);
    if (!skill) throw new Error(`技能不存在: ${name}`);
    const enabled = this.getOverrides()[skill.info.name] ?? true;
    if (!enabled) {
      throw new Error(`技能「${skill.info.name}」已停用，请在设置中启用`);
    }
    return skill;
  }

  read(name: string): SkillDetail {
    const skill = this.get(name);
    if (!skill) throw new Error(`技能不存在: ${name}`);
    return toDetail(skill);
  }

  readFile(name: string, relPath: string, maxBytes: number): { path: string; content: string } {
    const skill = this.get(name);
    if (!skill) throw new Error(`技能不存在: ${name}`);
    const abs = resolveSkillFile(skill.dir, relPath);
    const stat = fs.statSync(abs);
    const truncated = stat.size > maxBytes;
    const fd = fs.openSync(abs, 'r');
    try {
      const buffer = Buffer.alloc(Math.min(stat.size, maxBytes));
      fs.readSync(fd, buffer, 0, buffer.length, 0);
      return {
        path: relPath,
        content: buffer.toString('utf8') + (truncated ? `\n…（已截断，原文件 ${stat.size} 字节）` : '')
      };
    } finally {
      fs.closeSync(fd);
    }
  }

  /** 用户技能导入：校验通过后整目录复制进用户根；同名冲突拒绝 */
  installFromDir(srcDir: string): SkillInfo {
    const staged = loadSkillDir(srcDir, 'user');
    const dest = path.join(this.userRoot, staged.info.name);
    if (fs.existsSync(dest)) {
      throw new Error(`技能「${staged.info.name}」已存在，如需覆盖请先删除`);
    }
    fs.cpSync(srcDir, dest, { recursive: true, verbatimSymlinks: false });
    this.invalidate();
    return this.read(staged.info.name);
  }

  /** 仅允许删除用户根内的技能 */
  remove(name: string): void {
    const skill = this.get(name);
    if (!skill) throw new Error(`技能不存在: ${name}`);
    if (skill.info.source !== 'user') {
      throw new Error(`「${name}」为内置技能，不可删除（可在设置中停用）`);
    }
    fs.rmSync(skill.dir, { recursive: true, force: true });
    this.invalidate();
  }
}

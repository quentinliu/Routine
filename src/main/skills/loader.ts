import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import type { SkillDetail, SkillInfo } from '../../shared/types';

export interface LoadedSkill {
  info: SkillInfo;
  dir: string;
  body: string;
  files: string[];
}

interface Frontmatter {
  name?: unknown;
  description?: unknown;
  metadata?: unknown;
}

const NAME_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const NAME_MAX = 64;
const DESCRIPTION_MAX = 1024;

/** 解析 SKILL.md：frontmatter（YAML）与正文分离。格式非法时抛错。 */
export function parseSkillMd(raw: string, expectedName: string): { frontmatter: Frontmatter; body: string } {
  const normalized = raw.replace(/^\uFEFF/, '');
  if (!normalized.startsWith('---')) {
    throw new Error('SKILL.md 必须以 YAML frontmatter（--- 开头）开始');
  }
  const end = normalized.indexOf('\n---', 3);
  if (end < 0) throw new Error('frontmatter 未闭合（缺少结束 ---）');
  const yamlText = normalized.slice(3, end).replace(/^\r?\n/, '');
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (err) {
    throw new Error(`frontmatter YAML 解析失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('frontmatter 必须是键值映射');
  }
  const fm = parsed as Frontmatter;
  const name = typeof fm.name === 'string' ? fm.name : '';
  if (!name) throw new Error('frontmatter 缺少 name');
  if (name.length > NAME_MAX || !NAME_PATTERN.test(name)) {
    throw new Error(`name「${name}」不符合规范（小写字母/数字/连字符，≤${NAME_MAX}，不得连续或首尾连字符）`);
  }
  if (name !== expectedName) {
    throw new Error(`name「${name}」必须与目录名「${expectedName}」一致`);
  }
  const description = typeof fm.description === 'string' ? fm.description.trim() : '';
  if (!description) throw new Error('frontmatter 缺少 description');
  if (description.length > DESCRIPTION_MAX) {
    throw new Error(`description 超长（${description.length} > ${DESCRIPTION_MAX}）`);
  }
  if (fm.metadata !== undefined && (typeof fm.metadata !== 'object' || fm.metadata === null || Array.isArray(fm.metadata))) {
    throw new Error('metadata 必须是键值映射');
  }
  return { frontmatter: fm, body: normalized.slice(end + 4).replace(/^\r?\n/, '') };
}

function metadataString(fm: Frontmatter, key: string): string {
  if (typeof fm.metadata !== 'object' || fm.metadata === null) return '';
  const v = (fm.metadata as Record<string, unknown>)[key];
  return typeof v === 'string' ? v : '';
}

/** 递归列出技能目录内相对路径（不含 SKILL.md 自身），symlink 不跟随 */
function listFiles(dir: string, rel = ''): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...listFiles(path.join(dir, entry.name), relPath));
    } else if (entry.isFile()) {
      out.push(relPath);
    }
  }
  return out;
}

/** 读取并校验单个技能目录。不合法的目录抛错（由扫描方决定跳过还是上报）。 */
export function loadSkillDir(dir: string, source: 'builtin' | 'user'): LoadedSkill {
  const expectedName = path.basename(dir);
  const raw = fs.readFileSync(path.join(dir, 'SKILL.md'), 'utf8');
  const { frontmatter, body } = parseSkillMd(raw, expectedName);
  const files = listFiles(dir).filter((f) => f !== 'SKILL.md');
  return {
    dir,
    body,
    files,
    info: {
      name: String(frontmatter.name),
      description: String(frontmatter.description),
      version: metadataString(frontmatter, 'version'),
      source,
      enabled: true,
      partial: fs.existsSync(path.join(dir, 'scripts')),
      engine: metadataString(frontmatter, 'engine') || undefined
    }
  };
}

/** 扫描一个技能根目录：每个子目录若含合法 SKILL.md 即一个技能；非法目录跳过并返回原因 */
export function scanSkillRoot(
  root: string,
  source: 'builtin' | 'user'
): { skills: LoadedSkill[]; errors: Array<{ dir: string; error: string }> } {
  const skills: LoadedSkill[] = [];
  const errors: Array<{ dir: string; error: string }> = [];
  if (!fs.existsSync(root)) return { skills, errors };
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return { skills, errors };
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    if (!fs.existsSync(path.join(dir, 'SKILL.md'))) continue;
    try {
      skills.push(loadSkillDir(dir, source));
    } catch (err) {
      errors.push({
        dir: entry.name,
        error: err instanceof Error ? err.message : String(err)
      });
    }
  }
  return { skills, errors };
}

/** 限制 skill.read 只能读技能目录内的普通文件，拒绝穿越 */
export function resolveSkillFile(skillDir: string, relPath: string): string {
  const normalized = path.posix.normalize(relPath.replaceAll('\\', '/'));
  if (!normalized || normalized.startsWith('/') || normalized.split('/').includes('..')) {
    throw new Error(`非法路径: ${relPath}`);
  }
  if (normalized === 'SKILL.md') throw new Error('正文请用 skill.run 获取');
  const abs = path.join(skillDir, normalized);
  if (!abs.startsWith(path.join(skillDir, ''))) throw new Error(`非法路径: ${relPath}`);
  const stat = fs.statSync(abs);
  if (!stat.isFile()) throw new Error(`不是普通文件: ${relPath}`);
  return abs;
}

export function toDetail(skill: LoadedSkill): SkillDetail {
  return { ...skill.info, body: skill.body, files: skill.files };
}

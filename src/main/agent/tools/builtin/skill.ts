import type { SkillRegistry } from '../../../skills/registry';
import { getDbService } from '../../../services/db/service';
import type { ToolDefinition } from '../types';

const SKILL_FILE_MAX_BYTES = 24_000;

/**
 * Routine 宿主适配头：开源 skills 假设宿主是命令行 Agent（Bash + psql/mysql CLI）。
 * 激活时将正文包装进 Routine 的工具语境，避免 LLM 尝试执行不可用的 shell 命令。
 */
function adaptationHeader(skillName: string, datasourceId: string, engine: string): string {
  return [
    `【Routine 环境适配 — 技能「${skillName}」】`,
    `目标数据源 ID: ${datasourceId}（引擎: ${engine}）。执行本技能时遵守：`,
    '1. 所有 SQL 一律通过 db.query 工具执行（参数: datasourceId + sql）；本环境没有 shell，不要尝试运行 psql/mysql 命令行或技能附带的脚本。',
    '2. 技能中提到「先确认版本/配置」的步骤，直接用 db.query 查询对应系统视图/变量。',
    '3. 涉及变更或终止会话的操作（KILL、pg_terminate_backend、DDL 等）禁止用 db.query，改用 db.exec 并在 reason 里说明理由；执行前先向用户复述将要做的事。',
    '4. 每个步骤完成后给出简要判读，全部步骤完成后汇总发现与建议。',
    '',
    '【技能正文】'
  ].join('\n');
}

export function createSkillTools(registry: SkillRegistry): ToolDefinition[] {
  return [
    {
      name: 'skill.run',
      description:
        '激活一个运维技能（skill），返回其完整操作手册。当用户请求匹配某个已安装技能的场景（如慢查询诊断、锁等待分析）时调用。之后严格按手册步骤配合 db.query/db.exec 执行。',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名称（见系统提示词中的技能目录）' },
          datasourceId: { type: 'string', description: '目标数据源 ID（db.list 可查）' }
        },
        required: ['skill', 'datasourceId']
      },
      agent: 'main',
      maxResultChars: 12_000,
      risk: 'safe',
      execute: async (args) => {
        const name = String(args.skill ?? '').trim();
        const datasourceId = String(args.datasourceId ?? '').trim();
        if (!name) throw new Error('缺少 skill 参数');
        if (!datasourceId) throw new Error('缺少 datasourceId 参数（先用 db.list 查询）');
        const skill = registry.requireEnabled(name);
        const ds = getDbService()
          .list()
          .find((d) => d.id === datasourceId);
        if (!ds) throw new Error(`数据源不存在: ${datasourceId}`);
        const header = adaptationHeader(skill.info.name, datasourceId, ds.type);
        const body = skill.body.length > 30_000 ? `${skill.body.slice(0, 30_000)}\n…（技能过长已截断）` : skill.body;
        const notes = skill.info.partial
          ? '\n【注意】该技能包含 scripts/ 可执行脚本，本环境无法运行；按正文与 references 中的等价 SQL 手动执行对应步骤。'
          : '';
        return {
          skill: skill.info.name,
          version: skill.info.version,
          datasource: { id: ds.id, name: ds.name, type: ds.type },
          content: `${header}\n\n${body}${notes}`,
          references: skill.files
        };
      }
    },
    {
      name: 'skill.read',
      description: '读取技能目录内的附加文档（references 等，按 skill.run 返回的 references 列表）。需要更深入判读规则时使用。',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名称' },
          path: { type: 'string', description: '技能内相对路径，如 references/indexing.md' }
        },
        required: ['skill', 'path']
      },
      agent: 'main',
      maxResultChars: 8000,
      risk: 'safe',
      execute: async (args) => {
        const name = String(args.skill ?? '').trim();
        const relPath = String(args.path ?? '').trim();
        if (!name || !relPath) throw new Error('缺少 skill 或 path 参数');
        registry.requireEnabled(name);
        return registry.readFile(name, relPath, SKILL_FILE_MAX_BYTES);
      }
    }
  ];
}

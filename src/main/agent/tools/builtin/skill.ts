import type { SkillRegistry } from '../../../skills/registry';
import { buildSkillSummary, readSkillSection } from '../../../skills/outline';
import { getDbService } from '../../../services/db/service';
import { SECTION_ORDERS } from '../../prompt/registry';
import type { ToolDefinition } from '../types';

const SKILL_FILE_MAX_BYTES = 24_000;

/**
 * Routine 宿主适配头：开源 skills 假设宿主是命令行 Agent（Bash + psql/mysql CLI）。
 * 激活时将正文包装进 Routine 的工具语境，避免 LLM 尝试执行不可用的 shell 命令。
 * 术语对照段必须与常见第三方手册（MCP 工具名 / CLI 语法 / 多实例语境）对齐，
 * 否则模型会把「本环境执行不了」误判为「任务不可行」（v0.5.1 实测案例）。
 */
function adaptationHeader(skillName: string, datasourceId: string, engine: string): string {
  return [
    `【Routine 环境适配 — 技能「${skillName}」】`,
    `目标数据源 ID: ${datasourceId}（引擎: ${engine}）。执行本技能时遵守：`,
    '1. 所有 SQL 一律通过 db.query 工具执行（参数: datasourceId + sql）；同类只读查询可用 actions 在同一轮并行提交，不要一条一条地耗轮次。本环境不提供本地 shell：不要运行 psql/mysql 命令行或技能附带的脚本；主机级指标（磁盘、内存、Swap、服务状态）用 ssh.exec 采集。',
    "2. 手册中的 db_query、db_get_status、db_get_variable 等工具名一律视为 db.query 的等价调用：状态变量用 SHOW GLOBAL STATUS LIKE '…'，配置项用 SHOW VARIABLES LIKE '…'。",
    '3. 不要使用 mysql/psql 客户端特有语法（如 \\G 结尾）；手册中形如 {long_query_time} 的占位符，先用 db.query 查出实际值再代入。',
    '4. 多实例/CMDB 类手册在本环境按单数据源执行（对应手册的单实例模式），不要因缺少实例清单而放弃。',
    '5. 技能中提到「先确认版本/配置」的步骤，直接用 db.query 查询对应系统视图/变量。',
    '6. 涉及变更或终止会话的操作（KILL、pg_terminate_backend、DDL 等）禁止用 db.query，改用 db.exec 并在 reason 里说明理由；执行前先向用户复述将要做的事。',
    '7. 查询库表清单/容量时必须排除系统库（mysql、information_schema、performance_schema、sys）；结果 0 行时先用 SHOW DATABASES 复核，再决定是否写「无业务库」，不得据此判定实例为空。',
    '8. 没有历史基线时只做本期快照判断：不得编造趋势、同比或「较上期增长」；趋势维度标注「未获取：无历史基线」。',
    '9. 每个步骤完成后给出简要判读，全部步骤完成后汇总发现与建议；个别步骤无法执行时如实标注原因并继续其余步骤，不要整体放弃。',
    '',
    '【技能正文】'
  ].join('\n');
}

export function createSkillTools(registry: SkillRegistry): ToolDefinition[] {
  return [
    {
      name: 'skill.run',
      description:
        '激活一个运维技能（skill），返回环境适配头 + 手册开篇概览与章节清单（不再一次性返回全文）。需要某章细节时用 skill.read 按序号获取。',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名称（见系统提示词中的技能目录）' },
          datasourceId: { type: 'string', description: '目标数据源 ID（db.list 可查）' }
        },
        required: ['skill', 'datasourceId']
      },
      agent: 'main',
      // 摘要 + 章节清单必须完整送达：超长手册靠章节清单按需加载，这里不再做正文级截断
      maxResultChars: 8000,
      risk: 'safe',
      promptSection: {
        name: 'tool:skill',
        order: SECTION_ORDERS.TOOL_GUIDES + 30,
        text:
          '技能使用：skill.run 只返回环境适配头 + 手册开篇概览 + 章节清单，正文按章节用 ' +
          'skill.read {skill, path:"SKILL.md", section:"序号或标题关键词"} 取；只取当前步骤需要的章节，不要预取全文'
      },
      execute: async (args) => {
        const name = String(args.skill ?? '').trim();
        const datasourceId = String(args.datasourceId ?? '').trim();
        if (!name) throw new Error('缺少 skill 参数');
        // 技能存在性先于数据源校验：技能名写错时优先纠正名称，而不是误导去查数据源
        let skill;
        try {
          skill = registry.requireEnabled(name);
        } catch (err) {
          const available = registry
            .list()
            .map((s) => s.name)
            .join('、');
          const msg = err instanceof Error ? err.message : String(err);
          throw new Error(available ? `${msg}（可用技能：${available}）` : msg);
        }
        if (!datasourceId) throw new Error('缺少 datasourceId 参数（先用 db.list 查询）');
        const ds = getDbService()
          .list()
          .find((d) => d.id === datasourceId);
        if (!ds) throw new Error(`数据源不存在: ${datasourceId}`);
        const header = adaptationHeader(skill.info.name, datasourceId, ds.type);
        const body = buildSkillSummary(skill.body, skill.info.name);
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
      description:
        '读取技能内容：path="SKILL.md" 配合 section（章节序号或标题关键词）取手册某一章；或按 references 列表读取附加文档。',
      inputSchema: {
        type: 'object',
        properties: {
          skill: { type: 'string', description: '技能名称' },
          path: { type: 'string', description: '技能内相对路径，如 SKILL.md、references/indexing.md' },
          section: {
            type: 'string',
            description: '章节序号（如 "3"）、标题关键词或 rest（仅对 SKILL.md 生效）'
          }
        },
        required: ['skill', 'path']
      },
      agent: 'main',
      maxResultChars: 8000,
      risk: 'safe',
      execute: async (args) => {
        const name = String(args.skill ?? '').trim();
        const relPath = String(args.path ?? '').trim();
        const section = String(args.section ?? '').trim();
        if (!name || !relPath) throw new Error('缺少 skill 或 path 参数');
        const skill = registry.requireEnabled(name);
        const normalized = relPath.replaceAll('\\', '/').replace(/^\.\//, '');

        if (normalized === 'SKILL.md') {
          // 未指定章节时只回章节清单，避免模型一次性把 12k 手册灌回上下文
          if (!section) {
            return { path: 'SKILL.md', content: buildSkillSummary(skill.body, skill.info.name) };
          }
          const hit = readSkillSection(skill.body, section);
          return { path: `SKILL.md#${hit.title}`, section: hit.title, content: hit.content };
        }

        return registry.readFile(name, relPath, SKILL_FILE_MAX_BYTES);
      }
    }
  ];
}

import type { DatasourceConfig } from '../../../../shared/types';
import type { ToolDefinition } from '../types';
import { getDbService } from '../../../services/db/service';
import { omitSecretFields } from '../../../util/redact';
import { SECTION_ORDERS } from '../../prompt/registry';

/** 送模型前整键移除凭据字段：返回空串会被模型读成「密码缺失」并误报 */
function listForModel(): Promise<Array<Partial<DatasourceConfig>>> {
  return Promise.resolve(
    getDbService()
      .list()
      .map((ds) => omitSecretFields(ds, ['password']))
  );
}

/** 运行时快照块：数据源清单（同 SSH 主机清单先例），绝不包含凭据字段 */
function formatDatasourcesBlock(list: DatasourceConfig[]): string {
  if (list.length === 0) return '数据库数据源清单：（当前尚未配置任何数据源）';
  const lines = list
    .map(
      (d) =>
        `  - ${d.name} [${d.type}] id=${d.id} ${d.host}:${d.port}${d.database ? `/${d.database}` : ''}${d.enabled ? '' : '（已禁用，db.query 不可用）'}`
    )
    .join('\n');
  return `数据库数据源清单（db.query / db.exec / skill.run 的 datasourceId 参数使用 id）：\n${lines}`;
}

export function createDbTools(): ToolDefinition[] {
  return [
    {
      name: 'db.list',
      description:
        '列出已配置的数据库数据源（ID、名称、类型、主机，不含凭据）。查询或写操作前先用它拿到 datasourceId。',
      inputSchema: { type: 'object', properties: {} },
      agent: 'db',
      risk: 'safe',
      promptSection: {
        name: 'tool:db',
        order: SECTION_ORDERS.TOOL_GUIDES + 20,
        text:
          '数据库任务：先用 db.list 拿数据源 ID；只读诊断用 db.query，写操作/管理语句用 db.exec 并说明原因；' +
          '实时指标缺失时用 db.query 自行采样（连接数、QPS、命中率、锁等待、复制延迟、容量），只报实际查到的值；' +
          '同类只读查询可在同一轮用 actions 并行提交，不要逐条消耗轮次；' +
          '查询库表清单/容量必须排除系统库（mysql / information_schema / performance_schema / sys），' +
          '0 行结果先用 SHOW DATABASES 复核再下结论；' +
          '诊断与调优类需求优先激活对应技能（skill.run），按手册执行'
      },
      render(result) {
        const rows = Array.isArray(result) ? (result as Array<Partial<DatasourceConfig>>) : [];
        if (rows.length === 0) return '（尚未配置任何数据库数据源）';
        return rows
          .map(
            (d) =>
              `- ${String(d.id)} · ${String(d.name)}（${String(d.type)}）${String(d.user)}@${String(d.host)}:${String(d.port)}${d.enabled === false ? '（已禁用）' : ''}`
          )
          .join('\n');
      },
      promptContext() {
        let list: DatasourceConfig[] = [];
        try {
          list = getDbService().list();
        } catch {
          list = [];
        }
        return formatDatasourcesBlock(list);
      },
      execute: () => listForModel()
    },
    {
      name: 'db.query',
      description:
        '对指定数据源执行只读 SQL（仅 SELECT/SHOW/EXPLAIN/DESC，单语句，主进程强制守卫）。运维诊断与指标采样都用它。',
      inputSchema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'db.list 返回的数据源 ID' },
          sql: { type: 'string', description: '只读 SQL，单条语句' }
        },
        required: ['datasourceId', 'sql']
      },
      agent: 'db',
      maxResultChars: 8000,
      risk: 'safe',
      execute: async (args) => {
        const datasourceId = String(args.datasourceId ?? '');
        const sql = String(args.sql ?? '');
        const rows = await getDbService().query(datasourceId, sql);
        // sql 必须随结果一起返回：0 行提示文案对每条查询都相同，缺了 SQL 就无法区分是哪条查询空
        return { ok: true, sql, rowCount: rows.length, rows, empty: rows.length === 0 };
      },
      /**
       * 空结果语义化：裸 `{"rowCount":0,"rows":[]}` 与「查询失败」在模型眼里没有区别，
       * v0.5.1 巡检把 `information_schema.TABLES` 的 0 行误判成「空实例」。
       * 同时回填 sql：多条查询都返回 0 行时，只有带着 SQL 才能各自复核。
       */
      render(result) {
        const payload = result as { sql?: string; rowCount?: number; rows?: unknown[] };
        const rowCount = typeof payload.rowCount === 'number' ? payload.rowCount : 0;
        const sql = typeof payload.sql === 'string' ? payload.sql : '';
        if (rowCount === 0) {
          return JSON.stringify({
            ok: true,
            sql,
            rowCount: 0,
            rows: [],
            note:
              '该 SQL 已成功执行但返回 0 行：可能是确实没有匹配数据，也可能是当前账号对该对象无可见性' +
              '（information_schema 只显示有权限的对象），或过滤条件过严。' +
              '下结论前请用 SHOW DATABASES / 调整条件复核，不要直接判定「实例为空」或「未采集到数据」。'
          });
        }
        return JSON.stringify({ sql, rowCount, rows: payload.rows ?? [] });
      }
    },
    {
      name: 'db.exec',
      description:
        '对指定数据源执行写操作或管理语句（KILL 会话、终止后端等）。高风险操作，执行前必须向用户说明并获得确认。',
      inputSchema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'db.list 返回的数据源 ID' },
          sql: { type: 'string', description: '单条管理/写 SQL' },
          reason: { type: 'string', description: '执行原因（展示给用户审批）' }
        },
        required: ['datasourceId', 'sql', 'reason']
      },
      agent: 'db',
      maxResultChars: 4000,
      risk: 'medium',
      // 安全底线：写库/管理 SQL 不允许被降为 safe
      riskFloor: 'medium',
      describe: (args) => ({
        actionSummary: `在数据源上执行管理 SQL：${String(args.sql ?? '').slice(0, 120)}`,
        plan: [
          `目标数据源: ${String(args.datasourceId ?? '')}`,
          `SQL: ${String(args.sql ?? '').slice(0, 300)}`,
          `原因: ${String(args.reason ?? '未说明')}`
        ]
      }),
      execute: async (args) => {
        const datasourceId = String(args.datasourceId ?? '');
        const sql = String(args.sql ?? '');
        const rows = await getDbService().exec(datasourceId, sql);
        return { sql, rowCount: rows.length, rows };
      },
      render(result) {
        const payload = result as { sql?: string; rowCount?: number; rows?: unknown[] };
        return JSON.stringify({
          sql: typeof payload.sql === 'string' ? payload.sql : '',
          rowCount: payload.rowCount ?? 0,
          rows: payload.rows ?? []
        });
      }
    }
  ];
}

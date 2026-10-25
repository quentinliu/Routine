import type { DatasourceConfig } from '../../../../shared/types';
import type { ToolDefinition } from '../types';
import { getDbService } from '../../../services/db/service';
import { runInspection } from '../../../services/inspectionRunner';

function maskList(): Promise<DatasourceConfig[]> {
  return Promise.resolve(getDbService().list());
}

export function createDbTools(): ToolDefinition[] {
  return [
    {
      name: 'db.list',
      description: '列出已配置的数据库数据源（ID、名称、类型、主机，不含密码）。查询或巡检前先用它拿到 datasourceId。',
      inputSchema: { type: 'object', properties: {} },
      agent: 'db',
      risk: 'safe',
      execute: () => maskList()
    },
    {
      name: 'db.query',
      description:
        '对指定数据源执行只读 SQL（仅 SELECT/SHOW/EXPLAIN/DESC，单语句，主进程强制守卫）。运维诊断、巡检、采样都用它。',
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
        return { rowCount: rows.length, rows };
      }
    },
    {
      name: 'inspection.run',
      description:
        '对指定数据源执行一次基础巡检（连通性 / 连接水位 / 版本支持）。只读、safe；报告会写入数据库工作台并参与趋势与告警统计。',
      inputSchema: {
        type: 'object',
        properties: {
          datasourceId: { type: 'string', description: 'db.list 返回的数据源 ID' }
        },
        required: ['datasourceId']
      },
      agent: 'db',
      maxResultChars: 2000,
      risk: 'safe',
      execute: async (args, ctx) => {
        const datasourceId = String(args.datasourceId ?? '');
        const report = await runInspection(datasourceId, (line) => ctx.log(line));
        return {
          datasource: report.datasourceName,
          ok: report.ok,
          serverVersion: report.serverVersion,
          checks: report.results.map((r) => ({
            check: r.title,
            status: r.status,
            value: r.value
          }))
        };
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
        return { rowCount: rows.length, rows };
      }
    }
  ];
}

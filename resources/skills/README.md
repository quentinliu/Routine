# 内置 Skills（数据，不属于代码）

本目录下的技能包遵循 Agent Skills 开放标准（https://agentskills.io）：
每个子目录含 `SKILL.md`（YAML frontmatter + Markdown 正文），可选 `references/`。

| 技能 | 来源 | 许可 |
|------|------|------|
| mysql-slow-query-diagnose | https://github.com/openocta/openocta （DB Ops Skills） | Apache-2.0 |
| mysql-replication-lag-resolver | 同上 | Apache-2.0 |
| mysql-batch-health-check | 同上 | Apache-2.0 |
| mysql-capacity-early-warning | 同上 | Apache-2.0 |
| mysql-deadlock-analyzer | 同上 | Apache-2.0 |
| mysql-schema-linter | 同上 | Apache-2.0 |
| postgres | https://github.com/planetscale/database-skills （skills/postgres） | MIT |

上游许可副本：PlanetScale 部分见 `LICENSE`，OpenOcta DB Ops Skills 部分见
`LICENSE-openocta-db-ops-skills`。除本 README 与外层许可副本外，技能目录内文件保持上游原样，
便于后续同步升级；Routine 侧的运行环境差异（无 shell、SQL 经 db.query 工具执行）由 `skill.run`
激活时注入的适配层说明处理，不修改技能内容。

升级方式：用上游仓库对应目录覆盖本目录下的同名技能目录。上游技能包的
`sql-duration-spike-detector`（通用 SQL 时长）与 `tidb-cluster-inspector`（TiDB 集群巡检）
暂未纳入内置，按需再评估。

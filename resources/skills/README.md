# 内置 Skills（数据，不属于代码）

本目录下的技能包遵循 Agent Skills 开放标准（https://agentskills.io）：
每个子目录含 `SKILL.md`（YAML frontmatter + Markdown 正文），可选 `references/`。

| 技能 | 来源 | 许可 |
|------|------|------|
| mysql | https://github.com/planetscale/database-skills （skills/mysql） | MIT |
| postgres | https://github.com/planetscale/database-skills （skills/postgres） | MIT |

上游许可副本见 `LICENSE`。除本 README 外文件保持上游原样，便于后续同步升级；
Routine 侧的运行环境差异（无 shell、SQL 经 db.query 工具执行）由 `skill.run`
激活时注入的适配层说明处理，不修改技能内容。

升级方式：用上游仓库对应目录覆盖本目录下的同名技能目录。

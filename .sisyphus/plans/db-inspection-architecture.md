# 数据库巡检功能 · 架构规划（P1–P4）

> 状态：已评审修订（评审：GLM-5.3，Momus 标准）
> 类型：仅架构规划，未实施
> 适用项目：Routine（Electron 桌面 AI 助手，macOS Intel x64）
>
> **⚡ 状态更新（2026-10-22，S1 落地后）**
> - **已实现**：连接层四件套（adapter/mysql/postgres/connection）、`datasources.json` 存储、§6 全部六个 IPC 通道接线、数据源管理 UI（设置页 DatasourceSection，形式为内嵌分区而非弹窗）、最小巡检（版本 + 连接水位，`service.ts#inspect`）
> - **超出本规划**：数据库 Agent 工具 `db.list/db.query/db.exec`（本规划 §9 原排在 P3 且仅 `db.inspect`）、主进程只读 SQL 守卫、Skills 技能系统
> - **已被取代**：§11.2 的"纯声明式 JSON 能力包 + 三源 CheckRegistry"路线 → S1 改用 **Agent Skills 开放标准**（SKILL.md + 独立 SkillRegistry + `skill.run` 激活手册模式），内置包来自 planetscale/database-skills；巡检深化由 skills 承担而非 builtin 检查项
> - **已过时引用**：§0/§3 的 `TOOL_AGENT` 已重构为 `ToolRegistry`（见 react-mcp 规划 A1）；§11.1 MCP 客户端层已由 A3（2026-10-21）提前落地（stdio + Streamable HTTP + SSE 回退），"ESM-only 冲突"风险项已证实不存在（SDK 双构建 CJS 兼容）；头部"macOS Intel x64"已过时（0.2.2 起跨 macOS arm64 + Windows）
> - **仍有效待办**：§5 完整检查项清单（当前仅 2 项，其余由内置 skills 承担，注册表化仍值得做）、§4 TodoTask.kind 定时巡检、safeStorage 凭据加密、CustomCheck 注册表与 §12 自进化、§10.1 docker 集成测试

## 0. 背景与既有约束

Routine 是 Electron 44 + TypeScript 5.9（严格模式）桌面应用，React 19 渲染层，主进程 CJS。已有能力：

- **Agent 编排器**（`src/main/agent/orchestrator.ts`）：主 Agent 通过统一 JSON 协议调度子工具（`file.search` / `computer.exec` / `search.web` / `browser.run` 等），工具→Agent 映射表 `TOOL_AGENT`
- **Todo 调度器**（`src/main/services/scheduler.ts`）：循环类型 daily/weekly/monthly/anytime，24h catch-up 补跑，队列 + `pump()` 并发执行器（`Settings.scheduler.maxConcurrent` 可配置 1–8），运行历史 `TodoRunRecord` 持久化
- **存储**（`src/main/services/storage.ts`）：userData 目录 JSON 文件（settings/sessions/todos/file-index），原子写（tmp+rename），`MAX_TODO_RUNS=300` 裁剪
- **安全门**（`src/main/agent/safety.ts`）：操作按 safe/medium/high 分级，medium/high 需 UI 确认
- **设置页**：Zustand store + IPC `settings:get/set`，深合并默认值 + 范围钳制模式

**硬性契约（CONTRACTS.md，FROZEN）**：
- 零原生模块依赖；主进程 CJS 只能 require 兼容包；渲染层 vite/ESM
- `src/shared/types.ts`、`src/shared/ipc.ts` 为冻结区，修改需批准
- 严格 TS，禁 `as any` / `@ts-ignore`
- 服务以 `getXxxService()` 单例导出供 IPC 装配

## 1. 目标与非目标

**目标**
- 支持 MySQL（5.7/8.x）与 PostgreSQL（12+）健康巡检：连通性、连接数、慢查询、复制延迟、锁、表膨胀等
- 定时自动巡检 + 手动一键巡检，结构化报告持久化，历史可查
- 遵守现有契约：纯 JS 驱动、CJS 兼容、JSON 存储

**非目标（P1–P2 不做，边界见 §9）**
- SQL 执行/变更类操作（严格只读诊断）
- 外部告警推送（webhook/邮件）——P4+；P3 的"告警"仅指应用内通知
- 其他数据库（Redis/Mongo 等）——适配器模式预留

## 2. 核心架构决策

| 决策点 | 选项 | 推荐 | 理由 |
|---|---|---|---|
| 调度集成 | A. 独立巡检调度器<br>B. 扩展 `TodoTask` 增加 `kind: 'agent' \| 'dbInspection'` + `datasourceId` | **B** | 完全复用循环类型/catch-up/并发执行器（`pump` 并发模型天然支持多实例并行巡检）、运行历史、手动"立即执行"；改动仅是 runner 内按 kind 分发 |
| 驱动选型 | mysql2 + pg | **mysql2 + pg** | 均为纯 JS、CJS 兼容、electron-builder 自动打包进 asar |
| 巡检逻辑 | A. LLM 自由生成诊断 SQL<br>B. 结构化检查项注册表（白名单 SQL + 阈值判定） | **B** | 精确、可趋势化、安全；LLM 仅用于报告摘要润色（Phase 3） |
| 凭据存储 | A. 明文 JSON（同 siteCredentials 现状）<br>B. Electron `safeStorage`（macOS Keychain） | 先 A，Phase 2 升级 B | 与现有模式一致、快速落地；密码永不发给 LLM |

## 3. 模块划分

```
src/
├── shared/
│   └── types.ts                    # DatasourceConfig / InspectionReport / CheckResult
├── main/
│   └── services/db/                # B 代理域（新增）
│       ├── connection.ts           # 连接工厂：池化、connect/statement 超时、用后销毁
│       ├── adapter.ts              # DbAdapter 统一接口
│       ├── mysql.ts                # MySQL 适配器（mysql2/promise）
│       ├── postgres.ts             # PG 适配器（pg）
│       ├── registry.ts             # 检查项注册表 + 默认阈值
│       ├── checks.mysql.ts         # MySQL 检查项实现
│       ├── checks.pg.ts            # PG 检查项实现
│       └── inspector.ts            # 编排：逐项执行、聚合报告、getInspectorService()
├── renderer/components/
│   ├── DbInspectionView.tsx        # 巡检视图（报告列表 + 详情）
│   └── DatasourceDialog.tsx        # 数据源编辑弹窗
└── shared/ipc.ts                   # 新增通道（见 §6）
```

适配器统一接口（关键抽象，隔离两库差异）：

```ts
interface DbAdapter {
  serverVersion(): Promise<string>;
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;   // 内置 statement timeout
  ping(): Promise<void>;
  destroy(): Promise<void>;                                   // 巡检结束强制释放
}
```

## 4. 数据模型

```ts
interface DatasourceConfig {
  id: string; name: string;
  type: 'mysql' | 'postgresql';
  host: string; port: number;
  user: string; password: string;   // 仅存本地，永不进入 LLM 上下文
  database?: string; ssl?: boolean;
  enabled: boolean;
  timeoutMs?: number;               // 默认 10s
  thresholds?: Record<string, number>;  // 覆盖默认阈值，可选
}

interface CheckResult {
  checkId: string;                  // 如 'mysql.replication.lag'
  title: string;
  status: 'ok' | 'warn' | 'error' | 'skipped';  // skipped = 版本不满足/扩展未装/无基线
  value?: string;                   // 人类可读当前值（如 "85 / 500"）
  metrics?: Record<string, number>; // 机器可读数值指标（P2 趋势图数据源）
  threshold?: string;
  detail: string[];
  suggestion?: string;
  durationMs: number;
}

interface InspectionReport {
  id: string; datasourceId: string; datasourceName: string;
  startedAt: number; finishedAt: number;
  ok: boolean;                      // 无 error 即 true
  serverVersion: string;
  results: CheckResult[];
}
```

存储：数据源持久化到独立 `datasources.json`（同 sessions.json 模式，避免膨胀 settings.json；Settings 仅存全局开关与默认阈值）；报告持久化到 `inspections.json`（**每数据源上限 200 条**裁剪，保障多实例高频巡检下趋势数据可用）。

### TodoTask 集成语义（评审补充，P2 依据）

- IPC 装配层（ipc.ts）在 `bindRunner` 注册**分发型 runner**：`task.kind === 'dbInspection'` 时转发给 `inspector.run()`，不再创建聊天会话、不调用 orchestrator；缺省 `kind` 走现有 agent 路径
- 巡检完成后的运行历史：`TodoRunRecord.sessionId` 填 `insp:<reportId>`（引用而非双写），`ok`/`summary` 由报告聚合（error 数与最差状态项摘要）——运行历史 UI 与报告详情通过该引用互通
- **防重入**：同一数据源的巡检任务复用调度器 `queuedIds` 语义，排队/执行中再次触发直接拒绝

## 5. 巡检项清单

**MySQL**：连通性与版本 → 连接数使用率（`max_connections`）→ `Threads_running` → 慢查询速率（`Slow_queries` 增量）→ 主从延迟（`SHOW SLAVE STATUS`/`SHOW REPLICA STATUS`，按版本）→ InnoDB 缓冲池命中率 → 锁等待（`performance_schema`）→ 表空间占用

**PostgreSQL**：连通性与版本 → 连接数使用率 → 长事务（`pg_stat_activity` > 1h）→ 锁阻塞（`pg_locks`）→ 复制延迟（`pg_stat_replication`）→ 表膨胀（dead tuples 比例）→ 缓存命中率 → 无效索引 → autovacuum 健康

每项声明 `minVersion`（如 `performance_schema` 检查要求 5.7+；版本号按 X.Y 数值比较，兼容 `8.0.x`/`15.2` 两种格式），不满足自动 `skipped`，不阻塞整体报告。

**有状态检查项**：慢查询速率等基于累计计数器（`Slow_queries`）的指标需两次采样差值——检查项分「无状态/有状态」两类；有状态检查首跑或找不到上次报告基线时输出 `skipped`（`detail` 注明"等待下次采样建立基线"），基线取该数据源最近一份报告的同 `checkId` 值。

**复杂判定走 builtin**：枚举/布尔型指标（如 `Slave_IO_Running = 'Yes'`）的判定逻辑只允许出现在 builtin TS 检查项中，JSON DSL 不承载（见 §11.2 表达力边界）。

检查项接口：

```ts
interface DbCheck {
  id: string;
  title: string;
  minVersion?: string;
  run(ctx: CheckContext): Promise<CheckResult>;
}
interface CheckContext {
  adapter: DbAdapter;
  thresholds: Record<string, number>;   // 已合并用户覆盖值
  emitProgress: (line: string) => void;
}
```

## 6. IPC 通道（追加，遵循现有命名风格）

| 通道 | 载荷 | 返回 |
|---|---|---|
| `db:list/save/delete` | `{datasource?}` | `DatasourceConfig[]` / `DatasourceConfig` |
| `db:test` | `{id}` | `{ok, version, latencyMs}` |
| `inspection:run` | `{datasourceId}` | `InspectionReport`（长时操作：进度经 `inspection:progress` 事件；同数据源防重入，执行中重复触发抛错） |
| `inspection:reports` | `{datasourceId?}` | `InspectionReport[]` |
| 事件 `inspection:progress` | `{reportId, checkId, status}` | — |

## 7. 执行流程

```
Scheduler.tick ──┐                     ┌→ checks[0] (timeout 保护) ─┐
(复用现有队列/   ├→ runner 按 kind 分发 ┤→ checks[1] ...            ├→ 聚合报告
 并发 pump 模型) ┘                     └→ checks[N] ───────────────┘
                                                              ↓
TodoTask(kind=dbInspection) ──→ inspector.run(ds) ──→ 存 inspections.json
                                                              ↓
                              手动触发(IPC) ──→ 事件推送渲染层 → 报告页展示
```

- 每个数据源一次巡检 = 一个队列任务；多实例巡检受益于 `maxConcurrent` 并发配置
- **并发槽竞争（已知取舍）**：巡检与 agent 定时任务共享同一 FIFO 队列与并发预算，长巡检可能占满槽位。缓解：巡检任务入队时若存在 agent 任务等待，巡检让位（agent 优先插队一档）；P3 若仍不满足需求，再拆分独立巡检队列
- 单项检查失败降级为 `error`/`skipped`，绝不中断整份报告
- 连接即用即毁：巡检结束 `destroy()`，无长连接泄漏

## 8. 安全设计

1. **只读保障双保险**：文档建议只读账号（`SELECT`/`PROCESS`/`REPLICATION CLIENT` 最小权限）+ 代码层检查项全部为白名单内只读 SQL，无拼接入口
2. **超时三重防护**：connect timeout / statement timeout / 整体巡检软上限
3. **凭据隔离**：密码仅存 userData JSON（现状模式），Phase 2 迁移 `safeStorage`（Keychain）；LLM 摘要只传聚合指标，不含连接信息
4. **风险分级**：巡检属只读诊断 → `safe` 级，无需安全门确认；Phase 3 若开放 Agent 自由诊断查询，白名单外 SQL 走安全门

## 9. 分期实施

| 阶段 | 内容 | 产出 |
|---|---|---|
| **P1** | 数据源管理（设置页）+ 手动巡检 + 报告页 + 检查项注册表（builtin） | 核心价值闭环 |
| **P2** | `TodoTask.kind` 扩展接入定时巡检 + 历史趋势图（读 `metrics` 数值时序）+ safeStorage 凭据加密（含迁移：读旧明文→加密写回→删除明文字段）+ CustomCheck 注册表（自进化地基） | 自动化 |
| **P3** | LLM 诊断摘要（聚合指标 → 中文建议）+ Agent 工具 `db.inspect` + **应用内**阈值告警通知 + LLM 起草→批准回路 | 智能化 |
| **P4** | MCP 客户端层（动态工具发现/注册）+ Skill 巡检能力包安装 + 阈值自调优 | 开放生态 |

**依赖新增**：`mysql2@^3`、`pg@^8`（P1，共约 3–4 MB，纯 JS，无原生编译）；`@modelcontextprotocol/sdk`（P4，纯 JS）。

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| 两库版本差异大 | `minVersion` + `skipped` 降级 |
| `pg_stat_statements` 等扩展未安装 | 检查项自探测扩展可用性，不可用即跳过 |
| 连接泄漏 | 巡检结束强制 `destroy()`，finally 保证 |
| 风险 | 缓解 |
|---|---|
| 两库版本差异大 | `minVersion` + `skipped` 降级 |
| `pg_stat_statements` 等扩展未安装 | 检查项自探测扩展可用性，不可用即跳过 |
| 连接泄漏 | 巡检结束强制 `destroy()`，finally 保证 |
| 大实例慢查询拖垮巡检 | 全部语句带超时 + LIMIT |
| 凭据明文落盘 | P2 迁移 safeStorage（含旧数据迁移路径）；文档标注只读账号建议 |
| 长巡检占满并发槽、饿死 agent 任务 | agent 任务入队优先一档（§7）；P3 评估拆分独立巡检队列 |
| **MCP SDK ESM-only 与主进程 CJS 契约冲突（P4 前置验证项）** | P4 启动前先做 spike 验证：CJS 下 `dynamic import()` 可行性 / 独立 utilityProcess 承载 MCP 客户端；不可行则 MCP 层降级为"仅输出能力"（自身暴露 Server 经独立 Node 子进程）或推迟 |
| LLM 起草的检查项包含危险 SQL | 自动硬校验（只读白名单 + 黑名单 + EXPLAIN 验证）+ 人工批准双门，缺一不可（§12） |

## 10.1 测试策略

- **适配器集成测试**：docker 启动 MySQL 8 / PostgreSQL 15 容器，覆盖连接/超时/版本探测/`destroy()` 释放（CI 可选，本地必测）
- **检查项单测**：固定 fixtures（模拟查询结果 + 版本号）断言 status/阈值判定，含 `skipped` 分支（版本不足、扩展缺失、无基线）
- **调度集成**：`kind=dbInspection` 任务的入队/分发/防重入/运行历史引用正确性
- **安全校验单测**：§12 黑名单/白名单用例表（含大小写、注释混淆、多语句绕过尝试）

## 11. 能力扩展层：Skills 与 MCP（是否引入的结论：引入，分层置后）

P1/P2 不依赖 Skills/MCP；作为 P3/P4 的扩展机制，保持核心自包含。

### 11.1 MCP 客户端层（P4）

- Routine 作为 **MCP Host/Client**，通过 `@modelcontextprotocol/sdk`（纯 JS、CJS 兼容）连接外部 MCP Server：本地 stdio 子进程 / 远程 Streamable HTTP
- 价值一（输入能力）：外部数据库 MCP Server（官方 mysql/postgres MCP 等）经 `tools/list` 动态发现，注册进 orchestrator 的 `TOOL_AGENT` 映射，成为额外诊断工具源
- 价值二（输出能力）：Routine 自身可暴露 MCP Server（`db.inspect` / `db.list-reports` / `db.list-datasources`），供 Claude Desktop 等外部 AI 调用巡检能力
- 隔离性：每个 Server 独立子进程/连接，故障域隔离；单个 Server 崩溃不影响主应用与巡检主流程
- 取舍说明：对巡检场景，builtin + CustomCheck 已覆盖绝大多数需求，MCP 的核心收益是**能力增长与应用发版解耦**，故置 P4 而非前置

### 11.2 Skills（巡检能力包，P4）

- 借鉴现有 SKILL.md 能力包模式：检查项打包为可安装的"巡检能力包"
- 包内容为**纯声明式 JSON**（SQL 模板 + 参数 + 阈值 DSL + 解读提示词），**不含可执行代码** → 可审计、可签名
- 检查项三源合并，`checkId` 冲突时优先级：`builtin（代码内置）> custom（用户批准）> skill pack（外部安装）`

```
builtin checks (TS 代码，随版本发布)
custom checks (JSON，用户批准 LLM 起草的检查项)
skill pack checks (JSON，外部安装的能力包)
        ↓ 合并去重
   统一 CheckRegistry（§5 接口不变，registry 增加多源加载）
```

可序列化的 CustomCheck schema（无代码执行）：

```ts
interface CustomCheck {
  checkId: string; title: string; minVersion?: string;
  sql: string;                      // 单条只读 SQL
  evaluate: {                       // 阈值判定 DSL（仅数值比较）
    metric: string;                 // 如 'rows[0].usage_pct'
    op: '>' | '<' | '>=' | '<=';
    warn: number; error: number;
  };
  interpretation?: string;          // 给 LLM 的解读提示
}
// 表达力边界：枚举/布尔判定（如 Slave_IO_Running='Yes'）不进 DSL，
// 此类检查项只能以 builtin TS 形式存在（见 §5「复杂判定走 builtin」）
```

## 12. 能力自进化机制（Self-Evolution）

核心回路：**发现缺口 → LLM 起草 → 自动硬性安全校验 → 人工批准软门 → 注册生效 → 数据反馈调优**

1. **缺口发现**：用户问"为什么数据库慢"而标准检查项全部 ok → Agent 识别为覆盖缺口，进入起草流程
2. **LLM 起草**：基于报告上下文生成 CustomCheck JSON（SQL + 阈值 + 解读提示）
3. **安全校验（自动，硬门，全部通过才放行）**：
   - 单语句、只读白名单（SELECT/SHOW/EXPLAIN），关键字黑名单（INSERT/UPDATE/DELETE/DDL/GRANT/SET 等）
   - EXPLAIN 验证可执行 + statement timeout 试运行
4. **人工批准（软门）**：UI 弹窗展示 SQL 全文与阈值，确认后写入 `custom-checks.json`
5. **生效与回归**：下次巡检自动包含新检查项；连续 N 次 `skipped`（如扩展不存在）自动建议清理
6. **阈值自调优（P4）**：历史指标统计分布（p95）+ LLM 建议生成阈值调整提案，同样走批准门
7. **经验沉淀**：巡检报告 + Agent 分析结论 → 高频问题模式 → 检查项/提示词更新提案

**安全红线**：
- LLM 永不直接获得数据库连接串；起草阶段仅见聚合指标与表结构元数据
- 全部生成物必须过"自动安全校验 + 人工批准"双门
- `custom-checks.json` 支持一键禁用/清空（立即回滚到 builtin 基线）

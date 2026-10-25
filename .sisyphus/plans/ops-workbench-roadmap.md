# Ops 工作台路线图 · 设计（M2 批次）

> 2026-10-24 · 编排者起草。动机：对标 WorkBuddy（腾讯）/ Hermes Agent（Nous Research）/ OpenClaw 后确立不对称竞争路线——不拼生态规模与企业云，把「本地优先 + 运维垂直」做成纵深，同时以 1/10 成本消解可补的体验差距。本文件承载 5 项设计及配套契约（M2），供分批实施。
>
> 状态：M2 已批准（2026-10-24，见 CONTRACTS.md 变更记录）。批次一（设计一/二）与批次二（设计三/四/五）均已落地：验证 = typecheck 零错误 + 77 单测全过（含 memory/inspection-store/audit 新增 8 条）+ vite build 通过。遗留：设计五的审计日志已主进程落盘（userData/audit.json，仅 medium/high），列表/导出 UI 待补契约通道后实施；设计四告警依赖系统通知权限，需真机走查。

## 0. 战略背景与原则

### 0.1 竞品定位摘要（2026-10 调研）

| 产品 | 本质 | 开放性 | 入口 |
|------|------|--------|------|
| OpenClaw | 自托管消息网关（29 渠道）+ iOS/Android 节点，基金会治理 | MIT 开源 | 聊天 App 优先 |
| Hermes Agent | 自我改进 Agent（记忆/技能闭环），6 种执行后端，~25.6 万 star | MIT 开源 | CLI/TUI 优先，Desktop 为表层 |
| WorkBuddy | 云端 AI 办公工作台，100+ 领域专家，云端 7×24 托管，RBAC/审计 | 闭源 | 桌面/IM/小程序，需登录 |
| **Routine** | **本地优先桌面 Agent，数据库/SSH 运维垂直** | Apache 2.0 | 纯桌面 GUI，零部署 |

Routine 真实优势：双击即用（对手均为网关/CLI/云账号形态）、DB/SSH 运维一等公民、国内开箱可用（国产模型预设 + 必应免 Key 直连）、透明安全门。诚实差距：生态规模、消息无处不在、持久记忆、任务连续性、企业能力。

### 0.2 原则

- 每个改进要么加深「本地优先 + 运维垂直」护城河，要么以 1/10 成本消解一个体验差距；不复制对手形态
- 存储哲学修订：**配置与状态用 JSON，高频 append 的观测数据用 SQLite**（node:sqlite，无原生依赖）

### 0.3 非目标（资源纪律）

| 不做 | 原因 |
|------|------|
| 插件市场/社区生态 | 单人打不赢社区规模；MCP + Agent Skills 标准已兜住扩展性 |
| 企业 RBAC/云托管 | 与本地优先定位根本冲突 |
| 双向消息网关 | OpenClaw/Hermes 主场，正面刚无胜算；只做单向 webhook 通知（见设计二依赖项） |

---

## 1. 设计一：首启向导 + 模型体检

**目标**：新用户 30 秒完成「选预设 → 贴 Key → 体检通过 → 第一次对话」。

**触发判定（零契约变更）**：`cloudProfiles` 全部 `apiKey` 为空且 `providerMode === 'cloud'` 时主界面覆盖向导弹层；任一档案有 Key 后不再弹。

**三步向导**（新组件 `OnboardingWizard.tsx`）：
1. 选模型：复用 `CLOUD_PRESETS`（大号卡片），或「本地 Ollama」卡片（选中即 `providerMode: 'local'`，跳过后续步骤）
2. 贴 Key：密码框 + 「获取 XX API Key ↗」（`api.openExternal`）+ 自动生成档案名
3. 体检：保存 → `llmHealthClouds()` + `llmHealth()`；✓ 进主界面，✗ 显示原因可重试或跳过

**边界**：跳过按钮始终可见；向导期间 Esc 不关闭（必须显式跳过）；体检超时沿用 3s 探针。

**文件**：`OnboardingWizard.tsx`（新）、`App.tsx`（挂载判定）、`styles.css`。规模 ~250 行，无契约变更。

---

## 2. 设计二：托盘常驻 + 通知管道

**目标**：关窗不退出，定时任务/长任务继续跑；完成与异常弹系统通知。

**契约前置（M2）**：
- `index.ts`（冻结文件）追加 ≤3 行：`import { createTray } from './tray'` + `createTray()` + `window-all-closed` 增加 closeToTray 分支（M1 先例）
- `Settings` 追加 `tray?: { closeToTray: boolean }` 与 `notifications?: { enabled: boolean }`（缺省 true，旧配置自动兼容）

**新模块 `src/main/tray.ts`**：Tray 图标（resources/ 复用）+ 菜单（显示主窗口 / 暂停定时任务 / 退出）。关窗 → 隐藏到托盘。

**新模块 `src/main/services/notifier.ts`**：主进程 `Electron Notification` 封装，统一入口 `notify(title, body, opts)`：排队去重、点击聚焦主窗口、受 `notifications.enabled` 控制。**设计四的告警地基**。

**挂钩点**：`scheduler.execute()` finally 块（scheduler.ts L229-245）成功/失败/摘要通知；`chat:error` 同步通知。

**边界**：`window-all-closed` 拦截必须判断 closeToTray 开关，关闭时保持现行为；mac 首次通知自动申请权限。

**文件**：`tray.ts`（新）、`notifier.ts`（新）、`index.ts`（3 行）、`scheduler.ts`（挂钩）、`shared/types.ts` + 设置页两开关。规模 ~300 行 + M2。

---

## 3. 设计三：轻量持久记忆

**目标**：Agent 跨会话记住用户偏好与项目上下文——纯文件实现，不引入向量库。

**存储**：`userData/MEMORY.md`（用户可直编，Markdown 分节：偏好 / 项目 / 约定）。

**写入——内置工具而非自动提炼**：新增 safe 级内置工具 `memory.write {content}`，主 Agent 任务中自行决定沉淀（比任务结束自动 LLM 提炼省一次调用且可控）；追加式写入，单条 ≤500 字符，全文 ≤8k（超限拒绝并提示精简）。走 ToolRegistry 注册，safe 不弹门。

**读取——提示词注入**：`planningSystem()` / `fcSystem()` 增加 `{MEMORY}` 占位符（复刻 `SKILLS_PLACEHOLDER` 先例，orchestrator.ts L206/L211），注入截断至 4k 并标注「以下是长期记忆，供参考」。

**UI**：设置页「记忆」区——MEMORY.md 编辑 + 清空；`memory.write` 调用照常进 trace 时间线（用户可见 Agent 记了什么）。

**契约（M2）**：新增 `memory:get` / `memory:save` 通道。

**边界**：注入截断保证提示词预算；清空立即生效；MVP 只追加 + 整页编辑，无删除语义。

**文件**：`memory.ts` 服务（新）、`memory.write` 工具、orchestrator 占位符 ×2、preload/ipc 通道、设置 UI。规模 ~350 行。

---

## 4. 设计四：定时巡检告警 + 趋势（含 node:sqlite 留存迁移）

**目标**：数据库异常自动发现、主动通知；巡检历史可视化为趋势；**原始明细全量保留**，为后续数据功能留地基。

### 4.1 留存方案取舍

| 方案 | 思路 | 结论 |
|------|------|------|
| **A. node:sqlite 全量留存（采纳）** | 巡检报告迁 `userData/inspections.db`，时间窗口留存（默认 365 天 + 单数据源 5 万行双上限） | ✅ 原始明细全保留；趋势/基线/下钻均为一条 SQL；后续审计、todo runs 可同库加表 |
| B. 双层降采样（raw 200 条 + JSON 日聚合） | 裁剪点折叠为按日桶 | ✗ 用户要求保留足够原始数据支撑后续功能，降采样天然牺牲明细；已否决（2026-10-24） |
| C. 调大 JSON 上限 | 200 → 2000 | ✗ `writeJson` 全量重写成本线性涨，形状不对 |
| D. 按月轮转多文件 | 查询合并 N 个文件 | ✗ 复杂度高于 A、收益相同 |

**可行性已验证（2026-10-24）**：本项目 Electron 44 运行时 Node 24.22.0，`node:sqlite` 可用（`DatabaseSync`，CJS require 正常，SQLite 3.53.4，含 json1/窗口函数）。

### 4.2 Schema（`userData/inspections.db`）

```sql
CREATE TABLE IF NOT EXISTS inspection_reports (
  id              TEXT PRIMARY KEY,
  datasource_id   TEXT NOT NULL,
  datasource_name TEXT NOT NULL,
  started_at      INTEGER NOT NULL,   -- epoch ms，与现 JSON 字段一致
  finished_at     INTEGER NOT NULL,
  ok              INTEGER NOT NULL,   -- 0/1
  server_version  TEXT,
  results_json    TEXT NOT NULL       -- CheckResult[] 原样 JSON，结构零损失
);
CREATE INDEX IF NOT EXISTS idx_reports_ds_time
  ON inspection_reports(datasource_id, started_at DESC);
-- M2 只建巡检表；审计日志（设计五）、todo runs 历史后续同库加表
```

### 4.3 模块落点

**新增 `src/main/services/inspectionStore.ts`**（owner 模式，`init(dir)` 对齐 storage 测试初始化惯例）：

| API | 语义 |
|-----|------|
| `appendReport(report)` | 单事务：INSERT + 惰性 prune |
| `listReports(datasourceId?, limit?)` | 现有 `inspection:reports` 语义，返回 shape 不变 |
| `dailySeries(datasourceId, days)` | `GROUP BY date(started_at/1000,'unixepoch','localtime')`：每日次数/失败数/平均耗时 |
| `checkTrend(datasourceId, checkId, days)` | `json_each(results_json)` 按检查项取通过率/耗时序列 |
| `baseline(datasourceId, days=7)` | 近 7 天每 checkId 失败均值（告警基线） |
| `prune()` | `DELETE WHERE started_at < now-窗口`，随 append 同事务 |

`storage.ts` 的 `appendInspectionReport` / `loadInspections` 改为薄委托（签名不变，调用方零改动）。

**迁移（一次性、幂等）**：db 不存在且 `inspections.json` 存在 → 事务内逐条导入 → 原 JSON 改名 `inspections.json.migrated` 留备份；db 已存在则跳过。WAL 模式，app `will-quit` 统一 `wal_checkpoint(TRUNCATE)`（钩子已存在）——备份单位 = db 单文件。

### 4.4 告警管道

巡检完成（含 scheduler 触发场景）→ `baseline()` 对比 → 规则判定：
- 连接失败 / 巡检报错 → 立即通知
- 同一 checkId 当日 fail > 近 7 天均值 ×2 且绝对值 ≥1 → 通知（基线对比抗抖动，优于相邻两次对比）
- 去重：同一问题 6 小时窗口不重复通知（内存 Map）

**触发方式**：不新增任务类型——现有自然语言定时任务（「每天 9 点巡检生产库」）经 scheduler → orchestrator → db 工具执行，巡检服务在结果产出时挂告警钩子。

### 4.5 趋势 UI

设置 → 数据库区新增「历史趋势」：`dailySeries` 近 30/90/365 天视图（纯 CSS/SVG 迷你图，不引图表库）；`checkTrend` 按检查项下钻。

**边界**：告警只在 `notifications.enabled` 时弹但始终落日志；数据源删除连带删库内该 id 数据（`db:delete` 钩子）。

**文件**：`inspectionStore.ts`（新）、storage 薄委托、db 服务告警钩子、`DatasourceSection.tsx` 趋势区、notifier 调用。规模 ~350 行 + M2。

---

## 5. 设计五：审计日志 + 风险策略

**目标**：安全门从「弹窗机制」升级为「可审计的信任层」。

**审计日志**：
- 存储：`userData/audit.json`，环形上限 500 条（沿用 todo runs 300 裁剪先例）；若后续量大可平移进 inspections.db 同库加表（预留位）
- 记录范围：仅 medium/high 操作：时间 / Agent / 工具 / 参数摘要 / 风险级 / 结果（批准·执行 | 拒绝 | 超时未批）
- 挂钩点：`SafetyGate` 唯一咽喉——`createRequest` 记发起，`resolveApproval` 与超时记结果，各加一行 `audit.record()`

**风险策略自定义**：
- `Settings` 追加 `riskOverrides?: Record<string, 'safe' | 'medium' | 'high'>`（M2）；`classify()` 开头查覆盖表，未命中走现逻辑
- 合法性：仅已知工具名可覆盖；`db.exec`、未知工具保持 high 下限不可下调（classify 保留硬底线校验）
- UI：设置页「安全」区——工具风险级下拉 + 审计表（按风险级/结果筛选）+ 「导出 Markdown 报告」（对外可交付的执行凭证；参数摘要沿用脱敏惯例，不含 Key）

**边界**：覆盖表只影响分级，不绕过弹窗流程（medium/high 永远走门）。

**文件**：`safety.ts`（钩子+覆盖查询）、`audit.ts` 服务（新）、`shared/types.ts`、设置 UI 新区。规模 ~300 行 + M2。

---

## 6. 实施顺序与版本映射

| 序 | 设计 | 依赖 | 版本 | 理由 |
|----|------|------|------|------|
| 1 | 一：首启向导 + 体检 | 无 | 0.4.0 | 转化率第一杠杆，纯渲染层 |
| 2 | 二：托盘 + 通知管道 | 无 | 0.4.0 | 消解最大体验差距；为四铺通知底座 |
| 3 | 三：轻量记忆 | 无 | 0.4.1 | 补范式短板 |
| 4 | 四：巡检告警 + 趋势 + sqlite | 设计二（notifier） | 0.5.0 | 护城河纵深；README 定位句同步升级为「本地优先的无人值守运维 Agent」 |
| 5 | 五：审计 + 风险策略 | 无 | 0.5.0 | 信任层收官 |

## 7. M2 契约清单（一次批准、分批实现）

- `shared/types.ts`：`Settings` 追加 `tray?` / `notifications?` / `riskOverrides?`；新增 `InspectionTrend` / `DailyPoint` 类型
- `shared/ipc.ts` + `preload.ts`：新增 `memory:get` / `memory:save` / `inspection:trends` 通道
- `index.ts`（冻结）：追加 ≤3 行托盘启动 + will-quit checkpoint
- `CONTRACTS.md`：追加 M2 变更记录条目（含本文件引用）

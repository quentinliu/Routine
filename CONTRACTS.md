# Routine 契约文档（FROZEN）

本文件定义三个并行功能代理共同遵守的契约。`src/shared/**` 为冻结区，任何修改须经编排者批准。

> 变更记录：
> - 2026-08-31 · P1 契约扩展（数据库巡检功能），编排者已批准，规划见 `.sisyphus/plans/db-inspection-architecture.md`
> - 2026-08-31 · T0 条款修订：`src/main/preload.ts` 改为追加式扩展（原为冻结只读），编排者已批准，依据 `.sisyphus/plans/p1-task-breakdown.md`
> - 2026-10-16 · P1.5 契约扩展（SSH 远程主机与远程命令执行），编排者已批准：`src/shared/types.ts` 追加 `SshHostConfig` / `SshTestResult` / `SshExecResult` / `SshExecOptions`；`src/shared/ipc.ts` 追加 `ssh:list` / `ssh:save` / `ssh:delete` / `ssh:test` / `ssh:exec` 通道与对应 `RoutineApi` 方法；主进程新增 `src/main/services/ssh/**`（依赖 `ssh2`，纯 JS，无原生模块，CJS 兼容），存储新增 `ssh-hosts.json`；既有条目未修改
> - 2026-10-16 · P1.5b 契约扩展（SSH Agent 化），编排者已批准：`AgentName` 追加 `'ssh'`（`AGENT_NAMES` / `AGENT_LABELS` 同步）；编排器 JSON 协议新增工具 `ssh.hosts {}`（safe）与 `ssh.exec {host, command}`（medium，每次执行前经安全门 UI 确认，host 支持名称/id/唯一模糊匹配）；规划提示词动态注入当前主机清单；`OrchestratorDeps` 新增 `ssh: SshService`

## 目录所有权

| 代理 | 可写目录/文件 | 职责 |
|------|--------------|------|
| A 核心代理 | `src/main/llm/**`, `src/main/agent/**`, `src/main/ipc.ts` | LLM 双模式路由、编排器、安全门、IPC 装配 |
| B 服务代理 | `src/main/services/**`, `src/main/util/**` | 文件索引/读取、系统控制、联网搜索、浏览器自动化、数据库巡检（MySQL/PostgreSQL，`src/main/services/db/**`） |
| C 界面代理 | `src/renderer/**`（不含 `global.d.ts`） | 对话界面、Agent 面板、设置页、安全确认弹窗、数据库巡检视图 |

- `src/shared/types.ts` 与 `src/shared/ipc.ts`：冻结，只读。
- `src/main/index.ts`：冻结，只读（已定稿）。
- `src/main/preload.ts`：允许**追加式扩展**（比照 storage.ts 条款）——新增 IPC 通道时须在 `CH` 表与 `api` 实现中追加对应条目；既有条目不得修改，保持向后兼容；通道字符串须与 `src/shared/ipc.ts` 逐字一致（沙箱 preload 无法 require 共享常量）。
- `src/main/services/storage.ts`、`src/main/util/shell.ts`、`src/main/util/paths.ts`：已完整实现，B 代理可直接使用；如需扩展请以追加方式修改并保持向后兼容。
- 服务单例导出（已定稿，B 实现时必须保留）：`getFileAgentService()` / `getComputerService()` / `getWebSearchService()` / `getBrowserAgentService()` / `getInspectorService()`，A 代理在 IPC 装配时使用。

## IPC 通道（见 `src/shared/ipc.ts` 的 `IPC` 常量）

invoke（renderer→main，参数为对象）：

| 通道 | 载荷 | 返回 |
|------|------|------|
| `chat:send` | `{sessionId, text}` | `void`（结果经事件流回传） |
| `chat:stop` | `{}` | `void` |
| `safety:respond` | `{requestId, approved}` | `void` |
| `sessions:list/new/delete/load` | `{id?}` | `ChatSession[]` / `ChatSession` / `void` |
| `settings:get/set` | `{settings?}` | `Settings` |
| `file:search` | `{query, limit?}` | `FileSearchResult[]` |
| `file:read` | `{path, maxBytes?}` | `{content, truncated}` |
| `file:index:start` | `{}` | `void`（进度经 `index:progress` 事件） |
| `computer:snapshot` | `{}` | `SystemSnapshot` |
| `computer:exec` | `{op, args}` | `{summary, details?}` |
| `computer:list-ops` | `{}` | `ComputerOp[]` |
| `search:web` | `{query, maxResults?}` | `WebSearchResult[]` |
| `browser:run` | `{instruction}` | `BrowserTaskResult` |
| `browser:available` | `{}` | `boolean` |
| `llm:health` | `{}` | `{cloud, local}` |
| `app:open-external` | `{url}` | `void` |
| `db:list` | `{}` | `DatasourceConfig[]` |
| `db:save` | `{datasource}` | `DatasourceConfig` |
| `db:delete` | `{id}` | `void` |
| `db:test` | `{id}` | `{ok, version, latencyMs}` |
| `inspection:run` | `{datasourceId}` | `InspectionReport`（进度经 `inspection:progress` 事件；同数据源防重入） |
| `inspection:reports` | `{datasourceId?}` | `InspectionReport[]` |
| `ssh:list` | `{}` | `SshHostConfig[]` |
| `ssh:save` | `{host}` | `SshHostConfig`（校验 + upsert） |
| `ssh:delete` | `{id}` | `void` |
| `ssh:test` | `{id}` | `SshTestResult`（握手 + 版本横幅 + 延迟，不执行任何命令） |
| `ssh:exec` | `{id, command, options?}` | `SshExecResult`（每次独立连接；超时与输出上限钳制） |

事件（main→renderer，`sendToRenderer(channel, payload)`）：

| 通道 | 载荷 |
|------|------|
| `chat:delta` | `ChatDeltaEvent {sessionId, msgId, delta, done?}` |
| `chat:error` | `{sessionId, error}` |
| `agent:status` | `AgentStatus` |
| `safety:request` | `SafetyRequest` |
| `log:entry` | `LogEntry` |
| `index:progress` | `IndexProgress` |
| `inspection:progress` | `{reportId, checkId, status}` |

## 编排器协议（A 代理实现）

`Orchestrator.handleUserMessage(sessionId, text, emit)` 通过 `emit(OrchestratorEvent)` 推送四类事件（定义于 `src/main/agent/orchestrator.ts`）。主 Agent 采用统一 JSON 协议驱动子工具，与 LLM 供应商无关。工具白名单：`file.search` / `file.read` / `computer.info` / `computer.exec` / `search.web` / `browser.run` / `ssh.hosts` / `ssh.exec`；风险分级见 `SafetyGate.classify`（`ssh.exec` 固定 medium，执行前必须经 UI 确认）。

## 系统操作白名单（B 代理实现，风险级别已冻结）

见 `src/main/services/computer.ts` 的 `COMPUTER_OPS`。`empty-trash`、`kill-app` 必须经安全门走 UI 确认；`toggle-dark-mode`、`set-brightness` 为 medium 建议同样确认。

## 环境事实

- Intel x86_64 macOS 15.7，Node v24，Electron 44，TS ~5.9（严格模式，禁 `as any`/`@ts-ignore`）
- 主进程为 CJS（tsc 编译），只能 require 兼容包；渲染层由 vite 打包，可用 ESM
- 无原生模块依赖；存储 = userData 目录下 JSON 文件
- 文件索引默认目录：`~/Desktop`, `~/Documents`, `~/Downloads`；`~` 展开用 `expandHome()`（util/paths.ts）
- 数据库巡检（P1 批准）：依赖 `mysql2`、`pg`（纯 JS，无原生模块，CJS 兼容）；数据源存 `datasources.json`、巡检报告存 `inspections.json`（每数据源上限 200 条）；巡检为只读诊断（safe 级，不经安全门）；检查项接口与巡检清单见规划文档 §5
- SSH 远程主机（P1.5 批准）：依赖 `ssh2`（纯 JS，无原生模块，CJS 兼容）；主机配置存 `ssh-hosts.json`；`ssh:test` 仅握手不执行命令，`ssh:exec` 每次独立建立连接并在结束时关闭（无长连接池）；执行超时钳制 [1s, 300s]（默认 30s），输出上限钳制 [1KB, 10MB]（默认 512KB）；由用户在设置页直接触发（点击即确认），不接入安全门

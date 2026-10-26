# Routine 契约文档（FROZEN）

本文件定义三个并行功能代理共同遵守的契约。`src/shared/**` 为冻结区，任何修改须经编排者批准。

> 变更记录：
> - 2026-08-31 · P1 契约扩展（数据库巡检功能），编排者已批准，规划见 `.sisyphus/plans/db-inspection-architecture.md`
> - 2026-08-31 · T0 条款修订：`src/main/preload.ts` 改为追加式扩展（原为冻结只读），编排者已批准，依据 `.sisyphus/plans/p1-task-breakdown.md`
> - 2026-10-16 · P1.5 契约扩展（SSH 远程主机与远程命令执行），编排者已批准：`src/shared/types.ts` 追加 `SshHostConfig` / `SshTestResult` / `SshExecResult` / `SshExecOptions`；`src/shared/ipc.ts` 追加 `ssh:list` / `ssh:save` / `ssh:delete` / `ssh:test` / `ssh:exec` 通道与对应 `RoutineApi` 方法；主进程新增 `src/main/services/ssh/**`（依赖 `ssh2`，纯 JS，无原生模块，CJS 兼容），存储新增 `ssh-hosts.json`；既有条目未修改
> - 2026-10-16 · P1.5b 契约扩展（SSH Agent 化），编排者已批准：`AgentName` 追加 `'ssh'`（`AGENT_NAMES` / `AGENT_LABELS` 同步）；编排器 JSON 协议新增工具 `ssh.hosts {}`（safe）与 `ssh.exec {host, command}`（medium，每次执行前经安全门 UI 确认，host 支持名称/id/唯一模糊匹配）；规划提示词动态注入当前主机清单；`OrchestratorDeps` 新增 `ssh: SshService`
> - 2026-10-21 · A1+A2 契约扩展（ReAct 双策略 + 工具注册表），编排者已批准，规划见 `.sisyphus/plans/react-mcp-architecture.md`：A1 将编排器工具层重构为 `ToolRegistry`（`src/main/agent/tools/**`，8 个内置工具迁入 `tools/builtin/**`，安全审批收口 registry 统一管道，`OrchestratorDeps` 收窄为 `{router, safety, registry}`，行为不变）；A2 追加 `Settings.agent {maxSteps}`（范围 [2,30]，默认 12，旧配置文件自动合并默认值）与 `AgentTraceEvent` / `TracePhase`，`src/shared/ipc.ts` 追加事件通道 `agent:trace` 与 `RoutineApi.onAgentTrace`（preload 同步追加）；编排器支持双策略——云端 OpenAI 兼容接口走原生 function calling（`LLMRequest.tools` / `LLMResponse.toolCalls` / 消息 `tool` 角色，4xx 自动降级文本协议），本地 Ollama 维持文本 JSON 协议；新增循环安全：中止信号贯穿 LLM 请求、同参连续失败钳制、按工具结果截断（`file.read` 32k，默认 4k）、工具结果以 `<tool_result>` 包裹防注入
> - 2026-10-21 · A3 契约扩展（MCP 客户端层），编排者已批准，规划见 `.sisyphus/plans/react-mcp-architecture.md` §6-§7：`AgentName` 追加 `'mcp'`（`AGENT_NAMES` / `AGENT_LABELS` 同步）；`src/shared/types.ts` 追加 `McpServerConfig` / `McpTransport` / `McpToolInfo` / `McpConnState` / `McpServerInfo` / `McpTestResult`；`src/shared/ipc.ts` 追加 `mcp:list` / `mcp:save` / `mcp:delete` / `mcp:test` / `mcp:connect` / `mcp:disconnect` 通道与对应 `RoutineApi` 方法（preload 同步追加）；主进程新增 `src/main/services/mcp/**`（依赖 `@modelcontextprotocol/sdk@^1.32.1`，纯 JS 双构建 CJS 兼容，无原生模块），存储新增 `mcp-servers.json`；MCP 工具以 `mcp__{server}__{tool}` 注册进 ToolRegistry（冲突自动加后缀），默认 medium 风险走安全门 UI 确认、可按服务配置 safe；stdio 服务保存时须经高风险确认弹窗（本机将长期运行外部程序）；app `will-quit` 时统一断开全部连接（清理逻辑位于 `ipc.ts`，`index.ts` 保持冻结）
> - 2026-10-21 · T1 契约扩展（任务子任务清单），编排者已批准，规划见 `.sisyphus/plans/task-todo-panel.md`：`src/shared/types.ts` 追加 `TaskTodoStatus` / `TaskTodoItem` / `TodoUpdateEvent`（全量快照语义，命名避开定时任务 TodoTask）；`src/shared/ipc.ts` 追加事件通道 `agent:todo` 与 `RoutineApi.onTodoUpdate`（preload 同步追加）；新增内置工具 `todo.write`（safe，`ToolContext` 追加 `sessionId`）；渲染层右侧面板由 Agent 卡片改为任务进度清单（`TaskTodoPanel`，`agent:status` 事件协议保留）
> - 2026-10-21 · T2 契约扩展（联网搜索引擎重构），编排者已批准：`SearchConfig.provider` 枚举改为 `SearchProvider = 'auto' | 'bing' | 'tavily'`（默认 `auto` = Tavily(配置 Key 时) → 必应 自动回退链，引擎请求 8-12s 显式超时，进程内记忆上次成功引擎）；**DuckDuckGo 引擎移除**（受限网络不可达），旧配置中的 `duckduckgo` 读取时归一为 `auto`；`search:web` 通道与 `WebSearchResult` 结构不变；失败错误信息指名各引擎端点，便于定位网络问题
> - 2026-10-22 · S1 契约扩展（数据库 Agent + Skills 技能系统），编排者已批准：`AgentName` 追加 `'db'`（`AGENT_NAMES` / `AGENT_LABELS` 同步）；新增内置工具 `db.list {}`（safe）/ `db.query {datasourceId, sql}`（safe，主进程强制只读守卫：首词白名单 SELECT/SHOW/EXPLAIN/DESC + 单语句 + FOR UPDATE / LOCK IN SHARE MODE / INTO OUTFILE / sleep 拒绝）/ `db.exec {datasourceId, sql, reason}`（medium，走安全门确认）；主进程新增 `src/main/services/db/service.ts`（连接按 datasourceId 缓存，app `will-quit` 统一释放）并接通 P1 已声明的 `db:list` / `db:save` / `db:delete` / `db:test` / `inspection:run` / `inspection:reports` 六个通道；`Settings` 追加 `skillOverrides?: Record<string, boolean>`（缺省启用，旧配置自动兼容）；技能遵循 Agent Skills 开放标准（agentskills.io，目录 + SKILL.md），内置根 `resources/skills/`（electron-builder `extraResources` 打包，当前为 planetscale/database-skills 的 mysql/postgres，MIT）、用户根 `userData/skills/`（同名时用户覆盖内置），新增 `src/main/skills/**`（loader/registry）与内置工具 `skill.run {skill, datasourceId}`（safe，返回正文 + Routine 环境适配头，正文不常驻提示词、目录（name+description）经 `SKILLS_PLACEHOLDER` 注入双策略系统提示词）与 `skill.read {skill, path}`（safe，限技能目录内普通文件，拒绝路径穿越）；`src/shared/types.ts` 追加 `SkillInfo` / `SkillDetail`；`src/shared/ipc.ts` 追加 `skill:list` / `skill:read` / `skill:install` / `skill:remove` 通道与对应 `RoutineApi` 方法（preload 本地 CH 表同步追加，通道字符串逐字一致）；`OrchestratorDeps` 追加可选 `skills?: SkillRegistry`；主进程新增依赖 `yaml`（纯 JS，CJS 兼容）
> - 2026-10-24 · M1 契约变更（多云端模型 + 主界面切换），编排者已批准：`Settings.cloud: CloudProviderConfig` **替换为** `cloudProfiles: CloudProfile[]`（≥1 条）+ `activeCloudId: string`，`CloudProfile = CloudProviderConfig & {id, label}`；旧单配置 `cloud` 读取时包装为单条 profile（label 取模型名，id 随机生成），`activeCloudId` 失效归一为首条，下次保存落盘（storage.ts 读取时迁移，同 duckduckgo 先例）；`src/shared/ipc.ts` 追加 `llm:health-clouds` 通道与 `RoutineApi.llmHealthClouds`（返回 `Record<profileId, boolean>`，逐档案并行探测，不含本地）；`llm:health` 语义微调：`cloud` 字段=当前 active 档案可用性；LLM 路由 `getActive()` 按 `activeCloudId` 解析档案（失效回退首条）；编排器 `getActive()` 上提出 ReAct 循环——**单次任务全程锁定同一模型，任务失败/结束后方可切换**；渲染层 Topbar 增模型胶囊下拉（显示各档案健康徽标，软门控：失败仍可选仅标红），设置页云端模型区改为档案列表（增删改 + 设为使用中 + 逐档案健康圆点），模型候选沿用 datalist（选择 + 手输）
> - 2026-10-24 · M2 契约扩展（Ops 工作台批次一：托盘/通知/记忆/巡检趋势/风险策略），编排者已批准，设计见 `.sisyphus/plans/ops-workbench-roadmap.md`：`Settings` 追加 `tray?: {closeToTray}` / `notifications?: {enabled}` / `riskOverrides?: Record<string,'safe'\|'medium'\|'high'>`（均缺省关闭语义 = 功能开启，旧配置自动兼容；riskOverrides 硬底线：基线 high 不可下调至 safe、未知工具忽略）；`src/shared/types.ts` 追加 `DailyPoint` / `InspectionTrend`；`src/shared/ipc.ts` 追加 `memory:get` / `memory:save` / `inspection:trends` 通道与对应 `RoutineApi` 方法（preload 同步追加）；`src/main/index.ts`（冻结）追加 2 行：`createTray` 导入与调用；主进程新增 `src/main/tray.ts`（托盘：显示主窗口/暂停定时任务/退出，close-to-tray 拦截位于 ipc.ts `setMainWindow`，退出经 `markQuitting` 绕过）与 `src/main/services/notifier.ts`（系统通知统一入口，带 6h 去重键）；scheduler 追加 `setPaused/isPaused`（暂停自动触发，手动 runTaskNow 不受影响）与执行完成通知挂钩
> - 2026-10-24 · M3 契约扩展（两轮审查修复批次），编排者已批准，计划见 `.sisyphus/plans/design-review-remediation.md`：**R2-P0 修复**——FC 兜底摘要改由任务级 `taskObservations` 生成（原消息反解析在云模式下恒空）；`Settings.scheduler.maxConcurrent` 废弃（编排器单飞，调度并发钳制为 1），失败任务 15 分钟后自动重试一次；`src/shared/ipc.ts` 追加 `EventPayloadMap`（事件通道→载荷映射）与 `sendToRenderer` 类型化；IPC 错误采用 `[CODE] message` 前缀约定（`[INVALID]` / `[TURN_FAILED]`）；工具失败分型：用户拒绝不计入连续失败钳制；FC 能力探测由消息正则改为 `LlmHttpError.status`（openaiCompat 新增导出类）；删除 `SafetyGate.classify/baseClassify` 死代码（风险基线唯一来源 = ToolDefinition.risk）；`SafetyRequest` 追加 `tool?: string`（审计归因）；敏感凭据落盘加密（`enc:` 前缀，safeStorage 不可用回退明文）：SSH/DB 密码与站点凭据；JSON 解析失败改名 `.corrupt-<ts>` 保留并告警；新增组合根 `src/main/composition.ts`（工具/技能/编排器装配自 ipc.ts 迁出）与 `src/main/services/chatService.ts`（`runTurn` 统一聊天/定时两路径的会话持久化与失败清理）；渲染层新增 `lib/mcpParse.ts` / `lib/useEntityForm.ts` / `lib/cloudPresets.ts`（前者自 McpSection 下沉）

> - 2026-10-24 · M4 契约扩展（数据库工作台：观测面独立），编排者已批准：`src/shared/types.ts` 追加 `CheckTrendRow`（`checkId` / `title` / `total` / `fails` / `skipped` / `recentFails7d` / `lastStatus`；`fails` 仅计 warn/error，`skipped` 单列不拉低通过率）与 `CheckSeriesPoint`；`src/shared/ipc.ts` 追加 `inspection:check-trend` / `inspection:check-series` 通道及对应 `RoutineApi` 方法（preload 同步追加）；`inspection:reports` 载荷追加可选 `{limit, before}`（limit 缺省 50、钳制 [1,200]，before 为上一页最旧 startedAt），返回仍为 `InspectionReport[]`；`InspectionStore` 追加 `checkTrend(datasourceId, days)`（`json_each` 按 checkId 聚合，末次状态取窗口内最近一次**包含该检查项**的报告）与 `checkSeries(datasourceId, checkId, days)`（按本地日期逐日聚合）；新增 `src/main/services/inspectionRunner.ts`（执行 → 落库 → 告警评估唯一入口），`DbService.inspect` 增加同数据源 in-flight 锁（兑现既有防重入条款）；新增内置工具 `inspection.run {datasourceId}`（safe，让 Agent/定时任务能产出巡检报告，打通观测数据来源）；渲染层新增 `DatabaseWorkbench` 全屏弹窗（Topbar 主入口，设置页仅留入口与摘要），趋势支持 7/30/90/365 天，检查项行下钻逐日序列、报告行展开单次明细，异常记录由报告序列推导，并支持“在对话中诊断”预填（写入草稿、不自动发送）

> - 2026-10-25 · P6 契约变更（提示词体系），编排者已批准，规划见 `.omo/plans/prompt-system-refactor.md`：新增 `src/main/agent/prompt/{registry,interpolate,sections}.ts`——`PromptSection {name, order, strategies?, text}` 有序装配，`{{snake_case}}` 严格插值（未赋值 / 非法变量名 / 分段重名一律抛错）；删除 `PLANNING_SYSTEM` / `FC_SYSTEM` 模板与 `replace` 链，`Orchestrator.planningSystem()` 保留为 `assemble('text-json')` 薄封装；工具清单改由 `ToolRegistry.all()` 程序化生成（`{必填, 可选?}` 签名 + 描述首句；MCP 工具仍走独立分段）；`ToolDefinition` 追加 `promptSection`（跨调用行为守则，与工具定义同文件维护）与 `render`（工具结果渲染，缺省 `JSON.stringify`，渲染后仍受 `maxResultChars` 截断）；易变事实（长期记忆 / SSH 主机清单）自 system prompt 迁出，改为消息尾部 `[运行时上下文]` user 快照（每轮只保留最新一条、为空不追加），任务内系统提示词按策略冻结以保住供应商前缀缓存；`db.list` 工具结果整键移除 `password`（原先返回空串会被模型误读为「凭据缺失」并复述为密码为空）；新增 `src/main/util/redact.ts`（`redactSecrets` 掩码 / `omitSecretFields` 删除），`DbService.maskDatasource` 收敛到它
> - 2026-10-25 · M5 契约扩展（界面主题），编排者已批准：`src/shared/types.ts` 新增 `ThemeMode`（`system` / `light` / `dark`）与 `Settings.appearance?: { theme }`（缺省 `system`，`loadSettings` 归一非法值）；不新增 IPC 通道，复用 `settings:get/set`。`styles.css` 完成三层令牌化：新增 `--accent-strong/--accent-hover/--on-accent/--code-bg/--overlay/--knob/--hover/--bg-elev` 及 success/warn/danger 的 dim/border 变体，令牌块之外禁止裸色（新增 `tests/theme-tokens.test.js` 机器校验）；`:root[data-theme='light']` 提供浅色令牌并设置 `color-scheme: light`。渲染层 `theme.ts` 在 React 挂载前用 localStorage 镜像出首帧，设置加载后以 `Settings.appearance` 对账，`system` 模式监听 `prefers-color-scheme` 实时切换；设置页新增「外观」分类，选择即生效并立即持久化。主进程 `nativeTheme.themeSource` 随设置同步，窗口 `backgroundColor` 按 `nativeTheme.shouldUseDarkColors` 取色；托盘图标为模板图（`setTemplateImage`），由 macOS 自动适配浅/深菜单栏，无需新增资源
> - 2026-10-25 · M6 契约变更（模型选择器迁入输入区），编排者已批准：M1 条目中「渲染层 Topbar 增模型胶囊下拉」的**位置**部分被本条目替代——模型胶囊移到 `Composer` 卡片底部控制行（与发送/停止按钮同行），菜单向上展开避免窗口底部溢出；`Topbar` 仅保留「效率模式 / 隐私模式」徽标与功能入口。隐私模式（本地 Ollama）下胶囊为静态标签「本地 · `ollama.model`」，点击进入设置页；任务执行中胶囊禁用，承接 M1「单次任务全程锁定同一模型」。`llm:health-clouds` 通道、健康软门控（失败仍可选、仅标红）、设置页档案管理等其余条款不变；`src/shared/**` 未修改
> - 2026-10-26 · U1 渲染层简化（移除右侧任务进度面板），用户指示：删除 `TaskTodoPanel` 组件及 `AgentPanel` 引用，store 移除 `todosBySession` / `pushTodoUpdate` / `EMPTY_TODOS` 与 `App.tsx` 的 `onTodoUpdate` 订阅（连带清理 `sendText` / `removeSession` 中的 todos 维护与 T1 面板样式段）；子任务进度可见性由「执行过程」时间线承担（`todo.write` 工具行）。**冻结区不变**：`src/shared/**` 的 `agent:todo` 通道、`TaskTodoItem` / `TodoUpdateEvent`、`todo.write` 工具与主进程事件发播全部保留，仅渲染层暂不消费

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
| `llm:health` | `{}` | `{cloud, local}`（cloud = 当前 active 档案） |
| `llm:health-clouds` | `{}` | `Record<profileId, boolean>`（逐档案并行探测） |
| `app:open-external` | `{url}` | `void` |
| `db:list` | `{}` | `DatasourceConfig[]` |
| `db:save` | `{datasource}` | `DatasourceConfig` |
| `db:delete` | `{id}` | `void` |
| `db:test` | `{id}` | `{ok, version, latencyMs}` |
| `inspection:run` | `{datasourceId}` | `InspectionReport`（进度经 `inspection:progress` 事件；同数据源防重入） |
| `inspection:reports` | `{datasourceId?, limit?, before?}` | `InspectionReport[]`（倒序分页；limit 缺省 50、钳制 [1,200]） |
| `inspection:check-trend` | `{datasourceId, days}` | `CheckTrendRow[]`（窗口内按检查项聚合；days 钳制 [7,365]） |
| `inspection:check-series` | `{datasourceId, checkId, days}` | `CheckSeriesPoint[]`（单检查项逐日序列） |
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
- 敏感字段约定（P6 批准）：新增含密钥的配置或工具结果必须过 `src/main/util/redact.ts`——落盘由 storage 加密，对外载荷用 `redactSecrets` 掩码，送模型的结果用 `omitSecretFields` 整键删除（返回空串会让模型误报「凭据缺失」）。`db:list` 维持掩码形状（`password: ''`）；`ssh:list` 因设置页需回填编辑仍返回明文，不得在其它出口复用该返回值
- 提示词约定（P6 批准）：系统提示词只能经 `PromptRegistry.assemble()` 产出，禁止再拼大字符串或 `.replace()` 占位符；新增工具的行为守则写在该工具的 `promptSection` 里，易变的运行时事实（主机 / 记忆等）走 `promptContext()` → 消息尾部快照

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
> - 2026-10-26 · U2 渲染层扩展（右侧数据库状态面板），用户指示：`AgentPanel` 原「任务进度」空位改为「数据库状态」（`DbStatusPanel` + `src/renderer/lib/dbStatus.ts` 纯函数）。健康度模型：`down` 红（`db:test` 失败，无法访问）/ `issues` 黄（可达但最近一次巡检报告含 warn/error 项，读本地巡检库不实时跑巡检）/ `ok` 绿（可达且无已知问题）/ `disabled` 灰（停用数据源不探测）；排序红→黄→绿→灰（探测中过渡态置顶），组内按名称。挂载与 ↻ 按钮触发全量并行探测（`db:test` + `inspectionReports(id, 1)`，逐结果落位重排）；行点击打开对应数据库工作台，空态引导去设置。`src/shared/**` 未修改，复用既有 `db:list` / `db:test` / `inspection:reports` 通道
> - 2026-10-26 · U3 契约补充（数据源清单入运行时快照），用户指示 P0：`db.list` 工具新增 `promptContext()`（对齐 SSH 主机清单先例），将已配置数据源（name / type / id / host:port / database / enabled，**绝不含凭据字段**）注入 `[运行时上下文]` 快照；空清单输出明确空态块防模型臆断。修复「模型不可见数据源清单 → 断言『没有 MySQL 数据源』→ 幻觉技能名 + 缺 datasourceId 级联失败」的信息缺口；P6 快照机制不变，`src/shared/**` 未修改
> - 2026-10-26 · U4 契约补充（巡检任务三级容错），用户批准 A→C→E→F(+D)：**A** 提示词规则新增「工具失败≠任务失败，已有产出必须汇入回答，严禁整体放弃」（双策略 RULES 段）；编排器新增放弃式回答拦截——`isAbandonmentText`（短文本+放弃措辞启发式）+ 任务存在非失败工具产出时注入重写指令（`continue` 消耗一轮），每任务至多一次。**C** trace 摘要键序 `skill` 提前至 `datasourceId` 前，执行过程可见技能名。**E** `skill.run` 正文预截断阈值 14k + `skill.read` 续读指引（body 级截断保证 references 字段完整），`maxResultChars` 12k→16k。**F** 适配头扩充术语映射：db_query/db_get_status/db_get_variable→db.query 等价调用、禁 `\G`、占位符先查后代、多实例手册按单数据源执行（Pattern B）、单步失败不整体放弃。**D** `skill.run` 校验顺序改为技能存在性先于 datasourceId，报错附可用技能清单。`src/shared/**` 未修改
> - 2026-10-26 · U5 契约扩展（完整对话日志），用户指示：新增 `src/main/services/conversationLog.ts`（任务级 JSONL 落盘：task / round / event / final / error 五类行；每任务一个 `<msgId>.jsonl`，`userData/logs/conversations/`，保留最近 50 个任务；未初始化时返回空实现供测试）；编排器在每个 LLM 轮次记录完整请求（system / messages / 工具名）与响应（content / finishReason / usage / 解析后的 step）及策略降级、放弃式重写、中止、失败事件。`src/shared/types.ts` 追加 `ConversationTaskMeta` / `ConversationLogLine` / `ConversationLogView`；`src/shared/ipc.ts` 追加 `conversation:list` / `conversation:get` 通道与对应 `RoutineApi` 方法（preload 同步追加）；渲染层 `ChatView` 头部新增「对话日志」入口 + `ConversationLogDialog`（任务列表 / 逐轮展开：system、messages、模型原始输出、工具调用；支持复制 JSON）。用于定位模型行为问题——此前执行日志仅 500 条内存环形缓冲、过程块只有 160 字符摘要，看不到完整上下文
> - 2026-10-26 · U6 契约扩展（Agent 循环加固，依据 `sessionlog.txt` 巡检事故复盘），用户批准 plan `routine-agent-loop-fixes`：**日志** `ConversationLogLine.type` 追加 `'tool'`，`TaskRunLog` 追加 `tool(id, ToolLogInput)`（name / argsDigest 脱敏≤200 字符 / ok / denied? / durationMs / resultChars / resultDigest≤800 字符），补齐「最后一轮执行的调用在日志里没有痕迹」的缺口；`ConversationLogDialog` 增加 tool 行（工具名·成功/失败/被拒绝·耗时，可展开参数与结果摘要）。**控制流** 最后一轮（`round === steps-1` 且已有工具产出）不再执行工具调用，记 warn 并转 `answerIntent='budget'`；收敛提示提前到倒数第二轮；新增 `validateArgs`（结构/必填/枚举，深度≤2，标量类型不强校验），参数非法时不执行工具、错误带字段路径（如 `todos[0].content`），整轮全非法则原地重试不消耗规划轮次。**协议** 文本协议 `AgentLoopStep.calls` 支持 `actions` 数组（合并 `action`、去重、过滤空项），`todo.write` 规则按策略分流（FC 保留每轮并行刷新，文本协议改为 actions 合并提交）；工具清单签名递归渲染嵌套字段与枚举。**守卫** 新增 `findUnsupportedNumbers`（3 位以上整数/整数部分≥2 位小数，放行字面量、端口/年份/HTTP 白名单、两位来源数的比值-百分比-差值推导与近似值），命中后与一致性守卫共用一次重写额度，重写后仍不通过只记 warn 放行；`answerSystemPrompt` 追加阈值引用、系统库过滤、0 行复核、工具确认串不得当任务进度、缺失维度写「未获取」五条硬约束。**引导** `skill.run` 适配头改为「无本地 shell，但主机指标用 ssh.exec」，并补系统库过滤/无基线不得编造趋势；`db.list` 守则补「先 `inspection.run` 再补维度、同类查询用 actions 并行」。`todo.write` 兼容 `title` 别名。旧 `.jsonl` 日志与既有 `round/event/final` 字段不变
> - 2026-10-26 · U7 契约扩展（作答阶段与技能注入，依据 `sessionlog.txt` 复盘，用户指示前三项优先）：**作答分段续写** `streamAnswer` 支持最多 3 段自动续写（命中 `truncated` 时以上文 assistant 消息 + 续写指令继续），单段输出上限由 2048 提到 `Settings.agent.answerMaxTokens`（缺省 4096，范围 [1024, 8192]）；仍被截断时把「建议部分未完成 + 回复继续」写进**正文**并记 warn（不再只落日志）。**完整工具结果复用** `buildAnswerDigest` 改为逐条保留全部调用（序号 + 关键参数 `describeCallArgs`），取消 `compactTools` 占位与同文案去重，总预算 12k→48k、单条 4k→16k；`db.query` / `db.exec` 结果回填 `sql` 字段，0 行提示带上 SQL 以便逐条复核。**技能摘要注入** 新增 `src/main/skills/outline.ts`（`buildSkillSummary` / `readSkillSection`），`skill.run` 只返回环境适配头 + 开篇概览（1200 字）+ 章节清单，正文用 `skill.read {skill, path:"SKILL.md", section:"序号或标题"}` 按需取（`maxResultChars` 16k→8k）；`skill.read` 新增可选 `section`，不带 section 时只回摘要。**todo 增量下发** `todo.write` 入参拆为 `todos`（全量，`content`+`status` 必填）/ `patch`（增量，`index` 必填），主进程按 session 维护基线，回执只报变更条数；提示词双策略改为「首次全量、之后只发 patch」。**上下文预算** 编排器新增 `compactContext`：历史工具结果总字符超 16k 时从最旧开始归档为「前 240 字 + 已归档」占位（最后一轮默认保留），保证轮次增加不再线性推高 prompt。旧 `.jsonl` 字段与 `db.query` 既有结果键兼容（新增键为增量）

> - 2026-10-26 · U8 契约扩展（审批链留痕与安全底线，依据 `sessionlog.txt` 对 ssh.exec 确认链的核查）：**安全底线** `ToolDefinition` 追加 `riskFloor?: RiskClass`，`SafetyGate.effectiveRisk(tool, base, floor?)` 在应用 `Settings.riskOverrides` 之后按 `max(覆盖值, floor)` 收敛（保留「基线 high 不可降为 safe」旧规则）；`ssh.exec` / `db.exec` 设 `riskFloor: 'medium'`——修复「设置页把 ssh.exec 设为 safe 即可无弹窗、无审计地执行远程命令」的旁路。**审批结论分型** `SafetyGate.awaitApproval` 返回值由 `boolean` 改为 `ApprovalOutcome = 'approved' | 'denied' | 'timeout' | 'canceled'`（`constructor(approvalTimeoutMs?)` 可注入，供测试验证超时语义），新增 `cancelApproval(id, reason)` / `cancelAll(reason)`（窗口不可达、任务中止时立即终结，不再白等满 120s 并把 busy 锁占住）；`registry` 改为抛出带 `code` 的 `ApprovalError`（`E_DENIED` / `E_TIMEOUT` / `E_CANCELED`），编排器按 `code` 而非中文子串 `includes('拒绝')` 分型，回灌文案区分「用户拒绝」「确认超时（无人响应）」「任务已中止」。**审计取证** `AuditEntry` 追加 `detail?: string`（审批时展示的完整命令 / SQL 原文）与 `msgId?: string`（关联会话日志），`AuditOutcome` 追加 `canceled`；`SafetyGate.createRequest` 入参改为对象 `SafetyRequestInput`。**会话日志** `ConversationLogLine.type` 追加 `'safety'`，`TaskRunLog` 追加 `safety(id, SafetyLogInput)`（tool / risk / outcome / waitMs / detail）；`ToolLogInput` 追加 `timedOut?` / `canceled?` / `approvalMs?`（审批等待与命令执行耗时分开记录），`argsDigest` 上限 200→1000 字符（此前一条 ssh 命令被截断到看不全）。`ToolContext` 追加 `msgId?` / `approval?` 回调。`ConversationLogDialog` 增加 safety 行与「确认超时 / 已取消」状态。**IPC** `sendToRenderer` 改为返回 `boolean`，`safety` 事件送达失败即调用 `cancelApproval`（不把「没人看到」记成「用户拒绝」）；`safety:respond` 校验发送方必须是主窗口 webContents。旧 `.jsonl` 日志与既有工具定义不受影响（新增字段均为可选）

> - 2026-10-26 · U9 契约变更（日志去重与分工收敛，用户指示 P0~P3 全做）：定位划清为「执行日志 = 基础设施」「执行过程 = 本次任务」「对话日志 = 模型看到了什么」。**归属字段** `LogEntry` 追加可选 `scope?: 'task' | 'infra'`（缺省 `task` 以兼容旧载荷），`AgentPanel` 的 `LogPanel` 只渲染 `scope === 'infra'` 的条目并同步计数/空态；`src/main/ipc.ts`（浏览器 `browser.run`、MCP `setLogFn`）与 `src/main/services/scheduler.ts`（触发、进度、失败重试、异常四处）显式标记 `infra`；审批超时/取消改由编排器 `infra()` 发出。**任务内事件单一出口** 编排器新增 `report()`（写 `TaskRunLog.event`，warn/error 额外发 `trace phase='notice'`），替换原「`this.log` + `runLog.event`」十余处手工双写，删除思考文本与工具失败的执行日志副本；`TaskRunLog.begin` 上移至 `msgId` 生成后，避免「收到任务」被文件存在守卫丢弃；中止统一由 `emitAborted` 双侧上报（修复仅落盘、界面无感知的问题）；工具进度（`ToolContext.log`）并入同一出口。**TracePhase** 追加 `'notice'`，`AgentTraceEvent` 追加可选 `notice?: string`，`TurnProcess` 以「告警/失败」行渲染（warn 色 / danger 色），失败判定纳入 notice。**工具摘要单源** 新增 `src/main/agent/loop/toolDigest.ts`（`buildArgsDigest` 1000 字符、`buildResultDigest` 输出 `{trace:160, log:800, chars}`），`trace` 与 `runLog.tool` 共用。**对话日志增量落盘** `RoundInput` 追加 `systemRef?` / `msgs?: {base, items}`（system 与上一轮相同则不重复落盘，`base` 之前消息沿用上一轮；追加/归档替换/快照替换统一由「最早分歧点」覆盖），`messages` 保留为旧格式只读兼容；`ConversationLog.read()` 顺序物化 `system` 与 `messages`（删除 `msgs`/`systemRef`），旧 `.jsonl` 与 `ConversationLogDialog` 展示形式不变；单任务文件由 O(轮次×消息数) 降为近似 O(消息总数)。**测试** 新增 `tests/log-scope.test.js`（infra 标记、任务事件不发 LogEntry、失败与中止双侧可见），`tests/conversation-log.test.js` 增加增量往返、落盘结构与新旧混合格式用例；既有 `log` 断言改为 `notice` trace 或对话日志行。渲染层 `lib/tools.ts` 过期注释（200 字符）同步订正

> - 2026-10-26 · U10 契约扩展（对话日志删除），用户指示：`src/shared/ipc.ts` 追加 `conversation:delete` / `conversation:clear` 通道与 `RoutineApi.conversationDelete(id)` / `conversationClear()`（preload 同步追加，通道字符串逐字一致）；`ConversationLog` 追加 `delete(id): boolean` / `clear(): number`（`TaskRunLog` 与 `NULL_LOG` 同步），`begin` / `read` / `delete` 与追加写入统一走 msgId 白名单 `/^[A-Za-z0-9_-]{1,128}$/` 防路径穿越，`clear()` 仅删除根目录 `*.jsonl`（保留非日志文件）并逐文件容错、返回实际删除数；渲染层 `ConversationLogDialog` 列表项新增悬浮删除图标（改用 `div[role=button]` 承载行以容纳内嵌按钮，保留 Enter/Space 打开），头部新增「清空全部」（空列表禁用），两者均经 `requestConfirm` danger 二次确认，删除当前选中项时同步清空详情区。既有 `conversation:list/get`、日志格式、`prune()` 策略与其余 IPC 不变

> - 2026-10-26 · U11 内置技能包替换（数据，非代码），用户指示：删除 `resources/skills/mysql`（PlanetScale 通用 MySQL 手册），改为 OpenOcta DB Ops Skills 的 6 个 MySQL 运维技能作为内置技能：`mysql-slow-query-diagnose` / `mysql-replication-lag-resolver` / `mysql-batch-health-check` / `mysql-capacity-early-warning` / `mysql-deadlock-analyzer` / `mysql-schema-linter`（Apache-2.0，许可副本 `resources/skills/LICENSE-openocta-db-ops-skills`；上游 `sql-duration-spike-detector` 与 `tidb-cluster-inspector` 未纳入）。内置根路径、`extraResources` 打包规则与 `skill.run/skill.read` 机制不变。`src/main/skills/loader.ts` 版本号解析放宽为 `metadata.version` 优先、顶层 `version` 回退（该技能包把版本写在顶层，原实现会显示为空）；`tests/skills.test.js` 内置资源断言同步更新

> - 2026-10-26 · U12 契约变更（决策轮输出预算与截断重试，依据 `Untitled-1.ini` 巡检日志复盘）：**根因** FC 决策轮未设 `maxTokens`，落到 `openaiCompat` 缺省 2048；推理模型的思维链与并行 tool_calls 共用该预算，第 3 轮 `completion=2048`、`content` 与 `tool_calls` 双空，任务从「读手册」直接跳到 digest 作答（6 维巡检只落地 3 项）。**预算** 新增 `src/main/agent/loop/limits.ts`（`DECISION_MAX_TOKENS=8192` / `TEXT_JSON_DECISION_MAX_TOKENS=4096`），`FunctionCallingStrategy.buildRequest` 与 `TextJsonStrategy.buildRequest` 显式下发。**截断重试** `AgentLoopStep.retry` 追加可选 `reason?: 'truncated' | 'parse'`；FC 策略空内容/全部调用被丢弃时返回 `retry`（原为 `answer/truncated` 直接降级），`FunctionCallingStrategy.commitStep` 补齐 `retry` 的 assistant + 纠正消息回灌（此前静默丢弃，重试等于原样再撞一次）；编排器 `retry` 分支新增 notice 告警（截断不再静默）。**半截参数** `openaiCompat` 在 `tool_calls` 流命中 `finish_reason=length` 或被提前关闭时标 `truncated`（原先强制改写为 `tool_calls` 且丢掉截断标记，半截 SQL 会被当完整参数执行），FC 策略对 `truncated` 下参数 JSON 不完整的调用一律不执行。**提示词** 双策略 RULES 新增「决策轮只用于调度工具，报告正文留给作答阶段」硬约束。**上下文** `compactContext` 增加两条与总预算无关的压缩：历史轮次的技能手册类结果（`skill.run` 概览 / `skill.read` 章节，按内容形状识别）压到 1200 字符保留头部；完全相同的工具结果（≥400 字符）只留最新一份（作答摘要仍逐条保留，不受影响）。**清单收尾** `TaskTodoStatus` 追加 `'cancelled'`（`todo.ts` 的 `VALID_STATUSES` 与文本协议工具签名同步），新增 `finalizeSessionTodos(sessionId)`：任务结束时把未完成项置 `cancelled`（不谎报 `completed`），编排器据此发 `todo` 快照 + warn（含「无任何成功工具调用落地」判定）。旧 `.jsonl` 日志与既有工具入参兼容

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

`Orchestrator.handleUserMessage(sessionId, text, emit)` 通过 `emit(OrchestratorEvent)` 推送四类事件（定义于 `src/main/agent/orchestrator.ts`）。主 Agent 采用统一 JSON 协议驱动子工具，与 LLM 供应商无关。工具白名单：`file.search` / `file.read` / `computer.info` / `computer.exec` / `search.web` / `browser.run` / `ssh.hosts` / `ssh.exec`；风险分级见 `ToolDefinition.risk` 与 `riskFloor`（`ssh.exec` / `db.exec` 固定 medium 且为不可降级底线，执行前必须经 UI 确认）。

### 决策/作答分层（v0.5.2 批准 2026-10-26）

- **决策轮**只输出轻量 JSON：`{"thought":...,"action":{"tool","args"},"done":false}` 或 `{"action":null,"done":true}`；需要同轮多调用时用 `{"actions":[{tool,args},...]}`（与 `action` 二选一，自动合并去重）；`final` 字段仅保留作简短回答的兼容写法。
- **作答阶段**由编排器独立发起（`answerSystemPrompt()`，无 tools、无 jsonMode、纯文本流式），最终报告不再作为 JSON 字符串字段传输；`AgentLoopStep` 新增 `answer` 变体（`reason: done | truncated | budget`）。
- **作答分段续写**：单段上限取 `Settings.agent.answerMaxTokens`（缺省 4096）；命中 `truncated` 时自动续写（最多 3 段，续写请求带已输出正文 + 「紧接上文」指令，并裁掉重复开头）；仍被截断时在正文追加「后续内容未完成，回复继续」提示，禁止静默丢弃。
- **作答输入完整性**：作答阶段使用的是决策阶段**全部**工具结果的逐条清单（序号 + 关键参数 + 结果，不做同文案去重），预算 48k 字符；0 行结果必须带 `sql`。
- **截断语义**：`LLMResponse.truncated` 表示上游流提前关闭或命中输出上限；`finishReason` 此时为 `incomplete`。未闭合 JSON 由 `salvageJsonObject` 抢救，不得整份丢弃。
- **一致性守卫**：任务已有成功工具结果时，最终回答出现「未采集到任何数据 / 未实际执行 / 无法计算」等零产出声明（不受 300 字符阈值限制）会触发一次性重写；旧版兜底话术 `抱歉，我暂时无法完成这个任务。` 不再写入会话历史、也不再回灌给模型。
- **日志**：`final` 行新增可选 `answeredBy: 'decision'|'answer'|'digest'` 与 `degraded: boolean`；`round` 行新增可选 `truncated: boolean`；`tool` 行记录每次工具调用（参数脱敏、结果截断）；`safety` 行记录审批结论、决策耗时与审批内容原文。均为增量字段，旧日志读取不受影响。
- **收敛**：最后一轮不再执行工具调用（其观测无法被任何决策轮消费，且会触发确认弹窗），记 warn 后进入作答阶段；收敛提示提前一轮发出。
- **参数校验**：执行前按工具 `inputSchema` 做结构校验（必填 / 对象-数组形状 / 枚举，深度≤2），错误信息带字段路径；整轮参数全非法时原地重试，不消耗规划轮次。
- **数值溯源守卫**：最终回答中的数值必须能在任务原文或成功的工具结果中找到出处，无法溯源时触发一次性重写；重写后仍不通过只记 warn 放行。

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

# 设计审查修复计划（R1 结构 + R2 运行时合并）

> 2026-10-24 · 编排者起草。来源：两轮外部设计审查（R1 模块结构与工程化、R2 运行时/一致性/扩展点），编排者已逐条对照代码核实——R1 约 95% 属实（CSP 误报、npm test 误判各 1），R2 约 97% 属实（risk 必填子句 1 处失实），其中 **R2-P0「FC 模式兜底丢工具结果」确认为真实功能缺陷**。本计划合并两轮有效发现，按「先修真实缺陷 → 机械化保证 → 结构收敛 → 工程化」排序。
>
> 状态：已批准（2026-10-24）。决策：1a 并发固定 1 废弃配置项；2 safeStorage 凭据先行（SSH/DB 密码 + 站点凭据）；3 签名不做；4 会话拆分按触发条件延后；5 引入 eslint（recommended 档）。**B0–B7 已全部落地**（typecheck 0 错误 / 79 测试全过 / build 通过 / lint 0 违规）；遗留真机项：托盘/通知权限走查、本地 Ollama 提示词回归（B4 目录未动，无此项风险）。

## 0. 范围与原则

- 每个修复动作必须附带回归测试（两轮审查的共同根因是"约定没有被机械执行"——修复本身也要被机械执行）
- FROZEN 契约（shared/types.ts、shared/ipc.ts、index.ts）变更最小化；能落 CONTRACTS 记录/约定前缀的不动类型
- 存储哲学不变：配置与状态 JSON、观测数据 SQLite
- 两轮审查均已核实的根因定性：**核心抽象设计水准高，缺陷来自"设计没有被机械地执行"与"运行态数据放错了地方"**——修复优先补机器可验证的约束，而不是继续加抽象

## 1. 批次总览

| 批 | 内容 | 来源 | 契约影响 | 规模 |
|----|------|------|----------|------|
| B0 | FC 兜底丢工具结果（热修） | R2-1 | 无 | XS |
| B1 | 并发模型拍板 + 调度器语义修复 | R2-5/2 | CONTRACTS 记录语义 | S |
| B2 | ChatService.runTurn + ipc 拆分 + 错误信封 | R2-6/8、R1-P1-2 | 前缀约定记录 | M |
| B3 | 契约机械化（通道一致性单测 + 事件类型化 + 入参守卫） | R1-P0-1/2 | shared/ipc.ts 追加（M3） | M |
| B4 | 双真相清理（死代码 classify、结构化能力探测） | R2-4、R1-P2-1 | 无 | S |
| B5 | 存储可靠性（损坏告警、去变异） | R2-7 | 无 | S |
| B6 | 渲染层一致性（解析下沉、表单 hook、样式去域名化） | R1-P1-3 | 无 | M |
| B7 | 工程化（lint/CI/sandbox/签名/safeStorage） | R1-三 | 记录 | M |

依赖：B0 独立立即；B1 待决策点 1；B3 独立可与 B0 并行；B2 依赖 B1（并发语义先定）；B4/B5/B6 独立；B7 并行。

## 2. 批次详情

### B0（热修）：FC 兜底丢工具结果

**缺陷**（已核实）：云模式 ReAct 轮次耗尽走兜底时，digest 从消息历史过滤 `role === 'user' && startsWith('工具结果:')`，而 FC 策略写入的是 `role: 'tool'`（functionCalling.ts L70-78）→ digest 恒空 → 最终回答对着「（无）」生成，全部工具结果丢弃。文本协议正常（textJson.ts L117-118 恰好匹配过滤器）。

**修复**：`runTask` 维护任务级 `taskObservations: { tool: string; ok: boolean; resultText: string }[]`，每轮把 `LoopObservation[]` 并入；兜底 digest 从该数组生成（每条一行 `工具名: 结果摘要`），删除消息反解析。策略只负责 LLM 消息编解码，运行态归编排器。

- 文件：orchestrator.ts（~20 行）
- 回归测试：react-loop 增一例——FC 模式步数耗尽 → 断言兜底请求的 messages 含非空工具结果摘要
- 契约：无

### B1（需决策点 1）：并发模型 + 调度器语义

已核实的事实：scheduler 允许 1–8 并发，orchestrator `busy` 单飞抛错（L320-321）→ 第二个任务被记 `ok=false` 并弹失败通知；`advance` 先于入队（失败不重试）；anytime 先写 `lastChecklistDate`（失败丢整天）；`maxConcurrent()` 每次 pump 读盘；无 `stop()`。

- 决策点 1 拍板后执行（推荐 a）：
  - **a（推荐）**：并发固定 1——`Settings.scheduler.maxConcurrent` 保留字段但钳制为 1、设置页标注废弃；CONTRACTS 记录语义变更（零类型变更）
  - b：AgentRun 池化多并发（依赖 B4 的去实例状态重构，工作量大，建议延后到 0.6.x）
- 失败重试显式化：调度任务失败 15 分钟后补跑一次（run 记录 `retried: true`），仍失败才终态；写入设置页文案
- `Scheduler.stop()` + will-quit 清理定时器；`maxConcurrent()` 收敛为 checkNow 读一次
- 回归测试：钳制/补跑/清理单测
- 契约：CONTRACTS 记录 maxConcurrent 语义变更与重试语义

### B2：ChatService.runTurn + ipc 拆分 + 错误信封

已核实：聊天路径（ChatSend）与定时路径（bindRunner）双份实现且持久化语义已分叉——失败回合留悬空 user 消息（历史出现连续 user）、定时失败留永久空会话；registerIpc 348 行 God function 且承载业务逻辑。

- 新 `src/main/services/chatService.ts`：`runTurn({ sessionId, text, source: 'chat' | 'scheduled' })` 统一负责——会话持久化（含失败清理：失败回合回滚悬空 user 消息或标记 failed；定时失败删除空会话）、标题截取、sink/事件桥接、完成通知
- registerIpc 拆 per-domain 注册函数（settings/chat/sessions/db/ssh/mcp/skill/memory/inspection/llm/todo）；组合根（getRegistry/getOrchestrator/getSkillRegistry）移至新 `src/main/composition.ts`，ipc.ts 退化为路由 + 组装
- 错误信封（轻量约定，不动类型）：错误消息前缀 `[CODE] message`（`[SCHEDULE_BUSY]` / `[DB_READONLY]` / `[INVALID]` / `[DENIED]`…），渲染层 notice 解析前缀分类展示
- 工具错误分型：`Observation = { ok, kind: 'denied'|'timeout'|'invalid-args'|'remote-error', resultText }`——denied（用户拒绝）不计数到连续失败钳制且提示词明确"换思路不重试"；timeout/remote-error 可重试；invalid-args 提示修正参数
- 回归测试：chatService 用例（失败清理/标题/空会话不残留）；既有 react-loop 全过
- 契约：前缀约定与 kind 写 CONTRACTS 记录；无类型变更

### B3：契约机械化

已核实：IPC 双表（shared 61 键 / preload CH 61 键）当前逐字一致但零自动化保证；sendToRenderer payload `unknown`；SettingsSet 直透零校验。

- `tests/channels.test.js`：源码扫描两表键集 + 通道值一致性断言（扫描 TS 源码而非 require 编译产物——preload 依赖 electron 无法在纯 node 下加载）
- `shared/ipc.ts` 追加 `EventPayloadMap`（chat:delta → ChatDeltaEvent 等全事件映射），`sendToRenderer` 改为按 map 类型化（冻结区追加式，M3 记录）
- 信任边界入参守卫：SettingsSet / McpSave / DbSave / SshSave 手写 assert 校验（不引入 zod，符合零依赖哲学），坏数据抛 `[INVALID]` 前缀错误而非静默写盘
- readJson 增强（与 B5 合并实施）：ENOENT → fallback；解析失败 → 改名 `.corrupt-<ts>` + warn + 通知，防坏文件被下次写入永久覆盖
- 回归测试：守卫单测 + 通道一致性即本测试
- 契约：M3 记录 EventPayloadMap 追加

### B4：双真相清理 + 结构化能力探测

已核实：`classify/baseClassify` 全库（src+tests）零调用方，为随工具演进腐化的死代码；`isToolsUnsupportedError` 依赖错误消息文本正则；`extractDecision`（browser.ts）与 `extractJson`（textJson.ts）双生。

- 删 `SafetyGate.classify/baseClassify`，仅保留 `effectiveRisk`（风险基线唯一来源 = ToolDefinition.risk）
- `OpenAICompatProvider` 抛错携带 `status`（自定义错误类），orchestrator 判 `err.status ∈ {400,404,422}` 取代消息正则
- 抽 `loop/parsePlan.ts` 供 textJson 与 browser 复用（browser 全面并入 AgentLoopStrategy 体系为长期项，不在本批）
- 提示词工具目录生成 `buildToolCatalog(registry)`：**两档实施**——保守档仅集中工具名为常量表；完整档由 name/description 生成 PLANNING_SYSTEM 目录段（⚠️ 本地小模型对提示词格式敏感，完整档需一轮真机回归，默认取保守档）
- 回归测试：react-loop 既有降级用例改断言 `err.status` 路径（mock provider 抛带 status 的错误）
- 契约：无

### B5：存储可靠性

- readJson 分类处理（已并入 B3）
- `saveTodos`：`[...runs].sort` 去除对调用方数组的原地变异
- 会话存储拆分（每会话文件 + 索引）：**决策点 4**——推荐延后，写明触发条件（会话数 > 200 或 sessions.json > 10MB 再迁）
- 回归测试：saveTodos 去变异断言

### B6：渲染层一致性

- `parseMcpJson` / `parseKeyValue` / `splitCommandLine`（约 100 行纯逻辑）下沉 `src/renderer/lib/mcpParse.ts`（单测挂载方式实现时确认：tsc include src，产物可 require）
- `useEntityForm` hook 收敛 4 组件的 FormState/EMPTY_FORM/toForm 复制
- CSS 去域名化：ssh-\* → 通用类（item-row/status-dot 等），机械重命名 SshSection + 3 个借用文件
- **不做**：Section 全面 Zustand 化（域隔离清晰、迁移纯 churn）
- 回归测试：mcpParse 纯函数单测

### B7：工程化（决策点 2/3/5）

- eslint（flat config + typescript-eslint）+ prettier + npm scripts `lint/format`；禁 `as any` 从契约口头约定变 lint 规则
- CI：GitHub Actions（ubuntu：npm ci → lint → typecheck → test → build，push/PR 触发）
- `sandbox: true` 显式声明（index.ts webPreferences 1 行；Electron 20+ 默认已沙箱，此为显式化）
- 渲染层 sourceMap 开启（排障用，体积代价小）
- 决策点 2：safeStorage 加密——建议范围：SSH/DB 密码与站点凭据先行（apiKey 第二步），`safeStorage.isEncryptionAvailable()` 回退明文 + 日志；代价：加密后备份不可移植到其他机器
- 决策点 3：签名证书（成本问题非代码）
- 契约：safeStorage 落地时 CONTRACTS 记录存储格式变更

## 3. 决策点（需拍板）

| # | 决策 | 选项 | 推荐 |
|---|------|------|------|
| 1 | 调度器并发 | a) 固定 1 + 废弃配置项；b) AgentRun 池化（0.6.x） | a |
| 2 | safeStorage 加密 | 范围（凭据先行/全部）与时机 | 凭据先行，B7 |
| 3 | 签名 | 购买证书与否 | 视分发需求 |
| 4 | 会话存储拆分 | 现在迁 / 触发条件后迁 | 触发条件后迁 |
| 5 | lint/CI 引入 | eslint+prettier+Actions | 引入 |

## 4. 明确不做 / 延后

- Section 全面 Zustand 化（域隔离清晰，迁移纯 churn）
- 会话迁 SQLite（触发条件未到）
- browser.ts 全面并入 AgentLoopStrategy（长期项，先做 extract 复用）
- zod 引入（手写守卫够用，避免新依赖）
- 审计日志列表/导出 UI（M2 遗留，随下次契约批次一并申报通道）

## 5. 验证与收口

- 每批收口标准：`npm run typecheck` 零错误 + `npm test` 全过（含该批新增回归测试）+ `npm run build` 通过
- B0 额外：react-loop 新增 FC 耗尽兜底断言
- B2 额外：真机走查双路径（手动对话 + 定时任务失败清理）
- B4 保守档额外：本地 Ollama 模式一轮真机回归（提示词变更敏感）
- 全部完成后 CONTRACTS.md 增补对应批次条目；两轮审查报告归档至 `.sisyphus/plans/`（本文件附录引用）

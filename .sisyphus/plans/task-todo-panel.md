# 任务子任务清单（Task Todo Panel）· 设计（T1）

> 2026-10-21 · 编排者起草。动机：右侧 Agent 卡片信息价值低；任务执行期需要 OpenCode 式 todo list，呈现子任务的 已完成/进行中/未开始 状态。

## 0. 方案取舍

| 方案 | 思路 | 结论 |
|------|------|------|
| **A. todo.write 工具（推荐）** | 把"维护子任务清单"暴露为一个 safe 工具，LLM 在复杂任务开始时写计划、每完成一步更新状态；全量快照事件推 UI | ✅ 语义由 LLM 掌控（与 OpenCode 同构）；双策略（FC/文本）天然通用；UI 只做快照渲染 |
| B. 响应内嵌 plan 字段 | 每轮 ReAct 输出强制携带计划 | ✗ 侵入两种协议、每轮全量重复、小模型下脆弱 |
| C. 编排器从工具调用序列自动推导 | 无 LLM 参与，按调用记录生成 checklist | ✗ 只是调用日志换皮，无"计划"语义，无法表达未做之事 |

## 1. 数据模型与事件（shared 契约追加）

```ts
// src/shared/types.ts 追加（命名避开既有定时任务 TodoTask）
export type TaskTodoStatus = 'pending' | 'in_progress' | 'completed';
export interface TaskTodoItem { content: string; status: TaskTodoStatus; }
export interface TodoUpdateEvent { sessionId: string; todos: TaskTodoItem[]; }
// src/shared/ipc.ts：事件通道 agent:todo + RoutineApi.onTodoUpdate（preload 同步追加）
```

事件为**全量快照**（不做 diff），渲染端整表替换，天然幂等。

## 2. 工具层：`todo.write`（tools/builtin/todo.ts）

- ToolDefinition：`agent: 'main'`、`risk: 'safe'`、`maxResultChars: 60`
- inputSchema：`{ todos: [{ content: string, status: 'pending'|'in_progress'|'completed' }] }`（1..20 项）
- execute：校验后 `ctx.emit({ type: 'todo', sessionId, todos })`，返回极短确认文本（如"已更新 5 项子任务"）——避免浪费上下文
- OrchestratorEvent 联合追加 `{ type: 'todo'; sessionId: string; todos: TaskTodoItem[] }`；`ipc.ts` 的 orchestratorEmit 映射到 `agent:todo` 通道

## 3. 提示词（双策略各加一条规则）

> 复杂任务（需多步/多工具完成）先调用 todo.write 制定子任务清单（全部 pending，首项 in_progress）；每完成一项立即更新（该项 completed、下一项 in_progress）；收尾前全部 completed。简单问题不需要 todo.write。

## 4. UI：右侧 AgentPanel 改造

- **移除 Agent 卡片区**（信息价值低，agent:status 事件保留在协议中不删）；保留底部日志面板
- 新增 `TaskTodoPanel`：标题"任务进度 n/m"，条目三态渲染——
  - `completed`：✓ + 置灰删除线
  - `in_progress`：▶ 高亮（进行中）
  - `pending`：○ 置灰
- 状态生命周期：`sendText` 时清空 → 执行期随事件更新 → **完成后保留至下一次发送**（无需持久化到会话存储；跨重启保留列为后续可选项）
- ChatView 的 TraceTimeline 过滤 `todo.write` 的 tool-start/end 条目（右侧已有专属面板，避免重复噪音）

## 5. 测试

- 工具层：合法更新发事件、越界/非法 status 拒绝、返回短文本
- 编排器层：FC 脚本 todo.write → 断言 todo 事件负载与工具回灌
- 回归：现有 45 项全绿

## 6. 范围外（记录不做）

- todo 跨会话持久化 / 历史回放（后续可选）
- 定时任务（TodoTask）执行视图复用（可后续把 runner 的 sink 接到同一面板）

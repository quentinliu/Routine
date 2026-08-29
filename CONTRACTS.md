# Routine 契约文档（FROZEN）

本文件定义三个并行功能代理共同遵守的契约。`src/shared/**` 为冻结区，任何修改须经编排者批准。

## 目录所有权

| 代理 | 可写目录/文件 | 职责 |
|------|--------------|------|
| A 核心代理 | `src/main/llm/**`, `src/main/agent/**`, `src/main/ipc.ts` | LLM 双模式路由、编排器、安全门、IPC 装配 |
| B 服务代理 | `src/main/services/**`, `src/main/util/**` | 文件索引/读取、系统控制、联网搜索、浏览器自动化 |
| C 界面代理 | `src/renderer/**`（不含 `global.d.ts`） | 对话界面、Agent 面板、设置页、安全确认弹窗 |

- `src/shared/types.ts` 与 `src/shared/ipc.ts`：冻结，只读。
- `src/main/index.ts`、`src/main/preload.ts`：冻结，只读（已定稿）。
- `src/main/services/storage.ts`、`src/main/util/shell.ts`、`src/main/util/paths.ts`：已完整实现，B 代理可直接使用；如需扩展请以追加方式修改并保持向后兼容。
- 服务单例导出（已定稿，B 实现时必须保留）：`getFileAgentService()` / `getComputerService()` / `getWebSearchService()` / `getBrowserAgentService()`，A 代理在 IPC 装配时使用。

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

事件（main→renderer，`sendToRenderer(channel, payload)`）：

| 通道 | 载荷 |
|------|------|
| `chat:delta` | `ChatDeltaEvent {sessionId, msgId, delta, done?}` |
| `chat:error` | `{sessionId, error}` |
| `agent:status` | `AgentStatus` |
| `safety:request` | `SafetyRequest` |
| `log:entry` | `LogEntry` |
| `index:progress` | `IndexProgress` |

## 编排器协议（A 代理实现）

`Orchestrator.handleUserMessage(sessionId, text, emit)` 通过 `emit(OrchestratorEvent)` 推送四类事件（定义于 `src/main/agent/orchestrator.ts`）。主 Agent 采用统一 JSON 协议驱动子工具，与 LLM 供应商无关。

## 系统操作白名单（B 代理实现，风险级别已冻结）

见 `src/main/services/computer.ts` 的 `COMPUTER_OPS`。`empty-trash`、`kill-app` 必须经安全门走 UI 确认；`toggle-dark-mode`、`set-brightness` 为 medium 建议同样确认。

## 环境事实

- Intel x86_64 macOS 15.7，Node v24，Electron 44，TS ~5.9（严格模式，禁 `as any`/`@ts-ignore`）
- 主进程为 CJS（tsc 编译），只能 require 兼容包；渲染层由 vite 打包，可用 ESM
- 无原生模块依赖；存储 = userData 目录下 JSON 文件
- 文件索引默认目录：`~/Desktop`, `~/Documents`, `~/Downloads`；`~` 展开用 `expandHome()`（util/paths.ts）

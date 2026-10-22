# Routine

Routine 是一个运行在 macOS 与 Windows 上的** AI 助手**桌面应用。它通过多个专职 Agent 帮你完成日常事务：文件检索、系统控制、联网搜索、浏览器自动化、SSH 远程运维、数据库诊断，支持 Skills 技能扩展与 MCP 外部工具接入，并可定时自动执行任务。

## ✨ 功能特性

### 🤖 多 Agent 编排
- **主 Agent**：ReAct 循环 + 任务清单（todo）推进，云端走原生 function calling、本地模型自动降级文本协议
- **文件 Agent**：本地文件索引与全文搜索（默认索引 `~/Desktop`、`~/Documents`、`~/Downloads`）
- **系统 Agent**：操作系统级控制（快照、音量、亮度、暗色模式等），基于白名单操作集
- **搜索 Agent**：联网搜索（必应免 Key 国内直连，Tavily 可选，自动回退链）
- **浏览器 Agent**：基于 Playwright 的浏览器自动化，可用自然语言下达指令
- **SSH Agent**：远程主机管理与命令执行（安全门确认）
- **数据库 Agent**：MySQL / PostgreSQL 只读诊断与（经确认的）管理操作，主进程强制只读 SQL 守卫

### 🧩 Skills 技能系统
- 遵循 **Agent Skills 开放标准**（SKILL.md），技能即数据、可独立于代码升级
- 内置 PlanetScale 开源 **MySQL / PostgreSQL 运维技能**（慢查询、索引、锁、连接、配置体检，含 40 篇 references）
- 统一管理界面：启停（按技能覆盖）、详情查看、**原生目录选择器**安装 / 删除用户技能
- 技能激活时自动注入 Routine 环境适配（SQL 走 db.query、写操作走安全门），开源技能零修改可用

### 🔌 MCP 外部工具
- 作为 MCP 客户端接入外部服务器：本地 stdio 子进程 / 远程 Streamable HTTP（自动回退旧版 SSE）
- 外部工具动态注册进 Agent 工具表，默认每次调用需确认，可按服务改为直接执行
- 设置页支持 **Claude Desktop / Cursor 的 mcpServers JSON 直接导入**与整行命令粘贴自动拆分

### ☁️ LLM 双模式
- **云端模式**：任意 OpenAI 兼容 API（默认配置为智谱 GLM）
- **本地模式**：Ollama 本地模型（默认 `qwen2.5:3b`），保护隐私、离线可用

### 🛡️ 安全门机制
- 操作按风险分级（safe / medium / high）：系统操作、SSH 远程命令、数据库写操作、MCP 工具调用
- `medium` / `high` 风险操作（如 `empty-trash`、`kill-app`、远程命令、KILL 会话）必须经 UI 弹窗确认后才会执行

### ⏰ 定时任务（Todo Scheduler）
- 支持 `daily` / `weekly` / `monthly` / `anytime` 四种循环类型
- 到点自动将任务指令交给 Agent 执行，并记录运行历史
- 错过时间点后 24 小时内自动补跑（catch-up）

### 💬 对话界面
- 多会话管理、Markdown 渲染（GFM）
- 实时流式输出、Agent 状态面板、运行日志
- 会话与设置持久化（userData 目录下 JSON 文件，无原生模块依赖）

## 🏗️ 技术栈

| 层 | 技术 |
|----|------|
| 框架 | Electron 44 + TypeScript 5.9（严格模式） |
| 渲染层 | React 19 + Vite + Zustand |
| 主进程 | tsc 编译为 CJS |
| 文件监听 | chokidar |
| 浏览器自动化 | playwright-core |
| 打包 | electron-builder（macOS dmg / zip：x64 + arm64，Windows nsis：x64 + arm64） |
| 技能格式 | Agent Skills 开放标准（SKILL.md），内置 PlanetScale database-skills（MIT） |

## 📁 项目结构

```
Routine/
├── src/
│   ├── main/              # Electron 主进程
│   │   ├── llm/           # LLM 路由（云端/本地双模式）
│   │   ├── agent/         # 编排器 + 安全门
│   │   ├── services/      # 文件索引、系统控制、搜索、浏览器、调度器、存储、数据库、MCP
│   │   ├── skills/        # Skills 加载器与注册表（Agent Skills 开放标准）
│   │   ├── util/          # 路径展开、shell 工具
│   │   ├── ipc.ts         # IPC 装配
│   │   ├── preload.ts     # 预加载脚本
│   │   └── index.ts       # 入口
│   ├── renderer/          # 渲染层（React UI）
│   │   ├── components/    # 聊天视图、任务面板、设置页（模型/数据库/SSH/Skills/MCP）、安全确认弹窗等
│   │   └── store.ts       # Zustand 状态管理
│   └── shared/            # 冻结的共享类型与 IPC 通道定义
├── resources/skills/      # 内置技能包（数据，随安装包分发）
├── scripts/               # 开发与工具脚本
├── tests/                 # node:test 单元测试
├── CONTRACTS.md           # 模块契约文档（目录所有权、IPC 协议、变更记录）
└── electron-builder.yml   # 打包配置
```

详细架构契约见 [CONTRACTS.md](./CONTRACTS.md)。

## 🚀 快速开始

### 环境要求

- macOS 15+（Intel / Apple Silicon）或 Windows 10+（x64 / ARM64）
- Node.js v24+
- （可选，本地模式）[Ollama](https://ollama.com/)

### 开发运行

```bash
# 安装依赖
npm install

# 开发模式（带热重载）
npm run dev

# 或直接启动
npm start
```

### 生产构建与打包

```bash
# 编译 + 打包 macOS 安装包（x64 + arm64，输出到 release/）
npm run package

# 编译 + 打包 Windows 安装包（x64 + arm64，可在 macOS 上交叉构建）
npm run package:win

# 一次打包全部平台
npm run package:all
```

产出 `release/` 目录下的安装包：macOS 为 `.dmg` 与 `.zip`（Intel 与 Apple Silicon 各一套），Windows 为 `.exe`（NSIS 安装程序）。

### 测试与检查

```bash
# 类型检查
npm run typecheck

# 单元测试（node:test，含技能加载器 / 只读 SQL 守卫 / 搜索回退链等）
npm test
```

## ⚙️ 配置说明

首次启动后进入 **设置页** 配置：

| 配置项 | 说明 |
|--------|------|
| LLM 模式 | `cloud`（云端）或 `local`（Ollama 本地） |
| 云端 API | baseURL / apiKey / model（任意 OpenAI 兼容接口） |
| Ollama | baseURL（默认 `http://localhost:11434`）/ model |
| 搜索源 | `auto`（默认，Tavily → 必应自动回退）、`bing`（免 key 国内直连）、`tavily`（需 API Key） |
| 数据库 | MySQL / PostgreSQL 连接（设置 → 数据库），供数据库 Agent 诊断使用 |
| SSH 主机 | 远程主机地址与凭据，供 SSH Agent 执行远程命令 |
| Skills | 技能启停（设置 → Skills），内置 MySQL/PostgreSQL 运维技能，可从文件夹安装用户技能 |
| MCP 服务 | 外部 MCP 服务器接入（设置 → MCP 服务），支持 mcpServers JSON 导入 |
| 索引目录 | 文件 Agent 扫描的目录列表，支持 `~` 展开 |
| 排除规则 | glob 模式，如 `node_modules/**`、`**/*.dmg` |

配置持久化在系统用户数据目录下的 JSON 文件中（macOS：`~/Library/Application Support/Routine/`，Windows：`%APPDATA%\Routine\`）。

## 📡 IPC 架构

渲染层与主进程通过类型安全的 IPC 通道通信（定义在 `src/shared/ipc.ts`）：

- **invoke**（渲染层 → 主进程）：`chat:send`、`file:search`、`computer:exec`、`search:web`、`browser:run`、`ssh:exec`、`db:test`（数据源管理）、`mcp:list`（MCP 服务管理）、`skill:list`（技能管理）等
- **事件**（主进程 → 渲染层）：`chat:delta`（流式输出）、`agent:status`（Agent 状态）、`agent:trace`（执行轨迹）、`agent:todo`（任务清单）、`safety:request`（安全确认）、`index:progress`（索引进度）等

## 📄 License

Apache License 2.0

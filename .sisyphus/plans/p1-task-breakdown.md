# P1 实施任务拆解 · 数据库巡检

> 依据：`.sisyphus/plans/db-inspection-architecture.md`（已评审修订版）+ CONTRACTS.md P1 批准
> 状态：待执行
> 验收基线：每任务 typecheck 通过；全程禁 `as any`/`@ts-ignore`
>
> **⚡ 状态更新（2026-10-22）**：连接层（adapter/mysql/postgres/connection）、数据源存储与管理 UI、六个 IPC 通道接线已随 S1 提交（b46f8e6）完成；本拆解中「检查项注册表 / checks.mysql / checks.pg / inspector 完整实现 / 报告视图」仍待执行，且巡检深化职责已部分转移至内置 Skills（见 db-inspection 规划状态更新），执行前建议先按现状重新圈定范围。

## 依赖关系（DAG）

```
T0 契约补丁(preload 条款) ─┐
T1 冻结区类型+通道 ────────┼→ T4 DB基础设施 → T5 MySQL检查项 ┐
T2 存储层扩展(并行) ───────┤                → T6 PG检查项(并行) ├→ T7 Inspector → T8 IPC装配 ∥ T9 preload追加 → T10 渲染层 → T11 收尾
T3 安装 mysql2+pg(并行) ───┘                                    ┘
```

关键路径：T0 → T1 → T4 → T5 → T7 → T8 → T10 → T11

## 任务卡

### T0 · 契约补丁（阻塞项，需编排者批准）
- **内容**：CONTRACTS.md 将 `src/main/preload.ts` 从「冻结，只读（已定稿）」改为比照 storage.ts 的「追加式扩展（新增通道须追加 CH 表与 api 方法，保持向后兼容）」
- **原因**：preload 硬编码全部通道，新通道必须追加暴露，现状条款与 P1 批准的 IPC 表自相矛盾
- **验收**：变更记录追加一行

### T1 · 冻结区类型与通道（域：冻结区，契约已批准）
- **文件**：`src/shared/types.ts`、`src/shared/ipc.ts`
- **内容**：
  - types: `DatasourceConfig`（id/name/type/host/port/user/password/database?/ssl?/enabled/timeoutMs?/thresholds?）、`DbDialect`、`DbTestResult {ok, version, latencyMs}`、`CheckResult`（含 `metrics?: Record<string, number>`）、`InspectionReport`、`InspectionProgressEvent {reportId, checkId, status}`
  - ipc: `IPC` 常量追加 6 invoke + 1 event；`RoutineApi` 追加对应方法（dbList/dbSave/dbDelete/dbTest/inspectionRun/inspectionReports/onInspectionProgress）
- **验收**：typecheck 通过；IPC 常量与 CONTRACTS.md 通道表逐行一致
- **依赖**：T0

### T2 · 存储层扩展（域：B）
- **文件**：`src/main/services/storage.ts`（追加式，契约允许）
- **内容**：`DATASOURCES_FILE='datasources.json'`、`INSPECTIONS_FILE='inspections.json'`；`loadDatasources()/saveDatasources()/loadInspections()/appendInspectionReport()`（**每数据源保留最近 200 条**，原子写沿用 writeJson）
- **验收**：round-trip 单测（写→读→裁剪顺序按 startedAt 降序）
- **依赖**：无（与 T1 并行）

### T3 · 依赖安装（域：B）
- **内容**：`npm install mysql2 pg`（production 依赖，纯 JS）
- **验收**：`node -e "require('mysql2/promise');require('pg')"` 在主进程 CJS 下成功
- **依赖**：无

### T4 · DB 基础设施（域：B，`src/main/services/db/`）
- **文件**：`adapter.ts`（`DbAdapter` + `CheckContext` 接口）、`connection.ts`（`createAdapter(ds)` 工厂）、`mysql.ts`、`postgres.ts`
- **内容**：
  - 适配器：`serverVersion()/query<T>()/ping()/destroy()`；query 内置 statement timeout（mysql2 `timeout` 项 / pg `statement_timeout` 连接参数）
  - connect timeout（默认 ds.timeoutMs ?? 10s）；`destroy()` 幂等
  - 版本归一化：MySQL `8.0.34` → `[8,0]`，PG `15.2` → `[15]`，供 minVersion 数值比较
- **验收**：连本地/远程实例手测 `ping/serverVersion/超时路径`；不可达时错误信息含主机与原因
- **依赖**：T1、T3

### T5 · 检查项注册表 + MySQL 检查项（域：B）
- **文件**：`registry.ts`、`checks.mysql.ts`
- **内容**：
  - `CheckRegistry`：按 dialect 过滤、`minVersion` 数值比较、有状态检查标记（基线取该数据源最近报告同 checkId）
  - MySQL 8 项：连通性版本 / 连接数使用率 / Threads_running / 慢查询速率（**有状态，首跑 skipped**）/ 主从延迟（8.0.22+ 用 `SHOW REPLICA STATUS`，否则 `SHOW SLAVE STATUS`）/ InnoDB 缓冲池命中率 / 锁等待（performance_schema，5.7+）/ 表空间占用（information_schema，加 LIMIT）
  - 每项输出 status/value/metrics/detail，阈值默认值集中于 registry
- **验收**：fixture 单测——模拟 query 返回与版本号，断言 ok/warn/error/skipped 各分支（含无基线首跑）
- **依赖**：T4

### T6 · PG 检查项（域：B，与 T5 并行）
- **文件**：`checks.pg.ts`
- **内容**：9 项：连通性版本 / 连接数使用率 / 长事务（>1h）/ 锁阻塞 / 复制延迟（pg_stat_replication）/ 表膨胀（dead tuples 比例）/ 缓存命中率 / 无效索引 / autovacuum 健康；`pg_stat_statements` 类探测缺失即 skipped
- **验收**：同 T5 fixture 单测
- **依赖**：T4

### T7 · Inspector 编排服务（域：B）
- **文件**：`inspector.ts`（`getInspectorService()` 单例，契约已批准）
- **内容**：
  - `run(datasourceId, emitProgress)`：建 adapter → 逐项执行（单项 try/catch 降级 error）→ 聚合 `InspectionReport`（ok=无 error）→ `appendInspectionReport` 持久化 → **finally destroy()**
  - `testConnection(ds)`：ping + 版本 + 延迟
  - 防重入：`runningByDatasource: Set<string>`，执行中重复 run 抛错（契约注记）
  - 进度：每项开始/结束时 emitProgress
- **验收**：fake adapter 单测（含单项抛错不中断、destroy 必被调用）；集成手测
- **依赖**：T2、T5、T6

### T8 · IPC 装配（域：A）
- **文件**：`src/main/ipc.ts`
- **内容**：7 个 handler + `inspection:progress` 经 `sendToRenderer` 推送；输入校验（name/host 必填、type 枚举、port 1–65535、enabled 布尔）；delete 级联清理该数据源报告
- **验收**：契约 IPC 表逐行有 handler；typecheck
- **依赖**：T1、T2、T7

### T9 · preload 追加（域：冻结区，T0 批准后）
- **文件**：`src/main/preload.ts`（仅追加）
- **内容**：`CH` 表 + `api` 实现追加 7 个方法；通道字符串与 `shared/ipc.ts` 逐字一致（沙箱 preload 无法 require 共享常量，注释已注明）
- **验收**：渲染层 `window.api.dbList()` 直达主进程；typecheck
- **依赖**：T0、T1

### T10 · 渲染层（域：C）
- **文件**：`store.ts`（巡检 slice）、`App.tsx`（订阅 `onInspectionProgress` + 挂载视图）、`Sidebar.tsx`（导航项）、新组件 `DbInspectionView.tsx` + `DatasourceDialog.tsx`
- **内容**：
  - store：datasources/reports/activeReport/inspecting 状态 + loadAll/save/delete/test/run 动作
  - 视图：左侧数据源列表（状态点、测试连接、编辑、删除）+ 右侧报告列表（时间、状态计数）→ 详情（检查项表格：状态灯/当前值/阈值/建议/耗时）；巡检中逐项进度显示
  - 样式沿用现有 app-shell/组件类名风格
- **验收**：手测 E2E——新增数据源 → 测试连接 → 立即巡检 → 查看报告（含 skipped/error 分支展示）
- **依赖**：T1、T9

### T11 · 收尾验证
- **内容**：`npm run typecheck && npm run compile:main && npm run build && npm run package` 全绿；README「配置说明」追加数据库巡检一节（含只读账号建议）
- **依赖**：全部

## 执行波次（并行度最大化）

| 波次 | 任务 | 说明 |
|---|---|---|
| W1 | T0（批准）→ T1 ∥ T2 ∥ T3 | 冻结区与地基 |
| W2 | T4 | 适配器层 |
| W3 | T5 ∥ T6 | 两库检查项并行 |
| W4 | T7 → T8 ∥ T9 | 服务编排与装配 |
| W5 | T10 | UI |
| W6 | T11 | 全链路验证 |

## 风险与前置确认

1. ~~**T0 需即时批准**（preload 条款修订）~~ ✅ 已批准落盘（2026-08-31）
2. **测试环境（已确认）**：本机无 MySQL/PG 实例、无 docker。验收策略调整为：
   - T4：版本归一化纯函数单测 + 不可达主机手测（connect 超时路径、错误信息含主机与原因）；真实 query 路径待用户首次接入真实实例时验证，作为已知限制记录于 T11 的 README 注记
   - T5/T6：fixture fake-adapter 单测覆盖全部判定分支（检查项仅依赖 `CheckContext.adapter.query`，注入模拟返回）
   - T7：fake adapter 单测（单项抛错不中断、destroy 必调、防重入）
3. ~~mysql2/pg 的 TS 类型随包自带，无需 @types~~ **T4 实测修正**：mysql2 自带类型；`pg` 不自带，已补装 `@types/pg`（devDependency）。测试脚本为 `node --test tests/*.test.js`（目录参数在 Node 24 下解析异常，用 glob 展开）

# Implementation Plan: 技能目录冷启动全量 & 任务执行过程详情

**Branch**: `006-skill-catalog-and-task-detail` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/006-skill-catalog-and-task-detail/spec.md`

## Summary

两个相互独立、可分别交付的修复：

1. **技能冷启动缺项（US1）**：根因是技能按 preset 作用域分层、而作用域在「开过会话」后才懒挂载；旧实现只合并「当前活着的挂载」，冷进程为空 → 只剩全局层 24 条。改用宿主为冷读取提供的官方入口 `agentPresets.standingKeyFor(id)`（无会话也会 `ensureStanding` 建立/复用 standing 作用域）枚举每个可用 preset，再 `skills.list({scope})` 与全局层并集。
2. **任务执行详情（US2/US3）**：落定时持久化 runId/stopReason/diagnostic/输出摘要，并按 stopReason 正确收口（修掉「失败显示成功」）；新增经 `sessionQuery.observeSession` 的轨迹读取与时间线映射；任务标题打开详情弹层，展示冻结配置、attempts、工具/技能/MCP 调用时间线与失败诊断；底部支持「关联追问轮次」（同任务同配置起新 run、记新 attempt）。

## Technical Context

**Language/Version**: TypeScript（宿主半 tsconfig.host.json 可用 node + @deepseek-ai/*；客户端半 tsconfig.client.json 仅 `src/client` + `src/shared`，`types: []` 无 node 全局）。
**Primary Dependencies**: `@deepseek-ai/dsh-agent-presets`（`standingKeyFor`/`livePresetMounts`）、`@deepseek-ai/dsh-skill`、`@deepseek-ai/dsh-session-query`、`@deepseek-ai/dsh-subagent`、React 18（客户端）。
**Storage**: 插件数据目录 `board.json`（Principle VI，文件即真相）；attempt 扩展字段随之下盘。
**Testing**: vitest（`npm test`），跨宿主边界用结构类型桩 + vi.mock（对齐既有 `dsh-catalog-skills-scope.spec.ts`）。
**Target Platform**: DSH 宿主插件（web overlay + 宿主 HTTP 路由；headless 无 webServer 时路由不注册、插件仍加载）。
**Constraints**: 客户端半不得 import 宿主/node 模块；共享类型只放 `src/shared`；业务失败返回 200+`ok:false`；PAT 不涉及本特性。
**Scale/Scope**: 技能目录 ≤ 数百条；轨迹响应需对单工具 args/result 截断、对条目设上限。

## Constitution Check

- **I 证据优先**：所有宿主 API 均在 research.md 给 `文件:行号`；不臆造字段。`standingKeyFor`、`sessionQuery.observeSession`、SessionEvent 词表、SubagentResult 均已读源码核实。
- **VI 文件即真相**：runId/stopReason/diagnostic/output 写入 board.json 的 attempts，跨重启可读；新字段全部可选以兼容旧文件。
- **VII 验证先于完成**：新增/修改均配单测（冷启动技能回归、stopReason 收口、轨迹映射、看板 attempt 元数据）；跑 typecheck + test + build。
- **II/III/IV/V**：本特性不新增 TFS 写路径、不接触 PAT、不改标签语义，无冲突。
- 客户端/宿主边界：轨迹读取与追问经既有 HTTP 路由 + `guardedWebServer` 鉴权栅栏，不绕过。

## Project Structure

### Documentation（本特性）

```text
specs/006-skill-catalog-and-task-detail/
├── research.md   # 根因与宿主能力证据
├── spec.md       # US1/US2/US3 + FR/SC
├── plan.md       # 本文件
└── tasks.md      # 实施任务（/speckit.tasks）
```

### Source Code（变更）

```text
src/
├── shared/contracts.ts            # +TaskAttemptView/+attempts、TaskTrace*、FollowUp*、2 条路由、HostBridge 2 方法
├── host/
│   ├── dsh-catalog.ts             # US1：standingKeyFor 枚举 preset（冷安全），liveMounts 降级为补充
│   ├── api.ts                     # US2：落定捕获 runId/stopReason/diagnostic；+getTaskTrace/followUpTask；抽取共用执行器
│   ├── route.ts                   # +GET task-trace、POST task-follow-up 处理器与注册
│   ├── board-service.ts           # toTaskView 透 attempts；+bindRun/settleTask/followUp
│   ├── trace-mapper.ts            # 新：纯函数 SessionEvent[] → TaskTraceEntry[]（可单测，无宿主依赖）
│   └── task-trace.ts              # 新：TaskTraceService（sessionQuery.observeSession + mapper + 截断/降级）
├── core/board/
│   ├── task.ts                    # AttemptRecord +runId/stopReason/diagnostic/output/provider（可选）
│   └── board.ts                   # +attachRunId、finishTask 接收 meta、+followUpTask（显式重开 completed）
├── index.ts                       # 装配 TaskTraceService（ctx.get('sessionQuery',false)）并注入 api deps
└── client/
    ├── slots.tsx                  # HttpHostBridge +getTaskTrace/+followUpTask；向 TaskCenter 传回调
    └── components/
        ├── TaskCenter.tsx         # 标题可点击→打开详情弹层；渲染 TaskDetailDialog
        └── TaskDetailDialog.tsx   # 新：详情/时间线/失败诊断/追问，运行中轮询
tests/
├── dsh-catalog-skills-scope.spec.ts  # 改写：冷启动（mounts=[]）经 standingKeyFor 取到 89 条
├── task-trace-mapper.spec.ts         # 新：事件→时间线、callId 配对、错误、截断
├── board-attempt-meta.spec.ts        # 新：attachRunId/finishTask meta/followUp 重开/toTaskView
└── stop-reason.spec.ts               # 新（或并入 host-api）：5 种 stopReason → outcome 映射
```

## Design Details

### US1 技能冷启动（`dsh-catalog.ts#collectSkills`）

- 取 `agentPresets`（`host.get('agentPresets')`，结构类型声明 `list(): Promise<PresetRow[]>` 与 `standingKeyFor(id?: string): Promise<string>`）。
- 对 `list()` 每行：`broken` 跳过；`try { const scope = await agentPresets.standingKeyFor(row.id); skills.list({scope}) } catch { 警告并继续 }`。
- 保留全局 `skills.list({})`；保留 `livePresetMounts()` 并集作为补充（覆盖不在 preset 清单的临时作用域），scope 去重。
- 合并键 `name`，全局优先；排序。冷启动且 standing 成功返回非全局技能时，不再发「仅含全局层」告警；仅当全局与所有 standing/live 作用域合计仍只有全局层时才告警。
- 结构类型避免对宿主 branded `ScopeKey` 的硬依赖（按 string 处理后传入）。

### US2 落定与持久化

- `AttemptRecord` 增加可选 `runId?/stopReason?/diagnostic?/output?/provider?`（旧 board.json 反序列化不受影响）。
- `Board`：
  - `attachRunId(taskId, runId, provider?)`：写到当前未闭合 attempt，bump revision。
  - `finishTask(..., note?, meta?)`：把 `meta` 的 stopReason/diagnostic/output/runId 写到闭合的 attempt。
  - `followUpTask(taskId)`：非 deleted 校验；completed 显式重开为 in_progress；execState=running；push 新 running attempt；bump。
- `BoardService`：`bindRun`、`settleTask(taskId, outcome, meta)`（成功 complete / 失败 failed），`toTaskView` 透出 `attempts: TaskAttemptView[]`。
- `api.ts` 落定改为消费 `run.result` 的解析值：
  - `completed` → settle success（output 摘要）；
  - 其余 → settle failed（diagnostic 缺省用 stopReason 文案）；reject → settle failed（error.message）。
  - 派发返回 runId 后立即 `bindRun`，使运行中也能按 runId 冷读轨迹。
  - 输出摘要：仅取 text 块拼接并截断（常量，如 2000 字）；diagnostic 宿主已限 4096 字节，原样存。

### US2 轨迹（trace-mapper + task-trace）

- `trace-mapper.ts` 纯函数 `mapTraceEvents(events): TaskTraceEntry[]`：
  - user/message、assistant/message → 文本条目（assistant 带 interrupted）；
  - tool/call → tool 条目（status running，记录 name/args 原文，截断）；
  - tool/result → 按 callId（结果块 id 或最近未闭合）配对，置 ok/error，取 error.reason 或结果文本；
  - turn/end 可记录结束原因；文本与 args/result 统一截断；条目数上限（如 400，超出保留首尾或尾部最近 N —— 取「最近 N + 标记截断」）。
- `task-trace.ts`：`getTrace(taskId, attemptIndex?)`：从 board 取 attempt.runId；无 runId → `available:false, reason`；有则 `sessionQuery.observeSession(runId,{projectionMode:'none'})` → mapper → dispose；`running = source==='live'`；服务缺失/会话不可读 → `available:false` + 原因，不抛 500。

### US3 追问

- `api.followUpTask({taskId, message})`：取 board task → 角色按 `roleAgent` 名解析、frozenConfig 取 task.frozenConfig、workspace/需求提示词同 dispatch 组装；前导段为「上一轮 output 或 diagnostic 摘要」，再接「【追问/补充指令】message」；`board.followUpTask` 开新 attempt → dispatcher.dispatch → bindRun + 落定（复用同一执行器）。deleted 拒绝；角色缺失/派发失败回传原因且不残留 running attempt（失败收口）。

### 路由 / 契约 / UI

- `TFS_ROUTES`：`taskTrace: GET /tfs-requirment/task-trace?taskId=&attempt=`、`taskFollowUp: POST /tfs-requirment/task-follow-up`（body `{taskId,message}`），均经 `guardedWebServer`。
- `HttpHostBridge` 增加两方法；`slots.tsx` 把 `onGetTaskTrace/onFollowUpTask` 传入 TaskCenter。
- `TaskCenter`：标题改为按钮（link 样式），本地 state `detailTaskId`，渲染 `TaskDetailDialog`；追问/落定后调 `onRefresh` 同步看板。
- `TaskDetailDialog`：复用既有 overlay/dialog 样式；attempt 切换、失败红框、输出框、时间线（MCP/技能/工具图标与标签，args/result `<details>` 折叠）、底部追问框；运行中每 ~2s 轮询当前 attempt 轨迹，结束（source=prepared 或 execState 终态）停止。

## Test Strategy

- 冷启动技能：`livePresetMounts=[]`，agentPresets.list 返回 standard、standingKeyFor 返回 scope、该 scope list 返回 89 → 断言 89 条且无「仅含全局层」；broken/抛错隔离；无 agentPresets 降级。
- 轨迹映射：合成事件覆盖 user/assistant/tool call/result 配对、isError、mcp__ 与 skill 名称、超长截断、条目上限。
- 看板：attachRunId、finishTask meta 落字段、completed 经 followUp 重开且历史保留、deleted 拒绝、toTaskView.attempts。
- stopReason：completed→success；error/refusal/max-tokens/aborted→failed（带 diagnostic）；reject→failed（错误消息）。
- 路由契约：参照 `host-route.spec.ts` 为两新端点补 method/参数校验与 200+ok:false 业务失败用例（尽量小而集中）。
- 门禁：`npm run typecheck`（两端）、`npm test`、`npm run build`。

## Risks / Mitigations

- `standingKeyFor` 会真实挂载 preset 组合（较重但单飞缓存、不启会话/回合）：仅在目录采集（懒加载/手动刷新）发生，失败逐项隔离；不在 apply 关键路径阻塞。
- 极旧宿主无 `standingKeyFor`：`typeof !== 'function'` 时回退 liveMounts + 全局并告警。
- continuable 同会话续聊本期不做（父会话非持久交互会话，无法在本环境验证）：以关联追问轮次交付真实可迭代对话，并在代码与 spec 标注后续可替换 transport。
- sessionQuery 缺失或会话冷读失败：详情降级为「配置 + attempts + 诊断」，不白屏。

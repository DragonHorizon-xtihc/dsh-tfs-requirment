---
description: "Task list for 006 skill catalog cold-start + task execution detail"
---

# Tasks: 技能目录冷启动全量 & 任务执行过程详情

**Input**: `specs/006-skill-catalog-and-task-detail/`（spec.md / plan.md / research.md）
**Tests**: 按项目宪法 Principle VII，测试一律必选；跨宿主边界用结构类型桩 + vi.mock。
**Organization**: 按用户故事分组（US1 / US2 / US3），每组可独立实现与验证。

## 约定

- 宿主半改 `src/host/**`、`src/core/**`、`src/index.ts`；客户端半只改 `src/client/**`；两端共享类型只进 `src/shared/contracts.ts`。
- 每完成一个代码任务即保证 `npm run typecheck` 通过；测试任务随对应故事一并完成。

---

## US1 — 冷启动技能全量（P1）

- [x] **T1.1 [US1]** 修改 `src/host/dsh-catalog.ts`：
  - 在 `DshCatalogHost` 结构类型中声明 `agentPresets` 最小面：`list(): Promise<Array<{id:string;name?:string;broken?:unknown}>>`、`standingKeyFor(id?:string): Promise<unknown>`。
  - 重写 `collectSkills`：先全局 `skills.list({})`；再枚举 `agentPresets.list()` 的非 broken preset，逐个 `await standingKeyFor(id)` 取 scope 并 `skills.list({scope})`（逐项 try/catch，失败 push 含 preset id 的 warning）；`livePresetMounts()` 保留为补充来源；scope 去重；按 `name` 并集（全局优先）排序。
  - 仅当全局 + standing + live 合计仍只有全局层时才追加「仅含全局层」告警；standing 已取得非全局技能时不发该告警。
  - `standingKeyFor` 不是函数 / agentPresets 缺失 / `list()` 抛错时，回退旧路径（全局 + liveMounts）且不崩溃、给出可见 warning。
- [x] **T1.2 [P] [US1]** 改写 `tests/dsh-catalog-skills-scope.spec.ts`：
  - mock `@deepseek-ai/dsh-agent-presets` 同时提供 `livePresetMounts` 与（经 host 桩注入的）`agentPresets`。
  - 新增冷启动回归：`livePresetMounts()=[]`、`agentPresets.list()` 返回 standard、`standingKeyFor('standard')` 返回 scope、该 scope 的 `skills.list` 返回 89 条 → 断言 `catalog.skills.length===89`（全局 24 + standing 89 去重后并集）且 warnings 不含「仅含全局层」。
  - 保留并调整：全局+作用域并集/去重/全局优先；某 scope 抛错隔离；broken preset 跳过；无 agentPresets 或 standingKeyFor 非函数时降级且 warning 可见。
- [x] **T1.3 [US1]** `npx vitest run tests/dsh-catalog-skills-scope.spec.ts` 全绿（7 用例）。

## US2 — 执行落定、持久化与详情（P1）

- [x] **T2.1 [US2]** `src/shared/contracts.ts`：
  - 新增 `TaskAttemptView { startedAt; endedAt?; outcome; note?; runId?; stopReason?; diagnostic?; output? }`；`BoardTaskView` 增加 `attempts: TaskAttemptView[]`（保留 attemptCount/lastNote）。
  - 新增时间线类型：`TaskTraceEntry`（判别联合 user/assistant/tool/turn，tool 含 callId/name/args/status/result?/error?/durationMs?/turn/step）、`TaskTraceResult { ok; runId?; available; running?; source?; cursor?; truncated?; total?; entries; reason? }`。
  - 新增 `FollowUpTaskInput { taskId; message }`、`FollowUpTaskResult { ok; runId?; attempt?; task?; reason? }`。
  - `TFS_ROUTES` 增 `taskTrace:'/tfs-requirment/task-trace'`、`taskFollowUp:'/tfs-requirment/task-follow-up'`；`HostBridge` 增 `getTaskTrace`、`followUpTask`。
- [x] **T2.2 [US2]** `src/core/board/task.ts`：`AttemptRecord` 增可选 `runId?/stopReason?/diagnostic?/output?/provider?`（全部可选，兼容旧 board.json）。
- [x] **T2.3 [US2]** `src/core/board/board.ts`：
  - 新增 `attachRunId(taskId, runId, provider?)`：写入当前未闭合 attempt 并 bump。
  - 扩展 `finishTask(...)` 增加可选 `meta?: {runId?;stopReason?;diagnostic?;output?}`，落到闭合 attempt。
  - 新增 `followUpTask(taskId)`：deleted 拒绝；completed 显式重开为 in_progress；execState='running'；push 新 running attempt；bump（保留历史 attempts）。
- [x] **T2.4 [P] [US2]** 新增 `tests/board-attempt-meta.spec.ts`（7 用例）：attachRunId 落 runId；finishTask meta 落 stopReason/diagnostic/output；followUpTask 把 completed 重开为 in_progress 且历史 attempt 不丢；deleted 拒绝；非法状态仍报错。
- [x] **T2.5 [US2]** `src/host/board-service.ts`：
  - 新增 `bindRun(taskId, runId, provider?)`、`settleTask(taskId, outcome, meta?)`、`openFollowUp(taskId)`（try/catch + persist）。
  - `toTaskView` 透出 `attempts: TaskAttemptView[]`（映射全部字段；旧记录缺字段安全）。
- [x] **T2.6 [US2]** 新增 `src/host/trace-mapper.ts`（纯函数、无宿主 import）：
  - `mapTraceEvents(events)`：user/assistant 文本提取；tool/call→running 条目；tool/result 按 callId 配对置 ok/error 并算 durationMs；mcp__/skill 名称分类；args/result/文本统一截断（导出 `MAX_*` 常量）；条目数上限保留最近 N 并带 truncated/total。防御式提取。
- [x] **T2.7 [P] [US2]** 新增 `tests/task-trace-mapper.spec.ts`（9 用例）：顺序、callId 配对、isError + error.reason、mcp__/skill 标签、超长截断、上限、未知形态不抛错。
- [x] **T2.8 [US2]** 新增 `src/host/task-trace.ts`：`TaskTraceService`，构造注入 `getSessionQuery()` 与 `board`；`getTrace(taskId, attemptIndex?)`：无 runId/服务缺失/会话不可读/未知任务 → 200 体 `available:false`+可读 reason（不抛、不 500）；`observeSession(runId,{projectionMode:'none'})`→mapper→dispose；`running=source==='live'`。
- [x] **T2.9 [US2]** `src/host/api.ts`：
  - 抽出共用闭包 `launchRun(...)`（组装后的 prompt/role/frozenConfig/taskId）：`start→dispatcher.dispatch→bindRun(runId)→run.result 落定`，dispatch 与 followUp 共用。
  - 落定消费解析值：纯函数 `mapStopReasonToOutcome`（仅 completed→success；error/refusal/max-tokens/aborted→failed）、`stopReasonNote`（中文兜底）、`extractOutputText`（text 块 + 截断）；resolved 按 stopReason settle（failed 带 `diagnostic ?? note` + output）；rejected settle failed（infrastructure-error，error.message）；dispatch 启动抛错 settle failed（dispatch-failed），不留 running 悬挂。
  - deps 增加可选 `trace?: TaskTraceService`；实现 `getTaskTrace` 委托（缺服务降级 available:false）。
- [x] **T2.10 [P] [US2]** 新增 `tests/stop-reason.spec.ts`（3 用例，5 种 stopReason + reject 映射/诊断来源/输出摘要）与 `tests/host-api-task-run.spec.ts`（10 用例，派发收口 + 追问集成，可控 FakeDispatcher 手动 resolve/reject）。
- [x] **T2.11 [US2]** `src/host/route.ts`：新增 `createTaskTraceHandler`（GET，解析 query `taskId`/`attempt`，缺 taskId/非法 attempt→400）、`createTaskFollowUpHandler`（POST JSON `{taskId,message}`，校验非空字符串，否则 400）；在 `registerTfsRoutes` 用 `ctx.effect` + `web.register` exact 注册两条（业务不可用走 200 + available:false/ok:false）。
- [x] **T2.12 [P] [US2]** `tests/host-route.spec.ts` 补两路由契约（GET 200/缺 taskId 400/attempt 校验/405；POST 200/缺字段 400/405），fake api 补两方法桩。
- [x] **T2.13 [US2]** `src/index.ts`：用 `ctx.get('sessionQuery', false)` 惰性构造 `TaskTraceService` 并注入 `createHostApi` deps（boardService 缺失时不构造）。
- [x] **T2.14 [US2]** 新增 `src/client/components/TaskDetailDialog.tsx`：
  - props：`task`、`onClose`、`onGetTrace`、`onFollowUp`、`onFollowedUp`。
  - 渲染：标题/ID/状态、冻结配置（模型/技能数/MCP/角色/工作目录）、attempt 切换圆点（配色 running/success/failed/cancelled）、失败诊断红框（stopReason+diagnostic??note）、最终输出 `<details>`、时间线（turn 分隔、user 右蓝泡、assistant 左灰泡、tool 卡片 MCP/技能/工具徽章 + ok/error/running + 耗时 + args/result `<details>` + error 红 pre）、无 runId/不可用提示。
  - 数据：挂载与切换 attempt 拉取；运行中每 2s 轮询，终态停止；卸载 clearInterval。
- [x] **T2.15 [US2]** `src/client/components/TaskCenter.tsx`：标题改为蓝色虚下划线按钮（仅 onGetTaskTrace 存在时，可键盘聚焦）；state 存 `detailTaskId`（快照刷新后 derive task 对象）；页面末尾在 TaskEditDialog 之后渲染 `TaskDetailDialog`；关闭清空。
- [x] **T2.16 [US2]** `src/client/slots.tsx`：`HttpHostBridge` 实现 `getTaskTrace`（GET 拼 URLSearchParams，catch 降级 available:false）、`followUpTask`（postJson）；`<TaskCenter>` 传 `onGetTaskTrace`/`onFollowUpTask`（后者 await 后 reloadBoard）。
- [x] **T2.17 [US2]** `npm run typecheck` 三端（host/client/tests）通过。

## US3 — 详情页二次对话（关联追问轮次）（P2）

- [x] **T3.1 [US3]** `board.ts` + `board-service.ts`：`Board.followUpTask`（T2.3）经 `BoardService.openFollowUp(taskId)` 包装（persist），返回 `{ok,task,attempt}`。
- [x] **T3.2 [US3]** `src/host/api.ts`：实现 `followUpTask({taskId,message})`：空消息/任务不存在/deleted/角色缺失或无 provider → `ok:false`；取 task.frozenConfig/role/workspace/需求提示词；`openFollowUp` 后复用 `launchRun` 起新 run；prompt = 工作目录段 + 需求提示词 + 任务背景 + 【上一轮 outcome/stopReason/diagnostic/output】+ 【追问】；收口失败由 launchRun 统一 settle，不留 running 悬挂。
- [x] **T3.3 [P] [US3]** `tests/host-api-task-run.spec.ts` 覆盖：失败/完成任务追问 → 新 running attempt、dispatcher 收到含上轮诊断+追问的 prompt 与同一 frozenConfig、返回新 runId/attempt；空消息/deleted/角色缺失拒绝且无半截 attempt；无 trace 服务降级。
- [x] **T3.4 [US3]** `TaskDetailDialog.tsx`：底部追问 textarea + 发送（deleted 禁用并说明）；成功后 setSelected(最新 attempt)、立即 loadTrace + 轮询、onFollowedUp 刷新看板；发送中禁用与错误提示。
- [x] **T3.5 [US3]** `slots.tsx`/`TaskCenter.tsx` 追问回调与 reloadBoard 刷新接线（随 T2.16 一并完成，client typecheck + build 通过）。

## 收尾验证（全故事）

- [x] **T4.1** `npm run typecheck` 通过（host + client + tests 三段 tsc 全绿）。
- [x] **T4.2** `npm test` 全量通过：**43 文件 / 671 用例全绿，无跳过**。旧夹具按新语义更新——`host-api.spec.ts`、`edit-capability.spec.ts` 的 boardStub 补 bindRun/settleTask/openFollowUp 桩；`e2e.spec.ts` 的 FakeRun.resolve 默认 resolve `{output:[],stopReason:'completed'}`（旧的 resolve undefined 会被新收口判为失败，正是被旧夹具掩盖的"失败显示成功"缺陷的镜像）。
- [x] **T4.3** `npm run build` 通过（宿主 tsc + 客户端 React bundle，client.js 300.87 kB）。
- [x] **T4.4** 构建产物自查：`lib/client.js` 含 `task-trace`/`task-follow-up`/详情弹层文案/追问/失败诊断/stopReason；`lib/types/host/dsh-catalog.js` 含 `standingKeyFor`/`livePresetMounts`/`agentPresets` 冷枚举。**未实跑项（无法连真实 dsh/TFS）**：TaskDetailDialog 的 2s 轮询/追问交互仅过 client typecheck + bundle 验证（项目客户端半无 DOM 测试手段），未在真实界面点验；TaskTraceService 对真实 sessionQuery 的冷读/活读用结构类型桩验证，真实宿主行为以 research.md 引用的 .d.ts 为准。

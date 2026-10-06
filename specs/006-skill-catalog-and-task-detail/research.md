# Research：技能目录冷启动缺项 & 任务执行过程不可见

**Feature**: 006-skill-catalog-and-task-detail
**Date**: 2026-09-21
**方法**：仅采用三类证据——本地宿主源码（给 `文件:行号`）、插件源码、既有测试。未实跑联网调用。

---

## 一、问题 1：技能下拉为什么只有 24 个（三轮未修复的根因）

### 1.1 技能注册表是「按作用域分层」的

- 宿主技能服务 `packages/skill/skill/src/index.ts`
  - `list(options = {})`（约 `:470`）：**不传 `scope` 时只读全局层**。
  - 合并顺序（约 `:556`）：`layers = [global, ...chainLayers(scope)]`。
  - 结论：`skills.list({})` 永远只能拿到「全局层」的 provider。本机全局层只有内置（bundled）技能，实测 23~24 条、`source` 全为 `bundled`。

### 1.2 用户级技能根目录由 `skill-filesystem` 扫描，而它挂在 preset 作用域层

- `packages/skill/skill-filesystem/src/index.ts` 的 `roots(cwd)`（约 `:245-264`）：
  - 用户级根 `$DSH_HOME/skills`（source `user-dsh`）、`~/.agents/skills`（source `user-agents`）只要 provider 注册到被查询的层就会扫描，**与 cwd 无关**；
  - 项目根（`.dsh/skills`、`.agents/skills`）仅在 `cwd !== undefined` 时加入。
- 该 provider **没有挂在全局层**，而是挂在 standard agent preset 的 standing 作用域层：
  - `packages/preset/agent-presets/presets/standard/agent.cordis.yml:77-88`，注释明写
    “The skill REGISTRY lives in the host composition and is layered per scope: these rows register into THIS preset's layer”。

### 1.3 preset 作用域层是「懒挂载」的，冷进程不存在

- `packages/preset/agent-presets/src/mount.ts`
  - `mountPreset(agentCtx, preset)`（约 `:369-424`）只在「某个 agent 按该 preset 创建会话」时由 agent factory 的 setup 钩子调用；无 agent 作用域直接拒绝（约 `:370-376`）。
  - `livePresetMounts()`（约 `:173-177`）只返回**当前活着**的挂载；冷进程、没开过会话时为空数组。

### 1.4 现有修复为什么必然漏掉 65 个

- 插件 `src/host/dsh-catalog.ts` 的 `collectSkills`：全局 `skills.list({})` ∪ 对每个 `livePresetMounts()` 调 `skills.list({scope})`。
- 冷启动（执行配置场景恰恰发生在跑任务**之前**）`mounts.length === 0`，回退成全局层的 23~24 条。代码注释（`dsh-catalog.ts:273-297`）把这当成「请先开个会话再点重采」，对执行配置是伪修复。
- 既有测试 `tests/dsh-catalog-skills-scope.spec.ts`：
  - 89 条用例（`:97-108`）靠 **vi.mock 让 `livePresetMounts()` 返回挂载**才通过；
  - 真正的冷启动用例（`:121-129`，mounts=[]）只断言「给一条『仅含全局层』告警」，**把缺陷当成了预期行为锁定**。
- 客户端 `src/client/components/ExecutionPanel.tsx:138,339-347` 全量渲染 `skillOptions`（无 slice/limit，还显示「当前 N 项」），排除客户端截断。

### 1.5 正确的宿主能力（冷读取的官方入口）

- `packages/preset/agent-presets/src/index.ts`
  - `AgentPresets.standingKeyFor(id?)`（`:770-773`）：`resolveMountable(id)` → `ensureStanding(preset)`。
  - `ensureStanding`（`:798-822`）在**没有 agent / 会话 / 回合**的情况下 `createScope(selfCtx, { agentPreset: id })` 并 `mountPreset(scope.ctx, preset)`，单飞、进程内缓存（`:785-796`）。
  - 模块文档（`:13-14`）明确：“a host reader with no agent at all (a cold transcript read) resolves the same standing registrations by preset id”。
- 因此正确做法：枚举 `agentPresets.list()` 的每个可用 preset，调 `standingKeyFor(id)` 取得（必要时建立）其 standing scope，再 `skills.list({ scope: key })`，与全局层并集；`livePresetMounts()` 仅作补充。冷进程也能稳定拿到 `~/.agents/skills` 的 89+ 条。
- 备注：项目根技能（`.dsh/skills` 等）需要 `cwd`，属「按工作区」维度；本缺陷针对用户级 89 条，不需要 cwd，本期不展开项目根。

---

## 二、问题 2：任务执行过程为什么看不到、失败为什么不知道原因

### 2.1 现状（插件源码）

- 派发：`src/orchestration/dispatch.ts` 用 `ctx.subagents.start(name, request)` 起 **ONE-SHOT** 子 run；`SubagentRun.id` 即子会话 id，`run.result` 是最终结果。
- 落定：`src/host/api.ts:512-524`
  - `run.result.then(() => setTaskState('complete'), () => setTaskState('fail'))`；
  - **失败原因 `_e` 被直接丢弃**；`runId` 只在 dispatcher 内存 map 中，不写看板。
- 看板模型：`src/core/board/task.ts` 的 `AttemptRecord` 只有 `startedAt/endedAt/outcome/note`；`BoardTaskView`（`src/shared/contracts.ts:682-708`）只有 `attemptCount/lastNote`，**没有 runId、没有 stopReason、没有诊断、没有工具轨迹**。
- `src/host/board-service.ts:714-736` 的 `setTaskState` → `finishTask(...)` 失败收口不带 note；`:785-817` `toTaskView` 不透出 attempts 明细。

### 2.2 一个直接导致「失败显示成功」的 bug

- 宿主 `packages/subagent/subagent/lib/types/types.d.ts:305-312`：`run.result` 对**模型/传输失败是 resolve**（`stopReason: 'error' | 'refusal' | 'max-tokens' | 'aborted'`，带 `diagnostic`，`:256-282`），只有基础设施故障才 reject。
- 现代码 `.then(成功, 失败)` 把「resolve 但 stopReason=error」一律标成 **completed**——这正是「任务失败了却不知道、甚至显示成功」的直接来源。

### 2.3 执行过程数据从哪来（宿主能力）

- `packages/session-query/session-query/lib/types/index.d.ts`：`ctx.sessionQuery`
  - `observeSession(sessionId, {projectionMode})` → 一次性不可变快照 `SessionObservation`（`observation.d.ts:7-31`：`header`、`events: SessionEvent[]`、`cursor`、`source: 'live'|'prepared'`）；
  - 冷读 live 或已持久化会话，LRU 缓存；租约需 dispose。
- 事件词表 `@deepseek-ai/dsh-session` 的 `SessionEventMap`（`node_modules/@deepseek-ai/dsh-session/lib/types/types.d.ts:242-410`）：
  - `user/message`、`assistant/message`（含 `interrupted`）、
  - `tool/call` `{callId,name,arguments}`（`:333-339`）、`tool/result` `{message,error?}`（`:353-367`）、
  - `turn/start|end`、`step/start|end`。
  - 信封 `{type, seq, time(ms), data}`（`:466-473`）。
  - MCP 工具名形如 `mcp__<server>__<tool>`；技能经 skill 工具调用。足以渲染「技能 / MCP / 工具调用过程」。
- 轮询即可（快照语义），与插件既有轮询节奏一致，无需长连接。

### 2.4 能否直接复用 dsh 本地对话（结论：不能）

- 客户端是隔离 bundle，只经本插件 HTTP 路由与宿主通信（`src/client/slots.tsx` 的 `HttpHostBridge`，`:258` 起）。
- 注入面只有 `slots` 与 `layout`：`layout` 仅 `selectPanel(panelId|null)`（`dsh-client-ui-layout .../client/service.d.ts`），**没有「按 session id 打开主对话」的 API**；`dsh-client-store` 是通用快照状态工厂（zustand 类），不含会话导航。
- 主对话只渲染「当前活动的那一个交互会话」；ONE-SHOT 子会话不作为独立对话打开，且**没有 inbox、不能追发消息**（`types.d.ts:283-290, 305-317`）。
- 宿主自己的浏览器续聊面（`subagents.prompt`，`control-types.d.ts:86-103`）要求 `mode:'continuable'` 的持久子会话 + 可解析的持久父会话（`parentSessionId`，失败码 `subagent/parent-unavailable` / `subagent/not-resumable`）。本插件的父级是 `index.ts` 把根 ctx 强转的 Agent（`getParent: () => ctx as unknown as Agent`），不保证是持久交互会话，在不实跑验证下不能假设续聊可用。
- **结论**：在插件 overlay 内自建「任务执行详情」视图，数据源用 `sessionQuery` 按子会话 id 冷读/轮询。

### 2.5 二次对话的可行实现（v1）

- 真正同会话续聊需要 continuable 子会话 + 持久父会话，对根 ctx 后台派发路径风险高且本环境无法实跑验证。
- v1 采用**关联追问轮次**：详情页输入追问 → 起一条**同一任务的新 run**（同一角色 / frozenConfig / workspace / 需求提示词），prompt 带上「上一轮最终输出或诊断摘要 + 本次追问」，记为**一次新 attempt**（带新 runId，可独立看轨迹）。
  - 完全复用已验证的 ONE-SHOT 路径，无新生命周期假设；重启后 `sessionQuery` 仍可冷读已持久化日志；
  - 每次追问都是能看到上轮结果的真实迭代对话；
  - 代码把「续聊 transport」收敛在同一宿主方法后，未来可在能力探测通过后替换为 continuable，UI 不变（记为后续增强，不在本期宣称已支持）。

---

## 三、受影响文件（实现落点）

- 技能：`src/host/dsh-catalog.ts`；测试 `tests/dsh-catalog-skills-scope.spec.ts`。
- 看板模型：`src/core/board/task.ts`、`src/core/board/board.ts`、`src/host/board-service.ts`。
- 执行落定：`src/host/api.ts`、`src/index.ts`。
- 轨迹：新增 `src/host/trace-mapper.ts`（纯函数）、`src/host/task-trace.ts`（sessionQuery 读取）。
- 契约/路由：`src/shared/contracts.ts`、`src/host/route.ts`。
- UI：`src/client/slots.tsx`、新增 `src/client/components/TaskDetailDialog.tsx`、`src/client/components/TaskCenter.tsx`。
- 测试：trace-mapper、board attempt 元数据、冷启动技能回归。

# Implementation Plan: 任务中心主对话框 + 编排主 agent + 共享简报复用

**Branch**: `010-orchestrator-chat-shared-brief` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/010-orchestrator-chat-shared-brief/spec.md`

## Summary

三条改动线，共用一套需求级「编排上下文」（orchestration）：

1. **共享简报（US3 前半，最低风险、收益最直接）**：新增纯逻辑模块 `src/shared/brief.ts`，
   在需求级持久化 `RequirementBrief`（需求摘要 / 工作目录 / 已完成任务结论 / 产物清单 / 已绑定 MCP+技能）。
   任务 prompt 组装从「工作目录 → 需求提示词全文 → 任务正文」改为
   **「工作目录 → 共享简报 → 本任务增量 → 执行纪律」**；需求正文全文只在简报尚无 digest 时出现一次。
2. **编排主 agent（US1/US2）**：新增 `src/host/orchestrator-session.ts`，按需求
   `startContinuable` 一个持久编排子会话（childId 落 `board.json`）。任务 success 收口后
   `sendMessage` 给它做归纳 → 结论回写简报 → 放行下一任务；全部完成后 `sendMessage`
   「请出最终总结」→ 总结文案交给既有 `RequirementFinalizer` 作为结论评论，随后照旧更新状态/字段/上传产物。
   continuable 不可用或观测不到收口 → `mode:'off'` **fail-loud 降级**（面板给原因，链路不中断）。
3. **主对话框 UI（US1/US4）**：任务中心「进行中」页改左右分栏。右侧内嵌会话走
   **宿主官方路径**（父条目声明 `scope:'session'` 子槽 → 框架注入 `SessionProvider` →
   `sessions.retain()` 拿 `SessionReference` → `renderFactorySlot('conversation.content', …)`），
   与 `ui-subagent` 侧边对话同构。顶部切换条在主 agent 与子 agent 会话间切换。

## Technical Context

**Language/Version**: TypeScript。宿主半 `tsconfig.host.json`；客户端半 `tsconfig.client.json`
（只编译 `src/client` + `src/shared`，无 node 全局）；测试 `tsconfig.tests.json`（排除 `src/client`，无 jsx）。
**Primary Dependencies**: React 18、vitest。**不引入新依赖**，不 import 宿主客户端包
（客户端半只能 require `PLATFORM_MODULES`，见 research.md §二）。
**Storage**: `board.json`（需求级 `orchestration`、任务级 `orchestration`）JSON 权威，
字段全部可选，旧文件无需迁移（`Board.load` 是 verbatim 替换，`core/board/board.ts:116-118`）。
**Testing**: vitest 全量 + 三道 tsc + tsdown 构建。
**Constraints**:
- 客户端半拿不到 `SessionProvider` / `ui-conversation`，只能经槽位与工厂渲染（research.md §二）。
- 子槽键**只能被一个父条目声明**（`ui-slots/src/index.ts:1241-1245`）⇒ 只给 `main` 条目声明
  `tfs.orchestrator.chat`；右栏 `SidePanel` 复用同一组件但走独立键（本期不做）。
- `sessions.retain()` 必须**调用时**解析 `ctx.get('sessions')`，禁止 apply 期闭包捕获（项目纪律 6）。
- continuable 子**没有** per-message result（`run-settlement.ts:5`）⇒ 用
  `ctx.on('subagent/end')`（`info.id === childId`）+ `sessionQuery.observeSession` 轮询兜底观测完成。
- **不新增 TFS 写通道**；TFS 写仍只有 `adapter.executeWrite`（WriteGuard 四道门禁）。

## Constitution Check

- **I 证据优先**：UI 路径、`startContinuable`/`sendMessage` 签名、continuable 完成观测、
  槽位 children 规则逐条引用宿主源码行号（research.md）。未实机验证项登记为 `[NEEDS CLARIFICATION]`
  并设计降级路径，不臆造。
- **II/III/IV（写门禁 / 凭据 / 写收敛）**：不涉及。总结文案只作为 `RequirementFinalizer`
  的输入文本，不改字段映射、不改门禁、不接触 PAT。
- **VI 文件即真相**：编排会话 id、共享简报、任务结论全部落 `board.json`，重启可恢复。
- **VII 验证先于完成**：纯逻辑（brief / 地址解析 / 复用键）单测；api 组装断言「第 2 个任务 prompt
  不含需求正文全文」；三道 tsc + vitest + tsdown。
- **兼容性**：所有新字段可选；旧看板 = 无编排上下文 = 行为与今天完全一致（one-shot 派发 + 模板总结）。

## Project Structure

```
src/shared/brief.ts                  # 新增：共享简报结构 + 增量更新 + prompt 段渲染 + 主 agent 回复解析
src/shared/chat-address.ts           # 新增：dsh-resource://subagentchat/session/... 编解码（纯逻辑，可单测）
src/shared/contracts.ts              # RequirementSummary.orchestration / BoardTaskView.orchestration
                                     # + TFS_ROUTES.orchestratorEnsure + 输入/输出契约
src/core/board/board.ts              # 需求级 orchestration 读写与校验；任务级 orchestration（sessionId/summary）
src/core/board/task.ts               # TaskSnapshot.orchestration?
src/host/orchestrator-session.ts     # 新增：编排会话管理（ensure / summarize / finalize）+ 子会话完成观测
src/host/subagent-access.ts          # 新增 startContinuable / sendMessage 的调用时解析（保留接收者）
src/orchestration/dispatch.ts        # 新增 dispatchContinuable()：复用/新建 continuable，返回 SubagentRunLike
src/host/api.ts                      # prompt 组装改简报口径；收口后归纳；全部完成后最终总结并回写
src/host/board-service.ts            # orchestration 字段落盘与视图透出
src/host/route.ts                    # POST /tfs-requirment/orchestrator-ensure
src/config.ts                        # orchestratorMode / reuseTaskSessions / 归纳超时等
src/client/chat-target-store.ts      # 新增：模块级会话目标 store（TaskCenter ⇄ 对话框解耦）
src/client/components/OrchestratorChat.tsx  # 新增：内嵌会话 + 切换条 + 返回 + 侧栏兜底
src/client/components/TaskCenter.tsx        # 进行中页左右分栏容器
src/client/slots.tsx                 # main 条目声明 children；注册 tfs.orchestrator.chat 子槽
tests/brief.spec.ts                  # 新增
tests/chat-address.spec.ts           # 新增
tests/orchestrator-session.spec.ts   # 新增
```

## 设计要点（按风险从高到低）

### 1. 子会话完成观测（最高风险）

`OrchestratorSessionManager` 在 apply 期注册一次 `ctx.on('subagent/end', …)`，维护
`Map<childId, SubagentResult>` 与 waiter 集合（root 级监听可收各 agent 生命周期边，先例见
`src/host/parent-resolver.ts:60-71`）。

```
waitForChildSettle(childId, timeoutMs):
  ① resolve 于 'subagent/end' 且 info.id === childId（权威，带 lastAssistantMessage）
  ② 每 15s 轮询 sessionQuery.observeSession(childId)：source 从 live → prepared 或出现新的
     assistant turn-end ⇒ resolve
  ③ 超时 ⇒ resolve(undefined)，调用方按降级处理
```

`waitForChildSettle` 必须在 `sendMessage` **之前**挂上（事件可能同步到达）。

### 2. 合成 SubagentRun，复用现有收口链路

`dispatchContinuable()` 返回 `{ id, result }`（`result` = `waitForChildSettle` 包装的
`Promise<SubagentResult>`），形状与 `SubagentRun` 的**只读子集**一致 ⇒
`host/api.ts#launchRun` 里 `run.result.then(…)`、`bindRun`、`armRunWatchdog` 全部**零改动**可用。

### 3. 任务会话复用与并发

- 复用键 `reuseKey = `${requirementKey}|${provider}|${preset ?? ''}``，映射落
  `requirement.orchestration.taskSessions`。
- 同一 `reuseKey` 串行：已有任务在跑则**排队**（`Promise` 链），符合 AC3.3/E6。
- 复用会话失败或观测不到收口 ⇒ 该 `reuseKey` 降级为 one-shot，并在需求级记
  `orchestration.mode='off'` + `reason`，面板可读。

### 4. 客户端内嵌会话（次高）

- Workbench 的 `main` 条目加 `children: { 'tfs.orchestrator.chat': { kind:'single', scope:'session' } }`
  ⇒ 框架注入 `SessionProvider` + 收窄的 `renderSlot`；Workbench 必须调用 `renderSlot('tfs.orchestrator.chat')`。
- 子槽组件 `OrchestratorChatSlot` 拿到 `renderFactorySlot`，内部：
  `useChatTarget()`（模块级 store，TaskCenter 写入）→ `ctx.get('sessions')`（调用时解析）
  → `retain(target, { source:'tfsOrchestratorChat', signal })` → 组件卸载/切换时 `release()`。
- 渲染：`renderFactorySlot('conversation.content', { variant:'embedded', phase, hero }, { slots:{ views: ChatView } })`，
  `ChatView` = `props.renderSlot('conversation.session', { view:'chat' })`（与 ui-subagent 同构）。
- 降级（E2）：`sessions` / `renderFactorySlot` 缺失 → 渲染只读进展时间线 + 「在侧边栏打开」按钮。

### 5. prompt 组装口径变更

```
【工作目录】                （既有 buildWorkspacePromptSection，不变）
【共享简报】                （新增：需求标识/标题/工作目录/digest/已完成任务结论/产物/已绑定 MCP+技能）
                             —— 仅当 brief.digest 存在时；否则退化为【需求提示词】全文（首个任务）
【本任务增量】              （任务标题/描述/任务 prompt，既有）
【执行纪律段】              （既有 buildExecBudgetSection，不变）
```

## 风险与缓解

| 风险 | 缓解 |
|---|---|
| provider 不支持 continuable | `startContinuable` reject ⇒ `mode:'off'` + 面板原因；one-shot 链路完全保留 |
| `subagent/end` 在插件级 ctx 收不到 | `sessionQuery` 轮询兜底 + 超时降级；连续失败则关闭编排（`mode:'off'`） |
| 槽位 children 机制实机不符预期 | 兜底渲染只读时间线 + 侧栏打开；不阻塞任务链路 |
| 引用泄漏 | retain/release 成对；开发期在面板显示 retain 计数 |
| 并发放大 | 复用路径仍走 `RequirementDispatcher` 信号量（新增 acquire/release 复用） |

## 验证方式

1. `npm run e2e:offline`（既有）：确认引擎/服务/编排语义未被破坏。
2. 新增单测：brief 增量与渲染、地址编解码、`dispatchContinuable` 合成 run、api prompt 断言。
3. 三道 `tsc` + `vitest` + `tsdown` 构建。
4. 实机：拆一条 3 任务需求，观察右侧主 agent 会话产生开工/归纳/最终总结消息，切换子 agent 正常。

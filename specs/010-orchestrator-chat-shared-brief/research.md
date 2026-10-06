# Research：任务中心主对话框 / 编排主 agent / 共享简报复用

**Feature**: 010-orchestrator-chat-shared-brief
**Date**: 2026-09-29
**结论**：全部为**本地源码可核实**事实（`文件路径:行号`），无臆造项。缺口以 `[NEEDS CLARIFICATION]` 登记。

---

## 一、宿主「侧边对话」的参考实现（本特性的 UI 依据）

文件：`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx`

| 事实 | 位置 |
|---|---|
| 侧栏对话的 resource 协议名 `subagentchat`，地址前缀 `dsh-resource://subagentchat/session/` | `:21` |
| 地址格式 `dsh-resource://subagentchat/session/<encodeURIComponent(childSessionId)>?parent=<parentSessionId>&mode=<one-shot\|continuable\|unknown>` | `:51-57` |
| 解析函数 `parseSubagentChatAddress`（`mode` 只接受三个字面量） | `:64-89` |
| 用 `sessions.retain(address, { source:'sidebarChat', signal })` 拿 `SessionReference`；释放用 `reference.release()` | `:109`, `:114` |
| `source` 是开放联合：插件可 `declare module ... { interface SessionReferenceSourceMap { tfsChat: unknown } }` 自行扩展 | `:29-33` |
| 页体 = `<SessionProvider session={reference}>{renderSlot('sidebar.chat.conversation', {})}</SessionProvider>` | `:159-167` |
| 会话内容渲染：`renderFactorySlot('conversation.content', { variant:'embedded', phase, hero }, { slots: { views: FixedChatConversationView } })` | `:145-147` |
| `FixedChatConversationView` 内部只做 `props.renderSlot('conversation.session', { view: 'chat' })` | `:121-123` |
| 页类型注册 `ctx.sidebarRightTabs.register({ id, kind:'subagentchat', patterns, canOpen, title })` | `:181-193` |
| 页体注册 `ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name, key: SUBAGENT_CHAT_ID, children: { 'sidebar.chat.conversation': { kind:'single', scope:'session' } } }, SidebarChatTab))` | `:194-198` |
| 打开入口 `ctx.sidebarRight.openResource(subagentChatAddress(address), { kind:'subagentchat', preferNewPane: true })` | `packages/client/ui-subagent/src/client/index.ts:64-69` |

**关键推论**：内嵌会话的**唯一**合法路径是「父条目声明 `scope:'session'` 子槽 → 框架注入 `SessionProvider` → 用 `SessionReference` 绑定 → `renderFactorySlot('conversation.content')`」。插件不能 import `SessionProvider`。

## 二、插件客户端半能 import 什么

`packages/client/web/src/platform.ts:8-14`：`PLATFORM_MODULES = ['react','react/jsx-runtime','react-dom','react-dom/client','@deepseek-ai/cordis','@deepseek-ai/dsh-client-store','@deepseek-ai/dsh-client-ui-slots','@deepseek-ai/dsh-client-ui-primitives','@deepseek-ai/dsh-client-ui-dockkit']`。

⇒ 会话相关组件（`SessionProvider`、`ui-session`、`ui-conversation`）**一律只能经槽位/工厂渲染**，不能 import。

## 三、槽位框架：父条目声明子槽的规则

文件：`packages/client/ui-slots/src/index.ts`

| 事实 | 位置 |
|---|---|
| `register()` 支持 `children?: ChildrenDecl`；子槽键必须先在 `SlotMap` 里 `declare module` 合并 | `:150`, `:822` |
| **子槽键只能被一个父条目声明**，重复声明抛 `slot "<key>" is already declared` | `:1241-1245` |
| 未声明的子槽抛 `slot "<name>" is not declared (a parent entry's children table must declare it)` | `:1205-1207` |
| keyed 槽同 key 重复注册抛错（已在插件 `registerOnce` 里规避） | `:1222-1230` |
| 声明了 `children` 的条目**必须**消费 `renderSlot`（`RendersCheck`） | `:796-807` |
| 子槽声明含 `scope:'session'\|'session-maybe'` 时，框架额外注入 `SessionProvider`（`PropsRenderSlots`） | `:335-337` |
| `renderFactorySlot` 属于 `PropsRenderFactories`，**每个渲染器创建的组件都有** | `:402-404` |
| `renderSlot` 只在 `SlotMap` 条目声明了 `hookContext` 时才强制传 `opts.hookContext` | `:303-322` |
| `SessionAreaProps.session` 可显式传作用域目标；不传 = 继承外层绑定 | `:287-297` |

## 四、会话引用（SessionReference）

`packages/api/session-controller/src/client/contract/sessions.ts`

| 事实 | 位置 |
|---|---|
| `SessionTarget = SessionId \| SubagentAddress`（**可直接用裸会话 id**） | `:17` |
| `retain(target, { source, signal })` → `SessionReference { sessionId, binding, ready, release() }` | `:58`, `:22-31` |
| `using(target, opts, op)`：持引用直到回调落定，自动 release | `:64` |
| `subagentAddress(id)`：从已发现的目录里解析直接父地址（不 retain） | `:99` |
| `resolveTarget(target)` 在 `retain` 内归一化两种形态 | `sessions/service.ts:282,286` |

## 五、subagent 服务：one-shot 与 continuable

`packages/subagent/subagent/src/index.ts`

| 事实 | 位置 |
|---|---|
| `start(name, request)` → `SubagentRun`（有 `id` / `result` / `dispose`） | `:559-590` |
| `startContinuable(spec: ContinuableStartSpec)` → `{ childId, messageId }`；`spec.request = Omit<SubagentStartRequest,'label'|'signal'|'outputSchema'>`，且 `spec.request.parent` 仍必填 | `:261-263`；`types.ts:32-51` |
| `sendMessage(sender: Agent, targetId: SessionId, content, { signal })` → `MessageId`；可唤醒 idle / 冷恢复的子 | `:279-285` |
| 宿主 `resolveChildAgentOptions` 在子未指定 provider/model 时**继承父会话** | `child-agent.ts:109-116`（见 spec 009） |

## 六、continuable 的完成观测（本特性最大风险点）

| 事实 | 位置 |
|---|---|
| 「continuable children have **no** Task, **no** per-message result, and no Task cancellation」 | `run-settlement.ts:1-7` |
| 但 **Activation epoch 会发与 one-shot 同形状的 `subagent/start` / `subagent/end`**；`subagent/end` 带 `id`（= durable child session id）、`stopReason`、`lastAssistantMessage` | `lifecycle.ts:161-215`，`types.ts:100-117` |
| 事件是 scope-filtered（以委派父为 carrier）；宿主包在自身 ctx 上 `ctx.on('subagent/end', …)` 能收到 | `hooks/hooks-claude-code/src/index.ts:297`；`sdk/server/src/server.ts:111` |
| 插件现有先例：`ctx.on('agent/created')` / `ctx.on('agent/status')` 在 root 级监听且注释明确「root 级监听器能收到每个 agent 的生命周期边」 | `src/host/parent-resolver.ts:60-71` |
| 兜底读法：`sessionQuery.observeSession(sessionId, { projectionMode:'none' })` 可冷/热读任意子会话事件（插件已在用） | `src/host/task-trace.ts:95-105` |

⇒ **结论**：continuable 任务的完成可用 `ctx.on('subagent/end')` 观测（`info.id` 匹配 childId），并用 `sessionQuery.observeSession` 轮询作兜底；两者都失败时按现有 one-shot 降级。

## 七、插件现有链路（改动落点）

| 事实 | 位置 |
|---|---|
| `dispatch` → `launchRun` → `board.bindRun(taskId, runId)` → `run.result` → `board.settleTask` | `src/host/api.ts:808-940` |
| 收口后编排 `handleTaskSettled`：仅 success 推进；`board.autoStartRunnable(limit)` + 逐个 `launchBoardTaskExecution`；再 `finalizer.maybeFinalize` | `src/host/api.ts:1620-1666` |
| `BoardService.setSettledHook` 用 setter 补接（构造顺序环） | `src/host/board-service.ts:1097-1105` |
| 任务 attempt 已存 `runId`（= 子会话 id）、`stopReason`、`diagnostic`、`output` | `src/shared/contracts.ts:893-910` |
| 任务级产物路径 `artifactPaths`（由 `ARTIFACTS:` 段解析） | `src/shared/contracts.ts:948`；`src/shared/exec-protocol.ts:154-192` |
| 需求完成回写已覆盖：字段更新 / 结论评论 / **产物上传为附件** / 关联任务收口 | `src/host/requirement-finalizer.ts:196-235, 283-346` |
| `deps.getParent()` 解析真实宿主 Agent（不可伪造）；`agent.session.id` 可取父会话 id | `src/host/parent-resolver.ts:55-97` |
| 派发 prompt 顺序固定：工作目录 → 需求提示词 → 任务正文，末尾统一追加执行纪律段 | `src/host/api.ts:705-740`, `:789-806` |

## 八、UI 落点

- 任务中心「进行中 / 已完成」子 Tab：`src/client/components/TaskCenter.tsx:698-731, 899+`
- 工作台 `main` 槽条目：`src/client/slots.tsx:1611-1618`（`registerOnce(slots, { name:'main', key: PANEL_ID }, …)`）
- 右栏页体条目：`src/client/slots.tsx:1685-1707`（`sidebar.right.pane.tab`，key = `TFS_EXEC_TAB_ID`）
- ⚠️ 两个父条目**不能**声明同一个子槽键（§三），需各用独立键或只给 `main` 声明。

## 九、资料缺口

- `[NEEDS CLARIFICATION-1]`：`subagent/end` 在**插件级 ctx**（非 agent scope）上是否稳定收到，尚未在本机跑过实机验证。缓解：`sessionQuery` 轮询兜底 + 超时降级为 one-shot 语义（见 spec §US3 AC3.4）。
- `[NEEDS CLARIFICATION-2]`：用户现场 provider（`spawn` / `fork` / claude-code 等）是否都实现 `prepareContinuable`。未实现时 `startContinuable` 会 reject ⇒ 必须 fail-loud 降级（spec §US1 AC1.5）。
- `[NEEDS CLARIFICATION-3]`：子会话复用的 token 收益未在真机量化。spec 只要求「可观测」（面板展示每任务 attempt 的 turn/工具调用数），不承诺具体比例。

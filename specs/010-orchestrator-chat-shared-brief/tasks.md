# Tasks: 任务中心主对话框 + 编排主 agent + 共享简报复用

**Branch**: `010-orchestrator-chat-shared-brief` | **Date**: 2026-09-29 | **Spec**: [spec.md](./spec.md) | **Plan**: [plan.md](./plan.md)
**Input**: `specs/010-orchestrator-chat-shared-brief/spec.md` + `plan.md`

> 本项目宪法 Principle VII（验证先于"完成"）：**Tests 不是可选项**。
> 每个 P0/P1 任务都有对应断言；P2 任务至少要有编译门禁。

## Phase 1 — 共享简报（纯逻辑，US3）

- [x] T001 `src/shared/brief.ts`：`RequirementBrief` 类型 + `emptyBrief()` + `upsertConclusion()`
      + `mergeArtifacts()`。纯函数、无 node/DOM 依赖。
- [x] T002 `src/shared/brief.ts#buildBriefSection(brief, opts)`：渲染【共享简报】prompt 段，
      含「优先使用已绑定 MCP/技能」句（AC5.2）；`brief.digest` 为空时返回空串。
- [x] T003 `src/shared/brief.ts#buildSummarizePrompt` / `buildFinalSummaryPrompt`：
      主 agent 归纳请求与最终总结请求文案。
- [x] T004 `src/shared/brief.ts#parseOrchestratorSummary(text)`：从主 agent 回复抽结论
      （`SUMMARY:` 段优先，兜底取前 300 字并去 TASK_DONE/NEEDS_HUMAN_CONFIRM 标记）。
- [x] T005 `tests/brief.spec.ts`：增量去重、结论条数上限、渲染段不含需求正文、解析优先级。

## Phase 2 — 会话地址与契约（纯逻辑）

- [x] T006 `src/shared/chat-address.ts`：`buildChatAddress(childId, parentId, mode)` /
      `parseChatAddress(value)`，格式与宿主 `subagentChatAddress` 一致
      （`dsh-resource://subagentchat/session/<enc>?parent=<id>&mode=<one-shot|continuable|unknown>`）。
- [x] T007 `tests/chat-address.spec.ts`：往返、非法协议/host/缺参、mode 白名单。
- [x] T008 `src/shared/contracts.ts`：`RequirementSummary.orchestration`
      （`mode` / `orchestratorSessionId?` / `parentSessionId?` / `reason?` / `brief?`）；
      `BoardTaskView.orchestration`（`sessionId?` / `reused?` / `summary?` / `summaryState?`）。
- [x] T009 `src/shared/contracts.ts`：`TFS_ROUTES.orchestratorEnsure` +
      `OrchestratorEnsureInput/Result`。

## Phase 3 — 引擎与持久化（VI 文件即真相）

- [x] T010 `src/core/board/board.ts`：需求级 `orchestration` 读写
      （`setOrchestration` / 校验 / 快照透出），字段全可选。
- [x] T011 `src/core/board/task.ts` + `board.ts`：任务级 `orchestration`
      （`sessionId` / `reused` / `summary` / `summaryState`）+ `setTaskSummary()`。
- [x] T012 `src/core/board/board.ts`：`taskSessions` 复用键表读写
      （`getTaskSession(reuseKey)` / `putTaskSession()`）。
- [x] T013 `src/host/board-service.ts`：以上字段落盘与视图透出（`toTaskView` / 需求视图）。

## Phase 4 — 宿主编排会话（US1/US2，最高风险）

- [x] T014 `src/host/subagent-access.ts`：新增 `startContinuableOn(ctx, spec)` 与
      `sendMessageOn(ctx, sender, targetId, content, signal)` —— **调用时**解析服务、保留接收者。
- [x] T015 `src/host/orchestrator-session.ts#ChildSettleWatcher`：`ctx.on('subagent/end')`
      + `sessionQuery.observeSession` 轮询兜底 + 超时；暴露 `waitForChildSettle(childId, ms)`。
- [x] T016 `src/host/orchestrator-session.ts#OrchestratorSessionManager`：`ensure(requirementKey)`
      幂等创建 continuable 编排会话；失败 fail-loud 记 `mode:'off'` + `reason`。
- [x] T017 同上：`summarize(requirementKey, taskId, output)` → sendMessage + 等待 → 写结论回简报；
      超时/失败落 `summaryState:'timeout'|'failed'`，不阻断。
- [x] T018 同上：`finalize(requirementKey)` → sendMessage 最终总结 → 返回文案；
      失败回退 `undefined`（调用方用模板总结并标注 `template-fallback`）。
- [x] T019 `tests/orchestrator-session.spec.ts`：桩 subagent 服务驱动
      ensure 幂等 / summarize 超时降级 / finalize 回退。

## Phase 5 — 派发链路接入（US2/US3）

- [x] T020 `src/orchestration/dispatch.ts#dispatchContinuable`：信号量 + 复用/新建 continuable +
      返回 `{ id, result }`（`result` 由 `waitForChildSettle` 包装）+ 看门狗。
- [x] T021 `src/orchestration/dispatch.ts`：复用键串行队列（同 reuseKey 排队），
      与 one-shot 共用 `activeCount/queuedCount`。
- [x] T022 `src/host/api.ts`：prompt 组装改为「工作目录 → 共享简报（无则需求提示词全文）→
      本任务增量 → 纪律段」；断言第 2 个任务起的 prompt 不含需求正文全文。
- [x] T023 `src/host/api.ts#handleTaskSettled`：success 后先归纳（带超时）再 `autoStartRunnable`；
      全部完成后 `finalize()` → 文案传给 `finalizer.runWriteBack`。
- [x] T024 `src/host/api.ts#orchestratorEnsure` + `src/host/route.ts` 路由接线。
- [x] T025 `src/config.ts`：`orchestratorMode`、`reuseTaskSessions`、
      `summarizeTimeoutSeconds`、`taskSessionSettleTimeoutMinutes`。

## Phase 6 — 客户端 UI（US1/US4）

- [x] T026 `src/client/chat-target-store.ts`：模块级 store（`target` / `visible`），
      TaskCenter 写、对话框读，避免槽位 props 穿透。
- [x] T027 `src/client/components/OrchestratorChat.tsx`：内嵌会话组件
      （retain/release 生命周期 + `renderFactorySlot('conversation.content')` + 降级时间线）。
- [x] T028 同上：顶部切换条（主 agent / 子 agent 列表）+ 「← 返回主 agent」+ 无会话项禁用
      + 「在侧边栏打开」兜底按钮（AC4.1–AC4.5）。
- [x] T029 `src/client/slots.tsx`：`main` 条目加 `children` 声明 + 注册
      `tfs.orchestrator.chat` 子槽（registerOnce，回调只返回 disposer/undefined）。
- [x] T030 `src/client/components/TaskCenter.tsx` + `slots.tsx`：进行中页左右分栏容器，
      切换子 Tab 时写入 store 的 `visible`。

## Phase 7 — 门禁与收尾

- [x] T031 三道 `tsc`（host / client / tests）+ `vitest` 全绿 + `tsdown` 构建。
- [x] T032 `npm run e2e:offline` 回归。
- [x] T033 `README.md` / `README.zh.md` 增补本特性说明与配置项。
- [x] T034 更新 `.workbuddy/memory/` 日志与长期笔记（continuable 观测口径、槽位 children 规则）。

## 实施结果（2026-09-30）

- **P0–P1 全部完成并验证**：`src/shared/brief.ts`、`src/shared/chat-address.ts`、
  契约/引擎/服务字段、`src/host/orchestrator-session.ts`、`src/orchestration/dispatch.ts#acquireSlot`、
  `src/host/api.ts`（简报注入 + 归纳 + 最终总结 + 复用派发）、`src/host/route.ts`、
  `src/config.ts`、客户端 `OrchestratorChat.tsx` / `TaskCenter.tsx` / `slots.tsx`（含 `main` 条目的
  session 子槽声明）。
- **门禁**：三道 `tsc`（host / client / tests）全绿；`vitest` **922 passed / 0 failed**；
  `tsdown` 客户端构建通过；`e2e:offline` **27/27**。
  ⚠️ `e2e:offline` 需加 `CODEBUDDY_SAFE_DELETE_ENABLED=0`（沙箱内 safe-delete 助手
  `spawnSync … ETIMEDOUT`，与本特性无关）。
- **新增单测**：`tests/brief.spec.ts`(25)、`tests/chat-address.spec.ts`、`tests/orchestrator-session.spec.ts`(11)、
  `tests/brief-injection.spec.ts`(3)。
- **待实机验证（未在本轮完成）**：
  1. 右侧内嵌会话在真实 dsh web 中的渲染（`SessionProvider` 注入 + `conversation.content` 工厂）；
  2. `ctx.on('subagent/end')` 在**插件级 ctx** 上能否收到 continuable activation 的收口事件
     （收不到时会走 `sessionQuery` 轮询兜底，再超时降级）;
  3. 复用会话的实际 token 收益（`TaskTraceService.stats` 可观测，未量化）。

# Tasks: 需求池三项交互修复（可选项缓存 / 领取可见 / 目标带出内容）

**Input**: Design documents from `/specs/002-fix-pool-claim-target/`
**Prerequisites**: [plan.md](./plan.md) (required), [spec.md](./spec.md), [research.md](./research.md), [data-model.md](./data-model.md)

**Tests**: 本项目按 Constitution Principle VII 处理 —— 测试任务**必选**，每个故事先写失败测试再实现。

## Format: `[ID] [P?] [Story] Description`

- **[P]**: 可并行（不同文件、无依赖）
- **[Story]**: 所属用户故事（US1/US2/US3）

## Phase 1: Setup (Shared Infrastructure)

- [x] T001 新增 `src/shared/text.ts`：`htmlToPlainText()`（去标签 + 解码常见实体 + 折叠空行）与 `truncateText()`
- [x] T002 新增 `src/shared/pool.ts`：`requirementKey()`、`claimedKeysOf()`、`shouldCacheQueryOptions()`、`buildTargetFill()`
- [x] T003 [US1/US2/US3] `src/shared/contracts.ts`：`RequirementSummary` + `description?`；`ExecutionPanelData` + `target?`；`TFS_ROUTES` + `queryOptionsRefresh`

**Checkpoint**: 共享层就绪（三个故事共同依赖）

## Phase 2: Foundational (Blocking Prerequisites)

- [x] T004 [P] `src/tfs/types.ts`：`Requirement` 增加 `description?: string`
- [x] T005 [P] `src/tfs/adapter.ts`：`normalizeWorkItem` 映射 `System.Description` 并经 `htmlToPlainText` 转换
- [x] T006 `src/host/board-service.ts`：`summaryToRequirement` / `requirementToSummary` 双向透传 `description`
- [x] T007 [P] 测试 `tests/text.spec.ts`：HTML→纯文本与截断
- [x] T008 [P] 测试 `tests/normalize.spec.ts`：断言 `System.Description` 被归一化进 `description`

**Checkpoint**: 描述字段贯通 适配层 → 领域 → 持久化 → 契约

## Phase 3: User Story 1 - 筛选可选项只在该拉的时候拉 (P1) 🎯 MVP

**Goal**: 已有可选项时不重复采集；保留手动「重新采集」通道；并发只采一次

**Independent Test**: 连续两次取可选项，适配器采集调用次数为 1；换集合后为 2；强制重采后再 +1

### Tests for User Story 1

- [x] T009 [US1] `tests/host-api.spec.ts`：缓存命中不重采 / 换集合失效 / 空结果不入缓存 / 并发共享一次 / `refreshQueryOptions` 强制重采
- [x] T010 [US1] `tests/pool.spec.ts`：`shouldCacheQueryOptions` 判据（项目非空 / 类型非空 / 全空）
- [x] T011 [US1] `tests/host-route.spec.ts`：`POST /tfs-requirment/query-options-refresh` 可用且走强制重采

### Implementation for User Story 1

- [x] T012 [US1] `src/host/api.ts`：进程内 `cache` + `inflight` 双 Map，`getQueryOptions` 命中即返；新增 `refreshQueryOptions`
- [x] T013 [US1] `src/host/route.ts`：新增 `createQueryOptionsRefreshHandler` 并注册路由
- [x] T014 [US1] `src/client/slots.tsx`：`HttpHostBridge` 增加模块级可选项副本 + `refreshQueryOptions()`
- [x] T015 [US1] `src/client/components/RequirementPool.tsx`：仅在无数据时采集；增加「重新采集」按钮、进行中状态、采集时刻

**Checkpoint**: 切页签不再重复采集；手动按钮可强制刷新

## Phase 4: User Story 2 - 「领取入池」必须有看得见的结果 (P2)

**Goal**: 行内持久「已入池」标记 + 任务中心计数同步 + 失败可见 + 防连点

**Independent Test**: 领取后该行立刻标记已入池且看板快照 requirements 增加；重复领取提示"已在池中"

### Tests for User Story 2

- [x] T012a [US2] `tests/pool.spec.ts`：`requirementKey` 与 `claimedKeysOf` 的幂等与去重

### Implementation for User Story 2

- [x] T016 [US2] `src/client/slots.tsx`：`Workbench` 计算 `claimedKeys` 下发给需求池；`onClaim` 成功后同步本地集合并 `reloadBoard()`
- [x] T017 [US2] `src/client/components/RequirementPool.tsx`：已入池徽标 + 按钮态切换 + 行内失败原因 + 领取中禁用该行

**Checkpoint**: 「领取入池」在同一屏内即可见结果

## Phase 5: User Story 3 - 「选为目标」自动带出需求内容 (P3)

**Goal**: 目标变更时自动填充执行配置表单，零复制粘贴

**Independent Test**: 选目标后执行面板的标题/描述/执行 Prompt 已填为该需求内容

### Tests for User Story 3

- [x] T018 [US3] `tests/pool.spec.ts`：`buildTargetFill` 填充规则、正文缺失时的占位说明、超长截断

### Implementation for User Story 3

- [x] T019 [US3] `src/client/slots.tsx`：`execData` 带上 `target`
- [x] T020 [US3] `src/client/components/ExecutionPanel.tsx`：监听目标键变化 → 填充表单（不覆盖用户后续编辑）

**Checkpoint**: 三个故事均可独立验收

## Phase N: Polish & Cross-Cutting Concerns

- [x] T021 同步 `tests/host-route.spec.ts` 的假 `HostApi`（补 `refreshQueryOptions`）与其余受契约变更影响的用例
- [x] T022 门禁：`npm run typecheck`（host + client + **tests** 三条）与 `npm run test` 全绿
- [x] T023 客户端打包验证：`npm run build:client`（`tsc` + `tsdown`，.tsx 改动必须两条都跑）
- [x] T024 更新 `docs/` 与 `specs/002-.../plan.md` 的实施结论（含实测数据）

## Dependencies & Execution Order

- **Phase 1 → Phase 2**：共享层先于一切（客户端半也消费）
- **Phase 2 → Phase 3/4/5**：描述字段贯通后，US3 才有数据源
- **US1 / US2 / US3**：互不阻塞，按 P1 → P2 → P3 顺序落地
- **Polish**：全部故事完成后执行门禁

## Notes

- 改 `HostApi` 接口必须同批改 `tests/**` 的假实现（项目纪律：接口变更与测试同批，否则第三道门禁才暴露）
- `.tsx` 改动必须 `tsc(client)` 与 `tsdown` 两条都跑（JSX 内 Windows 路径需写 `{'D:\\...'}`）
- 客户端无 React 测试库 ⇒ 组件逻辑一律下沉 `src/shared` 方可单测

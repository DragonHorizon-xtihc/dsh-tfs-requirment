# Tasks 004

图例：`[x]` 完成 / `[ ]` 未做（附原因）。每个任务后括号内为验证方式。

## 阶段 A：契约与纯逻辑

- [x] T401 `TaskSnapshot.prompt?` + `TaskDraft.prompt?` + `Board.updateTask`（`tests/edit-capability.spec.ts` 引擎段 9 例）
- [x] T402 `Requirement.prompt?`（`tests/edit-capability.spec.ts` 服务段落盘回读）
- [x] T403 `src/shared/contracts.ts` 类型增量 + 两条路由 + `HostBridge` 两方法（三道 tsc）
- [x] T404 `src/shared/batch-dispatch.ts` 纯函数（`tests/batch-dispatch.spec.ts` 17 例）

## 阶段 B：宿主半

- [x] T405 `BoardService.updateRequirementMeta` / `updateTask` / `claimRequirement(prompt)` /
      `toTaskView(prompt)` / `summaryToRequirement(prompt)` / `resolveWorkspace` 抽取（服务段 9 例）
- [x] T406 `api.updateRequirement` / `api.updateTask` + `dispatch` 三段式 prompt + `dispatchConcurrency`
      + `catalogWarnings`（编排段 9 例 + E2E-A S4）
- [x] T407 `route.ts` 两条新路由 + 注册（`tests/host-route.spec.ts` 8 例 + E2E-B L3）
- [x] T408 `index.ts` 注入 `dispatchConcurrency`（tsc host）

## 阶段 C：客户端半

- [x] T409 `MultiSelect` 去重（导出 `dedupeOptions`）（`tests/ui-dedup.spec.ts`）
- [x] T410 `RoleSettings.buildModelItems` 去重 + provider 合并进 hint（同上）
- [x] T411 `ExecutionPanel` 模型去重 + 「重新采集目录」+ warnings/计数可见（tsc client + 构建产物 grep）
- [x] T412 `RequirementPool` 领取弹框（工作目录 + 提示词）（tsc client + 构建产物 grep `确认领取入池`）
- [x] T413 `TaskCenter` 需求编辑弹框（tsc client）
- [x] T414 `TaskCenter` 任务编辑弹框（tsc client）
- [x] T415 `TaskCenter` 勾选列 + 批量派发 + 进度（tsc client + 构建产物 grep `批量派发执行`）
- [x] T416 `slots.tsx` 接线 + `dispatchBatch` 分波轮询 + Tab 激活重采 + 5 分钟续采（tsc client + tsdown）

## 阶段 D：门禁与端到端

- [x] T-V1 三道 tsc：host / client / tests 全 0
- [x] T-V2 `vitest run --reporter=json`：`numFailedTests === 0`（622 用例）
- [x] T-V3 `tsc(host)+tsc(client)+tsdown` 全 0；`lib/client.js` 272.38 kB 含新符号
- [x] T-V4 E2E-B：真实 dsh web `panel-data` → `catalog-refresh`，**MCP 1→2 实测变化**、采集时刻推进
- [x] T-V5 E2E-A/B：`claim(prompt)` / `requirement-update` / `task-update` 落盘与路由注册均实测
- [x] T-V6 E2E-A：分波顺序 analyze>impl>verify + 提前派发被拒且不触达 dispatcher
- [x] T-V7 E2E-A + 单测：重复 id → 唯一选项/唯一 chip
- [x] T-V8 回填 `plan.md` 验证记录 + 写工作记忆
- [ ] T-V9（未做，已说明）真实宿主里"先建会话再观察技能 23→96+"：需在 dsh 进程内创建会话
      （驱动 `/api` RPC 或跑真实模型），成本与副作用超范围；由源码依据 + mounts=0 实测 + 并集单测组合支撑

---
description: "Task list for 009 LLM provider route + board refresh after dispatch"
---

# Tasks: LLM 供应商随模型成对路由 + 派发后任务中心即时可见

**Input**: `specs/009-llm-provider-route-and-board-refresh/`（spec.md / plan.md / research.md）
**Tests**: 按宪法 Principle VII，测试必选；纯逻辑下沉 shared/orchestration 可单测模块，跨宿主边界用结构类型桩。
**Organization**: US1–US4 为同一条「provider 全链路」修复线（共享 → 宿主 → 客户端），US5 为独立的刷新修复线。

## 约定

- 宿主半改 `src/host/**`、`src/core/**`、`src/orchestration/**`；客户端半改 `src/client/**`；
  两端共享只进 `src/shared/**`。
- 新字段一律**可选**；provider 为空串时不写 JSON 键，保持 `{mcp,skills,model}` 旧形状。
- provider 与 model 严格成对：agentOptions 中 provider 仅在 model 非空时出现。
- 每完成一个代码任务即跑相关测试；全部完成后跑三道 tsc + 全量 vitest + tsdown 构建。

---

## US0 — 共享层：契约与纯函数（P0，后续任务的前置）

- [x] **T0.1 [US1]** `src/shared/contracts.ts`：
  - `FrozenConfig` 增 `modelProvider?: string`（注释：LLM 路由 key=listProviders().id，
    与 model 成对；缺省=子 agent 继承父会话供应商）；
  - `RoleDefinition` 增 `defaultModelProvider?: string`（同语义；注明与 `provider`(子智能体驱动名) 是两条轴）；
  - `UpdateTaskInput` 增 `modelProvider?: string`；
  - `ExecutionFormState.model/aiParseModel` 注释更新为「modelOptionValue 复合值」。
- [x] **T0.2 [US1]** 新增 `src/shared/model-route.ts`（客户端安全，禁 import node:*）：
  - `modelOptionValue(provider, id)`：JSON 复合值 `{p,i}`；
  - `parseModelOptionValue(value)`：容错解码，非法返回 undefined；
  - `groupModelOptions(options)`：按 provider 分组、同 provider 内按 id 去重、保目录顺序；
  - `findModelOption(options, provider, id)`；
  - `providerLabel(options, provider)`：providerName ?? provider ?? ''。
- [x] **T0.3 [P] [US1]** 新增 `tests/model-route.spec.ts`：编解码往返；非法 JSON/空串→undefined；
  跨 provider 同 id 保留两项；同 provider 重复 id 去重；顺序稳定；providerLabel 三级回落。

## US1 — dispatcher 与宿主派发链路成对下发 provider（P0）

- [x] **T1.1 [US1]** `src/orchestration/dispatch.ts`：
  - 导出 `resolveFrozenModelRoute({ frozen, role })`：frozen.model(trim) → role.defaultModel(trim)
    → 空；每层 provider 与 model 同层取，provider trim 后为空则不返回该键；
  - `dispatch()` 构造 agentOptions 改为：model 非空时 `{ model, ...(modelProvider?{provider}) }`，
    model 空时 `{}`（成对不变量写进注释，引用宿主 tool-subagent/model-selection.ts:112-114）。
- [x] **T1.2 [P] [US1]** 更新 `tests/dispatch.spec.ts`：
  - 既有「model 为空不传 model」「model 有值透传」用例保持绿；
  - 新增：`{model:'deepseek-v4-flash', modelProvider:'arkcode'}` →
    agentOptions 含 `{provider:'arkcode', model:'deepseek-v4-flash'}`；
  - 新增：provider 有值但 model 空 → agentOptions 无 provider 键；
  - 新增 `resolveFrozenModelRoute` 表驱动：frozen 优先于 role、role 对成对、trim、空白归一。
- [x] **T1.3 [US1]** `src/host/api.ts`：
  - 三处 frozenConfig 组装（dispatch ~530、followUp ~850、launchBoardTaskExecution ~1284）
    改用 `resolveFrozenModelRoute({ frozen: draft/task.frozenConfig, role })`，
    provider 非空时写 modelProvider 键；
  - `launchRun` 形参 frozenConfig 类型改为 `FrozenConfig`（~734）；
  - `updateTask`（~1191-1202）增 modelProvider 运行时校验（必须为字符串）。
- [x] **T1.4 [P] [US1]** 更新 `tests/host-api.spec.ts`、`tests/host-api-task-run.spec.ts`：
  - 派发落盘任务 frozenConfig 含 modelProvider；
  - 角色 defaultModel+defaultModelProvider 在任务冻结为空时成对回落；
  - 旧角色（仅 defaultModel）回落结果不含 provider 键。

## US2 — 看板引擎 / 服务 / 拆解透传 provider（P0）

- [x] **T2.1 [US3]** `src/core/board/board.ts` `updateTask`（739-755）：
  - `fc.modelProvider` 出现时必须为字符串（否则 BoardError）；
  - same 比较纳入 modelProvider；写入时 trim、空串不写键；
  - 注释写明归一化规则。
- [x] **T2.2 [US3]** `src/host/board-service.ts`：
  - `updateTask` patch 类型增 `modelProvider?: string`；wantsFrozen 条件纳入；
    组装时 `patch.modelProvider ?? task.frozenConfig.modelProvider ?? ''`；
  - `toTaskView` 形参 frozenConfig 内联类型放宽为含 `modelProvider?: string`（或直接引用 FrozenConfig）。
- [x] **T2.3 [US2]** `src/core/board/decompose.ts`：`RoleRef` 增 `defaultModelProvider?`；
  `frozenOf` 在非空时写 modelProvider 键；DEFAULT_FROZEN 形状不变。
- [x] **T2.4 [P] [US2/US3]** 更新测试：
  - `tests/edit-capability.spec.ts`：provider 落盘/bump、非法值抛错、空串清除且不写键、
    整体替换语义保持；`BoardService.updateTask` 部分传参 provider 保持原值；
  - `tests/board-service.spec.ts`：createManualTask 透传 provider；
  - `tests/board.spec.ts`：decompose 角色带 provider 时草稿含该键，不带时 toEqual 旧形状不变。

## US3 — 客户端：执行配置 / 任务编辑 / 角色默认模型（P0）

- [x] **T3.1 [US1]** `src/client/components/ExecutionPanel.tsx`：
  - 分组逻辑改用 `groupModelOptions`；两个 select 的 option value 改 `modelOptionValue`；
  - effective 回落第一项的**复合值**；目录为空时 ''；
  - onDispatch 解码复合值，frozenConfig 携带 modelProvider（空则不带键）；
  - FREEZE 预览增「供应商显示名 / 模型」。
- [x] **T3.2 [US3]** `src/client/components/TaskCenter.tsx` `TaskEditDialog`：
  - 增 modelProvider state（初值取 t.frozenConfig.modelProvider ?? ''）；
  - 复合值 option；旧裸值任务追加「{id}（未绑定供应商，沿用会话供应商）」选项
    （value=`modelOptionValue('', id)`）；
  - 保存：model 空 → 不传/清空 provider；model 非空 → 带所选 provider；
  - 列表行模型显示改「供应商名 / 模型」，未绑定显式标注。
- [x] **T3.3 [US2]** `src/client/components/RoleSettings.tsx`：
  - 默认模型控件由 MultiSelect 改为分组原生 select（含「未指定」与旧裸值项），
    onChange 同时写 defaultModel/defaultModelProvider；保存前归一（provider 空删键）；
  - 删除 `buildModelItems`（跨 provider 按 id 去重是缺陷化身）；编辑既有角色时正确回填。
- [x] **T3.4 [US4]** `src/client/components/TaskDetailDialog.tsx`：冻结配置区按
  「供应商名 / 模型」显示，未绑定标注「沿用会话供应商」。
- [x] **T3.5 [P] [US2]** 更新 `tests/ui-dedup.spec.ts`：删除 buildModelItems 用例，
  改为 `groupModelOptions` 用例（跨 provider 同 id 两项、同 provider 去重、顺序、空输入）。

## US5 — 派发后任务中心即时可见（P0，独立修复线）

- [x] **T5.1 [US5]** `src/client/slots.tsx`：
  - `actions().dispatch` 改 async 包装：`const res = await bridge.dispatch(...); if (res.ok) await reloadBoard(); return res`；
  - 增 effect：切入 `tasks` Tab（已 visited）时 `void reloadBoard()`；
  - 失败路径不刷新（AC5.4）。
- [x] **T5.2 [US5]** `src/client/components/SidePanel.tsx`：actions.dispatch 包装为
  ok 后调用既有 `reloadBoard()`（保持 busy/notify 行为）。
- [x] **T5.3 [P] [US5]** 复核 `tests/e2e.spec.ts` 既有派发夹具不断言旧刷新行为；
  若存在可挂载的纯逻辑缺口则补用例，否则在 spec 记录为手工验证项
  （React 接线无 DOM 测试库，E2E 手工验证：派发→不刷新直接切 Tab 见任务+角标）。

## 验证与交付（P0）

- [x] **T6.1** 全量 `npm test`（vitest）全绿；新增用例先红后绿。
- [x] **T6.2** 三道 tsc（host/client/tests，以 package.json scripts 为准）零错误。
- [x] **T6.3** `npm run build`（tsdown）通过；`artifact-preview`/verifier 按交付清单复核。
- [ ] **T6.4** 本机手工验证（settings.yaml 含 arkcode/nvida）：
  - 执行配置选「火山方舟 / deepseek-v4-flash」派发 → attempt.provider=arkcode；
  - 选英伟达分组同 id 项 → provider=nvida（或该路由真实 key）；
  - 派发后直接切任务中心：新任务即时出现、角标计数 +1，无需手动刷新；
  - 旧 board.json/roles.json 裸 model 任务/角色正常显示与派发（标注未绑定供应商）。
- [x] **T6.5** 在 spec.md / tasks.md 回填勾选与验证记录；最终说明列出验证方式、覆盖范围与缺口。

---

## 验证记录（2026-09-22）

- **T6.1** `npm test`（vitest run）：49 个测试文件、**815 个用例全部通过**（修复前基线 774；新增 41 个：model-route 20、dispatch 路由 8、宿主/引擎/看板 9、ui-dedup 净 +4 等，以实际计数为准）。
- **T6.2** `npm run typecheck` 三道 tsc（host/client/tests）零错误；期间发现并修复 `scripts/e2e-004.ts` 对已删除 `buildModelItems` 的引用（步骤 6 改写为 spec 009 分组/复合值断言）。
- **T6.3** `npm run build`（host tsc + client tsc + tsdown）通过，client bundle 342.98 kB。
- **T5.3** React 接线无 DOM 测试库，刷新行为（派发后 reloadBoard、切入 tasks Tab 拉取）记为 **T6.4 手工验证项**；纯逻辑缺口不存在（刷新是接线层动作）。
- **T6.4 待用户手工验证**（未执行）：见上节清单；重点是 arkcode/nvida 各派发一次核对 attempt 实际供应商，以及派发后不手动刷新直接切任务中心。
- 兼容性自检：旧 `{mcp,skills,model}` JSON 形状在 provider 缺省时字节级保持（既有 toEqual 断言全部未改即通过）；旧裸值在三处模型下拉中以「（未绑定供应商，沿用会话供应商）」显式可见。

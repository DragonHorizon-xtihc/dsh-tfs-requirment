# Implementation Plan: LLM 供应商随模型成对路由 + 派发后任务中心即时可见

**Branch**: `009-llm-provider-route-and-board-refresh` | **Date**: 2026-09-22 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/009-llm-provider-route-and-board-refresh/spec.md`

## Summary

两条独立修复线：

1. **LLM 供应商路由（US1–US4）**：根因是 provider 在「目录 → UI 选项值 → 派发草稿 → FrozenConfig
   → agentOptions」链路上全程丢失，宿主对子 agent 继承父聊天会话的 LLM 供应商
   （`packages/subagent/subagent/src/child-agent.ts:109-116`）。修复 = 全链路成对携带
   `(modelProvider, model)`：新增共享纯函数模块 `src/shared/model-route.ts`（复合值编解码/分组/查找），
   契约加两个可选字段，三个模型下拉统一改造，宿主新增 `resolveFrozenModelRoute` 单一回落口径并在
   dispatcher 成对下发，看板引擎/服务/拆解透传并校验。
2. **派发后即时刷新（US5）**：根因是执行配置页 dispatch 成功后不调用 `reloadBoard()`
   （slots.tsx:1170、SidePanel.tsx:171），而任务中心 Tab 保活、无轮询、切 Tab 不拉取。
   修复 = dispatch 返回 ok 后刷新看板，并在切入任务中心 Tab 时兜底拉取。

## Technical Context

**Language/Version**: TypeScript（宿主半 `tsconfig.host.json`；客户端半 `tsconfig.client.json`
仅编译 `src/client` + `src/shared`，`types: []` 无 node 全局；测试 `tsconfig.tests.json`）。
**Primary Dependencies**: React 18、vitest；不引入新依赖。
**Storage**: `board.json`（frozenConfig 增可选键）、`roles.json`（RoleDefinition 增可选键），
均为 JSON 权威、原样加载（`Board.load` 为 verbatim 替换，board.ts:116-118），旧文件无需迁移。
**Testing**: vitest 全量 + 三道 tsc + tsdown 构建；dispatcher 已有 fake client 测试夹具
（tests/dispatch.spec.ts），路由断言直接复用。
**Constraints**:
- 客户端半只能 import `src/shared` 与 React；编解码/分组纯函数放 `src/shared/model-route.ts`。
- provider 为空时**不写 JSON 键**，保持 `{mcp,skills,model}` 旧形状与既有 toEqual 断言稳定。
- provider 与 model 严格成对：agentOptions 中 provider 仅在 model 非空时出现。
- 不做 provider 目录预检（目录可能降级为空但路由有效），未知 provider 交给宿主 LLM 层报错并经
  既有 stopReason=error 收口。
- 不新增路由、不新增 TFS 写路径、不引看板轮询。

## Constitution Check

- **I 证据优先**：根因逐行引用插件与宿主源码、本机 settings.yaml、board.json（见 research.md）。
- **VI 文件即真相**：所选 provider 立即进 frozenConfig 落 board.json、角色默认 provider 落 roles.json。
- **VII 验证先于完成**：纯函数单测 + dispatcher 路由断言 + 三处回落表驱动用例 + 全量 tsc/vitest/构建。
- **IV 写操作收敛 / II 凭据 / III 审批**：不涉及；无新写通道、无凭据接触、无门禁语义变更。
- **兼容性**：两个新字段全部可选；旧数据=继承父会话 provider（即现状语义），不迁移、不锁死。

## Project Structure

```
src/shared/model-route.ts        # 新增：复合值编解码 + 分组 + 查找（客户端安全纯函数）
src/shared/contracts.ts          # FrozenConfig.modelProvider? / RoleDefinition.defaultModelProvider?
                                 # / UpdateTaskInput.modelProvider?
src/orchestration/dispatch.ts    # resolveFrozenModelRoute() 导出；agentOptions 成对传 provider+model
src/core/board/decompose.ts      # RoleRef 增 defaultModelProvider；frozenOf 透传
src/core/board/board.ts          # updateTask 校验/比较/归一化 modelProvider
src/host/board-service.ts        # updateTask patch 透传；toTaskView 类型放宽
src/host/api.ts                  # 三处 frozenConfig 组装改用 resolveFrozenModelRoute；
                                 # launchRun 入参类型 FrozenConfig；updateTask 校验 modelProvider
src/client/components/ExecutionPanel.tsx  # 复合值下拉、冻结预览、草稿带 provider
src/client/components/TaskCenter.tsx      # 编辑弹框复合值 + 旧值选项；列表显示供应商
src/client/components/RoleSettings.tsx    # 默认模型改为按 provider 分组单选
src/client/components/TaskDetailDialog.tsx # 冻结配置显示供应商
src/client/components/SidePanel.tsx       # dispatch ok 后 reloadBoard
src/client/slots.tsx                      # actions.dispatch ok 后 reloadBoard；切入 tasks Tab 拉取
tests/model-route.spec.ts        # 新增：编解码/分组/查找/旧裸值
tests/dispatch.spec.ts           # 新增：provider 成对下发、成对不变量、回落
tests/board.spec.ts / edit-capability.spec.ts / board-service.spec.ts
                                 # 新增：modelProvider 落盘/编辑/拆解透传用例
tests/ui-dedup.spec.ts           # buildModelItems 用例替换为分组构建用例
```

## Implementation Approach

### 1. 共享层：`src/shared/model-route.ts`（新文件）

```ts
// 复合值用 JSON 编码，provider/id 中允许出现 '/' 等字符也不会歧义；解码失败返回 undefined。
modelOptionValue(provider, id): string          // JSON.stringify({ p, i })
parseModelOptionValue(value): { provider, id } | undefined
groupModelOptions(options): Array<{ provider, providerName, items: DshModelOption[] }>
                 // 同 provider 内按 id 去重，保持目录顺序（与 TaskCenter 既有 groupedModels 同口径）
findModelOption(options, provider, id): DshModelOption | undefined
providerLabel(options, provider): string        // providerName ?? provider ?? ''
```
ExecutionPanel/TaskCenter 现有内联分组逻辑（ExecutionPanel.tsx:511-517、TaskCenter.tsx:1673-1681）
统一替换为 `groupModelOptions`，消除两份重复实现。

### 2. 契约层（contracts.ts）

- `FrozenConfig` 增 `modelProvider?: string`（注释写明：LLM 路由 key，与 model 成对；缺省=继承父会话）。
- `RoleDefinition` 增 `defaultModelProvider?: string`。
- `UpdateTaskInput` 增 `modelProvider?: string`。
- `ExecutionFormState.model / aiParseModel` 注释更新为「复合值，见 model-route.ts」，字段类型不变（string）。

### 3. 宿主派发口径（dispatch.ts + api.ts）

dispatch.ts 导出：
```ts
export function resolveFrozenModelRoute(input: {
  frozen?: { model?: string; modelProvider?: string }
  role?: Pick<RoleDefinition, 'defaultModel' | 'defaultModelProvider'>
}): { model: string; modelProvider?: string }
```
层级：①frozen.model 非空 → 取 frozen 对（provider 空则不带）；②role.defaultModel 非空 → 取 role 对；
③都空 → `{ model: '' }`。trim 在本函数内完成；provider 为空串一律不返回该键。

dispatcher.dispatch（dispatch.ts:236-237）：
```ts
const route = resolveFrozenModelRoute({ frozen: req.frozenConfig })
const agentOptions: AgentOptions = route.model
  ? ({ model: route.model, ...(route.modelProvider ? { provider: route.modelProvider } : {}) } as AgentOptions)
  : ({} as AgentOptions)
```

api.ts 三个组装点（530-534、850-853、1284-1288）改为：
```ts
const route = resolveFrozenModelRoute({ frozen: draft.frozenConfig, role: dispatchRole })
const frozenConfig: FrozenConfig = {
  mcp: ..., skills: ..., model: route.model,
  ...(route.modelProvider ? { modelProvider: route.modelProvider } : {}),
}
```
- dispatch() 手工建任务落盘的就是这份（保证 UI 列表/详情可见供应商）。
- launchRun 的 `frozenConfig` 形参类型从内联 `{mcp,skills,model}` 改为 `FrozenConfig`。
- followUp 不建任务，仅传给 launchRun。

### 4. 引擎与服务（board.ts / board-service.ts / decompose.ts）

- `Board.updateTask`（board.ts:739-755）：`fc.modelProvider` 存在时必须为字符串；
  比较条件加入 provider；写入时 trim、空串不写键：
  `task.frozenConfig = { mcp, skills, model, ...(provider ? { modelProvider: provider } : {}) }`。
- `BoardService.updateTask`（board-service.ts:808-853）：patch 增 `modelProvider?: string`；
  `wantsFrozen` 条件并入该字段；组装时 `modelProvider: patch.modelProvider ?? task.frozenConfig.modelProvider ?? ''`，
  引擎侧统一归一化。
- `api.updateTask`（api.ts:1191-1202）：modelProvider 运行时校验（字符串）。
- `decompose.ts`：`RoleRef` 增 `defaultModelProvider?`；`frozenOf` 在非空时写入；
  DEFAULT_FROZEN 形状不变。
- `toTaskView`（board-service.ts:1099）内联结构类型改为引用 `FrozenConfig`（或补 modelProvider?）。

### 5. 客户端

**ExecutionPanel.tsx**
- 两个模型 `<select>` 的 option value 改 `modelOptionValue(m.provider, m.id)`；
  `effectiveModel/effectiveAiModel` 回落「目录第一项的复合值」；目录为空时为 ''。
- onDispatch 解码：`parseModelOptionValue(effectiveModel)` → frozenConfig
  `{ mcp, skills, model, ...(p ? {modelProvider:p} : {}) }`。
- FREEZE 预览增供应商显示名（`providerLabel`）。
- 表单不持久化，无旧值兼容负担。

**TaskCenter.tsx TaskEditDialog**
- state 增 `modelProvider`（初值 `t.frozenConfig.modelProvider ?? ''`）；
  select value 用复合值；当任务是旧裸值（model 非空、provider 空）时追加一个
  `<option value={JSON 旧值编码? }>`——实现为：旧裸值直接作为 select 的一个 legacy option，
  value 约定为 `modelOptionValue('', model)`（provider 空串），解码后 provider='' 即「未绑定」，
  文案「{model}（未绑定供应商，沿用会话供应商）」。
- onSave 传 `modelProvider: model ? provider : undefined`（model 清空时 provider 一并清空）。
- 列表行（TaskCenter.tsx:1099）显示 `供应商名 / 模型`，未绑定显示「模型（未绑定供应商）」。

**RoleSettings.tsx**
- 默认模型控件由 MultiSelect 换为与执行面板同口径的分组原生 `<select>`（含「未指定」项 + 旧裸值项）；
- onChange 同时写 `defaultModel` 与 `defaultModelProvider`；保存时 provider 空则删除该键
  （onSave 前 normalize：`defaultModelProvider: p || undefined`）。
- `buildModelItems` 删除（其跨 provider 按 id 去重正是本缺陷的设计化身）；ui-dedup.spec 同步改测
  `groupModelOptions`。

**TaskDetailDialog.tsx**：冻结配置区按 AC4.1 显示。

**slots.tsx（US5）**
```ts
dispatch: async (req, taskId, target) => {
  const res = await bridge.dispatch(req, taskId, target)
  if (res.ok) await reloadBoard()
  return res
},
```
另增 effect：`useEffect(() => { if (tab === 'tasks') void reloadBoard() }, [tab])`
（挂载时 1140 已有一次拉取，重复一次本地读无害；用 visited/tab 双条件避免无谓调用——
仅在 tasks 已访问后切入时拉取）。

**SidePanel.tsx**：actions.dispatch 包一层，ok 后调用既有 `reloadBoard()`（138-143）。

### 6. 测试

- `tests/model-route.spec.ts`（新）：编解码往返、非法值返回 undefined、分组去重与顺序、
  providerLabel 回落。
- `tests/dispatch.spec.ts`：
  - frozenConfig 带 `{model:'deepseek-v4-flash', modelProvider:'arkcode'}` →
    `agentOptions` 深等于 `{ provider:'arkcode', model:'deepseek-v4-flash' }`（断言顺序无关用 toMatchObject 或 toEqual）；
  - 只有 model → 仅 `{model}`（旧语义不回归）；
  - 都空 → 无 model/provider 键（既有用例保留）；
  - provider 有值、model 空 → 不出现 provider 键（成对不变量）。
  - `resolveFrozenModelRoute` 表驱动：frozen 优先于 role、role 对成对、trim、空串归一。
- `tests/board.spec.ts:155/158` decompose 断言：角色带 defaultModelProvider 时 frozenConfig 含该键；
  不带时形状仍为 `{mcp,skills,model}`（既有 toEqual 不破坏）。
- `tests/edit-capability.spec.ts`：updateTask 改 modelProvider 落盘/比较/bump；
  非法 provider（非字符串）抛错；空串清除且不写键。
- `tests/board-service.spec.ts`：updateTask 部分传参时 provider 与 model 同口径保持；
  createManualTask 透传 provider。
- `tests/host-api.spec.ts` / `host-api-task-run.spec.ts`：派发落盘任务含 modelProvider；
  role 默认 provider 回落（新增用例）。
- `tests/ui-dedup.spec.ts`：buildModelItems describe 替换为 groupModelOptions 用例
  （跨 provider 同 id 保留为两项、同 provider 去重、顺序）。

## Verification & Rollout

1. `npm test`（vitest 全量）全绿。
2. 三道 tsc：`tsc -p tsconfig.host.json`、`tsconfig.client.json`、`tsconfig.tests.json` 零错误
   （以 package.json 实际脚本为准）。
3. `npm run build`（tsdown）通过。
4. 手工：本机 settings.yaml 已具备 arkcode（火山方舟）与 nvida（英伟达）；
   执行配置选 arkcode/deepseek-v4-flash 派发 → 看板 attempt 的 provider 列为 arkcode、
   子会话模型切换提示为火山方舟；派发后直接切任务中心，新任务即时出现且角标 +1。
5. 回归：旧 board.json/roles.json（裸 model）加载正常、派发行为同现状（继承父会话供应商）。

## Risks / Mitigations

| 风险 | 缓解 |
| --- | --- |
| 旧数据/旧测试的 frozenConfig 无 modelProvider | 字段可选 + 空值不写键 + 旧语义保留；既有 toEqual 用例不需改动 |
| 目录重采后已选复合值失效（provider 下线） | 下拉按当前 options 校验值，失效时回落第一项（与现状 model 失效处理一致） |
| 角色页 UI 由 MultiSelect 换原生 select，交互变化 | 选项规模为模型目录（数十项），分组原生 select 与执行面板一致；可刷选需求由分组+浏览器原生搜索承担 |
| 切 Tab 拉取增加 I/O | getBoard 为本地 JSON 读（无 TFS、无 provider 请求），仅在切入 tasks 时触发 |

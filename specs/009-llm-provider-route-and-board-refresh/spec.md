# Feature Specification: LLM 供应商随模型成对路由 + 派发后任务中心即时可见

**Feature Branch**: `009-llm-provider-route-and-board-refresh`
**Created**: 2026-09-22
**Status**: 待评审（speckit specify 产物）
**Input**: User description:
> 1. 为什么我选择火山方舟的 deepseek-v4-flash 实际执行却是英伟达的 deepseek-v4-flash，请找到根本原因并解决问题。
> 2. 执行配置发起执行后任务中心需要刷新才能看到任务。

根因证据链（含宿主源码与本机配置行号）见同目录 `research.md`，本文只定义需求与验收标准。

---

## 零、问题定义（摘要）

**问题 1（路由错配）**：模型目录按「LLM 供应商（provider 路由 key）+ 模型 id」唯一标识，
但 UI 选项值、派发草稿、`FrozenConfig`、dispatcher 的 `agentOptions` 全链路只携带裸模型 id，
供应商在点击下拉项时即丢失。宿主 `resolveChildAgentOptions` 对未显式指定 provider 的子 agent
**继承父聊天会话的 LLM 供应商**，于是「火山方舟分组下的 deepseek-v4-flash」实际跑在父会话当前
供应商（用户现场为英伟达）上。角色默认模型存在同一缺陷（`role.provider` 是子智能体驱动名
`spawn`，并非 LLM 供应商，不能决定模型路由）。

**问题 2（刷新缺口）**：执行配置页 `dispatch` 成功后不触发看板快照刷新，而任务中心 Tab 保活、
无轮询、切 Tab 不拉取，导致新建任务必须手动点刷新才出现。

---

## 一、用户故事与验收标准

### US1：执行配置选择的模型供应商必须被真实执行

**As a** 从「执行配置」发起执行的用户，
**I want** 下拉中选定「火山方舟 / deepseek-v4-flash」后，子智能体真实走火山方舟路由，
**So that** 不会被静默改跑到英伟达等其它供应商上。

#### 验收标准

- **AC1.1（选项值不丢供应商）**：执行配置页「执行模型」与「AI 解析模型」两个下拉，
  每个选项的值唯一对应一个 `(provider, id)` 对；同一模型 id 被多个供应商暴露时，
  选择不同供应商分组下的同名项产生不同的提交值。
- **AC1.2（草稿与冻结配置携带供应商）**：发起执行的 `DispatchDraft.frozenConfig` 同时包含
  `model` 与 `modelProvider`；宿主创建的手工任务落盘 `board.json` 的 frozenConfig 中可见该 provider。
- **AC1.3（真实路由成对下发）**：dispatcher 调用 `ctx.subagents.start` 时，
  `agentOptions` 在 model 非空时为 `{ provider: modelProvider, model }`；
  宿主 `resolveChildAgentOptions` 合并后子 agent 的 provider 等于所选供应商、model 等于所选 id
  （以测试中断言 fake client 收到的 `agentOptions` 为准）。
- **AC1.4（provider 与 model 严格成对）**：model 为空时 agentOptions 不含 model 也不含 provider；
  modelProvider 为空（旧数据/未指定）时只传 model，维持「继承父会话供应商」的旧语义；
  不允许出现「有 provider 无 model」的组合。
- **AC1.5（冻结预览可见）**：执行配置页「派发时冻结」预览同时展示供应商显示名与模型 id。
- **AC1.6（默认选中确定化）**：未手动选择时，默认取目录第一个模型项，且携带该项自身的 provider，
  不再产生无 provider 的裸模型值（目录为空/降级时除外，此时模型字段为空、行为同旧版）。

### US2：角色默认模型绑定 LLM 供应商

**As a** 配置角色的用户，
**I want** 角色的默认模型也能指定来自哪个供应商，
**So that** 经角色默认模型回落发起的执行不会跑错供应商。

#### 验收标准

- **AC2.1（角色模型下拉按供应商区分）**：角色管理页「默认模型」不再按 id 跨供应商去重；
  同一 id 在不同供应商下是可分别选择的选项，选中后 `RoleDefinition` 同时保存
  `defaultModel` 与 `defaultModelProvider`。
- **AC2.2（回落成对）**：任务冻结配置未覆盖模型时，三处派发入口（执行配置派发、追问、
  看板 start/retry）按「任务冻结 → 角色默认 → 空」同一口径回落，且 model 与 modelProvider
  始终取自同一层级，不允许 model 取自角色、provider 错配其它来源。
- **AC2.3（拆解继承）**：五段式拆解生成任务的 frozenConfig 携带角色的 defaultModelProvider。
- **AC2.4（旧角色兼容）**：roles.json 中只有裸 defaultModel、无 defaultModelProvider 的旧角色
  正常加载与派发（继承父会话供应商）；角色编辑表单对该类旧值显示「未绑定供应商」提示项，
  重新保存后即绑定供应商。

### US3：任务编辑弹框可修改模型供应商

**As a** 在任务中心编辑拆解任务的用户，
**I want**「模型（写进冻结配置）」下拉的选择包含供应商维度，
**So that** 改模型时不会把供应商信息改错或丢掉。

#### 验收标准

- **AC3.1**：任务编辑弹框保存后，任务 frozenConfig 的 model/modelProvider 与下拉所选
  `(provider, id)` 对一致；选「不指定」时两者同时清空。
- **AC3.2**：乐观锁、整体替换语义、技能/MCP 编辑行为与现状一致，不因新增字段改变。
- **AC3.3**：旧任务（裸 model）打开弹框时可见一个「未绑定供应商」的当前值选项，不被静默
  替换成其它供应商下的同名模型。

### US4：供应商在任务列表与详情中可见

**As a** 任务中心的使用者，
**I want** 直接看出每个任务冻结的是哪家供应商的模型，
**So that** 错配在派发前就能被肉眼发现。

#### 验收标准

- **AC4.1**：任务列表「模型」行、任务详情对话框「冻结配置」区在已绑定供应商时显示
  「供应商显示名 / 模型 id」；未绑定时显示「模型 id（未绑定供应商，沿用会话供应商）」。

### US5：派发后任务中心即时可见，无需手动刷新

**As a** 在执行配置页发起执行的用户，
**I want** 切到任务中心立刻看到刚创建的任务（含 Tab 角标计数 +1），
**So that** 不需要记得手动点刷新。

#### 验收标准

- **AC5.1（中央工作台）**：执行配置页 dispatch 返回 `ok` 后，看板快照自动重新拉取一次；
  随后切到任务中心，新任务及其初始状态立即可见，「任务中心(n)」角标同步更新。
- **AC5.2（右栏）**：右栏 SidePanel 内执行配置 dispatch 成功后，其任务列表同样自动刷新。
- **AC5.3（切 Tab 兜底）**：每次切入「任务中心」Tab 都拉取一次最新看板快照
  （本地读，无 TFS 压力），覆盖异步状态流转与其它入口遗漏。
- **AC5.4（失败不误刷）**：dispatch 返回失败时不改变当前看板视图，错误提示行为同现状。
- **AC5.5（不引入轮询）**：本变更不新增看板定时轮询；批量派发循环内既有的快照拉取保持不变。

---

## 二、范围

### In scope

- 插件全链路（共享契约 / 客户端 4 个组件 / 宿主 api / dispatcher / 看板引擎 / board-service / 拆解纯函数）携带 LLM provider。
- 派发成功后的看板即时刷新（中央 + 右栏 + Tab 切入兜底）。
- 配套单元测试更新与新增。

### Out of scope

- 宿主 `resolveChildAgentOptions` / AgentOptions 语义改动（宿主行为正确，缺陷在插件未传 provider）。
- 已落盘旧数据的批量迁移（可选字段 + 旧语义保留即足够）。
- AI 解析（`actions.parse`）宿主接线：当前 workbench 挂载中该动作未接线（按钮恒禁用），
  本次仅保证其下拉值口径与执行模型一致，不新增宿主路由。
- 看板定时轮询、执行中任务状态的实时推送。

---

## 三、数据模型变更（摘要，详见 plan.md）

```ts
// src/shared/contracts.ts
interface FrozenConfig {
  mcp: string[]
  skills: string[]
  model: string
  /** LLM 供应商路由 key（= llm.listProviders() 的 id，如 arkcode）；仅在 model 非空时有意义。
   *  缺省 = 旧数据/未指定，子 agent 继承父会话供应商。 */
  modelProvider?: string
}

interface RoleDefinition {
  // ...既有字段
  /** 默认模型的 LLM 供应商路由 key，与 defaultModel 成对；缺省 = 继承父会话供应商。 */
  defaultModelProvider?: string
}

interface UpdateTaskInput {
  // ...既有字段
  modelProvider?: string
}
```

落盘形状约束：provider 为空串/纯空白时**不写键**，旧 JSON 形状（`{mcp,skills,model}`）保持稳定。

---

## 四、成功判据

1. 单测：dispatcher 在 `(arkcode, deepseek-v4-flash)` 输入下断言 `agentOptions.provider === 'arkcode'`；
   裸 model 输入断言不含 provider；三处回落口径有表驱动用例。
2. 单测：模型复合值编解码 / 分组 / 旧裸值识别纯函数有用例。
3. 既有测试套件全绿（`npm test` / 宿主侧 vitest 全量）。
4. `npm run typecheck`（host + client + tests 三套 tsconfig）零错误。
5. 手工验证（本机 settings.yaml 含 arkcode 与 nvida）：执行配置选火山方舟 deepseek-v4-flash 派发，
   任务 attempt 回绑 provider 为 arkcode（看板 attempts[].provider / 子会话模型切换提示）；
   派发后不切页、直接点任务中心 Tab，新任务即时出现。

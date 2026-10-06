# Research: LLM 供应商路由丢失 + 任务中心派发后不刷新

**Change**: 009-llm-provider-route-and-board-refresh
**Date**: 2026-09-22
**Method**: 代码走读（插件 + 宿主源码双向印证）+ 本机部署配置（`C:\Users\user\.dsh\settings.yaml`）+ 看板落盘数据（`.tfs-requirment-data\board.json`）

---

## 一、问题 1：选「火山方舟 deepseek-v4-flash」实际跑在英伟达上

### 1.1 部署侧事实：同名模型在多个 LLM provider 下并存

`C:\Users\user\.dsh\settings.yaml` 的 `llm-pi-ai.profiles` 配置了 4 条独立路由：

| 路由 key（= AgentOptions.provider） | displayName | baseURL | 是否含裸 id `deepseek-v4-flash` |
| --- | --- | --- | --- |
| `arkcode`（settings.yaml:32-66） | 火山方舟 | ark.cn-beijing.volces.com | 是（settings.yaml:61） |
| `nvida`（settings.yaml:134-192） | 英伟达 | integrate.api.nvidia.com | 否，只有 `deepseek-ai/deepseek-v4-flash-0731`（settings.yaml:151） |
| `siliconflow` | 硅基流动 | api.siliconflow.cn | 否 |
| `wincode` | wincode | wincode.winning.com.cn/openai/v1 | 否 |

另有 `llm-deepseek`（settings.yaml:14-27，路由 key `deepseek-official`，见 `dsh-service-subagent-route.json`）也含裸 id `deepseek-v4-flash`（settings.yaml:22）。

宿主模型目录的唯一性口径是 **provider + id**，不是 id 全局唯一：
- 插件契约自述：`src/shared/contracts.ts:111`「id 全局唯一性由 provider + id 保证」。
- 角色页注释也实测记录了跨 provider 重名：`src/client/components/RoleSettings.tsx:74-76`。

### 1.2 根因链路（provider 在 5 个环节被逐层丢弃，最终子 agent 继承父会话 provider）

1. **目录枚举正确**：`src/host/dsh-catalog.ts:190-198` 产出的 `DshModelOption` 同时带 `provider`（路由 key）与 `id`，UI 也按 provider 分组渲染（`ExecutionPanel.tsx:511-520`）。

2. **UI 选项值只保留模型 id**：`src/client/components/ExecutionPanel.tsx:515`
   ```tsx
   <option key={`${m.provider}/${m.id}`} value={m.id}>   // ← key 有 provider，value 没有
   ```
   下拉里「火山方舟 / deepseek-v4-flash」与其它 provider 分组下的同名项，提交值完全相同，分组信息在用户点击的瞬间丢失。
   任务编辑弹框同一缺陷：`src/client/components/TaskCenter.tsx:1721`（`value={m.id}`）。

3. **派发草稿不携带 provider**：`ExecutionPanel.tsx:276` 构造的 `frozenConfig` 只有 `{ mcp, skills, model }`；契约 `FrozenConfig`（`src/shared/contracts.ts:99-106`）根本没有 provider 字段。

4. **宿主三处冻结配置组装都只有 model**：
   - 执行配置派发：`src/host/api.ts:530-534`
   - 追问：`src/host/api.ts:850-853`
   - 看板 start/retry 派发：`src/host/api.ts:1284-1288`

5. **dispatcher 只把裸 model 放进 agentOptions**：`src/orchestration/dispatch.ts:236-237`
   ```ts
   const model = req.frozenConfig.model?.trim()
   const agentOptions: AgentOptions = model ? ({ model } as AgentOptions) : ({} as AgentOptions)
   //                                            ↑ 只有 model，没有 provider
   ```

6. **宿主按「继承父会话 provider + requested 覆盖」合并**：
   `packages/subagent/subagent/src/child-agent.ts:109-116`（`resolveChildAgentOptions`）
   ```ts
   ...(parentProvider !== undefined ? { provider: parentProvider } : {}),  // 先继承父会话
   ...(parentModel !== undefined ? { model: parentModel } : {}),
   ...requested,                                                            // 只覆盖 model
   ```
   `AgentOptions.provider` 的语义是 LLM 路由 key，`model` 是「由所选 provider 适配器解释的模型 id」
   （`packages/core/agent/src/runtime-types.ts:27-30`）。
   插件的 parent 是用户当前顶层聊天会话（`src/host/parent-resolver.ts:73-97`），
   该会话当前用的是哪家 LLM（用户场景下是英伟达 `nvida`），子 agent 就落在哪家；
   裸 `deepseek-v4-flash` 被该 provider 适配器解释（pi-ai 按 provider 严格解析模型，
   `packages/llm/llm-pi-ai/src/adapter.ts:258-261`，未知 id 报 UNKNOWN_MODEL，
   动态发现/网关别名场景下则会落到该供应商的同名模型上）。

**宿主自己的不变量也要求 provider+model 成对出现**：
`packages/subagent/tool-subagent/src/model-selection.ts:112-114`
> child LLM `provider` and `model` must be supplied together

插件绕过 tool 直接调 `ctx.subagents.start`，却只传了 model，违反同一约束。

### 1.3 旁证：落盘数据里的失败任务符合同一机理

`.tfs-requirment-data/board.json` 中任务 `2004154@WN_HIS#manual-role-...-20260922093129`
冻结 `model: "glm-5-3-flash"`（该裸 id 仅存在于 `arkcode`，settings.yaml:63；
`nvida` 下只有 `z-ai/glm-5.3-flash`，settings.yaml:171），连续 3 次 attempt
`stopReason=error`、诊断「子智能体执行失败：模型或传输错误」——
正是"裸 id 被父会话 provider（nvida）解释 → 该 provider 无此模型"的表现。

### 1.4 同一根因的第二个实例：角色默认模型

- `RoleDefinition.defaultModel` 同样只有模型 id（`contracts.ts:39`），
  `RoleSettings.tsx:92-112` 的 `buildModelItems` 按 id 跨 provider 去重后存裸 id。
- `RoleSettings.tsx:78-80` 的注释声称「provider 由 role.provider 单独决定」——
  **这是概念混淆**：`role.provider` 是**子智能体驱动名**（`ctx.subagents.start` 的 name，
  本机为 `spawn`，见 RoleSettings.tsx:289 的 UI 文案），与 LLM 路由 provider（arkcode/nvida）
  是两条完全不同的轴，前者不可能决定后者。
- 角色默认模型经 `api.ts:533 / 852 / 1287` 回落进 frozenConfig，同样不带 LLM provider。

### 1.5 修复方向

沿「目录 → UI → 契约 → 落盘 → 派发」全链路把 LLM provider 与 model 成对携带：

1. 契约：`FrozenConfig.modelProvider?`、`RoleDefinition.defaultModelProvider?`、`UpdateTaskInput.modelProvider?`（均为可选，保证旧 board.json / roles.json 兼容）。
2. UI：模型下拉 option value 改为 provider+id 复合值（共享纯函数编解码，放 `src/shared/model-route.ts`）；执行面板、任务编辑弹框、角色默认模型三处统一；展示位显示 provider。
3. 宿主：新增 `resolveFrozenModelRoute({ frozen, role })` 单一回落口径（任务冻结 → 角色默认 → 空=完全继承），三处组装点共用；dispatcher 在 model 非空时成对传 `{ provider, model }`，provider 绝不脱离 model 单独出现。
4. 拆解：`decompose.ts` 的 `frozenOf` 透传 `defaultModelProvider`。
5. 引擎：`Board.updateTask` 校验/比较/落盘 `modelProvider`（空串归一化为不写入，保持旧 JSON 形状稳定）。
6. 旧数据语义：只有裸 model、无 provider 时维持现状（继承父会话 provider），UI 明确标注「未绑定供应商，将沿用当前会话」。

---

## 二、问题 2：执行配置发起执行后，任务中心必须手动刷新才出现任务

### 2.1 数据流事实

- 中央工作台五个 Tab 首次访问后**保活、只隐藏不卸载**（`src/client/slots.tsx:858-872`）。
- 任务中心 `TaskCenter` 是纯受控组件，**自身无任何轮询/定时刷新**（`TaskCenter.tsx` 中无 setInterval）；
  看板快照 `board` 由 slots 持有，只在以下时机刷新（`reloadBoard()`，slots.tsx:885-891）：
  工作台挂载时（1140）、需求池领取/集合切换（1261/1279）、任务中心内自己的动作
  （派发 1334、追问 1316、拆解、还原、删除等）。
- 看板**没有周期性轮询**：slots.tsx 中唯一的 setInterval 是能力目录轮询（936-945）。

### 2.2 根因

执行配置页的 dispatch 动作是唯一**成功后不刷新看板**的写操作入口：

`src/client/slots.tsx:1170`
```ts
dispatch: (req, taskId, target) => bridge.dispatch(req, taskId, target),
// ↓ 宿主已 createManualTask 落库（api.ts:566-577），但客户端 board 状态不更新
```

对比同类入口全部 `await reloadBoard()`：任务中心行内派发 slots.tsx:1333-1334、
追问 1314-1317、领取 1279、角色保存 1385。切 Tab 也不会触发拉取（保活设计，setTab 只改 visited）。
于是用户在执行配置页派发后切到任务中心，看到的还是派发前的快照（Tab 角标计数
`任务中心(${board.tasks.length})` slots.tsx:1423 同样是旧值），必须点任务中心的手动刷新
（onRefresh=reloadBoard，slots.tsx:1294）才出现新任务。

右栏 `SidePanel` 的 ExecutionPanel dispatch 同样不刷新：`src/client/components/SidePanel.tsx:171`
（其就地派发 `dispatchTask` 倒是有 reloadBoard，SidePanel.tsx:216）。

### 2.3 修复方向

1. slots.tsx 的 `actions.dispatch` 与 SidePanel 的 `actions.dispatch`：bridge 返回 `ok` 后 `reloadBoard()`，与其它写入口径一致。
2. 兜底：切到「任务中心」Tab 时拉一次快照（覆盖状态异步流转、其它入口遗漏等场景；getBoard 为本地读，成本可忽略）。
3. 不引入看板定时轮询（与既有设计一致：状态推进依赖动作后刷新；批量派发循环内已自行 getBoard）。

---

## 三、受影响文件清单（证据 → 改动）

| 文件 | 现状证据 | 改动 |
| --- | --- | --- |
| `src/shared/contracts.ts` | FrozenConfig:99-106、RoleDefinition:33-48、UpdateTaskInput:1327-1341 | 加可选 modelProvider / defaultModelProvider |
| `src/shared/model-route.ts` | 不存在 | 新增：复合值编解码、分组、查找纯函数 |
| `src/client/components/ExecutionPanel.tsx` | option value=m.id:515；frozenConfig:276；FREEZE:458 | 复合值、提交 provider、预览显示供应商 |
| `src/client/components/TaskCenter.tsx` | option value=m.id:1721；保存:1762-1770；列表:1099 | 编辑弹框带 provider；列表/详情显示供应商 |
| `src/client/components/RoleSettings.tsx` | buildModelItems:92-112（按 id 去重）；MultiSelect:332-339 | 改为按 provider 分组的单选，存 defaultModelProvider |
| `src/client/components/TaskDetailDialog.tsx` | 模型展示:226 | 显示供应商 |
| `src/client/slots.tsx` | dispatch 不刷新:1170 | ok 后 reloadBoard；切 tasks Tab 自动刷新 |
| `src/client/components/SidePanel.tsx` | dispatch 不刷新:171 | ok 后 reloadBoard |
| `src/host/api.ts` | 530-534 / 734 / 850-853 / 1191-1194 / 1284-1288 | 共用路由回落 helper；updateTask 校验 modelProvider |
| `src/orchestration/dispatch.ts` | agentOptions 只有 model:236-237 | 成对传 provider+model；导出 resolveFrozenModelRoute |
| `src/core/board/decompose.ts` | frozenOf:30-37 | 透传 defaultModelProvider |
| `src/core/board/board.ts` | frozenConfig 校验/比较/写入:739-755 | 校验/比较/归一化 modelProvider |
| `src/host/board-service.ts` | updateTask:808-853；toTaskView:1099/1125 | patch 与视图透传 modelProvider |
| `tests/*` | dispatch.spec、edit-capability.spec、board.spec、ui-dedup.spec 等 | 新增 provider 路由用例；更新模型下拉用例 |

## 四、兼容性与风险

- `modelProvider` / `defaultModelProvider` 全部**可选**；旧 board.json、roles.json 裸 model 语义不变（继承父会话 provider），不做数据迁移。
- 序列化时 provider 为空串一律不写键，保证 frozenConfig JSON 形状与旧测试/旧数据一致。
- provider 与 model 严格成对：provider 仅在 model 非空时传入 agentOptions，避免「provider 覆盖 + model 继承」的新错配。
- provider 真实性交给宿主在调用时校验（未知 provider 由 LLM 层报错，经既有 stopReason=error 收口落盘），插件不做可能误伤的目录预检。

# Spec 004：能力目录实时化、需求/任务编辑与勾选批量派发

日期：2026-09-20
状态：已实现（implement 完成，verify 见 §7）
前置：001（REST 化）、002（需求池三项修复）、003（Tab 保活 / 拆解修复 / 技能目录补全 / 34 契约端点）

## 0. 用户提出的七个问题

| # | 位置 | 用户原话（摘要） |
|---|---|---|
| 1 | 执行配置 → 技能选择 | 下拉数据源不全；用户级技能就有 89 条；没有实时拉取 dsh 最新添加的技能 |
| 2 | 执行配置 → MCP 选择 | 下拉数据源不全，且没有实时拉取最新添加的 MCP |
| 3 | 任务中心 → 已领取需求 | 缺少编辑选项：增加提示词、切换工作目录 |
| 4 | 任务中心 → 拆解的任务列表 | 缺少编辑选项：增加提示词、切换模型、选择技能、MCP |
| 5 | 任务中心 → 拆解的任务列表 | 缺少勾选任务启动/派发；有依赖的必须等依赖完成才能开始 |
| 6 | 需求池 → 领取入池 | 需要弹框选择工作目录 + 增加提示词 |
| 7 | 角色管理 → 默认模型 | 勾选一个后同一项出现六次；勾选第二个出现三次；且第一个无法删除 |

## 1. 逐条根因（全部带 code 证据，非推断）

### 问题 1 / 2：能力目录「不全 + 不实时」

**证据链（三段，缺一不可）**

1. **面板数据只在挂载时取一次内存快照。**
   `src/client/slots.tsx:781-789`（`Workbench` 的挂载 effect）只调 `reload()` →
   `bridge.getPanelData()`（`src/client/slots.tsx:249-259`），后者 `GET /tfs-requirment/panel-data`。
   宿主侧该路由**只读内存快照**：`src/host/api.ts:296-319` 里 `deps.catalog?.current()`。
2. **中央工作台从不触发目录重采。**
   全仓 `refreshPanelData` 的消费点只有一处：`src/client/components/SidePanel.tsx:151`
   （**右侧栏**的 TFS 执行页）。中央「TFS 看板」工作台的五个 Tab 没有任何调用点 ——
   即 `HostBridge.refreshPanelData`（`src/shared/contracts.ts:308`）在中央面板上是**死代码**。
3. **宿主侧只采一次。**
   `src/index.ts:363-368` 用 `ctx.inject(['llm','skills','agentPresets','workspaceRegistry','subagents'],() => void catalog.refresh())`
   触发**唯一一次**自动采集；此后只有 `POST /catalog-refresh`（`src/host/route.ts:38-45`）能重采。

**结论**：用户"先打开插件、后装技能 / 加 MCP / 加模型（或先启动 dsh 但还没挂载 standard preset）"
的场景下，下拉永远停留在首次采集那一刻的结果 —— 与用户描述完全一致。

**技能项额外的时序事实（001/003 已记录，此处复核 + 2026-09-20 实测坐实）**
`src/host/dsh-catalog.ts:244-286` 的 `collectSkills` 除全局层 `skills.list({})` 外，还会遍历
`livePresetMounts()`（`packages/preset/agent-presets/src/mount.ts:127-136` 的 `PresetMount.key`）
逐作用域取用户级技能。003 已实测：`~/.agents/skills` 实有 96 个用户级技能目录。

**关键补充（本次实测）**：这些挂载是**按需**建立的 —— 宿主 `agent-presets` 的
`ensureStanding(preset)` 只在**某个 agent 加入该预设时**才 `await mountPreset(...)`
（`packages/preset/agent-presets/src/index.ts:814`）。因此：

- dsh 进程刚起、还没有任何会话时 `livePresetMounts()` 返回 **`[]`**，
  插件在 `apply` 期采到的技能**只有全局层**；
- 2026-09-20 对真实宿主（dsh 0.1.5-rc.2）实测：`panel-data` 返回 **23** 项技能，
  `source` **全部是 `bundled`**，`catalogWarnings` 为 **空数组**，
  而 `~/.agents/skills` 实有 **96** 个技能目录；
- 用户开始会话（挂载建立）后，旧实现**没有任何机制会重新采集**，下拉永远停在 23 项。

⇒ 问题 1 的"不全"与"不实时"**同一个根因**：采集时机 + 无重采入口 + 降级不可见。

**MCP 项**：`collectMcpServers`（`src/host/dsh-catalog.ts:364-374`）从
`ctx.tools.schemas()` 的 `mcp__<server>__` 前缀反推。已核实 `ToolRuntime.schemas(scope?)`
（`packages/core/tools/src/index.ts:1240-1242`）走 `view(scope)`，而 `view` 恒先并入
`this.layers.global.tools`（同文件 `:1167`），mcp-client 经 `ctx.tools.register()`
（`packages/mcp/mcp-client/src/tools.ts:150`）注册到 `this.layers.effect(this.ctx, …)`
即全局层 ⇒ **枚举通路本身是对的**，缺的只是"什么时候再枚举一次"。

2026-09-20 真实宿主实测（同一进程两次采样）：

| 采样点 | MCP 清单 |
|---|---|
| 首次采集（apply 期内存快照） | `winex_peis_knowledge`（1 项） |
| `POST /tfs-requirment/catalog-refresh` 后 | `ragflow`、`winex_peis_knowledge`（2 项） |

即面板打开时看到的 MCP 比宿主实际注册的**少 1 个**，重采即补齐 —— 与用户描述一致。
故问题 2 = 问题 1 的同一根因（快照不刷新 + 无重采入口）。

### 问题 7：MultiSelect 重复项

**证据**：`src/client/components/MultiSelect.tsx:132-135`

```ts
const selected = useMemo(() => {
  const set = new Set(props.value)
  return props.options.filter(o => set.has(o.value)).map(o => o.value)   // ← 未按 value 去重
}, [props.options, props.value])
```

`props.options` 里若存在**多个相同 `value` 的选项**，`selected` 就会产出多个相同值，
于是：
- chip 列表 `[...selected, ...orphan].map(v => <span key={v}>…)`（`:201-216`）渲染出 N 个
  **同 key 同内容**的 chip，并触发 React "duplicate key" 警告；
- 下拉面板 `filtered.map(o => <label key={o.value}>…)`（`:266-279`）渲染出 N 个同名行，
  勾选状态由 `selected.includes(o.value)` 决定 ⇒ 一次勾选让 N 行同时变蓝（用户看到"出现六次/三次"）。

**重复从哪来**：`src/client/components/RoleSettings.tsx:109-112`

```ts
const modelItems = useMemo(
  () => modelOptions.map(m => ({ value: m.id, label: m.name || m.id, hint: m.providerName })),
  [modelOptions],
)
```

`DshModelOption`（`src/shared/contracts.ts:114-125`）的 `id` 只在**单个 provider 内**唯一，
跨 provider 可重复 —— 本机 `E:\UserAgentData\.dsh\settings.yaml` 实测同一 `id`
出现在多个 provider 的 models 列表里（如 `deepseek-v4-flash-0731`、
`qwen3.7-plus`、`qwen3.8-flash`、`glm-5.3-flash` 同时属于 `deepseek-official` 与 `wincode`；
`subagent-model-selection.allowedModels` 里还并列了 12 条同族条目）。
同一 `id` 被 K 个 provider 暴露 ⇒ 该 id 的 chip 出现 K 次。
`MultiSelect` 的 `max={1}` 单选模式（`:157-160`）只约束"值列表长度"，**挡不住选项重复**。

**"第一个无法删除"**：`remove(v)`（`:166-168`）按 value 过滤，逻辑上会清空该值的全部副本；
但 N 个同 key 的 chip 让 React 复用/错配 DOM 节点，用户点第一个 chip 的 × 时命中的可能是
另一份 fiber，表现为"点了没反应"。去重后该现象消失（§7 E2E-7 断言）。

**修复口径**：值语义是"模型 id"（`RoleDefinition.defaultModel: string`，
派发时作 `GenerateOptions.model`，provider 由 `role.provider` 决定），
故同一 id 不应出现多次 ⇒ 按 `value` 去重，并把 provider 名合并进 `hint`（信息不丢）。

### 问题 6 / 3 / 4：编辑能力缺失

**问题 6**：`RequirementPool` 的领取入口 `claim(item)`（`src/client/components/RequirementPool.tsx:347-368`）
直接提交，**没有任何弹框**；工作目录只有一个全局文本框（`:480-485`，一次填写影响之后所有领取），
提示词字段在整个契约里根本不存在（`ClaimRequirementInput`，`src/shared/contracts.ts:680-698` 无 `prompt`）。

**问题 3**：已领取需求行只有「重新拆解 / 选为目标 / 还原到需求池」三个按钮
（`src/client/components/TaskCenter.tsx:406-438`），没有编辑入口。
`BoardService` 也没有"改需求本地字段"的方法（`src/host/board-service.ts` 仅
`claimRequirement` / `enrichRequirement` / `restoreRequirement`，见 `:299-484`）。
唯一能改 workspace 的路径是「重新领取」，而 `Board.claimRequirement`
（`src/core/board/board.ts:92-99`）对已存在键**直接返回 false 不更新** ⇒ 用户改不了。

**问题 4**：任务行只有「派发执行 + 状态动作 + 删除」（`TaskCenter.tsx:661-701`），
没有编辑。`TaskSnapshot`（`src/core/board/task.ts:36-68`）里没有 `prompt` 字段，
`Board` 也没有 update 类方法（只有 `assignTask` / `transition` / `startTask` / `finishTask`）。
派发时的 prompt 是**硬拼**的：`src/client/slots.tsx:950` `prompt: \`${t.title}\n\n${t.description}\``
⇒ 用户无法为某个任务单独写执行提示词。

### 问题 5：无勾选 / 无批量 / 无依赖顺序

**证据**：`TaskCenter.tsx` 的复选框只服务于"批量删除已取消任务"
（`:166` `selectedDeleted`、`:555-565` 表头全选、`:585-596` 行内复选框），
判定条件是 `deletable = t.state === 'deleted' && !!props.onDeleteTasks`（`:582`）；
派发只有单行按钮（`:662-675`）。`HostBridge` 没有任何批量派发入口。

依赖顺序：引擎层已有 `Board.isReady`（`src/core/board/board.ts:298-302`）与
`Board.startTask` 的依赖门禁（`:352-357`，依赖未就绪抛
`${taskId} 依赖未就绪：…`），`dispatch` 也会把它转成 `ok:false`
（`src/host/api.ts:433-438`）。**约束在引擎里已经成立**，缺的是"选中一批 → 按 DAG 分波
依序派发"的编排：用户逐个点会撞上"依赖未就绪"的报错。

## 2. 需求（FR）

- **FR-401** 中央工作台在首次进入「执行配置」「角色管理」Tab 时，以及点击面板内
  「重新采集目录」按钮时，必须触发 `POST /tfs-requirment/catalog-refresh` 并刷新面板数据。
- **FR-402** 目录重采必须**并发去重**且失败降级：重采失败时保留上一份快照，不清空下拉。
- **FR-403** MultiSelect 的选项与已选值都必须按 `value` 去重；重复 `value` 不得产生
  重复 chip、重复下拉行或重复 React key；去重后信息（provider 名）合并进 `hint` 保留。
- **FR-404** `ClaimRequirementInput` 增加 `prompt?: string`；需求池「领取入池」必须弹框，
  可选择工作目录（来自 dsh 真实工作区清单）并填写提示词。
- **FR-405** 需求摘要与看板需求必须持久化 `prompt` 与 `workspace`，跨重启保留。
- **FR-406** 任务中心「已领取需求」行提供「编辑」：修改该需求的提示词与工作目录。
  工作目录沿用 fail-loud 校验（绝对路径 + 真实存在且为目录）。
- **FR-407** `TaskSnapshot` 增加 `prompt?: string`；任务中心任务行提供「编辑」：
  修改提示词、模型、技能、MCP（写回 `frozenConfig`）与工作目录，走 revision 乐观锁。
- **FR-408** 派发时的 prompt 组装顺序固定为：
  `[工作目录上下文]` → `[需求级提示词]` → `[任务级提示词]`（或回落 `title\n\ndescription`），
  空段不产出空行。
- **FR-409** 任务表提供勾选列（`pending` 或 `in_progress` 任务可勾）与「批量派发执行」按钮；
  批量派发按 DAG **分波**执行：一波内并行，**依赖未 completed 的任务必须等前一波完成**。
- **FR-410** 批量派发必须能给出**可读的卡住原因**（依赖任务不存在 / 依赖任务已取消 /
  依赖任务未在本次选中且未完成），且不得静默什么都不做。
- **FR-411** 批量派发过程中必须可见进度（已派发/剩余/等待），且轮询有上界，不会无限挂住。

## 3. 非目标

- 不改 TFS 侧的写门禁与四道门禁口径。
- 不为子代理引入 per-task cwd（宿主无该字段，见 `src/shared/workspace.ts:1-17` 的边界说明）。
- 不新增 MCP 渲染层的增删实例能力（`dsh-mcp-client` 无运行期增删 API）。

## 4. 关键设计决策

| 决策 | 理由 |
|---|---|
| 目录重采放在**中央工作台**的 Tab 激活点 + 手动按钮，而非定时轮询 | 定时轮询会周期性打 `llm.listModels()` × N provider；Tab 激活点覆盖"用户要看下拉"的真实时刻，且与 003 的 Tab 保活机制天然契合 |
| 需求级提示词存在 `Requirement.prompt`，派发时**实时读取**而非复制进任务 | 需求提示词改了要立刻对未派发任务生效；复制进任务会制造两份真相 |
| 任务级提示词存 `TaskSnapshot.prompt` | 任务粒度覆盖：同一需求下三个任务可以各有不同提示词 |
| 批量派发编排放在**客户端**（复用既有 `dispatch` 路由 + `getBoard` 轮询） | 无需引入宿主侧长驻任务/长连接；进度天然对 UI 可见；每波只调一次已有路由，写路径不变 |
| 分波纯逻辑下沉 `src/shared/batch-dispatch.ts` | 客户端无 React 测试库（项目既有纪律），纯函数才能被 vitest 覆盖 |

## 5. 数据模型增量

```
Requirement        += prompt?: string
RequirementSummary += prompt?: string
ClaimRequirementInput += prompt?: string
TaskSnapshot       += prompt?: string
TaskDraft          += prompt?: string
BoardTaskView      += prompt?: string
ExecutionPanelData += dispatchConcurrency?: number
UpdateRequirementInput = { requirementKey; workspace?: string|null; prompt?: string|null }
UpdateTaskInput        = { taskId; prompt?; model?; skills?; mcp?; workspace?; expectedRevision? }
```

## 6. 新增路由

| 路由 | 方法 | 语义 |
|---|---|---|
| `/tfs-requirment/requirement-update` | POST | 改已领取需求的本地字段（prompt / workspace） |
| `/tfs-requirment/task-update` | POST | 改任务的 prompt / frozenConfig / workspace（revision 乐观锁） |

## 7. 验收（verify）

见 `tasks.md` 的 T-V* 与实现后的实测段落；结论写入 `plan.md` 的「验证记录」。

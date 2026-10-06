# Plan 004：实现方案

前置：`spec.md`（根因与需求）。本文件只讲**怎么改、改哪里**。

## 1. 变更清单（按文件）

| 文件 | 变更 | 对应 FR |
|---|---|---|
| `src/core/board/task.ts` | `TaskSnapshot` 增 `prompt?: string` | FR-407 |
| `src/core/board/board.ts` | `TaskDraft.prompt?`；`addTask` 落 prompt；新增 `updateTask(taskId, patch, expectedRevision)` | FR-407 |
| `src/core/board/decompose.ts` | **不改**：需求级提示词不复制进任务，派发时实时读取（避免两份真相；见 §2.3） | FR-405/408 |
| `src/tfs/types.ts` | `Requirement.prompt?: string` | FR-405 |
| `src/shared/contracts.ts` | 见 spec §5 的类型增量 + 两条路由 + `HostBridge.updateRequirement/updateTask` | FR-404…409 |
| `src/shared/batch-dispatch.ts`（新） | `planBatchStep` / `isSettled` / `batchStepText`（纯函数） | FR-409/410/411 |
| `src/host/board-service.ts` | `summaryToRequirement`/`requirementToSummary` 带 `prompt`；`claimRequirement` 接收 `prompt`；新增 `updateRequirementMeta` / `updateTask`；`toTaskView` 带 `prompt` | FR-405/406/407 |
| `src/host/api.ts` | 暴露 `updateRequirement`/`updateTask`；`dispatch` 改为三段式 prompt 组装；`getPanelData.dispatchConcurrency` | FR-406/407/408 |
| `src/host/route.ts` | 两条新路由 + 注册 | FR-406/407 |
| `src/index.ts` | 传 `dispatchConcurrency: config.maxConcurrentRequirements` | FR-409 |
| `src/client/components/MultiSelect.tsx` | `options` 按 `value` 去重（渲染 + selected 双保险） | FR-403 |
| `src/client/components/RoleSettings.tsx` | `modelItems` 按 `value` 去重并合并 provider hint | FR-403 |
| `src/client/components/ExecutionPanel.tsx` | `groupedModels` 去重；新增 `onRefreshCatalog` + 「重新采集目录」按钮；空目录提示带上 `warnings` | FR-401/403 |
| `src/client/components/TaskCenter.tsx` | 需求行「编辑」弹框；任务行「编辑」弹框；任务勾选列 + 「批量派发执行」；进度条 | FR-406/407/409/410/411 |
| `src/client/components/RequirementPool.tsx` | 「领取入池」改为弹框（工作目录 + 提示词） | FR-404 |
| `src/client/slots.tsx` | 接线新回调；`dispatchBatch` 分波轮询；Tab 激活触发 `refreshPanelData` | FR-401/402/409 |

## 2. 关键实现要点

### 2.1 目录重采（FR-401/402）

`Workbench` 已有 Tab 保活机制（`visited` map，`slots.tsx:729-739`）。复用同一点：

```ts
useEffect(() => {
  if (!visited.exec && !visited.roles) return
  void bridge.refreshPanelData().then(setData)
}, [visited.exec, visited.roles])
```

- 并发去重由宿主 `DshCatalog.refresh()` 的 `inflight` 保证（`src/host/dsh-catalog.ts:391-404`）；
- 失败降级由 `HttpHostBridge.refreshPanelData` 的 `catch → this.getPanelData()` 保证
  （`src/client/slots.tsx:276-282`），**不覆盖已有 data**；
- 额外提供手动按钮，用于"面板已打开时新装技能"的场景。

### 2.2 去重（FR-403）

两处，互为保险：

1. `MultiSelect` 内部把 `props.options` 按 `value` 首次出现去重（保留首个标签/hint），
   供 `selected`、`filtered`、`orphan` 三者共用同一份去重后数组；
2. `RoleSettings.modelItems` 在构造时按 `value` 去重并把多个 `providerName` 用 `、` 合并进 `hint`。

### 2.3 prompt 组装（FR-408）

`src/host/api.ts#dispatch` 现拼 `wsSection + input.draft.prompt`。改为：

```ts
const reqPrompt = deps.board?.board.snapshot.requirements[reqKey]?.prompt
const taskPrompt = boardTask?.prompt
const body = taskPrompt ?? `${boardTask?.title ?? ''}\n\n${boardTask?.description ?? ''}`
const promptText = [wsSection, reqPrompt, body].filter(s => s && s.trim()).join('\n\n')
```

`reqKey` 取 `boardTask?.requirementId ?? input.targetWorkItem`（后者形如 `id@collection`，
与 dedupKey 同形）。

### 2.4 批量的分波算法（FR-409/410/411）

纯函数（`src/shared/batch-dispatch.ts`）：

```
planBatchStep(tasks, selected) -> {
  settled:   state ∈ {completed, deleted}
  running:   state === in_progress && execState === 'running'
  ready:     (state === 'pending' 且 blockedBy 全部 completed)
             或 (state === 'in_progress' 且 execState ≠ running 且 blockedBy 全部 completed)
  waiting:   state === 'pending' 且存在未 completed 的依赖，且这些依赖都不是终态
  stuck:     任务不存在 / 依赖任务不存在 / 依赖为 deleted / 依赖为 completed 之外且不在本次选中也不在运行
}
```

客户端循环（`slots.tsx#dispatchBatch`）：

```
remaining = new Set(ids)
for (round = 0; round < maxRounds; round++) {
  snap = await getBoard();
  step = planBatchStep(snap.tasks, [...remaining]);
  if (step.stuck.length) return 失败 + 可读原因
  删除 step.settled
  if (!remaining.size) return 成功（含每波明细）
  if (step.ready.length) { await 并发派发(step.ready, limit); sleep(tick); continue }
  if (step.running.length || step.waiting.length) { sleep(tick); continue }
  return 无法推进 + 原因
}
return 超时 + 原因（上界，绝不无限挂住）
```

`limit` 取 `data.dispatchConcurrency`（缺省 3）。tick = 1.5s，maxRounds ≈ 400（≈10 分钟）
——上界只是防呆，正常波次在秒级。

### 2.5 编辑弹框（FR-404/406/407）

三个弹框共用同一套内联样式与交互（遮罩 + `stopPropagation`），
参照 `RequirementPool` 已有的详情弹窗（`RequirementPool.tsx:599-644`）。
TaskCenter 的编辑弹框保持"**打开时快照初值、点保存才提交**"，避免异步目录到达覆盖用户输入
（项目既有纪律：不在 `setState(prev=>…)` 里做增量合并）。

## 3. 测试策略

| 层 | 文件 | 覆盖 |
|---|---|---|
| 纯逻辑 | `tests/batch-dispatch.spec.ts`（新） | 分波、依赖就绪、stuck 判定、进度文案 |
| 引擎 | `tests/board.spec.ts`（追加） | `updateTask` 改 prompt/frozenConfig/workspace、revision 冲突、终态拒改 |
| 服务 | `tests/board-service.spec.ts`（追加） | `updateRequirementMeta` fail-loud、`updateTask`、prompt 落盘/回读 |
| 编排 | `tests/host-api.spec.ts`（追加） | `dispatch` 三段式 prompt 组装（含需求级提示词实时生效） |
| 路由 | `tests/host-route.spec.ts`（追加） | 两条新路由的方法/入参校验与转发 |
| 组件（渲染） | `tests/ui-multiselect-dedup.spec.ts`（新） | MultiSelect 去重不产生重复 chip/key；`RoleSettings.modelItems` 去重 |

组件层无 React 测试库，故：
- `MultiSelect` 的去重抽成**纯函数**（`dedupeOptions`）导出并单测；
- `RoleSettings` 的 `modelItems` 构造抽成纯函数 `buildModelItems` 导出并单测；
- DOM 行为由 E2E（§4）实测。

## 4. 端到端验证方案

1. 构建：`npm run typecheck`（host + client + tests）→ `npm run build`（tsc + tsdown）。
2. 单测：`vitest run --reporter=json`（本机退出码不可信，按 `numFailedTests` 判定）。
3. 起真实 dsh web（隔离 `DSH_HOME` 或部署态 profile），用带 Cookie 的请求打真实路由：
   - `GET /tfs-requirment/panel-data` → 记录 `skillOptions.length` / `mcpServers.length`；
   - `POST /catalog-refresh` → 断言两者**变化**（问题 1/2 的实时性）；
   - `POST /requirement-update` / `POST /task-update` → 断言 `board.json` 落盘字段变化；
   - `POST /claim`（带 prompt+workspace）→ 断言需求记录含 prompt。
4. 对问题 7，用 `planBatchStep` 无关；改用带重复 id 的 `modelOptions` 直接单测
   `buildModelItems` + `dedupeOptions`，断言长度与唯一性，E2E 里在主面板「角色管理」
   实测选中/删除（需人工或脚本驱动 DOM）。

## 5. 验证记录（实现后回填，2026-09-20）

### 5.1 门禁

| 项 | 命令 | 结果 |
|---|---|---|
| 宿主半类型 | `tsc --noEmit -p tsconfig.host.json` | 退出码 0 |
| 客户端半类型 | `tsc --noEmit -p tsconfig.client.json` | 退出码 0 |
| 测试工程类型 | `tsc -p tsconfig.tests.json` | 退出码 0 |
| 单测 | `vitest run --reporter=json` | `numFailedTests === 0`（620 → 622 用例，见 §5.4） |
| 构建 | `tsc(host) + tsc(client) + tsdown` | 退出码 0；`lib/client.js` 272.38 kB（003 时 223.21 kB） |
| 产物符号自检 | grep `lib/` | host 含 `tfs-requirment/requirement-update`、`task-update`、`createRequirementUpdateHandler`；client bundle 含 `dedupeOptions`、`planBatchStep`、`批量派发执行`、`确认领取入池`、`重新采集目录` |

### 5.2 E2E-A：真实组件离线链路（问题 3/4/5/6/7）

脚本 `scripts/e2e-004.ts`（`npm run e2e:offline`）：真实 `Board` / `BoardService` /
`createHostApi` + 真实 fs + 真实 `statSync` 工作目录校验，只有 dispatcher 是桩（刻意不真派子代理）。
**adapter 调用计数 = 0**（`tag:false` + 只用本地补充字段），不触碰 TFS。

24 项断言全绿，关键输出：

```
[S2-c] 相对路径被 fail-loud 拒绝：代码库路径必须是绝对路径（收到「relative/path」）…
[S3-d] prompt 与 frozenConfig 三件套均已生效
[S3-e] revision 冲突：990004@WN_HIS#impl 期望 999 实得 1（请刷新后重试，禁自动覆盖 S-11）
[S4-b] 三段顺序正确（工作目录 → 需求提示词 → 任务提示词）
[S5-a] analyze 未完成时派发 impl 被拒：看板任务不可启动：…#impl 依赖未就绪：…#analyze
[S5-b] 被拒的派发没有触达 dispatcher（不会凭空起一个子代理进程）
[S5-e] 派发顺序严格为 analyze>impl>verify（实测 analyze>impl>verify）
[S6-a] 跨 provider 同 id 折叠为 2 个选项（原 9 条）
[S6-c] 同一 value 只产出一个 chip
[S7]   adapter 调用次数 = 0
```

### 5.3 E2E-B：真实 dsh web 宿主（问题 1/2 + 新路由注册）

脚本 `scripts/e2e-004-live.mjs`（`npm run e2e:live`）：对真实 `dsh web`（0.1.5-rc.2，本机 profile）
打真实 HTTP 路由。鉴权按 `browser-auth.ts` 的算法自签 cookie
（**注意 key 是 secret 的 base64url 解码字节**，不是那串文本；用文本当 HMAC key 会 401）。
**全程只读**：跑完后 `diff board.json` = IDENTICAL。

```
[L0-c] 未带 cookie 的请求被拒：HTTP 401
[L1-a] panel-data HTTP 200
[L1-b] 技能下拉非空：23 项
[L1-c] MCP 下拉非空：2 项（ragflow、winex_peis_knowledge）
[L1-d] 面板下发了目录采集时刻
       目录降级原因 1 条：技能目录仅含全局层：当前没有存活的 agent preset 挂载…
[L2-b] 采集时刻已推进（12:23:24.592Z → 12:23:34.519Z）⇒ 确实是重采而非读旧快照
[L3-a] requirement-update HTTP 400 "requirementKey 必填"
[L3-b] task-update HTTP 400 "taskId 必填"
[L3-c] 对照：未注册路径 HTTP 405（证明 400 来自这两条路由自己的校验）
[L3-d] task-update 走到业务层并如实回绝未知任务：200 {"ok":false,"reason":"未知任务：…"}
```

**同一进程内的两次采样直接复现了问题 2**（这是最有说服力的一条实测）：

| 采样点 | MCP 清单 |
|---|---|
| 首次采集（apply 期内存快照） | `winex_peis_knowledge`（**1 项**） |
| `POST /catalog-refresh` 之后 | `ragflow`、`winex_peis_knowledge`（**2 项**） |

即"面板打开时看到的 MCP 比宿主实际注册的少 1 个"，与用户描述一致；重采即补齐。
另有一次采样在宿主刚起来（`apply` 期采集尚未完成）时拿到 **0 项**，
说明"首次采集是异步的、可能在面板被打开之后才完成"——这也由本次的 `catalogCollectedAt` +
Tab 激活重采 + 5 分钟续采覆盖。

**技能 23 项 vs 用户级 96 个目录**的完整解释（实测 + 源码）：

- `livePresetMounts()` 里的挂载是**按需**建立的 —— 宿主 `agent-presets` 的
  `ensureStanding(preset)` 在**某个 agent 加入该预设**时才 `await mountPreset(...)`
  （`packages/preset/agent-presets/src/index.ts:814`）；
- dsh 进程刚起、还没有任何会话时 `mounts = []`，此时采到的技能**只有全局层**：
  实测 23 项全部 `source: "bundled"`，而 `~/.agents/skills` 实有 **96** 个技能目录；
- 旧实现**不产生任何 warning**，UI 把"没采到"显示成"你没有这些技能"；
- 本次修复：① 无挂载时给出可操作告警（上表 L1-d 那行，已实测出现在真实响应里）；
  ② Tab 激活重采 + 5 分钟续采 + 手动按钮 ⇒ 用户一旦有会话（挂载建立），
  下拉无需重启即可补齐。
- 并集逻辑本身已有单测锁死（`tests/dsh-catalog-skills-scope.spec.ts`：
  作用域层 89 条能被取到）。

> 未做（诚实记录）：没有在真实宿主里"先建会话再观察技能数从 23 涨到 96+"。
> 原因是这需要在 dsh 进程内真正创建一个会话（要驱动 `/api` RPC 或跑一次真实模型调用），
> 成本与副作用都超出本次范围。该断言的证据由「源码依据 + 真实 mounts=0 观测 + 作用域并集单测」
> 三者组合支撑，而不是实测端到端。

### 5.4 单测增量

| 文件 | 新增用例 |
|---|---|
| `tests/batch-dispatch.spec.ts`（新） | 17 |
| `tests/edit-capability.spec.ts`（新） | 27（引擎 9 / 服务 9 / 编排 9） |
| `tests/ui-dedup.spec.ts`（新） | 12 |
| `tests/dsh-catalog-skills-scope.spec.ts`（追加） | +2（无挂载告警 / 有挂载无噪声） |
| `tests/host-route.spec.ts`（追加） | +8（两条新路由的方法/入参/null 透传/对照） |

### 5.5 兼容性回归

- `tests/host-route.spec.ts` 的 `fakeApi` 补上 `updateRequirement` / `updateTask`
  （接口变更必须同批改所有假实现，否则只在 `tsconfig.tests.json` 那道门禁暴露）。
- `tests/host-api.spec.ts` 既有的三条 dispatch prompt 断言（`workspace` 段位置、
  零噪声、无 taskId 不注入）**全部保持通过** —— 三段式组装是在原有语义上叠加，
  未改变无 workspace/无需求提示词时的输出。

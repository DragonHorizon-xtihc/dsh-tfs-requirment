# Feature Specification: 派发工作目录真实生效 & 已完成需求页

**Feature Branch**: `007-workspace-cwd-and-completed-tab`
**Created**: 2026-09-21
**Status**: Implemented（已落地并通过三道 tsc + vitest 742 项 + tsdown）
**Input**: User description:
> 1）为什么任务已经设置了工作区 `D:\体检管理\6.0\03 源代码\60混合框架\GIT60混合框架\Winning.WiNEX.Plugins`，但子代理依旧在 `Winning.Tjgl.UI.Summary` 工作区？找到根本原因并解决路径错误的问题。
> 2）添加「已完成」Tab：上列表显示已完成需求（**分页 + 按需求 ID / 标题检索**），下列表显示当前焦点行需求对应的任务，任务可以进去查看执行过程。
> 3）任务中心不再显示已完成的需求；所有任务均完成后把已完成需求转移到「已完成」Tab。
> 4）已领取需求缺少执行状态。
> 5）已完成需求，必须先点「取消完成」才能点「还原到需求池」。
> 6）执行配置「发起执行」是否会拆分任务到任务中心？如果不是，就看不见执行内容；如果是，点发起执行成功后应当清空执行配置。

根因与宿主能力证据均带 `文件:行号`，宿主侧证据取自本机已安装的
`node_modules/@deepseek-ai/dsh-subagent`（源码随包发布）。

---

## 零、根因分析（问题 1 与问题 6 **同一个根因**）

### 0.1 宿主能力边界（不是插件的锅，但决定了唯一可行通道）

| 事实 | 证据 |
|---|---|
| `SubagentStartRequest` **没有** `cwd` / `workspace` 字段 | `@deepseek-ai/dsh-subagent/src/types.ts:145-200`（接口全字段：label/prompt/parent/signal/agentOptions/outputSchema/maxDepth/toolFilter/persona） |
| in-process 子会话的 cwd 直接**复制父会话** | `@deepseek-ai/dsh-subagent/src/child-agent.ts:139,147` → `childSessionMeta()` 里 `...parentHeader.cwd !== undefined ? { cwd: parentHeader.cwd } : {}` |
| out-of-process 子进程 cwd 只有两条来源：部署配置 → 否则父会话 cwd | `@deepseek-ai/dsh-subagent/src/out-of-process.ts:147-152` → `resolveChildCwd(prefix, configured, parentCwd)` |

**结论（已核实，非推测）**：子代理进程 cwd **恒等于父会话 workspace**（本机为 `Winning.Tjgl.UI.Summary`），
插件无法按任务改 cwd。因此"让子代理在指定目录干活"**只能**通过 prompt 落地，且必须给出**可执行动作**
（绝对路径 / 先 `cd` 再执行），否则模型会继续按进程 cwd 去 glob/grep。

### 0.2 插件侧三个叠加缺陷（这才是"我设了工作区却没用"的直接原因）

| # | 缺陷 | 证据（修复前） |
|---|---|---|
| A | 从「执行配置 → 发起执行」派发时 `taskId` 传的是 `undefined` ⇒ 宿主 `boardTask` 为空 ⇒ **prompt 里连【工作目录】段都没有** | `src/client/components/ExecutionPanel.tsx:242`（`actions.dispatch({...}, undefined, targetRef)`）；`src/host/api.ts` 原 569 行 `...(boardTask?.workspace ? {...} : {})` |
| B | 执行配置页选的工作区是**死字段**：`draft.workspace` 在宿主侧从未被读取 | 原 `dispatch()` 只读 `draft.roleName / preset / prompt / frozenConfig` |
| C | 工作区下拉的 `value` 用的是 `w.id`，而需求领取/任务编辑两处存的是 `w.path`（**绝对路径**）—— 写进去的值不是路径 | `ExecutionPanel.tsx` 原 405 行 `value={w.id}` vs `RequirementPool.tsx` 领取弹框 `value={w.path}` |

**另有两条语义缺陷**：
- 工作目录取值链缺"需求级回落"：`Requirement.workspace` 已存在且可编辑，但 `dispatch` /
  `launchBoardTaskExecution` / `followUpTask` 三处只取 `task.workspace`；
- prompt 段落里写着"插件不能按任务改变进程 cwd，请把宿主会话的 cwd 设为该路径"（
  `src/shared/workspace.ts` 原 97-98 行）—— 那是**给开发者看的解释**，模型读到只会得到
  "这个目录我做不了主"的结论，反而强化了"在 cwd 里干活"。

### 0.3 问题 6 的答案：**不会**拆分为任务

`dispatch()` 里 `if (deps.board && input.taskId) deps.board.setTaskState(input.taskId, 'start')`：
无 `taskId` ⇒ 不开 attempt、不回绑 runId、任务中心里**什么都看不到**（无执行内容、无轨迹、无失败原因）。
且没有任何入口把这次执行登记成看板条目 ⇒ 用户点完只看到"已发起执行"，其余无从核对。

---

## User Scenarios & Testing

### User Story 1 - 子代理真正在指定工作目录里干活 (Priority: P1)

用户给需求或任务设置了代码库绝对路径（如 `D:\体检管理\...\Winning.WiNEX.Plugins`），
无论从「任务中心 → 派发执行」还是从「执行配置 → 发起执行」，子代理的 prompt 里都必须带
**硬约束工作目录段**，并在其中被要求"文件工具一律用绝对路径、shell 命令先 `cd` 再执行、
不得在父会话工作目录里就近找同名工程"。

**Why this priority**：这是用户阻塞性缺陷。任务设了目录却改到别的工程，产出全部不可信。

**Independent Test**：桩看板 + 桩 dispatcher，对以下三种取值来源各派发一次，断言 prompt 含预期路径：
① 面板显式选择；② 任务 `workspace`；③ 需求级 `workspace`。再断言没有任何 workspace 时该段整体不出现（零噪声）。

**Acceptance Scenarios**:

1. **Given** 任务 `workspace=D:\a`，**When** 从任务中心派发，**Then** prompt 首段为 `【工作目录（硬约束，必须遵守）】`，
   含 `D:\a`、`绝对路径`、`cd /d "D:\a"`，且位于需求提示词/任务正文之前。
2. **Given** 面板显式选择 `D:\面板选的`，任务上是 `D:\任务级`，需求上是 `D:\需求级`，
   **When** 发起执行，**Then** 生效 `D:\面板选的`（优先级：显式 > 任务 > 需求），返回体 `workspace` 字段如实回带该值。
3. **Given** 面板未选工作目录（留空），任务上设了 `D:\任务级`，**When** 发起执行，
   **Then** 生效 `D:\任务级`（不再被"清单第一个工作区"覆盖）。
4. **Given** 三处都没有工作目录，**When** 派发，**Then** prompt 不含工作目录段（不产出噪声），派发照常成功。
5. **Given** 工作目录不存在/不可访问，**Then** prompt 要求子代理**如实上报并停止**，不得改到别的目录"就近"完成。

### User Story 2 - 「发起执行」落地为可追踪的看板任务 (Priority: P1)

从「执行配置」发起执行时，系统在该需求下**创建一条手工任务**（`<需求键>#manual-<角色>-<时间戳>`），
走与任务中心完全相同的链路（开 attempt → 绑 runId → 按 stopReason 收口 → 需求级自动完成），
并在结果里回带任务 id；界面明确提示"已创建看板任务 X（到任务中心可查看执行过程）"与**实际生效的工作目录**。

**Why this priority**：问题 6 —— 没有任务就没有执行内容，用户无法确认它跑没跑、跑成什么样。

**Independent Test**：真 `BoardService` + 内存 fs：需求未领取时派发被拒（原因含"未领取"）；
领取后派发成功且 `getBoard().tasks` 里能找到该任务、`dispatcher` 收到的 `taskId` 与回带值一致。

**Acceptance Scenarios**:

1. **Given** 目标需求**已领取**、未传 `taskId`，**When** 发起执行，**Then** 结果 `ok=true`、
   `createdTask=true`、`taskId` 形如 `1997179@WN_HIS#manual-架构师-20260921123000`，且看板里确实有这条任务。
2. **Given** 目标需求**未领取**，**When** 发起执行，**Then** 拒绝并给出可读原因（提示先去需求池领取），**不隐式入池**、不创建任务。
3. **Given** 看板服务不可用，**When** 发起执行（无 taskId），**Then** 明确拒绝并说明"拒绝无任务的派发"，
   而不是静默产生一次看不见的执行。
4. **Given** 派发成功，**When** 面板收到结果，**Then** **清空执行内容**（标题/描述/执行 Prompt/标签/交接包/AI 解析文本），
   保留执行环境（角色/模型/预设/工作目录/MCP/技能/权限）。
5. **Given** 派发失败，**When** 面板收到结果，**Then** 表单**不清空**，错误原因就地显示（用户可改完重试）。

### User Story 3 - 所有任务完成后需求自动迁入「已完成」页 (Priority: P1)

一条需求名下的任务**全部收口**（均为 `completed` 或 `deleted`，且至少一个 `completed`）后，
该需求自动置为已完成；它与其任务**从「任务中心」整体消失**，出现在「已完成」页。

**Why this priority**：任务中心的列表被历史需求淹没后不可用；完成与未完成必须分页管理。

**Independent Test**：`BoardService` + 桩 adapter，走完 `claim → decompose → 逐个 start/settle(success)`，
断言 `snapshot().requirements` 中该需求 `execState='completed'`；另有任务未完成时保持 `active`。

**Acceptance Scenarios**:

1. **Given** 三个任务全部成功，**When** 最后一个 settle 落定，**Then** 需求自动 `completed` 并记 `completedAt`。
2. **Given** 仍有任务处于 pending/in_progress，**Then** 需求保持 `active`（不迁移）。
3. **Given** 全部任务被取消、没有一个 completed，**Then** **不**判完成（"整条需求被放弃"不等于交付完成）。
4. **Given** 已取消任务从看板删除，**Then** 仍按同一判据复判（删除路径也触发自动完成，幂等不来回跳页）。
5. **Given** 已完成需求被重新拆解并新建了任务，**Then** 该需求退回 `active`（拆解 = 重新开始干活）。
6. **Given** 历史 `board.json` 没有 `execState` 字段，**Then** 一律按 `active` 读取（升级后需求不会集体消失）。

### User Story 4 - 任务中心显示需求的**执行状态** (Priority: P1)

「已领取需求」列表与「已完成需求」列表都显示执行状态，取值为派生量：
`未拆解 / 执行中 N / 有失败 N / 待办 N / 已完成 c/t`（c、t 不含已取消任务），颜色随语义变化
（执行中=蓝、有失败=红、待办=琥珀、已完成=绿、未拆解=灰）。

**Why this priority**：问题 4 —— 需求行此前只显示 TFS 的 `state`（如"已建议"），与本地执行进度毫无关系。

**Independent Test**：纯函数 `summarizeRequirementExec` 单测覆盖六种形态与优先级（已完成 > 未拆解 > 执行中 > 有失败 > 待办 > 已完成 c/t）。

**Acceptance Scenarios**:

1. **Given** 需求名下无任务，**Then** 显示「未拆解」。
2. **Given** 有一个 `execState=running` 的任务，同时另有失败任务，**Then** 显示「执行中 1」（正在跑优先于失败）。
3. **Given** 无在跑但有失败未收口，**Then** 显示「有失败 N」。
4. **Given** 全部收口且 3 个 completed、1 个 deleted，**Then** 显示「已完成 3/3」（分母排除已取消）。

### User Story 5 - 已完成需求必须先「取消完成」才能还原到需求池 (Priority: P1)

「已完成」页的需求行提供「取消完成」按钮（需求退回「任务中心」，字段从 `board.json` 移除）；
「还原到需求池」按钮在该页**禁用**并说明原因；宿主侧 `Board.restoreRequirement` 对已完成需求直接拒绝，
原因文案指向"先点取消完成"。

**Why this priority**：问题 5 —— 完成状态是用户对"这条需求收口了"的显式确认，撤销必须同样显式，
不允许"还原"一步抹掉一次已完成的交付记录。

**Independent Test**：`restoreRequirement` 单测：已完成 ⇒ 抛错含"先点「取消完成」"；
取消完成但仍任务未取消 ⇒ 抛第二道门禁的原因（两道门禁各司其职）。

**Acceptance Scenarios**:

1. **Given** 需求已完成，**When** 点「还原到需求池」，**Then** 按钮不可点，提示"先取消完成"。
2. **Given** 直接调用还原（绕过 UI），**Then** 宿主拒绝并给出同样可读的原因。
3. **Given** 已取消完成，**Then** 需求出现在「任务中心」；此时若仍有未取消任务，还原仍被拒（先取消任务）。

### User Story 6 - 「已完成」页：上表需求（分页 + 检索）、下表任务（可看执行过程） (Priority: P2)

任务中心内分「进行中 / 已完成」两个子 Tab（计数可见）。已完成页：
- 上表 = 已完成需求（去重键/标题/执行状态/完成时间/标签/操作），支持**按需求 ID 与标题检索**、**分页**（5/10/20/50）；
- 点某行 ⇒ 该行成为焦点（高亮），下表显示该需求名下的任务（任务名/状态/执行/角色/尝试/操作）；
- 任务行的「查看执行过程」打开既有 `TaskDetailDialog`（工具调用时间线 / 失败诊断 / 追问）。

**Why this priority**：依赖 US3/US4 的数据，属查询体验增强，排 P2。

**Independent Test**：`filterCompletedRequirements` 纯函数单测（ID 片段命中、标题大小写不敏感、空关键字浅拷贝、无命中空数组）；
子 Tab 、焦点回落、检索重置页码由组件层承载（组件层无渲染测试库，故派生规则全部下沉到 shared 并单测）。

**Acceptance Scenarios**:

1. **Given** 已完成页有 12 条需求、每页 10 条，**Then** 分页栏可翻页且每页条数落盘记忆（`ui-state.json.donePageSize`）。
2. **Given** 输入关键字命中 3 条，**Then** 列表只显示这 3 条且页码回到第 1 页。
3. **Given** 焦点需求在第 2 页，搜索后它被过滤掉，**Then** 下表自动回落到当前命中集合的第一条（不显示"列表里看不到的需求"）。
4. **Given** 点某任务行的「查看执行过程」，**Then** 打开执行详情弹层并轮询该轮轨迹。
5. **Given** 无已完成需求，**Then** 显示空态说明"全部任务完成后会自动出现在这里"。

---

## Functional Requirements

- **FR-001** 派发 prompt 的工作目录段必须给出可执行动作（绝对路径、`cd /d` 或 `cd`、禁止在父会话工作目录就近找代码、目录不可访问时停手上报）；**不得**再把"插件不能改变进程 cwd"的自白写进 prompt。
- **FR-002** 工作目录取值链固定为：**面板显式选择 > 任务级 `workspace` > 需求级 `workspace` > 空（不产出该段）**，三处消费点（`dispatch` / `launchBoardTaskExecution` / `followUpTask`）必须同口径。
- **FR-003** 工作区下拉一律以**绝对路径**（`DshWorkspaceOption.path`）为值；留空表示"跟随任务/需求配置"。
- **FR-004** 无 `taskId` 的派发必须在需求已领取时创建手工看板任务并走标准链路；未领取或无看板服务时拒绝并给可读原因。
- **FR-005** 派发成功返回 `taskId` / `createdTask` / `workspace`；执行配置页据此提示**实际生效**的目录与新建任务，并清空执行内容（保留执行环境）。
- **FR-006** 需求级 `execState: 'active' | 'completed'`（本地补充字段，缺省 = active）；`completed` 时记 `completedAt`；取消完成时两个键一并删除。
- **FR-007** 自动完成判据：名下至少一个任务，且全部处于终态，且至少一个 `completed`。触发点：`setTaskState` / `settleTask` / `deleteTasks`（收口后与删除后）。
- **FR-008** 已完成需求**不得**直接还原；还原第二道门禁仍为"名下无未取消任务"。
- **FR-009** 重新拆解新建任务时，已完成需求退回 `active`。`enrichRequirement` 不得覆盖本地字段（workspace / prompt / execState / completedAt）。
- **FR-010** UI：任务中心内两个子 Tab；进行中页隐藏已完成需求及其任务；已完成页上表需求（检索 + 分页 + 每页条数记忆）、下表焦点需求的任务、任务可打开执行详情。
- **FR-011** 需求行执行状态为派生量（`shared/requirement-status.ts` 纯函数），不得新增落库字段。

## Key Entities

- `Requirement.execState` / `completedAt`（本地补充字段，随 `board.json` 持久化，TFS 侧无此概念）。
- `RequirementExecSummary`（派生视图：`text` + `tone`）。
- `DispatchActionResult`（`ok/reason/taskId/createdTask/workspace`）。

## 变更文件

**宿主半**：`src/tfs/types.ts`（execState）、`src/core/board/board.ts`（
`requirementExecState` / `isRequirementAllTasksDone` / `markRequirementCompletedIfAllDone` /
`setRequirementExecState` / 还原门禁）、`src/host/board-service.ts`（自动完成触发点、`sealRequirementIfAllDone`、
`setRequirementExecState`、`createManualTask`、摘要透传、enrich 保本地字段、拆解退回 active）、
`src/host/api.ts`（取值链、手工任务、返回值、`setRequirementExecState`）、`src/host/route.ts`（新路由 + ui-state 白名单）。

**共享契约**：`src/shared/contracts.ts`（`RequirementSummary.execState/completedAt`、
`DispatchActionResult`、`SetRequirementExecStateInput/Result`、`UiState.donePageSize`、新路由）、
`src/shared/requirement-status.ts`（新）、`src/shared/workspace.ts`（prompt 段重写）。

**客户端半**：`src/client/components/TaskCenter.tsx`（子 Tab、已完成页、执行状态列、取消完成、还原护栏）、
`src/client/components/ExecutionPanel.tsx`（工作区取 path、显式优先、成功清空、结果提示）、
`src/client/slots.tsx`（桥方法 + 接线）。

**测试**：`tests/requirement-status.spec.ts`（新）、`tests/board.spec.ts`（+8）、
`tests/board-service.spec.ts`（+9）、`tests/host-api.spec.ts`（改写 6 条 + 新增）、
`tests/workspace.spec.ts`（改写 2 条 + 新增 1 条）、`tests/host-route.spec.ts`（新 handler 4 条 + 桩补齐）、
`tests/tfs-tool-wrapping.spec.ts` / `tests/edit-capability.spec.ts`（桩补齐新能力）。

## 验证方式（可复现）

```bash
# 三道类型门禁（host / client / tests）
node <repo>/node_modules/typescript/bin/tsc --noEmit -p tsconfig.host.json
node <repo>/node_modules/typescript/bin/tsc --noEmit -p tsconfig.client.json
node <repo>/node_modules/typescript/bin/tsc -p tsconfig.tests.json
# 单测（判红绿锚定 JSON 报告的 success / numFailedTests）
node <repo>/node_modules/vitest/vitest.mjs run --reporter=json --outputFile=./vitest.json
# 构建（运行期加载 lib/，改完必须 build）
node <repo>/node_modules/typescript/bin/tsc -p tsconfig.host.json
node <repo>/node_modules/typescript/bin/tsc -p tsconfig.client.json
node node_modules/tsdown/dist/run.mjs --config-loader tsx
```

**实测结果（2026-09-21）**：三道 tsc 全绿；vitest `success=true, total=742, failed=0`；tsdown 构建产出 `lib/client.js`。

## Out of Scope

- 真正改变子代理进程 cwd（宿主无该通道，见 §0.1；需要改宿主 `SubagentStartRequest` 或部署级 `cwd` 配置）。
- 已完成需求写回 TFS（状态/评论）：仍走既有 `confirmWrite` 四道门禁，本轮不新增写路径。
- continuable 同会话追问（仍为"每轮一个新 run"，见 specs/006）。

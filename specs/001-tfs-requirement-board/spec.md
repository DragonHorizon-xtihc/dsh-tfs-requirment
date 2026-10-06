# Feature Specification: dsh-tfs-requirment —— TFS 需求驱动的 DSH 任务看板插件

**Feature Branch**: 无独立分支（随宿主仓库 `deepseek-harness` 在 `plugins/dsh-tfs-requirment/` 下开发；用户已裁定不启用 git hooks 自动化）
**Created**: 2026-09-17
**Status**: Draft
**Input**: 项目提示词（含 ADR-000 裁决结果）+ 宪法 v1.1.0 + TFS 环境实测结论

> **证据基线**：本文件所有涉及宿主与 TFS 的表述均来自宪法 v1.1.0 的 Section 2.D（源码 `路径:行号`）
> 与 Section 2.E（只读实测）。无法核实的部分一律标 `[NEEDS CLARIFICATION]`，不做填充式编造。

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 配置 TFS 连接并验证可用性 (Priority: P1)

作为体检产品线开发者，我希望在 DSH 插件设置页填入 TFS 集合 URL 与个人 PAT（输入即掩码），
点「测试连接」后立即看到是否连通，以便确认后续所有操作的凭据基础是可靠的，而不用等到拉需求时才报错。

**Why this priority**: 这是所有其它故事的前置；凭据不可用则需求池、回写、打标签全部失效。

**Independent Test**: 填入 URL/PAT → 点击测试连接 → 观察成功或失败归类；PAT 字段始终掩码，
且检索全仓（含日志与临时文件）找不到 PAT 明文。

**Acceptance Scenarios**:

1. **Given** 未配置任何凭据，**When** 打开设置页，**Then** URL 与 PAT 均为空且 PAT 输入框为掩码类型，
   页面明确提示「PAT 存储于 gitignored 的 profile 文件，不进入版本控制」。
2. **Given** 有效 URL + PAT，**When** 点击测试连接，**Then** 返回「已连接」并显示当前身份
   （实测基线：`zhangbo3(张波)`）与集合名，**且界面与日志均不出现 PAT 明文**。
3. **Given** 无效 PAT，**When** 点击测试连接，**Then** 返回失败并归类（认证失败 / 地址不可达 / 权限不足），
   错误信息中不包含凭据片段。
4. **Given** 多集合环境（实测 4 个集合、48 个项目），**When** 切换目标集合，
   **Then** 后续所有读取与写入均作用于所选集合。

---

### User Story 2 - 需求池：从 TFS 拉取、筛选并查看详情 (Priority: P1)

作为开发者，我希望在一个列表里看到 TFS 的需求，能按状态/指派/迭代/关键字筛选、分页、手动刷新、查看详情，
并能把选中的需求「领取」到本地任务池，以便决定今天要处理哪些。

**Why this priority**: 需求是任务的唯一来源，没有它就没有后续任何编排。

**Independent Test**: 无需预先存在本地任务 —— 配置好连接即可拉取真实工作项并翻页查看详情。

**Acceptance Scenarios**:

1. **Given** 已连接，**When** 打开需求池，**Then** 展示列包含：需求 ID、标题、状态、指派给、优先级、迭代、
   标签、创建时间、更新时间；默认按更新时间倒序。
2. **Given** 列表已加载，**When** 输入关键字或选择状态过滤，**Then** 结果集相应收窄且分页计数同步更新。
3. **Given** 列表已加载，**When** 点击刷新，**Then** 重新拉取并保留当前的筛选与分页位置。
4. **Given** 某条需求，**When** 点击查看详情，**Then** 展示该工作项的完整字段与其当前标签集合。
5. **Given** 选中若干需求，**When** 点击「同步/领取」，**Then** 它们进入本地需求池并带上去重标识，
   重复领取不产生重复条目。

---

### User Story 3 - 任务中心：需求拆解、指派与生命周期控制 (Priority: P1)

作为执行者，我希望把一条领取的需求拆解成若干 DSH 可执行任务，给每个任务指派角色智能体，
并能在任务粒度上启动 / 暂停 / 重试 / 取消，同时看到执行日志与结果。

**Why this priority**: 这是「派活给智能体」的核心界面，也是用户点名要的能力。

**Independent Test**: 一条已领取的需求即可完整走完「拆解 → 指派 → 启动 → 看日志 → 重试」闭环，
不依赖 TFS 回写（回写属 US4）。

**Acceptance Scenarios**:

1. **Given** 一条已领取需求，**When** 触发拆解，**Then** 生成一组带标题与描述的任务并归属到该需求，
   支持人工增删调整。
2. **Given** 任务列表，**When** 为某任务选择角色智能体，**Then** 该任务继承该角色的
   默认 MCP / 技能 / 模型配置，且可逐项覆盖。
3. **Given** 任务处于运行中，**When** 查看该任务详情，**Then** 可见实时执行日志、中间产物与最终结果。
4. **Given** 任务失败或被暂停，**When** 点击重试，**Then** 从可恢复的断点继续，且历史尝试仍可追溯。
5. **Given** 任务列表，**When** 按状态 / 角色 / 需求 / 时间筛选，**Then** 结果正确收窄。

---

### User Story 4 - 需求交付：发起执行、打 dsh 标签与回写 TFS (Priority: P1)

作为负责人，我希望选中需求后设置 MCP / 技能 / 模型 / 角色智能体发起 DSH 执行，
执行全过程在 TFS 上可追溯（`dsh` 标签），并能在完成后按配置回写状态、评论与关联信息，
且每一次回写都要先看得到 dry-run 预览。

**Why this priority**: 这是插件的价值终点 —— 把 DSH 的产出沉淀回团队共用的 TFS。

**Independent Test**: 对一条测试用需求发起执行并观察：进入队列时被打标签（幂等）、
回写前有 dry-run 预览、确认后工作项出现预期变更。

**Acceptance Scenarios**:

1. **Given** 选中一条需求，**When** 打开执行面板，**Then** 可设置 MCP、技能、模型、角色智能体与执行参数。
2. **Given** 执行已发起，**When** 任务进入执行队列，**Then** 对应 TFS 工作项被加上 `dsh` 标签
   （标签名可配置）；**重复入队不产生重复标签**（幂等键一致）。
3. **Given** 执行失败或被取消，**When** 查看该工作项，**Then** `dsh` 标签**仍然保留**，便于追踪无人跟进的中间态。
4. **Given** 执行完成且配置开启回写，**When** 触发回写，**Then** 先展示 dry-run 预览
   （目标工作项 + 变更前后对比），用户确认后才真正写入 TFS。
5. **Given** 回写执行完毕，**When** 查看审计日志，**Then** 每条写入记录含时间、操作者、profile、
   调用的工具、入参摘要、结果与幂等键，**且不含 PAT 明文**。
6. **Given** 网络或权限异常，**When** 回写失败，**Then** 失败被记录、可重试，且不产生半成品的部分写入。

---

### User Story 5 - 角色智能体管理 (Priority: P2)

作为配置者，我希望增删改角色智能体，为每个角色指定绑定的智能体、系统提示词、
默认 MCP / 技能 / 模型、是否自动执行、默认标签策略，以便不同任务能套用不同专家人设。

**Why this priority**: US3 的指派能力依赖它，但初期可用少量内置角色跑通，因此列 P2。

**Independent Test**: 创建一个新角色并在 US3 的指派下拉中看到它即可验证。

**Acceptance Scenarios**:

1. **Given** 角色列表为空，**When** 新增一个角色并保存，**Then** 该角色出现在任务指派的候选项中。
2. **Given** 已存在角色，**When** 修改其默认模型或提示词，**Then** 仅对之后新建的任务生效，
   已存在任务保持创建时的配置（避免执行中漂移）。
3. **Given** 某角色被任务引用，**When** 尝试删除该角色，**Then** 系统阻止删除或要求显式确认并给出受影响的引用清单。

---

### User Story 6 - 状态持久化与跨 session 恢复 (Priority: P2)

作为使用者，我希望今天做到一半的任务状态明天打开还在 —— 状态落在文件里而不是会话上下文里，
并且能自动生成人能读的 Markdown 看板。

**Why this priority**: 不持久化则会话一断全部丢失，但它是横切设施，US3/US4 已隐含其基础能力。

**Independent Test**: 创建若干任务后重启 DSH 并重新打开插件，任务、状态、验收记录与之前完全一致。

**Acceptance Scenarios**:

1. **Given** 存在若干任务，**When** 进程重启后重新打开，**Then** 任务列表、状态、执行日志与验收记录完全恢复。
2. **Given** 状态 JSON 被写入，**When** 同时查看渲染好的 Markdown 看板，**Then** 内容与 JSON 一致，
   且 Markdown 顶部标注「自动生成，请勿手改」。
3. **Given** JSON 解析失败，**When** 加载状态，**Then** 报错并**保留原文件**，不静默重建空状态。
4. **Given** 两个不同入口读写同一批任务，**When** 并发发生，**Then** 以文件级顺序写入 + 事件日志追加为准，
   同一任务不出现互相覆盖导致的状态倒退。

---

### Edge Cases

- PAT 过期或被回收：读取请求返回 401/403 时，界面给出「凭据失效，请重新配置」而非通用报错。
- 集合 URL 变更或迁移：历史任务里记录的工作项定位信息需能重新解析，或明确标记为不可解析。
- TFS 返回同一工作项的并发修改（revision 冲突）：回写必须检测到并以「已被他人修改，需重新 dry-run」中止。
- `dsh` 标签与目标工作项上已有的同名标签、大小写差异：比较时必须规范化后再判定幂等。
- 执行被中途取消时的中间态：TFS 侧已打标签但无回写，界面必须显式暴露这类「悬空」项。
- 一次 reload/重启时的半写状态：JSON 主数据与 JSONL 事件日志之间必须能检测并对齐。
- 目标工作项类型不支持某些目标状态（例如不可直接置为「已完成」）：回写前校验目标状态合法，非法则在 dry-run 阶段就拦截。

---

## Requirements *(mandatory)*

### Functional Requirements

**连接与凭据**

- **FR-001**: 系统 MUST 允许配置 TFS 集合 URL 与个人 PAT，并提供「测试连接」返回成功/失败与失败归类。
- **FR-002**: 系统 MUST 通过 profile 机制存取 PAT：密文落盘于 gitignored 文件，**绝不明文回显、不写入版本控制、不写入日志与错误堆栈**。
- **FR-003**: 系统 MUST 支持在**已配置的集合清单**中运行时切换目标集合，且所有 TFS 读写均作用于当前所选集合（清单配置见 FR-025）。

**需求读取**

- **FR-004**: 系统 MUST 复用 `tfs-mcp` 拉取工作项，**不得重新实现 TFS REST 调用**。
- **FR-005**: 需求池 MUST 支持关键字查询、按状态/指派/迭代筛选、分页、手动刷新、查看详情。
- **FR-006**: 需求列表 MUST 至少展示：ID、标题、状态、指派给、优先级、迭代、标签、创建时间、更新时间。
- **FR-007**: 「同步/领取」到本池 MUST 幂等，重复操作不产生重复条目。

**任务与编排**

- **FR-008**: 系统 MUST 支持把一条需求拆解为多个 DSH 可执行任务，并允许人工调整拆解结果。
- **FR-009**: 系统 MUST 支持为任务指派角色智能体，任务继承角色的默认 MCP/技能/模型且可覆盖。
- **FR-010**: 系统 MUST 提供任务的启动 / 暂停 / 重试 / 取消，并展示执行日志、中间产物与最终结果。
- **FR-011**: 多智能体编排 MUST 基于 DSH 原生能力（`packages/subagent`、`packages/workflow`），
  **不得**引入 CrewAI 或 `dsh-cli-agents` 的 CLI 适配器编排（ADR-000 = B）。
- **FR-012**: 任务 MUST 支持按状态、角色、需求、时间维度筛选。

**标签与回写**

- **FR-013**: DSH 执行的需求/任务 MUST 携带可配置标签，默认 `dsh`；打标签 MUST 幂等。
- **FR-014**: 打标签时机默认为「**进入执行队列时**」，失败/取消/中断后**标签保留**。
- **FR-015**: 所有 TFS 写操作 MUST 经过 dry-run 预览 → 显式确认 → 幂等键 → 结构化审计日志四道门禁。
- **FR-016**: 回写内容 MUST 支持按配置选择：状态、评论、关联提交/PR/构建、标签更新。
- **FR-017**: 回写 MUST 处理 revision 冲突，检测到目标已被修改时中止并要求重新 dry-run。

**持久化**

- **FR-018**: 任务权威状态 MUST 落盘为 JSON 主数据 + JSONL 事件日志，并自动渲染只读 Markdown 看板。
- **FR-019**: 状态 MUST 支持跨 session、跨进程重启恢复，并可供多个 agent 共享。
- **FR-020**: 解析失败 MUST 报错并保留原文件，禁止静默重建。

**UI 与集成**

- **FR-021**: UI MUST 与 DSH 现有形态一致：React 18 + CSS Modules、经 slots 挂载、
  设置区经 `ctx.settings.installSection` 注册（宪法 2.D）。
- **FR-022**: 设置页 MUST 提供 MCP 服务器管理区（宿主无现成 MCP 设置 UI，需自建）。
- **FR-023**: TFS 相关调用 MUST 经宿主的 MCP client（`mcp-client`，工具名 `mcp__<serverName>__<rawName>`），
  不在插件内自建 transport。
- **FR-024**: 需求池 MUST 支持可配置间隔的定时轮询同步（**默认 5 分钟**、增量更新），与手动刷新并存。
- **FR-025**: 目标集合与项目 MUST 可配置多个、默认 `WN_HIS`；所有 TFS 读写作用于所选集合。
- **FR-026**: TFVC 浏览/关联能力（changesets / branches / 文件下载）MUST 进 v1；shelveset 支持粒度以
  tfs-mcp 实际工具为准（缺失则降级只读或推迟，见 plan 风险项）。
- **FR-027**: 角色智能体 MUST 映射到宿主既有 subagent provider / agent preset（不新建注册表），
  每角色声明 provider/preset 引用 + 默认 MCP/技能/模型，配置存插件 JSON。
- **FR-028**: 看板面板 MUST 挂载于 `conversation.panel` 常驻侧栏（遵循 `slot-catalog.ts:81` 的 slots 契约，
  须 `inject:['slots']` 并经 `ctx.slots.inject` 注册）。
- **FR-029**: 同时执行的需求数量 MUST 可配置上限（**默认 3**，可配）；超过上限的需求排队，不抢占。
- **FR-030**: 每个需求的执行 MUST 进入独立对话/会话界面，用户可进入该界面查看此需求的执行全过程
  （实时日志、中间产物、子任务状态、回写结果）。
- **FR-031**: 插件持久化数据（`board.json` / `events.jsonl` / 渲染 Markdown）MUST 存于**插件私有数据目录**，
  不污染宿主或工作区项目根（遵循 Principle VI 的状态外置）。

### Key Entities

- **TfsProfile**：一组连接凭据与目标定位。属性：profile 名、集合 URL、PAT 密文引用、目标项目、目标集合、默认查询条件。
- **Requirement**：来自 TFS 的工作项。属性：工作项 ID、所属集合与项目、标题、状态、指派给、优先级、迭代、标签集合、
  创建/更新时间、当前 revision。
- **DsTask**：本地可执行单元。属性：任务 ID、所属需求、**幂等键**、标题、描述、指派的角色智能体、
  创建时冻结的 MCP/技能/模型配置、状态（待执行/执行中/待确认/已完成/失败/已取消）、尝试历史、产物路径。
- **RoleAgent**：角色定义。属性：角色名、绑定的智能体（provider）、系统提示词、默认 MCP/技能/模型、是否自动执行、默认标签策略。
- **WriteOp**（回写意图）：目标工作项、操作类型、变更前后 diff、幂等键、dry-run 结果、确认状态、最终 result。
- **AuditEvent**：一次写入或打标签的不可变记录。属性：时间、操作者、profile、工具、入参摘要、结果、幂等键（**不含凭据**）。
- **BoardState**：所有 DsTask / Requirement 的权威 JSON 快照 + JSONL 变更历史 + 渲染出的 Markdown 视图。

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 配置 URL 与 PAT 后「测试连接」成功，且全仓检索（含日志）无法找到 PAT 明文。
- **SC-002**: 从 TFS 拉取需求列表成功，筛选、分页、刷新、查看详情四项操作均可独立完成。
- **SC-003**: 一条需求可被拆解为任务并被指派角色智能体。
- **SC-004**: 可选中需求发起 DSH 执行，执行前可设置 MCP、技能、模型。
- **SC-005**: DSH 执行的需求在 TFS 上带有 `dsh` 标签，**重复发起不产生重复标签**（幂等验证通过）。
- **SC-006**: 回写 TFS（状态/评论/标签/关联）时必经 dry-run 预览，且每次写入对应一条审计日志。
- **SC-007**: 进程重启后任务状态、执行日志与验收记录完整恢复，数据与重启前逐字段一致。
- **SC-008**: 所有 TFS 写操作均有 dry-run 与审计日志，覆盖率 100%。度量：对每个写调用，**审计日志条目数 == 写调用数 == 1** 且按 `幂等键` 一一对齐；dry-run 预览缺位或审计条目缺失即判失败。
- **SC-009**: 提供安装、配置、使用文档与可执行的验收清单。

---

## Assumptions

- 目标 TFS 为**本地部署 TFS 2018**（实测结论，宪法 2.E），需考虑 TFS 2018 的 REST API 版本限制；
  TFVC（changesets / branches / 文件下载）已裁决进 v1，shelveset 专用工具在 tfs-mcp 当前版本未见（plan 风险项）。
- UI 锚点已裁决 = **② TeamTaskBoard 语义**（四态 + `blockedBy` DAG + `revision` 乐观锁，
  见 `packages/experimental/agent-team/src/types.ts:71,74`）。纠正：`TeamTaskBoard` 是**实验性宿主编排插件**，
  非看板组件、状态不在 JSON；本插件**借鉴其数据模型、自实现看板引擎并落 JSON**（Principle VI），不硬依赖它。
- 目标集合/项目可配置多个、默认 `WN_HIS`；同步支持手动 + 定时轮询；角色智能体映射到宿主 preset / subagent provider。
- JSON 为权威状态、session 投影仅用于呈现，二者冲突以 JSON 为准（宪法 2.A）。
- 明确指派的 self-hosted 执行环境为用户本机 Windows（pnpm + Node 22.x），不涉及服务端多用户部署。
- v1 面向单人使用，不做权限体系与多租户。

---

## Resolved Clarifications（/speckit.clarify 产出，2026-09-17 已裁决）

> 由用户裁决，结论已吸收进下方需求与宪法 v1.1.0 的 Section 2.C。

1. **UI 锚点 = ② TeamTaskBoard 语义**（四态 `pending/in_progress/completed/deleted` + `blockedBy` DAG 依赖
   + `revision` 乐观锁，见 `packages/experimental/agent-team/src/types.ts:71,74`）。
   **前提纠正**：`TeamTaskBoard`（`packages/experimental/agent-team/src/task-board.ts:32`）是宿主内的
   **实验性多智能体编排插件**，并非可嵌入的看板组件，状态存 session 投影、不落 JSON。
   「DSH 现有任务看板」本身无产品级实现。因此本插件的「一致」采用**借鉴其数据模型 + 自实现看板引擎并落 JSON**
   （Principle VI），UI 沿用 slots 挂载风格自绘 React 组件；**不把 experimental `agent-team` 作为硬依赖**。
2. **目标集合/项目可配置多个、默认 `WN_HIS`**：设置页提供多集合/多项目清单（实测 4 集合 48 项目），
   默认当前默认集合；所有 TFS 读写作用于所选集合。
3. **需求同步 = 手动 + 定时轮询**：手动刷新 + 可配置间隔的轮询增量更新。
4. **TFVC 进 v1**：changesets / branches / 文件下载工具已验证可用；shelveset 专用工具在 tfs-mcp 当前版本
   未见（见 plan 风险项），v1 按实际能力确定 shelveset 支持粒度。
5. **角色智能体映射到宿主 preset / subagent provider**：不新建注册表；每角色声明 provider/preset 引用 +
   默认 MCP/技能/模型，配置存插件 JSON。

---

## Requirement Supplements（源自 checklist 缺口回填，2026-09-17）

> 本段将 checklist（requirements-quality / security）标记的 `[Gap]/[Ambiguity]` 项落定为明确规格，
> 作为 FR/SC 的补充契约。对应 checklist 项视为已 resolve。

- **S-01 领取/同步去重键** = `workItemId + "@" + collection`（跨集合唯一）。同一键重复领取不产生重复本地条目（细化 FR-007）。
- **S-02 持久化不分片**：`board.json` 为单文件，所有 Requirement/DsTask 带 `collection` 字段，查询按集合过滤；
  不按集合拆分多文件，以降低并发写冲突（细化 FR-025/FR-031）。
- **S-03 审计日志** = append-only，滚动保留 **90 天**（超期归档后截断，插件自身不可删改），条目剔除 PAT（细化 FR-015/CHK003/CHK010）。
- **S-04 TFVC 关联方式** = 向目标工作项**追加评论**，评论内含 changeset / shelveset / branch 的 URL 或编号链接；
  不写专用关联字段（TFS 2018 工作项无统一关联字段，避免依赖不存在的 API）（细化 FR-016/CHK011）。
- **S-05 dry-run 确认载体** = 在 `ExecutionPanel` 内渲染 dry-run 预览卡片，用户点击「确认回写」按钮确认；
  为 UI 内联确认，非命令行（细化 FR-015/CHK008）。
- **S-06 并发排队** = 超限需求进入「排队中」状态并在任务中心可见；**FIFO 按入队时间**，默认不可重排（细化 FR-029/CHK009）。
- **S-07 断点重试** = 按**子任务（DsTask）粒度**重试；已完成子任务跳过，从失败子任务的上一次工具调用结果续跑（细化 US3 AC4/CHK010）。
- **S-08 标签规范化** = 比较前 `trim + toLowerCase` 并去重；幂等键 `<workItemId>@<collection>:<normalizedLabel>` 跨进程稳定（细化 FR-013/CHK013/CHK030）。
- **S-09 JSON 权威 vs session 镜像** = 写入只走 `board.json`；每需求独立 session 仅作**只读呈现镜像**，
  关闭后从 JSON 恢复；session 投影反向**不覆盖** JSON（闭环 CHK014/CHK017，衔接 FR-030/SC-007）。
- **S-10 崩溃对账** = 重启后按 `task.revision` 与 TFS 实际（标签存在性 + 最近回写审计）对账；
  有 `dsh` 标签但无回写记录的「悬空项」标「待人工核对」（细化 CHK025）。
- **S-11 revision 冲突续办** = 检测到目标已被修改即中止，要求**人工重新触发 dry-run**，禁止自动覆盖（细化 FR-017/CHK009）。
- **S-12 多 profile** = 支持多 TFS 凭据 profile；切换时内存与磁盘凭据隔离；删除 profile 时**彻底擦除**（覆盖 CHK004）。
- **S-13 角色开关与缺失** = 每角色增 `autoExecute: boolean`（对应原始需求 §1.2）；其引用的 provider/preset 在宿主不存在时，
  该角色在指派下拉中**禁用并提示**，不静默失败（细化 FR-027/CHK013/CHK005）。
- **S-14 轮询下限** = 默认 5 分钟；**最小间隔 1 分钟**，防止对本地 TFS 构成高频压力（细化 FR-024/CHK018）。
- **S-15 可访问性范围** = v1 **不强制 a11y 合规**，但 UI 组件须使用语义化标签且键盘可达（最低要求），列为已知范围外项（覆盖 CHK006）。
- **S-16 降级流** = 零状态（无集合/池空）有引导空界面；部分字段拉取失败按字段降级并标注；provider 缺失按 S-13 处理（覆盖 CHK022/CHK023）。

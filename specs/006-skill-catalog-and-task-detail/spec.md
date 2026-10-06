# Feature Specification: 技能目录冷启动全量 & 任务执行过程详情

**Feature Branch**: `006-skill-catalog-and-task-detail`
**Created**: 2026-09-21
**Status**: Draft
**Input**: User description:
> 1）执行配置「技能选择」下拉数据源不全，用户级技能有 89 条，三轮都没解决；为什么只能加载 24 个、其他技能为什么加载不出来，找到根因并解决。
> 2）任务中心点任务标题要进入「任务执行详情页」，查看任务动态执行过程，能二次对话；现在没有详情页，任务失败都不知道为什么失败。详情能否直接用 dsh 本地对话？不行就单独设计任务执行过程详情页，要能看到技能、MCP 等工具的调用过程。

根因与宿主能力证据见同目录 `research.md`（均带 `文件:行号`）。

## User Scenarios & Testing *(mandatory)*

### User Story 1 - 冷启动就能在技能下拉看到全部用户级技能 (Priority: P1)

用户刚启动 dsh、**还没开过任何会话**就打开插件「执行配置」，技能下拉必须直接列出用户级技能目录（如 `~/.agents/skills` 的 89+ 条）与内置技能的并集，而不是只有 24 条内置技能；不需要「先去开一个会话再点重采」这种绕行。

**Why this priority**: 这是用户连续三轮反馈的阻塞性缺陷，直接使「冻结技能配置」不可信；执行配置本就发生在跑任务之前，冷启动是主路径而非边角。

**Independent Test**: 在测试中把「存活 preset 挂载」置为空（`livePresetMounts()=[]`），仅让 `agentPresets.list()` 返回 standard 且 `standingKeyFor('standard')` 返回其作用域、该作用域 `skills.list` 返回 89 条用户技能；刷新目录后 `catalog.skills` 必须包含全部 89 条，且不出现「仅含全局层」告警。

**Acceptance Scenarios**:

1. **Given** 冷进程、无任何存活 preset 挂载，**When** 采集能力目录，**Then** 经每个可用 preset 的 `standingKeyFor(id)` 建立/取得 standing 作用域并 `skills.list({scope})`，技能下拉返回全局层 + 各 preset 作用域层的并集（含用户级 89+）。
2. **Given** 某 preset 损坏或其作用域 `list` 抛错，**When** 采集目录，**Then** 只跳过该 preset、其余 preset 与全局层照常返回，并在 `catalogWarnings` 给出带 preset id 的可读原因。
3. **Given** 宿主不提供 `agentPresets` 服务，**When** 采集目录，**Then** 回退全局层 + 存活挂载并集，插件不崩溃、给出可见降级说明。
4. **Given** 全局层与作用域层存在同名技能，**When** 合并，**Then** 以技能名为键去重且全局层行优先（与既有行为一致）。

---

### User Story 2 - 点任务标题看到执行详情与失败原因 (Priority: P1)

用户在「任务中心」点击任一任务标题，打开任务执行详情：看到任务基本信息、冻结配置（模型/技能/MCP/角色/工作目录）、每次尝试（attempt）的时间与结果，以及**本次执行的动态过程时间线**（用户指令、助手输出、技能/MCP/工具调用的入参、结果与报错）。任务失败时，失败原因（宿主 `diagnostic` 与 stopReason）显著展示，不再出现「失败却显示成功 / 不知道为什么失败」。

**Why this priority**: 失败不可见等于任务链路黑箱，用户无法纠错也无法信任自动执行；与 US1 同为本轮必须解决的核心问题。

**Independent Test**: 用合成的 Session 事件（user/assistant/tool call/tool result，含一次 isError）喂给轨迹映射纯函数，断言时间线按序产出、工具调用与结果按 callId 配对、错误可见；再用看板/落定单测断言非 `completed` 的 `run.result` 会把任务置为失败并写入 `diagnostic`。

**Acceptance Scenarios**:

1. **Given** 一个已派发任务（attempt 记录了子会话 runId），**When** 点击任务标题，**Then** 打开详情弹层并展示该 attempt 的执行时间线；任务运行中时定时刷新，结束后停止。
2. **Given** 子 run 以 `stopReason='error'|'refusal'|'max-tokens'|'aborted'` 结束并带 `diagnostic`，**When** 结果落定，**Then** 任务被标为失败（可重试），详情页红色失败区展示 stopReason 与 diagnostic，最后一次 attempt 带该诊断。
3. **Given** 子 run 以 `completed` 结束，**When** 结果落定，**Then** 任务标为完成，详情页展示最终助手输出。
4. **Given** 宿主未提供 `sessionQuery` 或该会话尚不可读，**When** 打开详情，**Then** 时间线区给出明确「执行过程暂不可用 + 原因」，但仍展示 attempt、冻结配置与失败诊断，不报错、不白屏。
5. **Given** 一个升级前产生的历史任务（attempt 无 runId），**When** 打开详情，**Then** 提示「该历史任务未记录会话 ID，重新派发后可查看过程」，其余信息正常展示。

---

### User Story 3 - 在详情页对任务二次对话（追问/补充指令） (Priority: P2)

用户在详情页底部输入追问或补充指令并发送，系统以**同一任务、同一角色与冻结配置**发起一轮新的执行，记为一次新的 attempt，并自动切到该新 attempt 实时展示其工具调用过程；上一轮的最终输出/失败诊断作为上下文带入。

**Why this priority**: 让失败/未达预期的任务能就地迭代，不必回到 TFS 或重新拆解；依赖 US2 的详情与轨迹能力，故排 P2。

**Independent Test**: 对一个失败任务调用追问，断言看板新增一次 running attempt、dispatcher 收到以「上轮结果 + 追问」组装的 prompt 与同一 frozenConfig、返回新 runId；新 attempt 可独立查看轨迹。

**Acceptance Scenarios**:

1. **Given** 任务处于失败/进行中/已完成（非已取消），**When** 用户输入追问并发送，**Then** 以同角色、同 frozenConfig、同工作目录发起新 run，看板新增一次 attempt（已完成任务被显式重开为进行中，历史 attempt 保留），详情切到新 attempt 并轮询其轨迹。
2. **Given** 任务已取消（deleted 终态），**When** 查看详情，**Then** 不展示追问输入（或禁用并说明终态不可追问）。
3. **Given** 追问派发失败（角色缺失/派发器不可用），**When** 发送，**Then** 返回可读原因且不产生半截 attempt，用户可重试。
4. **Given** 新一轮落定，**When** 刷新看板，**Then** 任务状态与该 attempt 结果按 US2 同样规则收口（成功完成 / 失败带诊断）。

---

### Edge Cases

- 冷进程且 `agentPresets` 存在多个 preset（standard/cordis/ptc/自定义）：逐 preset `standingKeyFor`，首个建立后进程内缓存；任一失败隔离，不影响其他。
- `standingKeyFor` 触发的 preset 组合挂载较重：目录采集本身已懒加载 + 缓存 + 手动刷新，首轮可接受；不得在插件 apply 关键路径上无限等待（沿用既有超时/降级）。
- 会话事件非常多（长任务）：轨迹映射对 args/result 文本截断、对条目数设上限，保证 HTTP 响应可控。
- 工具结果块形态多样（字符串 / 文本块数组 / 嵌套 content）：提取器需防御式处理，取不到原文时给出占位而非报错。
- 任务运行中关闭详情再打开：按当前 attempt 的 runId 重新冷读，不依赖前端常驻连接。
- 进程重启后查看：runId 已持久化进 board.json，`sessionQuery` 冷读已持久化会话日志；若会话日志也不存在则显式提示。

## Requirements *(mandatory)*

### Functional Requirements

**技能目录**
- **FR-001**: 系统 MUST 在采集技能目录时，对 `agentPresets.list()` 返回的每个可用（非 broken）preset 调用 `standingKeyFor(id)` 获取 standing 作用域，并对该 scope 调用 `skills.list({scope})`，使技能发现不依赖是否已有会话挂载。
- **FR-002**: 系统 MUST 将全局层、各 preset standing 作用域层、存活挂载作用域层的技能按 `name` 并集去重（全局层优先），并按名排序。
- **FR-003**: 系统 MUST 对单个 preset/作用域的失败做隔离降级，并在 `catalog.warnings` 给出含 preset id 与原因的可读信息；缺失 `agentPresets` 服务时回退旧路径且不崩溃。
- **FR-004**: 冷启动（`livePresetMounts()` 为空）且 standing 作用域成功返回用户级技能时，系统 MUST NOT 再产生「仅含全局层」告警。

**执行落定与持久化（文件即真相，Principle VI）**
- **FR-005**: 每次 attempt MUST 持久化其子会话 `runId`；落定时 MUST 记录 `stopReason`、失败 `diagnostic`（有界）与最终助手输出摘要（有界），这些字段随 board.json 落盘、跨重启可读，且为可选字段以兼容历史数据。
- **FR-006**: 系统 MUST 依据 `run.result` 的 `stopReason` 收口：`completed`→成功；其余（error/refusal/max-tokens/aborted）→失败（可重试）并写诊断；基础设施 reject→失败并写错误消息。不得再把非 completed 结果标为成功。
- **FR-007**: `BoardTaskView` MUST 透出 attempts 明细（时间、结果、note、runId、stopReason、diagnostic、输出摘要），供详情页渲染。

**执行过程详情**
- **FR-008**: 系统 MUST 提供按任务 + attempt 读取执行轨迹的宿主方法与 HTTP 路由，经 `sessionQuery.observeSession(runId,{projectionMode:'none'})` 取事件并映射为可 JSON 序列化的时间线条目（用户/助手文本、工具调用名+入参、工具结果/错误、turn 边界）。
- **FR-009**: 任务中心任务标题 MUST 可点击打开详情弹层；运行中按固定间隔轮询轨迹，结束后停止；轨迹不可用时降级提示但不阻断其余信息。
- **FR-010**: 时间线 MUST 能区分并标注 MCP（`mcp__` 前缀）、技能调用与普通工具，入参/结果支持折叠查看，错误项显著标红。

**二次对话**
- **FR-011**: 系统 MUST 提供「对任务追问」宿主方法与路由：以同角色、同 frozenConfig、同工作目录，组装「上一轮输出/诊断摘要 + 本次追问」发起新 run，记为新 attempt 并返回 runId。
- **FR-012**: 已取消（deleted）任务 MUST NOT 允许追问；追问派发失败 MUST 返回可读原因且不写半截 attempt。
- **FR-013**: 详情页 MUST 在追问成功后切换到新 attempt 并实时展示其轨迹。

### Key Entities

- **AttemptRecord（扩展）**：一次执行尝试，新增可选 `runId`（子会话 id）、`stopReason`、`diagnostic`、`output`（摘要）、`provider`。
- **TaskAttemptView**：attempt 的客户端可序列化镜像。
- **TaskTraceEntry**：时间线条目判别联合（user / assistant / tool / turn），工具条目含 callId、name、args、status、result/error。
- **TaskTraceResult**：一次轨迹读取结果（ok、available、running、source、cursor、entries、reason）。
- **Preset standing scope**：经 `agentPresets.standingKeyFor(id)` 取得的 preset 作用域键，是冷启动技能发现的依据。

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**：在「无存活挂载 + standing 作用域含 89 条用户技能」的回归测试中，目录技能数 = 全局与作用域并集（≥89），且无「仅含全局层」告警。
- **SC-002**：真实/模拟环境下，冷启动首次打开执行配置，技能下拉显示数量与用户 `~/.agents/skills`（及 `$DSH_HOME/skills`）目录数一致（误差仅来自无 SKILL.md/frontmatter 的非法目录）。
- **SC-003**：对 stopReason 为 error/refusal/max-tokens/aborted 的子 run，任务 100% 收口为失败且详情可见诊断；对 completed 100% 收口为成功（单测覆盖 5 种 stopReason）。
- **SC-004**：任一已派发（含 runId）任务，点击标题后能在详情看到至少：冻结配置、attempt 列表、按序的工具/消息时间线；sessionQuery 缺失时给出明确不可用原因而非白屏。
- **SC-005**：对失败任务发起一次追问，能产生新 attempt、新 runId，并在详情看到新一轮的工具调用过程。
- **SC-006**：`npm run typecheck`、`npm test`、`npm run build` 全部通过，且新增跨宿主边界能力均有单测/契约测试（Principle VII）。

## Assumptions

- 宿主版本提供 `AgentPresets.standingKeyFor(id?)`（本机 0.1.5-rc.2 源码已见，`agent-presets/src/index.ts:770`）；极旧版本若缺失，按 FR-003 降级。
- 子 run 的会话日志可被 `sessionQuery` 冷读（web 部署具备 session 持久化）；不可读时按 FR-009 降级提示。
- v1 二次对话采用「关联追问轮次（新 run/新 attempt）」而非同一会话 continuable 续聊；continuable 需持久交互父会话，根 ctx 后台派发不保证具备，列为后续增强（见 research.md 2.5）。
- 项目根技能（按工作区 cwd 发现）不在本期范围；本期解决用户级（user-dsh/user-agents）与内置技能的冷启动全量。
- 详情以 overlay 内弹层（沿用现有 dialog 模式）呈现，不新增独立主面板/Tab。

# Tasks: dsh-tfs-requirment —— TFS 需求驱动的 DSH 任务看板插件

**Input**: 设计文档 `specs/001-tfs-requirement-board/{plan.md, spec.md}`（含 6 用户故事、FR-001~031、S-01~16 补充）
**Prerequisites**: plan.md（必需）、spec.md（必需，含用户故事优先级）、checklist（requirements-quality/security 已生成）
**Constitution**: v1.1.0，原则 VII 要求**测试任务必选**（已覆盖 tasks-template 的 "Tests OPTIONAL" 默认约定）

**Tests**: 本项目**测试必选**（宪法 Principle VII）。每个用户故事阶段均含单元测试与涉及外部边界的契约测试；
跨 TFS / MCP / DSH 边界的改动必须补充契约测试。任务完成前必须通过测试门禁。

**Organization**: 任务按用户故事分组，便于独立实现与测试。

## Format: `[ID] [P?] [Story?] Description`

- **[P]**: 可并行（不同文件、无未完成任务依赖）
- **[Story]**: 用户故事标签（US1~US6）；Setup/Foundational/Polish 阶段无此标签
- 所有路径基于 plan.md 的目录结构

---

## Phase 1: Setup（共享基础设施）

**Purpose**: 插件包初始化与规格子文档落地

- [X] T001 创建插件包骨架 `package.json`（`@deepseek-ai/dsh-tfs-requirment`；`main: lib/index.js`；`exports` 含 `.`/`./client`/`./cordis.patch.yml`/`package.json`；`dsh.bundle.patch`；`dsh.client.platform: 'web'`；peerDeps `*` 指向 `@deepseek-ai/*`）
- [X] T002 [P] 编写 `cordis.patch.yml`（`- insert: - id: tfs-requirment / name / config`；并声明 `tfs-mcp` server 实例，`serverName` 唯一，重复即配置期硬错误）
- [X] T003 [P] 编写 `tsconfig.host.json` 与 `tsconfig.client.json`（参考宿主插件构建约定）
- [X] T004 [P] 更新 `.gitignore`：追加 `.env.*`、`board.json`、`events.jsonl`、插件私有数据目录（PAT 与看板数据不进版本控制，FR-002/FR-031）
- [X] T005 编写 `src/config.ts`（Config schema：defaultCollection 默认 `WN_HIS`、pollIntervalMinutes 默认 5 且最小 1、defaultLabel 默认 `dsh`、maxConcurrentRequirements 默认 3、auditRetentionDays 默认 90）
- [X] T006 编写 `src/index.ts`（宿主入口：`export const name='tfs-requirment'`；`inject` 为扁平字符串数组；`export const Config`；`apply(ctx, config)`）
- [X] T007 [P] 编写 `data-model.md`（Requirement / DsTask / RoleAgent / WriteOp / AuditEvent / BoardState 字段定义，源自 plan §数据模型）
- [X] T008 [P] 编写 `contracts/`：`tfs-mcp` 工具契约（入参/出参）、`installSection` 契约、`slots` 契约、`dry-run` 契约
- [X] T009 [P] 编写 `research.md`（宿主 API 与 tfs-mcp 实测结论汇总，含 file:line）
- [X] T010 [P] 编写 `quickstart.md`（本地 pnpm 安装、profile 配置、mcp 实例声明、DSH web profile 加载验证步骤）

---

## Phase 2: Foundational（阻塞前置，必须全部完成才能开始用户故事）

**⚠️ CRITICAL**: 无用户故事工作可先于本阶段完成

- [X] T011 实现 `src/tfs/adapter.ts`【Principle IV 唯一出口】封装全部 tfs-mcp 调用，注入 profile + collection，工具名映射 `mcp__<serverName>__<rawName>`（依赖 T012）
- [X] T012 [P] 实现 `src/tfs/types.ts`（Requirement / WorkItem / WriteOp 领域类型）
- [ ] T013 实现 `src/tfs/sampling.ts`（实施期一次性脚本：对目标项目实测采样字段/状态流，输出 `docs/` 校验文档，避免猜测 TFS 2018 字段）
- [X] T014 实现 `src/profile/store.ts`【Principle III】PAT profile 读写（gitignored，多 profile 内存/磁盘隔离，删除彻底擦除 S-12，绝不回显；纯逻辑不依赖宿主 API，已单测）
- [ ] T015 [P] 实现 `src/persistence/json-store.ts`（单 `board.json` + collection 命名空间 S-02；revision 乐观锁；解析失败保留原文件不静默重建 FR-020；崩溃保留 S-09）
- [ ] T016 [P] 实现 `src/persistence/events.ts`（`events.jsonl` append-only 写入）
- [ ] T017 [P] 实现 `src/persistence/markdown.ts`（渲染 `.ai-board/计划看板.md`，顶部标注「自动生成请勿手改」）
- [X] T018 实现 `src/core/board/task.ts`（`TaskSnapshot` 四态 `pending/in_progress/completed/deleted` + `blockedBy[]` + `revision`，借鉴 `packages/experimental/agent-team/src/types.ts:71-83`）
- [X] T019 实现 `src/core/board/board.ts`（看板引擎：领取/拆解/指派/状态机/依赖求解/并发 FIFO 排队 S-06，依赖 T018）
- [ ] T020 [P] 实现 `src/core/board/decompose.ts`（需求 → 任务拆解辅助）
- [X] T021 实现 `src/write-guard/dryrun.ts`（变更前后 diff 预览，供 ExecutionPanel 渲染 S-05；纯函数，独立于 T011，作用于 WriteOp.before/after）
- [ ] T022 [P] 实现 `src/write-guard/idempotency.ts`（幂等键生成/查重：标签 `<id>@<col>:<normLabel>` S-08、回写幂等键跨进程稳定）
- [X] T023 [P] 实现 `src/write-guard/audit.ts`（审计日志 append-only + 滚动 90 天 S-03，条目剔除 PAT，插件不可删改；idempotencyKey 与写调用一一对齐 SC-008）
- [X] T024 实现 `src/orchestration/dispatch.ts`（【FR-011】调 `ctx.subagents.start` / `packages/workflow`；并发信号量 maxConcurrentRequirements S-06；每需求绑定独立 session S-09，依赖 T019/T025）
- [X] T025 [P] 实现 `src/orchestration/roles.ts`（角色 → 宿主 provider / agent preset 映射；`autoExecute` S-13；引用缺失时禁用并提示 S-13）

**Foundational 测试（必选，Principle VII）**

- [X] T026 [P] 单元测试：`tfs/adapter` 调用桩、`profile/store` 隔离与擦除、`json-store` 乐观锁与崩溃保留、`write-guard` 四件套（dryrun/idempotency/audit 协同）
      —— 已落地：`tests/adapter.spec.ts`（12）、`tests/roles.spec.ts`（10）、`tests/dispatch.spec.ts`（5）、`tests/host-api.spec.ts`（8）、`tests/host-route.spec.ts`（7）；连同既有 `board/json-store/events/profile/write-guard` 共 11 文件 **84 例全绿**（vitest v4.1.8）。
- [X] T027 契约测试：经 tfs-mcp 对真实 TFS 只读调用 `tfs_whoami` / `tfs_get_current_collection` / `tfs_get_projects` 通过（验证 adapter 映射，不写 TFS）
      —— 真实只读冒烟已通过（whoami→`zhangbo3(张波)`；get_current_collection→`WN_HIS`；get_projects 返回多集合含 WN_HIS/WN_TECH/WN_TJ/WINNING-6.0）；另新增 `tests/tfs-contract.spec.ts`（7 例）用工具桩把只读出口锁定在实测字段名上（`mcp__tfs-mcp__<verb>`、`id:number`、`ids:number[]`、`query`、`keyword`）。

**Checkpoint**: 基础设施就绪 —— 用户故事可并行推进

---

## Phase 3: User Story 1 - 配置 TFS 连接并验证可用性（Priority: P1）🎯 MVP

**Goal**: 设置页配置 URL + PAT（掩码）、测试连接、多集合/多 profile
**Independent Test**: 填入 URL/PAT → 测试连接 → 成功或失败归类；全仓检索无 PAT 明文

- [X] T028 [US1] 实现设置区（`installSection` 注册配置区）。**实现位置修正**：settings 服务是**宿主半**能力，故落在 `src/host/settings.ts`（非 `src/client/settings.ts`），由 `src/index.ts#apply` 调用；宿主无 settings 服务时返回 false 降级。API 已核实：`SettingsProvider.installSection(owner, ns, schema, entry, hooks{setSource,onChange,validate?})`（`@deepseek-ai/dsh-settings/lib/types/index.d.ts:228`）。`validate` 钩子承载 `validateConfig`（pollInterval≥1、并发≥1、defaultLabel 非空、defaultCollection∈collections），配置变更经 `onResolved` 同步 adapter 默认集合。测试 `tests/settings.spec.ts`(5)。
- [~] T028b [US1] MCP 接入区（**降级交付，已核实宿主能力边界**）：宿主 `@deepseek-ai/dsh-mcp-client` 是「一实例一 server」的命名空间插件，`inject` 仅 `['tools']`（`src/index.ts:34`）、**无** `ctx.provide`，其文档要求多 server 需在 `cordis.yml` 多加载实例 → **不存在运行期增删实例的 API**。故不臆造写路径，改交付：`src/host/profile-service.ts#instance()`（serverName 合法性按宿主正则 `^[A-Za-z0-9_-]{1,32}$` 校验、同名互斥风险、工具前缀）+ `envTemplate()`/`writeEnvFile()`（声明式接入的环境模板与环境文件）+ 客户端「连接与凭据」页（明确标注"不支持运行期增删"并给出源码依据）。测试 `tests/profile-service.spec.ts`(16)。
- [x] T029 [US1] 测试连接逻辑：调 `tfs_whoami` / `tfs_get_current_collection` 返回成功或失败归类（认证/地址/权限），错误不含凭据片段
- [x] T030 [US1] 多集合切换 UI：`config.collections` 经 `getPanelData.collections` 下发 → 需求池集合选择器 → `POST /tfs-requirment/collection` → `HostApi.setCollection`（**校验必属清单**）→ `adapter.setCollection` 真实副作用；配置页保存后就地刷新清单数组（保持引用，避免 API 侧看到旧清单）。多**项目**筛选已由需求池 `project` 输入框覆盖（项目清单来自 tfs-mcp `tfs_get_projects`，UI 暂为自由输入）。测试 `tests/host-route.spec.ts`（集合路由 2 例）。
- [x] T031 [US1] 多 profile 切换：**此前 `ProfileStore` 全项目零引用（死代码）**，本轮接入 `src/host/profile-service.ts`（list/save/remove/activate + 活动档案指针落盘 `profile-active.json`）+ 4 条路由 + 「连接与凭据」页档案区。凭据隔离：对外一律 `ProfileView`（无 pat 字段，类型层防线）；`getCredential()` 仅 2 处调用（沿用原 PAT、写环境文件）；删除走随机字节覆写（S-12）。测试 `tests/profile-service.spec.ts`。
- [x] T032 [US1] 单元测试：settings schema 校验（`tests/settings.spec.ts`(5) 与 `validateConfig` 用例；`pollIntervalMinutes ≥ 1` / `maxConcurrentRequirements ≥ 1` / `defaultLabel` 非空 / `defaultCollection ∈ collections`）
- [x] T033 [US1] 契约测试：PAT 不明文回显、不落 `.env` 以外文件、不进日志（CHK002/CHK003）

**Checkpoint**: US1 可独立验证（连接 + 凭据安全）

---

## Phase 4: User Story 2 - 需求池：拉取/筛选/详情/领取（Priority: P1）

**Goal**: 从 TFS 拉需求到本地池，支持筛选/分页/刷新/详情/领取
**Independent Test**: 配置连接即可拉取真实工作项并翻页查看详情，无需本地任务

- [X] T034 [US2] 实现 `src/client/components/RequirementPool.tsx`（列表/筛选/分页/详情/领取；主区视图）。已实现：关键字/状态/项目筛选、结果表格、「选为目标」→ 写入执行配置目标（`id@collection`，形成端到端链路）。**外部阻断**：拉取经宿主 `POST /tfs-requirment/requirements` → adapter `listRequirements`（走 `tfs_custom_query`），但该工具在当前 tfs-mcp 构建下被 TFS 拒绝（详见文末"进展登记"），UI 显式显示错误而非伪装空列表。
- [X] T035 [US2] 调 `tfs/adapter` 实现 listRequirements（按状态/指派/迭代/关键字筛选、分页）。已实现 `listRequirements`/`getRequirement`/`normalizeWorkItem`（对齐 T013 实测归一化形状，含 `{id,fields}` 兼容兜底），测试 `tests/normalize.spec.ts`(6) + `tests/host-api.spec.ts` 需求用例。
- [x] T036 [US2] 领取/同步到本地池（去重键 `workItemId@collection` S-01，幂等不重复）
- [x] T037 [US2] 手动刷新 + 定时轮询：`pollIntervalMinutes` 经 `getPanelData` 下发 → 需求池 `setInterval`（页签隐藏时跳过并计数）→ 增量判定用**共享纯函数** `src/shared/poll.ts#mergeRequirementPage`（新增/更新/无变化/保留 + 变更键高亮）。轮询失败**不清空**已显示数据。测试 `tests/poll.spec.ts`(16)。**设计取舍**：轮询放在客户端——宿主侧定时刷新没人接收（客户端是拉取式），只会白烧 TFS 调用配额。
- [x] T038 [US2] 单元测试：去重键生成、增量更新判定、零状态空界面（S-16）
- [x] T039 [US2] 契约测试：listRequirements 对真实 TFS 返回字段映射正确（依赖 T013 采样） —— **2026-09-17 落地**：以真实 WIQL 样本（实测 id=2 / id=1）为事实来源，`tests/tfs-list-contract.spec.ts`（25 例）锁死字段映射、列表出口与两道护栏

**Checkpoint**: US2 可独立验证（读侧完整）

---

## Phase 5: User Story 3 - 任务中心：拆解/指派/生命周期（Priority: P1）

**Goal**: 需求拆任务、指派角色、启动/暂停/重试/取消、看日志
**Independent Test**: 一条已领取需求完整走「拆解→指派→启动→看日志→重试」闭环，不依赖回写

- [x] T040 [US3] 实现 `src/client/components/TaskCenter.tsx`（挂 `conversation.panel` 常驻侧栏，FR-028）
- [x] T041 [US3] 拆解需求为任务（`decompose`）+ 人工增删调整
- [x] T042 [US3] 指派角色智能体（`roles` 映射 + `autoExecute`）
- [x] T043 [US3] 启动/暂停/重试/取消 + 执行日志/中间产物/结果查看（断点重试按子任务粒度 S-07）
- [x] T044 [US3] 按状态/角色/需求/时间筛选；并发超限时「排队中」可见（S-06）
- [x] T045 [US3] 单元测试：board 状态机（四态转换）、`blockedBy` 依赖求解、FIFO 排队
- [x] T046 [US3] 单元测试：断点重试跳过已完成子任务、从失败子任务续跑（S-07）

**Checkpoint**: US3 可独立验证（编排核心）

---

## Phase 6: User Story 4 - 需求交付：执行/打标签/回写（Priority: P1）

**Goal**: 选中需求设参发起执行，打 dsh 标签，完成后按配置回写 TFS（dry-run 预览）
**Independent Test**: 对测试需求发起执行→入队打标签（幂等）→回写前有 dry-run 预览→确认后工作项变更

- [X] T047 [US4] 实现 `src/client/components/ExecutionPanel.tsx`（MCP/技能/模型/角色设置 + dry-run 预览卡片 + 「确认回写」按钮 S-05；含 `src/client/slots.tsx` 经 `shell.overlay` 注册与 `src/client/index.tsx` 真实 `apply`/`inject` 入口）
- [x] T048 [US4] 进入队列即打 `dsh` 标签（幂等 S-08、失败/取消/中断保留 FR-014，经 write-guard）
- [X] T049 [US4] 发起执行 `dispatch`（ctx.subagents，并发上限 S-06，每需求独立 session S-09）
      —— 宿主侧已接通：`src/host/api.ts#dispatch` 按角色名解析 → 构建 `DispatchRequest` → `RequirementDispatcher.dispatch`（`ctx.subagents` 经 `makeSubagentClient` 包装，并发上限取配置 FR-029）；客户端经 `POST /tfs-requirment/dispatch` 触发。**S-09 现状**：每任务 one-shot run 并按 requirementId 归组追踪（真·单 session 多任务续跑留待宿主支持 continuable 后升级）。
- [X] T050 [US4] 回写 TFS：状态/评论/标签/关联，过四道门禁（dryrun→确认→幂等→审计，依赖 T021/T022/T023）
      —— 宿主侧已接通：`src/host/api.ts#confirmWrite` 把 tag/comment/state 草稿映射到 adapter 写方法（均 `confirmed=true` 过 WriteGuard 四道门禁）；**关联（link）暂明确拒绝**（S-04：关联走评论，独立 link 写在 tfs-mcp 无工具）。
- [x] T051 [US4] TFVC 关联 = 向工作项追加评论含 changeset/shelveset/branch 链接（S-04，不写专用字段）；**降级**：经实测 tfs-mcp 未见 shelveset list/get/create 工具（plan 风险项），shelveset 工具缺失时仅关联 changeset/branch 链接、跳过 shelveset，不阻塞主回写链路（与 FR-026 降级一致） —— **2026-09-17 重估并落地**：本轮工具目录中 TFVC 系列已出现（`tfs_list_tfvc_changesets` / `tfs_get_tfvc_changeset` / `tfs_get_tfvc_changeset_changes` / `tfs_list_tfvc_branches` / `tfs_list_tfvc_items`），但**目录内仍无任何"建立工作项↔变更集关系"的写工具**（无 `add_relation` 类）→ 关联回写仍走评论，但评论改为携带**真实变更集元数据**（先只读 `tfs_get_tfvc_changeset` 取作者/时间/说明，取不到则降级为仅带 `C<id>` 的精简评论）。新增 `listChangesets` / `getChangeset` / `getWorkItemCommits` / `linkChangeset`。
- [ ] T052 [US4] revision 冲突中止 + 要求人工重 dry-run，禁自动覆盖（S-11/FR-017）
- [ ] T053 [US4] 单元测试：write-guard 四道门禁、标签幂等、审计 append-only 剔除凭据
- [x] T054 [US4] 契约测试：回写对真实 TFS 沙盘（dry-run 预览与实际写入一致；谨慎使用写调用） —— **2026-09-17 落地**：`tests/tfs-list-contract.spec.ts` §T054（7 例）以工具桩做沙盘回写，覆盖门禁2 未确认即拒、元数据读取 + 评论回写、元数据失败降级、同变更集幂等拦截、不同变更集不误判

**Checkpoint**: US4 可独立验证（价值终点，含安全门禁）

---

## Phase 7: User Story 5 - 角色智能体管理（Priority: P2）

**Goal**: 增删改角色，绑定 provider/preset、默认 MCP/技能/模型、autoExecute、标签策略
**Independent Test**: 新建角色后在 US3 指派下拉可见并可被选用

- [X] T055 [US5] 实现 `src/client/components/RoleSettings.tsx`（CRUD；provider/preset 引用、autoExecute、默认 MCP/技能/模型、默认标签策略，存插件 JSON）。已实现列表/新建/编辑/删除，数据经宿主 `GET /tfs-requirment/roles`、`POST /role-save`、`POST /role-delete`（宿主半落 `roles.json`，`saveRole` 校验、`deleteRole` 保护）。
- [X] T056 [US5] 引用缺失时该角色在指派下拉禁用并提示（S-13）。已实现：`RoleSettings` 在列表内对 provider 不在宿主可用清单的角色标 ⚠ 提示（`availableProviders` 由宿主注入）；`resolveRoleAvailability`（roles.ts）保留运行时判定，宿主可用 provider 清单的注入点待宿主能力枚举接线。
- [X] T057 [US5] 删除被引用角色的保护（阻止或显式确认，给出受影响引用清单，US5 AC3）。已实现：`host/api.ts#deleteRole` 默认拒绝并返回 `references`，`force=true` 才删；UI 二次确认后带 force 重试。测试覆盖于 `tests/host-api.spec.ts`。
- [x] T058 [US5] 单元测试：角色配置 schema、provider/preset 引用校验、autoExecute 生效范围

**Checkpoint**: US5 可独立验证

---

## Phase 8: User Story 6 - 状态持久化与跨 session 恢复（Priority: P2）

**Goal**: 状态落文件、重启恢复、Markdown 看板、崩溃对账
**Independent Test**: 创建任务→重启 DSH→重新打开，任务/状态/日志/验收记录逐字段一致

- [x] T059 [US6] 跨 session/重启恢复（从 `board.json` 恢复；session 镜像只读不覆盖 S-09）
- [x] T060 [US6] 崩溃对账（task.revision vs TFS 标签/审计；悬空项标「待人工核对」S-10）
- [x] T061 [US6] Markdown 看板渲染与 json→md 一致性校验
- [x] T062 [US6] 单元测试：`json-store` 崩溃保留原文件、解析失败不静默重建（FR-020）
- [x] T063 [US6] 审计 90 天滚动归档：**此前 `AuditLog.rollOver()` 无任何调用点，`auditRetentionDays` 是未被消费的配置项**。本轮新增 `src/host/audit-archive.ts`（inspect/archive/readArchive）+ `GET /audit` + `POST /audit-archive` + 「连接与凭据」页归档区。不变式：live 日志**逐字节不变**、无过期条目不创建空文件、**跨归档文件去重**（live 从不截断 → 次日不得重复归档）、损坏不静默成功。测试 `tests/audit-archive.spec.ts`(11)。

**Checkpoint**: US6 可独立验证（持久化闭环）

---

## Phase N: Polish & Cross-Cutting

- [x] T064 [P] 文档：`README.md`（安装三步 + 凭据传递机制含宿主源码依据 + 配置项表 + 数据落盘清单 + 门禁命令）+ `specs/001-tfs-requirement-board/acceptance-inventory.md`（SC-001~009 验收清单）
- [x] T065 [P] a11y 最低要求（v1，非完整合规）：`section aria-labelledby` 分区、表单控件 `label htmlFor`/`id` 关联、状态区 `role="status" aria-live="polite"`、模板 `pre tabIndex={0} aria-label`、tab 按钮 `type="button" aria-current`、所有按钮显式文本。**未做**：焦点陷阱、完整键盘导航顺序审计、对比度审计。
- [x] T066 安全评审：`specs/001-tfs-requirement-board/security-review.md`（写门禁四道 + 写路径唯一入口 `executeWrite` 5 处 grep 证据；PAT 全链路；凭据擦除单实现；审计 append-only；**残余风险 R1~R6**）
- [x] T067 集成测试：端到端（配置→拉取→拆解→指派→执行→打标签→回写→恢复）
- [~] T068 验收：`acceptance-inventory.md` 已逐项登记（SC-001/003~009 自动化通过；**SC-002 真实 TFS 复验受阻**于 tfs-mcp 列表工具缺陷，标 `[受阻]`；需真实 PAT 的手工项标 `[未实测]`）

---

## Dependencies & Execution Order

### Phase Dependencies

- **Setup (T001-T010)**: 无依赖，可最先开始
- **Foundational (T011-T027)**: 依赖 Setup；**阻塞全部用户故事**（T019 依赖 T018；T024 依赖 T019/T025；T021 依赖 T011）
- **US1 (T028-T033)**: 依赖 Foundational（T014 profile、T011 adapter）
- **US2 (T034-T039)**: 依赖 Foundational（T011/T015/T019）
- **US3 (T040-T046)**: 依赖 Foundational（T019/T020/T024/T025）
- **US4 (T047-T054)**: 依赖 US3（任务中心）+ Foundational（T021/T022/T023/T024）
- **US5 (T055-T058)**: 依赖 Foundational（T025）
- **US6 (T059-T063)**: 依赖 Foundational（T015/T016/T017）
- **Polish (T064-T068)**: 依赖所有故事

### User Story 并行机会

Foundational 完成后，US1~US6 可并行推进（不同模块、接口已在 contracts/ 锁定）：
- US1 设置页 ↔ US2 需求池（共享 adapter）↔ US5 角色（共享 roles）可同期开发
- US3 任务中心与 US4 执行回写强相关（US4 依赖 US3 的任务模型），应顺序或紧密协作

### Within Each User Story

- 测试任务（标记 `[USx]` 的 T032/T033、T038/T039、T045/T046、T053/T054、T058、T062/T063）必选，先写且失败后再实现
- 模型/类型先于服务，服务先于 UI
- 故事完成前过测试门禁

### Parallel Examples

```bash
# Foundational 内可并行（不同文件、无依赖）：
Task: "T012 实现 src/tfs/types.ts"
Task: "T015 实现 src/persistence/json-store.ts"
Task: "T016 实现 src/persistence/events.ts"
Task: "T017 实现 src/persistence/markdown.ts"
Task: "T022 实现 src/write-guard/idempotency.ts"
Task: "T023 实现 src/write-guard/audit.ts"
Task: "T025 实现 src/orchestration/roles.ts"

# Foundational 完成后并行推进：
Task: "T028 [US1] 设置页"
Task: "T034 [US2] 需求池"
Task: "T055 [US5] 角色管理"
```

---

## Implementation Strategy

### MVP First（User Story 1 Only）

1. Setup + Foundational 完成
2. US1（T028-T033）完成 → 验证连接与凭据安全
3. **STOP and VALIDATE**: 确认可配置并测试连接、PAT 不回显

### Incremental Delivery

1. Setup + Foundational → 基础设施就绪
2. + US1 → 连接可用（MVP）
3. + US2 → 需求可读（读侧闭环）
4. + US3 → 任务可编排
5. + US4 → 执行与回写（价值终点）
6. + US5/US6 → 角色管理与持久化（增强）
7. 每阶段独立可演示

---

## Notes

- [P] 任务 = 不同文件、无未完成任务依赖
- [Story] 标签将任务映射到具体用户故事以便追溯
- 每故事独立可完成、可测试；测试任务按 Principle VII 必选
- 提交按逻辑分组；宪法 Principle II/III 相关改动需过安全评审（T066）

---

## 进展登记（2026-09-17，Phase 3 集成 + 全面测试）

### 已消除的运行时 / 构建阻断

1. **adapter 写工具字段名全部为臆测占位**（运行期必失败）：经实测 tfs-mcp 工具 JSON Schema
   （发空参触发 `additionalProperties:false` 校验反推，不触发真实写）修正：
   `tfs_add_tags.tags` 为**分号拼接字符串**（非数组）、所有 `id` 为 **number**；
   `tfs_assign` 字段名为 **`assignedTo`**（原 `assignTo` 是 bug）；`tfs_create_workitem` 必填
   `project`/`workItemType`/`title`（自定义字段收敛到 `fields` 对象）；集合一律**内联 `collection`**
   透传（删除多余且会报错的 `tfs_set_collection` 预调用）。见 `src/tfs/adapter.ts`。
2. **`DefaultHostBridge` 占位返回"未接线"**（面板按钮点了没反应）：以真实 client→host HTTP 路由
   替换——宿主半 `src/host/{api,route,http-util,web-guard}.ts` 注册
   `GET /tfs-requirment/panel-data`、`POST /tfs-requirment/confirm-write`、`POST /tfs-requirment/dispatch`
   （`ctx.inject(['webServer'])` + 鉴权门栅）；客户端半 `src/client/slots.tsx` 的 `HttpHostBridge`
   用 `fetch` 调用。模式实测复核 `dsh-optimized-prompt`（routes.ts / host-api.ts / web-guard.ts）。
3. **缺 `tsdown.config.ts`**（服务端可跑、客户端永远装不上）：package.json 的 `build` 调 `tsdown`
   但无配置 → `lib/client.js` 永不产出 → 面板在浏览器侧静默消失。已补齐 `tsdown.config.ts`
   （`__ModuleLoader__.load` 闭包工厂，外部化 react/react-jsx-runtime）；`npm run build` 现全绿，
   产出 `lib/client.js` + `lib/types/**`。
4. **客户端入口 `export default apply`**（触发 MIXED_EXPORTS，加载器可能取错默认导出）：已改为
   仅命名导出 `name`/`inject`/`apply`（对齐 DSH 客户端契约）。
5. **`dispatch.cancel()` 追踪清理键错误**（`byRequirement.get(taskId)`，应以 requirementId 为键）：
   修正为遍历 values 定位包含该 taskId 的集合再删除。见 `src/orchestration/dispatch.ts`。
6. **`confirmWrite` 会对占位目标发出 `id:NaN`**：补数字 id 校验（非正整数即拒），由单测锁定。

### 测试与门禁

- `npm run typecheck`（host + client + tests 三程序）：**全绿**。
- `npm test`（vitest v4.1.8）：**11 文件 / 84 例全绿**。
- `npm run build`（tsc host + tsc client + tsdown）：**全绿**。

### 仍然待办（未完成，诚实标注）

- US1~US6 的面板（T028/T028b/T034/T040/T055 等）与设置区、MCP 管理区、需求池/任务中心/角色管理 UI 尚未实现。
- T013 的独立采样脚本 `src/tfs/sampling.ts` + `docs/` 未建立（其"拒绝猜测 TFS 字段"的目标已用
  实测 schema 采样替代达成，见 `adapter.ts` 注释与 `tests/tfs-contract.spec.ts`）。
- S-09 真·单 session 多任务续跑（continuable）待宿主能力就绪后升级；当前为按需求归组的 one-shot run。
- T048「进入队列即打 dsh 标签」的触发点、T051 TFVC 评论关联、T067 端到端集成测试尚未接线。

---

## 进展登记（2026-09-17 第二轮：US1 设置区 / US2 需求读取 / US5 角色管理）

### T013 正式采样：tfs-mcp 工作项**归一化形状**（实测，非猜测）

`tfs_get_workitem({id})` 返回的不是原始 TFS 字段引用，而是 tfs-mcp 归一化后的扁平对象（实测工作项 #1）：
```
{ id:number, title, type, state, reason, priority, severity, requirementType, discipline,
  moduleName, devLeader, testLeader, prodLeader, assignedTo, createdDate, changedDate,
  project, areaPath, description, demandAnalysis, tags(分号字符串), iterationPath, url,
  relations:array, collection }
```
据此实现 `adapter.normalizeWorkItem`（并对 `tfs_custom_query` 声明的 `{id, fields}` 形状兼容兜底）。
**注意**：`get_workitem` 会连带返回**全部 relations**（实测 #1 的响应达 **3.3MB**），故列表循环**不得**逐条 get_workitem。

### 外部运行时阻断（tfs-mcp 侧缺陷，非本插件代码问题）

2026-09-17 实测：当前连接中的 tfs-mcp 构建，**列表/查询类工具整体不可用**——

| 工具 | 实测结果 |
|---|---|
| `tfs_query_wiql` | `Failed request: (414)` |
| `tfs_search_work_items` | `Failed request: (414)` |
| `tfs_get_bugs` | `Failed request: (414)` |
| `tfs_custom_query`（含默认） | `The expand parameter can not be used with the fields parameter.` |
| `tfs_get_work_items`（带 fields） | 同上（expand 与 fields 冲突） |
| `tfs_get_workitem`（按 id） | 可用（但含全部 relations，响应巨大） |
| 元数据（whoami / get_current_collection / get_projects / get_my_tasks） | 可用 |

根因推断：tfs-mcp 构造请求时**同时**发送 `expand` 与 `fields`（TFS 拒绝该组合），且 WIQL/检索走 GET 时 URL 过长（414）。
依 Principle IV（tfs-mcp 为唯一出口）**不绕过**该层；adapter 按工具**声明的 schema** 正确构造调用，
失败时返回 `ok:false` + 可读原因，UI 显式提示（不伪装成"TFS 里没有需求"）。tfs-mcp 修复后即恢复。

### 本轮落地

- **T028 设置区**：`src/host/settings.ts`（`installSection` 注册 `tfs-requirment` 命名空间，
  `validate` 承载 `validateConfig`，变更经 `onResolved` 同步 adapter 默认集合）；`tests/settings.spec.ts`(5)。
- **T034/T035 需求读取**：`adapter.listRequirements/getRequirement/normalizeWorkItem`（`tfs_custom_query`）；
  `host/api.ts#listRequirements`；路由 `POST /tfs-requirment/requirements`；客户端 `RequirementPool.tsx`；
  `tests/normalize.spec.ts`(6) + host-api/route 需求用例。
- **T055/T056/T057 角色管理**：`host/api.ts#listRoles/saveRole/deleteRole`（T057 引用保护 + force）；
  路由 `GET /roles`、`POST /role-save`、`POST /role-delete`；客户端 `RoleSettings.tsx`（T056 provider 缺失提示）。
- **客户端工作台**：把 需求池 / 执行配置 / 角色管理 合并为**单一 `shell.overlay` 条目**的标签页
  （`src/client/slots.tsx` 的 `Workbench`），原因：多个 overlay entry 会同时全屏渲染并相互遮挡。
  需求池「选为目标」→ 执行配置目标变为 `id@collection`，形成端到端链路。

### 门禁（全绿）

- `npm run typecheck`（host+client+tests）：**EXIT 0**。
- `npm test`：**13 文件 / 106 例全绿**。
- `npm run build`：**EXIT 0**，`lib/client.js` 50.57 kB（含新面板）+ `lib/types/**`。

### 仍待办

- T028b McpManager（自建 MCP 设置 UI）、T029-T033（测试连接/多集合/多 profile/PAT 安全契约）、
  T036-T039（领取同步/轮询/增量）、T040-T046（任务中心）、T048/T051（入队打标签/TFVC 关联）、
  T058/T067（角色单测/端到端）。
- 宿主可用 provider/preset 清单的注入点（T056 运行时判定）待宿主能力枚举接线。

---

## 进展登记（2026-09-17 第三轮：看板接线 / 任务中心 / 端到端测试）

### 本轮消除的**头号阻断**：看板链路整体未接线

`core/board/board.ts`（看板引擎）、`persistence/{json-store,events,markdown}`、`core/board/decompose.ts`
此前**各自实现完整，但没有任何一处调用它们**——也就是说 US2 领取、US3 任务中心、US6 跨重启恢复
整条链路在运行期不存在（点了没有任何反应，也没有报错）。本轮补齐装配点：

- 新增 **`src/host/board-service.ts`**（`BoardService`）：把看板引擎 + JSON 权威落盘 + 事件日志 +
  Markdown 渲染 + tfs 写出口 + 角色表粘合起来，全部依赖可注入（内存 fs + 桩 adapter 可测）。
- `core/board/board.ts` 补齐此前缺失的**任务生命周期 API**：`addTasks`（批量、先整体校验不半写）、
  `startTask`（启动/重试，含依赖就绪校验）、`finishTask`（success→completed / failed→保留可重试 /
  cancelled→deleted）、`assignTask`、`reconcileDangling`（S-10 崩溃对账）、`resumableForRequirement`
  （S-07 断点续跑）、`updateRequirement`（T048 打标签后同步本地副本）、`setMarkdownViewPath`。
- 新增 **`src/host/health.ts`**（T029 自检 + T028b 工具盘点 + 凭据擦除归类）。

### 端到端测试当场抓到的**两个真实接线缺陷**（已修）

1. **派发/看板 taskId 命名空间不一致（严重）**：`host/api.dispatch` 用 `targetWorkItem#<roleId>`
   合成 taskId，而看板拆解出的任务是 `targetWorkItem#analyze|#impl|#verify`。两者对不上 →
   **run 的完成/失败永远回绑不到看板任务**，任务会永久停在 `running`。
   修复：`DispatchInput.taskId` 贯通（route body → api → dispatcher），派发前先 `setTaskState('start')`
   （失败即拒，避免"派发了但看板没动"），并通过 `RequirementDispatcher.getRun(taskId)` 暴露 run 句柄，
   在 `run.result` 落定时**自动收口**看板任务为 completed / failed。
2. **凭据擦除只覆盖了自检路径**：`tfs/adapter` 的写失败原因直接把 tfs-mcp 原始报错透出，
   而 TFS/tfs-mcp 的报错常回显请求 URL（支持 `?token=`/`?pat=` 查询串鉴权）→ 面板与日志会泄漏 PAT。
   修复：把擦除提取为共享纯函数 `src/shared/redact.ts#scrubCredentials`（只此一份实现），
   在 `adapter.executeWrite` 与 `listRequirements` 的错误路径统一调用；`host/health.ts` 改为再导出。

同时记账一处**测试期踩坑（非产品缺陷）**：`Board.snapshot` 返回**内部活引用**（`readonly` 只在类型层），
持引用跨变更读会看到新值（如 `revision` 已被 +1）。已在 `board.ts` 加显式契约警告；
服务层所有"读 revision → 同帧变更"均为同步、无 await 间隔，故无现实缺陷。

### 新增/改动源码

- 新增：`src/host/board-service.ts`、`src/host/health.ts`、`src/shared/redact.ts`、
  `src/client/components/TaskCenter.tsx`（T040~T044）。
- 改：`src/core/board/board.ts`（生命周期 API + 契约警告）、`src/orchestration/dispatch.ts`
  （`runHandles` + `getRun`）、`src/host/api.ts`（6 个新能力 + 派发绑定）、`src/host/route.ts`
  （6 条新路由 + `postJsonHandler` 骨架）、`src/shared/contracts.ts`（看板视图类型 + 6 条路由 +
  `HostBridge` 6 个方法 + `dispatch(req, taskId?)`）、`src/index.ts`（装配 BoardService + load +
  reconcile + 工具盘点）、`src/client/slots.tsx`（桥扩展 + 「任务中心」「连接诊断」两个标签页、
  从 3 标签扩到 5 标签）、`src/client/components/RequirementPool.tsx`（「按 ID 领取」+「领取入池」）、
  `src/tfs/adapter.ts`（错误路径擦除）、`src/tfs/types.ts`（`Requirement` 增可选 `type/url/areaPath`）。
- 新增测试：`tests/board-service.spec.ts`(39)、`tests/health.spec.ts`(15)、`tests/e2e.spec.ts`(6)，
  并扩 `tests/host-route.spec.ts`(+11)。

### ⚠️ 外部运行时阻断（tfs-mcp 侧缺陷，非本插件问题；沿用第二轮实测结论）

列表/查询类工具整体不可用（`tfs_query_wiql`/`tfs_search_work_items`/`tfs_get_bugs` → HTTP 414；
`tfs_custom_query`/`tfs_get_work_items` → `expand` 与 `fields` 冲突被 TFS 拒）。故需求池提供
**「按工作项 ID 领取」**这一实测可用读路径（走 `tfs_get_workitem`），使 US2 核心价值不被外部缺陷完全阻断。

### 设计决策：需求池的降级读路径

`RequirementPool` 显式区分两条读取路径并在失败时**显式提示**（而非伪装成"TFS 里没有需求"）：
列表路径失败 → 红色错误块 + 指向「按 ID 领取」；按 ID 路径走 `tfs_get_workitem`（实测可用）。

### 门禁（全绿）

- `npm run typecheck`（host + client + tests）：**EXIT 0**。
- `npm test`（vitest v4.1.8）：**16 文件 / 176 例全绿**。
- `npm run build`（tsc×2 + tsdown）：**EXIT 0**，`lib/client.js` **81.68 kB**（含任务中心/连接诊断）。

### 仍待办（诚实标注，未完成）

- **T028b McpManager 增删**：当前「连接诊断」页可展示 tfs-mcp 工具**可用/缺失**清单，
  但**未**实现经宿主 `mcp-client` 新增/移除 server 实例（宿主无现成 MCP 设置 UI，需自建写路径）。
- **T037 定时轮询**：手动刷新已可用；`pollIntervalMinutes` 定时轮询与增量（按 updatedTime/revision）未接线。
- **T030/T031**：多集合 UI（宿主已支持 `collection` 内联）、多 profile 切换 UI 未实现。
- **T039/T054**：对真实 TFS 的字段映射/沙盘回写契约测试未做（依赖 tfs-mcp 列表工具修复；
  只读契约测试 `tests/tfs-contract.spec.ts` 已覆盖 whoami/collection/projects/get_workitem）。
- **T051 TFVC 关联**：降级为评论回写（S-04），shelveset 工具缺失时跳过（实测无该工具）。
- **T063** 审计 90 天滚动归档、**T064** README/安装配置文档、**T065** a11y、**T066** 安全评审全量、**T068** 验收清点未做。
- **S-09 真·单 session 多任务续跑**：当前为按需求归组的 one-shot run（已暴露 `getRun` 便于后续升级）。

---

## 进展登记（2026-09-17 第四轮：审计归档 / 定时轮询 / 集合切换 / 连接档案 / MCP 接入 + 文档与验收）

### 本轮的起点：先找"实现了但没接线"的死代码（而不是先写新功能）

沿用第三轮"看板链路全项目零调用点"的教训，本轮先用 `grep` 核对剩下几个**配置项与模块**是否有运行期消费点：

| 对象 | 本轮开工前的实测事实 | 后果 |
|---|---|---|
| `pollIntervalMinutes` | 仅出现在 `config.ts` 定义与 `validateConfig` | 定时轮询**在运行期不存在** |
| `auditRetentionDays` | 仅出现在 `config.ts` 定义 | 90 天保留策略**在运行期不存在** |
| `AuditLog.rollOver()` | **零调用点** | 归档能力写了但没接 |
| `collections` | 仅在 `index.ts:109` 的日志文案里 join 了一次 | 多集合切换**在运行期不存在** |
| `ProfileStore` | **除自身模块外全项目零引用** | PAT 隔离（FR-002/FR-031/S-12）写了但没接 |

把这五项一次接完，是本轮的主体。

### 关键决策 1：轮询放客户端（有依据的取舍，不是图省事）

宿主半若自己起定时器，刷新结果**没人接收**——客户端是拉取式（HTTP 路由），服务端多刷几次只是
白烧 TFS 调用配额，UI 仍是旧数据。故：`pollIntervalMinutes` 经 `getPanelData` 下发到客户端，
由需求池排程；增量判定抽成**共享纯函数** `src/shared/poll.ts#mergeRequirementPage`
（可脱离 DOM 与 React 单测，`tests/poll.spec.ts` 16 例）。
细节：页签 `visibilityState === 'hidden'` 时**跳过**并计数（后台标签页不该持续打 TFS）；
轮询失败**不清空**已显示数据（失败不该让用户手上的列表消失）。

### 关键决策 2：T028b 不臆造宿主没有的 API

实测宿主 `@deepseek-ai/dsh-mcp-client`：`inject` 仅 `['tools']`（`src/index.ts:34`）、无任何 `ctx.provide`，
其模块头注释明确 "Each plugin instance connects to one MCP server; load multiple instances in `cordis.yml`"。
→ **不存在运行期增删 MCP server 实例的服务**。故不写"添加服务器"按钮（那会是假按钮），改交付：

1. `serverName` 合法性校验（照抄宿主正则 `^[A-Za-z0-9_-]{1,32}$`，`src/index.ts:40`）——不合法的名字会让**该实例在加载期失败**，这是最该提前告知的事；
2. 同名互斥风险说明（`src/index.ts:160-167` 的 `activeServerNames`）；
3. 可复制的接入模板 + 写出 `tfs-mcp.env`（含明文 PAT，尽力 `chmod 0600`）。

### 关键决策 3：凭据为什么只能"启动前 export"（含源码依据）

```
@deepseek-ai/dsh-mcp-client/src/transport.ts:21-23
  buildChildEnv(extra) = { ...scrubbedParentEnv(), ...extra }
```

父进程里"凭据形状"的变量会被 `scrubbedParentEnv()` 清洗掉，**只有 patch 的 `env`（extra）能覆盖**。
因此 `cordis.patch.yml` 本轮补上了：

```yaml
        env:
          TFS_URL: !!js process.env.TFS_URL || ''
          TFS_COLLECTION: !!js process.env.TFS_COLLECTION || ''
          TFS_PAT: !!js process.env.TFS_PAT || ''
```

而 `!!js` 在**配置解析期**求值（早于任何插件 `apply`）→ 插件无法运行期注入 → 面板只提供
「写出环境文件」与「可复制模板」，并显式说明"切换凭据需重载插件/重启 Host"。
**这是一处此前只写在 yml 注释里的承诺（"由插件运行时经 profile 注入"），本轮把它改成可执行的机制。**

### 修掉的两个真实缺陷（都是本轮新增测试抓出来的）

1. **审计归档的跨文件重复写入**：初版只在"今天那个归档文件"内去重。但 live 日志 append-only、
   **从不截断**，所以过期条目在源里永远还在 → **每天归档一次就把同一批条目再写一遍**，归档目录随天数线性膨胀。
   修复：去重集合改为**全部既有归档文件的并集**（`seenInArchives()`），并补测试断言
   "day1 归档过的条目在 day2 不再重复归档，而新过期条目仍会落到 day2 文件"。
2. **React 更新器内调 `setState`**：需求池初版在 `setItems(prev => ...)` 内部再调 `setChangedKeys`/`setPoll`，
   更新器在 StrictMode 下会**被双调用** → 增量计数翻倍 + React 警告。
   修复：用 `itemsRef` 作为增量合并的**同步事实源**，合并后一次性写回 state（与调用次数无关）。

### 新增/改动源码

- 新增：`src/host/audit-archive.ts`（T063）、`src/host/profile-service.ts`（T031 + T028b）、
  `src/shared/poll.ts`（T037 纯函数）、`src/client/components/ConnectionPanel.tsx`（连接与凭据面板，含 a11y 最低要求）。
- 改：`src/persistence/fs-like.ts`（+`readdirSync`、可选 `chmodSync`）、`src/shared/contracts.ts`
  （`ExecutionPanelData` +collections/pollIntervalMinutes；新增 AuditView/ArchiveResult/ProfileView/ProfileSaveInput/
  ProfileListResult/ProfileOpResult/EnvFileResult/McpEnvTemplate/McpInstanceInfo/McpSetup；+10 条路由 +10 个桥方法）、
  `src/host/api.ts`（+10 个能力，含降级返回）、`src/host/route.ts`（+9 个处理器与注册）、
  `src/index.ts`（装配 AuditArchive/ProfileService、集合清单**就地**刷新、onCollectionChange 真实副作用）、
  `src/client/slots.tsx`（桥扩展 + 「连接诊断」升级为「连接与凭据」）、
  `src/client/components/RequirementPool.tsx`（集合切换 + 轮询 + 增量高亮）、`cordis.patch.yml`（env 声明）。
- 新增测试：`tests/audit-archive.spec.ts`(11)、`tests/profile-service.spec.ts`(16)、`tests/poll.spec.ts`(16)，
  并扩 `tests/host-route.spec.ts`（+10，含"响应体不得含 pat"回归断言）。
- 文档：`README.md`（T064）、`specs/001-tfs-requirement-board/security-review.md`（T066）、
  `specs/001-tfs-requirement-board/acceptance-inventory.md`（T068）。

### 门禁（全绿）

- `npm run typecheck`（host + client + tests）：**EXIT 0**。
- `npm test`（vitest v4.1.8）：**19 文件 / 229 例全绿**（第三轮 176 → **+53**）。
- `npm run build`：**EXIT 0**，`lib/client.js` **116.87 kB**（第三轮 81.68 kB）。

### 工具链行为教训（影响后续所有编辑操作）

**同一批并行下发的两个 `Edit` 若落在同一文件，会互相覆盖**（工具均报 success，但只有后写入者的
结果存在于磁盘；实测本文件所在项目本轮丢了 4 处编辑：`contracts.ts` 的 HostBridge 方法与 TFS_ROUTES、
`api.ts` 的 imports 与 getPanelData、`profile-service.ts` 的 envTemplate）。
**纪律：同一文件的多次修改必须串行下发；改完用 `sed -n`/`grep` 复核，不要只信"successfully edited"。**

### 仍待办（诚实标注，未完成）

- **T039/T054**：对真实 TFS 的字段映射/沙盘回写契约测试——依赖 tfs-mcp 列表工具修复（414 / expand+fields 冲突）。
- **T051**：TFVC 关联，实测 tfs-mcp 无 shelveset 工具 → 降级为评论回写（S-04）。
- **T065**：a11y 只做到"最低要求"（label 关联/aria-live/role=status/tabIndex/type=button），
  **未做**焦点陷阱、键盘导航顺序审计、对比度审计。
- **T028b 写路径**：宿主无运行期增删实例 API → 永久降级为声明式接入（这是宿主能力边界，非本插件缺陷）。
- **S-09**：真·单 session 多任务续跑仍为 one-shot（`getRun(taskId)` 已暴露句柄）。
- **T068 的 SC-002**：真实 TFS 复验受阻（同上 tfs-mcp 缺陷）。

---

## 第五轮：真实 TFS 复探 → 列表出口改道 + T039/T051/T054 落地（2026-09-17）

### 起点：不沿用旧结论，全部重新实测

第四轮把 SC-002 记为 `[受阻]`，依据是第三轮的实测结论。**本轮重新逐条调用 tfs-mcp**（不引用旧结论），
结果**推翻了两条旧判断**，列表路径由"不可用"翻转为"可用 + 需两道护栏"。

### 复探实测（逐条，含调用参数）

| 工具 | 调用 | 实测结果 |
|---|---|---|
| `tfs_whoami` | `{}` | `zhangbo3(张波)` |
| `tfs_custom_query` | `{top:2}`——**刻意不传 fields** | 仍 `The expand parameter can not be used with the fields parameter.` ⇒ **结构性恒失败**（服务端内部固定同时发 expand+fields），与调用方无关 |
| `tfs_get_work_items` | `{ids:[2]}`（schema 无 fields 参数） | 同样 `expand+fields` 冲突 |
| `tfs_search_work_items` | `{keyword:'体检'}` | `Failed request: (414)` |
| `tfs_query_wiql` | `WHERE [System.Id] = 2` | **正常返回，≈4KB**（典型工作项） |
| `tfs_query_wiql` | `WHERE [System.Id] = 1` | 返回但 **3,492,287 字节 ≈3.4MB**（7316 条 relations，根计划项） |
| `tfs_query_wiql` | 0 命中的 WHERE | 抛 `items is not iterable (cannot read property null)` |
| `tfs_get_work_items_by_customer` | `{customerName:'人民', outputDir:...}` | `{totalCount:0, file:...}`（CSV 落盘，响应体极小） |
| `tfs_get_recent_resolved` | `{days:1}` / `{days:7}` | `[]`（无报错） |

**关键判读**：3.4MB 不是 WIQL 的常态，而是**离群值**（根计划项 id=1 挂了 7316 条 relations）；
典型工作项仅 ~4KB。所以 WIQL 可用，但**必须**防住两点：0 命中的伪错误、巨型响应的体积。

### 落地 1：列表出口改走 WIQL + 两道护栏

`src/tfs/adapter.ts#listRequirements` 重写：
- 出口 `tfs_custom_query` → **`tfs_query_wiql`**（`project` 走独立参数，其余进 WHERE；`assignedTo` 用 `CONTAINS`，
  因为实测返回的是 `xbp（徐保平) <WINNING\xbp>` 这类显示串，精确等于永不命中）；
- **护栏 1**：`isWiqlEmptyResult()` 把 tfs-mcp 的 0 命中伪错误归一为 `{ok:true, items:[], total:0}`；
- **护栏 2**：`safeSerializedBytes()` + `maxResponseBytes`（默认 2MB）熔断，超阈值给"收窄筛选条件"建议；
- **分页诚实声明**：WIQL schema 无 `top/skip` ⇒ 在客户端侧切片并回报 `total`。
- 同步更新：`EXPECTED_TFS_TOOLS`（弃 `custom_query`，补 TFVC 三工具）、`RequirementPool.tsx` 头部注释、
  `tests/host-api.spec.ts` 与 `tests/health.spec.ts` 中锁定旧出口的过期断言。

### 落地 2：T051 TFVC 关联（重估后落地）

- 重估：本轮工具目录**已出现** TFVC 系列（`tfs_list_tfvc_changesets` / `tfs_get_tfvc_changeset` /
  `tfs_get_tfvc_changeset_changes` / `tfs_list_tfvc_branches` / `tfs_list_tfvc_items`），
  第三轮"无 shelveset 工具"的降级前提**已变化**；但目录内**仍无任何"建立关系"的写工具**（无 `add_relation` 类），
  ⇒ 关联回写**仍走评论**，但内容升级。
- 新增 `listChangesets` / `getChangeset` / `getWorkItemCommits`（只读）与 `linkChangeset`（写，过四道门禁）。
- `linkChangeset` 先**只读**取变更集元数据（作者/时间/说明）再组评论；取不到则**降级**为仅带 `C<id>` 的精简评论，
  不阻断关联。同变更集重复关联由幂等键 `changeset:<id>` 拦截（门禁 3）。

### 落地 3：T039 / T054 契约测试

- 新增 `tests/fixtures/tfs-wiql-real.ts`：**逐字采集**的真实响应样本（id=2 完整；id=1 头部字段 +
  实测 `relationsCount: 7316` / `measuredBytes: 3492287`），并附 `makeMegaParent()` 生成同构大样本。
- 新增 `tests/tfs-list-contract.spec.ts`（**25 例**）：
  - T039-A 字段映射（7）：真实样本逐字段断言、空 tags→[]、分号 tags 拆分、number priority→字符串、
    **归一化不含 relations**、**7316 条 relations 归一化后体积恒定**、未映射字段不外泄；
  - T039-B 列表出口（9）：只发 `{query, collection}`、不再调 `custom_query`/`get_work_items`、
    `project` 不进 WHERE、0 命中归一、判定函数不误吞真实错误、体积熔断、默认阈值裕度、
    客户端切片 `top/skip`、`assignedTo` 用 CONTAINS、真实 414 仍报失败；
  - T054 变更集回写沙盘（7）+ `safeSerializedBytes`（2）。

### 门禁（全绿）

- `tsc` 三程序（host / client / tests）：**EXIT 0**。
- `npm test`（vitest v4.1.8）：**20 文件 / 254 例全绿**（第四轮 229 → **+25**）。
- （构建待跑：`npm run build`）

---

## 第六轮：真实凭据配置 + 真实 TFS 只读验证（2026-09-18）

用户提供真实 `serverUrl` + PAT，据此完成配置并对真实 TFS 做只读验证。**未做任何真实写操作。**

### 凭据处置（先补缺口再落盘）

- **发现真实安全缺口**：`.gitignore` 只有 `.env.*`，**匹配不到 `tfs-mcp.env`**，且完全没有
  `profiles.json` / `profile-active.json` 规则 ⇒ 直接落盘会把 PAT 送进版本控制。
  已补：`.tfs-requirment-data/`、`profiles.json`、`profile-active.json`、`tfs-mcp.env`。
  `git check-ignore -v` 三条凭据文件全部命中 `.gitignore:14`。
- 落盘：`ProfileService.save` + `activate` + `writeEnvFile` → 452 字节，`hardened=true`；
  `list()` 序列化不含 PAT（`PAT_LEAKED_IN_VIEW: false`）。
- PAT 全程只存在于系统临时文件与上述 gitignored 文件，**未出现在命令行/输出/日志**。

### PAT 有效性（真实 HTTP 只读）

`GET /tfs/WN_HIS/_apis/wit/workitems/2?api-version=4.1` + Basic `:PAT` → **HTTP 200**，
读回 `id=2 / 基础框架搭建 / 已关闭` ⇒ **PAT 可用**。

### 真实读取抓到的致命约束（前几轮都没发现）

用插件代码生成它实际要发的 WIQL，再打真实 TFS：

| WIQL | 真实结果 |
|---|---|
| `CONTAINS '框架'`（带/不带 project） | **414 / 414** |
| `CONTAINS 'MEMORY'`（ASCII） | **正常**，201 条 / 2,983,788 字节 |
| `[System.State] = '不存在状态ZZZ'`（中文等值） | **正常** `[]` |
| `[System.Id] = 2 ORDER BY …` | **正常** ≈4KB |

⇒ **414 = `CONTAINS` 含非 ASCII**（与长度/ORDER BY/project 无关）。中文关键字是常态，
**原实现必失败**。已修：`isAsciiSafe()` —— CONTAINS 仅在下推值为纯 ASCII 时使用，
非 ASCII 的 `keyword`/`assignedTo` 改客户端侧过滤；`state` 用等值 `=` 始终下推。

### 真实数据回放暴露的阈值错误

真实常规列表 = **201 条 / 2,983,788 字节** ⇒ **原 2MB 默认阈值会误熔断**（实测 `ok:false`），
即"默认列表在真实 TFS 上不可用"。已上调默认值为 **16MB**（按真实数据标定：约 1000 条，
仍能挡住整集合全量拉取）。复验：默认阈值下 `ok=true`，返回 20 条；归一化后单条 399 字节。
另修正口径说明：`safeSerializedBytes` 返回 UTF-16 字符数（2,810,204）≠ UTF-8 字节（2,983,788）。

### 门禁

`tsc` 三程序 EXIT 0；`npm test` **20 文件 / 259 例**（254 → +5，新增 T039-C 五例）。

### 仍待办（诚实标注，未完成）

- **真实写测试未做**：需先指定目标工作项 ID 并明确确认（写会落到公司 TFS 真实数据，不可逆）。
  执行时会先过 dry-run 预览 → 确认 → 幂等 → 审计四道门禁。
- **SC-002 的 UI 全流程**：列表出口已可用，仍缺"在宿主内以真实 PAT 启动跑通 UI"。
- **T051 的真·关系**：ArtifactLink 关联需 tfs-mcp 增补写工具，当前只能评论回写。
- **T065**：a11y 仍只有最低要求，未做焦点陷阱 / 键盘导航顺序 / 对比度审计。
- **T028b 写路径**：宿主无运行期增删 MCP 实例 API → 永久降级为声明式接入（宿主能力边界）。
- **S-09**：真·单 session 多任务续跑仍为 one-shot（`getRun(taskId)` 已暴露句柄）。

---

## 第七轮：工作目录接线 + 真实链路演练（2026-09-18）

### 用户指令

> 本地路径：`D:\体检管理\6.0\03 源代码\60混合框架\GIT60混合框架\Winning.WiNEX.Plugins`
> 需求号：1997179
> → 经确认选择：**接线工作目录 + 跑真实链路**（需求/任务携带 workspace，派发写进子代理 prompt，
> 并做进 UI；用 #1997179 走完 领取→拆解→指派，产出本地看板与任务，**不改 TFS**）

### 起点：先查宿主能力边界，再定设计（不按"想当然"实现）

任务要求里有一句"派发改成传给子代理的工作目录"。**先核实宿主到底支不支持按请求指定 cwd**：

| 核实点 | 源码位置 | 结论 |
|---|---|---|
| 子代理启动请求字段 | `@deepseek-ai/dsh-subagent/src/types.d.ts:91` `SubagentStartRequest` | **无 cwd / workspace / workdir 字段** |
| 子代理 cwd 来源 | 同包 `src/out-of-process.d.ts` `resolveChildCwd(prefix, configured, parentCwd)` | 只有两条：**部署级 config override** → 否则**父会话 workspace** |

⇒ **插件无法为某个任务指定子代理进程的工作目录**。"传给子代理的工作目录"在本宿主上
**做不到**；能做到的是把路径作为**任务上下文写进 prompt**（prompt 是插件唯一能影响子代理的通道）。

设计据此收敛为三件事（`src/shared/workspace.ts` 头部已写明依据，不夸大能力）：
1. 规范化输入路径（去空白、去尾分隔符，保留盘符根/POSIX 根）；
2. **fail loud 校验**（绝对路径 + 真实存在 + 是目录），哲学对齐宿主 `assertUsableCwd`
   —— "在进程边界之前失败，而不是留下含糊的 spawn ENOENT"；
3. 写进派发 prompt 并在看板/UI 可见，**文本里显式声明"插件不改变进程 cwd"**，避免读者误以为已改。

### 接线落点（全链路，逐文件）

| 层 | 文件 | 改动 |
|---|---|---|
| 领域 | `src/tfs/types.ts` | `Requirement.workspace?`（注释标明"本地补充字段，非 TFS 字段"） |
| 契约 | `src/shared/contracts.ts` | `RequirementSummary.workspace?` / `ClaimRequirementInput.workspace?` / `BoardTaskView.workspace?` |
| 看板 | `src/core/board/task.ts`·`board.ts`·`decompose.ts` | `TaskSnapshot.workspace?`；`TaskDraft.workspace?`；`addTask` 条件写入；拆解三段式**继承**需求 workspace |
| 纯函数 | `src/shared/workspace.ts`（新增） | `isAbsolutePath` / `normalizeWorkspace` / `workspaceIssue` / `buildWorkspacePromptSection` |
| 宿主服务 | `src/host/board-service.ts` | 领取时 fail-loud 校验（含 `statSync` 存在性/目录判定）；两个方向转换透传；`toTaskView` 透传 |
| 宿主 API | `src/host/api.ts` | `dispatch` 把看板任务的 workspace 注入 prompt 前置段 |
| 路由 | `src/host/route.ts` | claim handler 透传 `workspace` 字符串 |
| fs 抽象 | `src/persistence/fs-like.ts` | `FsLike.statSync?` + `realFs.statSync`（try/catch 返回 undefined） |
| 渲染 | `src/persistence/markdown.ts` | 需求池/任务两表新增「工作目录」列 + **单元格转义**（`\|`、换行） |
| UI | `RequirementPool.tsx` / `TaskCenter.tsx` | 领取路径输入框（含"不改变子代理进程工作目录"说明）；任务表新增「工作目录」列（`title` 承载完整路径） |

**降级策略**：`fs.statSync` 缺失（内存 fs / 受限环境）时**跳过**存在性校验，不误判为失败。

### 真实链路演练（`scripts/real-chain.ts`，可复跑）

用**需求 #1997179 的真实 TFS 响应**（`tests/fixtures/tfs-workitem-1997179-real.json`，2026-09-18
经 `mcp__tfs-mcp__tfs_get_workitem` 实抓）+ **真实本地路径**，跑通 领取 → 拆解 → 指派 → 渲染：

```
✓ 归一化：1997179 / 需求 / 已分析 / 体检管理\V6.0.2610.15.pec / relations=2
✓ 领取：workspace = D:\体检管理\6.0\03 源代码\60混合框架\GIT60混合框架\Winning.WiNEX.Plugins（真实目录校验通过）
✓ 拆解：3 任务（analyze → impl → verify），三条全部继承 workspace
✓ 指派：1997179@WN_HIS#impl → 开发工程师
✓ 落盘：board.json / events.jsonl / .ai-board/计划看板.md（真实 fs，插件数据目录）
✓ 断言：TFS 写调用 = 0；派发 prompt 前置段含真实路径
```

产物：`.tfs-requirment-data/real-board/`（gitignored）。演练脚本以 `tag:false` 显式关闭标签写入，
并代理所有写工具抛错，**双保险证明未写 TFS**。

**数据链路的真实性说明**：载荷不是手搓对象 —— 它经**真实的 `TfsAdapter.getRequirement`
（含 `normalizeWorkItem`）**归一化；路径经**真实的 `statSync`** 校验。

### 本轮修掉的真实构建缺陷（tsdown/oxc 抓到，tsc 放过了）

`RequirementPool.tsx` 的 JSX 属性 `placeholder="如 D:\体检管理\6.0\03 源代码\..."`：
`tsc` 通过，但 **oxc（rolldown/tsdown）报 PARSE_ERROR** —— JSX 双引号属性里的 `\6`、`\03`
被当作**八进制转义**。已改为表达式容器 `placeholder={'...\\6.0\\03...'}` 并转义反斜杠。
教训：**`tsc` 通过 ≠ 能打包**，客户端改动必须跑 `tsdown` 才算过门禁。

### 门禁（全绿）

- `tsc` 三程序（host / client / tests）**EXIT 0**；
- `tsdown` 客户端打包成功（`lib/client.js` 119.87 kB / gzip 24.34 kB）；
- `vitest run` **21 文件 / 307 例全通过**（259 → 304 → 307，本轮新增 48 例）。

新增测试：`tests/workspace.spec.ts`（26 例：路径判定/规范化/校验/prompt 组装/边界声明）
+ `board-service.spec.ts` 两个 describe（15 例：`statSync` 三态、未接线不留 `undefined` 键、
Markdown 表格转义列数恒定）+ `host-route.spec.ts` 2 例（claim 透传/非字符串不下传）
+ `host-api.spec.ts` 4 例（prompt 注入/零噪声/无 taskId/无 board 降级）。

### 仍待办（诚实标注，未完成）

- **真·子代理 cwd**：宿主无 per-request cwd 通道 ⇒ 若要让子进程 cwd 等于代码库路径，只能把
  **宿主会话/部署的 cwd** 设为该路径（prompt 文本已给出该指引）。这是宿主能力边界，非本插件缺陷。
- 其余待办同第六轮（真实写测试、SC-002 UI 全流程、T051 真·ArtifactLink、T065 剩余 a11y、T028b 写路径、S-09）。


---

## 第八轮（2026-09-18）：安装到真实 web profile + 工具契约纠正

### 事故驱动的工作项（全部完成）

- **T068 工具调用契约纠正（P0）**：`ctx.tools['mcp__…'](args)` → `ctx.tools.execute({callId,name,arguments,signal})`。
  文件 `src/tfs/adapter.ts`。新增 `unwrapToolValue` / `failureText` / `nextCallId` / `callTimeoutMs`。
- **T069 工具枚举纠正（P0）**：`Object.keys(ctx.tools)` → `ctx.tools.schemas()`。文件 `src/index.ts`。
- **T070 cordis 服务访问纠正（P0）**：`ctx.settings` / `ctx.subagents` / `ctx[dep]` → `ctx.get(name)`。
  文件 `src/index.ts`、`src/host/settings.ts`（后者加 `typeof ctx.get === 'function'` 守卫）。
- **T071 测试桩忠实化**：新增 `tests/helpers/fake-tools.ts`（真实 `execute`/`schemas` + MCP 信封），
  迁移 `adapter/e2e/tfs-contract/tfs-list-contract/host-api` 五个 spec + `scripts/real-chain.ts`。
- **T072 真实安装验证**：隔离 `DSH_HOME` 起 `dsh --profile web`，插件树加载成功；
  `health` 返回真实身份/集合/48 项目；`requirements{keyword:'MEMORY'}` 返回 201 条真实工作项。

### 新增/变更测试

- `tests/adapter.spec.ts` 重写：21 例（信封解包三级分支、isError 内层 message、execute 抛错、
  120s 超时经 AbortSignal、运行时缺失、UNKNOWN_TOOL、既有 6 组参数契约）。
- `tests/settings.spec.ts`：桩改为忠实复刻 `ctx.get(name)` 语义（原桩按不存在的"属性 settings"契约写）。
- 合计 **316 例**（第七轮 307）。

### 仍待办（诚实标注）

- **T073 查询收窄（新发现，未实施）**：`{project}` 单独筛选会生成**无 WHERE** 查询 → 真实项目上
  超时；`ChangedDate` 形状会 414/0 命中。需 (a) 项目下推 `WHERE [System.TeamProject]='X'`；
  (b) `RequirementFilter` 增时间窗字段并收窄默认查询。**前置条件**：先取到"返回非空"的窄查询真实样本。
- 其余同第七轮（真·子代理 cwd、T051 真·ArtifactLink、T065 剩余 a11y、T028b 写路径、S-09）。
- 用户实机 `dsh web`（PID 39344，插件安装前启动）**需重启**才会加载本插件。

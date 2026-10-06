# Feature Specification: 拆解自动匹配角色 + 通用工程师 + 角色自动创建 + 选为目标重复填充

**Feature Branch**: `008-decompose-role-match-and-target-refill`
**Created**: 2026-09-21
**Status**: 待评审（speckit specify 产物）
**Input**: User description:
> 1. 任务中心 tab 页的「已领取需求」点击「拆解为任务」，没有自动匹配合适的角色。
> 2. 帮我添加「通用工程师」角色。
> 3. 如果拆解的任务匹配不到合适的角色，请自动创建合适的角色。
> 4. 第二次点击「选为目标」，没有带入标题、描述和执行 prompt。

---

## 零、根因分析

### 0.1 问题 1：三段任务全部指派给"角色列表第一个"，不存在匹配逻辑

`src/core/board/decompose.ts:32-44` 的 `decomposeRequirement(req, roleAgents)`：

```ts
const role = roleAgents[0]           // ← 只取第一个角色
// analyze / impl / verify 三个草稿全部：
roleAgent: role?.name ?? 'general'   // ← 三段共用同一个角色
```

调用方 `src/host/board-service.ts:406` 传入的是 `this.deps.roles.list()`（全部角色），
但拆解函数**只用第一个**。于是无论角色表里有「架构师 / 开发工程师 / 测试工程师」，
`#analyze`、`#impl`、`#verify` 三个任务永远全部挂在列表第一个角色（默认即「架构师」）名下，
"分析→架构师、实现→开发、验证→测试"的预期匹配完全不存在。

### 0.2 问题 2：内置默认角色集没有通用兜底角色

`src/orchestration/roles.ts:191-222` 的 `DEFAULT_ROLES` 只有架构师 / 开发工程师 / 测试工程师
三个专门角色，没有"什么都能承担"的通用角色；当用户删掉/改空某个专门角色后，
拆解链路没有任何通用兜底。

另外 `src/index.ts:277-284` 的播种逻辑是**"roles.json 为空才整体写入"**：
老部署已经存在 roles.json（3 个角色），新增内置角色永远不会被补进去——
仅在 `DEFAULT_ROLES` 里加条目，对升级部署不生效，必须做按 id 对账式迁移。

### 0.3 问题 3：匹配不到角色时没有自动建角色的通道

`BoardService.decompose`（`src/host/board-service.ts:394-445`）拿到的角色端口
`RoleReader` 只有 `list()/getByName()` 两个读方法，既没有匹配启发式，也没有写角色的能力；
`decompose.ts` 在无角色时只写一个字符串字面量 `'general'`（该角色在角色管理中不存在，
UI 显示"general（未知）"，派发时被 `api.dispatch` 以"角色不存在"拒绝）。

### 0.4 问题 4：「选为目标」按目标键去重，同一需求第二次点击被静默跳过

`src/client/components/ExecutionPanel.tsx:122-131`：

```ts
const targetKey = data.target ? `${data.target.id}@${data.target.collection}` : ''
const filledKeyRef = useRef<string>('')
useEffect(() => {
  if (!targetKey) return
  if (filledKeyRef.current === targetKey) return   // ← 同一需求只填一次
  filledKeyRef.current = targetKey
  const fill = buildTargetFill(data.target)
  ...
}, [targetKey, data.target])
```

填充守卫以**目标键**为去重粒度。典型事故路径：第一次点「选为目标」→ 标题/描述/执行 Prompt
正常带入 → 点「发起执行」成功后 `resetContent()` 清空执行内容（spec 007 US2 的既定行为）→
对**同一条需求**第二次点「选为目标」想重新带入 → 目标键没变 → effect 直接 return，
三个字段保持空白。用户手工改过内容后想"恢复需求原文"同样被拦。

该设计的初衷是"轮询刷新 `data` 时不要反复顶掉用户手工编辑"，但它把**显式选择事件**和
**后台数据刷新**混在同一个键上；正确信号应当是"用户每次点击产生的一次性序号"。

---

## User Scenarios & Testing

### User Story 1 - 拆解时按分析/实现/验证自动匹配合适角色 (Priority: P1)

在任务中心点「拆解为任务」后，`#analyze`（分析需求）、`#impl`（实现需求）、`#verify`
（验证需求）三个任务分别自动指派给与阶段语义匹配的角色，而不是全部挂在第一个角色名下。
每个任务冻结其被指派角色自己的默认 MCP / 技能 / 模型。

**Why this priority**：用户明确反馈的阻塞性问题；错误指派会让架构师角色去跑测试任务、
测试角色去写代码，整条派发链路从第一步就是错的。

**Independent Test**：纯函数匹配器单测（关键词命中、定制角色名、平分回落顺序）+
`BoardService.decompose` 集成断言（三段 roleAgent 与各自 frozenConfig）。

**Acceptance Scenarios**:

1. **Given** 内置角色「架构师 / 开发工程师 / 测试工程师 / 通用工程师」均在，**When** 拆解需求，
   **Then** `#analyze→架构师`、`#impl→开发工程师`、`#verify→测试工程师`，
   且各任务 `frozenConfig` 取自被指派角色（不再共用第一个角色的配置）。
2. **Given** 用户自建角色「前端开发工程师」「自动化测试」，**When** 拆解，
   **Then** impl 阶段命中「前端开发工程师」（名称含"开发"）、verify 阶段命中「自动化测试」（名称含"测试"）。
3. **Given** 角色列表顺序被打乱（如测试工程师排在第一位），**When** 拆解，
   **Then** 匹配结果与列表顺序无关，仍按语义命中。
4. **Given** 某角色仅在描述里出现阶段词、名称不含任何线索，**Then** 不据此指派
   （名称是用户刻意声明的身份信号；自由文本描述不作为指派依据，避免意外错配）。
5. **Given** 重新拆解（在办任务跳过、已取消任务复活重建），**Then** 新建/复活的任务同样按本规则匹配。

### User Story 2 - 内置「通用工程师」角色 (Priority: P1)

系统内置第四个默认角色「通用工程师」（id `role-general`，provider `spawn`，
描述说明其为承担未匹配到专门角色的通用任务的兜底角色）；全新安装与老部署升级后都能在
「角色管理」与各处角色下拉中看到它。

**Why this priority**：用户点名要求；它是匹配失败时的第一道兜底，避免任务挂到未知角色。

**Independent Test**：`DEFAULT_ROLES` 含该角色且通过角色配置校验；空 roles.json 播种、
已有 roles.json（仅 3 个老内置角色）对账补写两种场景的单测。

**Acceptance Scenarios**:

1. **Given** 全新数据目录（无 roles.json），**When** 插件启动，**Then** 写入 4 个内置角色，含「通用工程师」。
2. **Given** 老部署 roles.json 只有 3 个内置角色，**When** 插件升级启动，
   **Then** 自动补写「通用工程师」，已有 3 个角色（含用户改过的名称/模型）**不被覆盖**。
3. **Given** 用户自建了一个同名「通用工程师」角色（id 不同），**Then** 不再重复写入内置条目
   （展示名必须唯一，见 `validateRolesConfig`）。
4. **Given** 用户删除某内置角色后重启插件，**Then** 启动对账会补回缺失的内置角色
   （本特性的既定策略：内置角色是拆解兜底资产；不需要时应改名/改派而非依赖删除保持，
   见 Out of Scope 中的"删除墓碑"说明）。

### User Story 3 - 匹配不到合适角色时自动创建 (Priority: P1)

拆解时按以下**优先级链**为每个阶段解析角色，保证每个任务都有可派发的有效角色：

1. 阶段专门角色（名称命中阶段关键词）；
2. 通用型角色（名称命中「通用 / 全栈 / general / fullstack」等，内置「通用工程师」即此类）；
3. 自动创建该阶段的标准内置角色（确定性 id：`role-architect` / `role-coder` / `role-qa`，
   落 roles.json，随后即可在角色管理中编辑）；
4. 角色端口无写能力（测试/降级装配）时，回落列表第一个角色；一个角色都没有时才使用
   「通用工程师」名称占位（与旧字面量 `'general'` 同属降级形态，但名称与内置角色一致）。

**Why this priority**：用户明确要求"匹配不到就自动创建合适的角色"，与 US2 共同保证
拆解产物永远不会挂在"未知角色"上。

**Independent Test**：`BoardService.decompose` + 内存角色仓：
只有无关自定义角色且带 save → 断言自动建角色、任务指派正确、roles.json 落盘、
结果 `createdRoles` 与中文结论可见；无 save 端口 → 断言回落不抛错。

**Acceptance Scenarios**:

1. **Given** 角色表只有「通用工程师」（三个专门角色都缺失），**When** 拆解，
   **Then** 三个任务全部指派给「通用工程师」，**不**自动创建专门角色（通用兜底优先于自动创建）。
2. **Given** 角色表只有一个无关角色「DBA」且角色端口可写，**When** 拆解，
   **Then** 自动创建「架构师 / 开发工程师 / 测试工程师」三个标准角色并分别指派；
   返回体含 `createdRoles: ['架构师','开发工程师','测试工程师']`，reason 文案说明"自动创建角色"。
3. **Given** 自动创建发生，**When** 拆解响应回到 UI，**Then** 角色下拉/筛选立即包含新角色
   （客户端在发现 `createdRoles` 非空后刷新面板数据），无需重启。
4. **Given** 自动创建出的角色已存在（同名/同 id，并发或历史数据），**Then** 不重复创建、不报错。
5. **Given** 角色保存抛错（磁盘不可写/校验失败），**Then** 拆解不失败：按回落链继续指派，
   事件日志记录"角色自动创建失败"原因。
6. **Given** 对同一需求第二次拆解（任务已存在被跳过），**Then** 不重复创建角色（幂等）。

### User Story 4 - 「选为目标」每次点击都重新带入标题/描述/执行 Prompt (Priority: P1)

无论第几次点击、点击的是否同一条需求，执行配置页的标题、描述（四段正文拼接）、
执行 Prompt 都必须按当前选中需求重新填入；后台轮询刷新面板数据则**不得**顶掉用户手工编辑。

**Why this priority**：用户明确反馈；发起执行后表单被清空是既定行为，再次选同一目标
必须能恢复正文，否则用户只能去 TFS 手动复制。

**Independent Test**：填充判定下沉为共享纯函数并单测
（nonce 不变→不填；nonce 变化→填；nonce=0/无目标→不填）。

**Acceptance Scenarios**:

1. **Given** 已对需求 A 点过一次「选为目标」并已填入，**When** 对 A 再点一次「选为目标」，
   **Then** 标题/描述/执行 Prompt 重新按 A 的正文填入（即使中间被「发起执行」清空或被手工删空）。
2. **Given** 已选 A，**When** 改选 B，**Then** 填入 B 的标题/四段正文/执行 Prompt。
3. **Given** 已选 A 且用户手工编辑了执行 Prompt，**When** 仅发生后台目录轮询刷新
   （没有新的点击），**Then** 手工内容保留不被覆盖。
4. **Given** enrich 实时重取失败降级为列表项字段，**Then** 第二次点击仍会用降级数据重新填充
   （填充动作本身不再被去重守卫拦截）。

---

## Functional Requirements

- **FR-001** 新增纯逻辑模块 `src/orchestration/role-match.ts`（不 import node:fs，可单测）：
  定义 `DecomposeStage = 'analyze'|'impl'|'verify'`、各阶段名称关键词表、通用型关键词表、
  内置角色模板（id/name/provider/默认模型/标签策略与 `DEFAULT_ROLES` 同源）、
  `matchRoleForStage(stage, roles)` 与 `matchGeneralistRole(roles)`；匹配只认角色**名称**命中，
  平分时取列表靠前角色（顺序稳定）。
- **FR-002** `decomposeRequirement` 签名改为接收
  `Record<DecomposeStage, RoleRef | undefined>`：三个草稿各取各阶段角色及其 frozenConfig；
  阶段角色缺失时占位名统一为「通用工程师」（不再写裸 `'general'`）。
- **FR-003** `DEFAULT_ROLES` 改为由 `role-match.ts` 的内置模板派生，末尾追加「通用工程师」
  （`role-general`，provider `spawn`，`defaultModel: 'deepseek-v4-flash'`，`autoExecute:false`，
  `tagStrategy:'dsh'`）；默认角色集必须通过 `validateRolesConfig`（名称唯一、provider 非空）。
- **FR-004** 新增 `ensureBuiltinRoles(store): string[]`：按 id（缺失时再按名称判重）补写缺失的
  内置角色，**永不覆盖**已存在条目；`src/index.ts` 启动播种从"空文件才写"改为调用该对账函数，
  返回补写 id 时记 info 日志。
- **FR-005** `BoardService` 角色端口扩展为可选写方法 `save?(role): void`（生产注入 RoleStore）；
  `decompose()` 按 US3 的四级优先级链为每阶段解析角色，再调用 `decomposeRequirement`。
- **FR-006** 拆解结果体新增 `createdRoles?: string[]`（自动创建的角色展示名）；
  reason 在有自动创建时追加"；自动创建角色：X、Y"；`events.jsonl` 的 decompose 事件 detail
  记录每阶段指派结果与自动创建清单。`HostBridge.decomposeRequirement` / TaskCenter props 类型同步。
- **FR-007** 客户端在拆解响应 `createdRoles` 非空时刷新面板数据（`getPanelData`），
  使新角色立即出现在角色下拉/筛选中。
- **FR-008** `ExecutionPanelData` 新增**客户端会话内**字段 `targetFillNonce?: number`
  （不经宿主、不落盘、不进路由白名单）；`slots.tsx` 维护该序号，每次 `chooseTarget`
  成功设置目标时自增并随 execData 下发。
- **FR-009** `ExecutionPanel` 填充 effect 改为以 `targetFillNonce` 为触发信号
  （共享纯函数 `shouldFillTarget(nonce, lastFilled, hasTarget)` 承载判定）：
  新序号且有目标 → 重新填入标题/描述/执行 Prompt；序号未变（轮询刷新）→ 不动表单。
- **FR-010** 自动创建的角色与内置角色同构（provider `spawn` 等有效字段），必须能通过
  `validateRole`，保证后续 `api.dispatch` 的"角色存在 + provider 非空"检查直接通过。

## Key Entities

- `DecomposeStage`（`'analyze' | 'impl' | 'verify'`）与 `STAGE_KEYWORDS` /
  `GENERALIST_KEYWORDS` / `STAGE_ROLE_TEMPLATES`（`src/orchestration/role-match.ts`）。
- 内置角色模板 `ROLE_ARCHITECT / ROLE_CODER / ROLE_QA / ROLE_GENERAL`（单一事实源，
  `DEFAULT_ROLES` 与自动创建共用，避免两处漂移）。
- 拆解结果扩展字段 `createdRoles: string[]`。
- `ExecutionPanelData.targetFillNonce: number`（客户端会话态）。

## 变更文件

**宿主半**：
- `src/orchestration/role-match.ts`（**新**：阶段/关键词/模板/匹配器）；
- `src/orchestration/roles.ts`（DEFAULT_ROLES 改由模板派生 + 通用工程师 + `ensureBuiltinRoles`）；
- `src/core/board/decompose.ts`（按阶段角色映射出草稿）；
- `src/host/board-service.ts`（RoleManager 端口、四级解析链、自动创建、createdRoles、事件 detail）；
- `src/index.ts`（启动对账播种替换空文件播种）。

**共享契约**：
- `src/shared/contracts.ts`（拆解结果 `createdRoles`、`ExecutionPanelData.targetFillNonce`）；
- `src/shared/pool.ts`（`shouldFillTarget` 纯函数）。

**客户端半**：
- `src/client/slots.tsx`（nonce 状态与下发、拆解后按 createdRoles 刷新面板数据、桥类型）；
- `src/client/components/ExecutionPanel.tsx`（nonce 触发填充，移除 targetKey 去重）；
- `src/client/components/TaskCenter.tsx`（onDecompose 返回类型加 createdRoles）。

**测试**：
- `tests/role-match.spec.ts`（**新**）；
- `tests/roles.spec.ts`（4 个默认角色、ensureBuiltinRoles 三场景）；
- `tests/board-service.spec.ts`（按阶段指派、通用兜底、自动创建、无 save 回落、幂等、筛选断言更新）；
- `tests/board-lifecycle-003.spec.ts`（decomposeRequirement 新签名适配）；
- `tests/pool.spec.ts`（shouldFillTarget）。

## 验证方式（可复现）

```bash
# 三道类型门禁（host / client / tests）
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.host.json
node node_modules/typescript/bin/tsc --noEmit -p tsconfig.client.json
node node_modules/typescript/bin/tsc -p tsconfig.tests.json
# 单测
node node_modules/vitest/vitest.mjs run --reporter=json --outputFile=./vitest.json
# 构建（运行期加载 lib/，改完必须 build）
npm run build
```

## Out of Scope

- 基于需求正文做 LLM/AI 角色推断（本期匹配仅基于阶段语义 + 角色名称关键词；
  三段式 stage 本身已携带分析/实现/验证语义）。
- 角色"删除墓碑"（tombstone）：本期策略是启动对账补回被删的内置角色（US2 AC4）；
  若后续需要"删除后永不复活"，需在 roles.json 旁增加墓碑标记，本期不做。
- 右栏 `SidePanel` 的任务级目标（BoardTaskView）不带需求正文填充，不涉及本缺陷，不改。
- 自动创建角色的 provider/preset 可用性探测（固定 `spawn`，与既有内置角色一致；
  用户可在角色管理中改绑，`resolveRoleAvailability` 的既有禁用提示不变）。

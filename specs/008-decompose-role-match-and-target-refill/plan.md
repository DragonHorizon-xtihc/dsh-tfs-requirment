# Implementation Plan: 拆解自动匹配角色 + 通用工程师 + 角色自动创建 + 选为目标重复填充

**Branch**: `008-decompose-role-match-and-target-refill` | **Date**: 2026-09-21 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/008-decompose-role-match-and-target-refill/spec.md`

## Summary

四个问题、两条独立修复线：

1. **拆解角色匹配（US1/US2/US3，宿主半）**：根因是 `decomposeRequirement` 只取 `roleAgents[0]`。
   新增纯逻辑模块 `src/orchestration/role-match.ts`：阶段（analyze/impl/verify）× 角色名称关键词打分匹配，
   内置四个角色模板（架构师/开发工程师/测试工程师/通用工程师，单一事实源），通用型关键词低权重兜底。
   `decomposeRequirement` 改为按阶段角色映射出草稿；`BoardService.decompose` 按
   "专门匹配 → 通用兜底 → 自动创建标准角色 → 列表首个角色 → 通用工程师占位" 五级回落链解析角色，
   自动创建经 `RoleStore.save` 落 roles.json 并在结果体 `createdRoles` 与中文结论中可见。
   启动播种从"空文件才写"改为 `ensureBuiltinRoles` 按 id 对账（老部署补出通用工程师）。
2. **选为目标重复填充（US4，客户端半）**：根因是填充 effect 用目标键做"同键只填一次"。
   改为以客户端会话内单调递增的 `targetFillNonce` 为触发信号：每次显式点击「选为目标」+1，
   轮询刷新不产生新序号；判定逻辑下沉为共享纯函数 `shouldFillTarget` 以便单测。

## Technical Context

**Language/Version**: TypeScript（宿主半 tsconfig.host.json 可用 node；客户端半 tsconfig.client.json
仅 `src/client` + `src/shared`，`types: []` 无 node 全局；测试 tsconfig.tests.json）。
**Primary Dependencies**: React 18（客户端）、vitest（测试）；本特性不引入新依赖、不新增 TFS 写路径。
**Storage**: 插件数据目录 `roles.json`（RoleStore/JsonStore）、`board.json`（Principle VI）、
`events.jsonl`（append-only）；`targetFillNonce` 仅客户端内存态，不落盘。
**Testing**: vitest（`npm test`）；宿主逻辑用内存 fs + 结构类型桩（沿用 board-service.spec.ts 纪律）。
**Target Platform**: DSH 宿主插件（web overlay + 宿主 HTTP 路由）。
**Constraints**:
- 客户端半不得 import 宿主/node 模块；`role-match.ts` 只依赖 `src/shared/contracts` 类型，
  但它服务于宿主装配（自动建角色需 RoleStore），放 `src/orchestration/`，不进客户端编译；
- 业务失败返回 200 + `ok:false`（本特性不新增路由，沿用 decompose 既有端点）；
- 匹配只认角色**名称**（描述自由文本不参与），避免意外错配；
- 自动创建角色必须通过 `validateRole`（id/name/provider 齐全），与内置角色同构。
**Scale/Scope**: 角色表通常 ≤ 数十条、阶段固定 3 个，匹配为 O(角色数 × 关键词数) 的一次性内存计算。

## Constitution Check

- **I 证据优先**：根因均带 `文件:行号`（decompose.ts:32-44、board-service.ts:394-445、
  roles.ts:191-222、index.ts:277-284、ExecutionPanel.tsx:122-131）；不臆造宿主字段。
- **IV 唯一出口 / 写操作收敛**：自动创建角色只写本地 roles.json（既有 RoleStore 通道），
  不新增 TFS 写调用、不接触 PAT。
- **VI 文件即真相**：自动创建的角色立即落 roles.json；拆解事件 detail 记录指派与建角色结果。
- **VII 验证先于完成**：匹配器/填充判定为纯函数并配单测；BoardService 新链路集成测试；
  三道 tsc + vitest 全量 + tsdown 构建通过才算完成。
- **II/III/V**：不涉及凭据回显、审批门禁语义变更；decompose 端点鉴权与路由形态不变。
- **客户端/宿主边界**：`targetFillNonce` 由客户端在 slots 层注入 execData，
  宿主 `getPanelData` 不感知（无需路由白名单改动）。

## Project Structure

### Documentation（本特性）

```text
specs/008-decompose-role-match-and-target-refill/
├── spec.md       # US1~US4 + FR-001~010 + 根因
├── plan.md       # 本文件
└── tasks.md      # 实施任务（/speckit.tasks）
```

### Source Code（变更）

```text
src/
├── orchestration/
│   ├── role-match.ts          # 【新】阶段/关键词/内置模板/匹配器/通用角色常量
│   └── roles.ts               # DEFAULT_ROLES 改由模板派生（+通用工程师）；+ensureBuiltinRoles
├── core/board/
│   └── decompose.ts           # 签名改 Record<Stage, RoleRef|undefined>，逐阶段指派
├── host/
│   └── board-service.ts       # RoleManager 端口(+save?)；resolveStageRole 五级回落；createdRoles
├── shared/
│   ├── contracts.ts           # 拆解结果 +createdRoles；ExecutionPanelData +targetFillNonce
│   └── pool.ts                # +shouldFillTarget 纯函数
├── index.ts                   # 启动播种改 ensureBuiltinRoles（按 id 对账，补缺失内置角色）
└── client/
    ├── slots.tsx              # targetFillNonce 状态/chooseTarget 自增/execData 注入；
    │                          # 拆解发现 createdRoles 后 reload() 面板数据；桥返回类型同步
    └── components/
        ├── ExecutionPanel.tsx # 填充 effect 改 nonce 信号（移除 filledKeyRef 目标键去重）
        └── TaskCenter.tsx     # onDecompose 返回类型 +createdRoles
tests/
├── role-match.spec.ts         # 【新】匹配器/通用兜底/模板自洽
├── roles.spec.ts              # 4 默认角色；ensureBuiltinRoles（补缺失/不覆盖/同名不重复）
├── board-service.spec.ts      # 逐阶段指派/通用兜底/自动创建/无 save 回落/幂等；筛选断言更新
├── board-lifecycle-003.spec.ts# decomposeRequirement 新签名适配
└── pool.spec.ts               # shouldFillTarget 四分支
```

## Design Details

### D1. `role-match.ts`（新，纯逻辑、零 node 依赖）

```ts
export const DECOMPOSE_STAGES = ['analyze', 'impl', 'verify'] as const
export type DecomposeStage = (typeof DECOMPOSE_STAGES)[number]

export const GENERAL_ROLE_ID = 'role-general'
export const GENERAL_ROLE_NAME = '通用工程师'

// 内置角色模板（DEFAULT_ROLES 与自动创建的单一事实源）
export const ROLE_ARCHITECT: RoleDefinition = { id: 'role-architect', name: '架构师',
  description: '需求拆解与方案设计', provider: 'spawn', defaultModel: 'deepseek-v4-flash',
  defaultSkills: [], autoExecute: false, tagStrategy: 'dsh' }
export const ROLE_CODER: RoleDefinition     = { id: 'role-coder', name: '开发工程师',
  description: '按方案编写与自测代码', ... }
export const ROLE_QA: RoleDefinition        = { id: 'role-qa', name: '测试工程师',
  description: '用例设计与回归验证', ... }
export const ROLE_GENERAL: RoleDefinition   = { id: GENERAL_ROLE_ID, name: GENERAL_ROLE_NAME,
  description: '通用型工程师：承担未匹配到专门角色的通用任务（分析/实现/验证均可承担）', ... }
export const BUILTIN_ROLES: RoleDefinition[] = [ROLE_ARCHITECT, ROLE_CODER, ROLE_QA, ROLE_GENERAL]
export const STAGE_ROLE_TEMPLATES: Record<DecomposeStage, RoleDefinition> = {
  analyze: ROLE_ARCHITECT, impl: ROLE_CODER, verify: ROLE_QA,
}
```

关键词（全部小写匹配，命中判定只看 `role.name`）：

| 阶段 | 名称关键词（任一命中即匹配） |
|---|---|
| analyze | `架构`、`需求分析`、`分析`、`设计`、`方案`、`architect`、`analyst`、`design` |
| impl | `开发`、`研发`、`编码`、`实现`、`coder`、`developer`、`engineer`、`programmer` |
| verify | `测试`、`验证`、`质量`、`回归`、`qa`、`test`、`testing` |
| 通用（低权重兜底） | `通用`、`全栈`、`通才`、`general`、`generalist`、`fullstack`、`full-stack` |

关键防串味验证（单测固化）：
- 「测试工程师」名称不含 impl 中文词（impl 表不收 `工程师`/英文 `engineer` 不命中中文），
  不会被 impl 抢走；「开发工程师」同理不命中 verify；
- 「通用工程师」在三个阶段的专门得分均为 0，仅以通用身份兜底；
- 「前端开发工程师」命中 impl、「自动化测试」命中 verify。

匹配器：

```ts
function countNameHits(name: string, keywords: readonly string[]): number
export function matchRoleForStage(stage, roles): RoleDefinition | undefined // 专门命中数 >0，平分取列表前者
export function matchGeneralistRole(roles): RoleDefinition | undefined       // 通用词命中 >0
```

只认名称的理由（写进模块注释）：名称是用户刻意声明的身份信号；描述为自由文本，
据其指派会产生用户无法预期的错配；描述仅在角色管理 UI 中作说明。

### D2. `decompose.ts` 签名与占位名

```ts
export function decomposeRequirement(
  req: Requirement,
  rolesByStage: Record<DecomposeStage, RoleRef | undefined>,
): TaskDraft[]
```

- 三个草稿分别取 `rolesByStage.analyze / .impl / .verify`；
- 各任务 `frozenConfig` 取自**自己阶段**角色的 defaultMcp/defaultSkills/defaultModel
  （修掉此前三段共用第一角色配置）；
- 阶段角色为 undefined 时 `roleAgent = GENERAL_ROLE_NAME`、frozenConfig 空快照
  （替换裸字面量 `'general'`）；
- workspace 继承、idempotencyKey、blockedBy DAG、标题描述文案保持不变。

### D3. `BoardService.decompose` 角色解析链

端口扩展（`save` 可选，保持既有桩装配可缺省）：

```ts
export interface RoleManager {
  list(): RoleDefinition[]
  getByName(name: string): RoleDefinition | undefined
  /** 自动创建角色通道（生产 = RoleStore；未注入时回落链跳过自动创建）。 */
  save?(role: RoleDefinition): void
}
```

`decompose(requirementId)` 在取到 req 之后、出草稿之前：

```ts
const createdRoles: RoleDefinition[] = []
const rolesByStage = {} as Record<DecomposeStage, RoleDefinition | undefined>
for (const stage of DECOMPOSE_STAGES) rolesByStage[stage] = resolveStageRole(stage, createdRoles)
drafts = decomposeRequirement(req, rolesByStage)
```

`resolveStageRole(stage, createdAcc)` 五级回落：

1. `matchRoleForStage(stage, list())` → 命中即返回；
2. `matchGeneralistRole(list())` → 命中即返回（通用工程师存在时专门角色缺失也不建角色）；
3. 取 `STAGE_ROLE_TEMPLATES[stage]`，双检 id/名称均不存在后，若 `typeof save === 'function'`：
   try `save(template)` → 记账 createdAcc、persist 事件、返回模板；save 抛错 →
   persist `role-auto-create-failed` 并继续回落（不使拆解失败）；
4. 回落 `list()[0]`（无 save 通道的测试/降级装配）；
5. 全空 → undefined（decompose 用通用工程师名占位）。

幂等：角色一旦在本次循环创建即进入 RoleStore（`list()` 后续阶段可见）；重复拆解时
专门/通用匹配先行命中，不会重复建角色。

结果体与文案：

```ts
{ ok, taskIds, created, skipped, createdRoles: createdAcc.map(r => r.name), reason }
// reason 追加：n>0 且 createdRoles.length ? `；自动创建角色：${names.join('、')}` : ''
```

`events.jsonl` 的 `decompose` 事件 detail 增加
`roleAssignment: { analyze, impl, verify }` 与 `createdRoles`。

### D4. 启动对账播种（roles.ts + index.ts）

```ts
/** 按内置角色集对账：缺失（按 id，再按名称判重）的补写；已存在条目一律不动。返回补写 id。 */
export function ensureBuiltinRoles(store: RoleStore): string[]
```

- `store.get(id) || store.getByName(role.name)` 存在即跳过（保护用户改名/改模型/同名自定义角色）；
- `src/index.ts:277-284` 的"list 为空才写 DEFAULT_ROLES"替换为 `ensureBuiltinRoles(roleStore)`，
  补写数量 >0 时记 info 日志（含新增角色名）；
- 既定策略（spec US2 AC4）：删除内置角色后重启会被补回——在角色注释与 spec 中明示，
  不做墓碑（Out of Scope）。

### D5. 「选为目标」nonce 填充（客户端）

- `contracts.ts`：`ExecutionPanelData.targetFillNonce?: number`（注释标明纯客户端会话态）；
  `HostBridge.decomposeRequirement` 返回类型加 `createdRoles?: string[]`。
- `slots.tsx#Workbench`：
  - 新 state `const [targetFillNonce, setTargetFillNonce] = useState(0)`；
  - `chooseTarget` 在 `setTarget(enriched)` 同时 `setTargetFillNonce(n => n + 1)`
    （enrich 降级路径同样自增——点击意图成立即填充）；
  - execData 注入 `targetFillNonce`；
  - TaskCenter `onDecompose` 改为：调用桥 → 若 `r.ok && r.createdRoles?.length` 则 `reload()`
    刷新面板数据（新角色立刻进下拉），再原样返回 r。
- `pool.ts`：

```ts
/** 一次显式「选为目标」是否应把正文填入表单：必须有目标、nonce 为正且与上次填充不同。 */
export function shouldFillTarget(nonce: number, lastFilledNonce: number, hasTarget: boolean): boolean
// = hasTarget && nonce > 0 && nonce !== lastFilledNonce
```

- `ExecutionPanel.tsx`：删除 `targetKey/filledKeyRef` 块，改为

```ts
const fillNonce = data.targetFillNonce ?? 0
const lastFilledNonceRef = useRef(0)
useEffect(() => {
  if (!shouldFillTarget(fillNonce, lastFilledNonceRef.current, !!data.target)) return
  lastFilledNonceRef.current = fillNonce
  const fill = buildTargetFill(data.target)
  if (!fill) return
  setForm(prev => ({ ...prev, title: fill.title, description: fill.description, execPrompt: fill.execPrompt }))
}, [fillNonce, data.target])
```

轮询 `refreshPanelData` 只换 data 不换 nonce → 不重填（保护手工编辑）；
同一需求第二次点击 nonce +1 → 重新填入（修复点）。

## Test Strategy

- **role-match.spec.ts（新）**：内置四角色下 analyze/impl/verify 各归其位；乱序不影响；
  定制名（前端开发工程师/自动化测试/DBA）命中与落空；通用工程师只作通用兜底；
  描述含词但名称不含 → 不命中；模板通过 validateRole、BUILTIN_ROLES 名称唯一。
- **roles.spec.ts**：DEFAULT_ROLES 长度 4 且含 role-general/通用工程师；
  ensureBuiltinRoles：空店补 4、已有不动（改名/改模型保留）、同名自定义不重复写入、
  缺 role-general 的老店只补 1 条。
- **board-service.spec.ts**：
  - 角色仓改为每实例独立数组并提供 save（避免模块级污染）；
  - 三角色齐全（含测试）→ analyze/impl/verify 分别为架构师/开发/测试，frozenConfig 各取所属角色；
  - 仅架构师+开发+通用工程师 → verify 落通用工程师且无 createdRoles；
  - 仅无关角色 DBA + save → 自动建三模板角色、createdRoles 与 reason 正确、再次拆解不重复建；
  - 无 save 端口且无匹配 → 回落首个角色，不抛错；
  - save 抛错 → 拆解仍 ok、回落生效；
  - 更新 listTasks 角色筛选旧断言（6 条全架构师 → 按新归属计数）。
- **board-lifecycle-003.spec.ts**：`decomposeRequirement` 调用改为阶段映射入参
  （analyze/impl/verify 分别给 ROLES 三项）。
- **pool.spec.ts**：shouldFillTarget 四分支（新 nonce 填、同 nonce 不填、0 不填、无目标不填）。
- **门禁**：`npm run typecheck`（三道 tsc）→ `npm test`（全量 vitest）→ `npm run build`（tsdown）。

## Risks / Mitigations

- **老部署 roles.json 已有 3 角色**：空文件播种会跳过新角色 → 对账函数按 id 补齐；
  补写走 RoleStore 校验，同名自定义角色先判重不写入，避免名称重复。
- **用户刻意删除内置角色**：重启/拆解会补回（本期明示策略）；缓解：角色可改名、可改 provider，
  自动创建只保证"有有效角色可派"，不锁定用户配置；墓碑机制留待后续。
- **关键词误匹配**：只认名称、词表保守（impl 不收裸"工程师"），并以单测固化三角色互不串台；
  通用词低权重且与专门命中分开判定，永远不会挤掉专门角色。
- **自动创建角色的 provider 在宿主不可用**：固定 `spawn`（与既有内置角色一致，
  现有部署默认提供）；即便不可用，既有 `resolveRoleAvailability` 禁用提示与派发前检查不变。
- **nonce 时序**：chooseTarget 中先 await enrich/reloadBoard 再 setTarget+setNonce，
  两次 state 更新同批提交，effect 看到的 target 与 nonce 一致；nonce 仅单调递增、不持久化，
  面板重挂后从 0 开始，首次选择仍正常填充。

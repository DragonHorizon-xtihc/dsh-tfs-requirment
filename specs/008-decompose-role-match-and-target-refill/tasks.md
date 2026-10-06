---
description: "Task list for 008 decompose role match + general engineer + auto-create roles + target refill"
---

# Tasks: 拆解自动匹配角色 + 通用工程师 + 角色自动创建 + 选为目标重复填充

**Input**: `specs/008-decompose-role-match-and-target-refill/`（spec.md / plan.md）
**Tests**: 按项目宪法 Principle VII，测试一律必选；纯逻辑全部下沉可单测模块，跨宿主边界用结构类型桩。
**Organization**: 按用户故事分组（US1/US2/US3 同属宿主半角色链路，US4 为客户端独立修复线）。

## 约定

- 宿主半改 `src/host/**`、`src/core/**`、`src/orchestration/**`、`src/index.ts`；
  客户端半只改 `src/client/**`；两端共享类型只进 `src/shared/contracts.ts`。
- 每完成一个代码任务即跑相关测试；全部完成后跑三道 tsc + 全量 vitest + tsdown 构建。
- 不臆造字段：内置角色字段与 `src/orchestration/roles.ts` 现有三条保持同构。

---

## US1 — 拆解按阶段自动匹配角色（P1）

- [x] **T1.1 [US1]** 新增 `src/orchestration/role-match.ts`（纯逻辑，仅 import type
  `RoleDefinition` 与本模块自有类型，禁 import node:* / persistence）：
  - `DECOMPOSE_STAGES = ['analyze','impl','verify'] as const`、`type DecomposeStage`；
  - `GENERAL_ROLE_ID='role-general'`、`GENERAL_ROLE_NAME='通用工程师'`；
  - 内置模板 `ROLE_ARCHITECT/ROLE_CODER/ROLE_QA/ROLE_GENERAL`（字段与现有 DEFAULT_ROLES
    同构：provider `spawn`、defaultModel `deepseek-v4-flash`、defaultSkills `[]`、
    autoExecute false、tagStrategy `dsh`；ROLE_GENERAL 描述说明通用兜底职责）；
  - `BUILTIN_ROLES`（4 条，顺序 架构师/开发/测试/通用）、
    `STAGE_ROLE_TEMPLATES: Record<DecomposeStage, RoleDefinition>`；
  - `STAGE_KEYWORDS`（analyze：架构/需求分析/分析/设计/方案/architect/analyst/design；
    impl：开发/研发/编码/实现/coder/developer/engineer/programmer；
    verify：测试/验证/质量/回归/qa/test/testing）；
  - `GENERALIST_KEYWORDS`（通用/全栈/通才/general/generalist/fullstack/full-stack）；
  - 内部 `countNameHits(name, keywords)`（name 小写化后逐词 includes，每个关键词至多计 1 次）；
  - `matchRoleForStage(stage, roles)`：名称阶段词命中数 >0 中取最高、平分取列表前者，无命中 undefined；
  - `matchGeneralistRole(roles)`：通用词命中 >0 取最高/前者，否则 undefined；
  - 模块注释写明"只认角色名称、描述不参与"的理由与三级回落语义。
- [x] **T1.2 [P] [US1]** 新增 `tests/role-match.spec.ts`：
  - 内置四角色：analyze→架构师、impl→开发工程师、verify→测试工程师；
  - 列表乱序（测试工程师排第一）结果不变；
  - 定制名：前端开发工程师→impl、自动化测试→verify、需求分析师→analyze、DBA→三阶段均不命中；
  - 防串味：测试工程师不命中 impl、开发工程师不命中 verify、架构师不命中 impl/verify；
  - 通用工程师三阶段专门匹配均落空、matchGeneralistRole 命中；自定义「全栈工程师」命中通用；
  - 仅描述含阶段词、名称不含 → 不命中；
  - BUILTIN_ROLES 通过 `validateRole` 逐条校验且名称唯一。
- [x] **T1.3 [US1]** 修改 `src/core/board/decompose.ts`：
  - 从 `role-match.js` import `GENERAL_ROLE_NAME` 与 `type DecomposeStage`；
  - 签名改为 `decomposeRequirement(req, rolesByStage: Record<DecomposeStage, RoleRef|undefined>)`；
  - 三个草稿分别取 analyze/impl/verify 角色，各自计算 frozenConfig；
  - 占位 roleAgent 由 `'general'` 改为 `GENERAL_ROLE_NAME`；
  - 更新模块注释（逐阶段匹配由 board-service 完成，本函数只按映射出草稿）。
- [x] **T1.4 [US1]** 修改 `src/host/board-service.ts`：
  - `RoleReader` 扩展/替换为 `RoleManager`：`list/getByName` + 可选 `save?(role): void`，
    deps.roles 类型同步（保留旧名引用处兼容）；
  - import `DECOMPOSE_STAGES/matchRoleForStage/matchGeneralistRole/STAGE_ROLE_TEMPLATES`；
  - 新增私有 `resolveStageRole(stage, createdAcc): RoleDefinition | undefined`
    （专门匹配 → 通用匹配 → save 自动创建（双检 id/名称、try/catch、失败 persist
    `role-auto-create-failed` 后回落）→ list()[0] → undefined）；
  - `decompose()` 先逐阶段解析角色再 `decomposeRequirement(req, rolesByStage)`；
  - 返回体新增 `createdRoles: string[]`（创建角色展示名），reason 追加"；自动创建角色：…"；
  - persist('decompose') detail 增 `roleAssignment` 与 `createdRoles`。
- [x] **T1.5 [P] [US1]** 更新 `tests/board-service.spec.ts`：
  - `makeRolesRepo` 改为**每次调用返回独立角色数组**（clone ROLES）并实现 `save`（push 去重），
    消除模块级状态污染；
  - 既有用例 line ~416 断言 analyze→架构师、frozenConfig 保持；
  - 新增：三角色齐全（架构师/开发/测试）逐阶段指派且 frozenConfig 各属其主；
  - 新增：架构师+开发+通用工程师（无测试）→ verify→通用工程师、createdRoles 为空；
  - 新增：仅 DBA + save → 自动创建架构师/开发工程师/测试工程师、任务分别指派、
    createdRoles 与 reason 含自动创建、再次 decompose 不重复创建；
  - 新增：角色仓无 save 且无匹配 → 回落首个角色、decompose 仍 ok；
  - 新增：save 抛错 → decompose 仍 ok 且回落生效；
  - 更新 listTasks 角色筛选断言（旧：架构师 6 条；新：按阶段归属计数）。
- [x] **T1.6 [US1]** `tests/board-lifecycle-003.spec.ts` 适配新签名：
  `seedRequirement` 中 `decomposeRequirement(req, ROLES)` 改为
  `decomposeRequirement(req, { analyze: ROLES[0], impl: ROLES[1], verify: ROLES[2] })`；
  跑该文件确认 decomposeTasks 复活重建等既有用例全绿。

## US2 — 内置「通用工程师」角色 + 启动对账播种（P1）

- [x] **T2.1 [US2]** 修改 `src/orchestration/roles.ts`：
  - 从 `role-match.js` 再导出/派生 `DEFAULT_ROLES = BUILTIN_ROLES`（单一事实源，保留既有
    `export { RolePermission, RoleDefinition }` 与所有现有导出不破坏）；
  - 新增 `ensureBuiltinRoles(store: RoleStore): string[]`：逐条 BUILTIN_ROLES，
    `store.get(id) || store.getByName(name)` 存在则跳过，否则 save；返回新补写 id 列表；
    注释写明"不覆盖已存在条目（含改名/改名后的内置 id）""同名自定义角色不重复写"。
- [x] **T2.2 [US2]** 修改 `src/index.ts`（约 277-284）：
  空文件播种替换为 `const added = ensureBuiltinRoles(roleStore)`，
  added 非空时 info 日志写明补写角色名与 roles.json 路径；catch 日志保留。
- [x] **T2.3 [P] [US2]** 更新 `tests/roles.spec.ts`：
  - 默认角色集自洽用例改为 4 条、含 id `role-general` 与名称「通用工程师」、名称唯一/provider 非空；
  - 新增 ensureBuiltinRoles：空店补 4；已存在（含被改名/改模型）不覆盖；
    老店仅缺 role-general 只补 1；存在同名「通用工程师」自定义角色时不写入重复条目。

## US3 — 匹配不到时自动创建角色的端到端可见性（P1）

- [x] **T3.1 [US3]** `src/shared/contracts.ts`：
  - `HostBridge.decomposeRequirement` 返回类型加 `createdRoles?: string[]`；
  - `ExecutionPanelData` 加 `targetFillNonce?: number`（注释：纯客户端会话态，
    由 slots 注入，宿主 getPanelData 不下发、不落盘）。
- [x] **T3.2 [US3]** `src/client/slots.tsx`：
  - HttpHostBridge.decomposeRequirement 返回泛型加 `createdRoles?: string[]`；
  - TaskCenter onDecompose 改为 async 包装：`const r = await bridge.decomposeRequirement(id);
    if (r.ok && r.createdRoles?.length) reload(); return r`（reload = getPanelData 刷角色下拉）。
- [x] **T3.3 [US3]** `src/client/components/TaskCenter.tsx`：
  onDecompose prop 类型返回对象加 `createdRoles?: string[]`（仅类型，处理在 slots）。
- [x] **T3.4 [P] [US3]** 宿主侧自动创建已在 T1.4/T1.5 覆盖；补一条契约核对：
  `tests/host-api.spec.ts` 中若有 decompose 直通用例，断言 createdRoles 字段可透传
  （无自动创建时为空数组或不存在，不破坏旧响应形状）；无则跳过并在交付说明注明。

## US4 — 第二次「选为目标」重新带入标题/描述/执行 Prompt（P1）

- [x] **T4.1 [US4]** `src/shared/pool.ts` 新增纯函数
  `shouldFillTarget(nonce, lastFilledNonce, hasTarget): boolean`
  （hasTarget && nonce>0 && nonce!==lastFilledNonce），附模块注释说明 nonce 语义
  （显式点击事件 vs 轮询刷新）。
- [x] **T4.2 [P] [US4]** `tests/pool.spec.ts` 新增用例：
  新 nonce（1 vs 0）→ true；同 nonce 重复 effect → false；nonce=0 → false；
  hasTarget=false → false；同一目标第二次点击（nonce 2 vs 1）→ true。
- [x] **T4.3 [US4]** `src/client/slots.tsx#Workbench`：
  - 新 state `targetFillNonce`（useState(0)）；
  - `chooseTarget` 中 setTarget(enriched) 同批 setTargetFillNonce(n=>n+1)
    （enrich catch 降级路径也自增）；
  - execData 展开注入 `targetFillNonce`。
- [x] **T4.4 [US4]** `src/client/components/ExecutionPanel.tsx`：
  删除 targetKey/filledKeyRef 块（约 122-131），改为 nonce 判定：
  `fillNonce=data.targetFillNonce??0`、`lastFilledNonceRef=useRef(0)`，
  effect 依赖 `[fillNonce, data.target]`，先 `shouldFillTarget` 判定再
  `buildTargetFill` 填 title/description/execPrompt；更新注释解释"每次显式选择都重填、
  轮询不填"。

## 收尾验证（全绿才算完成）

- [x] **T5.1** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.host.json`
- [x] **T5.2** `node node_modules/typescript/bin/tsc --noEmit -p tsconfig.client.json`
- [x] **T5.3** `node node_modules/typescript/bin/tsc -p tsconfig.tests.json`
- [x] **T5.4** `node node_modules/vitest/vitest.mjs run`（全量；记录总数/失败数）
- [x] **T5.5** `npm run build`（tsc host/client + tsdown，产出 lib/client.js）
- [x] **T5.6** 自检四条人工验收路径（代码走查）：
  ① 内置四角色拆解 → 三段各归其主；② 删测试工程师留通用 → verify 落通用；
  ③ 仅留无关角色 → 自动建三角色且下拉立即可见；④ 选目标→发起执行清空→再选同一目标→三字段重新带入。

---

## 完成记录（2026-09-21）

- 全部任务完成。验证命令实际从宿主根 `..\..\node_modules` 调用（插件本地无 node_modules）：
  - T5.1 host tsc `--noEmit`：通过（exit 0）；
  - T5.2 client tsc `--noEmit`：通过（exit 0）；
  - T5.3 tests tsc：通过（exit 0）；
  - T5.4 vitest run：**48 个测试文件 / 782 个用例全部通过**（新增 role-match.spec.ts 19 个、
    pool.spec.ts +5、roles.spec.ts +4、board-service.spec.ts +6、board.spec.ts +1）；
  - T5.5 `npm run build`：通过，`lib/client.js`（336.61 kB）与 `lib/types/**` 已含新逻辑
    （grep 验证 targetFillNonce / createdRoles / ensureBuiltinRoles / role-auto-create 均在产物中）。
- T3.4 补充说明：无 `tests/host-api.spec.ts` decompose 直通断言；已静态核对
  `src/host/api.ts`（两处 decompose 返回类型已补 `createdRoles?: string[]`，函数体原样
  `return deps.board.decompose(...)`）与 `src/host/route.ts#createDecomposeHandler`
  （`sendJson(res, 200, await api.decomposeRequirement(...))` 整对象透传），字段可到 HTTP 响应；
  客户端 HttpHostBridge 与 TaskCenter prop 类型同步补齐。
- T5.6 四条路径的自动化覆盖：① board-service.spec「US1 各归其主」；
  ② 同文件「通用工程师兜底」用例（verify 落通用、零创建）；
  ③ 「无专门无通用自动创建」用例 + slots.tsx onDecompose 成功后 reload() 使角色下拉立即刷新；
  ④ pool.spec `shouldFillTarget` 五分支 + slots nonce 自增 / ExecutionPanel effect 接线。
  仍建议人工在真实 dsh 界面走查一遍（测试环境无 React 渲染层）。

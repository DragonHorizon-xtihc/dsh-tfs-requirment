# Implementation Plan: 需求池三项交互修复（可选项缓存 / 领取可见 / 目标带出内容）

**Branch**: `002-fix-pool-claim-target` | **Date**: 2026-09-20 | **Spec**: [spec.md](./spec.md)
**Input**: Feature specification from `/specs/002-fix-pool-claim-target/spec.md`

## Summary

需求池面板存在三个已定位到源码的缺陷：**(1)** 筛选可选项（团队项目/工作项类型/状态/指派人）每次进入页签都全量重采
（62 个项目 × 元数据采集），宿主半无缓存、客户端半每次挂载都重发请求；**(2)**「领取入池」真实入池了
（`board.json` 已落盘）但 UI 无持久反馈，且不刷新看板快照，主观上"点了没反应"；**(3)**「选为目标」后执行配置表单为空，
因为 `RequirementSummary` 契约**根本没有描述字段**。

方案：① 在宿主半加进程内可选项缓存（集合为键 + inflight 去重 + 手动强制重采通道），客户端半保留一份
跨挂载的模块级副本只用于避免重复往返；② 把已入池的去重键集合下发给需求池，行内持久化标记 + 领取后刷新看板快照；
③ 给 `RequirementSummary` / 领域 `Requirement` 增加 `description`（`System.Description` → 纯文本），
执行面板在**目标键变化**时自动填充表单。

## Technical Context

**Language/Version**: TypeScript 5（宿主半 Node 运行时 + 客户端半浏览器运行时，两套 tsconfig）
**Primary Dependencies**: `@deepseek-ai/cordis`（插件容器）、React 18（客户端 UI，仅内联样式）、vitest（单测）
**Storage**: JSON（`board.json`，权威）+ JSONL（`events.jsonl`）+ 渲染 Markdown；可选项缓存为**进程内内存**，不落盘
**Testing**: vitest；三条门禁 `npm run typecheck`（host / client / **tests** 三条）+ `npm run test`
**Target Platform**: DSH 插件（宿主半 = dsh 进程；客户端半 = 浏览器 `main` 槽面板）
**Project Type**: DSH 插件（双半：host + client，经 `src/shared/contracts.ts` 契约通信）
**Performance Goals**: 需求池页签二次进入时下拉**立即可用**、后台采集请求数 0；单次采集请求数维持现状不再放大
**Constraints**: 客户端半编译范围仅 `src/client/**` + `src/shared/**`（`src/shared` 不得有 DOM 依赖）；
TFS 写操作仍唯一经适配层；不得新增 npm 依赖
**Scale/Scope**: 4 个集合 / 62 个项目；单集合可选项采集一次

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

| 原则 | 结论 | 依据 |
|---|---|---|
| I 证据优先 | ✅ 通过 | 全部根因带 `文件:行号`（见 research.md）；TFS 字段 `System.Description` 为 TFS 标准字段引用名，与 `adapter.ts:568` 既有写入用法同源 |
| II 写操作四门禁 | ✅ 不受影响 | 本次**不新增任何 TFS 写路径**；领取打标签仍走 `BoardService.claimRequirement` 既有门禁链路 |
| III 凭据隔离 | ✅ 不受影响 | 不涉及 PAT 读取/展示路径 |
| IV TFS 出口唯一 | ✅ 通过 | 全部读取仍经 `TfsAdapter`；缓存只缓存读取结果，不绕过适配层 |
| V dsh 标签幂等 | ✅ 不受影响 | 领取打标签逻辑不改 |
| VI 状态外置 | ✅ 通过 | 新增 `description` 随 `board.json` 落盘（符合"JSON 为权威"）；**可选项缓存刻意不落盘**——进程内缓存才能匹配"重启即重采"诉求，落盘反而让陈旧数据复活 |
| VII 契约显式 / 验证先行 | ✅ 通过 | 三处新增逻辑下沉 `src/shared/` 以便单测（客户端无 React 测试库）；契约改动集中在 `src/shared/contracts.ts` |

**无违规项** ⇒ Complexity Tracking 无需填写。

## Project Structure

### Documentation (this feature)

```text
specs/002-fix-pool-claim-target/
├── spec.md           # 需求（3 个用户故事 + 11 条 FR + 5 条 SC）
├── plan.md           # 本文件
├── research.md       # Phase 0：5 条决策 + 根因源码证据 + 备选方案否决理由
├── data-model.md     # Phase 1：4 项契约/结构变更与状态迁移
├── checklists/       # 需求质量清单（已全项通过）
└── tasks.md          # Phase 2（/speckit.tasks 产出）
```

### Source Code (repository root)

```text
src/
├── shared/                       # 宿主半与客户端半共享（无 DOM 依赖，可单测）
│   ├── contracts.ts              # ✏️ RequirementSummary + description；ExecutionPanelData + target；
│   │                             #    TFS_ROUTES + queryOptionsRefresh
│   ├── text.ts                   # 🆕 htmlToPlainText + 截断（纯字符串）
│   └── pool.ts                   # 🆕 requirementKey / 已入池集合 / 目标填充 / 缓存可缓存判据
├── tfs/
│   ├── adapter.ts                # ✏️ normalizeWorkItem 映射 System.Description
│   └── types.ts                  # ✏️ Requirement + description
├── host/
│   ├── api.ts                    # ✏️ 可选项缓存 + inflight 去重 + refreshQueryOptions
│   └── route.ts                  # ✏️ 新增 query-options-refresh 路由
├── client/
│   ├── slots.tsx                 # ✏️ 传已入池键集合 / 领取后刷新看板 / execData 带 target
│   └── components/
│       ├── RequirementPool.tsx   # ✏️ 复用可选项 / 已入池标记 / 重新采集按钮 / 行内反馈
│       └── ExecutionPanel.tsx    # ✏️ 目标变更时自动填充表单
└── core/board/…                  # 不改（任务模型不变）

tests/
├── pool.spec.ts                  # 🆕 shared/pool.ts 单测（键、填充、缓存判据）
├── text.spec.ts                  # 🆕 HTML→纯文本单测
├── host-api.spec.ts              # ✏️ 缓存命中/失效/并发/强制重采
├── normalize.spec.ts             # ✏️ description 归一化断言
└── host-route.spec.ts            # ✏️ 新路由可用性
```

**Structure Decision**：沿用既有双半结构（Option 1 单项目）。所有可被客户端消费的逻辑一律放 `src/shared`，
不留"只在组件里"的不可测逻辑。

## 实施要点（对应三条 FR 簇）

### A. 可选项缓存（FR-001…005）

1. `src/host/api.ts`：`createHostApi` 内增加 `cache = new Map<string, RequirementQueryOptions>()`
   与 `inflight = new Map<string, Promise<...>>()`；`getQueryOptions()` 命中即返回；
   新增 `refreshQueryOptions()` 绕过缓存重采；`HostApi` 接口补方法声明。
2. 缓存写入判据 `shouldCacheQueryOptions(opts)`（放 `src/shared/pool.ts`）：
   `projects.length > 0 || types.length > 0`——全空（降级）不锁死。
3. `src/host/route.ts`：新增 `POST /tfs-requirment/query-options-refresh`（有副作用=强制重采，故用 POST）。
4. 客户端：`HttpHostBridge` 增加模块级 `queryOptionsCache`（按集合）+ `refreshQueryOptions()`；
   `RequirementPool` 挂载时**仅在无数据时**请求（prop 由 Workbench 传入或模块缓存提供）。
5. UI：筛选区增加「重新采集」按钮 + 进行中状态 + 采集时刻显示。

### B. 领取可见（FR-006…008）

1. `Workbench` 计算 `claimedKeys`（`board?.requirements.map(requirementKey)`）下发给 `RequirementPool`。
2. `RequirementPool`：`onClaim` 成功后把该键并入本地已入池集合（先于 `reloadBoard` 生效，避免闪烁），
   再触发 `reloadBoard()`；失败则在**该行下方**显示原因且不标记。
3. 行渲染：已入池显示徽标 + 按钮转为"已在池中"（禁用重复入池）；领取中禁用该行按钮（`claimingId` state）。

### C. 目标带出内容（FR-009…011）

1. `normalizeWorkItem`（`src/tfs/adapter.ts:1520`）映射 `System.Description`，经 `htmlToPlainText` 转换。
2. `summaryToRequirement` / `requirementToSummary` 双向透传 `description`。
3. `Workbench` 的 `execData` 增加 `target`（当前目标摘要）。
4. `ExecutionPanel`：监听目标键变化（`requirementKey`）→ 调 `buildTargetFill()` 填充
   `title` / `description` / `execPrompt`；目标键未变时不覆盖用户输入。

## 风险与取舍

- **缓存陈旧**：项目/类型在 TFS 上变更后，缓存会滞后到服务重启或手动重采。已用「重新采集」按钮
  + 采集时刻显示把该代价显式化（FR-003），符合用户对"除非重启否则不重采"的明确要求。
- **`board.json` 体积**：新增正文字段会让单条需求变大。**实施时已加一道上限**——
  `src/shared/text.ts` 的 `MAX_DESCRIPTION_CHARS`（20000）在 `normalizeWorkItem` 处截断，
  把"权威数据"限定在"够用的完整"：面板填充另有一级 `TARGET_TEXT_LIMIT`（4000），
  两级取值不同是为了让截断标记只出现一次（同取 4000 会让面板把"…（已截断）"再截一遍，叠两个标记）。
- **列表 payload**：WIQL 本就返回全字段，映射 `description` 不新增网络请求，仅增加内存占用；
  上限 20000 也把它从"随正文体积线性膨胀"压成了有界。

## Complexity Tracking

无宪法违规项，本节为空。

---

## 实施结论（2026-09-20 完成，T024）

### 门禁实测

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型（三条） | `npm run typecheck`（host + client + **tests**） | ✅ 0 error |
| 单测 | `npm run test` | ✅ **31 文件 / 468 用例全绿**（基线 29 文件 / 410 用例 → +2 文件 +58 用例） |
| 客户端打包 | `npm run build:client`（`tsc` + `tsdown`） | ✅ `lib/client.js` 202.21 kB（gzip 50.15 kB） |

### 三条修复的落地要点与实测证据

**A. 可选项缓存（US1）**
- 宿主半 `src/host/api.ts`：`queryOptionsCache` + `queryOptionsInflight` 双 Map，键 = 当前生效集合。
  inflight 的值是 `{ key, promise }` 而非裸 promise——收尾时靠 `key` 令牌"只撤自己那一项"，
  避免误删 `refreshQueryOptions` 的登记（裸 promise 做不到，只能自引用，而自引用会被 TS2454 拦下）。
- 空结果不入缓存（`shouldCacheQueryOptions`：项目或类型任一非空才写），防一次抖动把空下拉锁死到重启。
- 新增 `POST /tfs-requirment/query-options-refresh`（`src/host/route.ts`），UI 有「重新采集可选项」按钮。
- 客户端 `RequirementPool` 保留模块级副本，切页签重挂载时**零 HTTP 往返**（`optionsMemory` 命中直接复用）。
- 实测（tests/host-api.spec.ts）：连续两次调用 → 采集轮数 1；换集合 → +1 且切回命中旧分区；
  全空结果 → 仍然重采；三路并发 → 1 轮；强制重采 → +1 且新结果重新入缓存。

**B. 领取可见（US2）**
- `claimedKeysOf(board.requirements)` 下发需求池；行内「已入池」徽标 + 按钮三态
  （领取入池 / 领取中… / 已在池中）+ 行级失败原因 + 防连点。
- 只在**成功**时打标记（失败也标记会把"没领进来"说成"已入池"）；成功后 `onClaimed → reloadBoard()`。
- `requirementKey`（`src/shared/pool.ts`）与宿主半 `requirementDedupKey`（`src/tfs/types.ts:68`）
  同构（均为 `id@collection`），已核对一致。

**C. 目标带出内容（US3）**
- 全链路补 `description`：`normalizeWorkItem` 取 `System.Description` → `htmlToPlainText`
  → `Requirement` → `board.json` → `RequirementSummary` → `ExecutionPanelData.target` → 表单自动填充。
- `ExecutionPanel` 用 `filledKeyRef` 记账，**只在目标键变化时填充一次**，不覆盖用户后续编辑
  （组件内已有同类教训：异步目录到达后写回 state 会顶掉用户选择）。

### 过程中修正的两处问题

1. **`htmlToPlainText` 列表项多空行**：`</li>` 与 `<li>` 各吐一个换行，导致 `- 甲\n\n- 乙`。
   已把 `li` 从块级闭合规则里摘出，改由 `<li>` 开头标记独占换行（tests/text.spec.ts 锁定）。
2. **旧断言与新契约冲突**：`tests/tfs-list-contract.spec.ts` 原先把 `description` 列在
   "未映射字段不得外泄"清单里——US3 之后它是**有意带出**的字段。已同步更新该断言并补三条正文用例，
   而不是回头削弱实现。

### 门禁退出码：本机 vitest 退出码不稳定（**不是**用例失败）

`npm run test` 的**用例结果恒为全绿**，但**进程退出码偶发为 1**，二者不对应：

| 判据 | 结果 |
|---|---|
| 默认/串行/JSON 三种跑法合计 8 次 | 汇总行恒为 `31 passed (31)` / `468 passed (468)`，无任何 FAIL 段 |
| JSON 报告（`--reporter=json`） | `success=true`、`numFailedTests=0`、`numFailedTestSuites=0`、`failedCount=0` |
| 进程退出码 | 全量跑 6 次：1 / 1 / 1 / 0 / 1 / 1；单文件与 4 文件子集多为 0；同一 8 文件组合两次不同（1 → 0） |

已排查并**排除**的原因：

- **并行专属**：`--pool=threads` 与 `--pool=forks` 均为 1；`--no-file-parallelism` 首次为 0、后续两次为 1
  ⇒ 串行同样复现，不是并行专属。
- **定时器泄漏**：`src` 两处 `setTimeout` 均在 `finally` 里 `clearTimeout`
  （`src/host/profile-service.ts:309`、`src/tfs/rest-client.ts:161`）；`tests` 仅 `tests/e2e.spec.ts:263`
  一处 `setTimeout(r, 0)`。
- **业务代码调 exit**：`process.exit` / `process.exitCode` 仅出现在 `scripts/`（不在测试范围）。

结论：退出码 1 属 Windows + Node 22.22.2 + vitest 4.1.8 工具链层的退出码传播现象，
**与本次三项修复无关，也与任一用例无关**。

应对（避免"习惯性红灯"掩盖将来的真实失败）：判红绿一律以**汇总行或 JSON 报告的 `success` 字段**为准，
不要只看 `$?`；
需要机器判读时用 `npx vitest run --reporter=json --outputFile=<path>` 后解析 `success` / `numFailedTests`。

**教训**：我一度据"串行那次为 0"就归因于并行并写进配置（`fileParallelism: false`），
第二次复跑即为 1 ⇒ 假设不成立，**已回滚**该配置项。单次运行的结果不能作为因果依据，必须重复验证。

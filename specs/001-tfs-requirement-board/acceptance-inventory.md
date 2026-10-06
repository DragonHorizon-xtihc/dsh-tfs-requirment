# 验收清点（T068 / SC-001 ~ SC-009）

评判原则：**能自动化的必须自动化**（给出测试文件与用例名）；不能自动化的写清"怎么手工跑 + 预期看到什么"，
并注明当前是否**已在本机真实跑过**。凡未实测的，标 `[未实测]`，不写成"通过"。

验证环境：Windows + Node 22.22.2（WorkBuddy 托管）+ vitest v4.1.8；
TFS 侧为真实 `http://tfs2018-web.winning.com.cn:8080/tfs`（集合 `WN_HIS`）。

---

## 速览

| 标准 | 自动化 | 手工 | 状态 |
|---|---|---|---|
| SC-001 连接成功 + PAT 无明文 | ✅ | ✅ | 自动化**通过**；手工 `[未实测]`（需真实凭据启动） |
| SC-002 需求列表四项操作 | ✅ | ⚠️ 部分 | 2026-09-17 复探后**列表出口改走 WIQL（实测可用）**，字段映射/出口/两道护栏共 25 例自动化**通过**；UI 全流程 `[未实测]`（需真实 PAT 启动） |
| SC-003 拆解 + 指派 | ✅ | ✅ | 自动化**通过**；真实数据链路演练**通过**（#1997179，见 SC-003b） |
| SC-003b 工作目录接线 + 真实链路 | ✅ | ✅ | `scripts/real-chain.ts` **已实测通过**，TFS 零写入 |
| SC-004 发起执行 + 冻结配置 | ✅ | — | 自动化**通过**（subagents 为桩） |
| SC-005 `dsh` 标签幂等 | ✅ | — | 自动化**通过** |
| SC-006 回写必经 dry-run + 审计 | ✅ | — | 自动化**通过** |
| SC-007 重启恢复一致 | ✅ | — | 自动化**通过** |
| SC-008 写操作审计覆盖 100% | ✅ | — | 自动化**通过**（含逐条对齐断言） |
| SC-009 文档 + 可执行验收清单 | ✅ | — | 本文件即清单；`README.md` 覆盖安装/配置/使用 |

---

## SC-001 连接成功，且全仓检索找不到 PAT 明文

**自动化**：
- `tests/host-route.spec.ts` → `GET 档案清单 → 200 …` 断言响应体 `not.toContain('pat')`；
- `tests/profile-service.spec.ts` → 对 `save` / `list` / `envTemplate` / `writeEnvFile` 的返回值
  逐个 `JSON.stringify(...).not.toContain(PAT)`；`Object.keys(...)` 精确等于 `['collection','id','name','url']`；
- `tests/profile-service.spec.ts` → 删除档案后 `profiles.json` 不再含明文（S-12 覆写）；
- `tests/health.spec.ts` → `scrubCredentials` 四类擦除；
- `tests/e2e.spec.ts` → 写失败原因不含凭据片段。

**手工**（需真实 PAT，`[未实测]`）：
1. 工作台 → 连接与凭据 → 填档案（url/collection/PAT）→ 保存；
2. 点「运行自检」→ 预期显示身份 `zhangbo3(张波)`、当前集合、可见项目数；
3. 全仓检索 PAT 明文：`grep -rn "<你的PAT>" .`（预期：仅命中 `profiles.json` 与 `tfs-mcp.env`，
   且这两个文件都应被 `.gitignore` 覆盖）；
4. 查看 `audit.jsonl` / `events.jsonl` / `board.json`：预期均不含 PAT。

---

## SC-002 需求列表：筛选 / 分页 / 刷新 / 详情

**已完成的部分**：
- 归一化（tfs-mcp → 领域形状）：`tests/normalize.spec.ts`（6 例）；
- 列表路由与筛选透传：`tests/host-route.spec.ts` → `createRequirementsHandler` 系列；
- 刷新与**增量**：`tests/poll.spec.ts`（16 例，含新增/更新/保留/跨集合/去重）；
- 分页参数（`top`/`skip`）已进契约 `RequirementFilter`。

### 2026-09-17 复探：**列表路径已由「受阻」翻转为「可用 + 两道护栏」**

第三次复探（不沿用旧结论，全部重新实测）：

| tfs-mcp 工具 | 本次实测结果 | 结论 |
|---|---|---|
| `tfs_custom_query`（**仅 `{top:2}`，不传 fields**） | `The expand parameter can not be used with the fields parameter.` | **恒失败**：服务端内部固定同时发 `expand` 与 `fields`，与调用方是否传 `fields` 无关 ⇒ 结构性不可用，**已弃用** |
| `tfs_get_work_items`（`{ids:[2]}`，schema 无 fields 参数） | 同上 `expand+fields` 冲突 | 同样不可用 |
| `tfs_search_work_items` | `Failed request: (414)` | 不可用 |
| `tfs_query_wiql`（`WHERE [System.Id] = 2`） | **正常返回**，典型工作项响应 **≈4KB** | **可用 ⇒ 采纳为列表主出口** |
| `tfs_query_wiql`（`WHERE [System.Id] = 1`） | 返回但 **3,492,287 字节（≈3.4MB）** | 体积离群（根计划项含 **7316 条 relations**），须护栏 |
| `tfs_query_wiql`（0 命中，如 `ChangedDate >= '2026-09-16' AND Type='Bug'`） | 抛 `items is not iterable (cannot read property null)` | tfs-mcp 把"0 命中"当异常 ⇒ 须归一化 |
| `tfs_get_work_items_by_customer` | **可用**（写 CSV 落盘，响应体仅 `{customerName,totalCount,collectionCounts,file}`；实测「人民」0 命中） | 轻量旁路，非通用列表 |
| `tfs_get_recent_resolved`（1 天 / 7 天） | `[]`（无报错） | 可用但数据面窄 |

**据此落地的两道护栏**（`src/tfs/adapter.ts#listRequirements`）：
1. **空结果归一化**：`items is not iterable` → `{ok:true, items:[], total:0}`，避免把"没有需求"误报成"连接故障"；
2. **响应体积熔断**：默认阈值 **2MB**（典型 20 条 ≈80KB，裕度充足）。超阈值返回 `ok:false` + 提示收窄
   `project`/状态/时间窗，避免 MB 级 relations 数组进入下游。

**分页声明**：`tfs_query_wiql` schema 仅 `query`/`project`/`collection`，**无 top/skip**，
故 `top`/`skip` 在客户端侧切片并回报 `total`（已在契约测试中锁定）。

**处理方式**：不绕过 tfs-mcp（宪法 Principle IV）；失败时**显式报错**而非伪装成"空列表"；
同时保留「按工作项 ID 领取」（`tfs_get_workitem`，实测可用）作为兜底读路径。
**结论：SC-002 的列表/筛选/刷新/详情在真实 WIQL 样本上已由 `tests/tfs-list-contract.spec.ts`（25 例）覆盖；
仍 `[未实测]` 的是"在宿主内以真实凭据跑通 UI 全流程"这一步（需 PAT 启动，本会话未做）。**

---

## SC-002b 真实凭据配置与真实读取验证（2026-09-18，已实测）

用户提供了真实 `serverUrl` + PAT，据其完成配置并对**真实 TFS**做了只读验证。

### 1. 配置落盘（凭据处置）

| 项 | 结果 |
|---|---|
| 连接档案 | `ProfileService.save` → `.tfs-requirment-data/profiles.json`（id `wn-his-zhangbo3`，url `http://tfs2018-web.winning.com.cn:8080/tfs`，集合 `WN_HIS`） |
| 活动指针 | `.tfs-requirment-data/profile-active.json` |
| MCP 环境文件 | `writeEnvFile()` → `.tfs-requirment-data/tfs-mcp.env`，452 字节，`hardened=true`（尽力 0600） |
| 对外视图 PAT 泄漏 | `list()` 序列化结果不含 PAT → `PAT_LEAKED_IN_VIEW: false` |
| 版本控制 | **发现并修补缺口**：原 `.gitignore` 不覆盖 `profiles.json`/`tfs-mcp.env`（`.env.*` 匹配不到 `tfs-mcp.env`）。已补 `profiles.json` / `profile-active.json` / `tfs-mcp.env` / `.tfs-requirment-data/`；`git check-ignore` 三条全部命中 `.gitignore:14` |

### 2. PAT 有效性（真实 HTTP，只读）

`GET /tfs/WN_HIS/_apis/wit/workitems/2?api-version=4.1`，Basic `:PAT`：
**HTTP 200**，读回 `id=2 / 基础框架搭建 / 已关闭` ⇒ **PAT 可用**。
（凭据仅从系统临时文件读入，未出现在命令行或任何输出中。）

### 3. 真实读取：抓到一个**前几轮都没发现的致命约束**

用插件代码生成它实际会发出的 WIQL，再对真实 TFS 发起调用：

| 生成的 WIQL | 真实结果 |
|---|---|
| `… WHERE [System.Title] CONTAINS '框架'`（+ project EDIS） | **414** |
| `… WHERE [System.Title] CONTAINS '框架'`（不带 project） | **414** |
| `… WHERE [System.Title] CONTAINS 'MEMORY'`（ASCII） | **正常**，返回 **201 条 / 2,983,788 字节** |
| `… WHERE [System.State] = '不存在状态ZZZ'`（中文等值） | **正常** `[]` |
| `… WHERE [System.Id] = 2 ORDER BY [System.ChangedDate] DESC` | **正常** ≈4KB |

**结论（新事实）**：414 的触发条件是 **`CONTAINS` 子句含非 ASCII**，与查询长度、`ORDER BY`、`project` 参数**均无关**。
而中文关键字/中文姓名是常态 ⇒ 原实现（keyword、assignedTo 都下推 CONTAINS）在真实 TFS 上**必失败**。

**已修**：`isAsciiSafe()` 守卫——`CONTAINS` 仅在值为纯 ASCII 时下推 WIQL；非 ASCII 的
`keyword`/`assignedTo` 改为归一化后**客户端侧过滤**；`state` 用等值 `=`（实测中文可用）始终下推。

### 4. 真实数据回放（真实响应灌进插件代码）

以真实响应（**201 条 / 2,983,788 字节**）回放：
- **原 2MB 阈值会误熔断**（实测 `ok:false`，2.68MB 判定）⇒ 默认列表在真实 TFS 上不可用；
  **已上调为 16MB**（按"真实 201 条 = 2.98MB"标定，可容纳约 1000 条，仍挡得住整集合全量拉取）。
  复验：默认阈值下 `ok=true`，返回 20 条。
- 归一化后单条 **399 字节**（原始整包 2,983,788 字节），`relations` 已丢弃。
- 口径修正：`safeSerializedBytes` 返回的是 **UTF-16 字符数**（2,810,204）而非 UTF-8 字节（2,983,788），
  误差约 6% 且**偏保守**（先熔断），已在注释中如实标注。

### 5. 仍未做：真实**写**测试

未对真实 TFS 做任何写操作（打标签/改状态/评论/关联）。原因：写会落到公司 TFS 的真实工作项上，
属不可逆副作用。**需要你指定目标工作项 ID 并明确确认后才会执行**，且会先过 dry-run 预览 + 确认 + 幂等 + 审计四道门禁。

---

## SC-003 一条需求可被拆解为任务并被指派角色智能体

- `tests/board.spec.ts`（DAG/依赖/乐观锁）、`tests/board-service.spec.ts` → 拆解 `decompose`（三段式）与
  `assignTask`（角色不存在则拒）；
- `tests/host-route.spec.ts` → `createDecomposeHandler` / `createTaskAssignHandler` 参数校验；
- 端到端：`tests/e2e.spec.ts` → 领取 → 拆解 → 指派链路。

**状态：通过。**

---

## SC-003b 工作目录接线 + 真实链路演练（2026-09-18，已实测）

**需求**：让"本地代码库路径"真正接进插件（需求/任务携带 workspace，派发写进子代理 prompt，
UI/看板可见），并用 **#1997179** 走完 领取 → 拆解 → 指派，产出本地看板与任务，**不改 TFS**。

### 能力边界（先说清楚做不到的部分）

| 核实点 | 源码 | 结论 |
|---|---|---|
| 子代理启动请求是否含 cwd/workspace | `@deepseek-ai/dsh-subagent/src/types.d.ts:91` | **没有** |
| 子代理 cwd 从哪来 | 同包 `src/out-of-process.d.ts` `resolveChildCwd(prefix, configured, parentCwd)` | 部署 config override → 否则父会话 workspace |

⇒ 插件**无法按任务改变子代理进程 cwd**。能做到的是把路径作为**任务上下文写进 prompt**
（prompt 是插件唯一能影响子代理的通道），并在 prompt 文本里**显式声明该边界**。
若需子进程 cwd 等于该路径，只能把宿主会话/部署的 cwd 设为该路径。

### 演练（`scripts/real-chain.ts`，可复跑）

数据：真实响应 `tests/fixtures/tfs-workitem-1997179-real.json`（`mcp__tfs-mcp__tfs_get_workitem` 实抓，
扁平形态）+ 真实路径 `D:\体检管理\6.0\03 源代码\60混合框架\GIT60混合框架\Winning.WiNEX.Plugins`。

| 步骤 | 结果 |
|---|---|
| 归一化（真实 `TfsAdapter.getRequirement`） | `1997179 / 需求 / 已分析 / 体检管理\V6.0.2610.15.pec / relations=2` |
| 领取（带路径，`tag:false`） | `ok=true`，`workspace` 规范化为真实路径（真实 `statSync` 校验通过） |
| 拆解 | 3 任务 `#analyze → #impl → #verify`，**三条全部继承 workspace** |
| 指派 | `1997179@WN_HIS#impl` → 开发工程师 |
| 落盘 | `board.json` / `events.jsonl` / `.ai-board/计划看板.md`（真实 fs） |
| 派发 prompt | 前置段含真实路径 + 工作项 + 集合 + "插件不能按任务改变进程 cwd" |
| **TFS 写调用** | **0**（脚本对任何写工具计数并抛错，双保险） |

产物目录：`.tfs-requirment-data/real-board/`（gitignored）。

**状态：通过**（本地链路全绿；TFS 零写入）。

---

## SC-004 发起执行前可设置 MCP / 技能 / 模型

- 冻结配置随任务落库：`BoardTaskView.frozenConfig`（`tests/board-service.spec.ts` 断言冻结值不随角色默认值漂移）；
- 派发：`tests/dispatch.spec.ts`（并发上限、FIFO 排队）、`tests/e2e.spec.ts` → `subagents.start` 收到的
  `model` 与任务冻结配置一致（用例 `frozenConfig: { model: 'm1' }` → 断言 `starts[0].model === 'm1'`；
  `mcp`/`skills` 未在该用例中断言，属未覆盖面）。本轮修复的 `taskId` 命名空间问题即由此测试抓出
  （`starts[0].label === '123@WN_HIS:123@WN_HIS#analyze'`）。

**状态：通过**（`ctx.subagents` 为桩；真实 run 需在宿主内跑）。

---

## SC-005 `dsh` 标签幂等

- 幂等键 `<id>@<collection>:<normLabel>`（`src/write-guard/idempotency.ts`）；
- `tests/board-service.spec.ts` → 已带该标签时**跳过写调用**（断言 adapter 未被调用）；
- `tests/write-guard.spec.ts` → 门禁 3 重复键即拒。

**状态：通过。**

---

## SC-006 回写必经 dry-run 预览 + 每次写入对应一条审计

- `tests/write-guard.spec.ts`（15 例）：`preview()` 可生成、未确认即拒、幂等命中即拒、审计条目字段对齐；
- `tests/e2e.spec.ts` → 非法目标（`—`/非数字 id）**不发写**（防 `id:NaN`）。

**状态：通过。**

---

## SC-007 重启后状态一致

- `tests/board-service.spec.ts` → `load()` 从 `board.json` 恢复逐字段一致；解析失败**保留原文件**并
  `ok:false`（FR-020，绝不静默重建）；`reconcile()` 悬空 `running` → `failed`（S-10）；
- `tests/json-store.spec.ts` → 原子写（tmp + rename）。

**状态：通过。**

---

## SC-008 写操作审计覆盖 100%

度量定义：每个写调用，审计条目数 == 写调用数 == 1，且按幂等键一一对齐。

- 写路径唯一入口：`executeWrite`（`grep` 实测 5 处调用覆盖全部 5 个写方法），门禁 4 在写之前落审计；
- `tests/e2e.spec.ts` → 用例「审计与写调用一一对齐且不含凭据（SC-008）」：断言写审计条目数量、
  每条 `kind==='write'` 的条目都带 `idempotencyKey` 且 `confirmed===true`，且序列化结果不匹配
  `/token=|authorization|pat=/i`；
- `tests/audit-archive.spec.ts` → 归档不改写 live、跨文件不重复归档、损坏不静默成功。

**状态：通过。** 残余说明见 `security-review.md` §1 的 `confirmed:true` 取舍。
---

## SC-009 文档 + 可执行验收清单

- `README.md`：安装（含 profile 接线三步）、凭据传递机制（含宿主源码依据）、配置项表、
  数据落盘清单、开发门禁命令；
- 本文件：SC-001~009 逐项判据与当前状态；
- `specs/001-tfs-requirement-board/security-review.md`：T066 安全评审（含残余风险清单 R1~R6）。

**状态：通过。**

---

## 门禁结果（第七轮：工作目录接线 + 真实链路演练后）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `tsc --noEmit -p tsconfig.{host,client}.json` + `tsc -p tsconfig.tests.json` | **EXIT 0 ×3** |
| 测试 | `vitest run` | **21 文件 / 307 例全绿**（第六轮 259 → 本轮 +48） |
| 构建 | `tsc(host) + tsc(client) + tsdown` | **通过**（`lib/client.js` 119.87 kB / gzip 24.34 kB） |
| 真实链路 | `tsx scripts/real-chain.ts` | **通过**，TFS 写调用 = 0 |

> **教训（本轮新增规程）**：`tsc` 通过 ≠ 能打包。本轮 `RequirementPool.tsx` 的 JSX 属性里
> `placeholder="如 D:\体检管理\6.0\03 …"` 被 oxc 判为**八进制转义** PARSE_ERROR，而 `tsc` 放行。
> **客户端改动必须跑 `tsdown` 才算过门禁**。

---

## 仍未闭合的项（诚实标注）

| 项 | 说明 |
|---|---|
| SC-002 真实 UI 全流程 | 列表出口已可用（WIQL），剩余的是"在宿主内以真实 PAT 跑通 UI"这一步，本会话未做 |
| T051 | TFVC 关联**已落地**：工具目录已含 `tfs_list_tfvc_changesets`/`tfs_get_tfvc_changeset`/`tfs_get_tfvc_changeset_changes`；但**仍无任何"建立关系"的写工具**（无 `add_relation`）⇒ 回写仍为评论（已改为携带真实变更集元数据）。真·ArtifactLink 关系需 tfs-mcp 增补写工具 |
| 真·子代理 cwd | 宿主 `SubagentStartRequest` 无 cwd 字段 ⇒ 插件只能写进 prompt；要真正改 cwd 需设宿主会话/部署 cwd（宿主能力边界，非插件缺陷） |
| T028b | 宿主**不支持**运行期增删 MCP 实例 → 交付"声明式接入指引 + 环境模板 + serverName 校验"，已在面板与文档明确标注不支持 |
| T065 | a11y 已做最低要求（`label`/`htmlFor`/`aria-live`/`role="status"`/`tabIndex`/`type="button"`），未做完整合规审计 |
| S-09 | 单 session 多任务续跑仍为按需求归组的 one-shot run（`getRun(taskId)` 已暴露，便于后续升级） |

---

## 第八轮：安装到 web profile + 真实 TFS 端到端（2026-09-18）

### 关键事故与纠正（本轮核心）

插件「装上了但**一次 TFS 调用都发不出去**」，根因是**对宿主工具运行时的契约假设错误**：

| 项 | 早期假设（错） | 实测事实（对） |
|---|---|---|
| 工具调用 | `ctx.tools['mcp__<server>__<raw>'](args)`（像可调用属性） | `ctx.tools` 是 `ToolRuntime extends Service`，必须 `ctx.tools.execute({ callId, name, arguments, signal })` |
| 工具枚举 | `Object.keys(ctx.tools)` 过滤前缀 | 必须 `ctx.tools.schemas()` |
| 返回形状 | 工具直接回业务 JSON | 回 `ToolExecutionResult`，成功时 `value` 是 MCP 信封 `{ content: [{type:'text',text:'<json>'}] }`（tfs-mcp 未声明 `outputSchema`，恒无 `structuredContent`） |

证据（源码行号）：
- `@deepseek-ai/dsh-tools/src/index.ts:789`（`ToolRuntime extends Service`）、
  `:1043`（`register()` 只写内部 `layers`，**无 Proxy/defineProperty**）、
  `:404`（`get`）、`:452`（`schemas`）、`:1339`（`execute`）、`:309`（`ToolExecutionInput`）、
  `:555/:568`（成功/失败联合）。
- `@deepseek-ai/dsh-mcp-client/src/tools.ts:81`（`publicToolName` = `mcp__<server>__<raw>`，超 64 字符才加哈希）、
  `:288-305`（canonical `value = { content, structuredContent? }`）。
- `tfs-mcp/dist/index.js:1457-1464`（`content:[{type:'text',text:JSON.stringify(result,null,2)}]`）、
  `grep -c outputSchema` = **0**。

**第二处事故（同轮）**：`ctx.settings` / `ctx.subagents` / `ctx[dep]` 的**属性读取**会让 cordis
Proxy 抛 `cannot get property "X" without inject`（`vendor/cordis/lib/index.js:672-681`），
导致 `dsh web` 启动直接 `plugin tree failed to load`。修法：一律改 `ctx.get(name)`
（同文件 `:762-765` 明确实现为非抛出、未提供返回 `undefined`）。

### 交付修复

- `src/tfs/adapter.ts`：`TfsTools` 改为 `execute`/`schemas` 结构化子集；新增
  `unwrapToolValue()`（structuredContent → content 文本 → 裸载荷三级解包）、
  `failureText()`（解析 tfs-mcp 的 JSON 错误体取内层 message）、
  `nextCallId()`、`DEFAULT_CALL_TIMEOUT_MS = 120_000`（`AbortSignal` 兜底超时）。
- `src/index.ts`：`listTfsTools()` 改用 `ctx.tools.schemas()`。
- `src/host/settings.ts`：`ctx.get('settings')` + `typeof` 守卫。
- 测试基建：新增 `tests/helpers/fake-tools.ts`，桩**严格实现真实 `execute`/`schemas` 契约并回 MCP 信封**，
  使单测同时覆盖解包路径；`adapter.spec.ts` 重写并扩到 21 例（含超时/信封/结构化载荷/UNKNOWN_TOOL）。
- 文档契约纠正：`src/shared/contracts.ts`、`src/client/slots.tsx`、`src/tfs/adapter.ts` 头部。

### 门禁结果（第八轮）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `tsc -p tsconfig.host.json` / `tsconfig.client.json` / `tsconfig.tests.json` | **EXIT 0 ×3** |
| 测试 | `vitest run` | **21 文件 / 316 例全绿**（第七轮 307 → 本轮 +9） |
| 构建 | `tsc(host) + tsc(client) + tsdown` | **通过**（`lib/client.js` 119.97 kB / gzip 24.40 kB） |
| 真实链路 | `tsx scripts/real-chain.ts` | **通过**，TFS 写调用 = 0 |
| **真实安装启动** | `dsh --profile web`（隔离 `DSH_HOME`） | **插件树加载成功**，无 `plugin tree failed to load` |
| **真实插件路由** | `GET /tfs-requirment/health` | `ok=true`，`identity=zhangbo3(张波) <zhangbo3>`，`collection=WN_HIS`，`projectCount=48`，`tools.available` 齐全 |
| **真实业务数据** | `POST /tfs-requirment/requirements {keyword:'MEMORY',top:5}` | `ok=true`，`total=201`，返回真实工作项（#2019042 / #2013692 / #2019084 / #2013202…），耗时 3.4s |

⇒ **SC-002 的「宿主内以真实 PAT 跑通」已闭合**（HTTP 路由层已用真实 PAT 打通真实 TFS；剩余仅"人手在 UI 里点一遍"）。

### 真实环境暴露的 tfs-mcp 侧约束（不是插件缺陷，但影响可用性）

| 查询形状 | 真实结果 | 处理 |
|---|---|---|
| `keyword`（ASCII `CONTAINS`，如 `MEMORY`） | **可用**，201 条 / 3.87MB | 插件 16MB 熔断阈值内 ⇒ 正常返回（实测 3.4s） |
| 只传 `project`（无其它条件） | `MCP error -32001: Request timed out` | 插件生成的是**无 WHERE 子句**的全项目查询 ⇒ 面板"按项目筛选"在大项目上会超时 |
| `[System.TeamProject] = 'X'`（无条件） | `Failed request: (414)` | tfs-mcp 展开后 URL 过长 |
| `ChangedDate >= '...'` | 0 命中 → `items is not iterable (cannot read property null)`；有命中时可能 414 | 已由护栏 1 归一为**空列表**（不误报故障） |
| 传 `project` 参数 + 额外条件 | 实测被改写为更宽的查询（414），与不传该参数时行为不同 | **建议**：把项目下推进 `WHERE [System.TeamProject] = '…'`，不要用 `project` 参数 |

> **待办（本轮新发现，未实施）**：`RequirementFilter` 无时间窗字段，且 `{project}` 单独使用会生成
> 无 WHERE 查询。建议 (a) 项目下推 WHERE；(b) 增加 ChangedDate 窗口字段并把默认查询收窄到近 N 天。
> 该改动涉及 `contracts.ts` + 客户端 UI，须先取得一个"真实返回非空"的窄查询样本再落地（本轮只验到
> `keyword` 形状可用），避免再造未验证假设。

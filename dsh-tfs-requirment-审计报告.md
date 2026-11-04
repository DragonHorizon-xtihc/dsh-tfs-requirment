# dsh-tfs-requirment 插件深度审计报告

> 审计日期：2026-10-05　|　审计对象：
>
> `dsh-tfs-requirment@0.1.0`
> 插件根目录：
>
> `D:\ClaudeCode\deepseek-harness\plugins\dsh-tfs-requirment`
> 审计原则：
>
> **所有结论均基于真实运行证据（代码位置 + 运行命令 + 实测输出）**
>
> ，未做真实测试的内容明确标注为「环境阻塞」或「未验证」，不臆断。



***

## 0. 结论速览



| 编号 | 类别      | 严重度 | 问题                                                | 证据强度        |
| -- | ------- | --- | ------------------------------------------------- | ----------- |
| D1 | 功能缺陷    | 高   | 需求池列表「分页设计」错误：先全量 WIQL + 全量二次取字段，最后才 slice，大项目必超时 | 真实运行 + 对照修复 |
| D2 | 功能缺陷    | 高   | 空筛选（全集合）查询必 20s 超时；全集合实测 203 万工作项                 | 真实运行        |
| D3 | 部署 / 集成 | 高   | 开箱默认 `web` profile 无法启动（3 个实验包不兼容 / 缺失）           | 真实运行        |
| D4 | 设计缺陷    | 中   | 复用任务子会话无清理出口，无界残留，带历史上下文被复用                       | 代码 + 数据     |
| D5 | 设计缺陷    | 中   | 复用任务取消信号断链，本轮失控无法中断                               | 代码确证        |
| D6 | 设计缺陷    | 中   | 任务级执行轨迹不可隔离、统计虚高（单任务混入全部历史）                       | 真实运行        |
| D7 | 功能缺陷    | 中   | 无宿主会话时派发失败，且面板未前置阻断                               | 真实运行        |
| D8 | BUG     | 低   | 契约注释写 GET，实际仅 POST（GET→405）                       | 真实运行        |

**前置说明（避免误报）**：「多次派发返回相同 runId」「失败任务停留在 in\_progress」「子会话持久化」均为 spec 010 / 看板状态机的**有意设计**，本身不是随机 BUG；但这些设计**确实衍生出 D4/D5/D6 三个真实缺陷**，详见第 3 节。



***

## 1. 插件定位与测试方法

### 1.1 插件定位

TFS 需求驱动的任务看板插件，核心闭环：



```
TFS 需求（REST 直连）→ 拆解任务 → 按角色派发子智能体执行 → 回写 TFS（标签/状态/评论/关联）
```



* 全部 TFS 操作走 REST（`src/tfs/rest-client.ts`、`adapter.ts`），**不依赖 tfs-mcp**。

* 规模：`src/` 约 71 个源文件、`tests/` 约 61 个测试文件。

* 分层：`src/index.ts`（宿主半入口 / 装配）、`src/host/`（api 编排、route 约 39 个 HTTP 端点、board-service、orchestrator-session、parent-resolver、subagent-access、task-trace）、`src/core/board/`（看板引擎、任务状态机）、`src/tfs/`（适配层、REST 客户端、WIQL 构造、系统回写）、`src/write-guard/`（dryrun / 审计 / 幂等门禁）、`src/orchestration/`（dispatch、roles、role-match）、`src/client/`（React Web）。

### 1.2 测试方法（全部真实执行）



| 测试                 | 命令                                              | 结果                             |
| ------------------ | ----------------------------------------------- | ------------------------------ |
| 单元测试               | `npm test`（vitest run）                          | **61 文件 / 955 用例全部通过**（23.14s） |
| 构建                 | `npm run build`                                 | **成功**（client 421.7KB）         |
| 真实 Web（最小 profile） | `dsh --profile tfs-audit --no-open --port 3101` | 启动成功，真实派发                      |
| 真实 Web（默认 profile） | `dsh --profile web --no-open --port 3102`       | **启动失败（D3）**                   |
| 浏览器端到端             | computer\_use 打开 Chrome 访问 dsh web、创建会话、派发      | 子 agent 真实创建                   |
| TFS 裸接口对照          | node 直连 TFS REST（PAT）                           | 连通正常，单工作项 228ms                |

**环境阻塞（非插件 BUG）**：当前环境的 deepseek 与 arkcode 两条 LLM 路由密钥均无效（`AUTH / API 密钥无效`），因此「派发 → 子 agent 成功产出」的正向闭环无法在本环境完成。这是**环境问题**，不计入插件缺陷；但「派发 → 子 agent 真实创建（非假执行）」已通过 HTTP 返回、看板状态、会话文件三层证据确认。



***

## 2. 功能缺陷（高优先级）

### D1 需求池列表「分页设计」错误：大项目必超时

**机制**：列表请求的处理顺序是：



1. 构造 WIQL 并一次性拉取**全部命中 id**（`adapter.ts:1627`）；

2. `wiqlFetchByIds` 按 **每批 200 个 id 串行**调用 `getWorkItems` 取字段（`adapter.ts:1743-1746`）；

3. 直到 `adapter.ts:1663-1665` 才做 `skip/top` 切片。



```
// adapter.ts:1743-1746  —— 对全部 id 串行取字段
for (let i = 0; i < ids.length; i += 200) {
  const rows = await read.getWorkItems(ids.slice(i, i + 200), WIQL_FETCH_FIELDS)
  ...
}
// adapter.ts:1663-1665 —— 分页在最后
const skip = Math.max(0, Math.trunc(num(filter.skip)))
const top  = Math.max(1, Math.trunc(num(filter.top) || 20))
return { ok: true, items: all.slice(skip, skip + top), total: all.length }
```

**复现（通过插件，项目 = 体检管理）**：



```
命令：node node-project.mjs
输出：指定项目(体检管理) HTTP 200 60228ms ok=false items=0 total=undefined
```

**根因对照实验（绕过插件，直连 TFS）**：



```
命令：node node-fixproof.mjs
输出：
  WIQL: 1880ms 命中=40275
  只取前20: HTTP 200 72ms 取到=20
  修复路径总耗时: 1952ms
```

> 即：体检管理项目命中 40275 个工作项，插件因此串行约 
>
> `40275/200 ≈ 202`
>
>  次 REST 调用，60s 超时；而 WIQL 已按 
>
> `ChangedDate DESC`
>
>  排序，
>
> **只需对当前页 20 个 id 取一次字段，总耗时约 1.95s**
>
> 。性能差距约 30 倍。

**影响**：用户只要选了一个工作项较多的项目，需求池就永远转圈打不开；top / 分页参数形同虚设。

**修复建议**：WIQL 拿到 id 后，先按 `skip/top` 截断 id 列表，再对当前页 id 二次取字段（把分页逻辑从 `wiqlFetchByIds` 之后前移到之前）。



***

### D2 空筛选（全集合）查询必 20s 超时

**机制**：当筛选条件全部为空时，`where` 数组为空，生成的 WIQL 没有任何收窄条件（`adapter.ts:1615-1618`）：



```
const query =
  `SELECT [System.Id] FROM WorkItems` +
  (where.length ? ` WHERE ${where.join(' AND ')}` : '') +   // 空 filter → 无 WHERE
  ` ORDER BY [System.ChangedDate] DESC`
```

REST 客户端超时固定为 20 秒（`rest-client.ts:38`：`DEFAULT_REST_TIMEOUT_MS = 20_000`）。

**复现（空 body）**：



```
命令：node node-emptyfilter.mjs
输出：
  [空filter {}] HTTP 200 20022ms ok=false items=0
     reason: 需求列表查询失败（TFS REST）：... 网络错误：This operation was aborted
```

**根因（直连 TFS 实测全集合规模）**：



```
命令：node node-allwiql.mjs
输出：全集合 WIQL HTTP 200 63578ms 命中=2037933
```

> 该集合实际有 
>
> **203 万**
>
> 个工作项，仅返回 id 列表就需要 63 秒；插件 20s 超时必然 abort，因此「清空全部筛选」时需求列表
>
> **必然失败**
>
> 。

**WIQL 不支持 TOP 子句**（排除了在查询语句层直接限量的可能）：



```
命令：node node-topwiql.mjs
输出：[SELECT TOP 20] HTTP 400 235ms
  TF51006: 该查询语句中缺少 FROM 子句。 该错误是由"20"引起的。
```

**影响**：清空筛选 / 首次打开未带任何条件时无法获取需求。

**修复建议**：



1. 强制 / 默认至少一个收窄条件 —— 默认仅查询「最近 N 天变更」或要求指定项目；

2. 配合 D1 的「只取当前页 id」；

3. 空 filter 时在前端直接拦截并给出可读提示，而不是发起一个注定 20s 超时的请求。



***

### D3 开箱默认 `web` profile 无法启动

**复现**：



```
命令：dsh --profile web --no-open --port 3102
结果：加载约 99 秒后崩溃，exit code 1
```

**实测错误（3 个，均为模块加载失败）**：



```
1. loader entry agent-team (@deepseek-ai/dsh-experimental-agent-team):
   The requested module '@deepseek-ai/dsh-subagent/internal' does not provide an export named
   'steerHostSubagentPrompt'
   （实验包 lib/index.js:7: import { steerHostSubagentPrompt } from "@deepseek-ai/dsh-subagent/internal"）

2. loader entry tool-agent-team (@deepseek-ai/dsh-experimental-tool-agent-team):
   同上，steerHostSubagentPrompt 导出不存在

3. loader entry preset-standard-antiguess (@deepseek-ai/dsh-agent-preset):
   Cannot find package '@deepseek-ai/dsh-agent-preset' imported from C:\Users\user\.dsh\profiles\web\
```

**责任边界（重要）**：这不是 dsh-tfs-requirment 的直接代码 BUG—— 该插件的 `peerDependencies` 只引用标准包（dsh-subagent、dsh-workflow、dsh-session 等），**未引用任何 experimental 包**。根因是默认 `web` profile 的 `bundles` 同时装入了 `dsh-experimental-agent-team-profile@0.1.7-alpha.2`（其依赖 dsh-experimental-agent-team /tool-agent-team 引用了宿主 dsh 0.2.0 已移除的内部导出 `steerHostSubagentPrompt`），并引用了缺失的 `dsh-agent-preset`。

**但从用户视角**：默认 profile 与 dsh-tfs-requirment 同时装配后，整个 dsh web 起不来，插件无法使用 —— 属于必须修复的**部署 / 集成缺陷**。

**修复建议**：从默认 profile 的 `bundles` 移除不兼容的 `dsh-experimental-agent-team-profile`（或升级到与宿主 0.2.0 兼容的版本），并补齐 / 移除 `dsh-agent-preset` 引用。最小可用 profile 见 `tfs-audit`（仅 dsh-base + dsh-web-app + dsh-tfs-requirment，验证可启动）。



***

### D7 无宿主会话时派发失败，且面板未前置阻断

**复现（全新实例，不创建任何会话直接派发）**：



```
命令：dsh --profile tfs-audit --no-open --port 3103  然后 node node-nosession.mjs
输出：
  无会话派发 HTTP 200
  {"ok":false,"reason":"派发前置条件不满足：无法获取可用的宿主 Agent 会话（既不在 agent 调用链上，
   注册表里也没有存活的顶层会话）。请先在 DSH 中打开一个会话，再从「工作台」派发任务"}
```

**代码层面**：`parent-resolver.ts` 的三级降级（currentInitiator → 捕获最近活跃顶层 Agent → roots 兜底）在 Web 刚启动、无会话时全部落空。客户端 `slots.tsx` 的 dispatch 直接调用后端，**派发前未检查会话是否存在、未禁用派发按钮**。

**影响**：用户必须先点派发、再读错误，才能知道要先开会话；错误文案本身可读，但缺少前置引导。

**修复建议**：面板加载时检测宿主会话可用性，无会话时禁用派发按钮并就地引导「先打开会话」。



***

## 3. 设计缺陷：任务子会话复用机制（spec 010）的副作用

### 背景：runId 重复是「有意复用」，不是随机 BUG

`api.ts:754` 先 `orchestrator.ensure(requirementKey)` 建立编排主会话；随后 `launchRun`（`api.ts:1008-1011`）在命中 `reuseTaskSessions && mode==='continuable'` 时走**复用路径**（`orchestrator-session.ts:658 launchReusedTask`），**不经过 RequirementDispatcher**。

复用键（`orchestrator-session.ts:659`）：



```
const reuseKey = `${input.requirementId}|${input.role.provider}|${input.role.preset ?? ''}`
// 首次：startContinuable 新建并 putTaskSession；之后同键：sendMessage 续投同一子会话
```

**复现 runId 重复**：



```
命令：node node-runid.mjs（串行派发 3 个不同任务）
输出：
  #1 taskId=...174057 runId=1b783a05-3c74-466e-b6b4-159f85fff6d7
  #2 taskId=...174105 runId=1b783a05-3c74-466e-b6b4-159f85fff6d7
  #3 taskId=...174108 runId=1b783a05-3c74-466e-b6b4-159f85fff6d7
  all identical? true
```

> 该机制有 FIFO 串行锁（
>
> `acquireReuseTurn`
>
> ，
>
> `orchestrator-session.ts:732-753`
>
> ），保证同键任务排队、不会并发交错 —— 这部分设计正确。
>
> **但它带来了下面三个真实缺陷。**



***

### D6 任务级执行轨迹不可隔离、统计虚高

**机制**：`task-trace.ts` 取 `attempt.runId`（:90），然后对该 id 调用 `observeSession`（:102）。复用模式下该 id 是**整个持久子会话**，包含所有历史任务的事件：



```
const runId = attempt.runId                                  // :90
obs = await sessionQuery.observeSession(runId, { projectionMode: 'none' })  // :102
```

**复现（派发一个新任务后查询该任务的轨迹）**：



```
命令：node node-trace.mjs
输出：
  trace available: true source: prepared
  entries 中「连通性测试」出现次数: 11      ← 11 个历史任务的 prompt 串入
  entries 中「本次标记」出现次数: 1
  total entries: 42
  stats: {"modelRequests":13,"turns":13,"userInputs":16}
```

> 单个新任务本应只有约 1 次模型请求、1 轮、1 次输入、几条轨迹；实际却返回整个子会话的 42 条事件、11 个历史 prompt、13/13/16 的虚高统计。

**影响**：用户无法查看单个任务的真实执行过程，也无法审计单个任务的 token / 调用开销。

**修复建议**：为每轮复用记录「起始 / 结束事件游标」，task-trace 仅返回该任务 `[startCursor, endCursor]` 区间内的事件并据此统计，而非整会话。



***

### D5 复用任务取消信号断链、本轮无法中断

**机制**：看板的取消钩子是（`index.ts:424`）：



```
cancelRun: taskId => dispatcher.cancel(taskId)
```

但复用路径不经过 `RequirementDispatcher`，`dispatcher.cancel` 在 `activeRuns` 中找不到该任务（`dispatch.ts:568-584`）：



```
async cancel(taskId) {
  const active = this.activeRuns.get(taskId)
  if (!active) {            // 复用任务不在此表
    this.forget(taskId)
    return                  // 仅清追踪键，不 abort / 不 dispose
  }
  active.controller.abort(); disposeRun(active.run); active.releaseSlot(); ...
}
```

复用路径内部使用的是 `launchReusedTask` 里的**局部 AbortController**（`orchestrator-session.ts:679`），该控制器既不注册给 dispatcher，也没有暴露给任何外部取消入口。

**影响**：复用任务本轮若失控（死循环），用户点「取消」无法停止，只能等待 `taskSettleTimeoutMs` 观测超时。子会话本身持久、不应销毁是正确的，但「本轮无法中断」是真实功能缺陷。

**修复建议**：复用路径同样登记一个可由外部触发的取消句柄（任务级，而非销毁持久子会话），使取消能 abort 本轮观测并释放并发槽。



***

### D4 复用子会话无清理出口、无界残留

**机制**：



* 39 个端点中**没有「删除需求」端点**（只有 restore/update/exec-state/enrich/write-back）。

* `task-delete` 只删看板任务：`board-service.ts:611-635 deleteTasks` 不清理 `taskSessions` 登记、不 dispose 子会话。

* 看板引擎里 `taskSessions` **只有 get/put、没有 delete/clear**：`board.ts:1067`（get）、`board.ts:1082`（put）；`board.ts:262-283 deleteTasks` 仅删 `state.tasks`。

**实测数据（**`node node-orch.mjs`**）**：



```
需求 2004154@WN_HIS
  mode: continuable
  orchestratorSessionId: 9b02c7f0-6aa8-44dd-af7a-358c35095818
  parentSessionId: session-38c2ced7-207f-45b0-b5e5-e874bb71e681
  taskSessions: {"2004154@WN_HIS|spawn|standard-antiguess":"1b783a05-3c74-466e-b6b4-159f85fff6d7"}
```

**影响**：每个 `需求 | provider | preset` 组合的子会话永久残留在 `C:\Users\user\.dsh\sessions`，并带着历史任务上下文被后续任务复用，无任何清理途径；长期运行会无界累积。

**修复建议**：



1. 提供「删除需求 / 重置需求编排」端点，级联清理 taskSessions 登记并 dispose 对应子会话；

2. 为 `taskSessions` 增加 delete/clear 原语；

3. 可对长期未使用的子会话设置生命周期回收策略。



***

## 4. BUG（低优先级）

### D8 契约注释写 GET，实际仅 POST

**代码位置**：



* `shared/contracts.ts:606`：`/** GET 需求池列表（US2）。 */ requirements: '/tfs-requirment/requirements'`

* `host/route.ts:100-104`：非 POST 即返回 405：



```
if (req.method !== 'POST') {
  res.setHeader('allow', 'POST')
  sendError(res, 405, '仅支持 POST')
  return
}
```

**复现**：



```
命令：node node-getreq2.mjs（GET） / node node-methods.mjs（POST、无 cookie）
输出：
  GET  /requirements => 405 | allow: POST | body: {"error":"仅支持 POST"}
  POST /requirements => 200
  POST /requirements (no cookie) => 401
```

**影响**：共享契约注释误导后续开发者（文档与实现不一致）；同时也说明该接口的鉴权设计正确（无 Cookie → 401）。

**修复建议**：将 `contracts.ts:606` 注释改为 `/** POST 需求池列表（body=RequirementFilter）。 */`。



***

## 5. 非缺陷澄清（避免误报）

以下现象经真实测试确认是**有意设计**，不应作为 BUG 上报：



| 现象                    | 真相                                                  | 证据                                                                            |
| --------------------- | --------------------------------------------------- | ----------------------------------------------------------------------------- |
| 多次派发返回相同 runId        | spec 010 任务子会话复用，同复用键续投同一持久子会话                      | node-runid.mjs（all identical true）                                            |
| 失败任务停留在 `in_progress` | 看板状态机有意：failed 保留 in\_progress 以便重试 S-07            | `board.ts:597-599`：success→completed，failed→保留 in\_progress，cancelled→deleted |
| 子会话持久化、不随任务销毁         | continuable 复用前提                                    | orchestrator-session.ts                                                       |
| 同复用键并发                | FIFO 串行锁正确处理，不会消息交错                                 | `orchestrator-session.ts:732-753 acquireReuseTurn`                            |
| 鉴权                    | 无 Cookie 一律 401，Cookie 为 HttpOnly + SameSite=Strict | node-methods.mjs                                                              |
| 集合名当项目名               | WN\_HIS 是集合，不是项目；传入必 400                            | 真实返回「在层次结构中找不到指定的项目…'WN\_HIS'」                                                |



***

## 6. 环境阻塞项（非插件缺陷，但影响闭环验证）



1. **LLM 密钥无效**：deepseek 与 arkcode 两条路由均 `AUTH / API 密钥无效`，「派发 → 子 agent 成功产出」正向闭环无法验证。已确认的是：派发前置检查、parent 解析、子 agent 真实创建（HTTP 返回 createdTask、看板状态、会话文件三层证据）均正常。**提供有效 LLM 密钥后即可补测正向闭环。**

2. **有副作用的写操作未做真实测试**：claim（真实打 TFS 标签）、decompose、task-assign、task-update、角色 /profile CRUD、集合切换等，因会修改真实 TFS 数据、且需选择可恢复对象，本次未执行。



***

## 7. 修复优先级建议



| 优先级 | 项                                   | 工作量                |
| --- | ----------------------------------- | ------------------ |
| P0  | D3：移除 / 升级默认 profile 不兼容实验包，恢复开箱可启动 | 小（改 profile 配置）    |
| P0  | D1：分页前移，只对当前页 id 取字段                | 小（改 adapter 取字段顺序） |
| P0  | D2：默认 / 强制收窄 filter，空 filter 前置拦截   | 中（前后端各一处）          |
| P1  | D5：复用任务登记可外部触发的本轮取消句柄               | 中                  |
| P1  | D6：task-trace 按事件游标区间隔离与统计          | 中                  |
| P1  | D4：新增删除 / 重置需求端点，级联清理子会话            | 中                  |
| P2  | D7：无会话时禁用派发按钮并引导                    | 小                  |
| P2  | D8：修正契约注释                           | 极小                 |



***

## 8. 证据脚本清单（可复现）

位于插件根目录：



| 脚本                                                               | 用途                                   |
| ---------------------------------------------------------------- | ------------------------------------ |
| `node-runid.mjs`                                                 | 复用 runId 重复（含 cancel/delete 清理）      |
| `node-trace.mjs`                                                 | 轨迹串 / 统计虚高（含清理）                      |
| `node-project.mjs` / `node-fixproof.mjs`                         | D1 分页缺陷 + 修复对照                       |
| `node-emptyfilter.mjs` / `node-allwiql.mjs` / `node-topwiql.mjs` | D2 空 filter 超时、全集合规模、TOP 不支持         |
| `node-nosession.mjs`                                             | D7 无会话派发失败                           |
| `node-getreq2.mjs` / `node-methods.mjs`                          | D8 GET 405 / POST 200 / 无 cookie 401 |
| `node-orch.mjs` / `node-listtasks.mjs`                           | board 编排登记与任务清单                      |
| `node-tfsconn.mjs` / `node-wiql-direct.mjs`                      | TFS 连通性与裸 WIQL 对照                    |
| `audit-unittest.log` / `audit-build.log`                         | 955 用例通过 / 构建成功日志                    |

> 审计结束后，看板已恢复到 13 个已完成任务的基线，探针任务全部清理。

---

# 9. 修复与真实验证结果（2026-10-05）

本章所有结论均基于**真实运行**（vitest / tsc+tsdown / HTTP / 浏览器），不以代码推断代替验证。

## 9.1 验证总览（全部真实执行）

| 验证动作 | 结果 |
| --- | --- |
| 全量单元测试 `npm test` | **63 文件 / 982 用例全部通过**，exit 0，Duration 27.61s |
| 构建 `npm run build` | tsc(host)+tsc(client)+tsdown 全部成功，exit 0；`lib/client.js` 427.31 kB（gzip 108.75 kB） |
| 默认 `dsh web`（http://127.0.0.1:3080） | 真实浏览器端到端闭环通过（入口→Workbench→关闭） |
| 干净对照实例 tfs-audit（http://127.0.0.1:3101） | 真实浏览器端到端闭环通过 |

## 9.2 逐项修复与验证

| 缺陷 | 原因级修复（落盘文件） | 真实验证 | 状态 |
| --- | --- | --- | --- |
| **D1** 分页设计错误、大项目必超时 | `src/tfs/adapter.ts` 改为有界分页/游标 + 超时熔断，不再一次性拉全量 | HTTP 真实复验：首页 3.4s、次页 4.5s 返回；`pagination.spec.ts` 6 用例 | 已修复（HTTP+单测） |
| **D2** 空筛选全集合扫描 20s 超时 | `src/tfs/adapter.ts` 空 filter 前置校验，直接返回 `ok=false`+明确 `reason`，不发起全集合 WIQL | HTTP 复验：112ms 返回 `ok=false/items=0`；`health.spec.ts` 等 | 已修复（HTTP+单测） |
| **D3** 默认 web profile 无法启动 | profile `cordis.patch.yml` 删除致命 preset `insert` 块（备份 `.bak-preset-entry-fix-20261005`） | 3080 真实启动成功并完整渲染 | 已修复（真实启动） |
| **D4** 复用子会话无清理出口、无界残留 | `src/host/subagent-access.ts` 增加 `drainRequirementSessions`/`drainChildrenOn` 对称清理 | `tests/d4-d7-fixes.spec.ts` 覆盖清理路径 | 已修复（单测；在线清理见 9.3） |
| **D5** 复用任务取消信号断链 | `src/host/orchestrator-session.ts` 增加 `cancelReusedTask`/`interruptChildOn`，取消信号贯通复用 runId | `d4-d7-fixes.spec.ts` 覆盖中断路径 | 已修复（单测；在线取消见 9.3） |
| **D6** 任务级轨迹不可隔离、统计虚高 | `src/host/trace-mapper.ts`/`task-trace.ts` 增加 `filterEventsForTurn`，按 turn 切片隔离 | `d4-d7-fixes.spec.ts` 三轮切片断言 | 已修复（单测；HTTP 见 9.3） |
| **D7** 无宿主会话派发失败且未前置阻断 | `src/host/board-service.ts` `gateProbeByParent` 三分支门控；客户端派发按钮无会话时 `disabled`+title 提示 | `d4-d7-fixes.spec.ts` 三分支；Workbench 真实可开 | 已修复（单测+UI 挂载；disabled 视觉见 9.3） |
| **D8** 契约写 GET、实际仅 POST | `src/shared/contracts.ts` 契约文档更正为 POST | HTTP 实测：GET 405 / POST 200 / 无 cookie 401 | 已修复（HTTP） |

## 9.3 审计外发现并修复：客户端在当前宿主「零挂载」

审计闭环阶段另定位到一个阻断性客户端缺陷（任务 #10）：

- **根因**：TFS 客户端为更新宿主（0.1.5–0.2.0，slot 名 `main` / `sidebar.panellist` / `sidebar.right.*`、服务 `configForms`/`sidebarRightTabs`）编写；而当前实际宿主（全局 dsh 0.1.2-alpha.5 内嵌）只有更简单的一套 slot——root 下 `sidebar`/`conversation`/`details`/`shell.overlay`，sidebar 下含 `sidebar.footer.action`，**完全没有** `main`/`sidebar.panellist`/`sidebar.right.*`。`slots.inject(slotName, factory)` 仅在该 slot 已被宿主声明时才执行 factory，故 TFS 在干净环境无任何挂载点。
- **修复**（同时保留新版 main/panellist/右栏注册，当前宿主不触发、跨版本安全）：
  - 新建 `src/shared/panel-open-control.ts`：`PanelOpenControl`（getSnapshot/subscribe/show/hide，对齐 `useSyncExternalStore`；show/hide 与退订均幂等）。
  - `src/client/slots.tsx`：新增 `TfsFooterEntry`（`sidebar.footer.action` 图标按钮，onClick→show）与 `TfsOverlayEntry`（`shell.overlay`，订阅开关；关闭时返回 `null` 不盖屏，打开时渲染遮罩+居中大面板包裹 Workbench，点遮罩/关闭/Esc→hide）。
- **真实验证**：3080 与 3101 的 footer 均真实出现「TFS 看板」按钮（位于「添加工作区」与「设置/余额」之间）→ 点击打开 shell.overlay 全屏 Workbench（需求池/任务中心 13/筛选器/本地池 3 条/执行配置/角色管理/连接与凭据）→ 点关闭返回主界面、遮罩移除；`tests/panel-open-control.spec.ts` 8 用例通过。

## 9.4 默认 web「boot fail-loud」止血（环境/第三方兼容，非 TFS 本体缺陷）

- **现象**：3080 根页原显示 `Failed to load plugins: web boot: 4 entries did not activate`。dsh-app-boot 的 `assertEntriesActivated` 在整个 loader tree settle 后审计，任一 enabled entry 处于 PENDING 即 throw，连累已下载的 TFS。
- **缺失服务**：`dsh-chat-import` 等待 `sidebarRightTabs`；`@linxin666/dsh-pet`、`dsh-client-ui-skin-center`、`dsh-client-ui-task-board` 等待 `configForms`（当前宿主均未提供）。
- **关键排查**：patch 按 cordis loader 的 **entry id** 匹配（错误页文案用的是 `options.name` 即包名，不能当 id）。逐包读各 bundle 的 `cordis.patch.yml` 核实真实 entry id 后，在 profile `cordis.patch.yml` 末尾按 id 禁用 5 条：`import-claude`、`web-ui-pet`、`web-ui-skin-center`、`ui-task-board`、`web-ui-task-board`（备份 `.bak-thirdparty-entry-fix-20261005`）。
- **真实验证**：重启 3080 后主界面完整恢复（工作区列表/余额/上下文洞察/设置/Agents），TFS 看板按钮出现并完整开/关闭环。
- 升级到提供 `configForms`/`sidebarRightTabs` 的宿主版本后，删除该禁用段即可恢复这些第三方插件。

## 9.5 未完成的在线验证（环境限制，非插件缺陷，如实披露）

- **LLM 路由密钥无效**：deepseek / arkcode 两条路由密钥均返回 AUTH 失败（3080 输入框提示「当前模型不可用，请先选择模型」）。因此「派发→成功产出」正向闭环，以及 D4 在线清理、D5 运行中任务在线取消、D6 task-trace 的 HTTP 在线复验，均无法在真实派发中完成。
  - 替代证据：原因级补丁 + 机制回归单测（`d4-d7` 19 用例 + `panel-open-control` 8 用例）+ build 通过 + D1/D2/D8 真实 HTTP 复验 + 双实例 UI 挂载/开关闭环。
- **D7 disabled 视觉**：当前看板基线 3 需求已全部入池/完成，需求池无未入池候选行，故「无会话时派发按钮 disabled + title」未能截图；其门控机制已有三分支单测，派发按钮代码已落盘。
- **TFS 写操作**：claim/decompose 等会改动看板数据，无授权未执行；本轮仅做只读 WIQL/拉取。
- 待 LLM 密钥恢复后，应补一次真实派发在线闭环，以把 D4/D5/D6/D7 的在线项从「单测/挂载已验证」升级为「端到端已验证」。
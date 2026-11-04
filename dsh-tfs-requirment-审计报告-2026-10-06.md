# dsh-tfs-requirment 插件深度审计与修复报告（2026-10-06）

> 审计对象：`dsh-tfs-requirment@0.1.0`
> 根目录：`D:\ClaudeCode\deepseek-harness\plugins\dsh-tfs-requirment`
> 原则：**每条结论都必须有运行证据**（代码位置 + 运行命令 + 实测输出）。
> 推断不作为结论；构造不出来的复现，如实标注为「未复现」，并说明为什么。

---

## 0. 结论速览

| 编号 | 类别 | 严重度 | 问题 | 证据 |
|---|---|---|---|---|
| B1 | 功能缺陷 | **高** | 删除已取消任务后，需求被封存进「已完成」页，但收口钩子**一次都不触发** ⇒ 结论评论/字段回写/附件/自动链全部静默跳过 | 真实组件演练实测：封存 `completed`，钩子 `[]` |
| B2 | 功能缺陷 | **高** | 「重取需求正文」抹掉本地字段 `orchestration` / `writeBack` ⇒ 编排会话变孤儿、回写幂等账本丢失（会重复追加 TFS 评论/附件） | 实测：enrich 后两字段 `undefined` |
| B3 | 设计缺陷 | 中 | `finalize` 未走串行 gate，与后台 `summarize` 抢同一 childId ⇒ 一次落定广播给两边，归纳结论与最终总结串台 | 实测：同一 childId 等待者数 `2` |
| B6 | 功能缺陷 | 中 | `removeTags` 只为读 `System.Tags` 却拉全字段+全 relations（实测单条可达 3.3MB） | 实测：请求 URL 无 `fields=` |
| M1 | 设计缺陷 | 中 | 已完成任务 UI 无任何出口 ⇒ 「还原到需求池」对含已完成任务的需求**永久不可达**（死结） | 代码 + 引擎门禁实测 |
| M2 | 设计缺陷 | 中 | `setOrchestration` 整对象替换 + 跨 await 陈旧读 ⇒ 并发登记的 `taskSessions` 被覆盖，会话复用静默失效 | 回归用例（回退即红） |
| H1 | BUG | 中 | 需求池分页 total 用全量、切片用过滤后集合 ⇒ 页码/计数文案与实际内容三者错位 | 纯函数实测：第16页显示第15页 |
| M3 | 功能缺陷 | 中 | 还原需求时只释放 `taskSessions`，漏掉 `orchestratorSessionId` ⇒ 编排主会话永久存活 | 代码 + D4 修复不完整 |
| B5 | BUG | 中 | 39 个端点中唯一缺 rejection 分支的 handler ⇒ 失败时请求**永久挂起** + unhandled rejection | 回归用例（回退即红） |
| B4 | 功能缺陷 | 轻 | 复用派发失败被空 `catch` 吞掉，注释承诺「记事件」却什么都没记 | 代码确证 |
| L1 | 设计缺陷 | 轻 | 看板「全空闲停拍」契约被破坏：空闲+后台标签页 ⇒ 永久 15s 轮询 | 代码确证 |
| L3 | 功能缺陷 | 轻 | 手动/后台重采绕过告警摘取 ⇒ 运行期宿主失联在需求池/任务中心页无任何提示 | 代码确证 |

**修复后验证**：单测 **1013 通过**（65 文件）、`typecheck` 全绿、构建成功、离线演练 **27/27**、缺陷演练 **11/11**、真实宿主 HTTP **6/6**、真实浏览器 **6/6**。

---

## 1. 基线（先证现状，不依赖历史报告）

| 动作 | 命令 | 结果 |
|---|---|---|
| 全量单测 | `npm test` | **64 文件 / 1000 用例全部通过**（修复前基线） |
| 离线端到端演练 | `scripts/e2e-004.ts` | **27 项断言，失败 0** |

上一轮（2026-10-05）的 8 项缺陷（D1–D8）我逐条复核：D1/D2/D8 在真实 HTTP 下确认已修复（见 §5），D3/D4/D5/D6/D7 的机制修复已在代码中，但 **D4 不完整**（漏 `orchestratorSessionId`，即本报告 M3）。

---

## 2. 严重缺陷

### B1 删除已取消任务 ⇒ 需求封存但收口钩子永不触发

**代码**：`src/host/board-service.ts:626-637`（修复前）

```ts
const deleted = this.deps.board.deleteTasks(taskIds)   // 引擎物理删除：delete state.tasks[id]
...
const sealed = this.sealRequirementIfAllDone(key)
if (!sealed) continue
const last = taskIds.find(id => this.deps.board.snapshot.tasks[id]?.requirementId === key)
if (last === undefined) continue        // ← 删除之后才查，恒为 undefined
this.afterTaskSettled({ taskId: last, ... })
```

`Board.deleteTasks`（`board.ts:277`）是 `delete this.state.tasks[id]`（物理删除，不是标 `deleted`），
所以在删除之后去快照里找被删的 id，必然 `undefined` ⇒ `afterTaskSettled` **不可达**。

**同文件 `setTaskState` 的 cancel 分支（1270-1273）已经正确实现**（用的是仍存在的 `taskId`）——
这说明是删除路径的疏漏，而非设计意图；该方法自己的注释（629-632）也明确警告了后果。

**实测（真实 Board + BoardService + 真实 fs）**：

```
删除后引擎原始 execState: completed          ← 需求确实被封存
删除后钩子调用: []                            ← 但收口钩子 0 次
```

后果：需求进了「已完成」页，却没有结论评论、没有评审/自测字段、没有附件、没有子任务归位，
自动链式也不再推进。

**修复**：删除**前**为每个需求留一个"删除后仍存活"的代表任务（优先取仍存活且 `completed` 的），
删除后用该 id 触发钩子。修后实测：

```
删除后钩子调用: [{"taskId":"990101@WN_HIS#analyze","outcome":"success"}]
```

---

### B2 重取需求正文抹掉本地字段 orchestration / writeBack

**代码**：`src/host/board-service.ts:966-974`（修复前）只搬了 4 个本地字段，
而 `Board.updateRequirement`（`board.ts:156`）是**整对象替换**，`summaryToRequirement()` 又不含
`orchestration` / `writeBack`。

**实测**：

```
enrich 前 orchestration: {"mode":"continuable","orchestratorSessionId":"child-ORCH-1",...}
enrich 前 writeBack:     {"items":[{"kind":"comment",...}]}
enrich 后 orchestration: undefined
enrich 后 writeBack:     undefined
```

后果：① 下次 `ensure` 判定为未编排，再建一个 continuable 主会话，旧会话成孤儿、永久占宿主会话资源；
`taskSessions` 一并丢失 ⇒ spec 010 的会话复用（AC3.3）失效。② 回写报告是 finalizer 的幂等账本，
丢了之后重跑会把结论评论/附件**重复追加**到 TFS。

**修复**：改为按显式清单搬运（新增 `LOCAL_REQUIREMENT_FIELDS`），清单含
`workspace / prompt / execState / completedAt / orchestration / writeBack / revision`，
并由回归用例守住"不得混入纯 TFS 字段"。

---

## 3. 中等缺陷

### B3 finalize 未串行化 ⇒ 与后台 summarize 抢同一 childId

`summarize`（`orchestrator-session.ts:589`）持有 `acquireReuseTurn('orchestrator|<key>')`，
`finalize`（660）**没有**。两者打的是**同一个** `orchestratorSessionId`，而
`ChildSettleWatcher.settle()`（`orchestrator-session.ts:243`）是**按 childId 广播**给全部等待者。

`api.ts:1967` 的真实时序是「归纳宽限 20s 到点即刻放行」，此时 `summarize` 可能仍在后台等待落定，
`finalize` 随即跟上并挂到同一 childId ⇒ 一次落定同时交给两边。

**实测**：

```
只调 summarize 时该 childId 的等待者数: 1
再调 finalize 后该 childId 的等待者数: 2     ← 未被 gate 挡住
```

修复后：`1`（finalize 在 gate 里排队）。同时补 `finally { ac.abort() }`，
修掉错误路径下 `waitForChildSettle` 的定时器与兜底轮询 interval 无人清理的泄漏。

### B6 removeTags 为读一个标签拉整个工作项

`adapter.ts:2659` 用 `read.getWorkItem(id)`（不带 `fields`），而同文件的 `readCurrentTags()`
（3049）早已用 `fields: ['System.Tags']`。实测请求：
`.../workitems/1?api-version=4.1`（无 `fields=`）⇒ 全字段 + 全部 relations。
修后：`.../workitems/1?fields=System.Tags&api-version=4.1`。

### M1 已完成任务无出口 ⇒ 还原需求池死结

`actionsFor()`（`TaskCenter.tsx:172-183`）对 `completed` 返回 `[]`，
而引擎 `TASK_TRANSITIONS.completed = ['deleted']` 是**允许**撤销的；
`Board.restoreRequirement`（`board.ts:307`）要求名下无非 `deleted` 任务，
UI 的按钮又是 `disabled={activeCount > 0}` ⇒ 跑完任务的需求永远还原不回去。

**修复**：给 `completed` 暴露 `cancel`（文案按状态显示「撤销完成」，避免被误认为丢弃产出）。

### M2 setOrchestration 覆盖并发登记的 taskSessions

`ensureOnce` 在 491 行读 `existing`，中间隔着 512（探活）与 547（创建会话）两个 `await`，
567 行整对象写回时仍用 491 行的陈旧 `taskSessions`。期间 `putTaskSession` 登记的复用键被覆盖。
这与同文件 `mergeIntoBrief` 已修并注明纪律的是同一个坑。

**修复**：写回前重读。回归用例在回退修复后即红。

### H1 需求池分页口径不一致

`usePagination(items.length)` 算页数，`paginate(visibleItems)` 切过滤后数组。
`paginateSlice` 内部会按 `visibleItems.length` 再夹一次 ⇒ 分页栏仍显示 25 页、仍高亮第 16 页、
「第 301–320 条 / 共 500 条」照算，列表里却是第 15 页内容。**页码、计数文案、实际内容三者错位**，
用户点第 20 页看到第 15 页的数据却无从察觉。（默认每页 20、上限 500 条时必现。）

**修复**：把过滤提到分页之前，total 与切片同源；切换「仅看未入池」时 `resetPage()`。

### M3 还原需求漏释放编排主会话

`restoreRequirement`（`board-service.ts:914`）只收 `taskSessions` 的值，
漏掉同级的 `orchestratorSessionId`（同样是 `startContinuableOn` 建的持久子会话）⇒ D4 的漏网之鱼。

### B5 exec-state 端点是全文件唯一缺 rejection 分支的 handler

`route.ts:309` 曾是单参 `.then(result => sendJson(...))`。同文件其余 fire-and-forget handler
一律两参；而 handler 已返回，`web-guard` 的 try/catch 看不到这个 Promise 的 rejection
⇒ 客户端请求**永久挂起**（无状态码），宿主日志只剩一条 unhandled rejection。
**修复**：补 `error => sendRouteError(res, error)`。

---

## 4. 轻缺陷

- **B4** `api.ts:1055` 复用派发失败是空 `catch`，而上方注释明确承诺"记事件并回退"。
  修：记下原因并写入任务编排上下文（新增 `TaskOrchestration.fallbackReason`），随 board.json 落盘。
- **L1** `board-store.ts delayFor()` 把 `document.hidden` / 不可用分支排在空闲判定**之前**，
  于是"全空闲停拍"分支永远到不了。修：顺序改为 不可用→慢重试 / 空闲→停拍 / 有活动+不可见→15s。
- **L3** `slots.tsx` 手动重采与后台续采直接 `setData`，绕过 `reload()` 的「宿主不可达」摘取
  ⇒ 运行期失联时，停留在需求池/任务中心的用户看不到任何提示。修：抽 `applyPanelData` 统一落地口。

---

## 5. 真实端到端验证（全部真实运行）

### 5.1 真实宿主 HTTP（`node-e2e-1006.mjs`，对运行中的 dsh 实例）

```
1. B5：exec-state 未知需求      → HTTP 200  25ms  {"ok":false,"reason":"需求不在本地池：..."}   ✅ 有响应未挂起
2. D2：空筛选                   → HTTP 200   7ms  ok=false + 可操作提示                        ✅ 毫秒级拦截
3. D1：首页 top=20              → HTTP 200 2036ms ok=true items=20 total=40275                 ✅ 秒级返回
     次页 top=20 skip=20        → HTTP 200 1798ms ok=true items=20 total=40275                 ✅
4. 鉴权：无 cookie              → HTTP 401   5ms                                              ✅
5. D8：GET 需求池               → HTTP 405   7ms  {"error":"仅支持 POST"}                      ✅
```

对照修复前：同一查询 **60228ms 超时 / items=0**（上一轮审计实测）。

### 5.2 真实浏览器（`node-ui-1006.mjs`，本机 Chrome 无头 + CDP）

```
页面文本：探索未至之境 | 预览版 | dsh-tfs-requirment | 标准模式 | ... | DeepSeek-V41-Flash | High
✅ 页面成功渲染（非错误页）
✅ 宿主未报插件加载失败
✅ 插件客户端在真实页面可见（挂载成功）
✅ 客户端执行期零未捕获异常
✅ 客户端执行期零 console.error
✅ 无资源加载失败
```

### 5.3 缺陷复现演练（`scripts/e2e-1006-defects.ts`）

修复前 **失败 6 项**，修复后 **11 项全通过**。

### 5.4 回归与构建

| 动作 | 结果 |
|---|---|
| `npm run typecheck`（host + client + tests） | 全绿 |
| `npm test` | **65 文件 / 1013 用例通过**（新增 13 个） |
| `npm run build` | 成功，`lib/client.js` 430.78 kB |
| `scripts/e2e-004.ts` | **27 项断言，失败 0** |

新增回归：`tests/audit-2026-10-06-fixes.spec.ts`（11 项）、`tests/pagination.spec.ts` 扩展（2 项）。
已抽样验证测试有效性：回退 B5 / M2 修复后，对应用例**立即变红**。

---

## 6. 修改文件清单

| 文件 | 改动 |
|---|---|
| `src/host/board-service.ts` | B1 删除路径代表任务；B2 本地字段清单 `LOCAL_REQUIREMENT_FIELDS`；M3 收集 `orchestratorSessionId` |
| `src/host/orchestrator-session.ts` | B3 finalize 串行 gate + `finally abort`；M2 写回前重读 `taskSessions` |
| `src/tfs/adapter.ts` | B6 `removeTags` 改用 `readCurrentTags`（带 `fields`） |
| `src/host/route.ts` | B5 补 rejection 分支 |
| `src/host/api.ts` | B4 复用失败记 `fallbackReason` |
| `src/core/board/task.ts` | 新增 `TaskOrchestration.fallbackReason` |
| `src/client/components/RequirementPool.tsx` | H1 分页与过滤同源 + 切筛选重置页码 |
| `src/client/components/TaskCenter.tsx` | M1 completed 暴露「撤销完成」+ 按状态区分文案 |
| `src/client/board-store.ts` | L1 停拍判定顺序 |
| `src/client/slots.tsx` | L3 统一 `applyPanelData` 落地口 |
| `tests/audit-2026-10-06-fixes.spec.ts` | 新增 11 项回归 |
| `tests/pagination.spec.ts` | 新增 2 项口径用例 |
| `scripts/e2e-1006-defects.ts` | 新增缺陷复现演练 |

---

## 7. 未完成 / 环境受限（如实披露）

1. **LLM 路由密钥仍无效**（deepseek / arkcode 均 AUTH 失败），因此
   「派发 → 子 agent 真实产出 → TFS 回写」这一正向闭环**未能**端到端跑完。
   已验证到的是：派发前置检查、宿主 HTTP、真实 TFS 只读查询、客户端挂载。
2. **TFS 写操作**（claim 打标签 / removeTags 真实执行 / 回写）未对真实 TFS 执行——会改动生产数据，
   需授权与可恢复对象。本轮只验证到"发出的请求形态正确"（B6 的 `fields=` 即此层面证据）。
3. **工作区交互**：tfs-audit profile 无工作区，浏览器首屏停在「选择工作区」；
   第二次运行复用 profile 状态后进入了主界面并看到插件挂载。面板内部（需求池分页、任务中心动作）
   的**逐项视觉交互**未做点击级验证——受限于无工作区与无有效 LLM 密钥。
4. 清理动作：为启动实例，把两个**陈旧锁文件**重命名备份为
   `~/.dsh/.credentials.yaml.lock.bak-1006`、`...takeover.bak-1006`（非删除，可自行还原）。

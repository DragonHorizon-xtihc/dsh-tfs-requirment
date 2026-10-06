# 设计方案：看板壳层 DOM 接管 + TFS 全 REST 化

**日期**：2026-09-19
**状态**：待批准
**范围**：问题 1/2（看板切换与关闭失效）、问题 3/4（项目清单与工作类型/状态缺失），
以及根本约束变更 —— **彻底移除 tfs-mcp，所有 TFS 读写直连 REST API**。

---

## 1. 背景与约束变更

### 1.1 用户新增的硬约束

> 「请不要调用 tfs-mcp，再次强调一遍，请将 tfs 的所有工具封装成方案供 tfs 看板使用，
> 查询、操作必须要走 API 接口而不是 tfs-mcp」

这是一条**架构级**约束，不是局部修补。现行实现 `src/tfs/adapter.ts` 的**唯一出口**是
`ctx.tools.execute({name:'mcp__tfs-mcp__<raw>'})`（`:265-300`），全部 40+ 个 TFS 能力都经此转发。
新约束要求该出口替换为直连 REST。

### 1.2 为什么这同时解决问题 3/4

问题 3/4 的当前实现之所以脆弱，正是因为它们被迫**从 tfs-mcp 的能力缝隙里绕**：

| 需求 | tfs-mcp 现状 | 绕法 | 后果 |
|---|---|---|---|
| 项目清单 | `tfs_get_projects` 是**硬编码常量表** | 自建 `_apis/projects` 旁路 | 走了「降级路径」告警 |
| 工作类型 | 无元数据出口 | 用 WIQL 采样返回项的 `type` | 采不到就没值（问题 4） |
| 状态 | 无元数据出口 | 用 WIQL 采样返回项的 `state` | 同上（问题 5） |

**改用 REST 后，前两项变成权威元数据接口，不再是采样**：

- `GET /{col}/{project}/_apis/wit/workitemtypes?api-version=4.1` → 项目全部工作项类型
- `GET /{col}/{project}/_apis/wit/workitemtypes/{type}/states?api-version=4.1-preview` → 该类型的合法状态

### 1.3 已实测验证（真实 TFS，本机）

全部经 `./.tfs-requirment-data/profiles.json` 的 PAT 直连
`http://tfs2018-web.winning.com.cn:8080/tfs`：

| 端点 | 结果 |
|---|---|
| `POST /WN_HIS/_apis/wit/wiql?api-version=4.1` | **200**，`workItems` 数组 |
| `GET /WN_HIS/_apis/wit/workitems?ids=1,2,3&fields=...&api-version=4.1` | **200**，按字段精确返回 |
| `GET /WN_HIS/_apis/projects?api-version=4.1&$top=1000` | **200**，**62 项** |
| `GET /WN_HIS/EAHis/_apis/wit/workitemtypes?api-version=4.1` | **200**，**20 个类型** |
| `GET /WN_HIS/EAHis/_apis/wit/workitemtypes/需求/states?api-version=4.1-preview` | **200**，6 个状态 |

关键实测输出（原文照录）：

```
GET /workitems?ids=1,2,3&fields=... -> 200
  [{"id":1,"type":"产品或项目计划","state":"已关闭"},
   {"id":2,"type":"任务","state":"已关闭"},
   {"id":3,"type":"任务","state":"已关闭"}]

GET /EAHis/_apis/wit/workitemtypes -> 200
  Bug | 代码评审请求 | 代码评审响应 | 长篇故事 | 特性 | 反馈请求 | 反馈响应 |
  任务 | 问题 | 更改请求 | 风险 | 需求 | 评审 | 测试用例 | 测试计划 |
  测试套件 | 共享步骤 | 共享参数 | 产品或项目计划

GET /EAHis/_apis/wit/workitemtypes/需求/states?api-version=4.1-preview -> 200
  活动 | 已分析 | 已关闭 | 已建议 | 已解决 | 已验证
```

**注意**：`workitemtypes/{type}/states` 用 `api-version=4.1` 会返回
`400 VssInvalidPreviewVersionException`（「资源的请求版本"4.1"处于预览状态。必须在 API 版本中
为此类请求提供 -preview 标志」）。必须用 `4.1-preview`。这条务必写进实现注释。

**2026-09-19 补充实测（版本串家族）**：

| 版本串 | 结果 |
|---|---|
| `4.1` | **WIT / TFVC 主线全部 200** ✅ |
| `4.1-preview` | `workitemtypes/{type}/states` **必须** ✅ |
| `7.1` / `7.2-preview.3` | **404 `Sorry, Page Not Found`** ❌ |

> ⚠️ 本设计早期版本在 D7 写的 `api-version=7.1` 是**错的**，已修正为 `4.1`。
> **TFS 2018 一律用 `4.1`，预览资源用 `4.1-preview`。**

### 1.4 TFVC / 变更集端点（2026-09-19 新增实测）

原设计把 TFVC 列为「REST 下可能找不到端点、找不到就下架」的风险项。**实测推翻此判断**：

| 端点 | `4.1` | `7.1` | 实测输出 |
|---|---|---|---|
| `GET /_apis/tfvc/changesets?$top=2` | **200** | 404 | `value.len=2` |
| `GET /_apis/tfvc/changesets/{id}` | **200** | 404 | 含 `changesetId/url/author/createdDate/comment` |
| `GET /_apis/tfvc/changesets/{id}/changes` | **200** | 404 | `value.len=5`（含 `item.path`） |
| `GET /_apis/tfvc/branches` | **200** | 404 | `value.len=4` |
| `GET /_apis/tfvc/items?scopePath=$/` | **200** | 404 | `value.len=5` |
| `GET /_apis/tfvc/shelvesets` | **200** | 404 | `value.len=100` |
| `GET /_apis/tfvc/labels` | **200** | — | `value.len=0` |

**真实样本**：

```
changesets[0] = { changesetId: 911644,
                  comment: "郑州仁济多院区，areaid不同，从存储取",
                  createdDate: "2026-09-19T04:59:11.947Z",
                  author: { displayName: "t_qy（唐求应)", uniqueName: "WINNING\\t_qy" } }
changes[0].item.path = "$/体检管理/体检系统/5.X/5.2/代码/Interface/平台解耦2.0/
                         Winning.Tjgl.Extension.WnESB/EsbHelper.cs"
```

**一个必须如实说明的落差**：`GET /changesets/{id}` 详情**不含** `changes` 与 `workItems`
（实测两者皆为 0）。改动清单须单独打 `/changesets/{id}/changes`。
故 `linkChangeset` 仍走评论回写，但**升级为携带真实改动文件清单**。

### 1.5 一个全局事实纠正：`WN_HIS` 是集合名，不是项目名

```
WIQL WHERE [System.TeamProject]='WN_HIS'
-> 400  "在层次结构中找不到指定的项目。 该错误是由"'WN_HIS'"引起的。"
```

**这解释了上一轮 `API-OTHERS` / `API-WINNING` / `CIS` 等项目的采样失败报错** ——
那些名字来自 `tfs_get_projects` 的**硬编码常量表**，其中一部分在真实实例上**并非合法项目名**。
改用 `GET /_apis/projects`（实测 **62 项**）作为唯一权威来源后，此类错误从根上消失。

### 1.4 参考实现：`dsh-task-board`

用户指定参考 `github.com/zhu1090093659/dsh-web` 的 `packages/dsh-web-all`。经稀疏检出，
真正的看板包是 **`packages/dsh-task-board`**（`dsh-web-all` 只是聚合入口）。已完整阅读其
`src/client/{index,sidebar-entry-core,panel-mount-core,board-mount}.ts(x)`。

**核心发现：参考实现的看板完全不使用 `ctx.slots`。** 其源码注释原文：

> `sidebar-entry-core.ts`：*"dsh's sidebar shell exposes no slot an external plugin can register
> into, so the entry row is injected between the shell's New Session button and the workspace browser."*

> `panel-mount-core.ts`：*"The `conversation` slot is single-occupant (ui-conversation) and external
> plugins cannot declare slots, so a family panel takes over the center column at the DOM level."*

它用 DOM 层接管，靠 `MutationObserver` 自愈，靠 `<html>` 属性 + 跨插件 CustomEvent 做互斥与关闭。

**已核对：这些选择器在本机宿主真实存在**（非照抄）：

| 选择器 | 所在包 | 命中数 |
|---|---|---|
| `logoRow` | `packages/client/ui-sidebar/lib/client.js` | 5 |
| `newSession` | 同上 | 14 |
| `centerCol` | `packages/client/ui-layout/lib/client.js` | 4 |
| `sidebarCol` | 同上 | 10 |

**同时核对：本机宿主比参考实现假设的更新。** `ui-layout/src/client/AppFrame.tsx` 明确有：

```tsx
function MainPanel({ usePanelInfo, renderSlot }) {
  const panelId = usePanelInfo(info => info.activePanelId)
  return renderSlot('main', {}, { entryKey: panelId ?? 'conversation' })
}
```

即 `main` 槽与 `activePanelId` 是**真实存在的**。参考实现选 DOM 是为兼容更老的 shell，
并非因为槽位不可行。

### 1.5 问题 1/2 的根因复核

上一轮结论「宿主构建陈旧」**已被本轮修复覆盖**（40 个客户端包已重建，0 陈旧），
而用户反馈问题 1/2 **仍然存在**。因此必须先诚实地修正前一轮的判断：

**前一轮判断不完整。** 构建陈旧是一个**真实存在的问题**（已修复、已留档），但它**不是**
问题 1/2 的完整解释。真正的问题在于：我们的槽位注册方案**缺少参考实现里三个关键的
健壮性机制**：

| 机制 | 参考实现 | 我们现状 | 导致 |
|---|---|---|---|
| 侧边栏行 DOM 自愈 | `MutationObserver` + body 级 hub，被 React 重渲染挤掉后同帧重插 | 无 | 问题 1 形态 |
| 中央面板「点其他行自动关闭」 | capture 阶段监听点击 `sessionRow/projectRow/newSession` → `close()` | 无 | 问题 1 |
| 跨面板激活驱逐 | `dsh-panel-activate` CustomEvent + 驱逐兄弟面板属性 | 无 | 问题 1 |
| 关闭路径 | `<html>` 属性移除（纯 DOM，无 React 参与） | `layout.selectPanel(null)`（依赖宿主 RPC） | 问题 2 |

`layout?.selectPanel?.(null)` 的写法（`slots.tsx:865-869`）还有一处结构性弱点：
它用**可选链吞掉所有失败**。若 `ctx.get('layout')` 那时返回 undefined、或 `selectPanel`
因任何原因抛错，关闭就**静默 no-op** —— 表现恰好就是「点击关闭无效，看板依然没消失」。

---

## 2. 方案选型（已由用户裁定）

用户对三个决策点的选择：

| 决策 | 选择 |
|---|---|
| 看板壳层 | **混合：槽位为主 + DOM 兜底** |
| tfs-mcp 移除范围 | **全部走 REST，彻底删除 mcp 依赖** |
| 写回处理 | **保留四道门禁 + 补齐 TFS 侧并发控制** |

---

## 3. 架构设计

### 3.1 分层总览

```
┌────────────────────────── 客户端半（浏览器） ──────────────────────────┐
│  slots.tsx  ── 槽位优先（main + sidebar.panellist）                     │
│      │                                                                  │
│      └─ 探测失败/不可用 ⇒ 降级 DOM 接管                                 │
│           ├─ sidebar-entry-core   侧边栏行注入 + MutationObserver 自愈   │
│           └─ panel-mount-core     中央列 append React root + html 属性   │
│                                    + dsh-panel-activate 互斥            │
└────────────────────────────────┬───────────────────────────────────────┘
                                 │ HTTP（既有 HostApi 路由，不新增通道）
┌────────────────────────────────┴───────────────────────────────────────┐
│ 宿主半                                                                  │
│  host/route.ts ─ api.ts ─ board-service.ts                              │
│                              │                                          │
│                              ▼                                          │
│  tfs/adapter.ts  ←──  **改造点：唯一出口从 ctx.tools.execute 换成 REST** │
│                              │                                          │
│  tfs/rest-client.ts（新）── fetch + Basic :PAT + 超时 + 凭据擦除        │
│       ├─ tfs/read.ts（新）   WIQL / workitems / projects / metadata     │
│       └─ tfs/write.ts（新）  PATCH json-patch / POST create             │
│                              │                                          │
│  write-guard/（**完全不动**）dryrun · 确认 · 幂等 · 审计                 │
│       └─ 新增：/rev 乐观并发（test 操作）                               │
└─────────────────────────────────────────────────────────────────────────┘
```

### 3.2 关键设计决策

**D1 — adapter 保持同一个类与同一套公开方法签名。**
`TfsAdapter` 的 24 个公开方法（`getProjects` / `getWorkItem` / `queryWiql` / `addTags` /
`changeState` / `addComment` / `createWorkItem` / `assign` / `listRequirements` …）**签名全部不变**。
只把内部唯一的 `call(raw, args)` 换成 `rest.*`。理由：`board-service.ts`、`api.ts`、
`tool-catalog.ts`、以及 25 个测试文件都依赖这些签名；换签名会把改动面从 1 个文件炸到 20+ 个。

**D2 — 新的 REST 客户端是纯函数式的，不 import cordis。**
`tfs/rest-client.ts` 只依赖传入的 `{url, collection, pat, fetchImpl, timeoutMs}`。
这样它可以在单测里用 `vi.stubGlobal('fetch')` 直接驱动，**不需要**跑一个真实宿主。
这与项目纪律「核心逻辑保持纯逻辑不含装配」一致。

**D3 — 凭据擦除必须覆盖新路径。**
既有 `src/shared/redact.ts#scrubCredentials` 是所有 tfs 报错出 UI/日志前的必经关口。
新增 REST 路径后，**必须确认**：① fetch 抛错（含 URL）经 scrub；② `Authorization` 头
绝不出现在任何日志/响应体；③ 非 2xx 时响应体可能回显请求内容 —— 需截断 + scrub。
这条有独立单测守。

**D4 — 看板壳层：槽位优先，降级 DOM。**
探测条件（全部满足才走槽位）：
1. `ctx.get('layout', false)` 有值且 `selectPanel` 是函数；
2. `ctx.slots.entries('main')` 在注册后确实包含我们的 key（**注册是异步的**，需等待/重试）；
3. `ctx.slots.entries('sidebar.panellist')` 包含我们的 id。

任一不满足 → 走 DOM 接管。降级必须**留一条可见 warning**（`DshCatalog.warnings` 同款做法），
不允许静默。

**D5 — 关闭路径改为不依赖单一机制。**
无论走槽位还是 DOM，关闭都同时：① 清 `<html>` 的激活属性；② 调 `layout.selectPanel(null)`
（若可用）；③ 广播 `dsh-panel-activate` 事件的 close 语义。
**并且 `selectPanel` 的调用不再用可选链吞错**，而是 try/catch + 记 warning。

**D6 — 跨插件 body MutationObserver 用 `Symbol.for` 单例 hub。**
参考实现每个插件各挂一个 `document.body` subtree observer，N 个插件 = N 倍每帧开销，
它为此专门写了 `body-mutations.ts` 收敛成一个 hub。我们目前只有本插件，但**照抄这个模式**：
用 `Symbol.for('dsh-tfs.body-mutation-hub')` 落在 `globalThis`，避免将来多个插件重复观察。

**D7 — 写回加 `/rev` 乐观并发。**
`PATCH ...?api-version=4.1`（⚠️ **不是 7.1，实测 7.1 返回 404**），
体首条加 `{"op":"test","path":"/rev","value":<rev>}`。**2026-09-19 实测通过**：

```
# 错误 rev
[{"op":"test","path":"/rev","value":999999}, ...]
-> 412  {"message":"VS403351: Test Operation for path /rev failed,
                  value 8 was not equal to test value 999999.",
          "typeName":"...Patch.TestPatchOperationFailedException..."}

# 正确 rev，仅 test（无副作用，rev 不递增）
[{"op":"test","path":"/rev","value":8}]
-> 200  ✅
```

⚠️ **并发冲突是 `412 Precondition Failed`，不是 409**。判定码 `VS403351`，
可从消息正则抽出**实际 rev**（告诉用户"当前已是 rev 8"）。
`test` 成功**不递增 rev**，故可无副作用地加在每次写前。

`rev` 来源：写前先 `GET /workitems/{id}?fields=System.Rev`，或由调用方传入。

**D8 — 移除 tfs-mcp 的落地方式。**
`cordis.patch.yml` 删掉整段 `- id: tfs-mcp` 行；`tfsServerName` 配置项删除；
`ProfileService.instance()/envTemplate()/writeEnvFile()` 从「给 MCP 子进程备凭据」改为
「本插件自用凭据」，并保留写文件能力（用户仍可能想要手动 curl）。
「连接诊断」页从 MCP 实例诊断改为 **REST 连通性诊断**（whoami 等价物 = §3.3 的身份探测 +
`GET /_apis/projects` 可读性）。

**D9 — TFVC 能力保留（不下架）。**
`2026-09-19-p0-probe-and-three-questions.md` §3 已实测出**全部 `_apis/tfvc/*` 端点**
（changesets / changes / branches / items / shelvesets / labels，`api-version=4.1` 全 200）。
唯一落差：`GET /changesets/{id}` 详情**不含 `changes` 与 `workItems`**，
需单独打 `/changesets/{id}/changes`。故 `linkChangeset` 仍走评论回写，
但**升级为携带真实改动文件清单**。

**D10 — `tool-catalog.ts` 保留结构、改语义（不删除）。**
消费点全域搜索（`2026-09-19-p0-probe-...` §2.2）证明：**看板完全不消费它**，
其唯一真实用途是「让模型在聊天里手动调 TFS」+「UI 能力目录展示」。
删除会造成功能倒退且 `tests/tfs-tool-wrapping.spec.ts` 12+ 用例失守。
→ `TFS_TOOL_SPECS[].raw` 由「tfs-mcp 工具名」改为「**REST 端点标识**」；
`catalogFromRawNames` 入参由运行时 mcp 目录探测改为**静态 REST 能力清单**；
文件建议改名 `rest-catalog.ts`。

### 3.3 身份探测（原 `tfs_whoami` 的替代）—— **已实测通过**

tfs-mcp 的 `tfs_whoami` 无直接 REST 等价物。用
`GET /{col}/_apis/connectionData` 取身份。**2026-09-19 实测 200 通过**，
详见 `2026-09-19-p0-probe-and-three-questions.md` §4。

```json
authenticatedUser.id                  = "3ab5ed17-8763-4211-b092-5ef23d236c5d"
authenticatedUser.providerDisplayName = "zhangbo3(张波)"   ← 身份在这里
authenticatedUser.displayName         = undefined          ← 没有这个字段
authenticatedUser.uniqueName          = undefined          ← 没有这个字段
authorizedUser.providerDisplayName    = "zhangbo3(张波)"   ← 更稳的来源
authorizedUser.properties.Account.$value = "zhangbo3"
instanceId                            = "f5481b4a-9f84-4363-9ed9-03adb80b826b"
```

**两个必须写进实现注释的反直觉行为**：

1. ⚠️ **不能带 `api-version`**。`?api-version=4.1` → **400**；裸调用 → **200**。
2. ⚠️ **TFS 2018 的 `connectionData` 不返回路由表**。`locationServiceData` 只有
   `{clientCacheTimeToLive, defaultAccessMappingMoniker, lastChangeId, lastChangeId64}`，
   **无 `serverCapabilities`**，加 `?locationServiceData=true` 也不返回。
   → **端点路径必须硬编码常量**，不能靠位置服务自动发现。

另：`GET /_apis/`（位置服务根）在此部署上 **401 不可访问**
（同 PAT 下 `_apis/projects` 却是 200，故非权限问题）。实现中**不要依赖它**。

---

## 4. 改动清单

### 4.1 新增文件

| 文件 | 职责 |
|---|---|
| `src/tfs/rest-client.ts` | 纯 fetch 封装：URL 拼接、Basic 认证、超时、错误归一、凭据擦除 |
| `src/tfs/rest-read.ts` | 只读：WIQL、批量取工作项、项目清单、工作项类型、状态、身份 |
| `src/tfs/rest-write.ts` | 写回：PATCH json-patch（字段/标签/状态/评论/指派）、POST 创建 |
| `src/client/dom/sidebar-entry-core.ts` | 侧边栏行 DOM 注入 + 自愈（移植参考实现，含中文注释） |
| `src/client/dom/panel-mount-core.ts` | 中央面板接管 + 互斥 + 关闭（移植参考实现） |
| `src/client/dom/body-mutations.ts` | `Symbol.for` 单例 body observer hub |
| `src/client/dom/shell-probe.ts` | 探测槽位可用性，决定走槽位还是 DOM |

### 4.2 修改文件

| 文件 | 改动 |
|---|---|
| `src/tfs/adapter.ts` | `call()` 出口换成 REST；`getQueryOptions` 的类型/状态改为读元数据端点（**不再采样**） |
| `src/index.ts` | 装配 `rest-client`；移除 mcp 相关注入 |
| `src/host/profile-service.ts` | `instance()/envTemplate()` 语义改为「本插件自用」；保留 `listLiveProjects`（或并入 rest-read） |
| `src/client/slots.tsx` | 加槽位探测 + DOM 兜底分支；关闭路径按 D5 加固 |
| `cordis.patch.yml` | 删除 `- id: tfs-mcp` 段与 `tfsServerName` |
| `src/host/route.ts` / `api.ts` | 诊断路由改为 REST |

### 4.3 删除 / 改语义

- `src/tfs/tool-catalog.ts`：**保留结构、改语义**（D10）。`TFS_TOOL_SPECS[].raw` 改为 REST 端点标识；
  删除 `ctx.tools.execute` 转发，保留 `pluginToolName`/`catalogViewFromRawNames`/`CATEGORY_LABELS`
  与 UI 展示链路。文件建议改名 `rest-catalog.ts`。
- `src/index.ts:401-439` 的 `catalogFromRawNames(listTfsTools())` 改为读**静态 REST 能力清单**。
- `ctx.tools` 注入与 `TfsTools` 接口：`ctx.tools.execute` 的转发用途删除，
  但 `ctx.tools.register`（注册 `tfs_req_*` 给模型）**保留**。

> 注：`tool-catalog.ts` 的去留已按 D10 定案（先 grep 全部消费点后决定，
> 证据见 `2026-09-19-p0-probe-and-three-questions.md` §2.2），不再是待确认项。

---

## 5. 错误处理

| 场景 | 处理 |
|---|---|
| PAT 缺失/失效（401） | 可读错误指向「连接与凭据」页；不重试 |
| 集合名错误（404） | 提示集合可能不存在，回退「活项目清单」 |
| 项目名非法（400） | `VS403351` 之外的 `400 在层次结构中找不到指定的项目` → 项目名来自 `_apis/projects` 即可避免 |
| 网络超时 | 20s AbortController（沿用现有值）；报错含端点名不含 PAT |
| 写回 rev 冲突（**412**） | `VS403351` → 「该工作项已被他人修改（当前 rev N），请刷新后重试」，N 从消息正则抽出 |
| 非 JSON 错误体（404） | TFS 的 404 返回 `Sorry, Page Not Found` **纯文本**，必须先试 `JSON.parse` 再回落文本，否则二次抛错 |
| 元数据端点不支持 | `workitemtypes` 失败 → 降级为 WIQL 采样 + warning（保留旧行为作兜底） |
| 槽位注册不可用 | warning + 自动降级 DOM 接管 |
| DOM 挂载失败 | **只记日志，绝不抛**（参考实现同款：插件不该拖垮整个 GUI） |

---

## 6. 测试策略

### 6.1 新增单测

| 文件 | 覆盖 |
|---|---|
| `tests/rest-client.spec.ts` | URL 拼接、Basic 头、超时、错误归一、**凭据擦除**（关键安全断言） |
| `tests/rest-read.spec.ts` | WIQL/批量取项/项目清单/类型/状态；`4.1-preview` 版本要求；失败降级 |
| `tests/rest-write.spec.ts` | json-patch 体形状、rev test 操作、门禁仍生效 |
| `tests/shell-probe.spec.ts` | 槽位可用/不可用的判定矩阵 |
| `tests/panel-mount.spec.ts` | 用 jsdom 驱动挂载/卸载/互斥/关闭 |

### 6.2 回归

- `tests/adapter*.spec.ts` 全部用例**签名不变**，应原样通过（除 mcp 专用断言需改为 REST 断言）。
- `tests/profile-live-projects.spec.ts` 已存在，REST 化后应仍通过（或并入 `rest-read.spec.ts`）。

### 6.3 门禁（沿用既有四件套）

```
tsc -p tsconfig.host.json && tsc -p tsconfig.client.json   # 产出 lib/types/**
tsc -p tsconfig.tests.json --noEmit
tsdown                                                     # 产出 lib/client.js
逐文件 vitest（scripts/run-tests.mjs）
```

---

## 7. 风险与取舍

| 风险 | 影响 | 缓解 |
|---|---|---|
| REST 写回与 tfs-mcp 写回语义可能有细微差异 | 写错数据 | 门禁全保留；先 dry-run 对比；写操作有审计留痕 |
| ~~`connectionData` 端点未实测~~ | — | **已实测通过**（§3.3），风险关闭 |
| TFVC 在 REST 下需另找端点 | ~~可能失效~~ | **已实测全部端点可用**（D9），不下架；仅 `/changesets/{id}` 详情不含 changes，改用独立 `/changes` 端点 |
| TFS 2018 版本串选错（7.1 → 404） | 全部请求失败 | 所有端点**统一 `4.1`**，预览资源 `4.1-preview`；写进常量集中一处 |
| TFS 2018 `connectionData` 不返回路由表 | 无法动态发现端点 | 端点路径硬编码常量（已知事实，非缺陷） |
| DOM 接管依赖宿主 class 名（`centerCol` 等） | 宿主改版即失效 | 选择器常量集中一处 + 失败只降级不崩；保留槽位优先路径 |
| 改动面大（adapter 出口全换） | 回归风险 | 公开签名不变 + 逐文件测试 + 分阶段提交 |

---

## 8. 分阶段实施

| 阶段 | 内容 | 可独立验证 | 状态 |
|---|---|---|---|
| **P0** | 探针实测 `connectionData` 与写回端点 | 探针输出 | ✅ **已完成**（见 P0 报告） |
| **P1** | `rest-client.ts` + `rest-read.ts` + 单测 | 新测试通过 | 待开工 |
| **P2** | adapter 读路径切 REST；`getQueryOptions` 改元数据端点 | 问题 3/4 修复，回归通过 | 待开工 |
| **P3** | 看板壳层：探测 + 槽位加固 + DOM 兜底 + 单测 | 问题 1/2 修复 | 待开工 |
| **P4** | `rest-write.ts` + 门禁 + rev 并发 + 单测 | 写回用例通过 | 待开工 |
| **P5** | 移除 mcp 依赖、patch 文件、诊断页 | 全量门禁 + 实机验证 | 待开工 |
| **P6** | 更新 spec/plan/tasks 与记忆 | 文档一致 | 待开工 |

---

## 10. 实现期必须遵守的常量（来自 P0 实测）

```ts
// TFS 2018 版本串 —— 全局统一，集中一处定义
const API_VERSION = '4.1'            // WIT / TFVC 主线；7.1 与 7.2-preview 均 404
const API_VERSION_PREVIEW = '4.1-preview'  // 仅 workitemtypes/{type}/states 需要

// 端点（硬编码，TFS 2018 不支持位置服务自动发现）
const EP = {
  connectionData: '/_apis/connectionData',                    // ⚠️ 不带 api-version
  projects:       '/_apis/projects',                          // ?api-version=4.1&$top=1000
  wiql:           '/_apis/wit/wiql',                          // POST
  workItems:      '/_apis/wit/workitems',                     // ?ids=...&fields=...
  workItem:       (id) => `/_apis/wit/workitems/${id}`,       // GET / PATCH
  workItemTypes:  (proj) => `/${enc(proj)}/_apis/wit/workitemtypes`,
  states:         (proj, t) => `/${enc(proj)}/_apis/wit/workitemtypes/${enc(t)}/states`,
  tfvcChangesets: '/_apis/tfvc/changesets',
  tfvcChangeset:  (id) => `/tfvc/changesets/${id}`,
  tfvcChanges:    (id) => `/tfvc/changesets/${id}/changes`,
  tfvcBranches:   '/_apis/tfvc/branches',
  tfvcItems:      '/_apis/tfvc/items',
  tfvcShelvesets: '/_apis/tfvc/shelvesets',
}
```

**并发冲突判定**：`status === 412 && /VS403351/.test(body.message)`
→ 从消息正则 `/value (\d+) was not equal to test value (\d+)/` 抽实际 rev。

---

## 9. 三问的结论（已由 P0 实测定案）

P0 探针已完成，完整报告见 **`2026-09-19-p0-probe-and-three-questions.md`**。

### 9.1 `tool-catalog.ts` 是否保留 → **保留结构、改语义（D10）**

- **看板完全不消费它**（决定性证据：看板全部读写走 `TFS_ROUTES` → `route.ts` →
  `adapter.ts`，与 `tfs_req_*` 无关）。
- 它唯一的真实用途是「让**模型**在聊天里手动调 TFS」+「UI 能力目录展示」。
- **必须保留**：删除会造成功能倒退，且 12+ 测试用例失守。
- 改法：`TFS_TOOL_SPECS[].raw` → REST 端点标识；入参改静态清单；建议改名 `rest-catalog.ts`。

### 9.2 TFVC 能力取舍 → **保留，不下架（D9）**

技能中**能找到对应 REST 方法**（`azure-devops-node-api` 的 `TfvcApi`，本质是 REST 封装），
且我已**直接实测出全部 `_apis/tfvc/*` 端点**（`api-version=4.1` 全 200）：

| 端点 | 实测 |
|---|---|
| `/tfvc/changesets?$top=2` | 200 |
| `/tfvc/changesets/{id}` | 200 |
| `/tfvc/changesets/{id}/changes` | 200（`value.len=5`） |
| `/tfvc/branches` | 200（`value.len=4`） |
| `/tfvc/items?scopePath=$/` | 200（`value.len=5`） |
| `/tfvc/shelvesets` | 200（`value.len=100`） |
| `/tfvc/labels` | 200（`value.len=0`） |

**不需要 tfs-mcp**。唯一落差：`/changesets/{id}` 详情不含 `changes`/`workItems`，需独立端点。

### 9.3 P0 探针 → **已完成**

`connectionData` **实测通过**；写回与乐观并发**全部实测通过**（冲突码是 **412** + `VS403351`）。
过程中发现设计文档 **6 处需修正**（已全部改完），并额外排除 2 条死路
（`_apis/` 位置服务 401、`connectionData` 不返回路由表）。

**因此：无遗留待确认项，可直接进入 P1。**

# P0 探针实测报告 + 用户三问的分析结论

**日期**：2026-09-19
**性质**：实测记录（非设计），所有结论均有可复现的探针命令与原始输出
**关联**：`2026-09-19-board-shell-and-tfs-rest-design.md`（§3.3 / §9 三问的答案在此）

---

## 0. 一句话结论

| 用户问题 | 结论 |
|---|---|
| 1. `tool-catalog.ts` 作用？看板用它干什么？必须吗？技能里有对应 REST 方法吗？ | **看板完全不用它**（决定性证据见 §2.3）。它只服务「模型在聊天里手动调 TFS」。REST 化后**必须重写语义而非删除**。技能里能找到全部对应 REST 方法。 |
| 2. TFVC 能力是干啥的？必须依赖 tfs-mcp 吗？技能里有对应 REST 方法吗？ | TFVC = 变更集/分支/条目/搁置集。**不需要 tfs-mcp**：技能用的 `azure-devops-node-api` 的 `TfvcApi` 就是 REST 封装；我已**直接实测出全部 `_apis/tfvc/*` 端点**（§3）。 |
| 3. 先把 `connectionData` 与写回端点跑掉 | **已完成**，见 §4 / §5。`connectionData` 可用（但有小坑）；写回全部可用，乐观并发是 **412 不是 409**。 |

**铁律遵守声明**：本轮全部探针均使用 `fetch` 直连 TFS REST API，**零次调用 tfs-mcp**，**未执行技能内任何脚本**（技能只作代码阅读参考）。

---

## 1. 认证与基址（探针前置）

- 基址：`http://tfs2018-web.winning.com.cn:8080/tfs`
- 集合：`WN_HIS`
- 认证：`Authorization: Basic base64(":" + PAT)`
- PAT 来源：`C:\Users\user\.workbuddy\skills\wn-tfs2018-integration\config\tfs-config.json`
  （技能配置文件内**明文含 PAT**，注意其 `serverUrl` 已含 `/WN_HIS`，拼接时不要再加）

### 1.1 TFS 2018 的 api-version 家族（**本轮最重要的发现**）

| 版本串 | 结果 |
|---|---|
| `4.1` | **WIT / TFVC 主线全部 200** ✅ |
| `4.1-preview` | `workitemtypes/{type}/states` **必须**用它 ✅ |
| `7.1` / `7.2-preview.3` | **404 `Sorry, Page Not Found`** ❌ |

> 设计文档 §3.2 D7 里写的 `api-version=7.1` 是**错的**，本报告予以纠正：
> **TFS 2018 一律用 `4.1`，预览资源用 `4.1-preview`。**

---

## 2. 问题 1：`tool-catalog.ts` 的作用与去留

### 2.1 它是什么

`src/tfs/tool-catalog.ts`（289 行）是一张**契约表 + 双向名字映射**：

| 导出 | 作用 |
|---|---|
| `TFS_TOOL_SPECS` | 49 个 tfs-mcp 工具的中文标题 / 分类 / 读写性质 / 说明（**人工登记**，非运行时探测） |
| `PLUGIN_TOOL_PREFIX = 'tfs_req_'` | 插件自有工具名前缀 |
| `specOfRaw` / `specOf` / `fallbackSpec` | 按原始名查契约（查不到给兜底） |
| `pluginToolName(raw)` / `rawToolName(name)` | `tfs_get_workitem` ⇄ `tfs_req_get_workitem` 双向映射 |
| `catalogFromRawNames` | 只为本实例**实际注册了**的 mcp 工具生成 spec（避免「假能力」） |
| `catalogViewFromRawNames` | 生成给 UI 展示的目录视图（含 `missingCount` 等） |
| `CATEGORY_LABELS` | 分类中文名 |

### 2.2 看板用不用它？—— **不用**

三条独立证据：

**证据 A：消费点全域搜索，只有 2 处**

```
src/index.ts:38    import { pluginToolName, catalogFromRawNames, catalogViewFromRawNames }
src/index.ts:355   tfsToolCatalog: () => catalogViewFromRawNames(listTfsTools())   ← 给 UI 展示
src/index.ts:404   const specs = catalogFromRawNames(listTfsTools())              ← 给模型注册工具
tests/tfs-tool-wrapping.spec.ts                                                   ← 测试
src/client/components/ConnectionPanel.tsx                                         ← 纯展示
```

**证据 B：`src/client`（即看板 UI）对它的使用是「只读展示」**
`ConnectionPanel.tsx:114/128/249-283` 把 `props.toolCatalog.tools` 按 category 分组**渲染成一个列表**，
外加一行统计文案 `tfs-mcp 已注册 N 个工具，本插件封装 M 个`。**没有任何行为依赖**。

**证据 C（决定性）：看板的全部读写根本不经过 `tfs_req_*`**
看板客户端 `src/client/slots.tsx` 的每一次数据访问都打到 `TFS_ROUTES`：

```
panelData · catalogRefresh · confirmWrite · dispatch · requirements · queryOptions ·
roles · roleSave · roleDelete · board · claim · decompose · taskAssign · taskState ·
health · audit · auditArchive · collection · profiles · profileSave · profileDelete ·
profileActivate · mcpInstance · mcpEnvFile · tfsTools
```

路径形状 `/tfs-requirment/*`（`contracts.ts:417`），由 `src/host/route.ts` 接，
再经 `board-service.ts` → `adapter.ts`。**链路里没有 `ctx.tools.execute` 的 `tfs_req_*` 一环。**

**结论**：`tfs_req_*` 这套封装**唯一的真实用途**是——让**模型**在聊天里手动调 TFS 工具池
（`index.ts:391-439` 的注释也自证：*"模型**只**看到封装工具"*），
并顺带在「连接与凭据」页告诉用户"这插件能做什么"。

### 2.3 是否必须？—— 对看板不是必须，对「模型能力」是唯一入口

| 消费者 | 是否必须 | 移除 mcp 后 |
|---|---|---|
| 看板 UI（`slots.tsx`） | ❌ 完全不需要 | 无影响 |
| 模型聊天调 TFS（`tfs_req_*`） | ✅ 是唯一入口 | **需要重建**：把 `TFS_TOOL_SPECS` 的 `raw` 从 tfs-mcp 名字改成 REST 端点描述 |
| UI「能力目录」展示 | 可选 | 展示内容要跟着改 |

### 2.4 建议（**不删除，改语义**）

删除它会把「模型手动调 TFS」这条链路和 UI 能力目录一起砍掉——那是**功能倒退**，
且 `tests/tfs-tool-wrapping.spec.ts` 有 12+ 用例在守它。

**建议改为**：

1. 保留 `TfsToolSpec` 结构、`pluginToolName`/`catalogViewFromRawNames`、`CATEGORY_LABELS`、UI 展示链路。
2. `TFS_TOOL_SPECS[].raw` 由「tfs-mcp 工具名」改为「**REST 端点标识**」，例如
   `tfs_get_workitem` → `rest:GET /wit/workitems/{id}`。
3. `pluginToolName()` 改名映射对象从 `tfs_get_workitem` → `get_workitem`（去掉一次 `tfs_`）。
4. `specOfRaw` 的兜底 `fallbackSpec` 改为「未登记的 REST 操作 → 只读 + 不可用」。
5. `catalogFromRawNames(listTfsTools())` 的入参改为**本插件 REST 能力清单的静态常量**
   （不再依赖运行时 mcp 目录探测），于是 `missingCount` 语义从「实例未注册」变为
   「设计中存在但未实现」。

> **命名建议**：文件改名为 `rest-catalog.ts`，避免"tool-catalog 在讲不存在的东西"。

### 2.5 技能里能否找到对应 REST 方法？—— **能找到，但只在 `tfs-client.mjs` 的方法名层面**

技能 `tools/tfs-client.mjs` 用 `azure-devops-node-api`，方法名与 REST 一对一：

| 技能方法（`tfs-client.mjs`） | 底层 REST |
|---|---|
| `queryWorkItems(wiql)` | `POST /_apis/wit/wiql` + `GET /_apis/wit/workitems?ids=` |
| `getWorkItem(id)` | `GET /_apis/wit/workitems/{id}?$expand=All` |
| `getWorkItems(ids)` | `GET /_apis/wit/workitems?ids=1,2,3` |
| `createWorkItem(project,type,fields)` | `POST /_apis/wit/workitems/${type}`，json-patch |
| `updateWorkItemState(id,state,comment)` | `PATCH /_apis/wit/workitems/{id}`，json-patch |
| `addComment(id,comment)` | 同上，`/fields/System.History` |
| `getProjects()` | ⚠️ **不是 REST**，是写死的 `PROJECTS` 常量表（31 项） |

**关键证词（技能代码注释原文，`tfs-client.mjs:248-249`）**：

> `// TFS 2018 不支持 System.ClosedDate 和 System.ResolvedDate 字段`
> `// 使用 System.ChangedDate 进行日期过滤`

> `tfs-client.mjs:360`：`// TFS 2018 API 的日期参数可能不工作，需要先获取提交后在客户端过滤`

这两条我**已在本插件适配层独立复现并规避**（`adapter.ts` 的 `WINDOW_LADDER`）。

**技能的授权引用（`SKILL.md`，原文照录）**：
> 服务器 `http://tfs2018-web.winning.com.cn:8080/tfs/`，集合 `WN_HIS`；
> **WIQL 日期格式必须 `YYYY-MM-DD`（不能带时间）**；
> **TFS 2018 不支持 `System.ClosedDate`/`System.ResolvedDate`，用 `System.ChangedDate` 替代**；
> **Git API 的 `fromDate`/`toDate` 在 TFS 2018 可能不工作，需客户端过滤**；
> `getChanges` 很耗时；创建工作项用 `{op:'add', path:'/fields/System.Title', value}`；
> 更新状态用 `{op:'replace', path:'/fields/System.State', value}`；提交关联工作项读 `commit.workItems`

---

## 3. 问题 2：TFVC 能力

### 3.1 TFVC 是什么、本插件用它做什么

TFVC（Team Foundation Version Control）是 TFS 的**集中式版本控制**（与 Git 并列）。
本插件通过 `adapter.ts:795-897` 暴露 4 个能力：

| 适配层方法 | 用途 | 读写 |
|---|---|---|
| `listChangesets(filter)` | 按作者/路径/日期/ID 范围列出变更集 | 读 |
| `getChangeset(id)` | 取单个变更集详情（作者/时间/说明） | 读 |
| `getWorkItemCommits(workItemId)` | 取工作项已关联的代码提交 | 读 |
| `linkChangeset(wiId, csId, ...)` | 把变更集关联到工作项（**当前走评论回写**） | 写 |

**它解决的真实问题**：需求/任务↔代码的可追溯性（"这条需求是谁改的、动了哪些文件"）。
对本插件（体检管理需求池）而言，这是**辅助能力，不在核心链路**
（核心链路是：列需求 → 认领 → 拆任务 → 改状态）。

### 3.2 是否必须依赖 tfs-mcp？—— **否，且有反证**

**反证**：技能 `SKILL.md` 与 `tools/*.mjs` 全文搜索 `tfvc|versioncontrol|changeset`，
**零命中**。即技能**从不调用 TFVC 能力**，却仍能完成它宣称的全部工作。

同时，技能依赖的 `azure-devops-node-api` 包里**存在完整的 `TfvcApi`**（42,624 字节 `.js` + 20,242 字节 `.d.ts`），
共 24 个公开方法：

```
createChangeset   getBatchedChangesets  getBranch      getBranchRefs   getBranches
getChangeset      getChangesetChanges   getChangesetWorkItems          getChangesets
getItem  getItemContent  getItemText  getItemZip  getItems  getItemsBatch  getItemsBatchZip
getLabel  getLabelItems  getLabels  getShelveset  getShelvesetChanges
getShelvesetWorkItems  getShelvesets  getTfvcStatistics
```

该 API 的内部实现（`TfvcApi.js`）通过 `getVersioningData(apiVersion, 'tfvc', '<resourceGuid>')`
解析路由 —— 也就是说，**它本质就是 REST 的封装**，无需 tfs-mcp。

### 3.3 技能里有对应 REST 方法吗？—— **有，且我已直接实测出全部端点**

我**没有照抄 GUID**（TFS 2018 的 `connectionData` 不吐路由表，见 §4.2），
而是按 Azure DevOps 公共约定**直接实测**——这比解析 GUID 更硬：

| 端点（基址 + 集合 + 路径） | `4.1` | `7.1` | 实测输出 |
|---|---|---|---|
| `GET /_apis/tfvc/changesets?$top=2` | **200** | 404 | `value.len=2` |
| `GET /_apis/tfvc/changesets?$top=1&orderby=Author` | **200** | — | `value.len=1` |
| `GET /_apis/tfvc/changesets/{id}` | **200** | 404 | 含 `changesetId/url/author/checkedInBy/createdDate/comment/_links` |
| `GET /_apis/tfvc/changesets/{id}/changes` | **200** | 404 | `value.len=5`（含条目 path/size/hashValue） |
| `GET /_apis/tfvc/branches` | **200** | 404 | `value.len=4` |
| `GET /_apis/tfvc/items?scopePath=$/` | **200** | 404 | `value.len=5` |
| `GET /_apis/tfvc/shelvesets` | **200** | 404 | `value.len=100` |
| `GET /_apis/tfvc/labels` | **200** | — | `value.len=0`（本集合无标签） |

**真实数据样本（原文照录）**：

```
GET /_apis/tfvc/changesets?api-version=4.1&$top=3 -> 200
changesets[0].keys = changesetId,url,author,checkedInBy,createdDate,comment
  changesetId  = 911644
  comment      = 郑州仁济多院区，areaid不同，从存储取
  createdDate  = 2026-09-19T04:59:11.947Z
  author       = {"displayName":"t_qy（唐求应)","uniqueName":"WINNING\\t_qy",
                  "id":"9a706b79-ffea-4869-87f9-d0fae8993439"}

GET /_apis/tfvc/changesets/911644/changes?api-version=4.1 -> 200  value.len=5
  changes[0].item = {"version":911644,"size":7245,
    "path":"$/体检管理/体检系统/5.X/5.2/代码/Interface/平台解耦2.0/
            Winning.Tjgl.Extension.WnESB/EsbHelper.cs", ...}
```

### 3.4 一个必须如实说明的落差

`GET /_apis/tfvc/changesets/{id}` 的详情响应里 **`changes` 与 `workItems` 都是空/不存在**：

```
changeset 911644 detail: 200
  keys      = changesetId,url,author,checkedInBy,createdDate,comment,_links
  changes   = 0
  workItems = 0
```

即**变更集→工作项的关联关系不在详情里**。要拿它需要：
- 改动清单 → 单独打 `GET /changesets/{id}/changes`（**已验证可用**）；
- 工作项关联 → 需另找 `getChangesetWorkItems` 对应端点，或反向从工作项侧查。

**因此 `linkChangeset` 的现有实现（走评论回写）在 REST 下依然是对的选择**，
但可以**升级**：关联评论里现在能带上**真实的改动文件清单**（从 `/changes` 拿），
比现在只带作者/时间/说明信息量大得多。

**当前设计文档 §7 风险表里「TFVC 在 REST 下需另找端点，找不到就下架」的判断不成立** ——
端点全部找到了，**不需要下架**。

---

## 4. 问题 3a：`connectionData` 身份探测（原设计唯一未实测项）

### 4.1 结论：**可用，通过**

```
GET /WN_HIS/_apis/connectionData          -> 200  ✅（不带 api-version）
GET /tfs/_apis/connectionData             -> 200  ✅（服务器根也可）

authenticatedUser.id                = 3ab5ed17-8763-4211-b092-5ef23d236c5d
authenticatedUser.providerDisplayName = zhangbo3(张波)      ← 身份在这里
authenticatedUser.displayName        = undefined            ← ⚠️ 坑：没有这个字段
authenticatedUser.uniqueName         = undefined            ← ⚠️ 坑：没有这个字段
authorizedUser.providerDisplayName   = zhangbo3(张波)
authorizedUser.descriptor            = System.Security.Principal.WindowsIdentity;S-1-5-21-...
authorizedUser.properties.Account.$value = zhangbo3
instanceId      = f5481b4a-9f84-4363-9ed9-03adb80b826b
deploymentId    (存在)
webApplicationRelativeDirectory (存在)
```

> ⚠️ **关键坑**：设计文档 §3.3 写的字段 `authenticatedUser.providerDisplayName / uniqueName`
> 只有**前一半对**。实测 `displayName` 与 `uniqueName` **都是 `undefined`**，
> 身份只存在于 **`providerDisplayName`**（格式 `账号(姓名)`，如 `zhangbo3(张波)`）。
> 更稳的来源是 `authorizedUser`（同时有 `providerDisplayName` 与 `properties.Account.$value`）。

### 4.2 两个反直觉的行为（**必须写进实现注释**）

**坑 1：加 `api-version` 反而 400**

```
GET /_apis/connectionData?api-version=4.1  -> 400  ❌
GET /_apis/connectionData                  -> 200  ✅
```

设计文档 §3.3 写的 `?api-version=4.1` 是**错的**。必须**裸调用**。

**坑 2：TFS 2018 的 `connectionData` 不返回路由表**

设计文档 §3.2 我没写过这条，但实现时若想"顺便拿路由表"会踩：

```
GET /_apis/connectionData -> 200，locationServiceData =
  {"clientCacheTimeToLive":86400,"defaultAccessMappingMoniker":"PublicAccessMapping",
   "lastChangeId":212993,"lastChangeId64":212993}
```

**没有 `serverCapabilities`**，加 `?locationServiceData=true&connectOptions=1&lastChangeId=-1`
也不返回。因此**不能靠位置服务自动发现路由**（新版 Azure DevOps 可以）。
→ 结论：**端点路径必须硬编码常量**（这正是我在 §3.3 直接实测而非解析 GUID 的原因）。

### 4.3 另一个"纯工具端点"的死路（提前排除，省一次踩坑）

```
GET /_apis/           -> 401  ❌（集合根与服务器根都是）
                        WWW-Authenticate: Basic realm="...", Negotiate, NTLM
```

**位置服务根端点在这个 TFS 2018 上不可访问**（401，不是 404）。
注意：**同一 PAT 下 `_apis/projects` 是 200**，所以这不是 PAT 问题，
而是该端点在此部署上不对外暴露。**不要在实现里依赖它。**

---

## 5. 问题 3b：写回端点

### 5.1 认证/权限语义（反向探针）

| 探针 | 实测 |
|---|---|
| 无 `Authorization` 头 → `GET /workitems/1980540` | **401** ✅ |
| 不存在的项目名 → `GET /不存在的项目XYZ/_apis/wit/workitemtypes` | **404 `Sorry, Page Not Found`** |
| 不存在的工作项 → `GET /workitems/999999999` | **404 `Sorry, Page Not Found`** |
| PATCH 不存在的字段 | **400 `TF51535: 找不到字段 No.Such.Field.XYZ。`** |

> 注意 404 的响应体是**HTML/纯文本 `Sorry, Page Not Found`**，不是 JSON。
> 错误归一逻辑必须先试 `JSON.parse` 再回落文本，否则会二次抛错。

### 5.2 乐观并发（rev test）—— **可用，但状态码是 412 不是 409**

```
# 探针 A：故意用错误 rev
PATCH /_apis/wit/workitems/1980540   Content-Type: application/json-patch+json
[{"op":"test","path":"/rev","value":999999},
 {"op":"add","path":"/fields/System.History","value":"probe"}]
-> 412
   {"$id":"1","innerException":null,
    "message":"VS403351: Test Operation for path /rev failed,
               value 8 was not equal to test value 999999.",
    "typeName":"...Patch.TestPatchOperationFailedException..."}

# 探针 B：正确 rev，只做 test（不改任何字段）
[{"op":"test","path":"/rev","value":8}]
-> 200  （返回完整工作项，rev 仍为 8 —— test 成功不产生新版本）✅

# 探针 C：对照，test 一个普通字段
[{"op":"test","path":"/fields/System.State","value":"活动"}]
-> 200  ✅
```

**三条结论**：

1. **`{"op":"test","path":"/rev","value":N}` 语义完全可用**，设计文档 D7 方向正确。
2. ⚠️ **并发冲突返回 `412 Precondition Failed`（不是 409）**，
   错误码 **`VS403351`**，消息形如 `Test Operation for path /rev failed, value <实际> was not equal to test value <期望>`。
   **设计文档 §5 错误表写的「409/400」要改成「412」**。
   → 归一化时按 `412` 判定「已被他人修改」，并可从消息里**正则抽出实际 rev**，直接告诉用户「当前已是 rev 8」。
3. **`test` 成功不递增 rev**（探针 B 验证），所以 rev 加锁是**无副作用**的，可以放心在每次写前加。

### 5.3 实测到的真实工作项（供写回测试造数据参考）

```
POST /_apis/wit/wiql?api-version=4.1
  SELECT [System.Id] FROM WorkItems
  WHERE [System.TeamProject]='体检管理' AND [System.WorkItemType]='需求'
  ORDER BY [System.ChangedDate] DESC
-> 200  命中 19186

GET /_apis/wit/workitems?ids=2029770,2031578,1980540&fields=...&api-version=4.1 -> 200
  id=1980540  rev=8  需求  活动    【操作日志】体检日志查询：修正初审操作人并补充缺失日志记…
  id=2029770  rev=2  需求  已建议  体检系统常规检查项目输入内容后，设置了节点规则，但是诊断…
  id=2031578  rev=4  需求  已建议  尿路上皮细胞无法关联问题
```

### 5.4 元数据端点复测（原设计已有，此处补更权威的样本）

```
GET /体检管理/_apis/wit/workitemtypes?api-version=4.1 -> 200  count=19
  类型：Bug / 代码评审请求 / 代码评审响应 / 长篇故事 / 特性 / 反馈请求 / 反馈响应 /
        任务 / 问题 / 更改请求 / 风险 / 需求 / 评审 / 测试用例 / 测试计划 /
        测试套件 / 共享步骤 / 共享参数 / 产品或项目计划

GET /体检管理/_apis/wit/workitemtypes/需求/states?api-version=4.1-preview -> 200
  状态：活动 / 已分析 / 已关闭 / 已建议 / 已解决 / 已验证
```

> ⚠️ **重要事实纠正**：`WN_HIS` 是**集合名，不是项目名**。
> `WHERE [System.TeamProject]='WN_HIS'` → `400 在层次结构中找不到指定的项目。该错误是由"'WN_HIS'"引起的。`
>
> **这解释了上一轮 `API-OTHERS` / `API-WINNING` / `CIS` 等项目的采样失败报错**
> —— 那些名字来自 `tfs_get_projects` 的硬编码表，其中一部分在真实实例上**并非合法项目名**。
> 改用 `GET /_apis/projects`（实测 62 项）作为唯一权威来源后，此类错误从根上消失。

---

## 6. 对设计文档的修订项（**共 6 处**）

| # | 位置 | 原文（错） | 改为（实测） |
|---|---|---|---|
| 1 | §3.2 D7 | `PATCH ...?api-version=7.1` | `?api-version=4.1` |
| 2 | §5 错误表 | 写回 rev 冲突 `409/400` | **`412`** + `VS403351` |
| 3 | §3.3 | `?api-version=4.1` 的 connectionData | **裸调用**，带 api-version 会 400 |
| 4 | §3.3 | 身份字段 `providerDisplayName / uniqueName` | 只有 **`providerDisplayName`**；`uniqueName` 为 undefined；建议优先读 `authorizedUser` |
| 5 | §3.3 警示框 | 「唯一未实测项」 | **已实测通过**，警示盒删除或改为「坑位提示」 |
| 6 | §7 风险表 | TFVC「找不到端点则下架」 | **端点全部实测可用**，不下架；改为「工作项↔变更集关联不在详情内，linkChangeset 仍走评论回写，但可附带真实改动清单」 |

另：§4.3 关于 `tool-catalog.ts` 的「不预设结论」，现按 §2.4 结论**改为「保留结构、改语义」**。

---

## 7. 附：探针可复现命令

所有命令用绝对路径 node（本机 `PATH` 被 shim 污染，`node` 不在精简 PATH 内）：

```bash
NODE="C:/Users/user/.workbuddy/binaries/node/versions/22.22.2-3/node.exe"
```

```js
// 通用骨架
const base='http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS';
const pat='<PAT>';
const auth='Basic '+Buffer.from(':'+pat).toString('base64');
const r = await fetch(base + '<PATH>', { headers: { Authorization: auth } });
```

| 探针 | PATH |
|---|---|
| 身份 | `/_apis/connectionData`（**不带 api-version**） |
| 项目清单 | `/_apis/projects?api-version=4.1&$top=1000` |
| 项目工作类型 | `/体检管理/_apis/wit/workitemtypes?api-version=4.1` |
| 类型状态 | `/体检管理/_apis/wit/workitemtypes/需求/states?api-version=4.1-preview` |
| WIQL | `POST /_apis/wit/wiql?api-version=4.1` |
| 批量取项 | `/_apis/wit/workitems?ids=1,2&fields=...&api-version=4.1` |
| 变更集列表 | `/_apis/tfvc/changesets?api-version=4.1&$top=2` |
| 变更集改动 | `/_apis/tfvc/changesets/911644/changes?api-version=4.1` |
| TFVC 分支 | `/_apis/tfvc/branches?api-version=4.1` |
| TFVC 条目 | `/_apis/tfvc/items?scopePath=$/&api-version=4.1` |
| TFVC 搁置集 | `/_apis/tfvc/shelvesets?api-version=4.1` |
| 写回 | `PATCH /_apis/wit/workitems/{id}?api-version=4.1`，`application/json-patch+json` |

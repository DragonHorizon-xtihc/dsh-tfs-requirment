# Plan 003：需求池/任务中心体验增强、拆解修复、技能目录补全与 34 个契约端点接入

日期：2026-09-20
状态：已实现并通过离线验收（verify）。2026-09-20 晚独立复核：三段 tsc 退出码 0、
vitest 35 文件 / 556 tests 全绿、build 通过（lib/client.js 223.21 kB）；
构建产物 catalogView 实测 49/49、missingCount=0；presets 模块可解析、用户级技能目录实存 96 个。
关联：`./spec.md`

> 实现期修订（2026-09-20）：本计划原写"deleted 任务按 seq 续号新建"，读 `decompose.ts`
> 后被证伪——任务 id 是确定性后缀 `${requirementId}#analyze|#impl|#verify`，根本不存在序号机制，
> 续号无号可续。实际实现改为**复活重建**（见 A.3 与「关键决策记录」修订条）。其余偏差在各节以
> 「实现」注记标明。

## 设计原则与沿用

- 宪法七层与目录纪律不变：纯逻辑下沉（core/shared），宿主编排（host），客户端零 Node 依赖。
- JSON 为权威：新增两类落盘文件均原子写、损坏可恢复（ui-state 损坏回退默认；query-options 损坏按"无文件"处理并允许重新采集）。
- 写操作（还原、删除、update_workitem、附件上传、PR 写、set_collection）一律经 `WriteGuard` + 审计。
- 新 REST 分支沿用 `rest-client.ts` 的 fetch 封装与 `adapter.ts` 的 `safeError`/凭据擦除；
  测试沿用 `tests/helpers/fake-rest.ts` 的 URL 子串路由桩。

## 文件级改动清单

### A. 共享契约与纯逻辑

1. **`src/shared/contracts.ts`**
   - `RequirementSummary` 增 `analysis?/dataStructure?/config?`（HTML 已转纯文本）。
   - 新增 `QueryOptionsCacheFile`（`{ [collection]: { data: QueryOptionsResponse; savedAt: string } }`）。
   - 新增 `UiStateFile`（`{ [collection]: UiState }`）与 `UiState`：
     `{ poolFilters?: { projectId?; types?; states?; assignedTo? }, poolPageSize?, claimedPageSize?, taskPageSize? }`。
   - `DecomposeResult` 增 `created/skipped` 计数（reason 据实生成）。
   - 新增响应类型：`DeleteTasksResult`、`RestoreResult`、`EnrichResult`、`CollectOptionsResult`。

2. **`src/shared/pool.ts`**
   - `buildTargetFill(req)` 改四段分节拼接（详细信息/需求分析/数据结构/需求配置），
     抽出纯函数 `buildSections(req): Array<{heading; text}>` 便于单测；总长度上限 4000，
     每节按剩余预算截断，截断标记只出现一次。

3. **`src/core/board/decompose.ts` + `board.ts`**（实现：复活重建，非续号）
   - 任务 id 是确定性后缀 `${requirementId}#analyze|#impl|#verify`，**无序号机制**，
     故不存在"续号"。`decomposeTasks(drafts)` 实际语义：
     - 同 id 不存在 → 新建；
     - 同 id 存在且 `state==='deleted'` → 先删该 id 的历史记录，再按草稿**原地复活重建**为全新
       pending 任务（revision 归零、execState 清空）；
     - 同 id 存在且为其他状态 → 跳过。
   - 返回 `{ created: TaskSnapshot[]; skipped: string[] }`；服务层据此生成三种中文 reason
     （新增 N / 新增 N 跳过 M / 全部跳过）。
   - `BoardEngine` 新增：
     - `deleteTasks(state, ids: string[]): string[]`：**整批门禁**（全部存在且全部 deleted，
       否则带 id 列表整批拒绝）；删任务、级联清理其他任务 `blockedBy` 中的悬挂引用。
     - `restoreRequirement(state, key): string[]`：门禁（需求须在池、名下无任何非 deleted 任务，
       否则报"请先取消"）；删需求 + 其 deleted 任务 + blockedBy 级联，返回被清理任务 id。
   - 两方法走既有 `mutate`/落盘路径。

4. **`src/tfs/tool-catalog.ts`**：无新增操作（49 个 raw 已在表内），仅把
   `tfs_set_collection/tfs_update_token/tfs_list_collections` 等描述与实际行为对齐
   （set_collection/update_token 标注"本地/进程内"，list_collections 标注兜底语义）。

### B. 宿主半

5. **`src/tfs/rest-client.ts`** 扩展最小面：
   - `TfsRestRead`：`serverGetJson(path)`（只拼 baseUrl，不拼集合，用于 projectCollections）、
     `getBlob(pathOrUrl)`（返回 `{ status, buffer, contentType, disposition }`，附件/文件下载）。
   - `TfsRestWrite`：`postJson(path, body)`（PR 创建/评论线程）、
     `uploadBinary(path, buffer, fileName)`（实现：`POST _apis/wit/attachments?fileName=<enc>`，
     octet-stream 原始字节体，**无 `uploadFile=true`**——探针实测该参数在 TFS 2018 (api 4.1) 不需要；
     返回 `{id,url}` 后再 PATCH `workitems/{id}` 的 `/relations/-` 挂 AttachedFile）。
   - 私有 `request` 增加 method/原始 body/contentType 透传，错误形状不变。

6. **`src/tfs/adapter.ts`**
   - `normalizeWorkItem`：增 `Winning.Demand.Analysis / Winning.Data.Design / Winning.Demand.Config`
     三字段（htmlToPlainText + 既有上限）。
   - 构造参数增 `knownCollections?: string[]`；增 `runtimePat?: string` 字段与
     `updateToken(pat)`（进程内覆盖，restFor 合并 PAT）；`setCollection` 已有，补公开包装。
   - 新增 `removeTags(id, tags[], collection?)`：先 GET 当前 `System.Tags`，剔除后 PATCH 整串。
   - 34 个分支在 `call()` 分派表内补齐（实现为私有方法 + 薄分支，保持 call() 可读性）：
     - WIQL 族复用 `queryByWiql + batchWorkItems + normalizeWorkItem`：
       customer（`Winning.Custom.Name =`）、recent_resolved、bugs、search（CONTAINS + 414 兜底）、
       custom_query（条件→WIQL 构造器，放 `src/tfs/wiql-builder.ts` 纯函数）、
       run_saved_query（`POST /{project}/_apis/wit/wiql/{id}`）。
     - relations/attachments：`$expand=relations` 过滤；上传走 uploadBinary + PATCH 关系；
       下载用 getBlob + `fs/promises` 写 `downloads/`（路径穿越防护，文件名重名加序号）。
     - TFVC：branches/items/item/file/changes/changeset-workItems/zip 下载。
     - Git：repos/refs/stats/commits/diffs/pullrequests 及子资源、threads/POST、pullrequests/POST。
     - 版本不支持（如 Git commit workItems 404）统一抛「TFS 版本不支持该端点：…」。
   - `implementedOperations` 随分支自动覆盖全部 49 个 raw。
   - 写分支（update_workitem/upload_attachment/create_pr/add_pr_comment）
     保持"只在 executeWrite 内生效"的现状约定。
   - 实现偏差（记录在案）：`tfs_set_collection/tfs_update_token` 为纯本地/进程内副作用，
     在 `call()` 内直接完成、**未走 executeWrite 审计**（不触达 TFS，无外部副作用）；
     与原计划"仍按写操作过门禁审计"有出入，后续如需审计本地配置变更可单独补审计事件。

7. **`src/host/board-service.ts`**
   - 删除进程内 `queryOptionsCache` Map；新增两个 `JsonStore`：
     `query-options.json`、`ui-state.json`（构造注入，测试可传 memfs）。
   - `loadQueryOptions(collection)`：读文件（损坏按 null 处理并记 warn）。
   - `collectQueryOptions(collection?)`：adapter 采集 + 原子落盘 + 返回。
   - `loadUiState(collection)` / `saveUiState(collection, patch)`（深合并单集合节点）。
   - `decompose` 透传 created/skipped；新增 `deleteTasks(taskIds)`、
     `restoreRequirement(key)`（引擎删除后 best-effort `adapter.removeTags(id,['dsh'])`，
     失败回带 tagWarning 不抛）、`enrichRequirement(key)`（重取 getRequirement 合并回
     state.requirements，保留 claimedAt/role/skills/notes/target 等本地字段）。

8. **`src/host/api.ts`**：HostApi 接口与 createHostApi 透传新方法（纯编排）。

9. **`src/host/route.ts`** 新增路由（实现注册前缀为 `/tfs-requirment/...`，GET 统一用宿主
   currentCollection，忽略 query 里的 collection）：
   - `GET  query-options-load`（只读盘，不触发采集）
   - `POST query-options-collect`（body `{ collection? }`，采集并落盘）
   - `GET/POST ui-state` 同路径：POST body **即补丁本身**（非 `{collection?, patch}` 包裹），
     服务端白名单只取 `poolFilters`（整体透传）与三个数字 pageSize 键，未知键丢弃，
     非数字 pageSize 忽略；非法 JSON 返回 200 + `{ok:false}` 不 500。
   - `POST tasks/delete`（body `{ taskIds: string[] }`，类型校验在路由、整批门禁在服务层）
   - `POST requirements/restore`、`POST requirements/enrich`（body `{ requirementKey }`）
   - 既有 `GET query-options` 保留兼容（采集通道），读盘优先后续以 load 路由为准。

10. **`src/host/dsh-catalog.ts`**（实现）
    - `collectSkills`：先全局 `skills.list({})`，再动态 `await import('@deepseek-ai/dsh-agent-presets')`
      取 `livePresetMounts()`（无参调用）；对每个 mount 的 **`key`**（`PresetMount.key: ScopeKey | undefined`，
      该包类型里没有 scopeKey 字段）用 Set 去重后调 `skills.list({scope: key})`；
      非对象/undefined/原始值 key 跳过；按技能名并集去重，**全局层优先**。
    - 动态 import 失败或任一作用域 list 抛错：try/catch 记 warning 降级（至少返回全局层）。
    - 缓存键不变；刷新按钮天然重算。

11. **`src/index.ts`**：构造 adapter 时注入 `knownCollections: config.collections`；
    新 stores 经 dataDir 装配；package.json 增可选依赖 `@deepseek-ai/dsh-agent-presets`。

### C. 客户端半

12. **`src/client/api.ts`**（浏览器侧 bridge，文件内同名 const api 对象）增：
    `loadQueryOptions/collectQueryOptions/loadUiState/saveUiState/deleteTasks/restoreRequirement/enrichRequirement`。

13. **`src/client/hooks/usePagination.ts`（新）**：通用分页 hook
    （`page,pageCount,setPage,resetPage,paginate,rangeStart,rangeEnd`；pageSize 受控由调用方持久化，
    筛选/集合变化由调用方调 resetPage 回第 1 页）。分页数学另抽纯函数
    `normalizePageSize/pageCountFor/clampPage/paginateSlice/pageRange` 供单测（tests/pagination.spec.ts）。
    配套 `src/client/components/PaginationBar.tsx`（新）：三档常量
    POOL=[10,20,50,100] 默认 20、CLAIMED=[5,10,20,50] 默认 10、TASK=[10,20,50,100] 默认 20。

14. **`src/client/components/RequirementPool.tsx`**
    - 可选项：挂载/切集合先 `loadQueryOptions`，无缓存才采集并落盘；工具栏增「采集可选项」按钮。
    - 筛选初始值来自 ui-state（options 到达后应用，失效值静默丢弃）；变更即 `saveUiState`（防抖 300ms）。
    - 列表接 usePagination（10/20/50/100，默认 20），分页栏组件 `PaginationBar`（新，共享给任务中心）。
    - 领取成功后除现有 reloadBoard 外，调 `onClaimed()` 通知任务中心（见 slots tick）。

15. **`src/client/components/TaskCenter.tsx`**
    - 已领取需求卡片分页（5/10/20/50，默认 10）；任务表分页（10/20/50/100，默认 20）；pageSize 持久化。
    - 需求卡片增「还原到需求池」（确认弹窗，复用 window.confirm 风格一致的内联 confirm）。
    - 任务表增复选框列（仅 deleted 可选）、表头全选（当前筛选+当前页内已取消）、
      批量条「删除所选（n）」；每行已取消任务增「删除」。
    - 拆解/重拆：`run` 中 await `onRefresh()`，成功文案取服务端 reason；卡片自动展开新任务。
    - 监听 `refreshTick`：领取/还原/删除导致需求集合变化时回到第 1 页。

16. **`src/client/components/ExecutionPanel.tsx`**
    - `buildTargetFill` 用 pool.ts 新四段拼接；useEffect 依赖加入 analysis/dataStructure/config。
    - 需求详情弹窗（RequirementPool 内）展示四段。

17. **`src/client/slots.tsx`**
    - Tab 保活：五个面板全部挂载，外层容器 `display: active? 'flex':'none'`；
      面板内部不感知显隐（数据请求只发生在各自 mount 与集合切换）。
    - `handleTargetChange`：先 `enrichRequirement` → reloadBoard → setTargetId。
    - `refreshTick`：claim/restore/delete/enrich 成功后自增并下发 TaskCenter。

### D. 测试（vitest，fake-rest + memfs）

18. 新增/扩展（实际落盘的测试文件）：
    - `tests/board-lifecycle-003.spec.ts`（新，26 tests）：引擎 decomposeTasks
      （新建/全取消复活/部分在办计数/需求不存在）、deleteTasks（不存在与非 deleted 整批拒绝带 id、
      空数组、全删 + 跨需求 blockedBy 级联）、restoreRequirement（门禁与级联）；BoardService
      三 reason、deleteTasks、restore（removeTags/tagWarning 降级）、query-options 落盘/全空不落盘/
      损坏返 null、ui-state 浅合并与 poolFilters 整体替换/两集合隔离/损坏返 {}、enrich 四段回写保留 workspace。
      （原计划的 query-options-store/ui-state/board-restore-delete 三文件合并于此。）
    - `tests/tfs-endpoints-34.spec.ts`（新，41 tests）：IMPLEMENTED_OPERATIONS=49、集合 3、WIQL 族 7、
      附件 4（含上传两步端点、下载 safeBasename/safeJoin 防穿越）、TFVC 6、Git 7、PR 7；
      写端点经 wrappedWrite 未确认零请求；normalizeWorkItem 四段 HTML→纯文本/空段不写键。
    - `tests/dsh-catalog-skills-scope.spec.ts`（新，4 tests）：全局+作用域并集排序、全局优先、
      重复 scope 只 list 一次、非法 key 跳过、单作用域抛错降级、livePresetMounts 抛错降级全局层。
    - `tests/pagination.spec.ts`（新，6 tests）：分页纯函数（兜底/夹回/切片/序号区间）。
    - 更新 `tests/pool.spec.ts`：四段段头格式、四段齐全/空段跳过。
    - 更新 `tests/host-route.spec.ts`（49 tests）：六条新路由（读盘/采集/GET·POST ui-state 白名单/
      非法 JSON/restore·enrich 校验/task-delete 类型校验）。
    - 更新 `tests/host-api.spec.ts`：缓存语义整体改为**落盘优先**（真 BoardService+memfs）。
    - 更新 `tests/e2e.spec.ts`：decompose await + created/skipped 断言。
    - 既有 `tfs-contract/tfs-list-contract/health/board-service` 等断言随契约动态对齐，无需手改计数。
    - `tests/helpers/fake-rest.ts` 扩展二进制响应形态 `{raw,contentType?,status?}`（供下载测试）。

## 关键决策记录

- **删除=本地看板清理**：TFS 2018 REST 无工作项销毁接口；「已取消」是 TFS 终态。
- **重新拆解=复活重建（修订，原"续号"决策被代码证伪）**：任务 id 是确定性后缀
  `${requirementId}#analyze|#impl|#verify`，没有序号机制，"续号"无号可续。实现为：同 id 的
  deleted 任务先清除历史记录、再按草稿原地重建为全新 pending（revision 归零）；在办任务跳过。
  审计连续性由 board.json 的事件历史（persist 记录 task-delete/task-create）保留，看板当前态不回卷。
- **还原不强制删 TFS 标签**：标签仅为本地领取标记与辅助查询，移除失败不阻断（与 002 领取标签失败不阻断对称）。
- **技能目录用作用域并集而非自行扫盘**：复用 dsh 注册表面对 frontmatter/调用策略的全部校验，
  与 dsh 自身结果天然一致；动态 import 保证包缺失时可降级。
- **分页在客户端**：WIQL $top=500 已覆盖真实规模；服务端分页需改两段式查询契约，收益不抵风险。
- **projectCollections 404 兜底**：该部署 TFS 2018 不提供此路由（实测全版本 404），
  返回配置内集合清单并标注来源，不伪称 REST 枚举成功。

## 风险与回滚

- 保活后五面板同时挂载，首屏多一次各面板 mount 请求；通过"面板首次激活才挂载"（lazy mount +
  挂载后保活）避免首屏放大。
- 34 个端点中 PR/附件上传等写路径无法在只读探针下实测，以微软 TFS 2018 (api 4.1) 文档形状实现
  并由 fetch 桩锁定；上线后若个别路由版本差异，错误经 safeError 可读返回，不影响其他操作。
- 回滚：本变更不改动既有文件格式（仅增字段/增文件），回退代码后旧 board.json 仍可读。

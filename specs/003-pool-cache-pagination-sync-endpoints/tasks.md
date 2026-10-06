# Tasks 003：需求池/任务中心增强、拆解修复、技能补全、34 端点接入

> 约定：[x] 完成；[ ] 待做。
> 验证命令：`npx tsc --noEmit -p tsconfig.host.json` / `tsconfig.client.json` / `tsconfig.tests.json`、
> `npm test`（vitest run）、`npm run build`。
> 最终状态（2026-09-20 晚，独立复核 verify）：三段 tsc 全绿；**35 个测试文件 / 556 tests 全绿**；
> build 通过（lib/client.js 223.21 kB）。另用构建产物离线核验：catalogView rawCount/wrappedCount=49、
> missingCount=0 且契约表与实现集双向无孤项；presets 模块可解析、livePresetMounts 为函数、
> `~/.agents/skills` 实有 96 个用户级技能目录；已清理临时便签 zz_check.txt 与 0 字节 tsc 日志。

## 阶段一：契约与纯逻辑（core/shared）

- [x] T1 `src/shared/contracts.ts`
  - RequirementSummary 增 `analysis?/dataStructure?/config?`
  - 增 `QueryOptionsCacheFile`、`UiState`/`UiStateFile`、decompose `created?/skipped?`、
    `DeleteTasksResult`、`RestoreResult`、`EnrichResult`、`CollectOptionsResult` 类型
  - HostBridge/HostApi 七方法、六条路由常量；UiState.poolFilters 扩展 `projects?:string[]`、
    `assigneeUnlimited?:boolean`（projectId 标 @deprecated 兼容）
- [x] T2 `src/shared/pool.ts`：`TARGET_SECTIONS`/`targetSections(req)`、`composeTargetDescription(max=4000)`
  （单截断标记）、`buildTargetFill` 四段拼接（【详细信息】【需求分析】【数据结构】【需求配置】，空段跳过）、
  `shouldCacheQueryOptions`
- [x] T3 `src/core/board/board.ts`：`decomposeTasks(drafts)` —— **实现修订为复活重建**
  （任务 id 为确定性后缀 `#analyze/#impl/#verify`，无序号机制）：不存在→新建；deleted→清历史后原地
  重建为全新 pending；其他状态→跳过；返回 `{created, skipped}`
- [x] T4 `src/core/board/board.ts`：`deleteTasks(ids)`（整批门禁：全部存在且全部 deleted，否则带 id
  整批拒绝；级联清 blockedBy 悬挂引用，返回 ids）、`restoreRequirement(key)`（门禁：需求在池且名下无
  非 deleted 任务；删需求+其 deleted 任务+blockedBy 级联；返回被清理任务 id）
- [x] T5 `src/tfs/wiql-builder.ts`（新纯函数）：WiqlConditions/wiqlEscape/buildWiql；
  端点测试经 custom_query 等分支间接覆盖

## 阶段二：REST 客户端与适配层（34 端点 + 字段 + 标签 + token）

- [x] T6 `src/tfs/rest-client.ts`：request 支持 PUT/原始 body/contentType/绝对 URL/服务器级；
  `requestBlob`、`serverGetJson/postJson`、`getBlob`、`write.postJson/uploadAttachment`
  （`POST attachments?fileName=<enc>` octet-stream，**无 uploadFile=true**）
- [x] T7 `src/tfs/adapter.ts`：normalizeWorkItem 捕获三个 Winning 字段（richField，空串不写键）；
  构造增 knownCollections/downloadsDir；runtimePat/updateToken；公开 `removeTags`
  （GET System.Tags 后 PATCH 整串，不经 WriteGuard）
- [x] T8 工作项查询族 7 分支：by_customer、recent_resolved、bugs（含中文"缺陷/已关闭"）、relations、
  custom_query（wiql-builder，返回 {total,returned,workItems}）、search（ASCII CONTAINS，
  非 ASCII 失败时客户端兜底：近 365 天 $top500 后标题/描述过滤）、run_saved_query（项目级 wiql/{id}）
- [x] T9 附件 4 分支：list_attachments、upload_attachment（两步：attachments 上传 → PATCH relations/-
  AttachedFile，写门禁）、download_attachments（getBlob 落盘 downloads/，safeJoin/safeBasename 防穿越）
- [x] T10 TFVC 6 分支：tfvc_branches（includeChildren=false）、tfvc_items（OneLevel 分组）、tfvc_item、
  tfvc_file（download=true）、changeset_changes（changesets/{id}/changes）、download_tfvc_files（保留目录结构）；
  check_commit_work_items 走 changesets/{id}/workItems
- [x] T11 Git/PR 分支：list_repos/get_repo、list_branches（refs?filter=heads）/get_branch（stats，
  分支不存在可读错误）、get_commits（$top）、get_branch_diffs（commitsbatch body，接受分支名）、
  list_prs/get_pr/get_pr_commits/get_pr_diffs（iterations/{iid}/changes）/get_pr_workitems（404 可读
  "TFS 2018 不支持"）、add_pr_comment（无 thread→POST threads {comments,status:1}；有→threads/{id}/comments）、
  create_pr（裸分支名自动补 refs/heads/，workitems 关联 best-effort 404 仅告警）
- [x] T12 集合 3 分支：list_collections（先服务器级 REST，404 回落 knownCollections，
  返回 source:'rest'|'local-config'）、set_collection、update_token（call() 内本地/进程内副作用）
- [x] T13 update_workitem 分支（fields map → JSON-PATCH add/replace，写门禁）
- [x] T14 `IMPLEMENTED_OPERATIONS` 覆盖全部 49 raw（测试断言 size===49）；tool-catalog 表 49 条与描述对齐；
  启动日志"契约表登记 N 条，已全部接入"

## 阶段三：宿主服务与路由

- [x] T15 `src/host/board-service.ts`：query-options.json / ui-state.json 两个 JsonStore；
  loadQueryOptions（损坏按 data=null）/collectQueryOptions（shouldCacheQueryOptions 门禁、全空不落盘）；
  loadUiState（损坏返 {}）/saveUiState（单集合节点浅合并、poolFilters 整体替换、两集合隔离）
- [x] T16 board-service：decompose 重写（引擎 + 三种中文 reason + created/skipped，persist 落事件）；
  deleteTasks（sync，persist 'task-delete'）；restoreRequirement（async，引擎后 best-effort
  adapter.removeTags([defaultLabel])，失败回带 tagWarning 不抛，persist 'requirement-restore'）；
  enrichRequirement（重取四段并保留旧 workspace，persist 'requirement-enrich'）；
  BoardTfsPort 扩可选 removeTags?/getQueryOptions?；summary↔requirement 双向携带三段字段
- [x] T17 `src/host/api.ts`：七方法接口与实现；queryOptions **读盘优先** + inflight 去重 +
  看板缺失回落 adapter 直采；decompose async 透传 created/skipped/reason；restore/enrich/deleteTasks 入参校验
- [x] T18 `src/host/route.ts`：六个 handler 工厂 + 六条 /tfs-requirment/ 路由注册；
  createDecomposeHandler 改 async await；uiState POST 白名单（poolFilters 整体 + 三数字 pageSize）；
  GET 类统一用宿主 currentCollection()
- [x] T19 `src/host/dsh-catalog.ts`：collectSkills 全局层 + livePresetMounts() 各 mount.key
  作用域并集（动态 import，Set 去重，同名全局优先，非法 key 跳过，单作用域失败 warning 降级）
- [x] T20 `src/index.ts`：adapter 注入 knownCollections=allowedCollections、downloadsDir=dataDir/downloads；
  package.json peerDependencies 已含 @deepseek-ai/dsh-agent-presets，无需新增

## 阶段四：客户端

- [x] T21 `src/client/slots.tsx` 内 HttpHostBridge：增 loadQueryOptions/collectQueryOptions/
  loadUiState/saveUiState/deleteTasks/restoreRequirement/enrichRequirement（全 try/catch 降级）
- [x] T22 `src/client/hooks/usePagination.ts`（新，含可单测纯函数）+
  `src/client/components/PaginationBar.tsx`（新，三档常量，total=0 返回空）
- [x] T23 RequirementPool：模块 Map 缓存 → loadQueryOptions 读盘 → getQueryOptions 三级；
  水合完成前禁止回写（hydratedRef）；「采集可选项」按钮 + 缓存时间提示；采集中/失败保留旧数据
- [x] T24 RequirementPool：筛选从 ui-state 恢复（失效值静默丢弃）、变更防抖 300ms 落盘；
  分页（WIQL top=500 客户端切片，默认 20，10/20/50/100），筛选/集合变化回第 1 页；
  详情弹窗四段正文；指派人空且非不限默认 defaultAssignee
- [x] T25 slots.tsx：五面板 lazy mount（pool 默认挂载，其余首次访问挂载）+ 保活
  （非活动 display:none/aria-hidden）；setTab 包装；error 改顶部红条不卸载面板；
  chooseTarget 先 enrichRequirement（失败降级列表项）→ await reloadBoard → setTarget → 跳 exec；
  领取/派发后 await reloadBoard（实时刷新由 reload 完成态承担）
- [x] T26 TaskCenter：已领取需求分页（默认 10，5/10/20/50）、任务表分页（默认 20，10/20/50/100），
  三个 pageSize 各自落盘；数据集合变化回第 1 页（拆解后 resetTaskPage）
- [x] T27 TaskCenter：还原红色按钮 + 门禁 confirm；tagWarning 以 tone:'warn' 可见
- [x] T28 TaskCenter：复选框列仅 deleted 可勾；表头全选作用域为跨页全部已取消；批量删除条 +
  单行删除 confirm；快照刷新后 useEffect 剪失效勾选；按钮显示在办/已取消计数
- [x] T29 TaskCenter：run() await onRefresh，成功文案用服务端 reason（问题 9/10）
- [x] T30 ExecutionPanel：`buildTargetFill(data.target)` 四段生效；需求详情弹窗四段展示

## 阶段五：测试

- [x] T31 pool.spec：四段段头格式/四段齐全/空段跳过/截断（22 tests）；
  normalize 三段 Winning 字段由 tfs-endpoints-34 的 normalizeWorkItem 用例锁定
- [x] T32 board-lifecycle-003.spec（新，26 tests）：复活重建 + 计数；还原门禁与清理；
  删除门禁/跨需求 blockedBy 级联/空数组/整批拒绝带 id
- [x] T33 落盘语义并入 board-lifecycle-003：query-options 落盘/读盘优先/覆盖/全空不落盘/损坏降级；
  ui-state 浅合并/poolFilters 整体替换/两集合隔离/损坏返 {}；host-api.spec 按落盘优比重写（24 tests）
- [x] T34 dsh-catalog-skills-scope.spec（新，4 tests）：作用域并集去重、全局优先、重复 scope 只 list 一次、
  非法 key 跳过、单作用域与动态 import 失败降级
- [x] T35 tfs-endpoints-34.spec（新，41 tests）：每类端点 URL/方法/体形状；写端点经 wrappedWrite
  未确认零请求；下载文件名/目录安全；commits/{id}/workItems 404 可读错误
- [x] T36 host-route（49 tests，新增六路由块）/host-api/e2e（decompose async）受影响断言已更新；
  tfs-contract/tfs-list-contract/health 随契约动态对齐，全量转绿
- [x] T37 pagination.spec（新，6 tests）：分页纯函数兜底/夹回/切片/序号区间；
  usePagination hook 本身为薄 React 状态壳

## 阶段六：验证与交付

- [x] T38 三段 tsc（host/client/tests）全部退出码 0
- [x] T39 `npm test` 全绿：35 文件 / 556 tests
- [x] T40 `npm run build` 通过；lib/client.js 含新模块（约 223 kB）
- [x] T41 README 更新（落盘缓存文件、筛选记忆、Tab 保活、分页档位、还原、删除、技能并集、49 端点）；
  plan.md 续号→复活重建决策已回写
- [x] T42 清理临时探针/补丁脚本；交付说明含"写端点未对真实 TFS 实测"的诚实声明
  （以微软 TFS 2018 api 4.1 文档形状实现 + fetch 桩锁定）

## 记录在案的偏差（不阻塞）

1. **重新拆解**：plan 原写"deleted 续号新建"，实现为复活重建（任务 id 确定性后缀，无序号），已回写 plan。
2. **set_collection/update_token 审计**：二者为纯本地/进程内副作用，在 adapter.call() 内直接完成、
   未过 executeWrite 审计（不触达 TFS）；如需审计本地配置变更可后续补审计事件。
3. **写端点实测范围**：PR 创建/评论、附件上传、update_workitem 等写路径未对真实 TFS 试写，
   仅以文档形状 + 写门禁测试（未确认零请求）锁定；读端点经探针/测试桩验证。

## 验收复核记录（verify，2026-09-20 晚）

独立重跑（非沿用实现期结论）：

- [x] V1 `tsc --noEmit -p tsconfig.host.json` → 退出码 0
- [x] V2 `tsc --noEmit -p tsconfig.client.json` → 退出码 0
- [x] V3 `tsc --noEmit -p tsconfig.tests.json` → 退出码 0
- [x] V4 `npx vitest run` → **35 文件 / 556 tests 全绿**（含 tfs-endpoints-34 41、
      board-lifecycle-003 26、host-route 49、pool 22、pagination 6、dsh-catalog-skills-scope 4）
- [x] V5 `npm run build` → 通过，lib/client.js 223.21 kB（gzip 54.51 kB）
- [x] V6 构建产物离线核验 `catalogView(IMPLEMENTED_OPERATIONS)`：
      rawCount=49、wrappedCount=49、missingCount=0；契约表 49 与实现集 49 **双向无孤项**
      （连接与凭据页缺口行在 missingCount=0 时不渲染）
- [x] V7 问题 12 数据源核验：`@deepseek-ai/dsh-agent-presets` 解析到
      packages/preset/agent-presets/lib/index.js，`livePresetMounts` 为函数；
      `~/.agents/skills` 实有 96 个技能目录、`~/.dsh/skills` 1 个。
      离线无存活 agent 时 livePresetMounts()=0 属预期（挂载随 standard preset 运行期注册），
      真实 web 应用中按 mount.key 作用域并集即覆盖用户级技能。
- [x] V8 代码走查 13 项需求落点：读盘优先+采集按钮（FR-101~104）、ui-state 记忆（FR-201~203）、
      五面板 lazy mount + display:none 保活（FR-301/302）、三处分页栏与档位、
      领取/拆解 await reloadBoard、还原门禁+tagWarning、删除整批门禁+blockedBy 级联+复选框批量、
      decomposeTasks 复活重建与真实计数、enrich+四段 buildTargetFill、技能作用域并集降级。
- [x] V9 清理临时残留：删除 zz_check.txt（清理便签）与三个 0 字节 .tsc-*.log（.gitignore 已覆盖 *.log）。

### 仍需在真实运行环境人工确认（离线无法覆盖，已在 spec 非目标/偏差中声明）

1. 浏览器内五 Tab 切换的网络面板"无重复请求"、滚动位置/勾选保持（需启动 dsh web 宿主肉眼验收）。
2. 对真实 TFS 的**写**端点（create_pr / add_pr_comment / upload_attachment / update_workitem）
   未试写；读端点与集合 404 兜底已经只读探针 + fetch 桩锁定。
3. 技能下拉在真实 standard agent 存活时展示的用户级技能条数（代码路径与 dsh 自身
   `skills.list({ scope })` 一致，单测锁定并集/去重/降级）。

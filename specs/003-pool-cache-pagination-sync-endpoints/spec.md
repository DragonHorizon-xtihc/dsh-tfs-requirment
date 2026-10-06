# Spec 003：需求池/任务中心体验增强、拆解修复、技能目录补全与 34 个契约端点接入

日期：2026-09-20
状态：已实现并通过离线验收（verify）。独立复核（2026-09-20 晚）：三段 tsc 退出码 0、
vitest **35 文件 / 556 tests 全绿**、`npm run build` 通过（lib/client.js 223.21 kB）；
构建产物实测能力目录 rawCount=49 / wrappedCount=49 / missingCount=0（两集合完全对齐）；
`@deepseek-ai/dsh-agent-presets` 可解析并导出 `livePresetMounts`，`~/.agents/skills` 实有 96 个
用户级技能目录（离线无存活 agent 时 mounts=0 为预期，真实 web 应用 standard preset 挂载后并集生效）。
前置：001（REST 化）、002（需求池三项修复）

> 实现期修订：FR-901 原设计"按 seq 续号新建"被代码证伪（任务 id 为确定性后缀，无序号机制），
> 实际为**复活重建**；FR-703/FR-804/FR-1301 涉及的本地操作（还原/删除/切集合/换令牌）写门禁
> 口径与实现的偏差在各条下注明。

## 背景

002 落地后，需求池已能分页查询 TFS 并领取入池。用户在真实使用中提出 13 项后续问题，
分为四类：

1. **数据源与 UI 状态持久化**（问题 1、2、4、6）：下拉可选项每次进页面都打 TFS；
   筛选条件刷新即丢；需求池与任务中心两个长列表没有分页。
2. **Tab 保活与跨页联动**（问题 3、5、10）：切 Tab 即卸载重挂载、重新拉数；
   领取/拆解后任务中心不能实时反映。
3. **看板操作补齐与拆解正确性**（问题 7、8、9、11）：缺"还原到需求池"、任务删除；
   重新拆解对已取消任务空转且文案误导；选为目标带不出需求正文。
4. **能力目录缺口**（问题 12、13）：执行配置技能下拉缺少预置体作用域内的用户级技能
   （实测 `~/.agents/skills` 有 96 个技能目录）；契约表 49 个操作中 34 个无 REST 分支。

## 实测事实（2026-09-20 只读探针，对 `WN_HIS` 集合）

- 「需求」工作项类型的自定义字段引用名（取自 `/_apis/wit/workitemtypes/需求/fields`）：
  - 详细信息（说明）= `System.Description`（HTML）
  - 需求分析 = `Winning.Demand.Analysis`（HTML）
  - 数据结构 = `Winning.Data.Design`（HTML）
  - 需求配置 = `Winning.Demand.Config`（HTML）
  - 客户名称 = `Winning.Custom.Name`（WIQL 中文**等值**查询实测 200）
- 工作项 1997179 的 `System.Description` 实测 799 字符非空；当前 `board.json`
  里该需求记录无 description（旧版领取时未捕获），是"选为目标为空"的直接成因。
- 技能目录根因：web profile 顶层 `skill-filesystem` 插件为 `disabled: true`；
  带默认根目录（用户级技能）的 filesystem provider 由 **standard agent preset 的预置体作用域**
  挂载（`dsh-agent-presets/presets/standard/agent.cordis.yml:84-85`）。
  `ctx.skills.list({})` 只读全局层 → 拿不到预置体层的用户级技能；
  dsh 自身工具调用形态为 `skills.list({ cwd, scope: exec.agent })`。
  `@deepseek-ai/dsh-agent-presets` 根导出 `livePresetMounts()`（可无参调用），可枚举存活预置体；
  PresetMount 的作用域字段为 `key: ScopeKey | undefined`（实现以 mount.key 作为 skills.list 的 scope）。
- 端点实测：
  - `GET /_apis/tfvc/items?scopePath=$/...` 200；`includeChildren=false` 的 `/_apis/tfvc/branches` 200；
    `/_apis/tfvc/changesets/{id}/changes` 200；`changesets/{id}/workItems` 200（空集亦 200）。
  - `GET /_apis/git/repositories` 200（36KB）；`refs?filter=heads`、`commits`、
    `pullrequests?searchCriteria.status=...`、`stats/branches?name=...` 均 200。
  - 项目级查询树 `/{project}/_apis/wit/queries?$depth=2` 200；按 id 执行走
    `POST /_apis/wit/wiql/{id}`（集合级 400，需带项目路径）。
  - 附件关系：`$expand=relations` 返回 `rel=AttachedFile`，
    `url=.../_apis/wit/attachments/{guid}`，`attributes.name` 为文件名（实测 WI 2013322）。
  - `POST /_apis/wit/wiql` 中文 `CONTAINS` 本次实测 200（服务端行为可能已变化）；
    保留 414 客户端兜底，不删除既有降级路径。
  - 服务器级 `/_apis/projectCollections` 在该 TFS 2018 部署上 1.0/2.0/3.0/4.0/4.1 全 404；
    Git `commits/{id}/workItems` 404（该路由此版本不支持）。这两类按"配置兜底/可读报错"处理。

## 需求

### 一、数据源本地配置文件（问题 1）

#### FR-101 下拉可选项落盘
需求池的四类可选项（团队项目、工作项类型、状态、指派给）首次采集后保存到插件私有数据目录
的 `query-options.json`，结构按集合命名空间：
`{ [collection: string]: { data: QueryOptionsResponse; savedAt: string } }`。
写入用原子写（tmp + rename），复用 `JsonStore` 同风格。

#### FR-102 读盘优先
打开需求池/切换集合时，优先读本地文件：文件存在则直接用文件数据渲染下拉，**不请求 TFS**；
文件不存在时自动采集一次（现有 `GET /_apis/wit/...` 路径）并落盘。

#### FR-103 「采集可选项」按钮
需求池工具栏新增「采集可选项」按钮：强制重新请求 TFS 四类可选项，成功后覆盖写本地文件并更新下拉；
进行中按钮禁用并显示「采集中…」，失败给出可读错误且**保留旧文件数据**（不半写、不清空）。

#### FR-104 宿主路由
- `GET /api/tfs/query-options/load?collection=<c>`：读文件，不存在返回 `{ ok:true, data:null }`。
- `POST /api/tfs/query-options/collect`，body `{ collection? }`：实时采集 + 落盘 + 返回数据。
- 既有进程内 Map 缓存删除，统一以文件为权威（宪法 Principle VI）。

### 二、记住上次筛选（问题 2）

#### FR-201 筛选状态持久化
需求池四类筛选（项目、类型、状态、指派给；关键字与"仅看未入池"是否记忆见 FR-203）
在变更后保存到 `ui-state.json`（按集合命名空间）；下次进入需求池自动恢复为上次选项。

#### FR-202 分页参数持久化
需求池每页条数、任务中心「已领取需求」与「任务列表」每页条数一并持久化；页码不持久化
（重进默认回到第 1 页）。

#### FR-203 边界
- 关键字搜索框不记忆（易腐，重进应为空）；「仅看未入池」不记忆。
- 已保存选项在新可选项数据中失效（项目被删除等）时，静默忽略失效值，不报错、不清空其他值。
- ui-state 只存 UI 状态，与角色/连接档案等配置文件分离；文件损坏时回退默认值（不阻塞面板）。

### 三、Tab 切换保活（问题 3）

#### FR-301 面板常驻不卸载
需求池、任务中心、执行配置、角色管理、连接与凭据五个 Tab 首次访问后**保持挂载**，
切换时仅以 CSS `display:none` 隐藏；各面板已加载数据、筛选、分页、滚动位置不丢失。

#### FR-302 不重复拉数
隐藏期间不触发任何数据请求；面板自身的数据加载只在首次挂载与集合切换时发生
（轮询/手动刷新按钮行为不变）。

### 四、需求池分页（问题 4）

#### FR-401 分页栏
需求池列表底部加分页栏：上一页/下一页、当前页/总页数、总条数、每页条数选择
（10/20/50/100，默认 20，可在分页栏直接切换）。

#### FR-402 分页语义
对**当前筛选结果**做客户端分页（与现有 WIQL `$top=500` 架构一致；超过 500 条的提示沿用现有横幅）。
筛选条件、关键字、集合变化时回到第 1 页；每页条数变化时回到第 1 页。

### 五、领取后实时刷新任务中心（问题 5）

#### FR-501 领取即见
需求池点击「领取入池」成功后，已保活的任务中心「已领取需求」列表实时出现该需求，
无需手动切 Tab 或点刷新；需求池列表的「已入池」徽标同步更新（沿用 002 的 board 重取）。

### 六、任务中心分页（问题 6）

#### FR-601 已领取需求分页
「已领取需求」卡片列表分页，独立每页条数（默认 10，可选 5/10/20/50）。

#### FR-602 任务列表分页
底部「全部任务」表分页，独立每页条数（默认 20，可选 10/20/50/100）。

#### FR-603 联动
新领取/新拆解产生数据时，相关列表回到第 1 页确保新数据可见；筛选（状态/关键字）变化回到第 1 页。

### 七、还原到需求池（问题 7）

#### FR-701 操作入口与规则
每个已领取需求卡片提供「还原到需求池」按钮，二次确认后执行：
- 该需求下存在**非已取消**任务（pending/running/paused/completed/failed/blocked）时拒绝，
  提示「请先取消全部任务后再还原」；
- 全部任务均为已取消（或无任务）时：从看板移除该需求及其已取消任务，
  清理其他任务 `blockedBy` 中对这些任务的引用，移除相关 artifacts 记录。

#### FR-702 TFS 标签尽力清理
还原时尽力移除 TFS 工作项上的 `dsh` 标签（新增 adapter `removeTags`，
PATCH `System.Tags` 重写整串标签）；标签移除失败**不阻断还原**，结果中回带 `tagWarning`。

#### FR-703 路由与刷新
`POST /api/tfs/requirements/restore`，body `{ requirementKey }`。
> 实现注记：还原的主体是**本地看板变更**（前端二次确认 + 看板事件 `requirement-restore` 落审计），
> 不经工具写门禁 WriteGuard；其中 best-effort 的 TFS 标签移除（FR-702）经 adapter.removeTags 直发，
> 同样不经 WriteGuard（失败只告警）。成功后刷新 board，需求池徽标消失、任务中心列表移除。

### 八、任务删除与批量删除（问题 8）

#### FR-801 仅删已取消
任务列表每行在任务为「已取消（deleted）」状态时显示「删除」按钮；非已取消任务不显示删除
（必须先走取消流程）。

#### FR-802 级联
删除任务时级联清理：任务记录及其 artifactPaths 引用（记录一并消失；**不主动删除磁盘上已生成的
产物文件**，避免误删用户工作区文件）；其他任务 `blockedBy` 中对该任务的引用。
看板内任务为同级拆解产物，无父子外键；不调用 TFS 删除工作项（TFS 2018 REST 不支持销毁工作项，
「已取消」是 TFS 侧终态，删除仅清理本地看板）。

#### FR-803 复选框与批量删除
任务列表增加复选框列（表头带全选框，全选范围=当前筛选+当前页内的已取消任务）；
出现勾选时显示批量操作条「删除所选（n）」，二次确认后批量删除；非已取消任务的复选框禁用。
跨页勾选保留（选择集按 taskId 维护）。

#### FR-804 路由
`POST /api/tfs/tasks/delete`，body `{ taskIds: string[] }`（前端二次确认；本地看板变更落
`task-delete` 事件审计，不经工具写门禁——它不触达 TFS）；
任一任务不存在或非已取消则整批拒绝并返回可读的阻断清单（不做部分删除）。

### 九、重新拆解正确性（问题 9）

#### FR-901 已取消任务不占位（实现：复活重建）
拆解时「已存在则跳过」只对**非 deleted 状态**的任务生效。
> 实现修订：任务 id 是确定性后缀 `${requirementId}#analyze|#impl|#verify`，**不存在序号机制**，
> 原设计的"按 requirementTaskSeq 续号新建"无号可续。实际语义：同 id 为 deleted 时，先清除该历史
> 记录，再按草稿**原地复活重建**为全新 pending（revision 归零、execState 清空）；同 id 在办则跳过。
> 审计连续性由看板事件历史保留。

#### FR-902 真实计数与文案
拆解结果返回 `{ created: number, skipped: number }`，文案据实生成，例如
「已拆解 1997179@WN_HIS：新增 3 个任务，跳过 0 个已存在」；全部跳过则
「未新增任务：3 个任务均已存在（未取消）」。客户端不再使用硬编码文案。

### 十、拆解结果实时同步（问题 10）

#### FR-1001 拆解即刷新
「拆解任务 / 重新拆解任务」成功后客户端**等待** board 重取完成再收尾，
任务列表（含该需求卡片分组与全部任务表）立即出现新任务；新任务需求卡片自动展开。
与 FR-901 配合后，"全已取消 → 空转 → 列表无变化"的现象消失。

### 十一、选为目标自动带入四段描述（问题 11）

#### FR-1101 归一化捕获四段
`normalizeWorkItem` 除 `System.Description`（详细信息）外，追加捕获：
`Winning.Demand.Analysis`（需求分析）、`Winning.Data.Design`（数据结构）、
`Winning.Demand.Config`（需求配置），均经 `htmlToPlainText` 转换与既有长度上限处理；
`RequirementSummary` 增加 `analysis/dataStructure/config` 三个可选字段。

#### FR-1102 目标填充格式
`buildTargetFill` 按【详细信息】【需求分析】【数据结构】【需求配置】分节拼接非空段落，
总长度仍受 `TARGET_TEXT_LIMIT`（4000）约束（按节等比截断，只出现一次截断标记）。

#### FR-1103 历史数据补偿
已在看板中、缺少四段字段的需求（如 1997179），在执行配置选中为目标时先调
`POST /api/tfs/requirements/enrich`（实时重取工作项并回写 board.json 该需求记录），
再填充目标描述；领取新需求时天然带齐四段（claim 走 getRequirement）。
需求详情弹窗同时展示这四段内容。

### 十二、技能下拉数据源补全（问题 12）

#### FR-1201 多作用域枚举
`DshCatalog.collectSkills` 除全局层 `skills.list({})` 外，
经 `livePresetMounts()`（`@deepseek-ai/dsh-agent-presets`，动态 import + try/catch 降级）
对每个存活预置体调用 `skills.list({ scope: mount.key })`，按技能名并集去重（全局层优先），
使用户级技能（`~/.agents/skills`、`~/.dsh/skills`）完整出现在技能下拉，与 dsh 自身一致。

#### FR-1202 降级
agent-presets 包不可用、无存活预置体或作用域枚举抛错时，退回当前全局层行为，
不影响面板打开与其他目录（模型/MCP）加载。

### 十三、34 个契约端点接入（问题 13）

为下列 34 个 `raw` 操作在适配层补齐 REST 分支（TFS 2018，api-version=4.1），
连接与凭据页「已接入端点」达到 49/49，缺口表清空：

- 集合/凭据（本地）：`tfs_set_collection`、`tfs_update_token`（进程内 PAT 覆盖，不写回档案）、
  `tfs_list_collections`（先试服务器级 `/_apis/projectCollections`，404 兜底返回配置内集合清单）。
- 工作项查询：`tfs_get_work_items_by_customer`（`[Winning.Custom.Name] = '...'` 等值 WIQL）、
  `tfs_get_recent_resolved`、`tfs_get_bugs`、`tfs_get_relations`、
  `tfs_update_workitem`（通用 fields JSON-PATCH，写）、`tfs_custom_query`（条件构造 WIQL）、
  `tfs_search_work_items`（标题 CONTAINS，414 走客户端兜底）、
  `tfs_run_saved_query`（项目级 `POST /{project}/_apis/wit/wiql/{id}`）。
- 附件：`tfs_list_attachments`、`tfs_upload_attachment`（POST 附件二进制 + PATCH 关系，写）、
  `tfs_download_attachments`（GET 附件 URL 落盘到指定目录）。
- TFVC：`tfs_download_tfvc_files`、`tfs_get_tfvc_changeset_changes`、
  `tfs_check_commit_work_items`（TFVC 走 changesets/{id}/workItems；Git 该版本 404 时给可读错误）、
  `tfs_list_tfvc_branches`（includeChildren=false）、`tfs_list_tfvc_items`、
  `tfs_get_tfvc_item`、`tfs_get_tfvc_file`（文件内容字节流）。
- Git：`tfs_get_commits`、`tfs_list_repos`、`tfs_get_repo`、`tfs_list_branches`、
  `tfs_get_branch`（stats/branches）、`tfs_get_branch_diffs`（diffs/commits，不支持则可读报错）、
  `tfs_list_prs`、`tfs_get_pr`、`tfs_get_pr_commits`、`tfs_get_pr_diffs`（iterations/changes）、
  `tfs_get_pr_workitems`、`tfs_add_pr_comment`（POST threads，写）、`tfs_create_pr`（写）。

#### FR-1301 统一约束
- TFS 写操作（update_workitem/upload_attachment/add_pr_comment/create_pr）
  全部经 `WriteGuard` 四道门禁 + 审计，opType=`tool`；读操作不经过门禁。
  （实现注记：`tfs_set_collection/tfs_update_token` 是纯本地/进程内副作用、不触达 TFS，
  在 adapter.call() 内直接完成，未过 WriteGuard；如后续要求审计本地配置变更可另补审计事件。）
- 下载类操作默认目录 = 数据目录下 `downloads/`，文件名取响应头/属性名并做路径穿越防护；
  返回落盘绝对路径清单。
- 所有新分支错误经 `safeError`/`scrubCredentials`，不泄露 PAT；
  服务器版本不支持的路由返回「TFS 版本不支持该端点」类可读错误，不伪造数据。

## 非目标

- 不做服务端真分页（WIQL $top 仍为 500，客户端分页）。
- 不做 TFS 工作项物理销毁（REST 不支持）；删除仅针对本地看板的已取消任务。
- 不改造角色管理/连接页既有功能；保活仅改变挂载方式。
- 不把 dsh 标签移除做成还原的强一致条件（标签失败不阻断）。
- 不引入新的第三方依赖。

## 验收标准

1. 断网/不请求 TFS 时，第二次打开需求池四类下拉仍有选项（来自 `query-options.json`）；
   点「采集可选项」后文件 `savedAt` 更新、下拉刷新。
2. 选好筛选/每页条数后重启面板（或切集合来回），筛选值与每页条数恢复；关键字框为空。
3. 五个 Tab 来回切换：网络面板无重复列表请求；各页数据、分页、勾选、滚动位置保持。
4. 需求池分页栏随筛选正确翻页/计数；每页条数切换即时生效并持久化。
5. 领取一个需求后切到任务中心（不手刷），该需求已在已领取列表第 1 页。
6. 任务中心两个列表各自分页、每页条数可配且持久化。
7. 有进行中任务的需求点还原被拒绝；全部取消后还原成功，board.json 中需求/任务消失，
   需求池该需求不再显示已入池。
8. 已取消任务可单个/勾选批量删除，删除后 blockedBy 悬挂引用被级联清理、任务记录与 artifactPaths
   引用消失（磁盘产物文件不主动删）；对含非已取消/不存在任务的删除请求整批拒绝并列出冲突 id。
9. 对 3 个任务全已取消的需求点重新拆解：3 个确定性 id 任务原地复活为全新待办，
   文案显示「新增 3，跳过 0」，任务列表立即出现新任务；仍有在办任务时对应 id 计入跳过数。
10. 选中 1997179 为目标：目标描述含【详细信息】（非空）及其他存在的分段；
    新领取的同类需求无需补偿即带齐四段。
11. 执行配置技能下拉包含 `~/.agents/skills` 下全部用户级技能（与 dsh 技能面板数量一致）；
    卸载/缺失 agent-presets 时面板仍能打开。
12. 连接与凭据页显示「已接入端点 49/49」，能力缺口表为空；
    新增读操作在 fetch 桩下命中正确 REST 路由，TFS 写操作未确认时零发出并留 WriteGuard 审计。
13. `npm run typecheck`（host/client/tests 三段）、`npm test`（35 文件 / 556 tests）、
    `npm run build` 全绿；新增行为有单测覆盖
    （落盘存储、还原/删除引擎、复活重建与计数、目标分节拼接、技能并集、端点路由、分页纯函数）。

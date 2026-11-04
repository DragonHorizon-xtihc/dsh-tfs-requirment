/**
 * 跨宿主半 / 客户端半共享的类型契约（T047 / US4）。
 *
 * **为什么存在这个文件**：DSH 插件分两个独立编译程序——
 *   - 宿主半（tsconfig.host.json）：include `src/**`（排除 src/client），可依赖 @deepseek-ai/* 与 node:fs；
 *   - 客户端半（tsconfig.client.json）：include 仅 `src/client/**` + `src/shared/**`，`types: []`（无 node 全局）。
 *
 * 因此任何"宿主半与客户端半都要用"的类型，必须放在 `src/shared` 且**不得**依赖 node / @deepseek-ai，
 * 否则客户端半类型检查会因 `node:fs` 不可见或勾不到宿主服务而失败。
 *
 * `src/client/components/ExecutionPanel.tsx`（客户端半）与宿主半的 `roles.ts`/`adapter.ts`/`dispatch.ts`
 * 都从这里取类型，保证两端对同一数据结构理解一致，且互不引入对方的编译依赖。
 *
 * 本文件是**纯类型**（`type`-only 导出也行，但这里用普通 interface/type 以便值语义兼容），
 * 不 export 任何运行时值，避免被错打包进任一端。
 *
 * @module dsh-tfs-requirment/shared/contracts
 */
/**
 * 客户端半 → 宿主半的 HTTP 路由路径（Phase 3 真实通道，对齐 dsh-optimized-prompt 的
 * `/optimized-prompt/*` 模式：客户端 `fetch` → 宿主 `webServer.register`）。路径为编译期常量，
 * 两侧必须一致；放在共享契约里避免两端各写一份、配置一改就分家。
 */
export const TFS_ROUTES = {
    /** GET 取面板静态数据。 */
    panelData: '/tfs-requirment/panel-data',
    /** POST 确认回写（tag/comment/state）。 */
    confirmWrite: '/tfs-requirment/confirm-write',
    /** POST 发起执行（按角色派发 subagent）。 */
    dispatch: '/tfs-requirment/dispatch',
    /**
     * POST 需求池列表（US2）。
     *
     * 用 POST 而非 GET：筛选条件含 projects/types/states/assignedTo 等数组与关键字，放在 query
     * string 上易超长且需重复转义；请求体承载 {@link RequirementFilter}，返回 {@link RequirementListResult}。
     */
    requirements: '/tfs-requirment/requirements',
    /** GET 需求筛选可选项（问题 3：项目/类型/状态/指派人；命中宿主进程内缓存则不重采）。 */
    queryOptions: '/tfs-requirment/query-options',
    /**
     * POST 强制重采需求筛选可选项（绕过缓存）。
     *
     * 用 POST 而非 GET：它有**副作用**（丢弃缓存并重新拉取 TFS 元数据），
     * 放在 GET 上会让任何预取/重试链路意外触发整轮元数据采集。
     */
    queryOptionsRefresh: '/tfs-requirment/query-options-refresh',
    /** GET 角色清单（US5）。 */
    roles: '/tfs-requirment/roles',
    /** POST 保存/更新角色（US5）。 */
    roleSave: '/tfs-requirment/role-save',
    /** POST 删除角色（US5；被引用时需 force）。 */
    roleDelete: '/tfs-requirment/role-delete',
    /** GET 技能/MCP 分组清单（2026-11-03 用户诉求）。 */
    skillGroups: '/tfs-requirment/skill-groups',
    /** POST 保存/更新技能/MCP 分组。 */
    skillGroupSave: '/tfs-requirment/skill-group-save',
    /** POST 删除技能/MCP 分组。 */
    skillGroupDelete: '/tfs-requirment/skill-group-delete',
    /** GET 看板快照（US3 任务中心 / US6 恢复）。 */
    board: '/tfs-requirment/board',
    /** POST 领取需求入本地池（US2 / T036）+ 打 dsh 标签（T048）。 */
    claim: '/tfs-requirment/claim',
    /** POST 拆解需求为任务（US3 / T041）。 */
    decompose: '/tfs-requirment/decompose',
    /** POST 指派任务角色（US3 / T042）。 */
    taskAssign: '/tfs-requirment/task-assign',
    /** POST 任务状态操作 启动/完成/重试/取消（US3 / T043）。 */
    taskState: '/tfs-requirment/task-state',
    /** GET 连通性自检（US1 / T029 测试连接）。 */
    health: '/tfs-requirment/health',
    /** GET 审计状态（T063）。 */
    audit: '/tfs-requirment/audit',
    /** POST 执行审计滚动归档（T063）。 */
    auditArchive: '/tfs-requirment/audit-archive',
    /** POST 切换默认集合（T030 / FR-003）。 */
    collection: '/tfs-requirment/collection',
    /** GET 连接档案清单（T031；不含 PAT）。 */
    profiles: '/tfs-requirment/profiles',
    /** POST 保存/更新连接档案（T031）。 */
    profileSave: '/tfs-requirment/profile-save',
    /** POST 删除连接档案（T031）。 */
    profileDelete: '/tfs-requirment/profile-delete',
    /** POST 设为活动档案（T031）。 */
    profileActivate: '/tfs-requirment/profile-activate',
    /** GET MCP 接入模板 + 实例诊断（T028b）。 */
    mcpInstance: '/tfs-requirment/mcp-instance',
    /** POST 写出 MCP 启动环境文件（T028b）。 */
    mcpEnvFile: '/tfs-requirment/mcp-env-file',
    /** GET 本插件的能力目录（问题 8 / 12）。 */
    tfsTools: '/tfs-requirment/tfs-tools',
    /**
     * POST 强制重采 DSH 能力目录（模型 / 技能 / 预设 / 工作区 / provider / MCP）。
     *
     * 存在的理由：目录在 `apply` 期只采一次，而用户可能**先打开插件、后配置模型**
     * （如新增 provider key、装新技能、加新 MCP server）。没有这条路由，UI 拿到的永远是
     * 首次采集的空/旧快照 —— 表现为"下拉里没有我刚配的模型"，且用户无法自救。
     * 该路由让"执行配置"标签页的刷新按钮真正触发重采，而不是只重读同一份内存快照。
     */
    catalogRefresh: '/tfs-requirment/catalog-refresh',
    /** GET 读本地落盘的需求池可选项（问题 1；无缓存返回 data:null）。 */
    queryOptionsLoad: '/tfs-requirment/query-options-load',
    /** POST 强制重采需求池可选项并落盘覆盖（问题 1「采集可选项」）。 */
    queryOptionsCollect: '/tfs-requirment/query-options-collect',
    /** GET/POST UI 状态（筛选/每页条数，问题 2/4/6）。 */
    uiState: '/tfs-requirment/ui-state',
    /** POST 还原已领取需求回需求池（问题 7）。 */
    requirementRestore: '/tfs-requirment/requirement-restore',
    /** POST 实时重取需求四段描述并回写看板（问题 11）。 */
    requirementEnrich: '/tfs-requirment/requirement-enrich',
    /** POST 删除已取消任务（问题 8，批量）。 */
    taskDelete: '/tfs-requirment/task-delete',
    /** POST 编辑已领取需求本地字段（问题 3：提示词 / 工作目录）。 */
    requirementUpdate: '/tfs-requirment/requirement-update',
    /** POST 设置需求级执行状态（问题 5：确认完成 / 取消完成）。 */
    requirementExecState: '/tfs-requirment/requirement-exec-state',
    /** POST 编辑任务字段（问题 4：提示词 / 模型 / 技能 / MCP / 工作目录）。 */
    taskUpdate: '/tfs-requirment/task-update',
    /** GET 任务执行过程轨迹（spec 006 US2；query：taskId、attempt?）。 */
    taskTrace: '/tfs-requirment/task-trace',
    /** POST 对任务追问 / 补充指令（spec 006 US3；body：FollowUpTaskInput）。 */
    taskFollowUp: '/tfs-requirment/task-follow-up',
    /**
     * POST 需求完成自动回写（问题 4；body：{ requirementKey, force? }）。
     *
     * 全部任务完成时宿主会自动调用一次；此路由用于：① 自动回写关闭时的"手动回写"入口；
     * ② 部分失败后的"重新回写"（幂等，已成功的项跳过）。GET（query requirementKey）只读回写报告。
     */
    requirementWriteBack: '/tfs-requirment/requirement-write-back',
    /**
     * POST 确保需求有编排主 agent 会话（spec 010 US1；body：{ requirementKey }）。
     *
     * 幂等：已存在 continuable 编排会话时直接返回既有上下文，不重复创建。
     * provider 不支持 / 宿主不可用 ⇒ 返回 `mode:'off'` + 可读 `reason`（fail-loud，不静默）。
     */
    orchestratorEnsure: '/tfs-requirment/orchestrator-ensure',
    /**
     * POST 开始编排（2026-11-03 问题 4/5）。
     * body：{ requirementKey, mode: 'now' | 'at', dueAt?, sequential? }。
     * 'at' = 登记定时（精确到分，持久化 + 重启补跑）；'now' = 立刻按依赖顺序启动子 Agent 链。
     */
    orchestrationStart: '/tfs-requirment/orchestration-start',
    /** GET 定时执行条目清单（问题 4/5）。 */
    schedules: '/tfs-requirment/schedules',
    /** POST 取消一条定时执行（body：{ id }）。 */
    scheduleCancel: '/tfs-requirment/schedule-cancel',
    /** POST 修改定时执行的到点时刻（body：{ id, dueAt }，2026-11-03 问题 3）。 */
    scheduleUpdate: '/tfs-requirment/schedule-update',
};
//# sourceMappingURL=contracts.js.map
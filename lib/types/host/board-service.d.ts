/**
 * 看板服务（US2 领取同步 / US3 任务中心 / US4 打标签 / US6 恢复对账）。
 *
 * **为什么需要这一层**：`core/board/board.ts`（看板引擎）、`persistence/json-store`（权威落盘）、
 * `persistence/events`（append-only 事件）、`persistence/markdown`（只读渲染）、
 * `core/board/decompose`（需求→任务拆解）此前**各自实现但从未接线**，导致
 * "领取需求 / 拆解任务 / 指派角色 / 启停重试 / 跨重启恢复" 整条 US2+US3+US6 链路在运行期不存在。
 * 本文件是这条链路的唯一装配点：把纯逻辑引擎 + 文件持久化 + TFS 写出口 + 角色表粘合起来，
 * 并保持**全部依赖可注入**（单测可用内存 fs 与桩 adapter 驱动，不接触真实磁盘/TFS）。
 *
 * ## 关键契约
 * - **JSON 为权威（Principle VI）**：`board.json` 是唯一权威；Markdown 只是渲染视图，
 *   每次变更后重渲染，顶部标注「自动生成请勿手改」。
 * - **HOST bridge 与审计**：本项目契约把"客户端请求 → 宿主账本"的每次变更都记进 `events.jsonl`
 *   （append-only，绝不改写历史行）。
 * - **T048 幂等打标签**：领取入池即打 `dsh` 标签，幂等键 `<id>@<collection>:<normLabel>`（S-08）；
 *   标签已存在则跳过（不重复发写调用）；标签写失败**不**使领取失败——条目仍入池（FR-014）。
 * - **FR-020 解析失败不静默重建**：`board.json` 解析失败时保留原文件并返回 `ok:false`，绝不覆盖。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/board-service
 */
import { Board, type AttemptMeta } from '../core/board/board.js';
import type { TaskOrchestration, TaskState } from '../core/board/task.js';
import { type FsLike } from '../persistence/fs-like.js';
import type { Requirement, RequirementExecState, RequirementOrchestration } from '../tfs/types.js';
import type { BoardSnapshotView, BoardTaskView, ClaimRequirementInput, ClaimRequirementResult, DeleteTasksResult, EnrichResult, FrozenConfig, RequirementQueryOptions, RequirementSummary, RequirementWriteBackReport, RestoreResult, RoleDefinition, TaskAction, TaskOpResult, UiState } from '../shared/contracts.js';
/** 本服务对 TFS 适配层的最小需求面（便于单测打桩，不引入整个 adapter）。 */
export interface BoardTfsPort {
    /** 按 id 取单个需求（实测可用读路径：`tfs_get_workitem`）。 */
    getRequirement(id: number, collection?: string): Promise<RequirementSummary>;
    /** 打标签（过 WriteGuard 四道门禁）。 */
    addTags(workItemId: string | number, collection: string | undefined, tags: string[], beforeTags: string[], confirmed: boolean): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /**
     * 移除标签（问题 7 还原需求池 best-effort 使用）。
     *
     * 2026-10-04：与其余写操作一样**走 WriteGuard 四道门禁**（旧实现绕过门禁自己 PATCH），
     * 故需要第四参 `confirmed`——「还原到需求池」是用户的显式操作，构成人工确认。
     * 失败由调用方降级为告警。可选：未注入时还原流程跳过 TFS 标签清理，只给提示。
     */
    removeTags?(workItemId: string | number, collection: string | undefined, tagsToRemove: string[], confirmed: boolean): Promise<{
        id: number;
        tags: string[];
    }>;
    /** 采集需求池筛选可选项（问题 1「采集可选项」按钮）。 */
    getQueryOptions?(collection?: string): Promise<RequirementQueryOptions>;
}
/**
 * 角色表面（拆解默认指派 + 指派校验）。
 *
 * `save` 可选：生产装配注入 RoleStore（拆解匹配不到角色时可自动创建，spec 008 US3）；
 * 测试/降级装配可不提供，此时回落链跳过自动创建、改用列表首个角色。
 */
export interface RoleReader {
    list(): RoleDefinition[];
    getByName(name: string): RoleDefinition | undefined;
    /** 自动创建角色通道（落 roles.json）。 */
    save?(role: RoleDefinition): void;
}
/** 看板服务依赖（全部可注入）。 */
export interface BoardServiceDeps {
    /** 插件数据目录（`board.json` / `events.jsonl` / `.ai-board/` 落此）。 */
    baseDir: string;
    /** 可注入文件系统（默认真实 `node:fs`）。 */
    fs?: FsLike;
    /** 看板引擎（可注入预置状态，便于恢复测试）。 */
    board: Board;
    /** TFS 适配面（REST 直连；写操作唯一出口，Principle IV）。 */
    adapter: BoardTfsPort;
    /** 角色表（拆解默认指派 + 指派校验）。 */
    roles: RoleReader;
    /** 入队标签（T048），通常取 `config.defaultLabel`（默认 `dsh`）。 */
    defaultLabel: string;
    /** 并发器运行时读数（S-06 排队可见性）。 */
    getRuntimeCounts?: () => {
        running: number;
        queued: number;
    };
    /**
     * 任务收口后的**异步副作用钩子**（问题 4 自动回写 / 问题 6 自动链式执行）。
     *
     * 由宿主装配层（`host/api` / `index`）注入，避免本服务反向依赖派发器与 TFS 回写器。
     * 在任务收口且看板已落盘后，以 microtask **异步、不阻塞、不抛错**地触发一次；钩子内部据此决定：
     * 成功 ⇒ 自动派发下一条就绪任务 + 需求全部完成时回写 TFS；待确认 / 失败 ⇒ 阻断链式与回写。
     * 单测可不注入（行为退化为仅本地状态收口）。
     */
    onTaskSettled?: (info: TaskSettledInfo) => void;
    /**
     * 取消任务时**真正终止子 run** 的钩子（2026-10-04 接线）。
     *
     * 背景：`RequirementDispatcher.cancel()` 此前是**零调用点的死代码**——
     * `setTaskState('cancel')` 只翻本地状态，子 agent 继续烧 token、并发槽继续被占，
     * 直到 run 自然落定或看门狗（默认 30 分钟）超时才归还。注释里警告的
     * 「三个失控 run 就把 maxConcurrentRequirements 占满」正是这条路径的真实后果。
     *
     * 由装配层注入 `dispatcher.cancel`，本服务不反向依赖分发器（保持可桩测）。
     * 未注入时（精简装配 / 单测）退化为旧行为。**异常必须内部吞掉**：取消失败不能让
     * 「取消」这个本地动作返回一个假失败——状态已经落，run 没停也要如实放行由看门狗兜底。
     */
    cancelRun?: (taskId: string) => Promise<void>;
    /**
     * 还原需求到需求池时，释放其名下 continuable 任务子会话（D4）。
     *
     * 由装配层注入（OrchestratorSessionManager.drainRequirementSessions），本服务不反向依赖编排器。
     * 入参为该需求登记的全部 taskSessions id；best-effort：返回可读 warning（不阻断还原），
     * 全部成功/无会话时返回 undefined。未注入时还原流程跳过子会话释放。
     */
    disposeRequirementSessions?: (sessionIds: string[]) => Promise<string | undefined>;
}
/** 传给 {@link BoardServiceDeps.onTaskSettled} 的收口信息。 */
export interface TaskSettledInfo {
    taskId: string;
    /** 所属需求去重键。 */
    requirementKey: string;
    /** 本次收口结果（人工确认通过记 success）。 */
    outcome: 'success' | 'failed' | 'needs_confirmation';
    /** 被收口任务是否为自动链式派发（诊断用）。 */
    autoLaunched?: boolean;
}
/**
 * **只存在于本地看板、TFS 侧没有对应字段**的需求属性清单。
 *
 * 存在理由：`enrichRequirement`（「实时重取需求正文」）用 `summaryToRequirement(fresh)`
 * 的结果**整对象替换**看板里的需求，而上行摘要里不会有这些本地字段 —— 不逐个搬回来
 * 就会被这一次重取抹掉。此前是手写 4 个 `if` 搬，漏了 `orchestration` / `writeBack`，
 * 造成"每重取一次就丢一次编排会话与回写账本"。
 *
 * 纪律：**新增任何本地补充字段都必须同步此清单**；`tests/audit-2026-10-06-fixes.spec.ts`
 * 的清单完整性用例会把守（缺一个即红）。
 */
export declare const LOCAL_REQUIREMENT_FIELDS: readonly ["workspace", "prompt", "execState", "completedAt", "orchestration", "writeBack", "revision"];
/** 把 TFS 归一化摘要转为看板领域需求。 */
export declare function summaryToRequirement(s: RequirementSummary): Requirement;
/** 把看板领域需求转回客户端摘要（看板快照用）。 */
export declare function requirementToSummary(r: Requirement): RequirementSummary;
/**
 * 看板服务：编排引擎 + 持久化 + 事件 + 渲染 + tfs 写出口。
 */
export declare class BoardService {
    private readonly deps;
    private readonly fs;
    private readonly store;
    private readonly events;
    private readonly markdownPath;
    /**
     * 需求池可选项落盘缓存（问题 1）：按集合命名空间的 `query-options.json`。
     * 与 board.json 同目录；损坏时按"无缓存"处理（不锁死下拉，见 loadQueryOptions）。
     */
    private readonly queryOptionsStore;
    /** UI 状态落盘（问题 2/4/6：筛选记忆 + 每页条数），按集合命名空间。 */
    private readonly uiStateStore;
    constructor(deps: BoardServiceDeps);
    /** 看板引擎（供上层读取只读快照 / 计算可运行集）。 */
    get board(): Board;
    /** `board.json` 绝对路径（诊断/测试用）。 */
    get storePath(): string;
    /** 渲染出的 Markdown 看板路径。 */
    get markdownViewPath(): string;
    /**
     * 从 `board.json` 恢复（T059 / US6）。
     *
     * 解析失败**保留原文件并返回 ok:false**（FR-020），绝不静默重建——这是"用户的看板被悄悄清空"
     * 这类事故的唯一防线。
     *
     * @returns 恢复结果；文件不存在视为首次启动（ok:true）。
     */
    load(): {
        ok: boolean;
        reason?: string;
        recovered: boolean;
    };
    /**
     * 崩溃对账（T060 / S-10）：重启后把悬空 running 任务标为 failed 并记事件。
     *
     * 同时做**需求完成对账**（问题 3，2026-09-21 实机修复）：把"任务其实已全部收口、但需求
     * `execState` 仍缺键"的历史需求补齐为已完成。只靠状态变更触发不够 —— 升级前完成的需求
     * 再也没有任何触发点（实机：需求 1997179 三个任务全 completed，却一直不进「已完成」页）。
     *
     * @returns 悬空任务 ID 列表与被补齐为已完成的需求键列表。
     */
    reconcile(): {
        ok: boolean;
        dangling: string[];
        migratedRequirements: string[];
    };
    /**
     * 运行期假执行巡检（补 `Board.reconcileUnboundRunning` / `forceFailRunning` 的调用点）。
     *
     * `reconcile()` 只在插件装载时跑一次；进程长驻期间若某个任务卡在
     * `in_progress` / `execState='running'`（HTTP 请求丢失、复用会话投递后无人观测、
     * `dispatcher.getRun` 未返回 run …），没有第二次巡检就永远不会收口 —— 面板上
     * 长期显示「执行中」，且它占用的状态会挡住该任务的所有编辑。
     *
     * 只处理**没有绑定 runId 的打开尝试**：已绑定的说明子 agent 在跑，交由分发器的
     * 总时长看门狗（`RequirementDispatcher.armRunWatchdog`）负责，插件不代它下结论。
     *
     * @param staleMs - 打开尝试超过该时长且未绑定 runId 即判为悬空。
     * @returns 被标失败的任务 ID 列表（无则为空数组）。
     */
    reapStaleRunning(staleMs: number): string[];
    /** 落盘：JSON 权威 + 事件 + Markdown 渲染（T061）。 */
    private persist;
    /** 看板快照（客户端渲染用）。 */
    snapshot(): BoardSnapshotView;
    /**
     * 领取需求入本地池（T036，去重键 `workItemId@collection` S-01）+ 入队打 `dsh` 标签（T048）。
     *
     * 幂等：已在池中返回 `added:false`；标签已存在则跳过写调用（S-08）。
     * 标签写失败不使领取失败（FR-014：条目保留，UI 可见失败原因）。
     *
     * @param input - 领取入参（完整摘要 或 id+collection）。
     * @returns 领取结果。
     */
    claimRequirement(input: ClaimRequirementInput): Promise<ClaimRequirementResult>;
    /**
     * 拆解需求为默认五段式任务（分析 → 架构师拆解 → 开发 → 代码审核 → 测试）并落库
     * （T041，问题 9/10 重写；spec 008 US1~US3，五段式扩展补「代码审核」）。
     *
     * 角色解析（每个阶段独立，见 `orchestration/role-match.ts`）：
     *   1. 阶段专门角色（名称命中分析/架构/开发/审核/测试关键词）；
     *   2. 通用型角色兜底（内置「通用工程师」）；
     *   3. 自动创建该阶段标准内置角色（经角色端口 save 落 roles.json，结果体 createdRoles 可见）；
     *   4. 端口无写能力 → 回落列表第一个角色；一个角色都没有 → 由 decompose 以「通用工程师」占位。
     *
     * 任务语义（`Board.decomposeTasks`）：
     *   - 同 id 任务**不存在** → 新建；
     *   - 同 id 任务为 `deleted`（已取消的历史任务）→ 删旧记录后按草稿**原地重建为全新 pending 任务**
     *     （问题 9：旧实现把已取消任务当"已存在"跳过，导致重新拆解提示成功却看不到任务）；
     *   - 同 id 任务为其他状态（在办/已完成）→ 跳过，不重置运行成果（S-07）。
     *
     * @param requirementId - 需求 dedupKey `id@collection`。
     * @returns 新增/跳过计数与全部任务 id、自动创建的角色名；reason 为可直接展示的中文结论。
     */
    decompose(requirementId: string): {
        ok: boolean;
        taskIds?: string[];
        created?: number;
        skipped?: number;
        createdRoles?: string[];
        reason?: string;
    };
    /**
     * 为一个拆解阶段解析应指派的角色（spec 008 US1~US3 的五级回落链）。
     *
     * 1. 名称命中阶段关键词的专门角色（需求分析师/架构师/开发工程师/代码审核工程师/测试工程师或用户自建的同义角色）；
     * 2. 名称命中通用关键词的通用型角色（内置「通用工程师」）——通用兜底优先于自动创建，
     *    避免在用户已配置兜底角色时还凭空造角色；
     * 3. 自动创建该阶段标准内置角色（双检 id/名称不存在；save 失败只记事件不阻断拆解）；
     * 4. 无 save 通道（测试/降级装配）→ 列表第一个角色；
     * 5. 一个角色都没有 → undefined（decompose 以「通用工程师」名称占位）。
     *
     * @param stage - 拆解阶段。
     * @param createdAcc - 本次拆解已自动创建角色的累计数组（创建后即入 RoleStore，后续阶段可见）。
     * @returns 解析到的角色；极端降级下 undefined。
     */
    private resolveStageRole;
    /**
     * 删除**已取消**任务（问题 8，本地看板清理；支持批量）。
     *
     * 整批门禁在引擎层：任一 id 不存在或不是 deleted 即整批拒绝并返回原因（不做部分删除）。
     * 级联清理其他任务 blockedBy 悬挂引用由引擎完成。
     */
    /**
     * 任务状态批量删除后，需求可能"全部任务已收口"（问题 3）：删除已取消任务会让
     * `全部处于终态` 这条判据成立，所以删除路径也要跑一次自动完成。
     *
     * @param taskIds - 被删除的任务 id。
     */
    deleteTasks(taskIds: string[]): DeleteTasksResult;
    /**
     * 任务收口后的需求级自动完成（问题 3）：全部任务已完成 ⇒ 需求迁入「已完成」页。
     *
     * 由**看板写路径**调用（`setTaskState` / `settleTask` / `deleteTasks`），而不是由 UI 判定：
     * 派发结果回绑是宿主异步完成的（`launchRun` 的 run.result 回调），UI 下一次轮询才看到，
     * 若把判定放客户端，多标签页/多客户端就会各自算一遍，还可能出现"看板已改、UI 没跟上"。
     *
     * @param key - 需求去重键。
     * @returns 是否发生了状态变更。
     */
    /**
     * best-effort 终止任务对应的子 run（中止 + dispose 句柄 + 归还并发槽）。
     *
     * **为什么不 await**：`setTaskState` 是同步 API，改成 async 要动整条调用链；而取消的
     * 语义是"本地状态已经是终态了"，主路径不该被它们拖住。
     *
     * **为什么用 Promise 链而不是 try/catch**：钩子是 async，`try { h() } catch {}` 抓不到
     * Promise rejection —— 失败会**完全静默**（面板无感，只有一条 unhandled rejection 进 node
     * 日志），用户会以为"取消了但槽没释放"。故显式 `.catch` 落到事件日志，让失败可查。
     *
     * @param taskId - 被取消的看板任务 id。
     */
    private cancelRunBestEffort;
    private sealRequirementIfAllDone;
    /**
     * 任务收口后的统一后处理（问题 3 需求自动完成 / 问题 4 TFS 回写 / 问题 6 自动链式执行）。
     *
     * - **同步**部分：仅 success 收口跑一次 {@link sealRequirementIfAllDone}（保证看板落盘时
     *   需求完成态已一致）；needs_confirmation / failed 不 seal（任务没完成，需求不能完成）。
     * - **异步**部分：通过注入的 `onTaskSettled` 钩子在 microtask 触发自动续跑与 TFS 回写，
     *   既不阻塞当前 HTTP 请求，也避免在 `persist` 过程中重入看板；钩子异常只记事件、不外溢。
     *
     * ## ⚠️ 钩子可以是 async，`try/catch` 抓不到 Promise rejection（2026-10-01 修复）
     *
     * spec 010 起 `handleTaskSettled` 是 `async`（要等编排主 agent 归纳）。旧写法
     * `try { hook(info) } catch {}` 只捕获**同步**抛出：钩子返回的 Promise 一旦 reject，
     * 既不进 catch、也不产生任何事件 —— 表现为"任务已完成，但下一个任务不启动、也不回写"，
     * 且**面板上没有任何线索**（只有一条 unhandled rejection 进了 node 日志）。
     * 因此这里必须显式走 Promise 链并 `.catch`，把失败落进事件日志。
     */
    private afterTaskSettled;
    /**
     * 显式设置需求执行状态（问题 5：「取消完成」；以及人工确认完成）。
     *
     * 与自动迁移共用同一个引擎方法，但**不做任务状态守卫** —— "取消完成"是用户对
     * "这条需求其实还没做完"的显式声明，本插件不替用户判断（守卫在 `restoreRequirement`
     * 那一侧：必须先取消完成才能还原，见引擎 `Board.restoreRequirement`）。
     *
     * @param key - 需求去重键 `id@collection`。
     * @param state - `'completed'`（确认完成）/ `'active'`（取消完成）。
     */
    setRequirementExecState(key: string, state: RequirementExecState): {
        ok: boolean;
        reason?: string;
        requirement?: RequirementSummary;
    };
    /** 读取需求的回写报告（问题 4；无则 undefined）。 */
    getRequirementWriteBack(key: string): RequirementWriteBackReport | undefined;
    /**
     * 落存需求回写报告（问题 4）：finalizer 每跑完一次（含 running 占位与终态）都调它，
     * 报告随 board.json 持久化，既给 UI 展示，也作为"重新回写"的幂等账本与防重入依据。
     */
    setRequirementWriteBack(key: string, report: RequirementWriteBackReport): {
        ok: boolean;
        reason?: string;
        requirement?: RequirementSummary;
    };
    /** 读取需求级编排上下文（未启用返回 undefined）。 */
    getOrchestration(key: string): RequirementOrchestration | undefined;
    /**
     * 落存需求级编排上下文（spec 010：编排会话 id + 共享简报 + 会话复用表）。
     *
     * 与回写报告同纪律：随 `board.json` 持久化，重启后编排会话与简报都可恢复（VI 文件即真相）。
     */
    setOrchestration(key: string, next: RequirementOrchestration): {
        ok: boolean;
        reason?: string;
        requirement?: RequirementSummary;
    };
    /**
     * 落存任务级编排上下文（会话 id / 是否复用 / 归纳结论）。
     *
     * @returns 更新后的任务视图；失败给出可读原因。
     */
    setTaskOrchestration(taskId: string, patch: TaskOrchestration): TaskOpResult;
    /** 取任务子会话复用表里的持久会话 id（AC3.3）。 */
    getTaskSession(requirementKey: string, reuseKey: string): string | undefined;
    /** 登记任务子会话复用键（AC3.3）。 */
    putTaskSession(requirementKey: string, reuseKey: string, sessionId: string): {
        ok: boolean;
        reason?: string;
    };
    /**
     * 由「执行配置 → 发起执行」创建一条**看板任务**并返回其 id（问题 6）。
     *
     * ## 为什么需要它
     *
     * 执行配置页的「发起执行」此前是"无任务派发"：不带 taskId ⇒ 宿主不打开 attempt、
     * 不回绑 runId ⇒ 任务中心里**什么都看不到**，用户无法确认这次执行到底跑了什么
     * （没有执行内容、没有轨迹、没有失败原因）。落地为看板任务后，它与任务中心派发
     * 的任务走**同一条链路**（attempt / runId / 轨迹 / 收口 / 需求级自动完成）。
     *
     * ## 约束
     *
     * - 需求必须**已领取入池**（`Board.addTask` 要求需求存在）：未领取时返回可读原因，
     *   提示用户先去需求池领取 —— 不隐式入池（"领取"是用户的显式动作）。
     * - taskId 形如 `<reqKey>#manual-<roleSlug>-<时间戳>`：确定性前缀保证任务中心里一眼可辨
     *   （与拆解任务的 `#analyze/#plan/#impl/#review/#verify` 同命名空间），时间戳后缀避免多次手工派发撞 id。
     *
     * @param input - 需求键、标题、任务级提示词、角色名与冻结配置。
     */
    createManualTask(input: {
        requirementKey: string;
        title: string;
        description?: string;
        prompt?: string;
        roleAgent: string;
        frozenConfig: FrozenConfig;
        workspace?: string;
        /** 当前时间（测试可注入）。 */
        now?: Date;
    }): {
        ok: boolean;
        taskId?: string;
        reason?: string;
    };
    /**
     * 把已领取需求**还原到需求池**（问题 7）。
     *
     * 引擎门禁：名下仍有任何非 deleted 任务时拒绝；其 deleted 任务随需求一并清理，
     * 并级联清理 blockedBy 悬挂引用。TFS 工作项不删除；best-effort 移除入池时打的
     * `dsh` 标签，失败只回带 tagWarning 不阻断还原。
     */
    restoreRequirement(key: string): Promise<RestoreResult>;
    /**
     * 实时重取需求工作项，把四段正文（详细信息/需求分析/数据结构/需求配置）回写看板（问题 11）。
     *
     * 保留本地字段（workspace 等）；需求不在本地池时返回失败（补全只针对已领取需求）。
     */
    enrichRequirement(key: string): Promise<EnrichResult>;
    /**
     * 校验并规范化工作目录（领取/编辑共用，fail-loud 口径一致）。
     *
     * 为什么抽出来：领取（`claimRequirement`）与编辑（`updateRequirementMeta` / `updateTask`）
     * 必须用**同一套**判定；两处各写一遍必然漂移（例如编辑放过了相对路径），
     * 而漂移的后果是"同一个字段有时能填有时不能"，比一开始就严格更难排查。
     *
     * @param raw - 原始输入（可为空串 = 清空）。
     * @returns `{ ok: true, value }`（value 为 undefined 表示清空）或 `{ ok: false, reason }`。
     */
    private resolveWorkspace;
    /**
     * 编辑已领取需求的**本地字段**（问题 3：增加提示词、切换工作目录）。
     *
     * 只允许改 `prompt` / `workspace` —— TFS 侧字段（标题/状态/标签）必须走
     * `confirmWrite` 的四道门禁，不能从这条路径绕过去。
     *
     * `undefined` = 不动，`null` = 清空（两者语义必须区分，否则用户删不掉已填的提示词）。
     *
     * @param key - 需求去重键 `id@collection`。
     * @param patch - 字段补丁。
     */
    updateRequirementMeta(key: string, patch: {
        workspace?: string | null;
        prompt?: string | null;
    }): {
        ok: boolean;
        reason?: string;
        requirement?: RequirementSummary;
    };
    /**
     * 编辑任务字段（问题 3/4：提示词 / 模型 / 供应商 / 技能 / MCP / 工作目录 / 预设 / 执行预算）。
     *
     * 工作目录在此**单独**校验（fail-loud），其余字段交给引擎 `Board.updateTask` 做
     * 结构化校验与 revision 乐观锁。工作目录先落进 `patch` 再交给引擎，保证"校验通过才写"。
     */
    updateTask(taskId: string, patch: {
        prompt?: string | null;
        workspace?: string | null;
        model?: string;
        modelProvider?: string;
        skills?: string[];
        mcp?: string[];
        preset?: string;
        workflow?: string;
        maxDepth?: number;
        maxTokens?: number;
    }, expectedRevision?: number): TaskOpResult;
    /**
     * 读本地落盘的可选项；文件缺失/损坏返回 data=null（损坏不锁死，调用方随即走采集）。
     * @param collection - 集合名；缺省用看板当前集合（由调用方解析后传入）。
     */
    loadQueryOptions(collection: string): {
        ok: boolean;
        data: RequirementQueryOptions | null;
        savedAt?: string;
    };
    /**
     * 强制重新采集可选项并原子落盘覆盖（问题 1「采集可选项」按钮）。
     * 全空结果不落盘（沿用 shouldCacheQueryOptions 判据，避免一次抖动锁死空下拉）。
     */
    collectQueryOptions(collection: string): Promise<{
        ok: boolean;
        data?: RequirementQueryOptions;
        reason?: string;
    }>;
    /** 读某集合的 UI 状态；文件缺失/损坏返回空对象（客户端回退默认值）。 */
    loadUiState(collection: string): UiState;
    /**
     * 合并保存某集合的 UI 状态（浅合并单集合节点；只覆盖 patch 给出的键）。
     * poolFilters 整体替换（筛选语义是"当前选择"，不做数组合并）。
     */
    saveUiState(patch: Partial<UiState>, collection: string): {
        ok: boolean;
        reason?: string;
    };
    /**
     * 指派/改派任务角色（T042）。角色须存在（S-13 引用校验）。
     * @param taskId - 任务 ID。
     * @param roleName - 角色展示名。
     */
    assignTask(taskId: string, roleName: string): TaskOpResult;
    /**
     * 任务状态操作（T043；问题 5 新增 `confirm`）。
     *
     * `start` / `retry` → 开一次尝试（重试从失败子任务续跑 S-07）；
     * `complete` → 成功收口；`fail` → 标记失败但保留可重试；`cancel` → 取消（FR-014 保留条目）；
     * `confirm`（问题 5）→ 把一条「待人工确认」任务人工确认通过、收口为完成，随后才放行
     * 下游自动链式执行与需求完成回写。
     *
     * @param taskId - 任务 ID。
     * @param action - 动作。
     * @param expectedRevision - 期望 revision（乐观锁；缺省用当前值，兼容无并发场景）。
     */
    setTaskState(taskId: string, action: TaskAction, expectedRevision?: number): TaskOpResult;
    /**
     * 装配层注入收口副作用钩子（问题 4 自动回写 / 问题 6 自动链式）。
     *
     * 之所以用 setter 而非构造参数：`BoardService` 在 `index.ts` 里**先于** `createHostApi` 构造，
     * 而钩子需要调用 api 内部的派发函数，存在构造顺序环。api 构造后立即调用本方法补接即可。
     */
    setSettledHook(hook: (info: TaskSettledInfo) => void): void;
    /**
     * 自动链式执行（问题 6）：一次性把当前**已就绪**（依赖全部完成）的待执行任务置为运行中，
     * 并打上 `autoLaunched` 标记；返回成功启动的任务 id，由装配层随后逐个发起真实派发。
     *
     * - 选任务用引擎 `Board.pickRunnable(limit)`：内部已扣除在跑/待确认占用的并发槽，且只选
     *   `pending && 依赖全 completed` 的任务，故待人工确认 / 失败任务会自然阻断其下游；
     * - 幂等防重入：已启动的任务离开 pending，不会被重复选中；多个任务并发收口时重复调用安全；
     * - 单个任务启动失败（revision 漂移 / 依赖刚变化）只记事件、不影响其余就绪任务。
     *
     * @param limit - 并发上限（通常传配置的 maxConcurrentRequirements）。
     * @param requirementKey - 只启动该需求名下的就绪任务（2026-11-03 问题 5 串行编排入口）；缺省全局。
     */
    autoStartRunnable(limit: number, requirementKey?: string): {
        ok: true;
        taskIds: string[];
    };
    /**
     * 派发返回后立即绑定子会话 runId（spec 006 US2）。
     *
     * 与收口分离：dispatch 一拿到 runId 就调用，使任务**运行中**也能按 runId 冷读执行轨迹。
     */
    bindRun(taskId: string, runId: string, provider?: string, turn?: number): TaskOpResult;
    /**
     * 按子 run 执行结果收口任务（spec 006 US2；问题 5 新增 `needs_confirmation`）。
     *
     * 与 `setTaskState` 的区别：携带执行元数据（runId/stopReason/diagnostic/output），落进闭合的
     * attempt。`failed` 时保留 in_progress 可重试（引擎既有语义）；`needs_confirmation` 时看板态
     * 保持 in_progress、阻断下游自动链式与需求回写，等待人工「确认通过」或「追问」。
     */
    settleTask(taskId: string, outcome: 'success' | 'failed' | 'needs_confirmation', meta?: AttemptMeta & {
        note?: string;
    }): TaskOpResult;
    /**
     * 为「追问 / 补充指令」打开新一轮执行（spec 006 US3）。
     *
     * completed 显式重开为 in_progress、failed 续跑；追加一条 running attempt 并保留全部历史。
     * @returns 成功时额外带 `attempt`（新一轮 attempt 下标）。
     */
    openFollowUp(taskId: string): TaskOpResult & {
        attempt?: number;
    };
    /**
     * 任务列表（T044）：按状态 / 角色 / 需求 / 关键字筛选。
     * @param filter - 筛选条件（全部可选）。
     */
    listTasks(filter?: {
        state?: TaskState;
        roleAgent?: string;
        requirementId?: string;
        keyword?: string;
    }): BoardTaskView[];
    /** 渲染 Markdown 看板并记录路径（T061，幂等）。 */
    renderMarkdown(): {
        ok: boolean;
        path: string;
        reason?: string;
    };
    /** 读取当前渲染出的 Markdown 文本（T061 json→md 一致性校验用）。 */
    readMarkdown(): string | null;
    /** 重放事件日志（诊断/对账用）。 */
    replayEvents(): Array<Record<string, unknown>>;
}
/** `TaskSnapshot` → 客户端可序列化视图。 */
export declare function toTaskView(t: {
    taskId: string;
    requirementId: string;
    title: string;
    description: string;
    roleAgent: string;
    state: TaskState;
    execState: string;
    blockedBy: string[];
    revision: number;
    frozenConfig: {
        mcp: string[];
        skills: string[];
        model: string;
        modelProvider?: string;
        preset?: string;
        maxDepth?: number;
        maxTokens?: number;
    };
    attempts: Array<{
        startedAt: string;
        endedAt?: string;
        outcome: string;
        note?: string;
        runId?: string;
        stopReason?: string;
        diagnostic?: string;
        output?: string;
        provider?: string;
    }>;
    workspace?: string;
    prompt?: string;
    artifactPaths?: string[];
    autoLaunched?: boolean;
    /** spec 010：任务级编排上下文（会话 id / 是否复用 / 归纳结论）。 */
    orchestration?: TaskOrchestration;
}): BoardTaskView;
//# sourceMappingURL=board-service.d.ts.map
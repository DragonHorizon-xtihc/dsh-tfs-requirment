/**
 * 宿主半编排核心（Phase 3：真实 HostBridge 的宿主侧实现）。
 *
 * 这是客户端半 `fetch` 调用的三个能力在宿主半的落地：
 *  - `getPanelData`：读 roles.json + 注入的模型/MCP/技能，返回面板静态数据；
 *  - `confirmWrite`：把 UI 的回写草稿（tag/comment/state）逐一过四道门禁后直连 TFS REST 写入；
 *  - `dispatch`：按角色名解析角色 → 构建 DispatchRequest → 经 RequirementDispatcher 派发。
 *
 * 本模块是**纯编排**：所有宿主 API（roles 落盘、TFS 适配层、subagent 派发）均以可注入依赖
 * 形式传入，因此可在单测里用桩驱动，无需起真实 DSH 宿主（参考 dsh-optimized-prompt 的
 * host-api / routes 分离）。
 *
 * @module dsh-tfs-requirment/host/api
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { TfsAdapter } from '../tfs/adapter.js';
import type { RoleDefinition, RoleStore } from '../orchestration/roles.js';
import { type RequirementDispatcher } from '../orchestration/dispatch.js';
import type { BoardService } from './board-service.js';
import type { AuditArchive } from './audit-archive.js';
import type { ProfileService } from './profile-service.js';
import type { TaskTraceService } from './task-trace.js';
import type { SkillGroupStore } from './skill-group-store.js';
import type { SubagentProbeResult } from './subagent-access.js';
import { type HealthProbePort } from './health.js';
import { type DshCatalogService } from './dsh-catalog.js';
import type { ScheduleService } from './scheduler.js';
import type { ArchiveResult, AuditView, BoardSnapshotView, ClaimRequirementInput, ClaimRequirementResult, DeleteTasksResult, DispatchDraft, EnrichResult, EnvFileResult, ExecutionPanelData, OrchestratorEnsureInput, OrchestratorEnsureResult, FollowUpTaskInput, FollowUpTaskResult, FrozenConfig, HealthResult, McpEnvTemplate, McpInstanceInfo, ProfileListResult, ProfileOpResult, ProfileSaveInput, RequirementFilter, RequirementExecStateResult, RequirementListResult, RequirementQueryOptions, RequirementWriteBackReport, RestoreResult, ScheduleEntryView, SetRequirementExecStateInput, SkillMcpGroup, TaskAction, TaskOpResult, TaskTraceResult, TfsToolCatalogView, UiState, UpdateRequirementInput, UpdateRequirementResult, UpdateTaskInput, WriteOpDraft, WriteOpType } from '../shared/contracts.js';
import { type CapabilitySkillBody, type ChildToolCall } from '../shared/capability-plan.js';
import type { OrchestratorSessionManager } from './orchestrator-session.js';
/**
 * 子 run 落定原因 → 看板收口结果（spec 006 US2）。
 *
 * 关键修复：`SubagentRun.result` 对**模型/传输失败是 resolve**（带 stopReason='error'/'refusal'/
 * 'max-tokens'/'aborted' + diagnostic），只有基础设施无法表达的故障才 reject。旧实现用
 * `.then(成功, 失败)` 收口，于是所有模型失败都被误标成「已完成」。只有 'completed' 算成功。
 */
export declare function mapStopReasonToOutcome(stopReason: string | undefined): 'success' | 'failed';
/**
 * 在 subagents 服务可达的探测结果上，再前置校验「当前是否有可派发的顶层会话」（D7）。
 *
 * 2026-11-03 修正：**"当前没有活跃会话"不等于"派发不了"**。只要宿主能现造一个会话
 * （`sessionController.create`，见 `canPrepareParent`），就不该把编排能力判成不可用并拦住
 * 用户 —— 旧行为在"从工作台直接发起"和"定时执行到点"两种场景下都是死路（后者还会因
 * 调度器 at-most-once 直接丢任务）。
 *
 * @param probe - {@link probeSubagents} 的现算结果（服务/工具/provider 是否就绪）。
 * @param getParent - 解析顶层父 Agent；无存活顶层会话时抛错（parent-resolver 同一判据）。
 * @param canPrepareParent - 能否在派发时准备出父会话（同步判定，无副作用）。
 * @returns 服务不可达则原样返回；服务可达时：
 *   - 有顶层会话 ⇒ 原样放行；
 *   - 无但能准备 ⇒ available:true + `parentOnDemand:true`（面板给"派发时自动准备"的提示）；
 *   - 无且不能准备 ⇒ 降级 available:false + 「请先开会话」的可操作提示，前端据此禁用。
 */
export declare function gateProbeByParent(probe: SubagentProbeResult, getParent: () => unknown, canPrepareParent?: () => boolean): SubagentProbeResult;
/** 各非 completed 落定原因的中文兜底说明（diagnostic 缺失时使用）。 */
export declare function stopReasonNote(stopReason: string | undefined): string;
/** 从子 run 的 ContentBlock[] 输出里抽取文本并截断为可落盘摘要。 */
export declare function extractOutputText(output: readonly ContentBlock[] | undefined): string;
/** 单条回写的结果。 */
export interface SingleWriteResult {
    /** 操作类型。 */
    opType: WriteOpType;
    /** 是否成功。 */
    ok: boolean;
    /** 失败原因。 */
    reason?: string;
}
/** confirmWrite 入参。 */
export interface ConfirmWriteInput {
    /** UI 提交的回写草稿列表。 */
    ops: WriteOpDraft[];
    /** 目标工作项 dedupKey，如 `123@WN_HIS`。 */
    targetWorkItem: string;
    /** 集合（dedupKey 未带时回退）。 */
    collection: string;
}
/** confirmWrite 出参。 */
export interface ConfirmWriteResult {
    ok: boolean;
    results: SingleWriteResult[];
    reason?: string;
}
/** dispatch 入参。 */
export interface DispatchInput {
    draft: DispatchDraft;
    targetWorkItem: string;
    collection: string;
    /**
     * 看板任务 ID（US3 任务中心派发时提供）。
     *
     * **为何必须有**：看板拆解出的任务 ID 形如 `123@WN_HIS#analyze`，而按角色临时派发的兜底 ID
     * 形如 `123@WN_HIS#<roleId>`。若派发不带 taskId，两套命名空间就对不上，run 的完成/失败
     * **永远回绑不到看板任务**（任务会停在 running）。带上 taskId 后，本方法会先启动该看板任务、
     * 并在 run 落定时自动把它收口为 completed / failed。
     */
    taskId?: string;
}
/** dispatch 出参。 */
export interface DispatchResult {
    ok: boolean;
    runId?: string;
    reason?: string;
    /** 本次派发实际关联的看板任务 id（问题 6：手工派发会新建一条；有则 UI 可直达任务中心查看）。 */
    taskId?: string;
    /** 该看板任务是否由本次派发**新建**（问题 6；用于 UI 提示"已创建任务 + 可去任务中心查看"）。 */
    createdTask?: boolean;
    /** 本次派发实际生效的工作目录（问题 1；UI 据此如实显示"代码库在哪"，而不是显示面板里选的值）。 */
    workspace?: string;
    /** true = 已登记为定时执行（问题 4）：到 `scheduledAt` 才真正派发，此刻不建任务。 */
    scheduled?: boolean;
    /** 定时派发的到点时刻（ISO 8601，精确到分；仅 scheduled=true 时有）。 */
    scheduledAt?: string;
}
/**
 * 需求完成自动回写器端口（问题 4；由 `host/requirement-finalizer.ts` 实现，以结构化最小面注入）。
 *
 * api 只负责"在正确的时机调用"，不关心字段/附件/关联任务的具体 TFS 写细节，便于桩测。
 */
export interface RequirementFinalizerPort {
    /**
     * 条件回写：仅当需求下全部任务完成（无待人工确认/失败/运行中）且本次尚未成功回写时执行；
     * 不满足条件返回 undefined（不报错）。内部幂等、防重入。
     *
     * @param options.finalSummary - spec 010：编排主 agent 的最终总结（有则作为结论评论主文案）。
     */
    maybeFinalize(requirementKey: string, options?: {
        finalSummary?: string;
    }): Promise<RequirementWriteBackReport | undefined>;
    /**
     * 显式（重新）回写：手动触发 / 部分失败后重试；`force=true` 允许对已回写需求重跑（幂等跳过已成功项）。
     *
     * @param options.finalSummary - spec 010：编排主 agent 的最终总结。
     */
    runWriteBack(requirementKey: string, force?: boolean, options?: {
        finalSummary?: string;
    }): Promise<RequirementWriteBackReport>;
}
/** 宿主半编排依赖（均由 apply 注入，便于单测）。 */
export interface HostApiDeps {
    /** 角色存储（读 roles.json）。 */
    roles: Pick<RoleStore, 'list' | 'getByName' | 'save' | 'delete'>;
    /**
     * 技能/MCP 分组存储（skill-groups.json，2026-11-03 用户诉求）。
     * 缺省（未接线）时 `getPanelData` 不下发 `skillGroups`、保存/删除返回能力降级。
     */
    skillGroups?: Pick<SkillGroupStore, 'list' | 'save' | 'delete'>;
    /** TFS 适配层（REST 直连；写操作唯一出口）。 */
    adapter: TfsAdapter;
    /** 需求并发分发器。 */
    dispatcher: Pick<RequirementDispatcher, 'dispatch'> & Partial<Pick<RequirementDispatcher, 'activeCount' | 'queuedCount' | 'getRun' | 'consumeTimeout' | 'takeTimeoutDetail' | 'forget' | 'cancel'>>;
    /**
     * 看板服务（US2/US3/US6：领取、拆解、指派、状态、恢复）。
     * 缺省时相关能力返回 `ok:false`（能力降级而非整体不可用）。
     */
    board?: BoardService;
    /** 连通性自检探测面（T029）。 */
    health?: {
        port: HealthProbePort;
        /** 适配层已实现 REST 分支的操作键（不含 `mcp__<server>__` 前缀）。 */
        availableTools?: () => string[];
    };
    /** 取当前宿主 Agent（SubagentStartRequest.parent 必填）。 */
    getParent: () => Agent;
    /**
     * 可选：**现场准备**一个父会话（2026-11-03 定时执行报错修复）。
     *
     * `getParent` 的同步链只看"**此刻**有没有存活的顶层会话"，于是：
     *   - 用户从「工作台」直接发起（没开过聊天会话）⇒ 必然被拦；
     *   - 定时执行**到点**那一刻，会话早关了 / dsh 重启过 ⇒ 必然失败（而调度器 at-most-once，
     *     失败即任务丢失）。
     * `ensureParent` 在这两种情况下恢复上次会话或新建一个（`host/parent-resolver.ts#ensure`）。
     * 缺省（未接线）时行为与旧版一致：只走同步解析。
     *
     * @param workspace - 期望的会话工作目录（子会话继承父目录，故传任务工作目录）。
     */
    ensureParent?: (workspace?: string) => Promise<Agent>;
    /**
     * 可选：当前能否在需要时准备出父会话（同步判定、无副作用，供面板探测用）。
     *
     * 为 true 时"当前没有活跃会话"不再把编排能力判成不可用 —— 面板改成
     * "无活跃会话，派发时自动准备"的提示，按钮照常可点。
     */
    canPrepareParent?: () => boolean;
    /**
     * 可选：解析某角色被哪些任务引用（T057 删除保护）。缺省视为无引用。
     * @param roleName - 角色展示名。
     * @returns 受影响任务/需求引用清单。
     */
    getRoleReferences?: (roleName: string) => string[];
    /**
     * US4 编排能力可达性探测（`host/subagent-access.ts#probeSubagents`）。
     *
     * 必须传**函数**而不是结果：`deps` 是值捕获，而"服务可不可用"是运行期事实
     * （提供方 fiber 何时激活、用户是否换了 profile）。缺省时面板不下发 `orchestration`。
     */
    probeOrchestration?: () => SubagentProbeResult;
    /** 可选模型清单（面板下拉）。 */
    models: string[];
    /** 可选 MCP server 名清单（来自 DSH 真实能力目录；本插件自身不依赖任何 mcp server）。 */
    mcpServers: string[];
    /** 可选技能清单。 */
    skills: string[];
    /** 标签候选（datalist）。 */
    tagSuggestions: string[];
    /**
     * DSH 真实能力目录服务（问题 4/5/6/7/9/11）：面板下拉渲染真实模型/工作区/预设/provider/技能/MCP，
     * 而非硬编码清单。`getPanelData` 在**每次请求时**取 `current()` 快照，避免 apply 期早于
     * `refresh()` 完成而拿到空目录。缺省（服务未注入）时面板回退到 `models`/`mcpServers`/`skills`。
     */
    catalog?: DshCatalogService;
    /**
     * 子 agent 工具黑名单（可选）。
     *
     * **REST 化后已不再由本插件提供**（2026-09-19）：旧实现需要它来拦住模型直调
     * `mcp__<server>__*` 绕过写门禁；REST 化后本插件不依赖任何 tfs mcp 实例，
     * TFS 写操作在本插件里**只有** `adapter.executeWrite` 一条带凭据的路径，
     * 故门禁保障变成结构性的，已无黑名单的必要。字段保留仅为兼容既有单测。
     */
    tfsToolDeny?: () => {
        allow?: readonly string[];
        deny?: readonly string[];
    };
    /**
     * 读取技能正文（宿主 `ctx.skills.get(name).content`）。
     *
     * 2026-10-29（诉求 3/4）：所选技能必须**真的**作用于子 agent。宿主的
     * `SubagentStartRequest` 没有工具/技能限制字段（见 `shared/capability-plan.ts` 注释），
     * 因此唯一可靠的通道是"把技能正文整篇写进子 agent 首条 prompt"。缺省（未接线）时
     * 仍下发技能名与调用纪律，只是没有正文可附。
     */
    loadSkillBodies?: (names: readonly string[]) => Promise<CapabilitySkillBody[]>;
    /**
     * 宿主当前注册的工具全名清单（`ctx.tools.schemas().map(s => s.name)`）。
     *
     * 用途：把用户勾选的 MCP server 名映射成真实工具名 `mcp__<server>__<tool>`；
     * 一个**没有注册任何工具**的 server 会在派发前被拒，而不是"选了但静默不生效"。
     */
    listToolNames?: () => string[];
    /**
     * 读取子会话的 `tool/call` 事件（落定后验收所选技能 / MCP 是否真被使用）。
     * 返回 `undefined` 表示"无法观测"（跳过验收），返回 `[]` 表示"确实一次工具都没调"。
     */
    readChildToolCalls?: (sessionId: string) => Promise<ChildToolCall[] | undefined>;
    /**
     * 读取子会话**真实工具表**（`request/header` 里的工具名并集）。
     *
     * 2026-10-30：用于戳穿"工具未注入"的谎报——现场子代理声称 MCP 未注入，
     * 但其请求工具表里 `mcp__tfs-mcp__*` 全在。返回 `undefined` = 无法核实（不据此判罚）。
     */
    readChildToolNames?: (sessionId: string) => Promise<string[] | undefined>;
    /** 技能调用工具名（宿主 `dsh-tool-skill` 默认注册为 `skill`）。 */
    skillToolName?: string;
    /**
     * 宿主半插件的加载时刻（ISO；2026-10-29 诊断字段）。
     *
     * 用途：面板显示"当前运行的宿主代码是什么时候加载的"。重新构建 `lib/` 后不重启 dsh，
     * 插件仍跑旧模块，而旧文案看起来完全"正常"（本次事故就是：构建产物已更新、报错仍是旧句）。
     */
    pluginLoadedAt?: string;
    /** 默认集合。 */
    collection: string;
    /**
     * 当前**生效**集合（可选；缺省回退 `collection`）。
     *
     * 为何需要它：`deps` 是值捕获（`createHostApi` 一次性快照），而切换集合是运行期真实副作用
     * （`onCollectionChange` → `adapter.setCollection`）。若可选项缓存用快照里的 `collection` 作键，
     * 切集合后键不变 ⇒ 既不会重采、还会拿旧集合的项目清单去填新集合的下拉。
     * 缓存键必须跟着"当前生效集合"走。
     */
    currentCollection?: () => string;
    /**
     * 可切换集合清单（FR-025，来自 `config.collections`）。
     * 缺省时只有 `collection` 一个可选值（UI 不显示无意义的切换器）。
     */
    collections?: string[];
    /** 定时轮询间隔（分钟，FR-024/S-14）。 */
    pollIntervalMinutes?: number;
    /**
     * 批量派发的单波并发上限（问题 5）。缺省 3，与 `RequirementDispatcher` 默认并发一致。
     * 由 apply 传 `config.maxConcurrentRequirements`，供客户端分波编排与宿主并发队列对齐。
     */
    dispatchConcurrency?: number;
    /**
     * 切换集合的落地动作（T030）。**必须是真实副作用**——缺省时 `setCollection` 直接拒绝，
     * 而不是"改了 UI 状态但适配层没变"（那种静默不一致比报错更难查）。
     */
    onCollectionChange?: (collection: string) => void;
    /** 审计归档服务（T063）。缺省时审计相关能力返回降级结果。 */
    audit?: Pick<AuditArchive, 'inspect' | 'archive'>;
    /** 连接档案服务（T031 / T028b）。缺省时档案能力整体降级。 */
    profiles?: ProfileService;
    /**
     * 本插件的能力目录（问题 8 / 12；REST 化后重定义，2026-09-19）。
     *
     * 由 apply 期用 `catalogView(IMPLEMENTED_OPERATIONS)` 现算：契约表全量登记，
     * 未实现 REST 分支的操作标 `unimplemented` 并计入 `missingCount`，
     * 故 UI 上不会出现"有封装但一调就报未映射"的假能力。
     * 缺省时该能力降级（`ok:false` + 可读原因），不阻断其它页签。
     */
    tfsToolCatalog?: () => TfsToolCatalogView;
    /**
     * 任务执行轨迹服务（spec 006 US2）：按 taskId/attempt 经 sessionQuery 冷读子会话事件。
     * 缺省时 `getTaskTrace` 返回 available:false（旧宿主/精简部署降级，不抛 500）。
     */
    trace?: TaskTraceService;
    /**
     * 需求完成自动回写器（问题 4）。缺省时不做 TFS 自动回写（仅本地需求完成态迁移）。
     */
    finalizer?: RequirementFinalizerPort;
    /**
     * 上一条依赖任务成功后是否自动执行下一条就绪任务（问题 6）。缺省 true（宿主侧自动链式）。
     * 关闭后退回"逐个手动点击运行"。
     */
    autoChainTasks?: boolean;
    /** 需求全部任务完成后是否自动回写 TFS（问题 4）。缺省 true。 */
    autoWriteBack?: boolean;
    /**
     * 归纳的"放行宽限"（毫秒，spec 010）。
     *
     * 任务收口后至多等这么久让编排主 agent 出结论；超时就**先放行下一个任务**，
     * 归纳继续在后台完成。缺省 20s。这不是归纳的硬超时（硬超时是
     * `OrchestratorSessionManager` 的 `summarizeTimeoutMs`），只是"链路愿意为结论等多久"。
     */
    summarizeGraceMs?: number;
    /** 最终总结的等待宽限（毫秒）；超时回退模板总结。缺省 60s。 */
    finalizeGraceMs?: number;
    /**
     * 委派深度默认上限（问题 1）。用于在执行纪律 prompt 中告知子智能体；硬限制已在分发器
     * 构造（DispatcherTimeouts.defaultMaxDepth）层强制，这里仅保持提示语与实际限制一致。0 = 不限制。
     */
    defaultMaxDepth?: number;
    /**
     * spec 010 编排主 agent（可选能力）。
     *
     * 缺省时本模块**完全退回 010 之前的语义**：不做归纳、不做 AI 最终总结、prompt 仍用
     * 「工作目录 → 需求提示词 → 任务正文」。这样老装配与精简部署不会因缺能力而报错。
     */
    orchestrator?: Pick<OrchestratorSessionManager, 'ensure' | 'summarize' | 'finalize' | 'decide'>;
    /**
     * 定时执行调度器（2026-11-03 问题 4/5；`index.ts` 以 `ScheduleService` 注入）。
     * 缺省 = 未装配：`schedule.mode:'at'` 的派发/编排登记被拒（fail loud，不静默立即跑）。
     */
    scheduler?: Pick<ScheduleService, 'schedule' | 'cancel' | 'list'>;
    /**
     * 主 agent 扫尾开关（2026-11-03 问题 7）。缺省 true（本次诉求的默认行为）。
     * 关闭后退回"停在待人工确认/失败、等用户手动处理"的旧口径。
     */
    sweepEnabled?: boolean;
    /** 单任务扫尾续跑轮数上限（超过转主 agent 亲做；缺省 2）。 */
    sweepMaxRounds?: number;
    /**
     * 是否复用任务子会话（spec 010 AC3.3）。缺省 false（沿用 ONE-SHOT）。
     *
     * 注意：复用路径**不经过** `RequirementDispatcher`（它没有 continuable 分支），
     * 开启后由 `deps.launchReusedTask` 负责。缺省时即便配置开启也不复用（能力缺失即降级）。
     */
    reuseTaskSessions?: boolean;
    /**
     * 复用会话任务的派发出口（spec 010 AC3.3）。
     *
     * 与 `deps.dispatcher.dispatch` 平级：返回 `{ id, result }` 形状的句柄，
     * 由 `launchRun` 统一接「绑定 runId → 按 stopReason 收口」，故收口链路零改动。
     */
    launchReusedTask?: (input: ReusedTaskLaunchInput) => Promise<ReusedTaskLaunchResult>;
}
/**
 * spec 010：复用会话任务的派发入参。
 */
export interface ReusedTaskLaunchInput {
    /** 需求去重键（复用键左半）。 */
    requirementId: string;
    /** 看板任务 id。 */
    taskId: string;
    /** 发起派发的父 Agent。 */
    parent: Agent;
    /** 消息正文（已含共享简报与执行纪律）。 */
    prompt: ContentBlock[];
    /** 角色（provider / preset）。 */
    role: RoleDefinition;
    /** 冻结配置（模型 / MCP / 技能 / 预算）。 */
    frozenConfig: FrozenConfig;
}
/** spec 010：复用会话任务的派发结果（形状对齐 `SubagentRun` 的只读子集）。 */
export interface ReusedTaskLaunchResult {
    /** 子会话 id（复用时 = 既有 childId；新建时 = 新建 continuable childId）。 */
    id: string;
    /** 是否复用了既有会话。 */
    reused: boolean;
    /** 本轮在复用子会话中的 turn 序号（D6）；新建恒 1，复用为当前 turn+1。 */
    turn?: number;
    /** 本轮落定结果（continuable 无 per-message result，由观测器合成）。 */
    result: Promise<SubagentResult>;
}
/** 宿主半编排对外形态（被路由层调用）。 */
export interface HostApi {
    getPanelData(): ExecutionPanelData;
    confirmWrite(input: ConfirmWriteInput): Promise<ConfirmWriteResult>;
    dispatch(input: DispatchInput): Promise<DispatchResult>;
    /** 需求池列表（US2）。 */
    listRequirements(filter: RequirementFilter): Promise<RequirementListResult>;
    /**
     * 需求筛选可选项（问题 1）：**优先读本地落盘缓存**（query-options.json），
     * 无缓存才采集一轮 TFS 元数据并落盘；并发请求共享一次采集。
     */
    getQueryOptions(): Promise<RequirementQueryOptions>;
    /** 强制重采需求筛选可选项并落盘覆盖（问题 1「采集可选项」按钮）。 */
    refreshQueryOptions(): Promise<RequirementQueryOptions>;
    /** 读本地落盘的可选项（问题 1；HostBridge 直通，无缓存 data=null）。 */
    loadQueryOptions(collection?: string): Promise<{
        ok: boolean;
        data: RequirementQueryOptions | null;
        savedAt?: string;
    }>;
    /** 强制重采并落盘（问题 1；HostBridge 直通）。 */
    collectQueryOptions(collection?: string): Promise<{
        ok: boolean;
        data?: RequirementQueryOptions;
        reason?: string;
    }>;
    /** 读 UI 状态（筛选记忆/每页条数，问题 2/4/6）。 */
    loadUiState(collection?: string): Promise<UiState>;
    /** 合并保存 UI 状态（问题 2/4/6）。 */
    saveUiState(patch: Partial<UiState>, collection?: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** 角色清单（US5）。 */
    listRoles(): RoleDefinition[];
    /** 保存/更新角色（US5）。 */
    saveRole(role: RoleDefinition): {
        ok: boolean;
        reason?: string;
    };
    /** 删除角色（US5 / T057）。 */
    deleteRole(id: string, force?: boolean): {
        ok: boolean;
        reason?: string;
        references?: string[];
    };
    /** 技能/MCP 分组清单（2026-11-03 用户诉求）。 */
    listSkillGroups(): SkillMcpGroup[];
    /** 保存/更新技能/MCP 分组（同名=覆盖）。 */
    saveSkillGroup(group: SkillMcpGroup): {
        ok: boolean;
        reason?: string;
    };
    /** 删除技能/MCP 分组。 */
    deleteSkillGroup(id: string): {
        ok: boolean;
        reason?: string;
    };
    /** 看板快照（US3 任务中心 / US6 恢复）。 */
    getBoard(): BoardSnapshotView;
    /** 领取需求入本地池（US2 / T036）+ 打 dsh 标签（T048）。 */
    claimRequirement(input: ClaimRequirementInput): Promise<ClaimRequirementResult>;
    /**
     * 拆解需求为任务（US3 / T041，问题 9/10）。
     * deleted 历史任务原地重建为全新 pending 任务；其他已存在任务跳过；返回新增/跳过计数。
     */
    decomposeRequirement(requirementId: string): Promise<{
        ok: boolean;
        taskIds?: string[];
        created?: number;
        skipped?: number;
        createdRoles?: string[];
        reason?: string;
    }>;
    /**
     * 开始编排（2026-11-03 问题 4/5）：立刻按依赖顺序启动该需求的子 Agent 链，
     * 或登记为定时启动（精确到分，持久化 + 重启补跑）。`sequential:true` 时上个任务完成才编排下个。
     */
    orchestrationStart(input: {
        requirementKey: string;
        mode: 'now' | 'at';
        dueAt?: string;
        sequential?: boolean;
    }): Promise<{
        ok: boolean;
        reason?: string;
        scheduledAt?: string;
    }>;
    /** 调度条目清单（问题 4/5 定时执行可视化；2026-11-03 问题 3 归一为 UI 视图）。 */
    listSchedules(): ScheduleEntryView[];
    /** 取消一条调度。 */
    cancelSchedule(id: string): boolean;
    /** 修改一条调度的到点时刻（2026-11-03 问题 3；同 id 覆盖 + 重新武装）。 */
    updateSchedule(id: string, dueAt: string): {
        ok: boolean;
        reason?: string;
        scheduledAt?: string;
    };
    /** 还原已领取需求回需求池（问题 7；名下仍有未取消任务时拒绝）。 */
    restoreRequirement(requirementKey: string): Promise<RestoreResult>;
    /** 实时重取需求四段正文并回写看板（问题 11）。 */
    enrichRequirement(requirementKey: string): Promise<EnrichResult>;
    /** 删除已取消任务（问题 8，支持批量；整批门禁）。 */
    deleteTasks(taskIds: string[]): Promise<DeleteTasksResult>;
    /** 编辑已领取需求的本地字段（问题 3：提示词 / 工作目录）。 */
    updateRequirement(input: UpdateRequirementInput): Promise<UpdateRequirementResult>;
    /** 设置需求级执行状态（问题 5：确认完成 / 取消完成）。 */
    setRequirementExecState(input: SetRequirementExecStateInput): Promise<RequirementExecStateResult>;
    /** 编辑任务字段（问题 4：提示词 / 模型 / 技能 / MCP / 工作目录），走 revision 乐观锁。 */
    updateTask(input: UpdateTaskInput): Promise<TaskOpResult>;
    /** 读取某次任务执行的过程轨迹（技能/MCP/工具调用时间线；spec 006 US2）。 */
    getTaskTrace(taskId: string, attemptIndex?: number): Promise<TaskTraceResult>;
    /** 对任务追问 / 补充指令：同角色同冻结配置起新一轮执行（spec 006 US3）。 */
    followUpTask(input: FollowUpTaskInput): Promise<FollowUpTaskResult>;
    /** 指派任务角色（US3 / T042）。 */
    assignTask(taskId: string, roleName: string): TaskOpResult;
    /** 任务状态操作（US3 / T043）。 */
    setTaskState(taskId: string, action: TaskAction, expectedRevision?: number): TaskOpResult;
    /** 连通性自检（US1 / T029）。 */
    healthCheck(): Promise<HealthResult>;
    /** 审计状态（T063 / S-03）。 */
    getAudit(): AuditView;
    /** 执行审计滚动归档（T063）。 */
    archiveAudit(): ArchiveResult;
    /**
     * 切换默认集合（T030 / FR-003 / FR-025）。
     * 只接受 `collections` 清单内的值；落地动作由 `onCollectionChange` 提供（真实副作用）。
     */
    setCollection(collection: string): {
        ok: boolean;
        reason?: string;
        collection?: string;
    };
    /** 连接档案清单（T031；不含 PAT）。 */
    listProfiles(): ProfileListResult;
    /** 保存/更新档案（T031；PAT 不回显）。 */
    saveProfile(input: ProfileSaveInput): ProfileOpResult;
    /** 删除档案（T031；S-12 擦除）。 */
    deleteProfile(id: string): ProfileOpResult;
    /** 设为活动档案（T031）。 */
    activateProfile(id: string): ProfileOpResult;
    /** MCP 接入模板（T028b；PAT 为占位符）。 */
    getMcpEnvTemplate(profileId?: string): McpEnvTemplate;
    /** 写出 MCP 启动环境文件（T028b）。 */
    writeMcpEnvFile(profileId?: string): EnvFileResult;
    /** MCP 实例诊断（T028b）。 */
    getMcpInstance(): McpInstanceInfo;
    /** 能力目录（问题 8 / 12）：`tfs_req_*` ⇄ 适配层操作键的一一对应 + 读写性质。 */
    getTfsToolCatalog(): TfsToolCatalogView;
    /**
     * 需求完成自动回写（问题 4）：置评审/自测字段、回写结论评论、上传产物附件、
     * 关联人员任务置已解决并设 FinishDate=明天。手动触发 / 部分失败后重跑（幂等）。
     */
    writeBackRequirement(input: {
        requirementKey: string;
        force?: boolean;
    }): Promise<{
        ok: boolean;
        reason?: string;
        report?: RequirementWriteBackReport;
    }>;
    /** spec 010 US1：确保需求有编排主 agent 会话（幂等）。 */
    orchestratorEnsure(input: OrchestratorEnsureInput): Promise<OrchestratorEnsureResult>;
    /**
     * 强制重采 DSH 能力目录并返回最新面板数据（问题 4/5/6/7/9/11 的"事后配置"场景）。
     *
     * 与 `getPanelData` 的区别：后者只读内存快照（`catalog.current()`），本方法先
     * `await catalog.refresh()` 再读，故能反映用户**在插件打开之后**新增的模型 / 技能 /
     * 预设 / 工作区 / MCP server。未注入 catalog 时退化为直接返回 `getPanelData()`。
     */
    refreshPanelData(): Promise<ExecutionPanelData>;
}
/**
 * 构造宿主半编排实例。
 * @param deps - 编排依赖（roles/adapter/dispatcher/getParent/面板静态数据）。
 * @returns HostApi 实例。
 */
export declare function createHostApi(deps: HostApiDeps): HostApi;
//# sourceMappingURL=api.d.ts.map
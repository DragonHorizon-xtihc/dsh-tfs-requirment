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
 * @module @deepseek-ai/dsh-tfs-requirment/host/api
 */

import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TfsAdapter } from '../tfs/adapter.js'
import type { RoleDefinition, RoleStore } from '../orchestration/roles.js'
import { resolveFrozenModelRoute, type RequirementDispatcher } from '../orchestration/dispatch.js'
import type { BoardService } from './board-service.js'
import type { AuditArchive } from './audit-archive.js'
import type { ProfileService } from './profile-service.js'
import type { TaskTraceService } from './task-trace.js'
import type { SubagentProbeResult } from './subagent-access.js'
import { runHealthCheck, type HealthProbePort } from './health.js'
import { type DshCatalogService } from './dsh-catalog.js'
import { blocksToText, truncate } from './trace-mapper.js'
import { buildWorkspacePromptSection, normalizeWorkspace } from '../shared/workspace.js'
import {
  buildExecBudgetSection,
  detectOutcome,
  extractHumanConfirmReason,
  parseArtifactPaths,
} from '../shared/exec-protocol.js'
import type {
  ArchiveResult,
  AuditView,
  BoardSnapshotView,
  ClaimRequirementInput,
  ClaimRequirementResult,
  DeleteTasksResult,
  DispatchDraft,
  EnrichResult,
  EnvFileResult,
  ExecutionPanelData,
  OrchestratorEnsureInput,
  OrchestratorEnsureResult,
  FollowUpTaskInput,
  FollowUpTaskResult,
  FrozenConfig,
  HealthResult,
  McpEnvTemplate,
  McpInstanceInfo,
  ProfileListResult,
  ProfileOpResult,
  ProfileSaveInput,
  RequirementFilter,
  RequirementExecStateResult,
  RequirementListResult,
  RequirementQueryOptions,
  RequirementWriteBackReport,
  RestoreResult,
  SetRequirementExecStateInput,
  TaskAction,
  TaskOpResult,
  TaskTraceResult,
  TfsToolCatalogView,
  UiState,
  UpdateRequirementInput,
  UpdateRequirementResult,
  UpdateTaskInput,
  WriteOpDraft,
  WriteOpType,
} from '../shared/contracts.js'
import { buildBriefSection, buildDigestSeed } from '../shared/brief.js'
import type { OrchestratorSessionManager } from './orchestrator-session.js'

/**
 * 子 run 落定原因 → 看板收口结果（spec 006 US2）。
 *
 * 关键修复：`SubagentRun.result` 对**模型/传输失败是 resolve**（带 stopReason='error'/'refusal'/
 * 'max-tokens'/'aborted' + diagnostic），只有基础设施无法表达的故障才 reject。旧实现用
 * `.then(成功, 失败)` 收口，于是所有模型失败都被误标成「已完成」。只有 'completed' 算成功。
 */
export function mapStopReasonToOutcome(stopReason: string | undefined): 'success' | 'failed' {
  return stopReason === 'completed' ? 'success' : 'failed'
}

/**
 * 在 subagents 服务可达的探测结果上，再前置校验「当前是否有可派发的顶层会话」（D7）。
 *
 * @param probe - {@link probeSubagents} 的现算结果（服务/工具/provider 是否就绪）。
 * @param getParent - 解析顶层父 Agent；无存活顶层会话时抛错（parent-resolver 同一判据）。
 * @returns 服务不可达则原样返回；服务可达但无顶层会话时降级为 available:false 并给出
 *          「请先开会话」的可操作提示，前端派发按钮据此禁用，而不是点完才在 dispatch 内失败。
 */
export function gateProbeByParent(
  probe: SubagentProbeResult,
  getParent: () => unknown,
): SubagentProbeResult {
  if (!probe.available) return probe
  try {
    getParent()
    return probe
  } catch (e) {
    return {
      available: false,
      providers: probe.providers,
      reason: `当前没有可派发的顶层会话（${(e as Error).message}）——请先在主会话中开始一轮对话/打开会话后，再发起执行`,
    }
  }
}

/** 各非 completed 落定原因的中文兜底说明（diagnostic 缺失时使用）。 */
export function stopReasonNote(stopReason: string | undefined): string {
  switch (stopReason) {
    case 'error':
      return '子智能体执行失败：模型或传输错误（stopReason=error）'
    case 'refusal':
      return '子智能体拒绝执行该任务（stopReason=refusal）'
    case 'max-tokens':
      return '子智能体在完成前达到输出 token 上限（stopReason=max-tokens）'
    case 'aborted':
      return '子智能体执行被中止（stopReason=aborted）'
    case 'completed':
      return ''
    default:
      return `子智能体未正常完成（stopReason=${String(stopReason ?? 'unknown')}）`
  }
}

/**
 * 单次尝试**落盘**的助手输出上限（字符）。
 *
 * 与"展示上限"分开：`MAX_TEXT_CHARS`（trace-mapper 的轨迹展示上限）若用在落盘上，
 * 一次运行的结论段往往落在第 2000 字符之后，等于永久丢掉；而 TFS 结论评论由
 * `RequirementFinalizer` 按**每任务** `MAX_TASK_OUTPUT_CHARS`、整体
 * `MAX_COMMENT_CHARS` 逐层截断，展示口径由它负责（两者都不看这里的上限）。
 * 这里留足余量（远大于 `MAX_COMMENT_CHARS` 的单任务配额之和量级），使落盘层不成为瓶颈。
 */
const MAX_PERSISTED_OUTPUT_CHARS = 20_000

/** 从子 run 的 ContentBlock[] 输出里抽取文本并截断为可落盘摘要。 */
export function extractOutputText(output: readonly ContentBlock[] | undefined): string {
  const text = blocksToText(output)
  return text ? truncate(text, MAX_PERSISTED_OUTPUT_CHARS) : ''
}

/** 单条回写的结果。 */
export interface SingleWriteResult {
  /** 操作类型。 */
  opType: WriteOpType
  /** 是否成功。 */
  ok: boolean
  /** 失败原因。 */
  reason?: string
}

/** confirmWrite 入参。 */
export interface ConfirmWriteInput {
  /** UI 提交的回写草稿列表。 */
  ops: WriteOpDraft[]
  /** 目标工作项 dedupKey，如 `123@WN_HIS`。 */
  targetWorkItem: string
  /** 集合（dedupKey 未带时回退）。 */
  collection: string
}

/** confirmWrite 出参。 */
export interface ConfirmWriteResult {
  ok: boolean
  results: SingleWriteResult[]
  reason?: string
}

/** dispatch 入参。 */
export interface DispatchInput {
  draft: DispatchDraft
  targetWorkItem: string
  collection: string
  /**
   * 看板任务 ID（US3 任务中心派发时提供）。
   *
   * **为何必须有**：看板拆解出的任务 ID 形如 `123@WN_HIS#analyze`，而按角色临时派发的兜底 ID
   * 形如 `123@WN_HIS#<roleId>`。若派发不带 taskId，两套命名空间就对不上，run 的完成/失败
   * **永远回绑不到看板任务**（任务会停在 running）。带上 taskId 后，本方法会先启动该看板任务、
   * 并在 run 落定时自动把它收口为 completed / failed。
   */
  taskId?: string
}

/** dispatch 出参。 */
export interface DispatchResult {
  ok: boolean
  runId?: string
  reason?: string
  /** 本次派发实际关联的看板任务 id（问题 6：手工派发会新建一条；有则 UI 可直达任务中心查看）。 */
  taskId?: string
  /** 该看板任务是否由本次派发**新建**（问题 6；用于 UI 提示"已创建任务 + 可去任务中心查看"）。 */
  createdTask?: boolean
  /** 本次派发实际生效的工作目录（问题 1；UI 据此如实显示"代码库在哪"，而不是显示面板里选的值）。 */
  workspace?: string
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
  maybeFinalize(
    requirementKey: string,
    options?: { finalSummary?: string },
  ): Promise<RequirementWriteBackReport | undefined>
  /**
   * 显式（重新）回写：手动触发 / 部分失败后重试；`force=true` 允许对已回写需求重跑（幂等跳过已成功项）。
   *
   * @param options.finalSummary - spec 010：编排主 agent 的最终总结。
   */
  runWriteBack(
    requirementKey: string,
    force?: boolean,
    options?: { finalSummary?: string },
  ): Promise<RequirementWriteBackReport>
}

/** 宿主半编排依赖（均由 apply 注入，便于单测）。 */
export interface HostApiDeps {
  /** 角色存储（读 roles.json）。 */
  roles: Pick<RoleStore, 'list' | 'getByName' | 'save' | 'delete'>
  /** TFS 适配层（REST 直连；写操作唯一出口）。 */
  adapter: TfsAdapter
  /** 需求并发分发器。 */
  dispatcher: Pick<RequirementDispatcher, 'dispatch'> &
    Partial<
      Pick<
        RequirementDispatcher,
        'activeCount' | 'queuedCount' | 'getRun' | 'consumeTimeout' | 'forget' | 'cancel'
      >
    >
  /**
   * 看板服务（US2/US3/US6：领取、拆解、指派、状态、恢复）。
   * 缺省时相关能力返回 `ok:false`（能力降级而非整体不可用）。
   */
  board?: BoardService
  /** 连通性自检探测面（T029）。 */
  health?: {
    port: HealthProbePort
    /** 适配层已实现 REST 分支的操作键（不含 `mcp__<server>__` 前缀）。 */
    availableTools?: () => string[]
  }
  /** 取当前宿主 Agent（SubagentStartRequest.parent 必填）。 */
  getParent: () => Agent
  /**
   * 可选：解析某角色被哪些任务引用（T057 删除保护）。缺省视为无引用。
   * @param roleName - 角色展示名。
   * @returns 受影响任务/需求引用清单。
   */
  getRoleReferences?: (roleName: string) => string[]
  /**
   * US4 编排能力可达性探测（`host/subagent-access.ts#probeSubagents`）。
   *
   * 必须传**函数**而不是结果：`deps` 是值捕获，而"服务可不可用"是运行期事实
   * （提供方 fiber 何时激活、用户是否换了 profile）。缺省时面板不下发 `orchestration`。
   */
  probeOrchestration?: () => SubagentProbeResult
  /** 可选模型清单（面板下拉）。 */
  models: string[]
  /** 可选 MCP server 名清单（来自 DSH 真实能力目录；本插件自身不依赖任何 mcp server）。 */
  mcpServers: string[]
  /** 可选技能清单。 */
  skills: string[]
  /** 标签候选（datalist）。 */
  tagSuggestions: string[]
  /**
   * DSH 真实能力目录服务（问题 4/5/6/7/9/11）：面板下拉渲染真实模型/工作区/预设/provider/技能/MCP，
   * 而非硬编码清单。`getPanelData` 在**每次请求时**取 `current()` 快照，避免 apply 期早于
   * `refresh()` 完成而拿到空目录。缺省（服务未注入）时面板回退到 `models`/`mcpServers`/`skills`。
   */
  catalog?: DshCatalogService
  /**
   * 子 agent 工具黑名单（可选）。
   *
   * **REST 化后已不再由本插件提供**（2026-09-19）：旧实现需要它来拦住模型直调
   * `mcp__<server>__*` 绕过写门禁；REST 化后本插件不依赖任何 tfs mcp 实例，
   * TFS 写操作在本插件里**只有** `adapter.executeWrite` 一条带凭据的路径，
   * 故门禁保障变成结构性的，已无黑名单的必要。字段保留仅为兼容既有单测。
   */
  tfsToolDeny?: () => { allow?: readonly string[]; deny?: readonly string[] }
  /** 默认集合。 */
  collection: string
  /**
   * 当前**生效**集合（可选；缺省回退 `collection`）。
   *
   * 为何需要它：`deps` 是值捕获（`createHostApi` 一次性快照），而切换集合是运行期真实副作用
   * （`onCollectionChange` → `adapter.setCollection`）。若可选项缓存用快照里的 `collection` 作键，
   * 切集合后键不变 ⇒ 既不会重采、还会拿旧集合的项目清单去填新集合的下拉。
   * 缓存键必须跟着"当前生效集合"走。
   */
  currentCollection?: () => string
  /**
   * 可切换集合清单（FR-025，来自 `config.collections`）。
   * 缺省时只有 `collection` 一个可选值（UI 不显示无意义的切换器）。
   */
  collections?: string[]
  /** 定时轮询间隔（分钟，FR-024/S-14）。 */
  pollIntervalMinutes?: number
  /**
   * 批量派发的单波并发上限（问题 5）。缺省 3，与 `RequirementDispatcher` 默认并发一致。
   * 由 apply 传 `config.maxConcurrentRequirements`，供客户端分波编排与宿主并发队列对齐。
   */
  dispatchConcurrency?: number
  /**
   * 切换集合的落地动作（T030）。**必须是真实副作用**——缺省时 `setCollection` 直接拒绝，
   * 而不是"改了 UI 状态但适配层没变"（那种静默不一致比报错更难查）。
   */
  onCollectionChange?: (collection: string) => void
  /** 审计归档服务（T063）。缺省时审计相关能力返回降级结果。 */
  audit?: Pick<AuditArchive, 'inspect' | 'archive'>
  /** 连接档案服务（T031 / T028b）。缺省时档案能力整体降级。 */
  profiles?: ProfileService
  /**
   * 本插件的能力目录（问题 8 / 12；REST 化后重定义，2026-09-19）。
   *
   * 由 apply 期用 `catalogView(IMPLEMENTED_OPERATIONS)` 现算：契约表全量登记，
   * 未实现 REST 分支的操作标 `unimplemented` 并计入 `missingCount`，
   * 故 UI 上不会出现"有封装但一调就报未映射"的假能力。
   * 缺省时该能力降级（`ok:false` + 可读原因），不阻断其它页签。
   */
  tfsToolCatalog?: () => TfsToolCatalogView
  /**
   * 任务执行轨迹服务（spec 006 US2）：按 taskId/attempt 经 sessionQuery 冷读子会话事件。
   * 缺省时 `getTaskTrace` 返回 available:false（旧宿主/精简部署降级，不抛 500）。
   */
  trace?: TaskTraceService
  /**
   * 需求完成自动回写器（问题 4）。缺省时不做 TFS 自动回写（仅本地需求完成态迁移）。
   */
  finalizer?: RequirementFinalizerPort
  /**
   * 上一条依赖任务成功后是否自动执行下一条就绪任务（问题 6）。缺省 true（宿主侧自动链式）。
   * 关闭后退回"逐个手动点击运行"。
   */
  autoChainTasks?: boolean
  /** 需求全部任务完成后是否自动回写 TFS（问题 4）。缺省 true。 */
  autoWriteBack?: boolean
  /**
   * 归纳的"放行宽限"（毫秒，spec 010）。
   *
   * 任务收口后至多等这么久让编排主 agent 出结论；超时就**先放行下一个任务**，
   * 归纳继续在后台完成。缺省 20s。这不是归纳的硬超时（硬超时是
   * `OrchestratorSessionManager` 的 `summarizeTimeoutMs`），只是"链路愿意为结论等多久"。
   */
  summarizeGraceMs?: number
  /** 最终总结的等待宽限（毫秒）；超时回退模板总结。缺省 60s。 */
  finalizeGraceMs?: number
  /**
   * 委派深度默认上限（问题 1）。用于在执行纪律 prompt 中告知子智能体；硬限制已在分发器
   * 构造（DispatcherTimeouts.defaultMaxDepth）层强制，这里仅保持提示语与实际限制一致。0 = 不限制。
   */
  defaultMaxDepth?: number
  /**
   * spec 010 编排主 agent（可选能力）。
   *
   * 缺省时本模块**完全退回 010 之前的语义**：不做归纳、不做 AI 最终总结、prompt 仍用
   * 「工作目录 → 需求提示词 → 任务正文」。这样老装配与精简部署不会因缺能力而报错。
   */
  orchestrator?: Pick<OrchestratorSessionManager, 'ensure' | 'summarize' | 'finalize'>
  /**
   * 是否复用任务子会话（spec 010 AC3.3）。缺省 false（沿用 ONE-SHOT）。
   *
   * 注意：复用路径**不经过** `RequirementDispatcher`（它没有 continuable 分支），
   * 开启后由 `deps.launchReusedTask` 负责。缺省时即便配置开启也不复用（能力缺失即降级）。
   */
  reuseTaskSessions?: boolean
  /**
   * 复用会话任务的派发出口（spec 010 AC3.3）。
   *
   * 与 `deps.dispatcher.dispatch` 平级：返回 `{ id, result }` 形状的句柄，
   * 由 `launchRun` 统一接「绑定 runId → 按 stopReason 收口」，故收口链路零改动。
   */
  launchReusedTask?: (input: ReusedTaskLaunchInput) => Promise<ReusedTaskLaunchResult>
}

/**
 * spec 010：复用会话任务的派发入参。
 */
export interface ReusedTaskLaunchInput {
  /** 需求去重键（复用键左半）。 */
  requirementId: string
  /** 看板任务 id。 */
  taskId: string
  /** 发起派发的父 Agent。 */
  parent: Agent
  /** 消息正文（已含共享简报与执行纪律）。 */
  prompt: ContentBlock[]
  /** 角色（provider / preset）。 */
  role: RoleDefinition
  /** 冻结配置（模型 / MCP / 技能 / 预算）。 */
  frozenConfig: FrozenConfig
}

/** spec 010：复用会话任务的派发结果（形状对齐 `SubagentRun` 的只读子集）。 */
export interface ReusedTaskLaunchResult {
  /** 子会话 id（复用时 = 既有 childId；新建时 = 新建 continuable childId）。 */
  id: string
  /** 是否复用了既有会话。 */
  reused: boolean
  /** 本轮在复用子会话中的 turn 序号（D6）；新建恒 1，复用为当前 turn+1。 */
  turn?: number
  /** 本轮落定结果（continuable 无 per-message result，由观测器合成）。 */
  result: Promise<SubagentResult>
}

/** 宿主半编排对外形态（被路由层调用）。 */
export interface HostApi {
  getPanelData(): ExecutionPanelData
  confirmWrite(input: ConfirmWriteInput): Promise<ConfirmWriteResult>
  dispatch(input: DispatchInput): Promise<DispatchResult>
  /** 需求池列表（US2）。 */
  listRequirements(filter: RequirementFilter): Promise<RequirementListResult>
  /**
   * 需求筛选可选项（问题 1）：**优先读本地落盘缓存**（query-options.json），
   * 无缓存才采集一轮 TFS 元数据并落盘；并发请求共享一次采集。
   */
  getQueryOptions(): Promise<RequirementQueryOptions>
  /** 强制重采需求筛选可选项并落盘覆盖（问题 1「采集可选项」按钮）。 */
  refreshQueryOptions(): Promise<RequirementQueryOptions>
  /** 读本地落盘的可选项（问题 1；HostBridge 直通，无缓存 data=null）。 */
  loadQueryOptions(collection?: string): Promise<{ ok: boolean; data: RequirementQueryOptions | null; savedAt?: string }>
  /** 强制重采并落盘（问题 1；HostBridge 直通）。 */
  collectQueryOptions(collection?: string): Promise<{ ok: boolean; data?: RequirementQueryOptions; reason?: string }>
  /** 读 UI 状态（筛选记忆/每页条数，问题 2/4/6）。 */
  loadUiState(collection?: string): Promise<UiState>
  /** 合并保存 UI 状态（问题 2/4/6）。 */
  saveUiState(patch: Partial<UiState>, collection?: string): Promise<{ ok: boolean; reason?: string }>
  /** 角色清单（US5）。 */
  listRoles(): RoleDefinition[]
  /** 保存/更新角色（US5）。 */
  saveRole(role: RoleDefinition): { ok: boolean; reason?: string }
  /** 删除角色（US5 / T057）。 */
  deleteRole(id: string, force?: boolean): { ok: boolean; reason?: string; references?: string[] }
  /** 看板快照（US3 任务中心 / US6 恢复）。 */
  getBoard(): BoardSnapshotView
  /** 领取需求入本地池（US2 / T036）+ 打 dsh 标签（T048）。 */
  claimRequirement(input: ClaimRequirementInput): Promise<ClaimRequirementResult>
  /**
   * 拆解需求为任务（US3 / T041，问题 9/10）。
   * deleted 历史任务原地重建为全新 pending 任务；其他已存在任务跳过；返回新增/跳过计数。
   */
  decomposeRequirement(
    requirementId: string,
  ): Promise<{ ok: boolean; taskIds?: string[]; created?: number; skipped?: number; createdRoles?: string[]; reason?: string }>
  /** 还原已领取需求回需求池（问题 7；名下仍有未取消任务时拒绝）。 */
  restoreRequirement(requirementKey: string): Promise<RestoreResult>
  /** 实时重取需求四段正文并回写看板（问题 11）。 */
  enrichRequirement(requirementKey: string): Promise<EnrichResult>
  /** 删除已取消任务（问题 8，支持批量；整批门禁）。 */
  deleteTasks(taskIds: string[]): Promise<DeleteTasksResult>
  /** 编辑已领取需求的本地字段（问题 3：提示词 / 工作目录）。 */
  updateRequirement(input: UpdateRequirementInput): Promise<UpdateRequirementResult>
  /** 设置需求级执行状态（问题 5：确认完成 / 取消完成）。 */
  setRequirementExecState(input: SetRequirementExecStateInput): Promise<RequirementExecStateResult>
  /** 编辑任务字段（问题 4：提示词 / 模型 / 技能 / MCP / 工作目录），走 revision 乐观锁。 */
  updateTask(input: UpdateTaskInput): Promise<TaskOpResult>
  /** 读取某次任务执行的过程轨迹（技能/MCP/工具调用时间线；spec 006 US2）。 */
  getTaskTrace(taskId: string, attemptIndex?: number): Promise<TaskTraceResult>
  /** 对任务追问 / 补充指令：同角色同冻结配置起新一轮执行（spec 006 US3）。 */
  followUpTask(input: FollowUpTaskInput): Promise<FollowUpTaskResult>
  /** 指派任务角色（US3 / T042）。 */
  assignTask(taskId: string, roleName: string): TaskOpResult
  /** 任务状态操作（US3 / T043）。 */
  setTaskState(taskId: string, action: TaskAction, expectedRevision?: number): TaskOpResult
  /** 连通性自检（US1 / T029）。 */
  healthCheck(): Promise<HealthResult>
  /** 审计状态（T063 / S-03）。 */
  getAudit(): AuditView
  /** 执行审计滚动归档（T063）。 */
  archiveAudit(): ArchiveResult
  /**
   * 切换默认集合（T030 / FR-003 / FR-025）。
   * 只接受 `collections` 清单内的值；落地动作由 `onCollectionChange` 提供（真实副作用）。
   */
  setCollection(collection: string): { ok: boolean; reason?: string; collection?: string }
  /** 连接档案清单（T031；不含 PAT）。 */
  listProfiles(): ProfileListResult
  /** 保存/更新档案（T031；PAT 不回显）。 */
  saveProfile(input: ProfileSaveInput): ProfileOpResult
  /** 删除档案（T031；S-12 擦除）。 */
  deleteProfile(id: string): ProfileOpResult
  /** 设为活动档案（T031）。 */
  activateProfile(id: string): ProfileOpResult
  /** MCP 接入模板（T028b；PAT 为占位符）。 */
  getMcpEnvTemplate(profileId?: string): McpEnvTemplate
  /** 写出 MCP 启动环境文件（T028b）。 */
  writeMcpEnvFile(profileId?: string): EnvFileResult
  /** MCP 实例诊断（T028b）。 */
  getMcpInstance(): McpInstanceInfo
  /** 能力目录（问题 8 / 12）：`tfs_req_*` ⇄ 适配层操作键的一一对应 + 读写性质。 */
  getTfsToolCatalog(): TfsToolCatalogView
  /**
   * 需求完成自动回写（问题 4）：置评审/自测字段、回写结论评论、上传产物附件、
   * 关联人员任务置已解决并设 FinishDate=明天。手动触发 / 部分失败后重跑（幂等）。
   */
  writeBackRequirement(input: {
    requirementKey: string
    force?: boolean
  }): Promise<{ ok: boolean; reason?: string; report?: RequirementWriteBackReport }>
  /** spec 010 US1：确保需求有编排主 agent 会话（幂等）。 */
  orchestratorEnsure(input: OrchestratorEnsureInput): Promise<OrchestratorEnsureResult>
  /**
   * 强制重采 DSH 能力目录并返回最新面板数据（问题 4/5/6/7/9/11 的"事后配置"场景）。
   *
   * 与 `getPanelData` 的区别：后者只读内存快照（`catalog.current()`），本方法先
   * `await catalog.refresh()` 再读，故能反映用户**在插件打开之后**新增的模型 / 技能 /
   * 预设 / 工作区 / MCP server。未注入 catalog 时退化为直接返回 `getPanelData()`。
   */
  refreshPanelData(): Promise<ExecutionPanelData>
}

/**
 * 取"真正有值"的字符串：`''` 与纯空白都视为**未设置**。
 *
 * 用于 model / preset 这类字段——它们语义上"空串 ≠ 有效值"，而 `??` 只挡 `null`/`undefined`。
 * 看板拆解冻结的 `frozenConfig.model` 经常是空串（角色没配默认模型），若直接透传会**覆盖**
 * 宿主为子会话解析出的模型路由（`resolveChildAgentOptions` 是 `...requested` 覆盖式合并），
 * 令子 agent 拿到不可解析的模型名（2026-09-21 假执行事故的伴生问题）。
 *
 * @param value - 原始字符串。
 * @returns 去空白后非空的字符串；否则 undefined。
 */
function nonEmptyString(value: string | undefined | null): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined
}

/**
 * 从 `123@WN_HIS` 解析出 id 与集合。
 *
 * **容忍看板任务 id 形态**：`123@WN_HIS#analyze` 这种 `<需求key>#<阶段>` 的字符串
 * （任务中心/右栏「设为目标」会把 taskId 当目标用）若直接按 `@` 切分，集合会变成
 * `WN_HIS#analyze` —— 写回时拿着这种集合去打 TFS 只会得到一个更费解的 404。
 * 因此这里先剥掉 `#…` 段，只认需求键部分。
 *
 * @param targetWorkItem - 目标键（`id@collection` 或 `id@collection#stage`）。
 * @param fallbackCollection - 键里没带集合时的回退集合。
 * @returns 工作项 id 与集合。
 */
function parseTarget(targetWorkItem: string, fallbackCollection: string): { id: string; collection: string } {
  const hash = targetWorkItem.indexOf('#')
  const base = hash >= 0 ? targetWorkItem.slice(0, hash) : targetWorkItem
  const at = base.indexOf('@')
  if (at < 0) return { id: base, collection: fallbackCollection }
  const id = base.slice(0, at)
  const collection = base.slice(at + 1) || fallbackCollection
  return { id, collection }
}

/**
 * 构造宿主半编排实例。
 * @param deps - 编排依赖（roles/adapter/dispatcher/getParent/面板静态数据）。
 * @returns HostApi 实例。
 */
export function createHostApi(deps: HostApiDeps): HostApi {
  function getPanelData(): ExecutionPanelData {
    const roles: RoleDefinition[] = deps.roles.list()
    // 每次请求取最新快照：apply 时 refresh() 可能尚未完成，current() 在运行时必定已是最新。
    const catalog = deps.catalog?.current()
    return {
      targetWorkItem: '—',
      collection: deps.collection,
      roles: roles.length > 0 ? roles : [],
      // 兼容清单（保留以兼容既有消费方 / 兜底）：优先取自 catalog 的真实项，否则回退 deps 旧字段。
      models: catalog?.models.length ? catalog.models.map(m => m.id) : deps.models,
      mcpServers: catalog?.mcpServers.length ? catalog.mcpServers : deps.mcpServers,
      skills: catalog?.skills.length ? catalog.skills.map(s => s.name) : deps.skills,
      // 真实枚举（问题 4/5/6/7/9/11）：直接透传 catalog 快照，UI 据此渲染真实下拉。
      modelOptions: catalog?.models ?? [],
      workspaces: catalog?.workspaces ?? [],
      presets: catalog?.presets ?? [],
      providers: catalog?.providers ?? [],
      skillOptions: catalog?.skills ?? [],
      tagSuggestions: deps.tagSuggestions,
      // 集合清单至少含当前集合：否则 UI 的切换器会出现"当前值不在选项里"的空选中态。
      collections: deps.collections?.length ? deps.collections : [deps.collection],
      pollIntervalMinutes: deps.pollIntervalMinutes ?? 5,
      dispatchConcurrency: deps.dispatchConcurrency ?? 3,
      // 问题 1/2：把目录采集的降级原因透出（"技能为空"要能区分"没装"与"没采到"）。
      ...(catalog ? { catalogWarnings: catalog.warnings, catalogCollectedAt: catalog.collectedAt } : {}),
      // US4 编排能力：每次请求现算（`subagents` 服务是否真的可用），让面板在点击前就能
      // 如实提示"派不了"，而不是让用户点了才收到一句"服务不可用"。
      // D7：在服务可达之外，再前置校验「当前是否有可派发的顶层会话」——无会话时 parent-resolver
      // 必然失败，这里提前把 available 置 false 并给出"先开会话"的可操作提示，按钮据此禁用。
      ...(deps.probeOrchestration
        ? { orchestration: gateProbeByParent(deps.probeOrchestration(), deps.getParent) }
        : {}),
      // 需求池/任务中心标题拼 TFS 需求页的兜底地址（只含 url，绝不含 PAT）。
      // 每次调用现取：档案会在运行期被切换（`deps` 是值捕获，缓存下来会拿旧地址）。
      ...(activeBaseUrl() ? { tfsBaseUrl: activeBaseUrl() } : {}),
    }
  }

  /**
   * 活动档案的服务地址（不含集合）。
   *
   * `ProfileView` 结构上没有 `pat` 字段，故这里**不可能**把凭据带进面板数据 ——
   * 这与"永不回显 PAT"是同一条纪律。
   */
  function activeBaseUrl(): string | undefined {
    const id = deps.profiles?.activeId()
    if (!id) return undefined
    return deps.profiles?.get(id)?.url
  }

  /**
   * 重采能力目录后再返回面板数据。
   *
   * `getPanelData` 只读内存快照，而用户在插件已挂载后仍可能补配模型 / 装技能 / 加 MCP
   * （这是常态，不是异常）。`catalog.refresh()` 自带 inflight 去重与逐项降级，故并发点击
   * 刷新按钮不会打爆 provider；`refresh` 本身从不抛错（内部 catch 后返回上一份快照）。
   */
  async function refreshPanelData(): Promise<ExecutionPanelData> {
    if (deps.catalog) {
      try {
        await deps.catalog.refresh()
      } catch {
        // refresh 内部已兜底；这里的 catch 只为"目录服务实现意外抛错"兜底，
        // 让面板仍能拿到上一份快照，而不是把错误抛给 HTTP 路由。
      }
    }
    return getPanelData()
  }

  async function confirmWrite(input: ConfirmWriteInput): Promise<ConfirmWriteResult> {
    // 回退集合用**调用方给的 collection**优先（视图所在集合），其次才是插件默认集合：
    // 目标键没带集合时（如 `1997179`），用默认集合会把写入打到另一个集合去。
    const { id, collection } = parseTarget(input.targetWorkItem, input.collection || deps.collection)
    // TFS 工作项 id 必为数字；占位 '—' 或非数字一律拒绝，避免发出 id:NaN 的无效写调用。
    const numericId = Number(id)
    if (!id || id.trim().length === 0 || !Number.isInteger(numericId) || numericId <= 0) {
      return { ok: false, results: [], reason: `targetWorkItem 缺少有效工作项 id：${input.targetWorkItem}` }
    }
    const results: SingleWriteResult[] = []
    for (const op of input.ops) {
      try {
        if (op.opType === 'tag') {
          const before = Array.isArray(op.before) ? (op.before as string[]) : []
          const after = Array.isArray(op.after) ? (op.after as string[]) : []
          const r = await deps.adapter.addTags(id, collection, after, before, true)
          results.push({ opType: 'tag', ok: r.ok, reason: r.reason })
        } else if (op.opType === 'comment') {
          const text = typeof op.after === 'string' ? op.after : ''
          if (!text) {
            results.push({ opType: 'comment', ok: false, reason: '评论内容为空' })
            continue
          }
          const r = await deps.adapter.addComment(id, collection, text, true)
          results.push({ opType: 'comment', ok: r.ok, reason: r.reason })
        } else if (op.opType === 'state') {
          const to = typeof op.after === 'string' ? op.after : ''
          const from = typeof op.before === 'string' ? op.before : ''
          if (!to) {
            results.push({ opType: 'state', ok: false, reason: '目标状态为空' })
            continue
          }
          const r = await deps.adapter.changeState(id, collection, to, from, true)
          results.push({ opType: 'state', ok: r.ok, reason: r.reason })
        } else if (op.opType === 'link') {
          // S-04：关联（变更集/TFVC）经评论回写实现，本插件暂不提供独立的 link 写工具。
          results.push({ opType: 'link', ok: false, reason: '暂不支持 link 回写（S-04：关联经评论实现）' })
        } else {
          results.push({ opType: (op.opType as WriteOpType), ok: false, reason: `未知回写类型 ${op.opType}` })
        }
      } catch (e) {
        results.push({ opType: op.opType, ok: false, reason: (e as Error).message })
      }
    }
    const failed = results.filter(r => !r.ok)
    return {
      ok: failed.length === 0,
      results,
      ...failed.length === 0 ? {} : { reason: failed.map(f => `${f.opType}:${f.reason}`).join('; ') },
    }
  }

  async function dispatch(input: DispatchInput): Promise<DispatchResult> {
    const role = deps.roles.getByName(input.draft.roleName)
    if (!role) {
      return { ok: false, reason: `角色 "${input.draft.roleName}" 不存在（检查 US5 角色配置）` }
    }
    if (!role.provider || role.provider.trim().length === 0) {
      return { ok: false, reason: `角色 "${role.name}" 未绑定 provider（S-13）` }
    }
    // 冻结配置：MCP/技能 UI 提交优先，缺省用角色默认值兜底；模型路由（model + LLM provider）
    // 经 resolveFrozenModelRoute 成对回落（spec 009：裸 model 会让子 agent 继承父会话供应商，
    // 造成"选火山方舟却跑英伟达"）。
    const modelRoute = resolveFrozenModelRoute({ frozen: input.draft.frozenConfig, role })
    const draftPreset = typeof input.draft.preset === 'string' ? input.draft.preset.trim() : ''
    const frozenConfig: FrozenConfig = {
      mcp: input.draft.frozenConfig?.mcp?.length ? input.draft.frozenConfig.mcp : (role.defaultMcp ?? []),
      skills: input.draft.frozenConfig?.skills?.length ? input.draft.frozenConfig.skills : (role.defaultSkills ?? []),
      model: modelRoute.model,
      ...(modelRoute.modelProvider ? { modelProvider: modelRoute.modelProvider } : {}),
      // 问题 3/1：预设与执行预算随任务冻结落库（空串/0 不写键，保持旧 JSON 形状）。
      ...(draftPreset ? { preset: draftPreset } : {}),
      ...(input.draft.maxDepth && input.draft.maxDepth > 0 ? { maxDepth: Math.floor(input.draft.maxDepth) } : {}),
      ...(input.draft.maxTokens && input.draft.maxTokens > 0 ? { maxTokens: Math.floor(input.draft.maxTokens) } : {}),
    }
    /**
     * 问题 6：执行配置页选的预设**覆盖**角色自带 `preset`。
     *
     * 为什么是克隆而不是改 `role`：`role` 取自 `RoleStore`（持久化在 roles.json），
     * 直接改字段会把一次性执行选择写回角色档案。克隆只在本次派发生效。
     */
    const dispatchRole: RoleDefinition =
      input.draft.preset && input.draft.preset !== role.preset ? { ...role, preset: input.draft.preset } : role
    // 任务上下文：把该任务的目标代码库路径写进 prompt。
    // **为何是 prompt 而不是 cwd**：宿主 `SubagentStartRequest` 无 cwd/workspace 字段，
    // 子代理工作目录只能来自「部署 cwd 覆盖 → 否则父会话 workspace」（dsh-subagent 的 resolveChildCwd）。
    // prompt 是插件唯一能影响子代理的通道，故 `shared/workspace.ts` 在这里给出一段**硬约束 + 可执行动作**
    // （绝对路径 / 先 cd 再执行 / 禁止在父会话工作目录里就近找代码），而不是一句"代码库位于 X"。
    const boardTask = input.taskId
      ? deps.board?.snapshot().tasks.find(t => t.taskId === input.taskId)
      : undefined
    /**
     * 需求键的**权威来源**：看板任务的 `requirementId` 优先于调用方传来的 target。
     *
     * 为什么：任务中心的 taskId 形如 `1997179@WN_HIS#analyze`，而客户端"目标"字段在多条
     * 路径上曾是面板占位符 `—`（2026-09-21 事故）。即便调用方给的目标不理想，
     * 只要任务本身知道它属于哪个需求，就应该用任务的答案 —— 否则子 agent 的 prompt 里
     * 会丢掉工作项号/集合（`workItemId: undefined`），run 也会被归到错误的 requirementId 桶里。
     */
    const requirementKey = boardTask?.requirementId ?? input.targetWorkItem
    const targetRef = parseTarget(requirementKey, input.collection || deps.collection)

    /**
     * 无看板任务时必须有**有效需求键**，否则拒绝派发。
     *
     * 旧行为会把兜底 taskId 拼成 `—#role-coder`（目标为面板占位符时的产物）：run 没有需求
     * 上下文、归组键也是垃圾值，用户只看到一句费解的 `分发失败（task=—#role-coder）`。
     * 宁可不派发，也要给出"该去哪儿选目标"的可执行提示。
     */
    if (!input.taskId && !/^\d+@/.test(requirementKey)) {
      return {
        ok: false,
        reason: `缺少有效的派发目标（当前目标：${input.targetWorkItem || '(空)'}）：`
          + '请先在「需求池」或「任务中心」把某个需求「选为目标」，再从「执行配置」发起执行',
      }
    }

    /**
     * 先解析真实 parent Agent，**再**创建/启动看板任务（2026-09-21 假执行事故修复点）。
     *
     * 为什么顺序不能反：`parent` 拿不到时（宿主无存活会话 / 不在 agent 调用链上），
     * 若已把任务置为 `in_progress/running`（或建了一条注定派不出去的手工任务），看板就会显示
     * "执行中"/多一条悬空任务，而子 agent 从未创建 —— 这正是"假执行"的用户可见形态。
     * 拿不到 parent 就**拒绝派发且不碰状态**，让"未派发"在 UI 上如实呈现。
     */
    let parent: Agent
    try {
      parent = deps.getParent()
    } catch (e) {
      return { ok: false, reason: `派发前置条件不满足：${(e as Error).message}` }
    }

    /**
     * spec 010：派发前 **best-effort** 建立编排主 agent（仅当该需求还没有）。
     *
     * 为什么这里要补一条：`ensure` 原本只在**拆解成功**时调用，于是"需求早就拆过、
     * 用户直接点派发"的场景**永远不会有主 agent** ⇒ 任务完成后无人归纳、也无人做最终总结
     * —— 这正是"主 agent 没有自动总结"的一条真实路径。
     *
     * 两个护栏：
     *   - 失败**绝不阻塞派发**（没有编排会话也要能把任务派出去）；
     *   - `OrchestratorSessionManager.ensure` 对 `mode:'off'` 直接返回既有结论，
     *     不会每次派发都重试一次注定失败的 `startContinuable`。
     */
    if (deps.orchestrator && requirementKey && !deps.board?.getOrchestration?.(requirementKey)) {
      try {
        const req0 = deps.board?.board?.snapshot?.requirements?.[requirementKey]
        await deps.orchestrator.ensure(requirementKey, {
          ...(req0 ? { title: req0.title, workspace: req0.workspace } : {}),
          ...(req0 ? { digestSeed: buildDigestSeed(req0) } : {}),
        })
      } catch {
        // best-effort：编排是增强能力，派发才是主路径。
      }
    }

    /**
     * 工作目录取值链（问题 1，2026-09-21 修复）。
     *
     * 优先级：**面板显式选择** > **看板任务自身的 workspace** > **需求级 workspace**。
     *
     * 旧实现只取 `boardTask?.workspace`：从「执行配置」发起执行时根本没有看板任务
     * （`input.taskId` 为空）⇒ 整段【工作目录】**完全不出现**在 prompt 里 ⇒ 子代理按进程 cwd
     * （父会话工作区）干活，用户看到的就是"任务上明明设了工作区，子代理却在另一个工程里改代码"。
     * 同时 `draft.workspace`（面板里选的工作区）此前是**死字段**（从未被读取），也一并接上。
     */
    const requirementWorkspace = deps.board?.board?.snapshot?.requirements?.[requirementKey]?.workspace
    const explicitWorkspace = nonEmptyString(input.draft.workspace)
    const workspace = normalizeWorkspace(
      explicitWorkspace ?? boardTask?.workspace ?? requirementWorkspace ?? '',
    )

    /**
     * 问题 6：「执行配置 → 发起执行」必须**落地为看板任务**，否则这次执行在任务中心里
     * 什么都看不到（无 attempt、无 runId、无轨迹、无失败原因），用户无从确认它跑没跑。
     *
     * 需求未领取时 `createManualTask` 会给出可读原因（不隐式入池）。
     */
    let effectiveTaskId = input.taskId
    let createdTask = false
    if (!effectiveTaskId) {
      const boardSvc = deps.board
      if (!boardSvc) {
        return {
          ok: false,
          reason: '看板服务不可用，无法把本次执行登记为任务：拒绝"无任务的派发"（否则执行内容在界面上不可见）',
        }
      }
      // 老版本装配（board 桩/旧服务）可能没有该方法：给出可读原因，而不是抛 TypeError 让路由 500。
      if (typeof boardSvc.createManualTask !== 'function') {
        return {
          ok: false,
          reason: '看板服务不支持"手工任务登记"（插件与宿主版本不匹配）：请从「任务中心」对具体任务点「派发执行」',
        }
      }
      const created = boardSvc.createManualTask({
        requirementKey,
        title: nonEmptyString(input.draft.title) ?? `${role.name} 手工执行`,
        description: input.draft.description ?? '',
        prompt: nonEmptyString(input.draft.prompt) ?? '',
        roleAgent: role.name,
        frozenConfig,
        ...(workspace ? { workspace } : {}),
      })
      if (!created.ok || !created.taskId) {
        return { ok: false, reason: created.reason ?? '创建执行任务失败' }
      }
      effectiveTaskId = created.taskId
      createdTask = true
    }

    // 有看板 taskId 时用看板 ID（两套命名空间必须一致，否则 run 结果无法回绑），否则退回兜底 ID。
    const taskId = effectiveTaskId ?? `${requirementKey}#${role.id}`
    const wsSection = buildWorkspacePromptSection({
      ...(workspace ? { workspace } : {}),
      ...(input.taskId ? { taskTitle: boardTask?.title } : {}),
      workItemId: Number(targetRef.id) || undefined,
      collection: targetRef.collection,
    })

    /**
     * 三段式 prompt 组装（问题 3/4/6/408）。
     *
     * 顺序固定为：**工作目录上下文 → 需求级提示词 → 任务级正文**。空段不产出空行
     * （`filter(Boolean)`），否则子代理会收到一串无意义的空行。
     *
     * - 「需求级提示词」取自看板需求记录（`Requirement.prompt`），**实时读取**而非随任务冻结：
     *   用户改了需求提示词后，尚未派发的任务必须立刻采用新值（复制进任务会制造两份真相）。
     * - 「任务级正文」优先任务自己的 `prompt`（问题 4 的编辑入口），其次用调用方给的
     *   `draft.prompt`（执行配置页手写的 prompt / 旧客户端），最后才回落
     *   `标题 + 描述`（保持看板任务的旧行为，不让用户拿到空 prompt）。
     *
     * 注意 `deps.board` 可能是测试桩（只有 snapshot/setTaskState）：这里全程可选链，
     * 拿不到需求记录时只少一段，不让派发失败。
     */
    const requirementPrompt = deps.board?.board?.snapshot?.requirements?.[requirementKey]?.prompt
    const freshBoardTask = createdTask
      ? deps.board?.snapshot().tasks.find(t => t.taskId === taskId)
      : boardTask
    const fallbackBody = freshBoardTask
      ? [freshBoardTask.title, freshBoardTask.description].filter(s => typeof s === 'string' && s.trim().length > 0).join('\n\n')
      : ''
    const taskBody = freshBoardTask?.prompt?.trim() || input.draft.prompt?.trim() || fallbackBody
    const promptText = [
      wsSection,
      buildSharedBriefSection({
        requirementKey,
        frozenConfig,
        ...(requirementPrompt?.trim() ? { requirementPrompt: requirementPrompt.trim() } : {}),
      }),
      taskBody,
    ].filter(s => s.length > 0).join('\n\n')
    const prompt: ContentBlock[] = [{ type: 'text', text: promptText }]

    // 看板绑定（US3）：把任务置为「进行中/运行中」并打开一次 attempt。失败即拒（依赖未就绪 /
    // 已终态 / revision 冲突），避免"派发了但看板上任务没动"这种静默不一致。
    if (deps.board) {
      const started = deps.board.setTaskState(taskId, 'start')
      if (!started.ok) {
        return {
          ok: false,
          reason: `看板任务不可启动：${started.reason}`,
          taskId,
          createdTask,
        }
      }
    }

    const launched = await launchRun({
      requirementId: requirementKey,
      taskId,
      boardTaskId: deps.board ? taskId : undefined,
      role: dispatchRole,
      frozenConfig,
      prompt,
      parent,
    })
    return {
      ...launched,
      taskId,
      ...(createdTask ? { createdTask: true } : {}),
      ...(workspace ? { workspace } : {}),
    }
  }

  /**
   * 真正发起一次子 run 并接好「启动 → 立即绑定 runId → 按 stopReason 收口」（dispatch 与 followUp 共用）。
   *
   * 调用前看板 attempt 必须已打开：首次派发走 `setTaskState('start')`，追问走 `openFollowUp`。
   *
   * ## 收口修复（spec 006 US2）
   * `SubagentRun.result` 对模型/传输失败是 **resolve**（stopReason≠completed + diagnostic），只有
   * 基础设施故障才 reject。故这里按 `stopReason` 判定成败，并把 runId/stopReason/diagnostic/输出摘要
   * 落进 attempt——旧实现 `.then(完成, 失败)` 会把模型失败误标成已完成，且丢弃失败原因。
   */
  /**
   * 组装派发 prompt 的「共享简报」段（spec 010 US3 / AC3.2）。
   *
   * ## 为什么它能省 token
   *
   * 旧口径把**需求提示词全文**塞进每一个任务的 prompt；N 个任务 = N 份相同正文，
   * 且前序任务的结论一点都不传递。现在需求级简报一旦有 `digest`，后续任务只拿
   * 「摘要 + 已完成结论 + 产物 + 已绑定工具」，需求正文**不再重复下发**。
   *
   * ## 降级
   *
   * 无编排能力 / 旧看板（没有 `orchestration`）时，原样退回「【需求提示词】全文」——
   * 与 010 之前逐字一致，不改变任何既有行为。
   *
   * @param input.requirementKey - 需求去重键。
   * @param input.frozenConfig - 本次生效的冻结配置（MCP/技能以它为准，简报可能滞后）。
   * @param input.requirementPrompt - 需求提示词全文（仅无简报摘要时使用）。
   */
  function buildSharedBriefSection(input: {
    requirementKey: string
    frozenConfig: FrozenConfig
    requirementPrompt?: string
  }): string {
    const orch = deps.board?.getOrchestration?.(input.requirementKey)
    const brief = orch?.brief
    if (!brief) {
      return input.requirementPrompt ? `【需求提示词】\n${input.requirementPrompt}` : ''
    }
    return buildBriefSection(brief, {
      mcp: input.frozenConfig.mcp,
      skills: input.frozenConfig.skills,
      ...(input.requirementPrompt ? { requirementPrompt: input.requirementPrompt } : {}),
    })
  }

  /**
   * 在任务 prompt 末尾统一追加「执行预算与终止纪律」段（问题 1/4/5）。
   *
   * 三条派发路径（执行配置派发 / 任务中心启动 / 追问）都经 launchRun，故在这里统一注入，
   * 避免散落三处对不上。追加到最后一个 text 块；没有 text 块则新增一个。
   */
  function withBudgetSection(prompt: ContentBlock[], frozen: FrozenConfig): ContentBlock[] {
    const effectiveDepth =
      frozen.maxDepth && frozen.maxDepth > 0 ? frozen.maxDepth : (deps.defaultMaxDepth ?? 0)
    const section = buildExecBudgetSection({ maxDepth: effectiveDepth })
    const lastText = (() => {
      for (let i = prompt.length - 1; i >= 0; i--) {
        const b = prompt[i]
        if (b && typeof b === 'object' && (b as { type?: string }).type === 'text') return i
      }
      return -1
    })()
    if (lastText === -1) return [...prompt, { type: 'text', text: section } as ContentBlock]
    return prompt.map((b, i) => {
      if (i !== lastText) return b
      const prev = (b as { text?: string }).text ?? ''
      return { ...(b as object), text: `${prev}\n\n${section}` } as ContentBlock
    })
  }

  async function launchRun(p: {
    requirementId: string
    /** dispatcher 内部键（看板任务 id，或无看板时的兜底 id）。 */
    taskId: string
    /** 看板任务 id（有则回绑 runId/状态/轨迹）。 */
    boardTaskId?: string
    role: RoleDefinition
    /** 模型路由必须成对（model + 可选 modelProvider），由 resolveFrozenModelRoute 统一产出。 */
    frozenConfig: FrozenConfig
    prompt: ContentBlock[]
    /**
     * 真实宿主 Agent（`SubagentStartRequest.parent`）。
     *
     * **必须由调用方先解析并传入**：解析失败时调用方要在动看板状态**之前**就返回，
     * 否则会留下"running 但从未派发"的假执行（见 `dispatch` 内的顺序注释）。
     */
    parent: Agent
  }): Promise<DispatchResult> {
    try {
      // 问题 3：任务级冻结预设覆盖角色自带 preset（克隆而非改 role 实例，避免污染 RoleStore）。
      // 说明：宿主 ONE-SHOT `subagents.start` 的请求体无 per-child preset 字段，子 agent 的 preset
      // 作用域默认继承父会话实时链；这里仍把 role.preset 改为任务冻结值，保持三条派发路径一致，
      // 并供角色可用性校验与未来宿主支持 per-child preset 时直接生效（不臆造请求字段）。
      const effectiveRole: RoleDefinition =
        p.frozenConfig.preset && p.frozenConfig.preset !== p.role.preset
          ? { ...p.role, preset: p.frozenConfig.preset }
          : p.role
      const budgetedPrompt = withBudgetSection(p.prompt, p.frozenConfig)

      /**
       * spec 010 AC3.3：**优先复用同一需求的持久任务子会话**。
       *
       * 前置条件（三者缺一即回退 ONE-SHOT）：
       *   ① 配置开启；② 装配注入了复用派发出口；③ 该需求的编排能力**已被证明可用**
       *   （`mode === 'continuable'`）—— 复用与编排依赖同一个 continuable 能力，
       *   没有理由一边判定不可用、一边还去试。
       *
       * 复用失败（provider 拒绝续投 / 会话已被清理）时记事件并**当场回退** ONE-SHOT：
       * 用户要的是"任务跑起来"，不是"必须复用"。
       */
      // 两个分支（复用 / ONE-SHOT）都必然赋值；用断言让 TS 认可这一事实。
      let handle!: { id: string; provider: string; reused: boolean; turn?: number; result?: Promise<SubagentResult> }
      let usedReuse = false
      /** 复用失败的原因（仅用于诊断与回写任务上下文；成功时为空）。 */
      let reuseFallbackReason: string | undefined
      const reuseReady =
        deps.reuseTaskSessions === true
        && typeof deps.launchReusedTask === 'function'
        && deps.board?.getOrchestration?.(p.requirementId)?.mode === 'continuable'
      if (reuseReady && p.boardTaskId) {
        try {
          const r = await deps.launchReusedTask!({
            requirementId: p.requirementId,
            taskId: p.taskId,
            parent: p.parent,
            prompt: budgetedPrompt,
            role: effectiveRole,
            frozenConfig: p.frozenConfig,
          })
          handle = { id: r.id, provider: effectiveRole.provider, reused: r.reused, turn: r.turn, result: r.result }
          usedReuse = true
        } catch (e) {
          usedReuse = false
          // ⚠️ 兑现上面注释的承诺：**记下原因**再回退（2026-10-06 修复）。
          // 此前是空 `catch {}`，复用为什么没生效完全没有痕迹 —— 而 `launchReusedTask`
          // 内部已经排过一次队（`acquireReuseTurn`），回退 ONE-SHOT 又要再排一次并发槽，
          // 用户等了两轮排队却只看到 ONE-SHOT 成功，无从追问。典型原因（provider 不支持
          // continuable / 排队超时 / 会话已被清理）本来都是可诊断的，留下来才谈得上排查。
          // 下面会把原因写进任务编排上下文（随 board.json 落盘，任务详情可读）。
          reuseFallbackReason = e instanceof Error ? e.message : String(e)
        }
      }
      if (!usedReuse) {
        // 把"为什么没复用"回写到任务编排上下文，让它在任务详情里可见（事件日志之外再留一处）。
        if (reuseFallbackReason && p.boardTaskId) {
          try {
            deps.board?.setTaskOrchestration?.(p.boardTaskId, { reused: false, fallbackReason: reuseFallbackReason })
          } catch {
            /* 同上：诊断写不进去不影响派发 */
          }
        }
        const result = await deps.dispatcher.dispatch(
          {
            requirementId: p.requirementId,
            taskId: p.taskId,
            role: effectiveRole,
            frozenConfig: p.frozenConfig,
            // 问题 1：统一注入执行纪律段（控 token / 防重复 / 防死循环 / 人工确认与产物协议）。
            prompt: budgetedPrompt,
            // 问题 1：任务级执行预算（maxDepth 缺省由分发器构造默认值兜底）。
            ...(p.frozenConfig.maxDepth && p.frozenConfig.maxDepth > 0
              ? { maxDepth: p.frozenConfig.maxDepth }
              : {}),
            ...(p.frozenConfig.maxTokens && p.frozenConfig.maxTokens > 0
              ? { maxTokens: p.frozenConfig.maxTokens }
              : {}),
            // REST 化后不再需要"拒绝原始 mcp 工具"：插件不依赖任何 tfs mcp 实例，
            // 写操作只有 `adapter.executeWrite` 一条带凭据的路径。字段保留仅为兼容旧装配。
            toolFilter: deps.tfsToolDeny?.(),
          },
          { parent: p.parent },
        )
        const run = deps.dispatcher.getRun?.(p.taskId)
        if (deps.dispatcher.getRun && !run) {
          /**
           * 分发器**能**给出 run 句柄、但这一刻没有 ⇒ 没有任何东西会回调收口。不显式判失败
           * 的话，这个任务会永远停在 `in_progress/running`（看板里可编辑被 `execState=running`
           * 挡住），正是"假执行"。`getRun` 整个缺失属能力降级（自定义分发器实现），此时沿用
           * 宽松语义，不据 absence 判失败。
           */
          const diagnostic = '分发完成但拿不到子会话句柄（dispatcher.getRun 未返回 run）：无法观测收口，任务已判失败'
          deps.dispatcher.forget?.(p.taskId)
          deps.board?.settleTask(p.boardTaskId ?? p.taskId, 'failed', {
            runId: result.runId,
            stopReason: 'infrastructure-error',
            diagnostic,
            note: diagnostic,
          })
          return { ok: false, reason: diagnostic }
        }
        handle = {
          id: result.runId,
          provider: result.provider,
          reused: false,
          ...(run ? { result: run.result } : {}),
        }
      }
      if (deps.board && p.boardTaskId) {
        // 立即绑定 runId：任务运行中也能按 runId 冷读执行轨迹，而不必等落定。
        // 复用子会话时同时绑定本轮 turn（D6），运行中查轨迹也能隔离到本轮。
        deps.board.bindRun(p.boardTaskId, handle.id, handle.provider, handle.turn)
        if (usedReuse) {
          // spec 010：把复用会话落到任务上，UI 的"切换到子 agent"据此定位会话。
          deps.board.setTaskOrchestration?.(p.boardTaskId, { sessionId: handle.id, reused: true })
        }
        const runResult = handle.result
        const bindTaskId = p.boardTaskId
        runResult?.then(
          (sr: SubagentResult) => {
            const output = extractOutputText(sr?.output)
            // 问题 4：从最终输出解析关键产物绝对路径（ARTIFACTS 段），落到任务级清单。
            const artifactPaths = parseArtifactPaths(output)
            /**
             * 问题 1：总时长看门狗终止优先于 run 自报原因（aborted 也可能是用户手动取消，
             * 但 consumeTimeout 命中即确定是看门狗），落"运行超时"失败。
             */
            const timedOut = deps.dispatcher.consumeTimeout?.(bindTaskId) === true
            // 超时标记消费后即可丢弃该任务的 run 追踪（run 句柄 + 需求索引 + 看门狗定时器）。
            deps.dispatcher.forget?.(bindTaskId)
            if (timedOut) {
              const note = '任务运行总时长超过看门狗上限，已被自动终止（可能存在死循环或失控空转）'
              deps.board?.settleTask(bindTaskId, 'failed', {
                runId: handle.id,
                stopReason: 'timeout',
                diagnostic: note,
                ...(output ? { output } : {}),
                note,
              })
              return
            }
            /**
             * 问题 5：收口不再只看 stopReason。`detectOutcome` 同时检查输出内容——
             * stopReason=completed 但结论是"请人工确认/人工确定"时，判 needs_confirmation，
             * 任务停在待确认（看板态保持 in_progress），不自动进入下游、不触发完成回写。
             */
            const outcome = detectOutcome(sr?.stopReason, output)
            if (outcome === 'success') {
              deps.board?.settleTask(bindTaskId, 'success', {
                runId: handle.id,
                stopReason: sr?.stopReason,
                ...(output ? { output } : {}),
                ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
              })
            } else if (outcome === 'needs_confirmation') {
              const reason = extractHumanConfirmReason(output)
              deps.board?.settleTask(bindTaskId, 'needs_confirmation', {
                runId: handle.id,
                stopReason: sr?.stopReason,
                ...(output ? { output } : {}),
                ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
                note: `待人工确认：${reason}`,
              })
            } else {
              const diagnostic = sr?.diagnostic?.trim() || stopReasonNote(sr?.stopReason)
              deps.board?.settleTask(bindTaskId, 'failed', {
                runId: handle.id,
                stopReason: sr?.stopReason,
                diagnostic,
                ...(output ? { output } : {}),
                note: diagnostic,
              })
            }
          },
          (e: unknown) => {
            // 仅基础设施无法表达为 stopReason 的故障才会走到 reject。
            deps.dispatcher.forget?.(bindTaskId)
            const message = e instanceof Error ? e.message : String(e)
            deps.board?.settleTask(bindTaskId, 'failed', {
              runId: handle.id,
              stopReason: 'infrastructure-error',
              diagnostic: message,
              note: message,
            })
          },
        )
      }
      return { ok: true, runId: handle.id }
    } catch (e) {
      // 启动失败（信号量/start 抛错）：把已打开的 attempt 收口为失败（保留条目 FR-014），不留 running 悬挂。
      const message = (e as Error).message
      if (deps.board && p.boardTaskId) {
        deps.board.settleTask(p.boardTaskId, 'failed', {
          stopReason: 'dispatch-failed',
          diagnostic: message,
          note: message,
        })
      }
      return { ok: false, reason: message }
    }
  }

  /** 读取某次任务执行的过程轨迹（spec 006 US2）；服务缺失/会话不可读均降级为 available:false。 */
  async function getTaskTrace(taskId: string, attemptIndex?: number): Promise<TaskTraceResult> {
    if (!deps.trace) {
      return {
        ok: false,
        taskId,
        attempt: attemptIndex ?? -1,
        available: false,
        entries: [],
        reason: '轨迹服务不可用（宿主未提供 sessionQuery）',
      }
    }
    return deps.trace.getTrace(taskId, attemptIndex)
  }

  /**
   * 对任务追问 / 补充指令（spec 006 US3）。
   *
   * v1 采用「关联追问轮次」：同一任务、同一角色、同一冻结配置（模型/MCP/技能）与工作区，
   * 打开一条**新的 attempt / 新的子 run**，prompt 带上一轮输出或失败诊断 + 追问内容；
   * completed 任务由 `openFollowUp` 显式重开，历史 attempts 全部保留。
   * （continuable 同会话续聊需持久父会话，本插件 parent 不保证，列为后续增强，见 research.md。）
   */
  async function followUpTask(input: FollowUpTaskInput): Promise<FollowUpTaskResult> {
    const message = typeof input?.message === 'string' ? input.message.trim() : ''
    if (!message) return { ok: false, reason: '追问内容为空' }
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    const taskId = typeof input?.taskId === 'string' ? input.taskId : ''
    if (!taskId) return { ok: false, reason: 'taskId 必填' }

    const task = deps.board.snapshot().tasks.find(t => t.taskId === taskId)
    if (!task) return { ok: false, reason: `未知任务：${taskId}` }
    if (task.state === 'deleted') return { ok: false, reason: '任务已取消（终态），不可追问' }

    const role = deps.roles.getByName(task.roleAgent)
    if (!role || !role.provider?.trim()) {
      return { ok: false, reason: `任务角色「${task.roleAgent}」不存在或未绑定 provider，无法追问` }
    }
    // 沿用任务创建时冻结的配置（FR-012），不回退到角色当前值，保证可复现。
    // 模型路由成对回落（spec 009）：任务冻结缺 modelProvider 时再看角色默认 provider。
    const followUpRoute = resolveFrozenModelRoute({ frozen: task.frozenConfig, role })
    const frozenConfig: FrozenConfig = {
      mcp: [...(task.frozenConfig?.mcp ?? [])],
      skills: [...(task.frozenConfig?.skills ?? [])],
      model: followUpRoute.model,
      ...(followUpRoute.modelProvider ? { modelProvider: followUpRoute.modelProvider } : {}),
      // 问题 3/1：追问沿用任务冻结的预设与执行预算，保证可复现。
      ...(task.frozenConfig?.preset ? { preset: task.frozenConfig.preset } : {}),
      ...(task.frozenConfig?.maxDepth ? { maxDepth: task.frozenConfig.maxDepth } : {}),
      ...(task.frozenConfig?.maxTokens ? { maxTokens: task.frozenConfig.maxTokens } : {}),
    }

    // 与 dispatch 同样：先解析真实 parent，拿不到就**不**开新一轮 attempt，
    // 避免留下"running 但从未派发"的假执行。
    let parent: Agent
    try {
      parent = deps.getParent()
    } catch (e) {
      return { ok: false, reason: `派发前置条件不满足：${(e as Error).message}` }
    }

    // 上一轮结果/诊断（开新 attempt 之前最后一条已闭合尝试）。
    const prior = [...(task.attempts ?? [])].reverse().find(a => a.endedAt)
    const opened = deps.board.openFollowUp(taskId)
    if (!opened.ok || opened.attempt === undefined) return { ok: false, reason: opened.reason }

    // 工作目录沿用 任务级 > 需求级 回落（问题 1）；追问与首轮必须是同一个代码库。
    const requirementId = String(task.requirementId)
    const workspace = normalizeWorkspace(
      task.workspace ?? deps.board.board?.snapshot?.requirements?.[requirementId]?.workspace ?? '',
    )
    const wsSection = buildWorkspacePromptSection({
      ...(workspace ? { workspace } : {}),
      taskTitle: task.title,
      workItemId: Number(requirementId.split('@')[0]) || undefined,
      collection: requirementId.split('@')[1],
    })
    const requirementPrompt = deps.board.board?.snapshot?.requirements?.[requirementId]?.prompt
    const priorLines: string[] = []
    if (prior) {
      priorLines.push(`【上一轮执行（${prior.outcome}${prior.stopReason ? ` / ${prior.stopReason}` : ''}）】`)
      if (prior.diagnostic) priorLines.push(`失败诊断：${prior.diagnostic}`)
      if (prior.output) priorLines.push(`上一轮输出：\n${prior.output}`)
    }
    const taskBackground = task.prompt?.trim() || [task.title, task.description].filter(s => s.trim().length > 0).join('\n\n')
    const promptText = [
      wsSection,
      requirementPrompt?.trim() ? `【需求提示词】\n${requirementPrompt.trim()}` : '',
      taskBackground ? `【任务背景】\n${taskBackground}` : '',
      priorLines.join('\n\n'),
      `【追问 / 补充指令】\n${message}\n\n请在同一代码库与需求上下文内继续完成该任务，并保持既有角色、模型与工具配置。`,
    ]
      .filter(s => s.length > 0)
      .join('\n\n')
    const prompt: ContentBlock[] = [{ type: 'text', text: promptText }]

    const launched = await launchRun({
      requirementId: task.requirementId,
      taskId,
      boardTaskId: taskId,
      role,
      frozenConfig,
      prompt,
      parent,
    })
    const fresh = deps.board.snapshot().tasks.find(t => t.taskId === taskId)
    if (!launched.ok || !launched.runId) {
      return { ok: false, reason: launched.reason, ...(fresh ? { task: fresh } : {}) }
    }
    return {
      ok: true,
      runId: launched.runId,
      attempt: opened.attempt,
      ...(fresh ? { task: fresh } : {}),
    }
  }

  function listRequirements(filter: RequirementFilter): Promise<RequirementListResult> {
    return deps.adapter.listRequirements(filter)
  }

  // ───────────────── 需求筛选可选项缓存（问题 1：落盘优先） ─────────────────
  //
  // ## 缓存语义（2026-09-20 按问题 1 重写）
  //
  // - 权威缓存是插件数据目录的 **`query-options.json`（按集合命名空间）**，由 BoardService
  //   两个 JsonStore 方法读写：首次采集后落盘，之后每次打开面板/切页签都**优先读盘**，
  //   不再重复调用 TFS 元数据接口（逐项目取类型/状态曾是数百次 REST 的开销）。
  // - 「采集可选项」按钮 → `collectQueryOptions` 强制重采并原子覆盖落盘。
  // - 进程内只保留**并发去重**登记（同一集合的并发首采共享一次真实采集），不做第二份缓存。
  /**
   * 并发去重：同一集合的并发请求共享一次真实采集（否则 N 次进入 = N 轮全量采集）。
   *
   * 值是 `{ key, promise }` 而不是裸 promise：`key` 是本次登记的令牌，用于收尾时
   * "只撤自己那一项"（期间登记项可能已被 `refreshQueryOptions` 换成别人的）。
   * 裸 promise 做不到这点——要么自引用（TS2454），要么误删别人的登记。
   */
  const queryOptionsInflight = new Map<
    string,
    { key: object; promise: Promise<RequirementQueryOptions> }
  >()

  /** 只撤自己登记的那一项；若期间已被别人替换，则原样保留。 */
  function retireInflight(col: string, key: object): void {
    const cur = queryOptionsInflight.get(col)
    if (cur && cur.key === key) queryOptionsInflight.delete(col)
  }

  /** 当前生效集合（优先取运行期 getter，回退值捕获的 `deps.collection`）。 */
  function currentCollection(): string {
    const live = deps.currentCollection?.()
    return typeof live === 'string' && live.length > 0 ? live : deps.collection
  }

  /**
   * 读盘优先的可选项获取（问题 1）。
   * 落盘缓存命中 → 直接返回；未命中 → 采集一轮并落盘（BoardService.collectQueryOptions
   * 内部含"全空不落盘"判据）；看板服务缺失时回退直接采集（旧行为）。
   */
  function getQueryOptions(): Promise<RequirementQueryOptions> {
    const col = currentCollection()
    if (deps.board) {
      const cached = deps.board.loadQueryOptions(col)
      if (cached.data) return Promise.resolve(cached.data)
    }
    const pending = queryOptionsInflight.get(col)
    if (pending) return pending.promise
    const key = {}
    const promise = (async (): Promise<RequirementQueryOptions> => {
      try {
        if (deps.board) {
          const r = await deps.board.collectQueryOptions(col)
          if (r.ok && r.data) return r.data
          // 落盘采集失败：回落直接调适配层（保留旧的错误透传行为）。
        }
        return await deps.adapter.getQueryOptions(col)
      } finally {
        retireInflight(col, key)
      }
    })()
    queryOptionsInflight.set(col, { key, promise })
    return promise
  }

  /** 「采集可选项」按钮：强制重采并落盘覆盖（问题 1）。 */
  async function refreshQueryOptions(): Promise<RequirementQueryOptions> {
    const col = currentCollection()
    // 刻意**不复用** inflight 里的旧采集：本方法的语义就是"另起一次真实采集"。
    // 但仍把自己登记进 inflight，让并发的普通请求共享这次重采，不重复打 TFS。
    const key = {}
    const promise = (async (): Promise<RequirementQueryOptions> => {
      if (deps.board) {
        const r = await deps.board.collectQueryOptions(col)
        if (r.ok && r.data) return r.data
        throw new Error(r.reason ?? '采集可选项失败')
      }
      return await deps.adapter.getQueryOptions(col)
    })()
    queryOptionsInflight.set(col, { key, promise })
    try {
      return await promise
    } finally {
      retireInflight(col, key)
    }
  }

  /** HostBridge 直通：读盘（无缓存 data=null）。 */
  async function loadQueryOptions(collection?: string) {
    const col = collection || currentCollection()
    if (deps.board) return deps.board.loadQueryOptions(col)
    return { ok: false as const, data: null as RequirementQueryOptions | null, reason: '看板服务不可用' }
  }

  /** HostBridge 直通：强制重采并落盘。 */
  async function collectQueryOptions(collection?: string) {
    const col = collection || currentCollection()
    if (deps.board) return deps.board.collectQueryOptions(col)
    return { ok: false, reason: '看板服务不可用' }
  }

  async function loadUiState(collection?: string): Promise<UiState> {
    const col = collection || currentCollection()
    return deps.board ? deps.board.loadUiState(col) : {}
  }

  async function saveUiState(patch: Partial<UiState>, collection?: string) {
    const col = collection || currentCollection()
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    return deps.board.saveUiState(patch, col)
  }

  function listRoles(): RoleDefinition[] {
    return deps.roles.list()
  }

  function saveRole(role: RoleDefinition): { ok: boolean; reason?: string } {
    try {
      deps.roles.save(role)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  function deleteRole(id: string, force?: boolean): { ok: boolean; reason?: string; references?: string[] } {
    const role = deps.roles.list().find(r => r.id === id)
    if (!role) return { ok: false, reason: `角色 ${id} 不存在` }
    // T057：被任务引用的角色默认拒绝删除，给出受影响引用清单；force=true 才真正删除。
    const references = (deps.getRoleReferences ?? defaultRoleReferences)?.(role.name) ?? []
    if (references.length > 0 && !force) {
      return {
        ok: false,
        reason: `角色「${role.name}」仍被 ${references.length} 处引用，删除前请确认`,
        references,
      }
    }
    const removed = deps.roles.delete(id)
    return removed ? { ok: true } : { ok: false, reason: `角色 ${id} 删除失败` }
  }

  /** 缺省引用解析：从看板任务里找引用该角色的任务 ID（真实引用，非空壳实现）。 */
  function defaultRoleReferences(roleName: string): string[] {
    if (!deps.board) return []
    return deps.board.listTasks({ roleAgent: roleName }).map(t => t.taskId)
  }

  /** 看板能力缺失时的统一降级返回。 */
  function boardUnavailable(): BoardSnapshotView {
    return {
      ok: false,
      reason: '看板服务不可用（插件数据目录不可写或初始化失败）',
      version: 0,
      updatedAt: '',
      requirements: [],
      tasks: [],
      counts: { pending: 0, inProgress: 0, completed: 0, running: 0, queued: 0 },
    }
  }

  function getBoard(): BoardSnapshotView {
    if (!deps.board) return boardUnavailable()
    return deps.board.snapshot()
  }

  async function claimRequirement(input: ClaimRequirementInput): Promise<ClaimRequirementResult> {
    if (!deps.board) return { ok: false, added: false, reason: '看板服务不可用' }
    return deps.board.claimRequirement(input)
  }

  async function decomposeRequirement(
    requirementId: string,
  ): Promise<{ ok: boolean; taskIds?: string[]; created?: number; skipped?: number; createdRoles?: string[]; reason?: string }> {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    if (typeof requirementId !== 'string' || requirementId.length === 0) {
      return { ok: false, reason: 'requirementId 必填' }
    }
    const result = deps.board.decompose(requirementId)
    /**
     * spec 010 US2：拆解成功后**立即**为该需求准备编排主 agent。
     *
     * 为什么放在这里：`ensure` 之后共享简报才存在，随后自动链式派发的第一个任务
     * 就能拿到「摘要 + 已绑定工具」而不是需求正文全文。失败只记原因（`mode:'off'`），
     * **不影响拆解结果** —— 编排是增强能力，不是拆解的前置条件。
     */
    if (result.ok) {
      try {
        const req = deps.board.board?.snapshot?.requirements?.[requirementId]
        await deps.orchestrator?.ensure(requirementId, {
          ...(req ? { title: req.title, workspace: req.workspace } : {}),
          ...(req ? { digestSeed: buildDigestSeed(req) } : {}),
          tools: { mcp: [], skills: [] },
        })
      } catch {
        // 编排会话创建失败由 ensure 内部落 `mode:'off'` + reason，此处不外溢。
      }
    }
    return result
  }

  /**
   * spec 010 US1：确保需求有编排主 agent 会话（幂等；失败 fail-loud 落 `mode:'off'`）。
   */
  async function orchestratorEnsure(
    input: OrchestratorEnsureInput,
  ): Promise<OrchestratorEnsureResult> {
    const key = typeof input?.requirementKey === 'string' ? input.requirementKey.trim() : ''
    if (key.length === 0) return { ok: false, reason: 'requirementKey 必填' }
    if (!deps.board) return { ok: false, reason: '看板服务不可用，无法登记编排会话' }
    if (!deps.orchestrator) {
      return {
        ok: false,
        reason: '编排主 agent 未装配（宿主未提供 continuable 能力或插件配置已关闭）：'
          + '任务仍可正常派发与执行，但没有 AI 归纳与最终总结',
      }
    }
    try {
      const req = deps.board.board?.snapshot?.requirements?.[key]
      const orch = await deps.orchestrator.ensure(key, {
        ...(req ? { title: req.title, workspace: req.workspace } : {}),
        ...(req ? { digestSeed: buildDigestSeed(req) } : {}),
        // 面板按钮 = 用户显式要求重试：即便之前判过 "off" 也再试一次。
        ...(input.force === true ? { force: true } : {}),
      })
      return { ok: orch.mode === 'continuable', orchestration: orch, ...(orch.reason ? { reason: orch.reason } : {}) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  async function restoreRequirement(requirementKey: string): Promise<RestoreResult> {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      return { ok: false, reason: 'requirementKey 必填' }
    }
    return deps.board.restoreRequirement(requirementKey)
  }

  async function enrichRequirement(requirementKey: string): Promise<EnrichResult> {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      return { ok: false, reason: 'requirementKey 必填' }
    }
    return deps.board.enrichRequirement(requirementKey)
  }

  async function deleteTasks(taskIds: string[]): Promise<DeleteTasksResult> {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    if (!Array.isArray(taskIds) || taskIds.length === 0) return { ok: false, reason: '未选择任何任务' }
    return deps.board.deleteTasks(taskIds)
  }

  /**
   * 编辑已领取需求的本地字段（问题 3）。
   *
   * 只透传**本地补充字段**（prompt / workspace）：TFS 侧字段必须走 `confirmWrite` 的四道门禁，
   * 从这条路径改会绕过写门禁与审计 —— 这正是本方法要做输入白名单的原因，而不是直接
   * 把 body 展开给 BoardService。
   */
  async function updateRequirement(input: UpdateRequirementInput): Promise<UpdateRequirementResult> {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    const key = typeof input?.requirementKey === 'string' ? input.requirementKey : ''
    if (key.length === 0) return { ok: false, reason: 'requirementKey 必填' }
    const patch: { workspace?: string | null; prompt?: string | null } = {}
    if ('workspace' in (input as object)) {
      const ws = (input as { workspace?: unknown }).workspace
      if (ws !== null && typeof ws !== 'string') return { ok: false, reason: 'workspace 必须是字符串或 null' }
      patch.workspace = ws as string | null
    }
    if ('prompt' in (input as object)) {
      const p = (input as { prompt?: unknown }).prompt
      if (p !== null && typeof p !== 'string') return { ok: false, reason: 'prompt 必须是字符串或 null' }
      patch.prompt = p as string | null
    }
    if (Object.keys(patch).length === 0) return { ok: false, reason: '未提供任何可改字段（prompt / workspace）' }
    return deps.board.updateRequirementMeta(key, patch)
  }

  /**
   * 设置需求级执行状态（问题 5：确认完成 / 取消完成）。
   *
   * 只接受 `'active' | 'completed'` 两个字面量：状态是 UI 分页（任务中心 ⇄ 已完成）的依据，
   * 放开成任意字符串会让需求掉进"两个页都不显示"的缝隙。
   */
  async function setRequirementExecState(input: SetRequirementExecStateInput): Promise<RequirementExecStateResult> {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    const key = typeof input?.requirementKey === 'string' ? input.requirementKey : ''
    if (key.length === 0) return { ok: false, reason: 'requirementKey 必填' }
    const state = input?.state
    if (state !== 'active' && state !== 'completed') {
      return { ok: false, reason: "state 必须是 'active'（取消完成）或 'completed'（确认完成）" }
    }
    return deps.board.setRequirementExecState(key, state)
  }

  /** 编辑任务字段（问题 4）。校验放宿主：客户端半没有类型运行时，入参可能来自任意调用方。 */
  async function updateTask(input: UpdateTaskInput): Promise<TaskOpResult> {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    const taskId = typeof input?.taskId === 'string' ? input.taskId : ''
    if (taskId.length === 0) return { ok: false, reason: 'taskId 必填' }
    const patch: {
      prompt?: string | null
      workspace?: string | null
      model?: string
      modelProvider?: string
      skills?: string[]
      mcp?: string[]
      preset?: string
      maxDepth?: number
      maxTokens?: number
    } = {}
    if ('prompt' in (input as object)) {
      const p = (input as { prompt?: unknown }).prompt
      if (p !== null && typeof p !== 'string') return { ok: false, reason: 'prompt 必须是字符串或 null' }
      patch.prompt = p as string | null
    }
    if ('workspace' in (input as object)) {
      const ws = (input as { workspace?: unknown }).workspace
      if (ws !== null && typeof ws !== 'string') return { ok: false, reason: 'workspace 必须是字符串或 null' }
      patch.workspace = ws as string | null
    }
    if (input.model !== undefined) {
      if (typeof input.model !== 'string') return { ok: false, reason: 'model 必须是字符串' }
      patch.model = input.model
    }
    if (input.modelProvider !== undefined) {
      if (typeof input.modelProvider !== 'string') {
        return { ok: false, reason: 'modelProvider 必须是字符串' }
      }
      patch.modelProvider = input.modelProvider
    }
    for (const field of ['skills', 'mcp'] as const) {
      const v = input[field]
      if (v === undefined) continue
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
        return { ok: false, reason: `${field} 必须是字符串数组` }
      }
      patch[field] = [...v]
    }
    // 问题 3：预设（agent preset id，允许空串=清空回落角色定义）。
    if (input.preset !== undefined) {
      if (typeof input.preset !== 'string') return { ok: false, reason: 'preset 必须是字符串' }
      patch.preset = input.preset
    }
    // 问题 1：执行预算（非负有限数；0 = 沿用默认/不限制）。
    for (const field of ['maxDepth', 'maxTokens'] as const) {
      const v = input[field]
      if (v === undefined) continue
      if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
        return { ok: false, reason: `${field} 必须是非负有限数` }
      }
      patch[field] = v
    }
    if (Object.keys(patch).length === 0) {
      return {
        ok: false,
        reason: '未提供任何可改字段（prompt / workspace / model / modelProvider / skills / mcp / preset / maxDepth / maxTokens）',
      }
    }
    if (input.expectedRevision !== undefined) {
      if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
        return { ok: false, reason: 'expectedRevision 必须是非负整数' }
      }
    }
    return deps.board.updateTask(taskId, patch, input.expectedRevision)
  }

  function assignTask(taskId: string, roleName: string): TaskOpResult {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    return deps.board.assignTask(taskId, roleName)
  }

  /**
   * 「启动 / 重试」任务时**真正发起一次派发**（2026-09-21 假执行事故修复点）。
   *
   * ## 为什么需要
   *
   * 看板 `start` / `retry` 只把任务写成 `in_progress + execState=running` 并追加一条空
   * attempt（`Board.startTask`），**本身不做任何派发**；UI 上「启动」「重试」又是独立按钮。
   * 于是用户点完看到的是"进行中"，而子智能体从未创建 —— 零 token、零产物，且永远没有收口，
   * 任务会永久停在 running。这不是"重试"，是假执行。
   *
   * 这里在状态落地后立即按任务自己的角色与冻结配置发起真实派发。任一前置条件不满足
   * （角色未绑 provider / 拿不到真实 parent）都**当场收口为 failed 并写诊断**，
   * 绝不留悬空 running。
   *
   * @param taskId - 看板任务 id（调用前该任务的 attempt 必须已由 start/retry 打开）。
   */
  async function launchBoardTaskExecution(taskId: string): Promise<void> {
    if (!deps.board) return
    /** 收口为失败并写入可读诊断（attempt 有 endedAt 与 diagnostic，用户能看到原因）。 */
    const settleFailed = (note: string): void => {
      deps.board?.settleTask(taskId, 'failed', {
        stopReason: 'dispatch-failed',
        diagnostic: note,
        note,
      })
    }
    try {
      const task = deps.board.snapshot().tasks.find(t => t.taskId === taskId)
      if (!task) return
      const role = deps.roles.getByName(task.roleAgent)
      if (!role?.provider?.trim()) {
        settleFailed(`任务角色「${task.roleAgent}」不存在或未绑定 provider（检查 US5 角色配置）`)
        return
      }
      let parent: Agent
      try {
        parent = deps.getParent()
      } catch (e) {
        settleFailed(`派发前置条件不满足：${(e as Error).message}`)
        return
      }
      // 与 `dispatch` / `followUpTask` 同口径的三段式组装：工作目录 → 需求级提示词 → 任务正文。
      // 工作目录同样按 任务级 > 需求级 回落（问题 1：只在任务上设、或只在需求上设，都必须生效）。
      const requirementId = String(task.requirementId)
      const requirementWorkspace = deps.board.board?.snapshot?.requirements?.[requirementId]?.workspace
      const workspace = normalizeWorkspace(task.workspace ?? requirementWorkspace ?? '')
      const wsSection = buildWorkspacePromptSection({
        ...(workspace ? { workspace } : {}),
        taskTitle: task.title,
        workItemId: Number(requirementId.split('@')[0]) || undefined,
        collection: requirementId.split('@')[1],
      })
      const requirementPrompt = deps.board.board?.snapshot?.requirements?.[requirementId]?.prompt
      const body = task.prompt?.trim()
        || [task.title, task.description].filter(s => typeof s === 'string' && s.trim().length > 0).join('\n\n')
      const promptText = [
        wsSection,
        requirementPrompt?.trim() ? `【需求提示词】\n${requirementPrompt.trim()}` : '',
        body,
      ].filter(s => s.length > 0).join('\n\n')
      const boardRoute = resolveFrozenModelRoute({ frozen: task.frozenConfig, role })
      await launchRun({
        requirementId: task.requirementId,
        taskId,
        boardTaskId: taskId,
        role,
        frozenConfig: {
          mcp: [...(task.frozenConfig?.mcp ?? [])],
          skills: [...(task.frozenConfig?.skills ?? [])],
          model: boardRoute.model,
          ...(boardRoute.modelProvider ? { modelProvider: boardRoute.modelProvider } : {}),
          // 问题 3/1：任务编辑后的预设与执行预算随启动生效。
          ...(task.frozenConfig?.preset ? { preset: task.frozenConfig.preset } : {}),
          ...(task.frozenConfig?.maxDepth ? { maxDepth: task.frozenConfig.maxDepth } : {}),
          ...(task.frozenConfig?.maxTokens ? { maxTokens: task.frozenConfig.maxTokens } : {}),
        },
        prompt: [{ type: 'text', text: promptText }],
        parent,
      })
    } catch (e) {
      // 调用方（setTaskState）是 fire-and-forget，不会 await 本函数：这里必须吞掉一切异常
      // 并收口，绝不能让它变成 unhandled rejection（那会连同进程一起把错误藏起来）。
      settleFailed(`派发过程异常：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  function setTaskState(taskId: string, action: TaskAction, expectedRevision?: number): TaskOpResult {
    if (!deps.board) return { ok: false, reason: '看板服务不可用' }
    const result = deps.board.setTaskState(taskId, action, expectedRevision)
    if (!result.ok) return result
    /**
     * 启动 / 重试 = 真的执行。
     *
     * 状态已落地为 `in_progress + running`，这里必须紧跟着发起真实派发，否则该任务会
     * 永远停在"执行中"（假执行）。fire-and-forget 是刻意的：本 API 是同步契约，
     * 派发时长不可预期（含并发排队）；失败由 `launchBoardTaskExecution` 内部收口为
     * failed 并写诊断，UI 下一次轮询即可看到真实结局。
     */
    if (action === 'start' || action === 'retry') {
      void launchBoardTaskExecution(taskId)
    }
    return result
  }

  async function healthCheck(): Promise<HealthResult> {
    if (!deps.health) return { ok: false, kind: 'unknown', reason: '连通性自检不可用（适配层未接线）' }
    return runHealthCheck(deps.health.port, deps.health.availableTools?.())
  }

  // ───────────────────────── T063 审计归档 ─────────────────────────

  function getAudit(): AuditView {
    if (!deps.audit) {
      return {
        ok: false,
        total: 0,
        expired: 0,
        retentionDays: 0,
        archiveFiles: [],
        reason: '审计归档服务不可用（数据目录不可写或初始化失败）',
      }
    }
    return deps.audit.inspect()
  }

  function archiveAudit(): ArchiveResult {
    if (!deps.audit) return { ok: false, reason: '审计归档服务不可用' }
    return deps.audit.archive()
  }

  // ───────────────────────── T030 集合切换 ─────────────────────────

  function setCollection(collection: string): { ok: boolean; reason?: string; collection?: string } {
    const name = (collection ?? '').trim()
    if (name.length === 0) return { ok: false, reason: 'collection 不可为空' }
    const allowed = deps.collections?.length ? deps.collections : [deps.collection]
    if (!allowed.includes(name)) {
      return { ok: false, reason: `集合 "${name}" 不在可切换清单内（allowed: ${allowed.join(', ')}）` }
    }
    if (!deps.onCollectionChange) {
      return { ok: false, reason: '集合切换未接线（运行期无法改变目标集合）' }
    }
    try {
      deps.onCollectionChange(name)
    } catch (e) {
      return { ok: false, reason: `切换集合失败：${(e as Error).message}` }
    }
    return { ok: true, collection: name }
  }

  // ───────────────────────── T031 连接档案 + T028b MCP 接入 ─────────────────────────

  function listProfiles(): ProfileListResult {
    if (!deps.profiles) return { ok: false, profiles: [], reason: '连接档案服务不可用' }
    const profiles = deps.profiles.list()
    const activeId = deps.profiles.activeId()
    return { ok: true, profiles, ...(activeId ? { activeId } : {}) }
  }

  function saveProfile(input: ProfileSaveInput): ProfileOpResult {
    if (!deps.profiles) return { ok: false, reason: '连接档案服务不可用' }
    if (typeof input !== 'object' || input === null) return { ok: false, reason: '请求体必须为对象' }
    return deps.profiles.save(input)
  }

  function deleteProfile(id: string): ProfileOpResult {
    if (!deps.profiles) return { ok: false, reason: '连接档案服务不可用' }
    if (typeof id !== 'string' || id.trim().length === 0) return { ok: false, reason: 'id 必填' }
    return deps.profiles.remove(id)
  }

  function activateProfile(id: string): ProfileOpResult {
    if (!deps.profiles) return { ok: false, reason: '连接档案服务不可用' }
    if (typeof id !== 'string' || id.trim().length === 0) return { ok: false, reason: 'id 必填' }
    const result = deps.profiles.activate(id)
    // 真实效果：把活动档案的集合同步到适配层（URL/PAT 变更需重启，见 ProfileService 注释）。
    if (result.ok && result.profile && deps.onCollectionChange) {
      const allowed = deps.collections?.length ? deps.collections : [deps.collection]
      if (allowed.includes(result.profile.collection)) deps.onCollectionChange(result.profile.collection)
    }
    return result
  }

  function getMcpEnvTemplate(profileId?: string): McpEnvTemplate {
    if (!deps.profiles) {
      return {
        ok: false,
        serverName: deps.mcpServers[0] ?? '',
        serverNameValid: false,
        envFilePath: '',
        posixLines: [],
        powershellLines: [],
        note: '连接档案服务不可用，无法生成接入模板',
      }
    }
    return deps.profiles.envTemplate(profileId)
  }

  function writeMcpEnvFile(profileId?: string): EnvFileResult {
    if (!deps.profiles) return { ok: false, reason: '连接档案服务不可用' }
    return deps.profiles.writeEnvFile(profileId)
  }

  function getMcpInstance(): McpInstanceInfo {
    if (deps.profiles) return deps.profiles.instance()
    return {
      serverName: deps.mcpServers[0] ?? '',
      serverNameValid: false,
      toolPrefix: `mcp__${deps.mcpServers[0] ?? ''}__`,
      runtimeAddSupported: false,
      runtimeAddReason: '连接档案服务不可用，无法读取实例诊断',
      serverNameConstraint: '^[A-Za-z0-9_-]{1,32}$',
      duplicateRisk: '未知',
      credentialPath: '未知',
    }
  }

  function getTfsToolCatalog(): TfsToolCatalogView {
    if (!deps.tfsToolCatalog) return TFS_TOOL_CATALOG_UNAVAILABLE
    try {
      return deps.tfsToolCatalog()
    } catch (e) {
      // 目录是现算的（读 ctx.tools.schemas()），失败必须给出原因而不是静默空表。
      return { ...TFS_TOOL_CATALOG_UNAVAILABLE, reason: (e as Error).message }
    }
  }

  /**
   * 任务收口后的宿主侧编排（问题 6 自动链式 / 问题 4 自动回写）。
   *
   * 由 BoardService 在任务收口且看板落盘后以 microtask 异步调用（见 `setSettledHook`）。
   * - 仅 `success` 收口推进：待人工确认 / 失败任务**不**自动续跑、**不**触发回写（问题 5）；
   * - 自动链式：`autoStartRunnable` 一次性启动所有已就绪任务（引擎按在跑数扣并发槽、幂等防重），
   *   再逐个 fire-and-forget 发起真实派发；
   * - 自动回写：交给 finalizer 的 `maybeFinalize`（内部判"需求全部完成"、幂等、防重入），失败不外溢。
   */
  /**
   * 任务收口后的宿主侧编排（问题 6 自动链式 / 问题 4 自动回写 / spec 010 主 agent 归纳）。
   *
   * 顺序（spec 010 US2）：
   *   1. 只有 `success` 收口才推进（待人工确认 / 失败一律阻断，沿用既有门禁）；
   *   2. **先让编排主 agent 归纳**本任务并把结论合进共享简报（AC2.2）；
   *      归纳是 `await` 的 —— 否则下一个任务会在结论写进简报**之前**就被派发出去，
   *      简报复用就成了空话。但它带超时，主 agent 卡住时按"无摘要"放行，不阻断链路；
   *   3. 再 `autoStartRunnable` 放行下一批就绪任务；
   *   4. 需求全部完成时：先问主 agent 要**最终总结**（AC2.4），再触发 TFS 回写。
   */
  async function handleTaskSettled(info: {
    taskId: string
    requirementKey: string
    outcome: string
  }): Promise<void> {
    if (info.outcome !== 'success') return

    /**
     * ── ② 主 agent 归纳：**不能阻塞放行**（2026-10-01 修复）──
     *
     * 上一版写成 `await summarize(...)` 再 `autoStartRunnable`：而 continuable 子会话
     * **没有 per-message result**，归纳完成只能靠事件/轮询观测，观测不到就会等满
     * `summarizeTimeoutSeconds`（默认 120s）⇒ 用户看到"上一个任务完成了，下一个 2 分钟没动静"。
     *
     * 现在的口径：**归纳与放行并行**，只给归纳一个短"宽限"
     * （`summarizeGraceMs`，默认 20s）——
     *   - 宽限内拿到结论 ⇒ 结论进简报，**下一个任务的 prompt 就能复用它**（AC2.2 的本意）；
     *   - 宽限内没拿到 ⇒ **立刻放行下一个任务**，归纳继续在后台跑完并写回简报（给再下一个任务用）；
     *   - 归纳自身永不 reject（已在闭包里吞掉），后台跑完不会变成 unhandled rejection。
     *
     * 结论：链路推进（主路径）不再依赖归纳（增强路径）。
     */
    const summarizeDone = (async (): Promise<void> => {
      try {
        await deps.orchestrator?.summarize(info.requirementKey, info.taskId)
      } catch {
        // 归纳是增强能力：任何意外都不应影响已完成任务的收口结果。
      }
    })()
    await Promise.race([summarizeDone, delay(deps.summarizeGraceMs ?? 20_000)])

    if (deps.autoChainTasks !== false && deps.board && typeof deps.board.autoStartRunnable === 'function') {
      try {
        const limit = deps.dispatchConcurrency ?? 3
        const started = deps.board.autoStartRunnable(limit)
        for (const id of started.taskIds) void launchBoardTaskExecution(id)
      } catch {
        // 自动续跑是增强能力：任何意外都不应影响已完成任务的收口结果。
      }
    }

    // ── ④ 回写：需求全部完成时才先问主 agent 要最终总结（AC2.4）──
    if (deps.autoWriteBack !== false && deps.finalizer) {
      const allDone = deps.board?.board?.isRequirementAllTasksDone?.(info.requirementKey) === true
      let finalSummary: string | undefined
      if (allDone) {
        /**
         * 全部完成时已没有"下一个任务"要放行，这里等最终总结是合理的；
         * 但同样加宽限（不无限等）——拿不到就回退模板总结，并在评论里标注来源。
         */
        const finalizeDone = (async (): Promise<string | undefined> => {
          try {
            return await deps.orchestrator?.finalize(info.requirementKey)
          } catch {
            return undefined
          }
        })()
        finalSummary = await Promise.race([
          finalizeDone,
          delay(deps.finalizeGraceMs ?? 60_000).then(() => undefined),
        ])
      }
      void deps.finalizer
        .maybeFinalize(info.requirementKey, ...(finalSummary ? [{ finalSummary }] : []))
        .catch(() => {
          /* 回写失败由报告与"重新回写"入口承载，不打断任务流 */
        })
    }
  }

  /** 纯粹的延时（用于给异步增强步骤设"宽限"，避免主路径被它拖住）。 */
  function delay(ms: number): Promise<void> {
    return new Promise<void>(resolve => setTimeout(resolve, Math.max(0, ms)))
  }

  /** 需求完成回写（问题 4）：手动触发 / 部分失败后重跑，返回逐项报告。 */
  async function writeBackRequirement(input: {
    requirementKey: string
    force?: boolean
  }): Promise<{ ok: boolean; reason?: string; report?: RequirementWriteBackReport }> {
    if (!deps.finalizer) {
      return { ok: false, reason: '需求完成回写器不可用（未接线 TFS 系统写通道 / finalizer 未注入）' }
    }
    const key = typeof input?.requirementKey === 'string' ? input.requirementKey.trim() : ''
    if (!key) return { ok: false, reason: 'requirementKey 必填' }
    try {
      const report = await deps.finalizer.runWriteBack(key, input.force === true)
      if (report.status === 'error') {
        return { ok: false, reason: report.summary ?? '回写失败', report }
      }
      // ok / partial 都返回报告（partial 时报告内含失败项，UI 可"重新回写"）。
      return { ok: true, report }
    } catch (e) {
      return { ok: false, reason: e instanceof Error ? e.message : String(e) }
    }
  }

  // 把收口编排钩子接到看板服务（BoardService 先于本 api 构造，故在此补接）。
  deps.board?.setSettledHook?.(handleTaskSettled)

  return {
    getPanelData,
    refreshPanelData,
    confirmWrite,
    dispatch,
    listRequirements,
    getQueryOptions,
    refreshQueryOptions,
    loadQueryOptions,
    collectQueryOptions,
    loadUiState,
    saveUiState,
    listRoles,
    saveRole,
    deleteRole,
    getBoard,
    claimRequirement,
    decomposeRequirement,
    restoreRequirement,
    enrichRequirement,
    deleteTasks,
    updateRequirement,
    setRequirementExecState,
    updateTask,
    getTaskTrace,
    followUpTask,
    assignTask,
    setTaskState,
    healthCheck,
    getAudit,
    archiveAudit,
    setCollection,
    listProfiles,
    saveProfile,
    deleteProfile,
    activateProfile,
    getMcpEnvTemplate,
    writeMcpEnvFile,
    getMcpInstance,
    getTfsToolCatalog,
    writeBackRequirement,
    orchestratorEnsure,
  }
}

/**
 * 能力目录（问题 8 / 12）。
 *
 * 缺省（apply 未注入 `tfsToolCatalog`）时给出**可读的降级原因**而不是空数组：
 * 空数组会让 UI 显示"0 个工具"，既像是插件坏了、又看不出为什么。
 *
 * 触发时机：`deps.tfsToolCatalog` 只在 `index.ts#apply` 里经 `catalogView(IMPLEMENTED_OPERATIONS)`
 * 注入（纯内存计算，不依赖宿主服务）。因此这里只会在**单测/未走 apply 的装配**下兜到；
 * 与"宿主有没有装 MCP 实例"无关 —— REST 化后本插件不再依赖任何 MCP 实例。
 */
const TFS_TOOL_CATALOG_UNAVAILABLE: TfsToolCatalogView = {
  ok: false,
  rawCount: 0,
  wrappedCount: 0,
  tools: [],
  missingCount: 0,
  reason: '能力目录服务不可用（装配未注入 tfsToolCatalog，本插件自身的能力目录未能生成）',
}

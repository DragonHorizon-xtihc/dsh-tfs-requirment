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

import { join } from 'node:path'
import {
  Board,
  BoardError,
  type AttemptMeta,
  type BoardState,
  type TaskDraft,
} from '../core/board/board.js'
import { decomposeRequirement } from '../core/board/decompose.js'
import {
  DECOMPOSE_STAGES,
  STAGE_ROLE_TEMPLATES,
  matchGeneralistRole,
  matchRoleForStage,
  type DecomposeStage,
} from '../orchestration/role-match.js'
import type { TaskOrchestration, TaskSnapshot, TaskState } from '../core/board/task.js'
import { JsonStore, JsonStoreParseError } from '../persistence/json-store.js'
import { EventLog } from '../persistence/events.js'
import { renderBoardMarkdown } from '../persistence/markdown.js'
import { realFs, type FsLike } from '../persistence/fs-like.js'
import type { Requirement, RequirementExecState, RequirementOrchestration } from '../tfs/types.js'
import { requirementDedupKey } from '../tfs/types.js'
import { normalizeLabel } from '../write-guard/idempotency.js'
import type {
  BoardSnapshotView,
  BoardTaskView,
  ClaimRequirementInput,
  ClaimRequirementResult,
  DeleteTasksResult,
  EnrichResult,
  FrozenConfig,
  QueryOptionsCacheFile,
  RequirementQueryOptions,
  RequirementSummary,
  RequirementWriteBackReport,
  RestoreResult,
  RoleDefinition,
  TaskAction,
  TaskOpResult,
  UiState,
  UiStateFile,
} from '../shared/contracts.js'
import { normalizeWorkspace, workspaceIssue } from '../shared/workspace.js'
import { shouldCacheQueryOptions } from '../shared/pool.js'

/** 本服务对 TFS 适配层的最小需求面（便于单测打桩，不引入整个 adapter）。 */
export interface BoardTfsPort {
  /** 按 id 取单个需求（实测可用读路径：`tfs_get_workitem`）。 */
  getRequirement(id: number, collection?: string): Promise<RequirementSummary>
  /** 打标签（过 WriteGuard 四道门禁）。 */
  addTags(
    workItemId: string | number,
    collection: string | undefined,
    tags: string[],
    beforeTags: string[],
    confirmed: boolean,
  ): Promise<{ ok: boolean; reason?: string }>
  /**
   * 移除标签（问题 7 还原需求池 best-effort 使用）。
   *
   * 2026-10-04：与其余写操作一样**走 WriteGuard 四道门禁**（旧实现绕过门禁自己 PATCH），
   * 故需要第四参 `confirmed`——「还原到需求池」是用户的显式操作，构成人工确认。
   * 失败由调用方降级为告警。可选：未注入时还原流程跳过 TFS 标签清理，只给提示。
   */
  removeTags?(
    workItemId: string | number,
    collection: string | undefined,
    tagsToRemove: string[],
    confirmed: boolean,
  ): Promise<{ id: number; tags: string[] }>
  /** 采集需求池筛选可选项（问题 1「采集可选项」按钮）。 */
  getQueryOptions?(collection?: string): Promise<RequirementQueryOptions>
}

/**
 * 角色表面（拆解默认指派 + 指派校验）。
 *
 * `save` 可选：生产装配注入 RoleStore（拆解匹配不到角色时可自动创建，spec 008 US3）；
 * 测试/降级装配可不提供，此时回落链跳过自动创建、改用列表首个角色。
 */
export interface RoleReader {
  list(): RoleDefinition[]
  getByName(name: string): RoleDefinition | undefined
  /** 自动创建角色通道（落 roles.json）。 */
  save?(role: RoleDefinition): void
}

/** 看板服务依赖（全部可注入）。 */
export interface BoardServiceDeps {
  /** 插件数据目录（`board.json` / `events.jsonl` / `.ai-board/` 落此）。 */
  baseDir: string
  /** 可注入文件系统（默认真实 `node:fs`）。 */
  fs?: FsLike
  /** 看板引擎（可注入预置状态，便于恢复测试）。 */
  board: Board
  /** TFS 适配面（REST 直连；写操作唯一出口，Principle IV）。 */
  adapter: BoardTfsPort
  /** 角色表（拆解默认指派 + 指派校验）。 */
  roles: RoleReader
  /** 入队标签（T048），通常取 `config.defaultLabel`（默认 `dsh`）。 */
  defaultLabel: string
  /** 并发器运行时读数（S-06 排队可见性）。 */
  getRuntimeCounts?: () => { running: number; queued: number }
  /**
   * 任务收口后的**异步副作用钩子**（问题 4 自动回写 / 问题 6 自动链式执行）。
   *
   * 由宿主装配层（`host/api` / `index`）注入，避免本服务反向依赖派发器与 TFS 回写器。
   * 在任务收口且看板已落盘后，以 microtask **异步、不阻塞、不抛错**地触发一次；钩子内部据此决定：
   * 成功 ⇒ 自动派发下一条就绪任务 + 需求全部完成时回写 TFS；待确认 / 失败 ⇒ 阻断链式与回写。
   * 单测可不注入（行为退化为仅本地状态收口）。
   */
  onTaskSettled?: (info: TaskSettledInfo) => void
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
  cancelRun?: (taskId: string) => Promise<void>
  /**
   * 还原需求到需求池时，释放其名下 continuable 任务子会话（D4）。
   *
   * 由装配层注入（OrchestratorSessionManager.drainRequirementSessions），本服务不反向依赖编排器。
   * 入参为该需求登记的全部 taskSessions id；best-effort：返回可读 warning（不阻断还原），
   * 全部成功/无会话时返回 undefined。未注入时还原流程跳过子会话释放。
   */
  disposeRequirementSessions?: (sessionIds: string[]) => Promise<string | undefined>
}

/** 传给 {@link BoardServiceDeps.onTaskSettled} 的收口信息。 */
export interface TaskSettledInfo {
  taskId: string
  /** 所属需求去重键。 */
  requirementKey: string
  /** 本次收口结果（人工确认通过记 success）。 */
  outcome: 'success' | 'failed' | 'needs_confirmation'
  /** 被收口任务是否为自动链式派发（诊断用）。 */
  autoLaunched?: boolean
}

/** 事件日志类型（append-only）。 */
interface BoardEvent {
  kind: 'board'
  action: string
  detail?: unknown
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
export const LOCAL_REQUIREMENT_FIELDS = [
  /** 本地代码库绝对路径（领取/编辑时填）。 */
  'workspace',
  /** 需求级执行提示词。 */
  'prompt',
  /** 需求级执行状态（`active` 是"人声明还没完"的抑制标记，必须连 active 一起搬）。 */
  'execState',
  /** 置为已完成的时间。 */
  'completedAt',
  /** spec 010 编排上下文（主会话 id / 共享简报 / 任务子会话复用表）。 */
  'orchestration',
  /** 问题 4 回写报告（兼作重跑幂等账本）。 */
  'writeBack',
  /** 需求级 revision（本地版本计数；TFS 摘要恒给 0，不该被重取清零）。 */
  'revision',
] as const satisfies readonly (keyof Requirement)[]

/** 把 TFS 归一化摘要转为看板领域需求。 */
export function summaryToRequirement(s: RequirementSummary): Requirement {
  return {
    workItemId: s.id,
    collection: s.collection,
    project: s.project,
    title: s.title,
    // 正文（US3）：随需求落 board.json，重启后"选为目标"仍能带出内容。
    ...(s.description ? { description: s.description } : {}),
    // 问题 11：需求分析 / 数据结构 / 需求配置三段 Winning 自定义字段，同 description 纪律落盘。
    ...(s.analysis ? { analysis: s.analysis } : {}),
    ...(s.dataStructure ? { dataStructure: s.dataStructure } : {}),
    ...(s.config ? { config: s.config } : {}),
    state: s.state,
    assignedTo: s.assignedTo,
    priority: s.priority,
    iteration: s.iterationPath,
    tags: s.tags,
    createdAt: s.changedDate,
    updatedAt: s.changedDate,
    revision: 0,
    type: s.type,
    url: s.url,
    areaPath: s.areaPath,
    // 本地补充字段：为空时不写入，避免在 board.json 留下空字段。
    ...(s.workspace ? { workspace: s.workspace } : {}),
    // 需求级提示词（问题 3/6）：与 workspace 同纪律，随需求落 board.json 跨重启保留。
    ...(s.prompt ? { prompt: s.prompt } : {}),
    // 需求级执行状态（问题 3/4/5）：同上，本地字段；缺省不写键（读取侧按 'active' 处理）。
    ...(s.execState === 'completed' ? { execState: 'completed' as const } : {}),
    ...(s.completedAt ? { completedAt: s.completedAt } : {}),
    // 问题 4：回写报告随 board.json 持久化（兼作重跑幂等账本）。
    ...(s.writeBack ? { writeBack: s.writeBack } : {}),
  }
}

/** 把看板领域需求转回客户端摘要（看板快照用）。 */
export function requirementToSummary(r: Requirement): RequirementSummary {
  return {
    id: r.workItemId,
    collection: r.collection,
    project: r.project,
    title: r.title,
    // 正文回带（US3）：空则不写键，保持与历史 board.json 反序列化形状一致。
    ...(r.description ? { description: r.description } : {}),
    // 问题 11：三段 Winning 字段同口径回带。
    ...(r.analysis ? { analysis: r.analysis } : {}),
    ...(r.dataStructure ? { dataStructure: r.dataStructure } : {}),
    ...(r.config ? { config: r.config } : {}),
    type: r.type ?? '',
    state: r.state,
    assignedTo: r.assignedTo,
    priority: r.priority,
    areaPath: r.areaPath ?? '',
    iterationPath: r.iteration,
    tags: r.tags,
    changedDate: r.updatedAt,
    url: r.url ?? '',
    ...(r.workspace ? { workspace: r.workspace } : {}),
    ...(r.prompt ? { prompt: r.prompt } : {}),
    /**
     * 需求级执行状态（问题 4：已领取需求缺执行状态）。
     *
     * **总是显式回带**（不像 workspace/prompt 那样省略空值）：客户端据它把需求分到
     * 「进行中」/「已完成」两页，缺字段会让 UI 只能靠 `undefined` 猜，多一处隐含约定。
     */
    execState: r.execState === 'completed' ? 'completed' : 'active',
    ...(r.completedAt ? { completedAt: r.completedAt } : {}),
    ...(r.writeBack ? { writeBack: r.writeBack } : {}),
    // spec 010：需求级编排上下文（缺则省略键 —— 无编排的需求视图形状不变）。
    ...(r.orchestration ? { orchestration: { ...r.orchestration } } : {}),
  }
}

/**
 * 看板服务：编排引擎 + 持久化 + 事件 + 渲染 + tfs 写出口。
 */
export class BoardService {
  private readonly fs: FsLike
  private readonly store: JsonStore<BoardState>
  private readonly events: EventLog
  private readonly markdownPath: string
  /**
   * 需求池可选项落盘缓存（问题 1）：按集合命名空间的 `query-options.json`。
   * 与 board.json 同目录；损坏时按"无缓存"处理（不锁死下拉，见 loadQueryOptions）。
   */
  private readonly queryOptionsStore: JsonStore<QueryOptionsCacheFile>
  /** UI 状态落盘（问题 2/4/6：筛选记忆 + 每页条数），按集合命名空间。 */
  private readonly uiStateStore: JsonStore<UiStateFile>

  constructor(private readonly deps: BoardServiceDeps) {
    this.fs = deps.fs ?? realFs
    this.store = new JsonStore<BoardState>({ baseDir: deps.baseDir, fileName: 'board.json', fs: this.fs })
    this.events = new EventLog(deps.baseDir, 'events.jsonl', this.fs)
    this.markdownPath = join(deps.baseDir, '.ai-board', '计划看板.md')
    this.queryOptionsStore = new JsonStore<QueryOptionsCacheFile>({
      baseDir: deps.baseDir,
      fileName: 'query-options.json',
      fs: this.fs,
    })
    this.uiStateStore = new JsonStore<UiStateFile>({
      baseDir: deps.baseDir,
      fileName: 'ui-state.json',
      fs: this.fs,
    })
  }

  /** 看板引擎（供上层读取只读快照 / 计算可运行集）。 */
  get board(): Board {
    return this.deps.board
  }

  /** `board.json` 绝对路径（诊断/测试用）。 */
  get storePath(): string {
    return this.store.path
  }

  /** 渲染出的 Markdown 看板路径。 */
  get markdownViewPath(): string {
    return this.markdownPath
  }

  /**
   * 从 `board.json` 恢复（T059 / US6）。
   *
   * 解析失败**保留原文件并返回 ok:false**（FR-020），绝不静默重建——这是"用户的看板被悄悄清空"
   * 这类事故的唯一防线。
   *
   * @returns 恢复结果；文件不存在视为首次启动（ok:true）。
   */
  load(): { ok: boolean; reason?: string; recovered: boolean } {
    try {
      const state = this.store.read()
      if (!state) return { ok: true, recovered: false }
      this.deps.board.load(state)
      return { ok: true, recovered: true }
    } catch (e) {
      const reason =
        e instanceof JsonStoreParseError
          ? `board.json 解析失败，原文件已保留未改动：${this.store.path}（${(e.cause as Error)?.message ?? 'JSON 语法错误'}）`
          : (e as Error).message
      return { ok: false, reason, recovered: false }
    }
  }

  /**
   * 崩溃对账（T060 / S-10）：重启后把悬空 running 任务标为 failed 并记事件。
   *
   * 同时做**需求完成对账**（问题 3，2026-09-21 实机修复）：把"任务其实已全部收口、但需求
   * `execState` 仍缺键"的历史需求补齐为已完成。只靠状态变更触发不够 —— 升级前完成的需求
   * 再也没有任何触发点（实机：需求 1997179 三个任务全 completed，却一直不进「已完成」页）。
   *
   * @returns 悬空任务 ID 列表与被补齐为已完成的需求键列表。
   */
  reconcile(): { ok: boolean; dangling: string[]; migratedRequirements: string[] } {
    const dangling = this.deps.board.reconcileDangling()
    const migratedRequirements = this.deps.board.reconcileRequirementCompletion()
    if (dangling.length > 0 || migratedRequirements.length > 0) {
      this.persist('reconcile', { dangling, migratedRequirements })
    }
    return { ok: true, dangling, migratedRequirements }
  }

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
  reapStaleRunning(staleMs: number): string[] {
    const reaped = this.deps.board
      .reconcileUnboundRunning(staleMs)
      .map(entry => entry.taskId)
    if (reaped.length > 0) {
      this.persist('reap-stale-running', { taskIds: reaped, staleMs })
    }
    return reaped
  }

  /** 落盘：JSON 权威 + 事件 + Markdown 渲染（T061）。 */
  private persist(action: string, detail?: unknown): void {
    const state = this.deps.board.snapshot
    this.store.write(state as BoardState)
    // Markdown 渲染失败不应回滚权威 JSON（视图是派生物）；但仍要记事件以便排查。
    try {
      this.fs.mkdirSync(join(this.deps.baseDir, '.ai-board'), { recursive: true })
      this.fs.writeFileSync(this.markdownPath, renderBoardMarkdown(state as BoardState), 'utf8')
    } catch (e) {
      this.events.append({ kind: 'board', action: 'render_failed', detail: { error: (e as Error).message } })
    }
    const event: BoardEvent = { kind: 'board', action, ...(detail !== undefined ? { detail } : {}) }
    this.events.append(event as unknown as Record<string, unknown>)
  }

  /** 看板快照（客户端渲染用）。 */
  snapshot(): BoardSnapshotView {
    const state = this.deps.board.snapshot
    const runtime = this.deps.getRuntimeCounts?.() ?? { running: 0, queued: 0 }
    const tasks = Object.values(state.tasks).map(toTaskView)
    return {
      ok: true,
      version: state.version,
      updatedAt: state.updatedAt,
      requirements: Object.values(state.requirements).map(requirementToSummary),
      tasks,
      ...(state.markdownViewPath ? { markdownViewPath: state.markdownViewPath } : {}),
      counts: {
        pending: tasks.filter(t => t.state === 'pending').length,
        inProgress: tasks.filter(t => t.state === 'in_progress').length,
        completed: tasks.filter(t => t.state === 'completed').length,
        running: runtime.running,
        queued: runtime.queued,
      },
    }
  }

  /**
   * 领取需求入本地池（T036，去重键 `workItemId@collection` S-01）+ 入队打 `dsh` 标签（T048）。
   *
   * 幂等：已在池中返回 `added:false`；标签已存在则跳过写调用（S-08）。
   * 标签写失败不使领取失败（FR-014：条目保留，UI 可见失败原因）。
   *
   * @param input - 领取入参（完整摘要 或 id+collection）。
   * @returns 领取结果。
   */
  async claimRequirement(input: ClaimRequirementInput): Promise<ClaimRequirementResult> {
    let summary = input.requirement
    if (!summary) {
      if (typeof input.id !== 'number' || !Number.isInteger(input.id) || input.id <= 0) {
        return { ok: false, added: false, reason: '缺少有效工作项 id（须为正整数）' }
      }
      try {
        summary = await this.deps.adapter.getRequirement(input.id, input.collection)
      } catch (e) {
        return { ok: false, added: false, reason: `按 id 拉取工作项失败（TFS REST）：${(e as Error).message}` }
      }
    }
    if (!Number.isInteger(summary.id) || summary.id <= 0) {
      return { ok: false, added: false, reason: `工作项 id 无效：${String(summary.id)}` }
    }

    // 本地代码库路径（本地补充字段，非 TFS 字段）：fail loud 校验后附到需求上。
    // 校验哲学对齐宿主 `assertUsableCwd`（"在进程边界之前失败"，而不是留下含糊的后果）。
    // 与 updateRequirementMeta 共用 resolveWorkspace，保证领取与编辑两条路径判定一致。
    const rawWorkspace = input.workspace ?? summary.workspace
    if (rawWorkspace !== undefined) {
      const ws = this.resolveWorkspace(rawWorkspace)
      if (!ws.ok) return { ok: false, added: false, reason: ws.reason }
      if (ws.value !== undefined) summary = { ...summary, workspace: ws.value }
    }

    // 需求级提示词（问题 6：领取弹框里填写的"增加提示词"）。
    // 与 workspace 不同，提示词**不需要** fail-loud：空串视为"未填"，其余原样保留
    // （多行文本是正常内容，不做 trim 之外的任何处理）。
    const rawPrompt = input.prompt ?? summary.prompt
    if (rawPrompt !== undefined) {
      const prompt = rawPrompt.trim()
      summary = prompt.length > 0 ? { ...summary, prompt } : { ...summary, prompt: undefined }
    }

    const req = summaryToRequirement(summary)
    const key = requirementDedupKey(req)
    const added = this.deps.board.claimRequirement(req)

    // T048：进入队列即打 dsh 标签（幂等 S-08）。已带该标签则跳过（不重复发写调用）。
    let tag: { ok: boolean; reason?: string } | undefined
    if (input.tag !== false) {
      const want = this.deps.defaultLabel
      const already = summary.tags.some(t => normalizeLabel(t) === normalizeLabel(want))
      if (already) {
        tag = { ok: true }
      } else {
        const r = await this.deps.adapter.addTags(summary.id, summary.collection, [want], summary.tags, true)
        tag = r.ok ? { ok: true } : { ok: false, ...(r.reason ? { reason: r.reason } : {}) }
        if (r.ok) {
          // 写成功后同步本地副本的标签，使本地视图与 TFS 一致。
          summary = { ...summary, tags: [...summary.tags, want] }
          this.deps.board.updateRequirement(summaryToRequirement(summary))
        }
      }
    }

    this.persist('claim', { key, added, tagged: tag?.ok === true })
    return { ok: true, added, requirement: summary, ...(tag ? { tag } : {}) }
  }

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
    ok: boolean
    taskIds?: string[]
    created?: number
    skipped?: number
    createdRoles?: string[]
    reason?: string
  } {
    const state = this.deps.board.snapshot
    const req = state.requirements[requirementId]
    if (!req) return { ok: false, reason: `需求未领取：${requirementId}` }
    // 逐阶段解析角色（专门匹配 → 通用兜底 → 自动创建 → 首个角色回落）。
    const createdRoles: RoleDefinition[] = []
    const rolesByStage = {} as Record<DecomposeStage, RoleDefinition | undefined>
    const roleAssignment: Record<DecomposeStage, string> = {} as Record<DecomposeStage, string>
    for (const stage of DECOMPOSE_STAGES) {
      const role = this.resolveStageRole(stage, createdRoles)
      rolesByStage[stage] = role
      roleAssignment[stage] = role?.name ?? '通用工程师'
    }
    let drafts: TaskDraft[]
    try {
      drafts = decomposeRequirement(req, rolesByStage)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    let result: { created: TaskSnapshot[]; skipped: string[] }
    try {
      result = this.deps.board.decomposeTasks(drafts)
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
    const createdIds = result.created.map(t => t.taskId)
    this.persist('decompose', {
      requirementId,
      created: createdIds,
      skipped: result.skipped,
      roleAssignment,
      createdRoles: createdRoles.map(r => r.name),
    })
    const n = createdIds.length
    const m = result.skipped.length
    /**
     * 拆解是"开始 / 继续干活"的动作：已完成（或被显式取消完成）的需求在**新建出任务**后
     * 必须回到「进行中」页，否则新任务会挂在已完成需求下、整条需求落在已完成页里，
     * 用户会以为"拆解没生效"。
     *
     * 用 `resetRequirementCompletion`（删键回到"未判定"）而非 `setRequirementExecState('active')`：
     * 后者是"人声明还没完"的抑制标记，会把**后续的自动完成**一并关掉；重新开工只应撤销历史判定，
     * 不该连"做完后自动完成"也一起关。
     */
    if (n > 0 && this.deps.board.resetRequirementCompletion(requirementId)) {
      this.persist('requirement-exec-state', { key: requirementId, state: null, trigger: 'decompose' })
    }
    const createdRoleNames = createdRoles.map(r => r.name)
    const roleNote = createdRoleNames.length > 0 ? `；自动创建角色：${createdRoleNames.join('、')}` : ''
    const reason =
      n > 0 && m > 0
        ? `已拆解 ${requirementId}：新增 ${n} 个任务，跳过 ${m} 个已存在的任务${roleNote}`
        : n > 0
          ? `已拆解 ${requirementId}：新增 ${n} 个任务${roleNote}`
          : `已拆解 ${requirementId}：${m} 个任务均已存在，全部跳过${roleNote}`
    return {
      ok: true,
      taskIds: [...createdIds, ...result.skipped],
      created: n,
      skipped: m,
      ...(createdRoleNames.length > 0 ? { createdRoles: createdRoleNames } : {}),
      reason,
    }
  }

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
  private resolveStageRole(stage: DecomposeStage, createdAcc: RoleDefinition[]): RoleDefinition | undefined {
    const specific = matchRoleForStage(stage, this.deps.roles.list())
    if (specific) return specific
    const generalist = matchGeneralistRole(this.deps.roles.list())
    if (generalist) return generalist
    const template = STAGE_ROLE_TEMPLATES[stage]
    const roles = this.deps.roles.list()
    const existing = this.deps.roles.getByName(template.name) ?? roles.find(r => r.id === template.id)
    if (existing) return existing
    if (typeof this.deps.roles.save === 'function') {
      try {
        this.deps.roles.save(template)
        createdAcc.push(template)
        this.events.append({
          kind: 'board',
          action: 'role-auto-create',
          detail: { stage, roleId: template.id, roleName: template.name },
        } as unknown as Record<string, unknown>)
        return template
      } catch (e) {
        // 自动创建失败不阻断拆解：记事件后走列表首个角色回落。
        this.events.append({
          kind: 'board',
          action: 'role-auto-create-failed',
          detail: { stage, roleName: template.name, error: (e as Error).message },
        } as unknown as Record<string, unknown>)
      }
    }
    return this.deps.roles.list()[0]
  }

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
  deleteTasks(taskIds: string[]): DeleteTasksResult {
    if (!Array.isArray(taskIds) || taskIds.length === 0) {
      return { ok: false, reason: '未选择任何任务' }
    }
    // 先记下这些任务属于哪些需求，**并为每个需求留一个删除后仍然存在的代表任务 id**
    // （删完就都查不到了）。代表 id 是 `afterTaskSettled` 的必要入参：它决定自动链式
    // 从哪一环继续、以及 finalizer 以哪个任务的执行结果去组装结论。
    //
    // ⚠️ 这里必须是**删除前**取、且必须取**不会被本次删除**的任务（2026-10-06 修复）：
    // 旧实现是删除之后再用 `taskIds.find(...)` 去快照里找，而被删的任务已经从
    // `state.tasks` 里物理移除（`Board.deleteTasks` 是 `delete`，不是标 `deleted`），
    // 于是 `last` 恒为 `undefined`，`afterTaskSettled` **一次都不会执行** ——
    // 需求照样被封存进「已完成」页，却没有结论评论、没有评审/自测字段、没有附件、
    // 没有子任务归位，自动链也断在这里。注释原已警告这条路径，实现却落反了。
    const owners = new Map<string, string | undefined>()
    for (const id of taskIds) {
      const key = this.deps.board.snapshot.tasks[id]?.requirementId
      if (!key) continue
      if (!owners.has(key)) owners.set(key, undefined)
    }
    // 代表任务优先取"仍存活且已收口"的任务（最能代表这条需求的产出），
    // 退而取任何仍存活的任务；全部被删则为 undefined（此时只能跳过钩子）。
    for (const key of [...owners.keys()]) {
      const alive = Object.values(this.deps.board.snapshot.tasks).filter(t => t.requirementId === key)
      const settledAlive = alive.find(t => t.state === 'completed')
      const representative = settledAlive ?? alive.find(t => !taskIds.includes(t.taskId))
      owners.set(key, representative?.taskId)
    }
    try {
      const deleted = this.deps.board.deleteTasks(taskIds)
      this.persist('task-delete', { deleted })
      for (const [key, representative] of owners) {
        // 删除已取消任务是**另一种收口路径**：它能让"全部任务处于终态"成立，需求随之迁入
        // 「已完成」页。此处必须与 `setTaskState` 一样走 `afterTaskSettled`，否则 `onTaskSettled`
        // 不触发，`finalizer.maybeFinalize` 永不执行 —— 需求会显示已完成，却没有结论评论、
        // 没有评审/自测字段、没有附件、没有子任务归位（`autoWriteBack` 在这条路径上形同虚设）。
        const sealed = this.sealRequirementIfAllDone(key)
        if (!sealed) continue
        if (representative === undefined) continue
        this.afterTaskSettled({ taskId: representative, requirementKey: key, outcome: 'success' })
      }
      return { ok: true, deleted, count: deleted.length }
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
  }

  // ─────────────── 需求级执行状态（问题 3/4/5） ───────────────

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
  private cancelRunBestEffort(taskId: string): void {
    const hook = this.deps.cancelRun
    if (!hook) return
    queueMicrotask(() => {
      void Promise.resolve()
        .then(() => hook(taskId))
        .catch((e: unknown) => {
          this.persist('task-cancel-run-failed', {
            taskId,
            reason: e instanceof Error ? e.message : String(e),
          })
        })
    })
  }

  private sealRequirementIfAllDone(key: string): boolean {
    const changed = this.deps.board.markRequirementCompletedIfAllDone(key)
    if (changed) this.persist('requirement-complete', { key, trigger: 'all-tasks-done' })
    return changed
  }

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
  private afterTaskSettled(info: TaskSettledInfo): void {
    if (info.outcome === 'success') this.sealRequirementIfAllDone(info.requirementKey)
    const hook = this.deps.onTaskSettled
    if (!hook) return
    queueMicrotask(() => {
      void Promise.resolve()
        .then(() => hook(info))
        .catch((e: unknown) => {
          this.events.append({
            kind: 'board',
            action: 'settle-hook-failed',
            detail: { taskId: info.taskId, error: e instanceof Error ? e.message : String(e) },
          } as unknown as Record<string, unknown>)
        })
    })
  }

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
  setRequirementExecState(
    key: string,
    state: RequirementExecState,
  ): { ok: boolean; reason?: string; requirement?: RequirementSummary } {
    const req = this.deps.board.snapshot.requirements[key]
    if (!req) return { ok: false, reason: `需求不在本地池：${key}` }
    try {
      const next = this.deps.board.setRequirementExecState(key, state)
      this.persist('requirement-exec-state', { key, state })
      return { ok: true, requirement: requirementToSummary(next) }
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
  }

  /** 读取需求的回写报告（问题 4；无则 undefined）。 */
  getRequirementWriteBack(key: string): RequirementWriteBackReport | undefined {
    return this.deps.board.snapshot.requirements[key]?.writeBack
  }

  /**
   * 落存需求回写报告（问题 4）：finalizer 每跑完一次（含 running 占位与终态）都调它，
   * 报告随 board.json 持久化，既给 UI 展示，也作为"重新回写"的幂等账本与防重入依据。
   */
  setRequirementWriteBack(
    key: string,
    report: RequirementWriteBackReport,
  ): { ok: boolean; reason?: string; requirement?: RequirementSummary } {
    const existing = this.deps.board.snapshot.requirements[key]
    if (!existing) return { ok: false, reason: `需求不在本地池：${key}` }
    const next: Requirement = { ...existing, writeBack: report }
    this.deps.board.updateRequirement(next)
    this.persist('requirement-writeback', { key, status: report.status, items: report.items.length })
    return { ok: true, requirement: requirementToSummary(next) }
  }

  // ───────────── spec 010：编排上下文读写（编排主 agent + 共享简报 + 会话复用） ─────────────

  /** 读取需求级编排上下文（未启用返回 undefined）。 */
  getOrchestration(key: string): RequirementOrchestration | undefined {
    return this.deps.board.orchestrationOf(key)
  }

  /**
   * 落存需求级编排上下文（spec 010：编排会话 id + 共享简报 + 会话复用表）。
   *
   * 与回写报告同纪律：随 `board.json` 持久化，重启后编排会话与简报都可恢复（VI 文件即真相）。
   */
  setOrchestration(
    key: string,
    next: RequirementOrchestration,
  ): { ok: boolean; reason?: string; requirement?: RequirementSummary } {
    const existing = this.deps.board.snapshot.requirements[key]
    if (!existing) return { ok: false, reason: `需求不在本地池：${key}` }
    try {
      this.deps.board.setOrchestration(key, next)
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
    this.persist('requirement-orchestration', { key, mode: next.mode })
    const updated = this.deps.board.snapshot.requirements[key]
    return updated ? { ok: true, requirement: requirementToSummary(updated) } : { ok: true }
  }

  /**
   * 落存任务级编排上下文（会话 id / 是否复用 / 归纳结论）。
   *
   * @returns 更新后的任务视图；失败给出可读原因。
   */
  setTaskOrchestration(
    taskId: string,
    patch: TaskOrchestration,
  ): TaskOpResult {
    try {
      const next = this.deps.board.setTaskOrchestration(taskId, patch)
      this.persist('task-orchestration', { taskId, ...patch })
      return { ok: true, task: toTaskView(next) }
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
  }

  /** 取任务子会话复用表里的持久会话 id（AC3.3）。 */
  getTaskSession(requirementKey: string, reuseKey: string): string | undefined {
    return this.deps.board.getTaskSession(requirementKey, reuseKey)
  }

  /** 登记任务子会话复用键（AC3.3）。 */
  putTaskSession(
    requirementKey: string,
    reuseKey: string,
    sessionId: string,
  ): { ok: boolean; reason?: string } {
    try {
      this.deps.board.putTaskSession(requirementKey, reuseKey, sessionId)
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
    this.persist('task-session-reuse', { requirementKey, reuseKey, sessionId })
    return { ok: true }
  }

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
    requirementKey: string
    title: string
    description?: string
    prompt?: string
    roleAgent: string
    frozenConfig: FrozenConfig
    workspace?: string
    /** 当前时间（测试可注入）。 */
    now?: Date
  }): { ok: boolean; taskId?: string; reason?: string } {
    const req = this.deps.board.snapshot.requirements[input.requirementKey]
    if (!req) {
      return {
        ok: false,
        reason: `需求未领取：${input.requirementKey}（「执行配置」发起的执行需要落到看板，请先到「需求池」把该需求领取入池）`,
      }
    }
    const roleSlug = input.roleAgent.replace(/[^\w\u4e00-\u9fa5-]/g, '') || 'role'
    const stamp = (input.now ?? new Date()).toISOString().replace(/[-:T]/g, '').slice(0, 14)
    const taskId = `${input.requirementKey}#manual-${roleSlug}-${stamp}`
    try {
      const task = this.deps.board.addTask({
        taskId,
        requirementId: input.requirementKey,
        idempotencyKey: taskId,
        title: input.title,
        description: input.description ?? '',
        roleAgent: input.roleAgent,
        frozenConfig: input.frozenConfig,
        blockedBy: [],
        ...(input.workspace ? { workspace: input.workspace } : {}),
        ...(input.prompt ? { prompt: input.prompt } : {}),
      })
      this.persist('task-create', { taskId: task.taskId, trigger: 'execution-panel-dispatch' })
      /**
       * 手工派发也是"重新开工"：若该需求此前已完成（或被显式取消完成），新任务意味着它重新进入生产，
       * 回到"未判定"态（做完后重新按任务状态自动完成）。失败不阻断 —— 任务已建成，需求状态可后续对账。
       */
      if (this.deps.board.resetRequirementCompletion(input.requirementKey)) {
        this.persist('requirement-exec-state', { key: input.requirementKey, state: null, trigger: 'manual-task' })
      }
      return { ok: true, taskId: task.taskId }
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
  }

  /**
   * 把已领取需求**还原到需求池**（问题 7）。
   *
   * 引擎门禁：名下仍有任何非 deleted 任务时拒绝；其 deleted 任务随需求一并清理，
   * 并级联清理 blockedBy 悬挂引用。TFS 工作项不删除；best-effort 移除入池时打的
   * `dsh` 标签，失败只回带 tagWarning 不阻断还原。
   */
  async restoreRequirement(key: string): Promise<RestoreResult> {
    const state = this.deps.board.snapshot
    const req = state.requirements[key]
    if (!req) return { ok: false, reason: `需求不在本地池：${key}` }
    // D4：还原前先收集该需求登记的全部 continuable 子会话 id（还原后需求对象被删，查不到）。
    //
    // ⚠️ **编排主会话也必须一并收集**（2026-10-06 修复）：`orchestratorSessionId` 与
    // `taskSessions` 里的值一样，都是 `startContinuableOn` 建出来的持久子会话（同一父 Agent
    // 名下）。此前只收 `taskSessions`，于是「还原到需求池」后编排主会话 id 随需求对象一起
    // 消失，再无任何入口能释放它 ⇒ 宿主侧一个 continuable 子会话永久存活（D4 的漏网之鱼）。
    const sessionIds = [
      ...(typeof req.orchestration?.orchestratorSessionId === 'string'
        && req.orchestration.orchestratorSessionId.length > 0
        ? [req.orchestration.orchestratorSessionId]
        : []),
      ...Object.values(req.orchestration?.taskSessions ?? {}),
    ].filter((id): id is string => typeof id === 'string' && id.length > 0)
    let removedTasks: string[]
    try {
      removedTasks = this.deps.board.restoreRequirement(key)
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
    // best-effort 移除 TFS 上的入池标签（经写门禁四道；失败只降级为告警，不阻断还原）。
    let tagWarning: string | undefined
    if (this.deps.adapter.removeTags) {
      try {
        // `confirmed=true`：用户刚显式点了「还原到需求池」，这就是本次写操作的人工确认凭据。
        await this.deps.adapter.removeTags(req.workItemId, req.collection, [this.deps.defaultLabel], true)
      } catch (e) {
        tagWarning = `本地已还原，但移除 TFS 标签「${this.deps.defaultLabel}」失败：${(e as Error).message}`
      }
    }
    // D4：best-effort 释放 continuable 任务子会话（失败只降级为告警，不阻断还原）。
    let sessionWarning: string | undefined
    if (sessionIds.length > 0 && this.deps.disposeRequirementSessions) {
      try {
        sessionWarning = await this.deps.disposeRequirementSessions(sessionIds)
      } catch (e) {
        sessionWarning = `本地已还原，但释放任务子会话失败：${(e as Error).message}`
      }
    }
    this.persist('requirement-restore', { key, removedTasks, ...(sessionIds.length ? { sessionIds } : {}) })
    return {
      ok: true,
      removedTasks,
      ...(tagWarning ? { tagWarning } : {}),
      ...(sessionWarning ? { sessionWarning } : {}),
    }
  }

  /**
   * 实时重取需求工作项，把四段正文（详细信息/需求分析/数据结构/需求配置）回写看板（问题 11）。
   *
   * 保留本地字段（workspace 等）；需求不在本地池时返回失败（补全只针对已领取需求）。
   */
  async enrichRequirement(key: string): Promise<EnrichResult> {
    const state = this.deps.board.snapshot
    const existing = state.requirements[key]
    if (!existing) return { ok: false, reason: `需求不在本地池：${key}` }
    let fresh: RequirementSummary
    try {
      fresh = await this.deps.adapter.getRequirement(existing.workItemId, existing.collection)
    } catch (e) {
      return { ok: false, reason: `重取工作项失败：${(e as Error).message}` }
    }
    const merged = summaryToRequirement(fresh)
    // 本地字段不被服务端数据覆盖：TFS 返回的摘要里根本没有它们，不显式搬过来就会被这次
    // enrich 抹掉（`Board.updateRequirement` 是**整对象替换**）。
    //
    // ⚠️ 这里必须按**清单**搬，不能靠"记得住"补（2026-10-06 修复）：此前只搬了 4 个，
    // 漏掉 `orchestration` 与 `writeBack` 两个同样是本地补充的字段，于是用户每点一次
    // 「实时重取需求正文」都会：
    //   - 丢掉编排主会话 id ⇒ 下次 `ensure` 判定 `getOrchestration()` 为 undefined 又建一个
    //     continuable 主会话（旧会话成孤儿，永久占宿主会话资源），`taskSessions` 一并丢失
    //     ⇒ spec 010 的会话复用（AC3.3）自此失效，每个任务都新建会话；
    //   - 丢掉回写报告 ⇒ finalizer 的幂等账本没了，重跑会把结论评论/附件**重复追加**到 TFS。
    // 新增任何"本地补充字段"都必须同步 {@link LOCAL_REQUIREMENT_FIELDS}，并由
    // `tests/audit-2026-10-06-fixes.spec.ts` 的清单完整性用例把守。
    //
    // `execState` 必须连 `'active'` 一起搬：它是"人声明还没完"的抑制标记，丢了就会被自动完成标回去。
    for (const field of LOCAL_REQUIREMENT_FIELDS) {
      const value = existing[field]
      if (value === undefined) continue
      // 逐字段赋值（而非整对象展开）：保持各字段自己的"空值不落盘"纪律。
      Object.assign(merged, { [field]: value })
    }
    this.deps.board.updateRequirement(merged)
    this.persist('requirement-enrich', { key })
    return { ok: true, requirement: requirementToSummary(merged) }
  }

  // ─────────────── 问题 3/4：编辑能力 ───────────────

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
  private resolveWorkspace(
    raw: string | null | undefined,
  ): { ok: true; value: string | undefined } | { ok: false; reason: string } {
    if (raw === null || raw === undefined) return { ok: true, value: undefined }
    const issue = workspaceIssue(raw)
    if (issue) return { ok: false, reason: issue }
    const ws = normalizeWorkspace(raw)
    // statSync 缺失时**跳过**存在性校验（内存文件系统/受限环境），不误判为失败。
    if (typeof this.fs.statSync === 'function') {
      const st = this.fs.statSync(ws)
      if (st === undefined) return { ok: false, reason: `代码库路径不存在：${ws}` }
      if (typeof st.isDirectory === 'function' && !st.isDirectory()) {
        return { ok: false, reason: `代码库路径不是目录：${ws}` }
      }
    }
    return { ok: true, value: ws }
  }

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
  updateRequirementMeta(
    key: string,
    patch: { workspace?: string | null; prompt?: string | null },
  ): { ok: boolean; reason?: string; requirement?: RequirementSummary } {
    const state = this.deps.board.snapshot
    const existing = state.requirements[key]
    if (!existing) return { ok: false, reason: `需求不在本地池：${key}` }

    // snapshot 是内部活引用（Board.snapshot 的契约警告）：跨后续 await 前先取成基本类型。
    const next: Requirement = { ...existing }

    if ('workspace' in patch) {
      const ws = this.resolveWorkspace(patch.workspace)
      if (!ws.ok) return { ok: false, reason: ws.reason }
      if (ws.value === undefined) delete next.workspace
      else next.workspace = ws.value
    }
    if ('prompt' in patch) {
      const p = patch.prompt === null ? undefined : (patch.prompt ?? '').trim()
      if (p === undefined || p.length === 0) delete next.prompt
      else next.prompt = p
    }

    this.deps.board.updateRequirement(next)
    this.persist('requirement-update', {
      key,
      fields: Object.keys(patch),
      workspace: next.workspace ?? null,
      promptLength: next.prompt?.length ?? 0,
    })
    return { ok: true, requirement: requirementToSummary(next) }
  }

  /**
   * 编辑任务字段（问题 3/4：提示词 / 模型 / 供应商 / 技能 / MCP / 工作目录 / 预设 / 执行预算）。
   *
   * 工作目录在此**单独**校验（fail-loud），其余字段交给引擎 `Board.updateTask` 做
   * 结构化校验与 revision 乐观锁。工作目录先落进 `patch` 再交给引擎，保证"校验通过才写"。
   */
  updateTask(
    taskId: string,
    patch: {
      prompt?: string | null
      workspace?: string | null
      model?: string
      modelProvider?: string
      skills?: string[]
      mcp?: string[]
      preset?: string
      workflow?: string
      maxDepth?: number
      maxTokens?: number
    },
    expectedRevision?: number,
  ): TaskOpResult {
    const task = this.deps.board.snapshot.tasks[taskId]
    if (!task) return { ok: false, reason: `未知任务：${taskId}` }
    const rev = expectedRevision ?? task.revision
    // 冻结配置是**整体替换**语义：只传一部分时用当前值补齐（避免把没动的字段清空）。
    // spec 009：modelProvider 与 model 同属模型路由，任一出现即视为要重写冻结配置。
    // 问题 3：preset / maxDepth / maxTokens 同理，任一出现也视为要重写冻结配置。
    // 2026-10-29：workflow（诉求 4）同理。
    const wantsFrozen =
      patch.model !== undefined ||
      patch.modelProvider !== undefined ||
      patch.skills !== undefined ||
      patch.mcp !== undefined ||
      patch.preset !== undefined ||
      patch.workflow !== undefined ||
      patch.maxDepth !== undefined ||
      patch.maxTokens !== undefined
    let workspacePatch: { workspace?: string | null } = {}
    if ('workspace' in patch) {
      const ws = this.resolveWorkspace(patch.workspace)
      if (!ws.ok) return { ok: false, reason: ws.reason }
      workspacePatch = { workspace: ws.value ?? null }
    }
    try {
      // provider 与 model 成对：只传 provider 时沿用当前 model；trim 后空串不写键（引擎层再归一一次）。
      const frozenModel = patch.model ?? task.frozenConfig.model
      const frozenProvider =
        patch.modelProvider !== undefined
          ? patch.modelProvider.trim()
          : (task.frozenConfig.modelProvider ?? '')
      // 问题 3：preset/预算缺省时沿用当前值（0/缺省 = 不写键，由引擎层归一）。
      const frozenPreset = patch.preset !== undefined ? patch.preset.trim() : (task.frozenConfig.preset ?? '')
      const frozenMaxDepth = patch.maxDepth ?? task.frozenConfig.maxDepth ?? 0
      const frozenMaxTokens = patch.maxTokens ?? task.frozenConfig.maxTokens ?? 0
      const nextSkills = patch.skills ?? [...task.frozenConfig.skills]
      // 2026-10-29（诉求 4）：工作流必须在技能清单内 —— 工作流就是一个技能。
      // 允许"清空工作流"（空串），但不允许指向一个没选的技能：那会让派发时
      // 既加载不到正文、又生成一份无步骤可执行的强制流程，属于自相矛盾的配置。
      const frozenWorkflow = patch.workflow !== undefined ? patch.workflow.trim() : (task.frozenConfig.workflow ?? '')
      if (frozenWorkflow.length > 0 && !nextSkills.includes(frozenWorkflow)) {
        return {
          ok: false,
          reason: `工作流「${frozenWorkflow}」不在该任务的技能清单内：请先在「技能」里选中它（工作流从技能中选择）`,
        }
      }
      const next = this.deps.board.updateTask(
        taskId,
        {
          ...('prompt' in patch ? { prompt: patch.prompt ?? null } : {}),
          ...workspacePatch,
          ...(wantsFrozen
            ? {
                frozenConfig: {
                  model: frozenModel,
                  ...(frozenProvider ? { modelProvider: frozenProvider } : {}),
                  skills: nextSkills,
                  mcp: patch.mcp ?? [...task.frozenConfig.mcp],
                  ...(frozenPreset ? { preset: frozenPreset } : {}),
                  ...(frozenWorkflow.length > 0 ? { workflow: frozenWorkflow } : {}),
                  ...(frozenMaxDepth > 0 ? { maxDepth: frozenMaxDepth } : {}),
                  ...(frozenMaxTokens > 0 ? { maxTokens: frozenMaxTokens } : {}),
                },
              }
            : {}),
        },
        rev,
      )
      this.persist('task-update', { taskId, fields: Object.keys(patch) })
      return { ok: true, task: toTaskView(next) }
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
  }

  // ─────────────── 问题 1：需求池可选项落盘缓存 ───────────────

  /**
   * 读本地落盘的可选项；文件缺失/损坏返回 data=null（损坏不锁死，调用方随即走采集）。
   * @param collection - 集合名；缺省用看板当前集合（由调用方解析后传入）。
   */
  loadQueryOptions(collection: string): { ok: boolean; data: RequirementQueryOptions | null; savedAt?: string } {
    try {
      const all = this.queryOptionsStore.read()
      const hit = all?.[collection]
      if (hit?.data) return { ok: true, data: hit.data, savedAt: hit.savedAt }
      return { ok: true, data: null }
    } catch {
      // 解析失败（JsonStoreParseError，原文件保留）：按无缓存处理，不把损坏文件当错误抛给 UI。
      return { ok: true, data: null }
    }
  }

  /**
   * 强制重新采集可选项并原子落盘覆盖（问题 1「采集可选项」按钮）。
   * 全空结果不落盘（沿用 shouldCacheQueryOptions 判据，避免一次抖动锁死空下拉）。
   */
  async collectQueryOptions(
    collection: string,
  ): Promise<{ ok: boolean; data?: RequirementQueryOptions; reason?: string }> {
    if (!this.deps.adapter.getQueryOptions) {
      return { ok: false, reason: '适配层未提供可选项采集能力' }
    }
    let data: RequirementQueryOptions
    try {
      data = await this.deps.adapter.getQueryOptions(collection)
    } catch (e) {
      return { ok: false, reason: `采集可选项失败：${(e as Error).message}` }
    }
    if (shouldCacheQueryOptions(data)) {
      /**
       * 读取旧缓存要自己兜住解析失败：本行的 `write` 正是修复损坏文件的那一步，
       * 读失败就抛等于"永远修不好"——`loadQueryOptions` 会把同一个错误吞成 `data:null`
       * 并让 UI 提示"未采集"，用户再点一次采集又撞回这里，形成自我维持的坏状态。
       * 读不到就当没有旧缓存：本次采集结果照样落盘，损坏的文件随之被覆盖修好。
       */
      let all: Record<string, { data: RequirementQueryOptions; savedAt: string }> = {}
      try {
        all = this.queryOptionsStore.read() ?? {}
      } catch (error) {
        this.events.append({ kind: 'board', action: 'query-options-read-failed', detail: { collection, reason: (error as Error).message } })
      }
      all[collection] = { data, savedAt: new Date().toISOString() }
      this.queryOptionsStore.write(all)
    }
    return { ok: true, data }
  }

  // ─────────────── 问题 2/4/6：UI 状态（筛选/每页条数）落盘 ───────────────

  /** 读某集合的 UI 状态；文件缺失/损坏返回空对象（客户端回退默认值）。 */
  loadUiState(collection: string): UiState {
    try {
      const all = this.uiStateStore.read()
      return all?.[collection] ?? {}
    } catch {
      return {}
    }
  }

  /**
   * 合并保存某集合的 UI 状态（浅合并单集合节点；只覆盖 patch 给出的键）。
   * poolFilters 整体替换（筛选语义是"当前选择"，不做数组合并）。
   */
  saveUiState(patch: Partial<UiState>, collection: string): { ok: boolean; reason?: string } {
    try {
      const all = this.uiStateStore.read() ?? {}
      const current: UiState = all[collection] ?? {}
      all[collection] = { ...current, ...patch }
      this.uiStateStore.write(all)
      return { ok: true }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  /**
   * 指派/改派任务角色（T042）。角色须存在（S-13 引用校验）。
   * @param taskId - 任务 ID。
   * @param roleName - 角色展示名。
   */
  assignTask(taskId: string, roleName: string): TaskOpResult {
    const role = this.deps.roles.getByName(roleName)
    if (!role) return { ok: false, reason: `角色「${roleName}」不存在（检查 US5 角色配置）` }
    const task = this.deps.board.snapshot.tasks[taskId]
    if (!task) return { ok: false, reason: `未知任务：${taskId}` }
    try {
      const next = this.deps.board.assignTask(taskId, roleName, task.revision)
      this.persist('assign', { taskId, roleName })
      return { ok: true, task: toTaskView(next) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

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
  setTaskState(taskId: string, action: TaskAction, expectedRevision?: number): TaskOpResult {
    const task = this.deps.board.snapshot.tasks[taskId]
    if (!task) return { ok: false, reason: `未知任务：${taskId}` }
    // snapshot 是内部活引用：跨后续 await / 变更前先取成基本类型（Board.snapshot 的契约警告）。
    const requirementId = task.requirementId
    const rev = expectedRevision ?? task.revision
    try {
      let next
      /** 本次动作是否构成一次"收口"及其结果（start/retry/cancel 不走自动链式与回写钩子）。 */
      let settledOutcome: 'success' | 'failed' | 'needs_confirmation' | undefined
      if (action === 'start' || action === 'retry') {
        next = this.deps.board.startTask(taskId, rev)
      } else if (action === 'complete') {
        next = this.deps.board.finishTask(taskId, 'success', rev)
        settledOutcome = 'success'
      } else if (action === 'fail') {
        next = this.deps.board.finishTask(taskId, 'failed', rev)
        settledOutcome = 'failed'
      } else if (action === 'cancel') {
        next = this.deps.board.finishTask(taskId, 'cancelled', rev)
        // 本地状态终态之后紧接着停掉子 run（abort + dispose + 归还并发槽）。
        this.cancelRunBestEffort(taskId)
      } else if (action === 'confirm') {
        // 问题 5：人工确认通过 → completed/success（引擎校验当前必须是 needs_confirmation）。
        next = this.deps.board.confirmTask(taskId, rev)
        settledOutcome = 'success'
      } else {
        return { ok: false, reason: `未知动作：${String(action)}` }
      }
      this.persist('task-state', { taskId, action, state: next.state, execState: next.execState })
      /**
       * 取消也可能让需求"全部任务已收口"（名下其余任务皆终态）⇒ 仍跑一次自动完成判定。
       *
       * 判定若真的翻转（`sealed` 为 true），还必须补一次 `afterTaskSettled`：取消路径本身
       * 不产出 `settledOutcome`，若只 seal 不发钩子，需求会迁到「已完成」页却没有触发
       * `finalizer.maybeFinalize` —— 评审/自测字段、结论评论、附件、子任务归位全部静默跳过。
       */
      if (action === 'cancel' && this.sealRequirementIfAllDone(requirementId)) {
        this.afterTaskSettled({ taskId, requirementKey: requirementId, outcome: 'success' })
      }
      if (settledOutcome) {
        this.afterTaskSettled({
          taskId,
          requirementKey: requirementId,
          outcome: settledOutcome,
          ...(next.autoLaunched ? { autoLaunched: true } : {}),
        })
      }
      return { ok: true, task: toTaskView(next) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  /**
   * 装配层注入收口副作用钩子（问题 4 自动回写 / 问题 6 自动链式）。
   *
   * 之所以用 setter 而非构造参数：`BoardService` 在 `index.ts` 里**先于** `createHostApi` 构造，
   * 而钩子需要调用 api 内部的派发函数，存在构造顺序环。api 构造后立即调用本方法补接即可。
   */
  setSettledHook(hook: (info: TaskSettledInfo) => void): void {
    this.deps.onTaskSettled = hook
  }

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
  autoStartRunnable(limit: number, requirementKey?: string): { ok: true; taskIds: string[] } {
    const taskIds: string[] = []
    // Board.pickRunnable 返回就绪任务的 **id**（内部已扣除在跑/待确认占用的并发槽，
    // 且只选 pending && 依赖全 completed），这里再逐个取当前 revision 启动。
    const runnableIds = this.deps.board.pickRunnable(limit >= 1 ? Math.floor(limit) : 1, requirementKey)
    for (const id of runnableIds) {
      try {
        const snapshot = this.deps.board.snapshot.tasks[id]
        if (!snapshot) continue
        const next = this.deps.board.startTask(id, snapshot.revision, { autoLaunched: true })
        this.persist('task-state', {
          taskId: next.taskId,
          action: 'start',
          auto: true,
          state: next.state,
          execState: next.execState,
        })
        taskIds.push(next.taskId)
      } catch (e) {
        this.events.append({
          kind: 'board',
          action: 'auto-start-failed',
          detail: { taskId: id, error: (e as Error).message },
        } as unknown as Record<string, unknown>)
      }
    }
    return { ok: true, taskIds }
  }

  /**
   * 派发返回后立即绑定子会话 runId（spec 006 US2）。
   *
   * 与收口分离：dispatch 一拿到 runId 就调用，使任务**运行中**也能按 runId 冷读执行轨迹。
   */
  bindRun(taskId: string, runId: string, provider?: string, turn?: number): TaskOpResult {
    const task = this.deps.board.snapshot.tasks[taskId]
    if (!task) return { ok: false, reason: `未知任务：${taskId}` }
    try {
      const next = this.deps.board.attachRunId(taskId, runId, provider, turn)
      this.persist('task-bind-run', { taskId, runId, ...(turn ? { turn } : {}) })
      return { ok: true, task: toTaskView(next) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  /**
   * 按子 run 执行结果收口任务（spec 006 US2；问题 5 新增 `needs_confirmation`）。
   *
   * 与 `setTaskState` 的区别：携带执行元数据（runId/stopReason/diagnostic/output），落进闭合的
   * attempt。`failed` 时保留 in_progress 可重试（引擎既有语义）；`needs_confirmation` 时看板态
   * 保持 in_progress、阻断下游自动链式与需求回写，等待人工「确认通过」或「追问」。
   */
  settleTask(
    taskId: string,
    outcome: 'success' | 'failed' | 'needs_confirmation',
    meta?: AttemptMeta & { note?: string },
  ): TaskOpResult {
    const task = this.deps.board.snapshot.tasks[taskId]
    if (!task) return { ok: false, reason: `未知任务：${taskId}` }
    const requirementId = task.requirementId
    try {
      const next = this.deps.board.finishTask(taskId, outcome, task.revision, meta?.note, meta)
      this.persist('task-settle', { taskId, outcome, stopReason: meta?.stopReason })
      // 收口后统一处理：success 才 seal 需求完成；自动链式 / TFS 回写由注入钩子异步执行。
      this.afterTaskSettled({
        taskId,
        requirementKey: requirementId,
        outcome,
        ...(next.autoLaunched ? { autoLaunched: true } : {}),
      })
      return { ok: true, task: toTaskView(next) }
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
  }

  /**
   * 为「追问 / 补充指令」打开新一轮执行（spec 006 US3）。
   *
   * completed 显式重开为 in_progress、failed 续跑；追加一条 running attempt 并保留全部历史。
   * @returns 成功时额外带 `attempt`（新一轮 attempt 下标）。
   */
  openFollowUp(taskId: string): TaskOpResult & { attempt?: number } {
    const task = this.deps.board.snapshot.tasks[taskId]
    if (!task) return { ok: false, reason: `未知任务：${taskId}` }
    try {
      const { task: next, attemptIndex } = this.deps.board.followUpTask(taskId)
      this.persist('task-follow-up', { taskId, attempt: attemptIndex })
      return { ok: true, task: toTaskView(next), attempt: attemptIndex }
    } catch (e) {
      return { ok: false, reason: e instanceof BoardError ? e.message : (e as Error).message }
    }
  }

  /**
   * 任务列表（T044）：按状态 / 角色 / 需求 / 关键字筛选。
   * @param filter - 筛选条件（全部可选）。
   */
  listTasks(filter: {
    state?: TaskState
    roleAgent?: string
    requirementId?: string
    keyword?: string
  } = {}): BoardTaskView[] {
    let tasks = Object.values(this.deps.board.snapshot.tasks)
    if (filter.state) tasks = tasks.filter(t => t.state === filter.state)
    if (filter.roleAgent) tasks = tasks.filter(t => t.roleAgent === filter.roleAgent)
    if (filter.requirementId) tasks = tasks.filter(t => t.requirementId === filter.requirementId)
    if (filter.keyword) {
      const kw = filter.keyword.toLowerCase()
      tasks = tasks.filter(t => t.title.toLowerCase().includes(kw) || t.taskId.toLowerCase().includes(kw))
    }
    return tasks.sort((a, b) => a.taskId.localeCompare(b.taskId)).map(toTaskView)
  }

  /** 渲染 Markdown 看板并记录路径（T061，幂等）。 */
  renderMarkdown(): { ok: boolean; path: string; reason?: string } {
    try {
      this.fs.mkdirSync(join(this.deps.baseDir, '.ai-board'), { recursive: true })
      this.fs.writeFileSync(this.markdownPath, renderBoardMarkdown(this.deps.board.snapshot as BoardState), 'utf8')
      this.deps.board.setMarkdownViewPath(this.markdownPath)
      this.store.write(this.deps.board.snapshot as BoardState)
      return { ok: true, path: this.markdownPath }
    } catch (e) {
      return { ok: false, path: this.markdownPath, reason: (e as Error).message }
    }
  }

  /** 读取当前渲染出的 Markdown 文本（T061 json→md 一致性校验用）。 */
  readMarkdown(): string | null {
    if (!this.fs.existsSync(this.markdownPath)) return null
    return this.fs.readFileSync(this.markdownPath, 'utf8')
  }

  /** 重放事件日志（诊断/对账用）。 */
  replayEvents(): Array<Record<string, unknown>> {
    return this.events.replay()
  }
}

/** `TaskSnapshot` → 客户端可序列化视图。 */
export function toTaskView(t: {
  taskId: string
  requirementId: string
  title: string
  description: string
  roleAgent: string
  state: TaskState
  execState: string
  blockedBy: string[]
  revision: number
  frozenConfig: {
    mcp: string[]
    skills: string[]
    model: string
    modelProvider?: string
    preset?: string
    maxDepth?: number
    maxTokens?: number
  }
  attempts: Array<{
    startedAt: string
    endedAt?: string
    outcome: string
    note?: string
    runId?: string
    stopReason?: string
    diagnostic?: string
    output?: string
    provider?: string
  }>
  workspace?: string
  prompt?: string
  artifactPaths?: string[]
  autoLaunched?: boolean
  /** spec 010：任务级编排上下文（会话 id / 是否复用 / 归纳结论）。 */
  orchestration?: TaskOrchestration
}): BoardTaskView {
  const last = t.attempts[t.attempts.length - 1]
  return {
    taskId: t.taskId,
    requirementId: t.requirementId,
    title: t.title,
    description: t.description,
    roleAgent: t.roleAgent,
    state: t.state,
    execState: t.execState,
    blockedBy: t.blockedBy,
    revision: t.revision,
    frozenConfig: t.frozenConfig,
    attemptCount: t.attempts.length,
    ...(last?.note ? { lastNote: last.note } : {}),
    ...(t.workspace ? { workspace: t.workspace } : {}),
    ...(t.prompt ? { prompt: t.prompt } : {}),
    // 问题 6：自动链式派发标记；问题 4：关键产物路径（回写时上传为需求附件的候选）。
    ...(t.autoLaunched ? { autoLaunched: true } : {}),
    ...(t.artifactPaths && t.artifactPaths.length > 0 ? { artifactPaths: [...t.artifactPaths] } : {}),
    // spec 010：任务级编排上下文（缺失时不写键，旧快照形状不变）。
    ...(t.orchestration ? { orchestration: { ...t.orchestration } } : {}),
    // spec 006：透出每次尝试明细（runId/落定原因/诊断/输出/provider），供任务详情页渲染。
    attempts: t.attempts.map(a => ({
      startedAt: a.startedAt,
      ...(a.endedAt ? { endedAt: a.endedAt } : {}),
      outcome: a.outcome,
      ...(a.note ? { note: a.note } : {}),
      ...(a.runId ? { runId: a.runId } : {}),
      ...(a.stopReason ? { stopReason: a.stopReason } : {}),
      ...(a.diagnostic ? { diagnostic: a.diagnostic } : {}),
      ...(a.output ? { output: a.output } : {}),
      ...(a.provider ? { provider: a.provider } : {}),
    })),
  }
}

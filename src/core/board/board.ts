/**
 * 看板引擎（Principle VI：JSON 为权威）。
 *
 * 负责：领取需求、拆解任务、指派角色、状态机校验、DAG 依赖求解、FIFO 并发排队（S-06）。
 * 不依赖宿主 API，纯逻辑；宿主侧经 `persistence/json-store` 落盘。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/core/board/board
 */

import type {
  Requirement,
  RequirementExecState,
  RequirementOrchestration,
} from '../../tfs/types.js'
import { requirementDedupKey } from '../../tfs/types.js'
import {
  bumpRevision,
  canTransition,
  type AttemptRecord,
  type TaskOrchestration,
  type TaskSnapshot,
  type TaskState,
} from './task.js'
import type { ExecState } from './exec-state.js'

/**
 * 一次尝试落定时附带的执行元数据（spec 006 US2）。
 * 全部可选；用于把 subagent run 的会话 id / 落定原因 / 失败诊断 / 输出摘要落进 attempt。
 */
export interface AttemptMeta {
  runId?: string
  stopReason?: string
  diagnostic?: string
  output?: string
  provider?: string
  /**
   * 本次收口从子智能体输出中解析出的关键产物绝对路径（问题 4）。
   * 与其它字段不同：它**不落在 attempt 上**，而是由 `finishTask` 合并去重后写到任务级
   * `TaskSnapshot.artifactPaths`，供需求完成回写时上传为需求附件。
   */
  artifactPaths?: string[]
}

/** 只挑出 AttemptRecord 上真实存在且有值的元数据字段（避免写入 undefined 覆盖）。 */
function attemptMetaFields(meta?: AttemptMeta): Partial<AttemptRecord> {
  if (!meta) return {}
  const out: Partial<AttemptRecord> = {}
  if (meta.runId) out.runId = meta.runId
  if (meta.stopReason) out.stopReason = meta.stopReason
  if (meta.diagnostic) out.diagnostic = meta.diagnostic
  if (meta.output) out.output = meta.output
  if (meta.provider) out.provider = meta.provider
  return out
}

/** 把元数据合并进一条已存在的 attempt。 */
function applyAttemptMeta(attempt: AttemptRecord, meta?: AttemptMeta): void {
  Object.assign(attempt, attemptMetaFields(meta))
}

/** 看板权威快照。 */
export interface BoardState {
  /** 快照版本（乐观锁）。 */
  version: number
  /** 全部 DsTask（按 taskId）。 */
  tasks: Record<string, TaskSnapshot>
  /** 全部 Requirement（按 dedupKey，含集合命名空间 S-02）。 */
  requirements: Record<string, Requirement>
  /** 更新时间 ISO。 */
  updatedAt: string
  /** 渲染出的 Markdown 看板路径（可选）。 */
  markdownViewPath?: string
}

/** 创建空看板。 */
export function emptyBoard(): BoardState {
  return { version: 0, tasks: {}, requirements: {}, updatedAt: new Date().toISOString() }
}

/** 任务草稿（拆解/创建时的输入，不含运行期字段）。 */
export interface TaskDraft {
  taskId: string
  requirementId: string
  idempotencyKey: string
  title: string
  description: string
  roleAgent: string
  frozenConfig: TaskSnapshot['frozenConfig']
  blockedBy?: string[]
  /** 目标代码库绝对路径（由需求继承；本地补充字段，非 TFS 字段）。 */
  workspace?: string
  /** 任务级执行提示词（本地补充字段，非 TFS 字段）。 */
  prompt?: string
}

/** 依赖/并发冲突错误。 */
export class BoardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'BoardError'
  }
}

/**
 * 看板引擎。所有变更经方法进入，内部维护 revision 一致性。
 */
export class Board {
  private state: BoardState

  constructor(initial?: BoardState) {
    this.state = initial ?? emptyBoard()
  }

  /**
   * 当前快照。
   *
   * **契约警告（易踩坑）**：返回的是**内部活引用**，不是深拷贝——`readonly` 只在类型层面生效。
   * 持该引用**跨任意 await / 变更**读取，会看到变更后的新值（例如 `revision` 已被 +1）。
   * 需要"某个时刻的值"时，请立刻取成基本类型或做一次浅拷贝（`{...t}`），再继续异步流程。
   * 客户端的序列化（`JSON.stringify`）是同步的，不受影响。
   */
  get snapshot(): Readonly<BoardState> {
    return this.state
  }

  /** 用新快照替换（落盘后恢复用）。 */
  load(state: BoardState): void {
    this.state = state
  }

  /**
   * 领取需求到本地池（幂等，S-01）。
   * @param req - 需求。
   * @returns 是否为新增（false 表示已存在）。
   */
  claimRequirement(req: Requirement): boolean {
    const key = requirementDedupKey(req)
    if (this.state.requirements[key]) return false
    this.state.requirements[key] = req
    this.state.updatedAt = new Date().toISOString()
    this.state.version = bumpRevision(this.state.version)
    return true
  }

  /**
   * 覆盖已领取需求的本地副本（T048 打标签成功后同步 tags，使本地视图与 TFS 一致）。
   *
   * 只更新**已存在**的条目；未领取时返回 false（不隐式入池，保持"领取"是显式动作）。
   *
   * @param req - 新的需求副本（按 dedupKey 定位）。
   * @returns 是否更新成功。
   */
  updateRequirement(req: Requirement): boolean {
    const key = requirementDedupKey(req)
    if (!this.state.requirements[key]) return false
    this.state.requirements[key] = req
    this.state.updatedAt = new Date().toISOString()
    this.state.version = bumpRevision(this.state.version)
    return true
  }

  /**
   * 批量新增任务（US3/T041 拆解结果落库）。任一任务非法即整体失败（不半写）。
   * @param drafts - 任务草稿列表。
   * @returns 新增的任务快照列表。
   */
  addTasks(drafts: TaskDraft[]): TaskSnapshot[] {
    // 先整体校验（需求存在 + 任务未重复 + 草稿内部不重复），再统一落库，避免半写。
    const pending = new Set<string>()
    for (const d of drafts) {
      if (!this.state.requirements[d.requirementId]) throw new BoardError(`未知需求：${d.requirementId}`)
      if (this.state.tasks[d.taskId]) throw new BoardError(`任务已存在：${d.taskId}`)
      if (pending.has(d.taskId)) throw new BoardError(`草稿内任务重复：${d.taskId}`)
      pending.add(d.taskId)
    }
    return drafts.map(d => this.addTask(d))
  }

  /**
   * 新增任务（须属于已领取需求）。
   * @param draft - 任务草稿。
   */
  addTask(draft: TaskDraft): TaskSnapshot {
    if (!this.state.requirements[draft.requirementId]) {
      throw new BoardError(`未知需求：${draft.requirementId}`)
    }
    if (this.state.tasks[draft.taskId]) {
      throw new BoardError(`任务已存在：${draft.taskId}`)
    }
    const task: TaskSnapshot = {
      taskId: draft.taskId,
      requirementId: draft.requirementId,
      idempotencyKey: draft.idempotencyKey,
      title: draft.title,
      description: draft.description,
      roleAgent: draft.roleAgent,
      frozenConfig: draft.frozenConfig,
      state: 'pending',
      execState: 'queued',
      blockedBy: draft.blockedBy ?? [],
      revision: 0,
      attempts: [],
      artifactPaths: [],
      ...(draft.workspace ? { workspace: draft.workspace } : {}),
      ...(draft.prompt ? { prompt: draft.prompt } : {}),
    }
    this.state.tasks[draft.taskId] = task
    this.state.updatedAt = new Date().toISOString()
    this.state.version = bumpRevision(this.state.version)
    return task
  }

  /**
   * 拆解落库（问题 9：重新拆解对已取消任务空转）。
   *
   * 规则：
   *   - 同 id 任务**不存在** → 新建；
   *   - 同 id 任务处于 `deleted`（已取消，终态）→ **不视为已存在**：删除旧历史记录后按新草稿
   *     原地重建为全新待办（拆解 id 是确定性的 `#analyze/#plan/#impl/#review/#verify`，无法"换号新建"；
   *     取消事件已在尝试记录/审计里留痕）；
   *   - 同 id 任务为其他状态 → 跳过（幂等，不覆盖在办任务）。
   *
   * @param drafts - 任务草稿列表。
   * @returns 新建（含复活）的任务快照与跳过的任务 id。
   */
  decomposeTasks(drafts: TaskDraft[]): { created: TaskSnapshot[]; skipped: string[] } {
    // 先整体校验需求存在，避免重建到一半才发现需求缺失（不半写）。
    for (const d of drafts) {
      if (!this.state.requirements[d.requirementId]) throw new BoardError(`未知需求：${d.requirementId}`)
    }
    const created: TaskSnapshot[] = []
    const skipped: string[] = []
    const seen = new Set<string>()
    for (const d of drafts) {
      if (seen.has(d.taskId)) throw new BoardError(`草稿内任务重复：${d.taskId}`)
      seen.add(d.taskId)
      const existing = this.state.tasks[d.taskId]
      if (existing && existing.state !== 'deleted') {
        skipped.push(d.taskId)
        continue
      }
      if (existing) {
        // 已取消的历史任务不占位：移除旧记录，随后按新草稿重建。
        delete this.state.tasks[d.taskId]
      }
      created.push(this.addTask(d))
    }
    return { created, skipped }
  }

  /**
   * 删除**已取消**任务（问题 8，本地看板清理）。
   *
   * 整批门禁：任一 id 不存在或不是 `deleted` 状态即整批拒绝（不做部分删除）。
   * 级联：清理其他任务 `blockedBy` 中对被删任务的悬挂引用
   * （否则依赖一个已删除任务的在办任务会永久卡在"依赖未就绪"）。
   * 任务自带的 artifactPaths 随记录一并消失；不调用 TFS 物理销毁（TFS 2018 REST 不支持）。
   *
   * @param taskIds - 待删除任务 id（可跨需求、可批量）。
   * @returns 实际删除的任务 id（去重后）。
   */
  deleteTasks(taskIds: string[]): string[] {
    const ids = [...new Set(taskIds)]
    if (ids.length === 0) throw new BoardError('未选择任何任务')
    const missing: string[] = []
    const notCancelled: string[] = []
    for (const id of ids) {
      const t = this.state.tasks[id]
      if (!t) missing.push(id)
      else if (t.state !== 'deleted') notCancelled.push(id)
    }
    if (missing.length > 0) throw new BoardError(`任务不存在，无法删除：${missing.join('、')}`)
    if (notCancelled.length > 0) {
      throw new BoardError(`仅「已取消」任务可删除，请先取消以下任务：${notCancelled.join('、')}`)
    }
    const idSet = new Set(ids)
    for (const id of ids) delete this.state.tasks[id]
    for (const t of Object.values(this.state.tasks)) {
      if (t.blockedBy.some(x => idSet.has(x))) {
        t.blockedBy = t.blockedBy.filter(x => !idSet.has(x))
      }
    }
    this.touch()
    return ids
  }

  /**
   * 把已领取需求**还原到需求池**（问题 7）：从本地看板移除该需求。
   *
   * 门禁（两道，顺序即优先级）：
   *   1. **已完成的需求必须先「取消完成」**（问题 5）—— 完成状态是用户对"这条需求收口了"的
   *      显式确认，撤销它必须同样显式，否则"还原"会顺手抹掉一次已完成的交付记录；
   *   2. 该需求下仍有任何**非已取消**任务时拒绝（在办/已完成任务不能随还原丢弃）。
   *
   * 其名下已取消任务随需求一并清理，并级联清理其他任务 `blockedBy` 的悬挂引用。
   * TFS 工作项不删除；`dsh` 标签由宿主 best-effort 移除，失败不阻断（见 board-service）。
   *
   * @param key - 需求去重键 `id@collection`。
   * @returns 一并清理的已取消任务 id。
   */
  restoreRequirement(key: string): string[] {
    const req = this.state.requirements[key]
    if (!req) throw new BoardError(`需求不在本地池：${key}`)
    if (req.execState === 'completed') {
      throw new BoardError(`需求已完成，请先点「取消完成」再还原到需求池（${key}）`)
    }
    const owned = Object.values(this.state.tasks).filter(t => t.requirementId === key)
    const active = owned.filter(t => t.state !== 'deleted')
    if (active.length > 0) {
      throw new BoardError(`请先取消该需求的全部任务后再还原（仍有 ${active.length} 个未取消任务）`)
    }
    const idSet = new Set(owned.map(t => t.taskId))
    for (const id of idSet) delete this.state.tasks[id]
    for (const t of Object.values(this.state.tasks)) {
      if (t.blockedBy.some(x => idSet.has(x))) {
        t.blockedBy = t.blockedBy.filter(x => !idSet.has(x))
      }
    }
    delete this.state.requirements[key]
    this.touch()
    return [...idSet]
  }

  // ───────────────── 需求级执行状态（问题 3/4/5） ─────────────────

  /**
   * 读需求级执行状态。
   *
   * 缺省（键不存在 / 历史 `board.json`）一律按 `'active'` 处理：老数据没有该字段，
   * 若把"未知"当成已完成，用户升级后全部需求会一次性消失到「已完成」页。
   *
   * @param key - 需求去重键 `id@collection`。
   */
  requirementExecState(key: string): RequirementExecState {
    return this.state.requirements[key]?.execState === 'completed' ? 'completed' : 'active'
  }

  /** 某需求名下的全部任务（含已取消）。 */
  tasksOfRequirement(key: string): TaskSnapshot[] {
    return Object.values(this.state.tasks).filter(t => t.requirementId === key)
  }

  /**
   * 该需求是否"全部任务均已收口"（问题 3 的自动完成判据）。
   *
   * 判据（三条同时成立）：
   *   1. 至少有一个任务（未拆解的需求永不自动完成 —— 那不叫完成，叫没开始）；
   *   2. 名下任务全部处于终态（`completed` 或 `deleted`）—— 有 in_progress/pending 就不算；
   *   3. 至少有一个是 `completed`（全部被取消不算完成，避免"整条需求被放弃"被记成交付完成）。
   *
   * @param key - 需求去重键。
   */
  isRequirementAllTasksDone(key: string): boolean {
    const owned = this.tasksOfRequirement(key)
    if (owned.length === 0) return false
    if (!owned.every(t => t.state === 'completed' || t.state === 'deleted')) return false
    return owned.some(t => t.state === 'completed')
  }

  /**
   * 全部任务完成后自动把需求置为已完成（问题 3）。
   *
   * ## 只对"未被显式判定过"的需求生效（`execState === undefined`）
   *
   * 用户点过「取消完成」后，需求会被**显式**写成 `execState='active'`（见
   * {@link setRequirementExecState}）。这是"我知道它任务都做完了，但我还要继续处理它"的声明，
   * 必须被尊重 —— 否则用户取消完成后任何一个任务状态变更（甚至下次插件加载的对账）
   * 都会把它又标回已完成，表现为"取消完成不生效/按钮点了没用"。
   *
   * 抑制的解除方式只有一个：**重新开工**（拆解出新任务 / 手工派发建任务）时会调用
   * {@link resetRequirementCompletion} 把键删回 `undefined`，此后自动完成重新生效。
   *
   * @param key - 需求去重键。
   * @param nowInput - 当前时间（测试可注入）。
   * @returns 是否发生了状态变更（未变更时调用方不必落盘）。
   */
  markRequirementCompletedIfAllDone(key: string, nowInput: Date = new Date()): boolean {
    const req = this.state.requirements[key]
    if (!req) return false
    // 已被显式判定过（completed 或 active）⇒ 不自动改写。缺键才是"从未判定"。
    if (req.execState !== undefined) return false
    if (!this.isRequirementAllTasksDone(key)) return false
    req.execState = 'completed'
    req.completedAt = nowInput.toISOString()
    this.touch()
    return true
  }

  /**
   * 清除需求级完成判定，回到"未判定"态（**重新开工**语义）。
   *
   * 与 {@link setRequirementExecState}(key, 'active') 的区别是这个更彻底：显式 active 表示
   * "人认为它还没完"（抑制自动完成），而删除键表示"这项工作重新开始，做完后该怎么判就怎么判"。
   *
   * 调用场景：拆解出新任务、为需求新手工派发任务 —— 两者都意味着需求重新进入生产。
   *
   * @param key - 需求去重键。
   * @returns 是否发生了变更。
   */
  resetRequirementCompletion(key: string): boolean {
    const req = this.state.requirements[key]
    if (!req) return false
    if (req.execState === undefined && req.completedAt === undefined) return false
    delete req.execState
    delete req.completedAt
    this.touch()
    return true
  }

  /**
   * 需求完成对账（问题 3）：把"任务其实已全部收口、但 `execState` 仍缺键"的需求**补齐**为已完成。
   *
   * ## 为什么必须有它（只靠状态变更触发是不够的）
   *
   * {@link markRequirementCompletedIfAllDone} 只在**状态变更的瞬间**被调用（任务收口 / 删除）。
   * 于是存在一类永远补不上的数据：**升级前就已经把任务全部做完的需求** —— 那时插件还没有"需求级
   * 执行状态"这个概念，没有任何触发点会去判定它。
   *
   * 2026-09-21 实机取证（`board.json`）：需求 `1997179@WN_HIS` 名下 3 个任务全部
   * `state=completed / execState=success`，但需求记录里 **没有 `execState` 键**，
   * 因此一直留在「任务中心」不迁入「已完成」页 —— 这正是用户反馈的现象。本方法在
   * **插件加载时**（`BoardService.reconcile()`）跑一遍，把这类历史数据一次性补齐。
   *
   * 方向是**单向**的：只补 `未判定 → completed`；显式 `active`（用户点过取消完成）与
   * 已 `completed` 的一律不动。
   *
   * @param nowInput - 当前时间（测试可注入）。
   * @returns 本次被补齐为已完成的需求键（无变更时为空数组，调用方据此跳过落盘）。
   */
  reconcileRequirementCompletion(nowInput: Date = new Date()): string[] {
    const migrated: string[] = []
    for (const key of Object.keys(this.state.requirements)) {
      if (this.markRequirementCompletedIfAllDone(key, nowInput)) migrated.push(key)
    }
    return migrated
  }

  /**
   * 显式设置需求执行状态（问题 5：「取消完成」；以及手动确认完成）。
   *
   * 与 {@link markRequirementCompletedIfAllDone} 的分工：本方法是**人**的显式动作，
   * 不做"任务是否都完成"的守卫（确认完成是人的判断）；自动迁移则由引擎按任务状态推导。
   * 状态未变化时**不 bump revision**（避免制造无意义的版本，干扰并发检测）。
   *
   * @param key - 需求去重键。
   * @param state - 目标执行状态。
   * @param nowInput - 当前时间（测试可注入）。
   * @returns 更新后的需求（未变化时返回原对象）。
   */
  setRequirementExecState(
    key: string,
    state: RequirementExecState,
    nowInput: Date = new Date(),
  ): Requirement {
    const req = this.state.requirements[key]
    if (!req) throw new BoardError(`需求不在本地池：${key}`)
    /**
     * "是否变化"看**原始键**而不是归一后的状态：缺键与显式 `'active'` 都读作 active，
     * 但两者语义不同（缺键 = 未判定、可被自动完成；显式 active = 人声明还没完、抑制自动完成），
     * 所以"缺键 → 显式 active"是一次必须落盘的真实变更。
     */
    if (req.execState === state) return req
    if (state === 'completed') {
      req.execState = 'completed'
      req.completedAt = nowInput.toISOString()
    } else {
      /**
       * 「取消完成」：**显式**写 `'active'`，而不是删键。
       *
       * 为什么不能删键：删键等于回到"从未判定"，于是下一次任务收口（或插件加载时的需求完成对账）
       * 又会按"任务全完成"把它自动标回已完成 —— 用户会以为"取消完成"没生效。
       * 显式 active 是一份**声明**（这条需求还要继续处理），必须持久化以对抗自动判定；
       * 要解除它只有一条路：重新开工（`resetRequirementCompletion`）。
       */
      req.execState = 'active'
      delete req.completedAt
    }
    this.touch()
    return req
  }

  /**
   * 状态转换（经状态机校验 + revision 乐观锁）。
   * @param taskId - 任务 ID。
   * @param to - 目标态。
   * @param expectedRevision - 期望当前 revision（乐观锁；不匹配则抛错）。
   */
  transition(taskId: string, to: TaskState, expectedRevision: number): TaskSnapshot {
    const task = this.state.tasks[taskId]
    if (!task) throw new BoardError(`未知任务：${taskId}`)
    if (task.revision !== expectedRevision) {
      throw new BoardError(`revision 冲突：${taskId} 期望 ${expectedRevision} 实得 ${task.revision}`)
    }
    if (!canTransition(task.state, to)) {
      throw new BoardError(`非法转换：${task.state} → ${to}`)
    }
    task.state = to
    task.revision = bumpRevision(task.revision)
    this.state.updatedAt = new Date().toISOString()
    this.state.version = bumpRevision(this.state.version)
    return task
  }

  /**
   * 依赖是否已就绪：blockedBy 中任务全部 completed。
   * @param taskId - 任务 ID。
   * @returns 就绪返回 true。
   */
  isReady(taskId: string): boolean {
    const task = this.state.tasks[taskId]
    if (!task) return false
    return task.blockedBy.every(dep => this.state.tasks[dep]?.state === 'completed')
  }

  /**
   * FIFO 并发排队：在 pending 且依赖就绪的任务中，按 taskId 字典序（入队顺序代理）选取
   * 最多 `limit` 个，返回其 ID。已超限（在跑数 ≥ limit）则不再放行权。
   *
   * 「占槽」只认 `execState === 'running'`：`failed` 与 `needs_confirmation` 的任务
   * 四态上仍是 `in_progress`，但它们早已把 `RequirementDispatcher` 的并发槽还回去了
   * （见 dispatch 的槽位归还），照旧计入会让三个失败/待确认任务吃满
   * `maxConcurrentRequirements` 预算，`autoStartRunnable` 恒返回空、自动链式执行**全局停摆**，
   * 而分发器那边其实三个槽都空着。
   *
   * @param limit - 同时执行上限（FR-029，默认 3）。
   * @returns 本批可启动的任务 ID 列表。
   */
  pickRunnable(limit: number): string[] {
    const running = Object.values(this.state.tasks).filter(t => t.execState === 'running').length
    if (running >= limit) return []
    const slots = limit - running
    if (slots <= 0) return []
    return Object.values(this.state.tasks)
      .filter(t => t.state === 'pending' && this.isReady(t.taskId))
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .slice(0, slots)
      .map(t => t.taskId)
  }

  /** 取任务并校验乐观锁（US3/T043 的全部写路径共用）。 */
  private requireTask(taskId: string, expectedRevision: number): TaskSnapshot {
    const task = this.state.tasks[taskId]
    if (!task) throw new BoardError(`未知任务：${taskId}`)
    if (task.revision !== expectedRevision) {
      throw new BoardError(`revision 冲突：${taskId} 期望 ${expectedRevision} 实得 ${task.revision}（请刷新后重试，禁自动覆盖 S-11）`)
    }
    return task
  }

  /** 标记快照已变更。 */
  private touch(): void {
    this.state.updatedAt = new Date().toISOString()
    this.state.version = bumpRevision(this.state.version)
  }

  /**
   * 启动或重试一次尝试（T043/S-07）：进入 `in_progress`，execState=running，追加一条尝试记录。
   *
   * 允许的进入条件：`pending`（首次启动）或 `in_progress` 且 execState ∈ {queued, failed, cancelled}
   * （断点重试——从失败子任务续跑，已完成任务不被重置）。**execState=running 已在跑的任务拒绝再启动**：
   * 否则会再追加一条打开的尝试并让宿主二次派发，两个子代理同时改同一个代码库。
   *
   * @param taskId - 任务 ID。
   * @param expectedRevision - 期望 revision（乐观锁）。
   * @param opts - 可选启动项。`autoLaunched=true` 标记本任务由宿主自动链式执行派发（问题 6）；
   *   手动启动（缺省/false）清除该标记。
   * @returns 更新后的任务快照。
   */
  startTask(
    taskId: string,
    expectedRevision: number,
    opts?: { autoLaunched?: boolean },
  ): TaskSnapshot {
    const task = this.requireTask(taskId, expectedRevision)
    if (task.state === 'completed') throw new BoardError(`${taskId} 已完成，无需重跑（如需重做请先取消再新建）`)
    if (task.state === 'deleted') throw new BoardError(`${taskId} 已删除（终态），不可启动`)
    if (task.state === 'in_progress' && task.execState === 'running') {
      throw new BoardError(`${taskId} 正在执行中（execState=running），不可重复启动（如需终止请先取消）`)
    }
    if (task.state === 'pending') {
      if (!this.isReady(taskId)) {
        throw new BoardError(`${taskId} 依赖未就绪：${task.blockedBy.join(', ')}`)
      }
      task.state = 'in_progress'
    }
    task.execState = 'running'
    task.attempts.push({ startedAt: new Date().toISOString(), outcome: 'running' })
    if (opts?.autoLaunched === true) task.autoLaunched = true
    else delete task.autoLaunched
    task.revision = bumpRevision(task.revision)
    this.touch()
    return task
  }

  /**
   * 结束一次尝试（T043；问题 5 新增 `needs_confirmation`）。
   * - `success` → 看板态转 `completed`，execState=success；
   * - `failed` → 保留 `in_progress`（可重试 S-07），execState=failed；
   * - `cancelled` → 看板态转 `deleted`，execState=cancelled（FR-014：取消保留本地条目）；
   * - `needs_confirmation`（问题 5）→ **看板态保留 `in_progress`**、execState=needs_confirmation：
   *   子智能体在结论中请求人工确认，这不是成功——下游依赖不就绪、不自动链式执行、不触发需求
   *   完成回写；必须经 {@link confirmTask}（人工确认通过 → completed）或追问重跑后才能继续。
   *
   * @param taskId - 任务 ID。
   * @param outcome - 结果。
   * @param expectedRevision - 期望 revision。
   * @param note - 备注（失败原因 / 待人工确认原因等）。
   * @param meta - 本次尝试的执行元数据（spec 006：runId/stopReason/diagnostic/output），落进闭合的 attempt。
   */
  finishTask(
    taskId: string,
    outcome: 'success' | 'failed' | 'cancelled' | 'needs_confirmation',
    expectedRevision: number,
    note?: string,
    meta?: AttemptMeta,
  ): TaskSnapshot {
    const task = this.requireTask(taskId, expectedRevision)
    if (outcome === 'failed' || outcome === 'needs_confirmation') {
      if (task.state !== 'in_progress') {
        throw new BoardError(`非法转换：${task.state} → ${outcome}（仅 in_progress 可如此收口）`)
      }
    } else if (!canTransition(task.state, outcome === 'success' ? 'completed' : 'deleted')) {
      throw new BoardError(`非法转换：${task.state} → ${outcome}`)
    }
    const endedAt = new Date().toISOString()
    const outcomeValue: ExecState =
      outcome === 'success'
        ? 'success'
        : outcome === 'failed'
          ? 'failed'
          : outcome === 'needs_confirmation'
            ? 'needs_confirmation'
            : 'cancelled'
    // 关闭最后一条未结束的尝试记录；没有未结束记录则补一条（崩溃恢复后 finish 也要可落账）。
    const open = [...task.attempts].reverse().find(a => a.endedAt === undefined)
    if (open) {
      open.endedAt = endedAt
      open.outcome = outcomeValue
      if (note !== undefined) open.note = note
      applyAttemptMeta(open, meta)
    } else if (
      (outcome === 'failed' && task.execState === 'failed') ||
      (outcome === 'needs_confirmation' && task.execState === 'needs_confirmation')
    ) {
      // 幂等：任务已按该结果收口、又没有运行中的尝试时，重复收口是 no-op，
      // 不补造 startedAt=endedAt 的幽灵 attempt（曾污染审计轨迹）。
      return task
    } else {
      task.attempts.push({
        startedAt: endedAt,
        endedAt,
        outcome: outcomeValue,
        ...(note !== undefined ? { note } : {}),
        ...attemptMetaFields(meta),
      })
    }
    if (outcome === 'success') task.state = 'completed'
    if (outcome === 'cancelled') task.state = 'deleted'
    // needs_confirmation：看板态刻意保持 in_progress（不迁入 completed），只更新执行链路态。
    task.execState = outcomeValue
    // 问题 4：把本次收口解析出的关键产物合并到任务级清单（去重保序），供需求完成回写上传附件。
    if (Array.isArray(meta?.artifactPaths) && meta.artifactPaths.length > 0) {
      const existing = new Set(task.artifactPaths)
      for (const p of meta.artifactPaths) {
        const clean = typeof p === 'string' ? p.trim() : ''
        if (clean && !existing.has(clean)) {
          existing.add(clean)
          task.artifactPaths.push(clean)
        }
      }
    }
    task.revision = bumpRevision(task.revision)
    this.touch()
    return task
  }

  /**
   * 人工确认通过一条「待人工确认」任务（问题 5）。
   *
   * 前置：任务看板态 `in_progress` 且 execState=`needs_confirmation`（由 {@link finishTask}
   * 在子智能体请求人工确认时落定）。确认后看板态转 `completed`、execState=success，
   * 此后下游依赖才就绪、宿主才会自动链式执行下一个任务、需求才可能触发完成回写。
   *
   * 轨迹保留：最后一条 `needs_confirmation` attempt **不改写**（它记录了"曾请求人工确认及原因"），
   * 另补一条即时收口的 `success` attempt（note 记"人工确认通过"），使审计链完整可辨。
   *
   * @param taskId - 任务 ID。
   * @param expectedRevision - 期望 revision（乐观锁）。
   * @param note - 可选确认备注（缺省"人工确认通过"）。
   */
  confirmTask(taskId: string, expectedRevision: number, note?: string): TaskSnapshot {
    const task = this.requireTask(taskId, expectedRevision)
    if (task.state === 'deleted') throw new BoardError(`${taskId} 已删除（终态），不可确认`)
    if (task.execState !== 'needs_confirmation' || task.state !== 'in_progress') {
      throw new BoardError(`${taskId} 当前不处于「待人工确认」状态（execState=${task.execState}），不可确认通过`)
    }
    const endedAt = new Date().toISOString()
    task.attempts.push({
      startedAt: endedAt,
      endedAt,
      outcome: 'success',
      note: note?.trim() ? note.trim() : '人工确认通过',
    })
    task.state = 'completed'
    task.execState = 'success'
    task.revision = bumpRevision(task.revision)
    this.touch()
    return task
  }

  /**
   * 把派发返回的子会话 id（runId）绑定到当前未闭合的尝试（spec 006 US2）。
   *
   * 派发是异步的：`dispatcher.dispatch` 一返回 runId 就立即落账，使任务**运行中**也能按 runId
   * 冷读执行轨迹，而不必等落定。没有未闭合 attempt 时原样返回（竞态下可能已被收口）。
   *
   * @param taskId - 任务 ID。
   * @param runId - 子 agent 会话 id（SubagentRun.id）。
   * @param provider - 可选 provider 名（诊断用）。
   */
  attachRunId(taskId: string, runId: string, provider?: string, turn?: number): TaskSnapshot {
    const task = this.state.tasks[taskId]
    if (!task) throw new BoardError(`未知任务：${taskId}`)
    const open = [...task.attempts].reverse().find(a => a.endedAt === undefined)
    if (open) {
      open.runId = runId
      if (provider) open.provider = provider
      // D6：复用子会话时记录本尝试对应的 turn，轨迹读取据此隔离。
      if (typeof turn === 'number' && Number.isFinite(turn) && turn > 0) open.turn = Math.trunc(turn)
      task.revision = bumpRevision(task.revision)
      this.touch()
    }
    return task
  }

  /**
   * 对任务发起「追问 / 补充指令」的新一轮执行（spec 006 US3）。
   *
   * 与 `startTask` 的区别：它面向**已经跑过**的任务（failed 待续跑，或 completed 要追加一轮），
   * 且**保留全部历史 attempts**。对 `completed` 任务，这里是一次**显式重开**（不走通用
   * `canTransition`——那张表刻意只允许 completed→deleted；追问是独立、由用户显式触发的动作），
   * 重开后看板态回到 `in_progress`、execState=running，并追加一条新的 running attempt。
   *
   * @param taskId - 任务 ID。
   * @returns 更新后的快照与新一轮 attempt 的下标。
   */
  followUpTask(taskId: string): { task: TaskSnapshot; attemptIndex: number } {
    const task = this.state.tasks[taskId]
    if (!task) throw new BoardError(`未知任务：${taskId}`)
    if (task.state === 'deleted') throw new BoardError(`${taskId} 已删除（终态），不可追问`)
    if (task.state === 'pending') throw new BoardError(`${taskId} 尚未执行过，无可追问的执行；请直接派发`)
    // completed → 显式重开；failed（仍 in_progress）直接续跑。
    task.state = 'in_progress'
    task.execState = 'running'
    task.attempts.push({ startedAt: new Date().toISOString(), outcome: 'running' })
    const attemptIndex = task.attempts.length - 1
    task.revision = bumpRevision(task.revision)
    this.touch()
    return { task, attemptIndex }
  }

  /**
   * 指派/改派任务角色（T042）。
   * @param taskId - 任务 ID。
   * @param roleAgent - 角色展示名。
   * @param expectedRevision - 期望 revision。
   */
  assignTask(taskId: string, roleAgent: string, expectedRevision: number): TaskSnapshot {
    const task = this.requireTask(taskId, expectedRevision)
    if (roleAgent.trim().length === 0) throw new BoardError('角色名不能为空')
    task.roleAgent = roleAgent
    task.revision = bumpRevision(task.revision)
    this.touch()
    return task
  }

  /**
   * 编辑任务的本地字段（问题 3/4：提示词 / 模型 / 供应商 / 技能 / MCP / 工作目录 / 预设 / 执行预算）。
   *
   * ## 为什么需要它
   *
   * 拆解产出的任务在派发前几乎总要被人工调一下：五段式任务的提示词不同、测试任务不需要
   * 开发任务那套 MCP、某任务要换更便宜的模型、或换一个 agent 预设。此前 `Board` 只有
   * `assignTask`（改角色名），其余字段一旦落库就只能"取消后重新拆解"，而重新拆解又会丢掉
   * 同需求下其他任务的运行成果。
   *
   * ## 语义
   *
   * - `deleted` 是终态：不可编辑；
   * - **正在执行（execState='running'）的任务不可编辑**（问题 3：用户要编辑的是"未执行任务"；
   *   运行中改冻结配置会造成"子智能体实际所用配置"与"看板记录"不一致，且 attempt 已开账）；
   *   待执行（pending/queued）、失败待重试、待人工确认、已完成的任务均允许编辑；
   * - `completed` **允许**编辑：用户可能需要改提示词后重跑（本方法只改字段，不隐式改状态）；
   * - 传 `null` 表示**清空**该字段；不传表示不动。两者语义必须区分（否则无法删除已填的提示词）；
   * - 无实际变化时**不 bump revision**（避免制造无意义的乐观锁版本，干扰并发检测）。
   *
   * @param taskId - 任务 ID。
   * @param patch - 字段补丁。
   * @param expectedRevision - 期望 revision（乐观锁）。
   * @returns 更新后的任务快照。
   */
  updateTask(
    taskId: string,
    patch: {
      prompt?: string | null
      workspace?: string | null
      frozenConfig?: TaskSnapshot['frozenConfig']
    },
    expectedRevision: number,
  ): TaskSnapshot {
    const task = this.requireTask(taskId, expectedRevision)
    if (task.state === 'deleted') throw new BoardError(`${taskId} 已取消（终态），不可编辑`)
    if (task.execState === 'running') {
      throw new BoardError(`${taskId} 正在执行中，不可编辑（请等待执行结束或先取消）`)
    }

    let changed = false
    if ('prompt' in patch) {
      const next = patch.prompt === null ? undefined : (patch.prompt ?? '').trim()
      const apply = next && next.length > 0 ? next : undefined
      if (task.prompt !== apply) {
        if (apply === undefined) delete task.prompt
        else task.prompt = apply
        changed = true
      }
    }
    if ('workspace' in patch) {
      const next = patch.workspace === null ? undefined : (patch.workspace ?? '').trim()
      const apply = next && next.length > 0 ? next : undefined
      if (task.workspace !== apply) {
        if (apply === undefined) delete task.workspace
        else task.workspace = apply
        changed = true
      }
    }
    if (patch.frozenConfig !== undefined) {
      const fc = patch.frozenConfig
      for (const [key, value] of [['mcp', fc.mcp], ['skills', fc.skills]] as const) {
        if (!Array.isArray(value) || value.some(v => typeof v !== 'string')) {
          throw new BoardError(`frozenConfig.${key} 必须是字符串数组`)
        }
      }
      if (typeof fc.model !== 'string') throw new BoardError('frozenConfig.model 必须是字符串')
      if (fc.modelProvider !== undefined && typeof fc.modelProvider !== 'string') {
        throw new BoardError('frozenConfig.modelProvider 必须是字符串')
      }
      if (fc.preset !== undefined && typeof fc.preset !== 'string') {
        throw new BoardError('frozenConfig.preset 必须是字符串')
      }
      for (const budgetKey of ['maxDepth', 'maxTokens'] as const) {
        const v = fc[budgetKey]
        if (v !== undefined && (typeof v !== 'number' || !Number.isFinite(v) || v < 0)) {
          throw new BoardError(`frozenConfig.${budgetKey} 必须是非负有限数`)
        }
      }
      // spec 009：provider 与 model 成对；trim 后为空串一律不写键（保持旧 JSON 形状）。
      const nextProvider = typeof fc.modelProvider === 'string' ? fc.modelProvider.trim() : ''
      // 问题 3：preset trim 空串不写键；maxDepth/maxTokens 为 0/缺省表示"沿用默认/不限制"，不写键。
      const nextPreset = typeof fc.preset === 'string' ? fc.preset.trim() : ''
      const nextMaxDepth = typeof fc.maxDepth === 'number' && fc.maxDepth > 0 ? Math.floor(fc.maxDepth) : 0
      const nextMaxTokens = typeof fc.maxTokens === 'number' && fc.maxTokens > 0 ? Math.floor(fc.maxTokens) : 0
      const same =
        task.frozenConfig.model === fc.model &&
        (task.frozenConfig.modelProvider ?? '') === nextProvider &&
        (task.frozenConfig.preset ?? '') === nextPreset &&
        (task.frozenConfig.maxDepth ?? 0) === nextMaxDepth &&
        (task.frozenConfig.maxTokens ?? 0) === nextMaxTokens &&
        task.frozenConfig.mcp.join('\u0000') === fc.mcp.join('\u0000') &&
        task.frozenConfig.skills.join('\u0000') === fc.skills.join('\u0000')
      if (!same) {
        task.frozenConfig = {
          mcp: [...fc.mcp],
          skills: [...fc.skills],
          model: fc.model,
          ...(nextProvider ? { modelProvider: nextProvider } : {}),
          ...(nextPreset ? { preset: nextPreset } : {}),
          ...(nextMaxDepth > 0 ? { maxDepth: nextMaxDepth } : {}),
          ...(nextMaxTokens > 0 ? { maxTokens: nextMaxTokens } : {}),
        }
        changed = true
      }
    }
    if (!changed) return task
    task.revision = bumpRevision(task.revision)
    this.touch()
    return task
  }

  /**
   * 运行期假执行看门狗：收口"被置为 running 但从未绑定 runId、且开启超过 `staleMs`"的尝试。
   *
   * 这是"任务永远执行中 + 零 token"假执行的唯一状态形态，来源有二：
   *  1. 只翻了看板状态（task-state 的 start/retry 是纯状态动作，不启动子 agent）却没有随后派发；
   *  2. 已派发但启动悬挂（`client.start` 迟迟不返回 run，且未被启动超时收口）。
   *
   * 与 {@link reconcileDangling} 的分工：后者只在插件加载（重启）时跑，把所有 running 一律
   * 视为悬空；本方法用于运行期定时巡检，**只收口无 runId 且超时者**——已绑定真实 run 的
   * running 任务可能正在正常执行（含长任务），绝不能误杀。
   *
   * @param staleMs - 无 runId 的 running attempt 开启多久后判定为假执行。
   * @param nowInput - 当前时间（测试可注入）。
   * @returns 被收口的任务 id 与 attempt 下标。
   */
  reconcileUnboundRunning(
    staleMs: number,
    nowInput: Date = new Date(),
  ): Array<{ taskId: string; attemptIndex: number }> {
    const now = nowInput.getTime()
    const reaped: Array<{ taskId: string; attemptIndex: number }> = []
    for (const task of Object.values(this.state.tasks)) {
      if (task.execState !== 'running') continue
      let openIndex = -1
      for (let i = task.attempts.length - 1; i >= 0; i--) {
        if (task.attempts[i]!.endedAt === undefined) {
          openIndex = i
          break
        }
      }
      if (openIndex < 0) continue
      const open = task.attempts[openIndex]!
      // 已绑定真实子 run 的不在此处理（交给句柄存活判断 / 重启对账）。
      if (open.runId) continue
      const startedAtMs = Date.parse(open.startedAt)
      if (!Number.isFinite(startedAtMs) || now - startedAtMs < staleMs) continue
      open.endedAt = new Date(now).toISOString()
      open.outcome = 'failed'
      open.note =
        '运行期看门狗：任务被置为运行中但未绑定执行 run（只翻状态未派发，或派发启动悬挂），已自动标失败；可点「重新派发」'
      task.execState = 'failed'
      task.revision = bumpRevision(task.revision)
      reaped.push({ taskId: task.taskId, attemptIndex: openIndex })
    }
    if (reaped.length > 0) this.touch()
    return reaped
  }

  /**
   * 运行期强制收口一条 running 任务（看门狗发现"已绑 runId 但执行句柄丢失"时使用）。
   *
   * @param taskId - 任务 ID。
   * @param note - 写入闭合 attempt 的收口说明。
   * @param nowInput - 当前时间（测试可注入）。
   * @returns 是否实际收口（任务不存在或非 running 返回 false）。
   */
  forceFailRunning(taskId: string, note: string, nowInput: Date = new Date()): boolean {
    const task = this.state.tasks[taskId]
    if (!task || task.execState !== 'running') return false
    const endedAt = nowInput.toISOString()
    const open = [...task.attempts].reverse().find(a => a.endedAt === undefined)
    if (open) {
      open.endedAt = endedAt
      open.outcome = 'failed'
      open.note = note
    } else {
      task.attempts.push({ startedAt: endedAt, endedAt, outcome: 'failed', note })
    }
    task.execState = 'failed'
    task.revision = bumpRevision(task.revision)
    this.touch()
    return true
  }

  /**
   * 崩溃对账（T060/S-10）：把"进程重启后仍处于 running 但实际已无运行句柄"的悬空任务
   * 标为 failed，返回其 ID 供 UI 提示「待人工核对」。**不**自动重跑（避免重复副作用）。
   *
   * @returns 悬空任务 ID 列表。
   */
  reconcileDangling(): string[] {
    const dangling: string[] = []
    for (const task of Object.values(this.state.tasks)) {
      if (task.execState !== 'running') continue
      dangling.push(task.taskId)
      const open = [...task.attempts].reverse().find(a => a.endedAt === undefined)
      const endedAt = new Date().toISOString()
      if (open) {
        open.endedAt = endedAt
        open.outcome = 'failed'
        open.note = '崩溃恢复：运行态悬空，已标失败（S-10 待人工核对）'
      } else {
        task.attempts.push({
          startedAt: endedAt,
          endedAt,
          outcome: 'failed',
          note: '崩溃恢复：运行态悬空，已标失败（S-10 待人工核对）',
        })
      }
      task.execState = 'failed'
      task.revision = bumpRevision(task.revision)
    }
    if (dangling.length > 0) this.touch()
    return dangling
  }

  /**
   * 跳过已完成子任务、收集可续跑的任务（S-07 断点重试）。
   *
   * @param requirementId - 需求 dedupKey。
   * @returns 该需求下 `pending`（或 `in_progress` 且 execState=failed/cancelled）的任务 ID。
   */
  resumableForRequirement(requirementId: string): string[] {
    return Object.values(this.state.tasks)
      .filter(t => t.requirementId === requirementId)
      .filter(t => t.state === 'pending' || (t.state === 'in_progress' && (t.execState === 'failed' || t.execState === 'cancelled')))
      .filter(t => this.isReady(t.taskId))
      .sort((a, b) => a.taskId.localeCompare(b.taskId))
      .map(t => t.taskId)
  }

  /** 更新看板渲染的 Markdown 路径（落盘记录，T061）。 */
  setMarkdownViewPath(path: string): void {
    this.state.markdownViewPath = path
    this.touch()
  }

  // ───────────── spec 010：需求级编排上下文（编排主 agent + 共享简报） ─────────────

  /**
   * 读取需求的编排上下文（不存在返回 undefined = 未启用编排）。
   *
   * @param key - 需求去重键。
   */
  orchestrationOf(key: string): RequirementOrchestration | undefined {
    return this.state.requirements[key]?.orchestration
  }

  /**
   * 写入/合并需求的编排上下文（整体替换，调用方负责合并语义）。
   *
   * 为什么是整体替换而不是深合并：`orchestration` 是插件自己写入的**单一对象**，
   * 半合并会让"清除某个字段"（如降级时清 `orchestratorSessionId`）无法表达。
   *
   * @param key - 需求去重键。
   * @param next - 新的编排上下文。
   * @throws 需求未领取。
   */
  setOrchestration(key: string, next: RequirementOrchestration): void {
    const req = this.state.requirements[key]
    if (!req) throw new BoardError(`未知需求：${key}`)
    req.orchestration = next
    this.touch()
  }

  /**
   * 记录/更新任务的编排上下文（会话 id、是否复用、归纳结论）。
   *
   * 按字段覆盖；`undefined` 表示"不改动"，`null` 语义由调用方在上一层表达
   * （这里不引入 null，避免 JSON 里出现 null 键）。
   *
   * @param taskId - 任务 id。
   * @param patch - 要写入的字段。
   */
  setTaskOrchestration(taskId: string, patch: TaskOrchestration): TaskSnapshot {
    const task = this.state.tasks[taskId]
    if (!task) throw new BoardError(`未知任务：${taskId}`)
    task.orchestration = { ...(task.orchestration ?? {}), ...patch }
    task.revision = bumpRevision(task.revision)
    this.touch()
    return task
  }

  /**
   * 取某复用键对应的持久子会话 id（AC3.3）。
   *
   * @param key - 需求去重键。
   * @param reuseKey - 复用键（`需求键|provider|preset`）。
   */
  getTaskSession(key: string, reuseKey: string): string | undefined {
    return this.state.requirements[key]?.orchestration?.taskSessions?.[reuseKey]
  }

  /**
   * 登记复用键 → 持久子会话 id（AC3.3）。
   *
   * @param key - 需求去重键。
   * @param reuseKey - 复用键。
   * @param sessionId - 持久子会话 id。
   * @throws 需求未领取。
   */
  putTaskSession(key: string, reuseKey: string, sessionId: string): void {
    const req = this.state.requirements[key]
    if (!req) throw new BoardError(`未知需求：${key}`)
    const orch: RequirementOrchestration = req.orchestration ?? { mode: 'off' }
    orch.taskSessions = { ...(orch.taskSessions ?? {}), [reuseKey]: sessionId }
    req.orchestration = orch
    this.touch()
  }
}

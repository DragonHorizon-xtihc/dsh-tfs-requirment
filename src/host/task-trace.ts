/**
 * 任务执行轨迹读取服务（spec 006 US2）。
 *
 * 输入 taskId（+可选尝试序号），从看板 attempt 上取 runId（子会话 id），经宿主
 * `sessionQuery.observeSession(runId, { projectionMode: 'none' })` 拿到该子会话的**不可变事件快照**，
 * 再用 {@link mapTraceEvents} 映射成时间线。
 *
 * ## 降级纪律（与 dsh-catalog 一致）
 * sessionQuery 缺失、会话已被清理、runId 缺失（旧记录）等情况**都不抛 500**：返回
 * `available:false` + 可读 `reason`，详情页据此显示"无轨迹"而不是白屏。异常只可能来自真正的
 * 程序错误。
 *
 * 为什么用 observeSession 而不是自己读 jsonl：它对 live（运行中）/ prepared（冷读持久化）两种
 * 来源给统一快照（`packages/session-query/session-query/src/.../observation.ts`），并处理了
 * fork 继承、游标、租约释放；我们只需在用完后 dispose。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/task-trace
 */
import type { Board } from '../core/board/board.js'
import type { TaskTraceEntry, TaskTraceResult } from '../shared/contracts.js'
import { filterEventsForTurn, mapTraceEvents, summarizeTrace } from './trace-mapper.js'

/** observeSession 的最小结构面（避免硬依赖宿主 branded 类型，实际服务满足该形状）。 */
interface SessionQueryLike {
  observeSession(
    sessionId: string,
    options?: { signal?: AbortSignal; projectionMode?: 'all' | 'none' },
  ): Promise<ObservationLike>
}

/** SessionObservation 的最小结构面。 */
interface ObservationLike {
  readonly source: 'live' | 'prepared'
  readonly events: readonly unknown[]
  readonly cursor: number
  dispose?(): void
  [Symbol.dispose]?(): void
}

export interface TaskTraceServiceDeps {
  /** 看板引擎（读 task.attempts.runId）。 */
  board: Board
  /** 惰性取宿主 sessionQuery 服务（缺失时返回 undefined/null）。 */
  getSessionQuery?: () => unknown
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** 释放观察租约（两种 Disposable 形态都兼容）。 */
function releaseObservation(obs: ObservationLike | undefined): void {
  if (!obs) return
  try {
    const dispose = obs.dispose
    const symbolDispose = obs[Symbol.dispose]
    if (typeof dispose === 'function') dispose.call(obs)
    else if (typeof symbolDispose === 'function') symbolDispose.call(obs)
  } catch {
    // 释放失败不影响读取结果。
  }
}

export class TaskTraceService {
  constructor(private readonly deps: TaskTraceServiceDeps) {}

  /**
   * 读取某次任务尝试的执行轨迹。
   * @param taskId - 看板任务 id。
   * @param attemptIndex - 尝试序号（从 0 开始）；缺省取最后一次。
   */
  async getTrace(taskId: string, attemptIndex?: number): Promise<TaskTraceResult> {
    const unavailable = (attempt: number, reason: string, runId?: string): TaskTraceResult => ({
      ok: true,
      taskId,
      attempt,
      available: false,
      entries: [],
      ...(runId ? { runId } : {}),
      reason,
    })

    const task = this.deps.board.snapshot.tasks[taskId]
    if (!task) return unavailable(attemptIndex ?? -1, `未知任务：${taskId}`)

    const idx = attemptIndex ?? task.attempts.length - 1
    const attempt = task.attempts[idx]
    if (!attempt) return unavailable(idx, `第 ${idx + 1} 次尝试不存在（该任务共 ${task.attempts.length} 次尝试）`)

    const runId = attempt.runId
    if (!runId) {
      return unavailable(idx, '该次尝试没有关联的子会话记录（可能由旧版本产生，或派发未返回 runId），无执行轨迹')
    }

    const sessionQuery = this.deps.getSessionQuery?.() as SessionQueryLike | undefined
    if (!sessionQuery || typeof sessionQuery.observeSession !== 'function') {
      return unavailable(idx, '宿主未提供 sessionQuery 服务，当前环境无法读取执行过程轨迹', runId)
    }

    let obs: ObservationLike | undefined
    try {
      obs = await sessionQuery.observeSession(runId, { projectionMode: 'none' })
    } catch (error) {
      return unavailable(idx, `子会话轨迹不可读：${reasonOf(error)}（会话日志可能已被清理）`, runId)
    }

    try {
      // D6：复用 continuable 子会话时 attempt.turn 指定本轮；先把事件切到本轮再映射/统计，
      // 否则会把同一子会话其它任务的历史一并算入（轨迹串台、统计虚高）。one-shot 无 turn，用全量。
      const allEvents = obs?.events ?? []
      const rawEvents =
        typeof attempt.turn === 'number' && attempt.turn > 0
          ? filterEventsForTurn(allEvents, attempt.turn)
          : allEvents
      const mapped = mapTraceEvents(rawEvents)
      const entries: TaskTraceEntry[] = mapped.entries
      // 问题 2：聚合统计必须用**完整事件**（时间线可能为防灌爆而截断，统计不截断）。
      const stats = summarizeTrace(rawEvents)
      const result: TaskTraceResult = {
        ok: true,
        taskId,
        attempt: idx,
        runId,
        available: true,
        running: obs.source === 'live',
        source: obs.source,
        entries,
        stats,
        truncated: mapped.truncated,
        total: mapped.total,
        ...(typeof obs.cursor === 'number' ? { cursor: obs.cursor } : {}),
        ...(mapped.cursor !== undefined ? { cursor: mapped.cursor } : {}),
      }
      return result
    } finally {
      releaseObservation(obs)
    }
  }
}

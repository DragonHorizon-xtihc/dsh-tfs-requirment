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
 * @module dsh-tfs-requirment/host/task-trace
 */
import type { Board } from '../core/board/board.js'
import type { TaskTraceEntry, TaskTraceResult } from '../shared/contracts.js'
import type { ChildToolCall } from '../shared/capability-plan.js'
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

/**
 * 读取某子会话的 `tool/call` 事件切片（2026-10-29 诉求 3/4 的**验收**数据源）。
 *
 * ## 为什么需要单独一个入口
 *
 * 任务落定后要回答"所选技能 / MCP 到底用了没有"，唯一可信的证据是子会话日志里的
 * `tool/call`（`packages/session/src/...` 的会话事件类型；本插件 `trace-mapper.ts:211`
 * 已按同名字段解析工具名与入参）。`TaskTraceService` 面向 UI 时间线（会被截断、按 turn 过滤），
 * 不适合做机验；这里只做**最朴素的**事件扫描。
 *
 * ## 降级口径（与轨迹服务一致）
 *
 * `sessionQuery` 缺失、会话已被清理、观察抛错 ⇒ 返回 `undefined`（= 不可观测）。
 * 返回 `[]` 表示"读到了会话，确实一次工具都没调" —— 两者语义不同，调用方据此决定是否判不达标。
 *
 * @param sessionQuery - 宿主 `sessionQuery` 服务（未知形状，内部做能力探测）。
 * @param sessionId - 子会话 id。
 * @returns 工具调用切片；不可观测时 `undefined`。
 */
export async function readChildToolCallsFrom(
  sessionQuery: unknown,
  sessionId: string,
): Promise<ChildToolCall[] | undefined> {
  const service = sessionQuery as SessionQueryLike | undefined
  if (!service || typeof service.observeSession !== 'function' || !sessionId) return undefined
  let obs: ObservationLike | undefined
  try {
    obs = await service.observeSession(sessionId, { projectionMode: 'none' })
  } catch {
    return undefined
  }
  try {
    const out: ChildToolCall[] = []
    for (const raw of obs?.events ?? []) {
      const event = raw as { type?: unknown; data?: unknown }
      if (event?.type !== 'tool/call') continue
      const data = event.data as { name?: unknown; arguments?: unknown }
      const name = typeof data?.name === 'string' ? data.name : ''
      if (!name) continue
      const args = typeof data?.arguments === 'string'
        ? data.arguments
        : data?.arguments === undefined
          ? ''
          : (() => {
              try {
                return JSON.stringify(data.arguments)
              } catch {
                return ''
              }
            })()
      out.push({ name, args })
    }
    return out
  } finally {
    releaseObservation(obs)
  }
}

/**
 * 读取某子会话**模型真实收到的工具表**（`request/header` 事件里的 `tools[].name`）。
 *
 * ## 为什么需要它（2026-10-30 现场纠正）
 *
 * 现场子代理声称"MCP 工具未注入本会话的工具列表"，据此绕开 MCP 自建 REST 脚本。
 * 但解包该子会话的 `request/header` 后发现：**模型收到的工具表有 455 个工具，
 * `mcp__tfs-mcp__*`（含 tfs_add_tags / tfs_update_workitem）与
 * `mcp__winex_peis_knowledge__*` 全都在里面**——"未注入"是模型的错误自述，不是装配事实。
 *
 * 因此验收不能只信输出文本：要把**请求工具表**作为事实源，用于识别
 * "工具实际存在却谎称不存在"（`mcpClaimedMissing`）。这与 {@link readChildToolCallsFrom}
 * 的分工是：那个回答"它调了什么"，本函数回答"它能看到什么"。
 *
 * 降级口径同轨迹服务：sessionQuery 缺失/会话不可读 ⇒ `undefined`（无法核实，不据此判罚）。
 *
 * @param sessionQuery - 宿主 `sessionQuery` 服务。
 * @param sessionId - 子会话 id。
 * @returns 工具全名清单（多次请求取并集）；不可观测时 `undefined`。
 */
export async function readChildToolSurfaceFrom(
  sessionQuery: unknown,
  sessionId: string,
): Promise<string[] | undefined> {
  const service = sessionQuery as SessionQueryLike | undefined
  if (!service || typeof service.observeSession !== 'function' || !sessionId) return undefined
  let obs: ObservationLike | undefined
  try {
    obs = await service.observeSession(sessionId, { projectionMode: 'none' })
  } catch {
    return undefined
  }
  try {
    const names = new Set<string>()
    for (const raw of obs?.events ?? []) {
      const event = raw as { type?: unknown; data?: unknown }
      if (event?.type !== 'request/header') continue
      const header = (event.data as { header?: { tools?: Array<{ name?: unknown }> } })?.header
      for (const tool of header?.tools ?? []) {
        if (typeof tool?.name === 'string' && tool.name.length > 0) names.add(tool.name)
      }
    }
    return [...names]
  } finally {
    releaseObservation(obs)
  }
}

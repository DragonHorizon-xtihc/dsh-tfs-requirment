/**
 * 批量派发的**分波**纯逻辑（问题 5）。
 *
 * ## 为什么需要独立模块
 *
 * 用户选中一批任务点「批量派发执行」时，真正要保证的语义只有一句：
 * **有依赖的任务必须等它依赖的任务执行完成，才能开始执行。**
 *
 * 这句话不能靠"逐个点派发"实现 —— 引擎 `Board.startTask` 对依赖未就绪的任务会直接抛
 * `${taskId} 依赖未就绪：…`（`src/core/board/board.ts` 的 `startTask`），用户逐个点只会
 * 撞一串红字。正确做法是**编排**：把选中集合按 DAG 切成若干波，一波内并行派发，
 * 等这一波全部收口后再算下一波。
 *
 * 编排本身是纯计算（给一份任务快照 → 给出"现在能派谁、在等谁、卡在哪"），
 * 故放在 `src/shared` 而不是客户端组件里：**客户端半没有 React 测试库**
 * （项目既有纪律，见 `vitest.config.ts` 与既有 `tests/*.spec.ts` 的覆盖范围），
 * 只有纯函数才能被 vitest 直接覆盖。真正的 I/O（调派发路由、轮询看板）留在
 * `src/client/slots.tsx`。
 *
 * ## 与引擎的关系
 *
 * 本模块**不重复实现**依赖判定逻辑的语义 —— 判定口径与 `Board.isReady`
 * （`src/core/board/board.ts:298-302`：`blockedBy.every(dep => tasks[dep]?.state === 'completed')`）
 * 严格一致。差别只在于本模块**不抛错**，而是把"为什么不能派"分类返回，好让 UI 给出
 * 可读原因，而不是一句 "依赖未就绪"。
 *
 * @module dsh-tfs-requirment/shared/batch-dispatch
 */

/** 本模块需要的最小任务形状（`BoardTaskView` 的结构子集）。 */
export interface BatchTaskLike {
  taskId: string
  /** 看板四态。 */
  state: string
  /** 执行链路态。 */
  execState: string
  /** DAG 依赖（被阻断的任务 ID）。 */
  blockedBy: string[]
}

/** 一次分波判定的结果。 */
export interface BatchStep {
  /** 已收口（`completed` 或 `deleted`），可从待办集合移除。 */
  done: string[]
  /** 已派发且仍在运行（等它，不要重复派）。 */
  running: string[]
  /**
   * 可以现在派发的：依赖全部 `completed`，且看板态允许开一次尝试
   * （`pending`，或 `in_progress` 且执行态不是 running —— 即失败后的重试）。
   */
  ready: string[]
  /** 依赖尚未完成，需等待（不是错误）。 */
  waiting: string[]
  /** 结构性卡住：任务本身或依赖不存在、依赖已取消 —— 再等也不会变化。 */
  stuck: Array<{ taskId: string; reason: string }>
}

/** 任务是否已到"不需要再推进"的终态。 */
export function isSettled(t: BatchTaskLike): boolean {
  return t.state === 'completed' || t.state === 'deleted'
}

/**
 * 对选中集合做一次分波判定。
 *
 * @param tasks - **全量**任务快照（依赖任务可能不在选中集合内，故不能只传选中的）。
 * @param selected - 本次批量派发选中的任务 id。
 * @returns 分波结果（五个桶互斥且并集 = `selected` 去重后的集合）。
 */
export function planBatchStep(tasks: readonly BatchTaskLike[], selected: readonly string[]): BatchStep {
  const byId = new Map<string, BatchTaskLike>()
  for (const t of tasks) byId.set(t.taskId, t)

  const step: BatchStep = { done: [], running: [], ready: [], waiting: [], stuck: [] }

  for (const id of [...new Set(selected)]) {
    const t = byId.get(id)
    if (!t) {
      step.stuck.push({ taskId: id, reason: '任务不存在（可能已被删除，请刷新后重新勾选）' })
      continue
    }
    if (isSettled(t)) {
      step.done.push(id)
      continue
    }

    // 依赖判定：口径与 Board.isReady 一致（every completed），但把失败原因分类。
    const missing: string[] = []
    const cancelled: string[] = []
    const unmet: string[] = []
    for (const depId of t.blockedBy) {
      const dep = byId.get(depId)
      if (!dep) missing.push(depId)
      else if (dep.state === 'deleted') cancelled.push(depId)
      else if (dep.state !== 'completed') unmet.push(depId)
    }
    if (missing.length > 0) {
      step.stuck.push({ taskId: id, reason: `依赖任务不存在：${missing.join('、')}` })
      continue
    }
    if (cancelled.length > 0) {
      step.stuck.push({ taskId: id, reason: `依赖任务已取消，永远不会完成：${cancelled.join('、')}` })
      continue
    }

    if (t.state === 'in_progress') {
      // running / success：已派发，等自动回绑把 state 收口为 completed。
      if (t.execState === 'running' || t.execState === 'success') {
        step.running.push(id)
        continue
      }
      // queued / failed / cancelled：看板态允许再开一次尝试（Board.startTask 的语义）。
      if (unmet.length === 0) step.ready.push(id)
      else step.waiting.push(id)
      continue
    }

    // pending（以及其他非终态）
    if (unmet.length === 0) step.ready.push(id)
    else step.waiting.push(id)
  }

  return step
}

/**
 * 生成一条给用户看的进度文案。
 *
 * @param step - 本次分波结果。
 * @param remaining - 仍在待办集合里的任务数。
 * @param waveIndex - 已完成的波次序号（从 1 开始；用于"第 N 波"）。
 * @returns 单行中文文案。
 */
export function batchStepText(step: BatchStep, remaining: number, waveIndex: number): string {
  const parts: string[] = []
  if (step.ready.length > 0) parts.push(`第 ${waveIndex} 波派发 ${step.ready.length} 个`)
  if (step.running.length > 0) parts.push(`运行中 ${step.running.length}`)
  if (step.waiting.length > 0) parts.push(`等待依赖 ${step.waiting.length}`)
  if (step.done.length > 0) parts.push(`已完成 ${step.done.length}`)
  if (step.stuck.length > 0) parts.push(`卡住 ${step.stuck.length}`)
  return `剩余 ${remaining}：${parts.join('，')}`
}

/**
 * 生成"无法继续推进"的可读总结（stuck 或超时）。
 *
 * @param entries - 卡住条目。
 * @param limit - 最多列出几条（避免长列表把提示刷屏）。
 * @returns 中文总结。
 */
export function describeStuck(entries: ReadonlyArray<{ taskId: string; reason: string }>, limit = 5): string {
  if (entries.length === 0) return ''
  const head = entries.slice(0, limit).map(e => `${e.taskId}：${e.reason}`)
  const more = entries.length > limit ? `\n…另有 ${entries.length - limit} 个` : ''
  return `有 ${entries.length} 个任务无法推进：\n${head.join('\n')}${more}`
}

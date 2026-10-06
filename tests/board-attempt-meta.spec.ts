import { describe, expect, it } from 'vitest'
import { Board, BoardError, type TaskDraft } from '../src/core/board/board.js'
import { requirementDedupKey, type Requirement } from '../src/tfs/types.js'
import { toTaskView } from '../src/host/board-service.js'

function makeReq(workItemId = 1): Requirement {
  return {
    workItemId,
    collection: 'WN_HIS',
    project: 'PEIS',
    title: `需求 ${workItemId}`,
    state: 'Active',
    assignedTo: 'zhangbo3',
    priority: 'High',
    iteration: 'Sprint1',
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 1,
  }
}

function draft(taskId: string, requirementId: string): TaskDraft {
  return {
    taskId,
    requirementId,
    idempotencyKey: `${taskId}:dsh`,
    title: taskId,
    description: '',
    roleAgent: 'general',
    frozenConfig: { mcp: [], skills: [], model: '' },
  }
}

/** 取数组最后一个元素（noUncheckedIndexedAccess 下断言非空）。 */
function last<T>(arr: readonly T[]): T {
  const v = arr[arr.length - 1]
  if (!v) throw new Error('空数组')
  return v
}

/** 建好需求 + 任务并启动到 in_progress/running。 */
function runningBoard(taskId = 't1'): Board {
  const b = new Board()
  const key = requirementDedupKey(makeReq())
  b.claimRequirement(makeReq())
  b.addTask(draft(taskId, key))
  b.startTask(taskId, b.snapshot.tasks[taskId]!.revision)
  return b
}

describe('Board 执行元数据（spec 006 US2）', () => {
  it('attachRunId 把 runId 写到当前未闭合 attempt', () => {
    const b = runningBoard()
    const rev = b.snapshot.tasks['t1']!.revision
    const next = b.attachRunId('t1', 'run-abc', 'spawn')
    const open = last(next.attempts)
    expect(open.runId).toBe('run-abc')
    expect(open.provider).toBe('spawn')
    expect(open.endedAt).toBeUndefined()
    expect(next.revision).toBe(rev + 1)
  })

  it('finishTask 成功收口时落 stopReason/output/runId', () => {
    const b = runningBoard()
    b.attachRunId('t1', 'run-1')
    const rev = b.snapshot.tasks['t1']!.revision
    const t = b.finishTask('t1', 'success', rev, undefined, {
      runId: 'run-1',
      stopReason: 'completed',
      output: '任务完成的输出摘要',
    })
    expect(t.state).toBe('completed')
    expect(t.execState).toBe('success')
    const a = last(t.attempts)
    expect(a.endedAt).toBeTruthy()
    expect(a.runId).toBe('run-1')
    expect(a.stopReason).toBe('completed')
    expect(a.output).toBe('任务完成的输出摘要')
  })

  it('finishTask 失败收口时落 diagnostic/stopReason，任务保留 in_progress 可重试', () => {
    const b = runningBoard()
    const rev = b.snapshot.tasks['t1']!.revision
    const t = b.finishTask('t1', 'failed', rev, '模型失败', {
      stopReason: 'error',
      diagnostic: 'Provider error: 401 invalid api key',
    })
    expect(t.state).toBe('in_progress')
    expect(t.execState).toBe('failed')
    const a = last(t.attempts)
    expect(a.outcome).toBe('failed')
    expect(a.note).toBe('模型失败')
    expect(a.diagnostic).toContain('401')
    expect(a.stopReason).toBe('error')
  })

  it('followUpTask 对 completed 任务显式重开：保留历史 attempts 并追加 running 轮次', () => {
    const b = runningBoard()
    b.attachRunId('t1', 'run-1')
    b.finishTask('t1', 'success', b.snapshot.tasks['t1']!.revision, undefined, { stopReason: 'completed' })
    const before = b.snapshot.tasks['t1']!
    expect(before.state).toBe('completed')
    const historyCount = before.attempts.length

    const { task, attemptIndex } = b.followUpTask('t1')
    expect(task.state).toBe('in_progress')
    expect(task.execState).toBe('running')
    expect(task.attempts).toHaveLength(historyCount + 1)
    expect(attemptIndex).toBe(historyCount)
    const fresh = task.attempts[attemptIndex]!
    expect(fresh.outcome).toBe('running')
    expect(fresh.endedAt).toBeUndefined()
    // 历史 attempt 不丢。
    expect(task.attempts[0]!.stopReason).toBe('completed')
  })

  it('followUpTask 对 failed（in_progress）任务追加新一轮', () => {
    const b = runningBoard()
    b.finishTask('t1', 'failed', b.snapshot.tasks['t1']!.revision, '失败', { stopReason: 'error' })
    const { task, attemptIndex } = b.followUpTask('t1')
    expect(task.state).toBe('in_progress')
    expect(task.execState).toBe('running')
    expect(attemptIndex).toBe(1)
  })

  it('followUpTask 拒绝 deleted / pending / 未知任务', () => {
    const b = runningBoard()
    b.finishTask('t1', 'cancelled', b.snapshot.tasks['t1']!.revision)
    expect(() => b.followUpTask('t1')).toThrow(BoardError)
    expect(() => b.followUpTask('nope')).toThrow(BoardError)

    const b2 = new Board()
    const key = requirementDedupKey(makeReq(2))
    b2.claimRequirement(makeReq(2))
    b2.addTask(draft('p1', key)) // 从未启动，pending
    expect(() => b2.followUpTask('p1')).toThrow(/尚未执行/)
  })
})

describe('toTaskView 透出 attempts（spec 006）', () => {
  it('映射每次尝试的 runId/stopReason/diagnostic/output，且旧记录（无这些字段）安全', () => {
    const b = runningBoard()
    b.attachRunId('t1', 'run-x')
    b.finishTask('t1', 'failed', b.snapshot.tasks['t1']!.revision, '备注', {
      stopReason: 'max-tokens',
      diagnostic: '超出 token 上限',
    })
    const view = toTaskView(b.snapshot.tasks['t1']!)
    expect(view.attempts).toHaveLength(1)
    expect(last(view.attempts)).toMatchObject({
      outcome: 'failed',
      runId: 'run-x',
      stopReason: 'max-tokens',
      diagnostic: '超出 token 上限',
      note: '备注',
    })
    expect(view.attemptCount).toBe(1)
    expect(view.lastNote).toBe('备注')
  })
})

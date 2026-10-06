import { describe, expect, it } from 'vitest'
import {
  batchStepText,
  describeStuck,
  isSettled,
  planBatchStep,
  type BatchTaskLike,
} from '../src/shared/batch-dispatch.js'

/**
 * 批量派发分波纯逻辑（问题 5：勾选任务启动/派发，有依赖的必须等依赖执行完成）。
 *
 * 这些用例锁死的是**用户可见语义**，不是实现细节：
 *   - 依赖未完成的 `pending` 任务绝不能出现在 `ready` 里（否则用户会看到"点了批量派发
 *     却报依赖未就绪"）；
 *   - 依赖已取消 / 不存在必须归到 `stuck`（再等一万年也不会变，要立刻给可读原因）；
 *   - 已 `completed` 的依赖才放行（`state === 'completed'`，不是 `execState === 'success'`）。
 */

function task(taskId: string, state: string, execState: string, blockedBy: string[] = []): BatchTaskLike {
  return { taskId, state, execState, blockedBy }
}

/** 线性 DAG（五段式 analyze→plan→impl→review→verify 的通用三节点示意）：a → b → c。 */
function dag(over: Partial<Record<string, BatchTaskLike>> = {}): BatchTaskLike[] {
  return [
    over['a'] ?? task('a', 'pending', 'queued'),
    over['b'] ?? task('b', 'pending', 'queued', ['a']),
    over['c'] ?? task('c', 'pending', 'queued', ['b']),
  ]
}

describe('planBatchStep · 依赖顺序', () => {
  it('初始状态：只有无依赖的 analyze 可派，其余两个在等待依赖', () => {
    const step = planBatchStep(dag(), ['a', 'b', 'c'])
    expect(step.ready).toEqual(['a'])
    expect(step.waiting).toEqual(['b', 'c'])
    expect(step.running).toEqual([])
    expect(step.done).toEqual([])
    expect(step.stuck).toEqual([])
  })

  it('analyze 运行中：无 ready（不放行 impl），analyze 归 running', () => {
    const step = planBatchStep(dag({ a: task('a', 'in_progress', 'running') }), ['a', 'b', 'c'])
    expect(step.ready).toEqual([])
    expect(step.running).toEqual(['a'])
    expect(step.waiting).toEqual(['b', 'c'])
  })

  it('analyze 已完成：impl 放行，verify 仍等待', () => {
    const step = planBatchStep(dag({ a: task('a', 'completed', 'success') }), ['a', 'b', 'c'])
    expect(step.done).toEqual(['a'])
    expect(step.ready).toEqual(['b'])
    expect(step.waiting).toEqual(['c'])
  })

  it('依赖只看「看板态 completed」：execState=success 但 state 仍 in_progress 不放行', () => {
    // 收口瞬间（run 已成功、state 还没翻成 completed）不能提前放行下一波，
    // 否则"必须等依赖完成"这条用户可见承诺会出现毫秒级窗口。
    const step = planBatchStep(dag({ a: task('a', 'in_progress', 'success') }), ['a', 'b', 'c'])
    expect(step.ready).toEqual([])
    expect(step.running).toContain('a')
    expect(step.waiting).toEqual(['b', 'c'])
  })

  it('全链路完成后：三个都归 done，无 ready', () => {
    const step = planBatchStep(
      dag({ a: task('a', 'completed', 'success'), b: task('b', 'completed', 'success'), c: task('c', 'completed', 'success') }),
      ['a', 'b', 'c'],
    )
    expect(step.ready).toEqual([])
    expect(step.done).toEqual(['a', 'b', 'c'])
  })
})

describe('planBatchStep · stuck（再等也不会变，必须给出原因）', () => {
  it('任务不存在 → stuck', () => {
    const step = planBatchStep(dag(), ['a', 'ghost'])
    expect(step.stuck).toEqual([{ taskId: 'ghost', reason: '任务不存在（可能已被删除，请刷新后重新勾选）' }])
  })

  it('依赖任务不存在 → stuck', () => {
    const step = planBatchStep([task('x', 'pending', 'queued', ['gone'])], ['x'])
    expect(step.stuck).toHaveLength(1)
    expect(step.stuck[0]!.reason).toContain('依赖任务不存在')
    expect(step.stuck[0]!.reason).toContain('gone')
    expect(step.ready).toEqual([])
    expect(step.waiting).toEqual([])
  })

  it('依赖任务已取消 → stuck（不是 waiting：取消是终态）', () => {
    const step = planBatchStep([task('a', 'deleted', 'cancelled'), task('b', 'pending', 'queued', ['a'])], ['b'])
    expect(step.stuck).toHaveLength(1)
    expect(step.stuck[0]!.reason).toContain('依赖任务已取消')
    expect(step.waiting).toEqual([])
  })

  it('依赖已取消时选中依赖本身 → done（终态，出队即可）', () => {
    const step = planBatchStep([task('a', 'deleted', 'cancelled')], ['a'])
    expect(step.done).toEqual(['a'])
    expect(step.stuck).toEqual([])
  })
})

describe('planBatchStep · 重试与去重', () => {
  it('in_progress + failed 且在依赖就绪时 → ready（可重试）', () => {
    const step = planBatchStep([task('a', 'in_progress', 'failed')], ['a'])
    expect(step.ready).toEqual(['a'])
  })

  it('in_progress + failed 但依赖未就绪 → waiting（不许绕过依赖重试）', () => {
    const step = planBatchStep([task('dep', 'pending', 'queued'), task('a', 'in_progress', 'failed', ['dep'])], ['a'])
    expect(step.ready).toEqual([])
    expect(step.waiting).toEqual(['a'])
  })

  it('重复选中同一 id 只统计一次', () => {
    const step = planBatchStep(dag(), ['a', 'a', 'a'])
    expect(step.ready).toEqual(['a'])
  })

  it('五桶并集 = 选中集合（互斥且完整）', () => {
    const step = planBatchStep(dag(), ['a', 'b', 'c', 'ghost'])
    const all = [...step.done, ...step.running, ...step.ready, ...step.waiting, ...step.stuck.map(s => s.taskId)]
    expect(all.sort()).toEqual(['a', 'b', 'c', 'ghost'].sort())
    expect(new Set(all).size).toBe(4)
  })
})

describe('isSettled / 文案', () => {
  it('isSettled 只认 completed 与 deleted', () => {
    expect(isSettled(task('a', 'completed', 'success'))).toBe(true)
    expect(isSettled(task('a', 'deleted', 'cancelled'))).toBe(true)
    expect(isSettled(task('a', 'in_progress', 'failed'))).toBe(false)
    expect(isSettled(task('a', 'pending', 'queued'))).toBe(false)
  })

  it('batchStepText 汇总各桶数量', () => {
    const text = batchStepText(planBatchStep(dag(), ['a', 'b', 'c']), 3, 1)
    expect(text).toContain('剩余 3')
    expect(text).toContain('第 1 波派发 1 个')
    expect(text).toContain('等待依赖 2')
  })

  it('describeStuck 截断长列表但说明总数', () => {
    const many = Array.from({ length: 8 }, (_, i) => ({ taskId: `t${i}`, reason: '依赖未就绪' }))
    const text = describeStuck(many, 3)
    expect(text).toContain('有 8 个任务无法推进')
    expect(text).toContain('另有 5 个')
    expect(text).not.toContain('t7')
  })

  it('describeStuck 空输入返回空串（不产出噪声）', () => {
    expect(describeStuck([])).toBe('')
  })
})

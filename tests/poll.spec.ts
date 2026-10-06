import { describe, expect, it } from 'vitest'
import {
  clampPollInterval,
  isPollDue,
  mergeRequirementPage,
  msUntilNextPoll,
  requirementKey,
  MIN_POLL_INTERVAL_MINUTES,
} from '../src/shared/poll.js'
import type { RequirementSummary } from '../src/shared/contracts.js'

/**
 * 定时轮询纯逻辑单测（T037 / FR-024 / S-14）。
 *
 * 这些断言是"轮询到底有没有用"的判据：如果增量判定错了，UI 上要么**什么都没高亮**
 * （用户以为没变化，实际 TFS 里已改），要么**全表变绿**（每次都当成新增，等于没做增量）。
 */

function req(id: number, over: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id,
    collection: 'WN_HIS',
    project: 'PEIS',
    title: `需求 ${id}`,
    type: '产品需求',
    state: 'Active',
    assignedTo: 'zhangbo3',
    priority: '2',
    areaPath: 'PEIS',
    iterationPath: 'Sprint 1',
    tags: ['dsh'],
    changedDate: '2026-09-17T10:00:00Z',
    url: `http://tfs/_workitems/edit/${id}`,
    ...over,
  }
}

describe('requirementKey', () => {
  it('键为 id@collection（与 S-01 去重键一致）', () => {
    expect(requirementKey(req(123))).toBe('123@WN_HIS')
  })
})

describe('mergeRequirementPage 增量合并', () => {
  it('全新列表：全部计为新增，顺序与响应一致', () => {
    const r = mergeRequirementPage([], [req(1), req(2)])
    expect(r.added).toBe(2)
    expect(r.updated).toBe(0)
    expect(r.unchanged).toBe(0)
    expect(r.items.map(i => i.id)).toEqual([1, 2])
  })

  it('同一条状态变化 → 计为更新，且就地替换（不打乱既有顺序）', () => {
    const prev = [req(1), req(2), req(3)]
    const next = [req(1), req(2, { state: 'Resolved' }), req(3)]
    const r = mergeRequirementPage(prev, next)
    expect(r.added).toBe(0)
    expect(r.updated).toBe(1)
    expect(r.unchanged).toBe(2)
    expect(r.changedKeys).toEqual(['2@WN_HIS'])
    expect(r.items.map(i => i.id)).toEqual([1, 2, 3])
    expect(r.items[1]?.state).toBe('Resolved')
  })

  it('标题/指派/优先级/迭代任一变化都算更新', () => {
    for (const over of [{ title: '改了' }, { assignedTo: '别人' }, { priority: '1' }, { iterationPath: 'Sprint 2' }]) {
      const r = mergeRequirementPage([req(9)], [req(9, over)])
      expect(r.updated).toBe(1)
    }
  })

  it('仅标签顺序不同不算更新（避免无意义高亮）', () => {
    const r = mergeRequirementPage([req(9, { tags: ['dsh', 'auto'] })], [req(9, { tags: ['auto', 'dsh'] })])
    expect(r.updated).toBe(0)
    expect(r.unchanged).toBe(1)
  })

  it('标签集合真变化算更新', () => {
    const r = mergeRequirementPage([req(9, { tags: ['dsh'] })], [req(9, { tags: ['dsh', 'auto'] })])
    expect(r.updated).toBe(1)
  })

  it('分页响应缺的旧条目被保留（需求池不是全量集合，丢条目会让用户以为数据没了）', () => {
    const prev = [req(1), req(2), req(3)]
    const r = mergeRequirementPage(prev, [req(3)])
    expect(r.items.map(i => i.id)).toEqual([1, 2, 3])
    expect(r.retained).toBe(2)
    expect(r.unchanged).toBe(1)
  })

  it('同号不同集合不被误判为同一条', () => {
    const prev = [req(5, { collection: 'WN_HIS' })]
    const r = mergeRequirementPage(prev, [req(5, { collection: 'WN_TECH', title: 'TECH 的 5 号' })])
    expect(r.added).toBe(1)
    expect(r.items).toHaveLength(2)
    expect(r.items.map(i => requirementKey(i))).toEqual(['5@WN_HIS', '5@WN_TECH'])
  })

  it('同一响应内重复条目只取第一条（防御后端重复）', () => {
    const r = mergeRequirementPage([], [req(1, { title: 'A' }), req(1, { title: 'B' })])
    expect(r.items).toHaveLength(1)
    expect(r.items[0]?.title).toBe('A')
    expect(r.added).toBe(1)
  })

  it('新增与更新混合：计数分别正确', () => {
    const prev = [req(1), req(2)]
    const r = mergeRequirementPage(prev, [req(2, { state: 'Closed' }), req(3)])
    expect(r).toMatchObject({ added: 1, updated: 1, unchanged: 0, retained: 1 })
    expect(r.items.map(i => i.id)).toEqual([1, 2, 3])
  })

  it('不修改入参（纯函数）', () => {
    const prev = [req(1)]
    const snapshot = JSON.stringify(prev)
    mergeRequirementPage(prev, [req(1, { state: 'Closed' }), req(2)])
    expect(JSON.stringify(prev)).toBe(snapshot)
  })
})

describe('轮询排程（S-14 最小 1 分钟）', () => {
  it('clampPollInterval：非法/过小一律夹到下限', () => {
    for (const v of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(clampPollInterval(v)).toBe(MIN_POLL_INTERVAL_MINUTES)
    }
    expect(clampPollInterval(5)).toBe(5)
    expect(clampPollInterval(2.5)).toBe(2.5)
  })

  it('isPollDue：从未轮询过视为立即到期', () => {
    expect(isPollDue(0, 5, Date.now())).toBe(true)
  })

  it('isPollDue：未到期 false，正好到期 true', () => {
    const now = 1_000_000_000
    expect(isPollDue(now - 4 * 60_000, 5, now)).toBe(false)
    expect(isPollDue(now - 5 * 60_000, 5, now)).toBe(true)
    expect(isPollDue(now - 6 * 60_000, 5, now)).toBe(true)
  })

  it('isPollDue：间隔小于下限时按 1 分钟判定（防止配置写 0 变成高频轮询）', () => {
    const now = 1_000_000_000
    expect(isPollDue(now - 30_000, 0, now)).toBe(false)
    expect(isPollDue(now - 60_000, 0, now)).toBe(true)
  })

  it('msUntilNextPoll：未到期返回剩余毫秒，已过期返回 0', () => {
    const now = 1_000_000_000
    expect(msUntilNextPoll(now - 60_000, 5, now)).toBe(4 * 60_000)
    expect(msUntilNextPoll(now - 10 * 60_000, 5, now)).toBe(0)
    expect(msUntilNextPoll(0, 5, now)).toBe(0)
  })
})

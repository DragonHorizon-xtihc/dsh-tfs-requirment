/**
 * `shared/target.ts` 单测（2026-09-21 目标串混用事故）。
 *
 * 覆盖两类真实输入：
 *   - 需求键 `1997179@WN_HIS`（需求池「选为目标」）；
 *   - 看板任务 id `1997179@WN_HIS#analyze`（任务中心/右栏「设为目标」）——
 *     若按 `@` 直接切分，集合会变成 `WN_HIS#analyze`，回写 TFS 时只会得到一个更费解的 404。
 *   - 面板占位符 `—`（宿主下发值，必须判为"未选目标"）。
 */

import { describe, expect, it } from 'vitest'
import { isValidTargetWorkItem, targetRefFromKey } from '../src/shared/target.js'

describe('targetRefFromKey：目标键归一', () => {
  it('需求键：id 与集合原样取出', () => {
    expect(targetRefFromKey('1997179@WN_HIS', 'WN_HIS')).toEqual({
      targetWorkItem: '1997179@WN_HIS',
      collection: 'WN_HIS',
    })
  })

  it('看板任务 id：剥掉 `#stage` 段，集合不得被污染', () => {
    expect(targetRefFromKey('1997179@WN_HIS#analyze', 'WN_TJ')).toEqual({
      targetWorkItem: '1997179@WN_HIS',
      collection: 'WN_HIS',
    })
  })

  it('键里没带集合 ⇒ 回退 fallbackCollection', () => {
    expect(targetRefFromKey('1997179', 'WN_TJ')).toEqual({ targetWorkItem: '1997179', collection: 'WN_TJ' })
    expect(targetRefFromKey('1997179@', 'WN_TJ')).toEqual({ targetWorkItem: '1997179', collection: 'WN_TJ' })
  })

  it('占位符/空值：原样返回，交由有效性校验拦住', () => {
    expect(targetRefFromKey('—', 'WN_HIS')).toEqual({ targetWorkItem: '—', collection: 'WN_HIS' })
    expect(targetRefFromKey('', 'WN_HIS')).toEqual({ targetWorkItem: '', collection: 'WN_HIS' })
    expect(targetRefFromKey('  ', 'WN_HIS')).toEqual({ targetWorkItem: '', collection: 'WN_HIS' })
  })
})

describe('isValidTargetWorkItem：可否用于 TFS 回写', () => {
  it('`<正整数>@<集合>` 有效；裸 id 也有效（集合由 TargetRef.collection 一并给出）', () => {
    expect(isValidTargetWorkItem('1997179@WN_HIS')).toBe(true)
    expect(isValidTargetWorkItem('1@X')).toBe(true)
    expect(isValidTargetWorkItem('1997179')).toBe(true)
  })

  it('占位符 / 空串 / 非数字 / 带 stage 的原始任务 id 都无效', () => {
    expect(isValidTargetWorkItem('—')).toBe(false)
    expect(isValidTargetWorkItem('')).toBe(false)
    expect(isValidTargetWorkItem('  ')).toBe(false)
    // 原始任务 id 应先经 targetRefFromKey 归一；未归一时不得当作可回写目标。
    expect(isValidTargetWorkItem('1997179@WN_HIS#analyze')).toBe(false)
    expect(isValidTargetWorkItem('abc@WN_HIS')).toBe(false)
    expect(isValidTargetWorkItem('1997179@')).toBe(false) // 归一后才是 '1997179'
  })
})

/**
 * 定时执行纯逻辑（2026-11-03 问题 4/5）。
 *
 * 覆盖：datetime-local 解析/校验（形状、不存在的日期、过去时刻）、
 * 完整计划校验（now/at）、到点判定与倒计时、本地分钟格式化。
 */

import { describe, expect, it } from 'vitest'
import {
  formatLocalMinute,
  isDue,
  msUntilDue,
  parseDateTimeLocal,
  validateSchedule,
} from '../src/shared/schedule.js'

const NOW = new Date('2026-11-03T10:00:00')

describe('parseDateTimeLocal（精确到分）', () => {
  it('合法未来时刻 → ok + ISO dueAt', () => {
    const r = parseDateTimeLocal('2026-11-03T18:30', NOW)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.plan.mode).toBe('at')
      const d = new Date(r.plan.dueAt!)
      expect(d.getHours()).toBe(18)
      expect(d.getMinutes()).toBe(30)
    }
  })

  it('空串 / 垃圾输入 → 拒绝（不猜）', () => {
    expect(parseDateTimeLocal('', NOW).ok).toBe(false)
    expect(parseDateTimeLocal('  ', NOW).ok).toBe(false)
    expect(parseDateTimeLocal('tomorrow', NOW).ok).toBe(false)
    expect(parseDateTimeLocal('2026/11/03 18:30', NOW).ok).toBe(false)
  })

  it('不存在的日期（2 月 30 日）→ 拒绝', () => {
    const r = parseDateTimeLocal('2026-02-30T10:00', NOW)
    expect(r.ok).toBe(false)
  })

  it('过去时刻 → 拒绝（定时必须晚于当前时间）', () => {
    expect(parseDateTimeLocal('2026-11-03T09:59', NOW).ok).toBe(false)
    expect(parseDateTimeLocal('2026-11-03T10:00', NOW).ok).toBe(false)
  })

  it('可带秒（仍精确到分粒度可用）', () => {
    const r = parseDateTimeLocal('2026-11-03T18:30:45', NOW)
    expect(r.ok).toBe(true)
  })
})

describe('validateSchedule（立刻/定时）', () => {
  it('mode=now → 立刻（忽略时间输入）', () => {
    const r = validateSchedule({ mode: 'now', dueAtLocal: '' })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan).toEqual({ mode: 'now' })
  })

  it('mode 缺省/未知 → 按立刻（默认语义）', () => {
    const r = validateSchedule({ mode: '', dueAtLocal: '' })
    if (r.ok) expect(r.plan.mode).toBe('now')
  })

  it('mode=at 无时刻 → 拒绝并给出可读原因', () => {
    const r = validateSchedule({ mode: 'at', dueAtLocal: '', now: NOW })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toContain('执行时间')
  })

  it('mode=at 合法时刻 → ok', () => {
    const r = validateSchedule({ mode: 'at', dueAtLocal: '2026-11-03T18:30', now: NOW })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.plan.dueAt).toBeTruthy()
  })
})

describe('isDue / msUntilDue', () => {
  it('now 恒到点、msUntilDue=0', () => {
    expect(isDue({ mode: 'now' }, NOW)).toBe(true)
    expect(msUntilDue({ mode: 'now' }, NOW)).toBe(0)
  })

  it('未到点 → false + 正倒计时', () => {
    const plan = { mode: 'at' as const, dueAt: '2026-11-03T18:30:00' }
    expect(isDue(plan, NOW)).toBe(false)
    expect(msUntilDue(plan, NOW)).toBeGreaterThan(0)
  })

  it('已到点/越过 → true + 0', () => {
    const plan = { mode: 'at' as const, dueAt: '2026-11-03T09:00:00' }
    expect(isDue(plan, NOW)).toBe(true)
    expect(msUntilDue(plan, NOW)).toBe(0)
  })

  it('缺 dueAt / 非法 ISO → 不到点（不误触发）', () => {
    expect(isDue({ mode: 'at' }, NOW)).toBe(false)
    expect(isDue({ mode: 'at', dueAt: 'garbage' }, NOW)).toBe(false)
  })
})

describe('formatLocalMinute', () => {
  it('ISO → 本地 YYYY-MM-DD HH:mm', () => {
    const iso = new Date(2026, 10, 3, 18, 30, 0).toISOString()
    expect(formatLocalMinute(iso)).toBe('2026-11-03 18:30')
  })

  it('非法/空 → 空串（不显示 Invalid Date）', () => {
    expect(formatLocalMinute('')).toBe('')
    expect(formatLocalMinute(undefined)).toBe('')
    expect(formatLocalMinute('garbage')).toBe('')
  })
})

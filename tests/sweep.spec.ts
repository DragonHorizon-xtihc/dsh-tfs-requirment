/**
 * 主 agent 扫尾决策（2026-11-03 问题 7）。
 *
 * 覆盖：推荐选项解析（显式标记/无标记）、扫尾决策矩阵
 * （成功不动 / 待确认续跑 / 瞬时失败重试 / 拒绝与轮数耗尽转亲做）、
 * 续跑与亲做 prompt 组装（含原因与任务背景）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildContinuePrompt,
  buildMainAgentCompletePrompt,
  decideSweep,
  extractRecommendedOption,
  RECOMMENDATION_LIMIT,
} from '../src/shared/sweep.js'

describe('extractRecommendedOption（推荐选项解析）', () => {
  it('RECOMMEND: 显式标记 → 解析出选项', () => {
    expect(extractRecommendedOption('前面一堆话\nRECOMMEND: 选方案 A（加缓存）\n')).toBe('选方案 A（加缓存）')
    expect(extractRecommendedOption('推荐：按 3.2 执行')).toBe('按 3.2 执行')
    expect(extractRecommendedOption('推荐选项：先跑冒烟再合并')).toBe('先跑冒烟再合并')
    expect(extractRecommendedOption('RECOMMENDED: use plan B')).toBe('use plan B')
  })

  it('无标记 → 空串（不瞎猜）', () => {
    expect(extractRecommendedOption('请人工确认一下')).toBe('')
    expect(extractRecommendedOption('')).toBe('')
    expect(extractRecommendedOption(undefined)).toBe('')
  })

  it('超长推荐项限长', () => {
    const long = 'x'.repeat(RECOMMENDATION_LIMIT + 100)
    const out = extractRecommendedOption(`RECOMMEND: ${long}`)
    expect(out.length).toBeLessThanOrEqual(RECOMMENDATION_LIMIT + 1)
  })
})

describe('decideSweep（扫尾决策矩阵）', () => {
  it('成功收口 → none（走既有链式放行）', () => {
    const a = decideSweep({ outcome: 'success', sweepRound: 0, maxSweepRounds: 2 })
    expect(a.kind).toBe('none')
  })

  it('待人工确认 → 选推荐选项续跑（带解析出的推荐项）', () => {
    const a = decideSweep({
      outcome: 'needs_confirmation',
      output: 'RECOMMEND: 选 A',
      sweepRound: 0,
      maxSweepRounds: 2,
    })
    expect(a).toEqual({ kind: 'continue_with_recommendation', recommendation: '选 A' })
  })

  it('待人工确认且解析不出推荐项 → 仍续跑（推荐项为空，由主 agent 决断）', () => {
    const a = decideSweep({ outcome: 'needs_confirmation', output: '请确认', sweepRound: 1, maxSweepRounds: 2 })
    expect(a.kind).toBe('continue_with_recommendation')
    if (a.kind === 'continue_with_recommendation') expect(a.recommendation).toBe('')
  })

  it('待确认反复出现、轮数耗尽 → 转主 agent 亲做（防无限续跑死循环）', () => {
    const a = decideSweep({ outcome: 'needs_confirmation', output: '请确认', sweepRound: 2, maxSweepRounds: 2 })
    expect(a.kind).toBe('main_agent_completes')
    if (a.kind === 'main_agent_completes') expect(a.reason).toContain('反复请求人工确认')
  })

  it('瞬时失败（未超轮数）→ retry_continue（round+1）', () => {
    const a = decideSweep({ outcome: 'failed', stopReason: 'max-tokens', sweepRound: 0, maxSweepRounds: 2 })
    expect(a).toEqual({ kind: 'retry_continue', round: 1 })
  })

  it('轮数耗尽 → 转主 agent 亲做', () => {
    const a = decideSweep({ outcome: 'failed', stopReason: 'error', sweepRound: 2, maxSweepRounds: 2 })
    expect(a.kind).toBe('main_agent_completes')
    if (a.kind === 'main_agent_completes') expect(a.reason).toContain('耗尽')
  })

  it('明确拒绝 → 不烧轮数，直接主 agent 亲做', () => {
    const a = decideSweep({ outcome: 'failed', stopReason: 'refusal', sweepRound: 0, maxSweepRounds: 5 })
    expect(a.kind).toBe('main_agent_completes')
    if (a.kind === 'main_agent_completes') expect(a.reason).toContain('拒绝')
  })
})

describe('buildContinuePrompt / buildMainAgentCompletePrompt', () => {
  it('续跑 prompt 带推荐项与进度尾巴，且要求输出 TASK_DONE', () => {
    const p = buildContinuePrompt({ recommendation: '选 A', outputTail: '上一轮尾部' })
    expect(p).toContain('按推荐选项继续：选 A')
    expect(p).toContain('上一轮尾部')
    expect(p).toContain('TASK_DONE')
  })

  it('无推荐项时给"自行选择最合理的默认选项"指引', () => {
    const p = buildContinuePrompt({ recommendation: '' })
    expect(p).toContain('自行选择最合理的默认选项')
  })

  it('亲做 prompt 带任务号/标题/原因/任务要求', () => {
    const p = buildMainAgentCompletePrompt({
      taskId: '123@WN_HIS#impl',
      title: '实现接口',
      taskPrompt: '写 /api/x',
      reason: '子 agent 拒绝执行',
    })
    expect(p).toContain('123@WN_HIS#impl')
    expect(p).toContain('实现接口')
    expect(p).toContain('写 /api/x')
    expect(p).toContain('子 agent 拒绝执行')
    expect(p).toContain('TASK_DONE')
  })
})

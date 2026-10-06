import { describe, expect, it } from 'vitest'
import { extractOutputText, mapStopReasonToOutcome, stopReasonNote } from '../src/host/api.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'

describe('子 run 落定收口（spec 006 US2，修复"失败显示成功"）', () => {
  it('只有 completed 算成功，error/refusal/max-tokens/aborted/未知都算失败', () => {
    expect(mapStopReasonToOutcome('completed')).toBe('success')
    expect(mapStopReasonToOutcome('error')).toBe('failed')
    expect(mapStopReasonToOutcome('refusal')).toBe('failed')
    expect(mapStopReasonToOutcome('max-tokens')).toBe('failed')
    expect(mapStopReasonToOutcome('aborted')).toBe('failed')
    expect(mapStopReasonToOutcome(undefined)).toBe('failed')
    expect(mapStopReasonToOutcome('something-new')).toBe('failed')
  })

  it('stopReasonNote 为每种失败给出可读中文说明', () => {
    expect(stopReasonNote('error')).toContain('模型或传输错误')
    expect(stopReasonNote('refusal')).toContain('拒绝')
    expect(stopReasonNote('max-tokens')).toContain('token')
    expect(stopReasonNote('aborted')).toContain('中止')
    expect(stopReasonNote(undefined)).toContain('unknown')
    expect(stopReasonNote('completed')).toBe('')
  })

  it('extractOutputText 抽取文本块、忽略非文本、超长截断', () => {
    const blocks: ContentBlock[] = [
      { type: 'text', text: '第一段' } as unknown as ContentBlock,
      { type: 'reasoning', text: '思考过程应被忽略' } as unknown as ContentBlock,
      { type: 'text', text: '第二段' } as unknown as ContentBlock,
    ]
    const out = extractOutputText(blocks)
    expect(out).toContain('第一段')
    expect(out).toContain('第二段')
    expect(out).not.toContain('思考过程')
    expect(extractOutputText(undefined)).toBe('')
    expect(extractOutputText([])).toBe('')
    const long = [{ type: 'text', text: 'x'.repeat(5000) }] as unknown as ContentBlock[]
    // 落盘上限远高于展示上限：结论段常在第 2000 字符之后，落盘层不得成为瓶颈，
    // 展示截断由 RequirementFinalizer 逐层负责（B31）。
    expect(extractOutputText(long)).toHaveLength(5000)
    const huge = [{ type: 'text', text: 'y'.repeat(50_000) }] as unknown as ContentBlock[]
    // truncate 会追加「…（已截断，共 N 字）」标记，故上限含标记。
    expect(extractOutputText(huge)).toMatch(/^y+…（已截断/)
    expect(extractOutputText(huge).length).toBeLessThan(20_100)
  })
})

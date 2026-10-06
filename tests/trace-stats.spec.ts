import { describe, expect, it } from 'vitest'
import { summarizeTrace, classifyTool } from '../src/host/trace-mapper.js'

/**
 * 任务执行统计聚合单测（问题 2，对标 dsh-context 的上下文统计）。
 *
 * 用手工构造的会话事件信封（{type,seq,time,data}）驱动 summarizeTrace，锁死：
 *  - 模型请求 / 轮次 / 用户输入计数；
 *  - token 计费口径（total = input + cacheRead + cacheWrite + output，reasoning 不重复计）；
 *  - 工具调用分类（MCP / 技能 / 普通）、成败、仍在运行、耗时；
 *  - "同名 + 同入参" 的重复请求识别（问题 1 的可观测面）。
 */

/** 便捷构造事件信封。 */
function ev(type: string, seq: number, time: number, data?: unknown): { type: string; seq: number; time: number; data?: unknown } {
  return { type, seq, time, data }
}
function toolCall(seq: number, time: number, callId: string, name: string, args: unknown) {
  return ev('tool/call', seq, time, { callId, name, arguments: typeof args === 'string' ? args : JSON.stringify(args) })
}
function toolResult(seq: number, time: number, callId: string, isError = false, text = 'ok') {
  return ev('tool/result', seq, time, { message: { content: [{ toolCallId: callId, isError, content: [{ type: 'text', text }] }] } })
}
function assistantMsg(seq: number, time: number, usage: Record<string, number>) {
  return ev('assistant/message', seq, time, { message: { usage } })
}

describe('classifyTool（工具分类）', () => {
  it('MCP / 技能 / 普通工具', () => {
    expect(classifyTool('mcp__tfs-mcp__query')).toBe('mcp')
    expect(classifyTool('Skill')).toBe('skill')
    expect(classifyTool('run_skill')).toBe('skill')
    expect(classifyTool('Read')).toBe('tool')
  })
})

describe('summarizeTrace（问题 2 统计聚合）', () => {
  function sample() {
    return [
      ev('turn/start', 1, 900, { turn: 1 }),
      ev('user/message', 2, 950, { content: [{ type: 'text', text: '请完成需求 123 的拆解' }] }),
      ev('step/start', 3, 1000),
      toolCall(4, 1000, 'c1', 'mcp__tfs__query', { id: 1 }),
      toolResult(5, 1100, 'c1', false),
      // 与 c1 同名同入参 ⇒ 重复请求。
      toolCall(6, 1200, 'c2', 'mcp__tfs__query', { id: 1 }),
      toolResult(7, 1300, 'c2', false),
      toolCall(8, 1400, 'c3', 'Skill', { name: 'x' }),
      toolResult(9, 1500, 'c3', true, '技能执行失败'),
      // c4 发起后无结果 ⇒ 仍在运行。
      toolCall(10, 1600, 'c4', 'Read', { path: '/a.ts' }),
      assistantMsg(11, 1650, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 10, reasoningTokens: 5 }),
      ev('step/start', 12, 2000),
      assistantMsg(13, 3000, { inputTokens: 200, outputTokens: 80, cacheReadTokens: 40, cacheWriteTokens: 0, reasoningTokens: 9 }),
    ]
  }

  it('请求 / 轮次 / 用户输入计数', () => {
    const s = summarizeTrace(sample())
    expect(s.modelRequests).toBe(2) // 两个 step/start
    expect(s.turns).toBe(1)
    expect(s.userInputs).toBe(1)
    expect(s.assistantMessages).toBe(2)
  })

  it('token 计费口径：total 含缓存读写、不含 reasoning 重复', () => {
    const s = summarizeTrace(sample())
    expect(s.tokens.input).toBe(300)
    expect(s.tokens.output).toBe(130)
    expect(s.tokens.cacheRead).toBe(60)
    expect(s.tokens.cacheWrite).toBe(10)
    expect(s.tokens.reasoning).toBe(14)
    // total = 300 + 60 + 10 + 130 = 500（reasoning 已含在 output 内，不重复加）。
    expect(s.tokens.total).toBe(500)
  })

  it('工具分类 / 成败 / 运行中 / 耗时', () => {
    const s = summarizeTrace(sample())
    expect(s.toolCalls).toBe(4)
    expect(s.toolByKind).toEqual({ mcp: 2, skill: 1, tool: 1 })
    expect(s.toolOk).toBe(2) // c1,c2
    expect(s.toolError).toBe(1) // c3
    expect(s.toolRunning).toBe(1) // c4
    // c1/c2/c3 各 100ms，c4 无结果不计。
    expect(s.toolDurationMs).toBe(300)
  })

  it('工具明细：次数 / 成败 / 单工具最大重复度', () => {
    const s = summarizeTrace(sample())
    const q = s.toolBreakdown.find(t => t.name === 'mcp__tfs__query')
    expect(q).toMatchObject({ kind: 'mcp', count: 2, ok: 2, error: 0, duplicate: 2 })
    const skill = s.toolBreakdown.find(t => t.name === 'Skill')
    expect(skill).toMatchObject({ count: 1, ok: 0, error: 1, duplicate: 1 })
  })

  it('重复请求：同名同入参计数 ≥2 才上报，按次数降序', () => {
    const s = summarizeTrace(sample())
    expect(s.repeatedCalls).toHaveLength(1)
    expect(s.repeatedCalls[0]).toMatchObject({ name: 'mcp__tfs__query', count: 2 })
    // 入参归一化后用于判等（去空白）。
    expect(s.repeatedCalls[0]!.args).toContain('"id":1')
  })

  it('总时长 = 最早事件到最晚事件', () => {
    const s = summarizeTrace(sample())
    expect(s.startedAt).toBe(900)
    expect(s.endedAt).toBe(3000)
    expect(s.durationMs).toBe(2100)
  })

  it('无 step/start 事件时，模型请求数降级为助手消息数', () => {
    const s = summarizeTrace([assistantMsg(1, 100, { inputTokens: 1, outputTokens: 1 })])
    expect(s.modelRequests).toBe(1)
  })

  it('入参仅空白差异不算新请求（归一化判等）', () => {
    const events = [
      toolCall(1, 1, 'a', 'Foo', { a: 1, b: 2 }),
      toolResult(2, 2, 'a'),
      toolCall(3, 3, 'b', 'Foo', JSON.stringify({ a: 1, b: 2 })),
      toolResult(4, 4, 'b'),
    ]
    const s = summarizeTrace(events)
    // 两次入参归一化后等价 ⇒ 同一签名 count=2。
    expect(s.repeatedCalls).toHaveLength(1)
    expect(s.repeatedCalls[0]!.count).toBe(2)
  })

  it('怪事件 / 空序列不抛', () => {
    expect(() => summarizeTrace([null, 42, { type: 'unknown' }, {} as never])).not.toThrow()
    const s = summarizeTrace([])
    expect(s.toolCalls).toBe(0)
    expect(s.tokens.total).toBe(0)
    expect(s.durationMs).toBeUndefined()
  })

  it('空文本用户消息不计为用户输入', () => {
    const s = summarizeTrace([ev('user/message', 1, 1, { content: [{ type: 'text', text: '   ' }] })])
    expect(s.userInputs).toBe(0)
  })
})

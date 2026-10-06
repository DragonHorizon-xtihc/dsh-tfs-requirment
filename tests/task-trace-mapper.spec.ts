import { describe, expect, it } from 'vitest'
import {
  blocksToReasoning,
  blocksToText,
  classifyTool,
  mapTraceEvents,
  MAX_ENTRIES,
  truncate,
} from '../src/host/trace-mapper.js'

/** 造一个 SessionEvent 信封。 */
function ev(type: string, seq: number, data: unknown, time = 1_700_000_000_000 + seq * 1000) {
  return { type, seq, time, data }
}

const userMsg = (text: string) => ({ role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } })
const assistantMsg = (text: string, interrupted = false) => ({
  turn: 0,
  step: 0,
  message: { role: 'assistant', content: [{ type: 'text', text }], source: { kind: 'model', provider: 'p', model: 'm' } },
  stream: [],
  ...(interrupted ? { interrupted: true } : {}),
})
const toolCall = (callId: string, name: string, args: unknown) => ({
  turn: 0,
  step: 0,
  callId,
  name,
  arguments: typeof args === 'string' ? args : JSON.stringify(args),
})
const toolResult = (callId: string, text: string, isError = false, errorReason?: string) => ({
  turn: 0,
  step: 0,
  message: {
    role: 'user',
    content: [
      {
        type: 'tool-result',
        toolCallId: callId,
        isError,
        content: [{ type: 'text', text }],
      },
    ],
    source: { kind: 'tool', callId },
  },
  ...(isError
    ? { error: { name: 'ToolError', code: 'TOOL_FAILED', ...(errorReason ? { reason: errorReason } : {}) } }
    : {}),
})

describe('trace-mapper', () => {
  it('classifyTool 区分 MCP / 技能 / 普通工具', () => {
    expect(classifyTool('mcp__tfs__tfs_get_workitem')).toBe('mcp')
    expect(classifyTool('Skill')).toBe('skill')
    expect(classifyTool('run_skill')).toBe('skill')
    expect(classifyTool('Bash')).toBe('tool')
  })

  it('blocksToText 抽取文本块并递归 tool-result，忽略非文本块', () => {
    expect(blocksToText([{ type: 'text', text: 'a' }, { type: 'reasoning', text: 'x' }])).toBe('a')
    expect(
      blocksToText([
        { type: 'tool-result', content: [{ type: 'text', text: 'inner' }] },
        { type: 'text', text: 'outer' },
      ]),
    ).toBe('inner\nouter')
    expect(blocksToText('plain')).toBe('plain')
    expect(blocksToText(undefined)).toBe('')
  })

  it('blocksToReasoning 只抽 reasoning 块，与可见文本分离', () => {
    expect(blocksToReasoning([{ type: 'reasoning', text: '我在想' }, { type: 'text', text: '可见' }])).toBe('我在想')
    expect(blocksToReasoning([{ type: 'reasoning', text: '一' }, { type: 'reasoning', text: '二' }])).toBe('一\n二')
    expect(blocksToReasoning([{ type: 'reasoning', text: '   ' }])).toBe('')
    expect(blocksToReasoning(undefined)).toBe('')
    expect(blocksToReasoning('plain')).toBe('')
  })

  it('assistant 同时含思考与正文：thinking 与 text 都映射', () => {
    const data = {
      turn: 0,
      step: 0,
      message: {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: '先分析一下问题' },
          { type: 'text', text: '结论如下' },
        ],
        source: { kind: 'model' },
      },
      stream: [],
    }
    const { entries } = mapTraceEvents([ev('assistant/message', 1, data)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: '结论如下', thinking: '先分析一下问题' })
  })

  it('仅有思考（无可见文本，常伴随工具调用）也保留助手节点——修复"时间线只剩工具"', () => {
    const data = {
      turn: 0,
      step: 0,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: '我需要先查一下' }], source: { kind: 'model' } },
      stream: [],
    }
    const { entries } = mapTraceEvents([ev('assistant/message', 1, data)])
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({ kind: 'assistant', text: '', thinking: '我需要先查一下' })
  })

  it('既无文本也无思考（仅 tool-call 块）不产出空助手节点', () => {
    const data = {
      turn: 0,
      step: 0,
      message: {
        role: 'assistant',
        content: [{ type: 'tool-call', id: 'x', name: 'Bash', arguments: '{}' }],
        source: { kind: 'model' },
      },
      stream: [],
    }
    const { entries } = mapTraceEvents([ev('assistant/message', 1, data)])
    expect(entries).toHaveLength(0)
  })

  it('truncate 超长加省略号与总长度', () => {
    const s = 'x'.repeat(10)
    expect(truncate(s, 10)).toBe(s)
    const out = truncate(s, 5)
    expect(out.startsWith('xxxxx…')).toBe(true)
    expect(out).toContain('10')
  })

  it('truncate 的切点按码点对齐，不劈开增补平面字符', () => {
    // 每个 emoji 占 2 个 UTF-16 码元；按码元 slice 会在 max 落在高代理项时切出半个字符。
    const s = '😀'.repeat(6)
    const out = truncate(s, 5)
    expect(out.startsWith('😀😀…')).toBe(true)
    expect(out).not.toContain('�')
    expect(out).toContain('12')
  })

  it('完整一轮：turn/user/assistant/tool call+result 正确映射与配对', () => {
    const events = [
      ev('turn/start', 1, { turn: 0 }),
      ev('user/message', 2, userMsg('请修复登录 bug')),
      ev('tool/call', 3, toolCall('c1', 'mcp__tfs__tfs_get_workitem', { id: 123 })),
      ev('tool/result', 4, toolResult('c1', '{"id":123,"title":"登录"}')),
      ev('tool/call', 5, toolCall('c2', 'Bash', { command: 'npm test' })),
      ev('tool/result', 6, toolResult('c2', 'tests passed')),
      ev('assistant/message', 7, assistantMsg('已修复并验证')),
      ev('turn/end', 8, { turn: 0, reason: { kind: 'completed' } }),
    ]
    const { entries, cursor } = mapTraceEvents(events)
    expect(cursor).toBe(8)
    const kinds = entries.map(e => e.kind)
    expect(kinds).toEqual(['turn', 'user', 'tool', 'tool', 'assistant', 'turn'])

    const mcp = entries[2]!
    expect(mcp.kind).toBe('tool')
    if (mcp.kind === 'tool') {
      expect(mcp.name).toBe('mcp__tfs__tfs_get_workitem')
      expect(mcp.toolKind).toBe('mcp')
      expect(mcp.status).toBe('ok')
      expect(mcp.result).toContain('登录')
      expect(mcp.args).toContain('123')
      expect(mcp.callId).toBe('c1')
    }
    const bash = entries[3]!
    if (bash.kind === 'tool') expect(bash.toolKind).toBe('tool')
    const end = entries[5]!
    expect(end.kind).toBe('turn')
    if (end.kind === 'turn') expect(end.reason).toBe('completed')
  })

  it('工具失败：isError + error.reason 映射为 error 状态与原因', () => {
    const events = [
      ev('tool/call', 1, toolCall('c9', 'mcp__tfs__tfs_update', {})),
      ev('tool/result', 2, toolResult('c9', '权限不足', true, 'HTTP 403 拒绝访问')),
    ]
    const { entries } = mapTraceEvents(events)
    const t = entries[0]!
    expect(t.kind).toBe('tool')
    if (t.kind === 'tool') {
      expect(t.status).toBe('error')
      expect(t.error).toBe('HTTP 403 拒绝访问')
      expect(t.result).toBeUndefined()
    }
  })

  it('assistant 中断输出带 interrupted 标记', () => {
    const { entries } = mapTraceEvents([ev('assistant/message', 1, assistantMsg('半截输出', true))])
    expect(entries[0]).toMatchObject({ kind: 'assistant', interrupted: true })
  })

  it('乱序事件按 seq 排序；未识别/畸形事件安全跳过', () => {
    const events = [
      ev('assistant/message', 3, assistantMsg('后')),
      ev('user/message', 1, userMsg('先')),
      { type: 'weird/unknown', seq: 2, data: { foo: 1 } },
      null,
      'garbage',
      ev('step/start', 4, { turn: 0, step: 0 }), // 不进时间线
    ]
    const { entries } = mapTraceEvents(events)
    expect(entries.map(e => e.kind)).toEqual(['user', 'assistant'])
  })

  it('有结果无调用（冷读缺头）时补一条结果，失败不丢', () => {
    const { entries } = mapTraceEvents([ev('tool/result', 9, toolResult('orphan', '失败了', true, 'boom'))])
    expect(entries).toHaveLength(1)
    const t = entries[0]!
    if (t.kind === 'tool') {
      expect(t.callId).toBe('orphan')
      expect(t.status).toBe('error')
      expect(t.error).toBe('boom')
    }
  })

  it('超上限保留开头（首轮指令）+ 最近尾部，并标记 truncated', () => {
    const events = [
      ev('user/message', 1, userMsg('首轮指令')),
      ...Array.from({ length: MAX_ENTRIES + 50 }, (_, i) =>
        ev('tool/call', i + 2, toolCall(`c${i}`, 'Bash', { i })),
      ),
    ]
    const { entries, truncated } = mapTraceEvents(events)
    expect(truncated).toBe(true)
    expect(entries.length).toBe(MAX_ENTRIES)
    // 开头的首轮 user 指令被保留。
    expect(entries[0]).toMatchObject({ kind: 'user', text: '首轮指令' })
  })
})

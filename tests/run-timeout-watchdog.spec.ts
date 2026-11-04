/**
 * 看门狗「活性判定 + 终止证据」单测（2026-11-04）。
 *
 * 背景（真机证据见 `.workbuddy/memory/2026-11-04.md`）：旧看门狗是纯墙钟 30 分钟，
 * 把一次**刚刚产出完整报告**的正常长任务判成"可能存在死循环"并终止。本次改造后：
 *
 *   - 到点先探子会话最后一次事件（`probeActivity`）；
 *   - 最近仍有活动 ⇒ 宽限一次（总上界 = runTimeout + grace）；
 *   - 长时间无活动 ⇒ 判 `inactivity`（这才是空转）；
 *   - 探不到/探针抛错 ⇒ fail-open，按总时长终止（`cap`），绝不因探测失败提前杀；
 *   - 任何终止都留下 `RunTimeoutDetail`，上层文案由 `shared/run-timeout.ts` 纯函数生成。
 */
import { describe, expect, it, vi } from 'vitest'
import {
  RequirementDispatcher,
  type DispatchContext,
  type DispatchRequest,
  type SubagentClient,
} from '../src/orchestration/dispatch.js'
import { DEFAULT_ROLES } from '../src/orchestration/roles.js'
import { describeRunTimeout, formatDuration } from '../src/shared/run-timeout.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'

class FakeRun implements SubagentRun {
  readonly id: SessionId
  readonly localAgent: undefined = undefined
  readonly result: Promise<SubagentResult>
  private resolveFn!: (value: SubagentResult) => void
  constructor(id: string) {
    this.id = id as unknown as SessionId
    this.result = new Promise<SubagentResult>(res => {
      this.resolveFn = res
    })
  }
  resolve(): void {
    this.resolveFn(undefined as unknown as SubagentResult)
  }
  async dispose(): Promise<void> {}
}

class FakeClient implements SubagentClient {
  readonly requests: SubagentStartRequest[] = []
  readonly runs: FakeRun[] = []
  private next = 0
  async start(_name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const run = new FakeRun(`run-${++this.next}`)
    this.requests.push(request)
    this.runs.push(run)
    return run
  }
}

function makeReq(taskId: string): DispatchRequest {
  return {
    requirementId: 'r1',
    taskId,
    role: DEFAULT_ROLES[0]!,
    frozenConfig: { mcp: [], skills: [], model: 'deepseek-v4-flash' },
    prompt: [{ type: 'text', text: 'execute' }] as unknown as ContentBlock[],
  }
}

const ctx: DispatchContext = { parent: {} as unknown as Agent }
const MIN = 60_000

/** 起一个 dispatch 并让看门狗到达时限（不推进 run 落定）。 */
async function startAndExpire(d: RequirementDispatcher, ms: number): Promise<void> {
  const p = d.dispatch(makeReq('t1'), ctx)
  await vi.advanceTimersByTimeAsync(0)
  await expect(p).resolves.toMatchObject({ taskId: 't1' })
  await vi.advanceTimersByTimeAsync(ms)
}

describe('看门狗：无活性判据时保持旧语义', () => {
  it('未配 grace / 未接探针 ⇒ 到点按总时长终止（cap），证据如实记录', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1, { runTimeoutMs: 50 })
      await startAndExpire(d, 60)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      const detail = d.takeTimeoutDetail('t1')
      expect(detail).toMatchObject({ kind: 'cap', extended: false })
      expect(detail!.ranMs).toBeGreaterThanOrEqual(50)
      // 证据一次性取出。
      expect(d.takeTimeoutDetail('t1')).toBeUndefined()
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('看门狗：活性判定（2026-11-04）', () => {
  it('到点仍有活动 ⇒ 宽限一次，宽限到点才终止，并标记 extended', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const probe = vi.fn(async (): Promise<number | undefined> => Date.now())
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 100,
        runTimeoutGraceMs: 100,
        probeActivity: probe,
      })
      await startAndExpire(d, 110)
      // 探测到"刚刚还有事件" ⇒ 不终止。
      expect(probe).toHaveBeenCalledTimes(1)
      expect(client.requests[0]!.signal.aborted).toBe(false)
      expect(d.consumeTimeout('t1')).toBe(false)
      // 宽限期满：无条件终止（总上界 = runTimeout + grace）。
      await vi.advanceTimersByTimeAsync(110)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      expect(d.takeTimeoutDetail('t1')).toMatchObject({ kind: 'cap', extended: true })
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('到点时长时间无新事件 ⇒ 判 inactivity（这才是空转），并记录空闲时长', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 100,
        runTimeoutGraceMs: 5 * MIN,
        probeActivity: async () => Date.now() - 30 * MIN,
      })
      await startAndExpire(d, 110)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      const detail = d.takeTimeoutDetail('t1')
      expect(detail).toMatchObject({ kind: 'inactivity', extended: false })
      expect(detail!.lastActivityAgoMs).toBeGreaterThanOrEqual(30 * MIN)
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('探针不可观测（undefined）⇒ fail-open：按总时长终止，不伪造空转结论', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 100,
        runTimeoutGraceMs: 5 * MIN,
        probeActivity: async () => undefined,
      })
      await startAndExpire(d, 110)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      const detail = d.takeTimeoutDetail('t1')
      expect(detail).toMatchObject({ kind: 'cap' })
      expect(detail!.lastActivityAgoMs).toBeUndefined()
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('探针抛错 ⇒ 同样 fail-open（不因探针故障提前/错误归因）', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 100,
        runTimeoutGraceMs: 5 * MIN,
        probeActivity: async () => {
          throw new Error('sessionQuery 不可用')
        },
      })
      await startAndExpire(d, 110)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      expect(d.takeTimeoutDetail('t1')).toMatchObject({ kind: 'cap' })
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('run 正常落定后看门狗不再终止（不登记超时）', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const probe = vi.fn(async (): Promise<number | undefined> => Date.now())
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 100,
        runTimeoutGraceMs: 100,
        probeActivity: probe,
      })
      await startAndExpire(d, 10)
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(1000)
      expect(client.requests[0]!.signal.aborted).toBe(false)
      expect(d.consumeTimeout('t1')).toBe(false)
      expect(probe).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('cancel 之后看门狗不再把用户取消记成超时失败（宽限定时器也要被 dispose）', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 100,
        runTimeoutGraceMs: 100,
        probeActivity: async () => Date.now(),
      })
      // 到点、探到活跃 ⇒ 进入宽限窗口（当前生效的是**第二个**定时器）。
      await startAndExpire(d, 110)
      expect(d.consumeTimeout('t1')).toBe(false)
      await d.cancel('t1')
      await vi.advanceTimersByTimeAsync(500)
      // 关键：宽限定时器已 dispose ⇒ 不会登记超时（否则取消被记成 timeout 失败）。
      expect(d.consumeTimeout('t1')).toBe(false)
      expect(d.takeTimeoutDetail('t1')).toBeUndefined()
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('未到总时长但持续空闲 ⇒ 巡检提前判 inactivity（真死循环不再白占槽到总上限）', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 10_000,
        runTimeoutGraceMs: 1_000,
        stallCheckMs: 100,
        probeActivity: async () => Date.now() - 5_000,
      })
      const p = d.dispatch(makeReq('t1'), ctx)
      await vi.advanceTimersByTimeAsync(0)
      await p
      // 只推进 150ms（远未到 10s 总上限）就该被巡检拿下。
      await vi.advanceTimersByTimeAsync(150)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      const detail = d.takeTimeoutDetail('t1')
      expect(detail).toMatchObject({ kind: 'inactivity', extended: false })
      expect(detail!.ranMs).toBeLessThan(10_000)
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('巡检期间持续有活动 ⇒ 不提前杀，只在总时长 + 宽限后终止（cap）', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      let probes = 0
      const d = new RequirementDispatcher(client, 1, {
        runTimeoutMs: 1_000,
        runTimeoutGraceMs: 200,
        stallCheckMs: 50,
        probeActivity: async () => {
          probes += 1
          return Date.now()
        },
      })
      const p = d.dispatch(makeReq('t1'), ctx)
      await vi.advanceTimersByTimeAsync(0)
      await p
      // 一路巡检到总时长上限：始终活跃 ⇒ 不能杀。
      await vi.advanceTimersByTimeAsync(1_050)
      expect(client.requests[0]!.signal.aborted).toBe(false)
      expect(probes).toBeGreaterThan(3)
      // 宽限期满才终止。
      await vi.advanceTimersByTimeAsync(300)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      expect(d.takeTimeoutDetail('t1')).toMatchObject({ kind: 'cap', extended: true })
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('超时诊断文案（shared/run-timeout）', () => {
  it('formatDuration 分钟/小时口径', () => {
    expect(formatDuration(30_000)).toBe('不到 1 分钟')
    expect(formatDuration(28 * MIN)).toBe('28 分钟')
    expect(formatDuration(90 * MIN)).toBe('1 小时 30 分钟')
    expect(formatDuration(120 * MIN)).toBe('2 小时')
  })

  it('inactivity ⇒ 明说"无任何新事件"，指向轨迹末尾', () => {
    const text = describeRunTimeout({ kind: 'inactivity', ranMs: 62 * MIN, lastActivityAgoMs: 41 * MIN, extended: false })
    expect(text).toContain('62 分钟')
    expect(text).toContain('41 分钟')
    expect(text).toContain('失控空转')
    expect(text).toContain('轨迹末尾')
    expect(text).not.toContain('请调大')
  })

  it('cap ⇒ 明说"不是空转，是任务比上限更久"，并给出可操作建议', () => {
    const text = describeRunTimeout({ kind: 'cap', ranMs: 152 * MIN, lastActivityAgoMs: 20_000, extended: true })
    expect(text).toContain('2 小时 32 分钟')
    expect(text).toContain('不是空转')
    expect(text).toContain('runTimeoutMinutes')
    // 不再出现旧文案那种无根据的断言。
    expect(text).not.toContain('可能存在死循环')
  })

  it('无证据 ⇒ 只陈述"超过上限"，不做归因', () => {
    const text = describeRunTimeout(undefined)
    expect(text).toContain('超过看门狗上限')
    expect(text).not.toContain('死循环')
    expect(text).not.toContain('空转并已终止')
  })

  it('所有分支都提示产出已保留（避免用户以为白跑）', () => {
    for (const evidence of [
      undefined,
      { kind: 'cap' as const, ranMs: MIN, extended: false },
      { kind: 'inactivity' as const, ranMs: MIN, lastActivityAgoMs: MIN, extended: false },
    ]) {
      expect(describeRunTimeout(evidence)).toContain('执行过程')
    }
  })
})

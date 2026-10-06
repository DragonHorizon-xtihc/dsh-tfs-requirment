/**
 * D4–D7 修复机制的可执行回归测试。
 *
 * 背景：本环境 deepseek/arkcode 两条 LLM 路由密钥均无效（AUTH），无法完成
 * 「派发 → 子会话真实产出」的在线闭环，因此对不依赖 LLM 的修复机制
 * （取消收口、子会话释放、turn 级轨迹切片、无会话前置阻断）用单元测试做真实可执行验证。
 * 这些用例会被 vitest 真实运行并断言行为，区别于「只凭代码推断」。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { filterEventsForTurn } from '../src/host/trace-mapper.js'
import { gateProbeByParent } from '../src/host/api.js'
import {
  drainChildrenOn,
  interruptChildOn,
  type SubagentProbeResult,
} from '../src/host/subagent-access.js'
import { OrchestratorSessionManager } from '../src/host/orchestrator-session.js'

/** 事件信封（与 task-trace-mapper.spec.ts 同形）。 */
function evt(type: string, seq: number, data: unknown) {
  return { type, seq, time: 1_700_000_000_000 + seq * 1000, data }
}
const turnStart = (seq: number, turn: number) => evt('turn/start', seq, { turn })
const turnEnd = (seq: number, turn: number) => evt('turn/end', seq, { turn })
const turnTool = (seq: number, turn: number) => evt('tool/call', seq, { turn, callId: `c${seq}` })

// ───────────────────────────────── D6 ─────────────────────────────────

describe('D6 filterEventsForTurn：复用子会话轨迹按 turn 隔离', () => {
  // 三个 turn：turn1[1-3]、turn2[4-6]、turn3 live[7-8]，故意打乱传入顺序。
  const events = [
    turnTool(8, 3),
    turnEnd(6, 2),
    turnStart(1, 1),
    turnTool(2, 1),
    turnStart(4, 2),
    turnTool(5, 2),
    turnStart(7, 3),
    turnEnd(3, 1),
  ]

  it('切出中间轮：只含 [start..end]，排除其它轮（下界用上一轮 end）', () => {
    const got = filterEventsForTurn(events, 2).map(e => (e as { seq: number }).seq)
    expect(got).toEqual([4, 5, 6])
  })

  it('切出首轮：无上一轮 end，下界取 start 前一个 seq', () => {
    const got = filterEventsForTurn(events, 1).map(e => (e as { seq: number }).seq)
    expect(got).toEqual([1, 2, 3])
  })

  it('live 轮（无 turn/end）：从上一轮 end 之后取到目前', () => {
    const got = filterEventsForTurn(events, 3).map(e => (e as { seq: number }).seq)
    expect(got).toEqual([7, 8])
  })

  it('降级一：缺 turn/start 但有 data.turn ⇒ 保留所有 data.turn===turn 的事件', () => {
    const noStart = [
      turnTool(2, 1),
      turnEnd(3, 1),
      turnTool(5, 2),
      turnEnd(6, 2),
    ]
    const got = filterEventsForTurn(noStart, 2).map(e => (e as { seq: number }).seq)
    expect(got).toEqual([5, 6]) // tool/call 与 turn/end 均 data.turn===2
  })

  it('降级二：完全无法判定（无 start、无 data.turn）⇒ 原样返回全部，避免轨迹空白', () => {
    const unknown = [evt('message', 1, {}), evt('message', 2, {})]
    const got = filterEventsForTurn(unknown, 2)
    expect(got).toHaveLength(2)
  })
})

// ───────────────────────────────── D7 ─────────────────────────────────

describe('D7 gateProbeByParent：无顶层会话时前置阻断派发', () => {
  const okProbe: SubagentProbeResult = { available: true, providers: ['spawn'] }

  it('服务可达且有顶层会话 ⇒ 原样放行', () => {
    const out = gateProbeByParent(okProbe, () => ({ id: 'parent' }))
    expect(out).toBe(okProbe)
  })

  it('服务可达但无顶层会话（getParent 抛错）⇒ 降级 available:false + 可操作提示', () => {
    const out = gateProbeByParent(okProbe, () => {
      throw new Error('no top-level agent')
    })
    expect(out.available).toBe(false)
    expect(out.providers).toEqual(['spawn'])
    expect(out.reason).toMatch(/请先在主会话/)
    expect(out.reason).toMatch(/no top-level agent/)
  })

  it('服务本身不可达 ⇒ 原样返回，不再调用 getParent', () => {
    let called = false
    const badProbe: SubagentProbeResult = { available: false, providers: [], reason: 'down' }
    const out = gateProbeByParent(badProbe, () => {
      called = true
      return {}
    })
    expect(out).toBe(badProbe)
    expect(called).toBe(false)
  })
})

// ───────────────────── D5 / D4 subagent-access helper ─────────────────────

function makeCtx(service: unknown): Context {
  return {
    get: (name: string) => (name === 'subagents' ? service : undefined),
    on: () => () => {},
  } as unknown as Context
}

describe('D5 interruptChildOn：复用任务取消时请求宿主中断当前轮', () => {
  it('服务支持 interrupt ⇒ 以 ancestor 授权调用并返回 true', () => {
    const calls: unknown[][] = []
    const service = { interrupt: (...a: unknown[]) => void calls.push(a) }
    const authority = { id: 'parent-agent' }
    const ok = interruptChildOn(makeCtx(service), 'child-1', authority as never)
    expect(ok).toBe(true)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe('child-1')
    expect(calls[0]?.[1]).toEqual({ kind: 'ancestor', agent: authority })
  })

  it('服务缺 interrupt 方法（旧宿主）⇒ 返回 false，调用方降级为仅本地收口', () => {
    expect(interruptChildOn(makeCtx({}), 'child-1', {} as never)).toBe(false)
    expect(interruptChildOn(makeCtx(undefined), 'child-1', {} as never)).toBe(false)
  })
})

describe('D4 drainChildrenOn：还原需求时释放 continuable 子会话', () => {
  it('服务支持 drainChildren ⇒ 以 (parent, ids) 调用', async () => {
    const calls: unknown[][] = []
    const service = { drainChildren: async (...a: unknown[]) => void calls.push(a) }
    const parent = { id: 'parent' }
    await drainChildrenOn(makeCtx(service), parent as never, ['c1', 'c2'])
    expect(calls).toHaveLength(1)
    expect(calls[0]?.[0]).toBe(parent)
    expect(calls[0]?.[1]).toEqual(['c1', 'c2'])
  })

  it('服务缺 drainChildren（旧宿主）⇒ 抛可读错误，由调用方 best-effort 处理', async () => {
    await expect(drainChildrenOn(makeCtx({}), {} as never, ['c1'])).rejects.toThrow(/drainChildren/)
  })
})

// ───────────────── D5 / D4 OrchestratorSessionManager 方法 ─────────────────

function makeManager(service: unknown, getParent: () => unknown) {
  const deps = {
    ctx: makeCtx(service),
    getParent,
    provider: 'spawn',
    enabled: true,
    summarizeTimeoutMs: 1000,
    finalizeTimeoutMs: 1000,
    taskSettleTimeoutMs: 1000,
  }
  return new OrchestratorSessionManager(deps as never)
}

describe('D5 cancelReusedTask：复用任务取消的完整收口', () => {
  it('非复用任务（无注册现场）⇒ 返回 false，调用方回退 ONE-SHOT 取消', () => {
    const m = makeManager({}, () => ({ id: 'p' }))
    expect(m.cancelReusedTask('not-registered')).toBe(false)
  })

  it('命中复用任务 ⇒ 注入 aborted 收口 + abort controller + best-effort 中断子会话', () => {
    const interruptCalls: unknown[][] = []
    const service = { interrupt: (...a: unknown[]) => void interruptCalls.push(a) }
    const parent = { id: 'parent' }
    const m = makeManager(service, () => parent)

    const injected: unknown[][] = []
    m.watcher.injectSettle = (id: string, r: unknown) => void injected.push([id, r])

    const ac = new AbortController()
    ;(m as unknown as { activeReuse: Map<string, unknown> }).activeReuse.set('t1', {
      childId: 'child-1',
      reuseKey: 'k',
      controller: ac,
    })

    const ok = m.cancelReusedTask('t1')
    expect(ok).toBe(true)
    // ① 等待以 aborted 立即收口
    expect(injected).toHaveLength(1)
    expect(injected[0]?.[0]).toBe('child-1')
    expect(injected[0]?.[1]).toMatchObject({ stopReason: 'aborted', diagnostic: '任务已被用户取消' })
    // ② controller 已 abort
    expect(ac.signal.aborted).toBe(true)
    // ③ best-effort 中断子会话当前轮
    expect(interruptCalls).toHaveLength(1)
    expect(interruptCalls[0]?.[0]).toBe('child-1')
    expect(interruptCalls[0]?.[1]).toEqual({ kind: 'ancestor', agent: parent })
  })

  it('中断子会话抛错（授权失败）时不影响本地收口，仍返回 true', () => {
    const service = { interrupt: () => { throw new Error('UNAUTHORIZED') } }
    const m = makeManager(service, () => ({ id: 'p' }))
    m.watcher.injectSettle = () => {}
    const ac = new AbortController()
    ;(m as unknown as { activeReuse: Map<string, unknown> }).activeReuse.set('t2', {
      childId: 'child-2',
      reuseKey: 'k',
      controller: ac,
    })
    expect(m.cancelReusedTask('t2')).toBe(true)
    expect(ac.signal.aborted).toBe(true)
  })
})

describe('D4 drainRequirementSessions：还原需求时批量释放子会话', () => {
  it('空列表 ⇒ 返回 undefined（不解析父会话、不发请求）', async () => {
    const m = makeManager({}, () => ({ id: 'p' }))
    expect(await m.drainRequirementSessions([])).toBeUndefined()
  })

  it('无法解析父会话 ⇒ 返回可读原因，不阻断还原', async () => {
    const m = makeManager({}, () => { throw new Error('parent gone') })
    const reason = await m.drainRequirementSessions(['c1'])
    expect(reason).toMatch(/无法解析父会话/)
    expect(reason).toMatch(/parent gone/)
  })

  it('全部释放成功 ⇒ undefined（去重后逐个调用）', async () => {
    const ids: string[] = []
    const service = { drainChildren: async (_p: unknown, childIds: readonly string[]) => void ids.push(...childIds) }
    const m = makeManager(service, () => ({ id: 'p' }))
    expect(await m.drainRequirementSessions(['c1', 'c1', 'c2'])).toBeUndefined()
    expect(ids).toEqual(['c1', 'c2'])
  })

  it('部分失败 ⇒ 聚合失败 id 与原因，不抛错', async () => {
    const service = {
      drainChildren: async (_p: unknown, childIds: readonly string[]) => {
        if (childIds[0] === 'bad') throw new Error('UNAUTHORIZED')
      },
    }
    const m = makeManager(service, () => ({ id: 'p' }))
    const reason = await m.drainRequirementSessions(['bad', 'good'])
    expect(reason).toMatch(/部分子会话释放失败/)
    expect(reason).toMatch(/bad/)
    expect(reason).not.toMatch(/good:/)
  })
})

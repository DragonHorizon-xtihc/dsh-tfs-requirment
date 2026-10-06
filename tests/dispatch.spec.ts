import { describe, expect, it, vi } from 'vitest'
import {
  RequirementDispatcher,
  DispatchError,
  resolveFrozenModelRoute,
  type DispatchRequest,
  type DispatchContext,
  type SubagentClient,
} from '../src/orchestration/dispatch.js'
import { DEFAULT_ROLES } from '../src/orchestration/roles.js'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { SubagentStartRequest, SubagentRun, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'

/**
 * 需求并发分发器单测（T026 子集 + S-06 信号量 / S-09 每需求 run 追踪）。
 *
 * 用假 SubagentClient 模拟 `ctx.subagents.start`，断言：
 *  - maxConcurrent 并发上限与 FIFO 排队释放；
 *  - 每需求 runId 聚合（runsForRequirement）；
 *  - cancel 清理追踪集合（修正 byRequirement 以 requirementId 为键的 lookup bug）；
 *  - maxConcurrent < 1 构造即抛 DispatchError。
 */

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
  readonly starts: Array<{ name: string; label: string }> = []
  /** 逐个记录传入 client.start 的完整请求（断言 parent / agentOptions 用）。 */
  readonly requests: SubagentStartRequest[] = []
  readonly runs: FakeRun[] = []
  private next = 0
  async start(_name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const run = new FakeRun(`run-${++this.next}`)
    this.starts.push({ name: _name, label: request.label ?? '' })
    this.requests.push(request)
    this.runs.push(run)
    return run
  }
}

function makeReq(taskId: string, requirementId = 'r1'): DispatchRequest {
  return {
    requirementId,
    taskId,
    role: DEFAULT_ROLES[0]!,
    frozenConfig: { mcp: ['tfs-mcp'], skills: [], model: 'deepseek-v4-flash' },
    prompt: [{ type: 'text', text: 'execute' }] as unknown as ContentBlock[],
  }
}

function ctx(): DispatchContext {
  return { parent: {} as unknown as Agent }
}

describe('构造校验', () => {
  it('maxConcurrent < 1 抛 DispatchError', () => {
    const client = new FakeClient()
    expect(() => new RequirementDispatcher(client, 0)).toThrow(DispatchError)
  })
})

describe('信号量 + FIFO（S-06）', () => {
  it('超额进入 FIFO 排队，释放后才启动下一个', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 2)
    const p1 = d.dispatch(makeReq('t1'), ctx())
    const p2 = d.dispatch(makeReq('t2'), ctx())
    const p3 = d.dispatch(makeReq('t3'), ctx())
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1.taskId).toBe('t1')
    expect(r2.taskId).toBe('t2')
    // 仅 2 个拿到并发槽，t3 排队
    expect(client.starts).toHaveLength(2)
    expect(d.activeCount).toBe(2)
    expect(d.queuedCount).toBe(1)
    // 释放 t1 → t3 获得槽（FIFO：t3 在 t2 之后）
    client.runs[0]!.resolve()
    const r3 = await p3
    expect(r3.taskId).toBe('t3')
    expect(client.starts.map(s => s.label)).toEqual(['r1:t1', 'r1:t2', 'r1:t3'])
  })

  it('并发上限严控：第 4 个在 3 槽占满时排队', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 3)
    const ps = [makeReq('a'), makeReq('b'), makeReq('c'), makeReq('d')].map(r => d.dispatch(r, ctx()))
    await Promise.all(ps.slice(0, 3))
    expect(client.starts).toHaveLength(3)
    expect(d.queuedCount).toBe(1)
    client.runs.forEach(run => run.resolve())
    await ps[3]
    expect(client.starts).toHaveLength(4)
  })
})

describe('每需求 run 追踪（S-09）', () => {
  it('runsForRequirement 聚合该需求下全部 runId', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 5)
    const ps = [makeReq('t1', 'reqX'), makeReq('t2', 'reqX'), makeReq('t3', 'reqY')].map(r =>
      d.dispatch(r, ctx()),
    )
    await Promise.all(ps)
    expect(d.runsForRequirement('reqX').sort()).toEqual(['run-1', 'run-2'])
    expect(d.runsForRequirement('reqY')).toEqual(['run-3'])
    expect(d.runsForRequirement('nope')).toEqual([])
  })
})

describe('cancel 清理追踪（修正 byRequirement 键 bug）', () => {
  it('cancel 后 runs 与 byRequirement 均移除该任务', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 5)
    await d.dispatch(makeReq('t1', 'reqX'), ctx())
    expect(d.runsForRequirement('reqX')).toEqual(['run-1'])
    await d.cancel('t1')
    expect(d.runsForRequirement('reqX')).toEqual([])
  })
})

/**
 * 2026-09-21 假执行修复的配套断言：
 * 分发器必须**原样透传**调用方给的 parent（它现在由 `host/parent-resolver` 解析为真实
 * Agent），并且不能把空模型名透给宿主（`resolveChildAgentOptions` 是覆盖式合并，
 * 空串会顶掉父会话解析出的模型路由）。
 */
describe('parent 透传与模型路由（2026-09-21）', () => {
  it('parent 原样传给 client.start（分发器不自造 parent）', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1)
    const parent = { id: 'real-agent' } as unknown as Agent
    await d.dispatch(makeReq('t1'), { parent })
    expect(client.requests[0]!.parent).toBe(parent)
  })

  it('frozenConfig.model 为空串时不传 model 字段', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1)
    const req = makeReq('t1')
    req.frozenConfig = { mcp: [], skills: [], model: '' }
    await d.dispatch(req, ctx())
    expect(client.requests[0]!.agentOptions).not.toHaveProperty('model')
  })

  it('frozenConfig.model 有值时原样透传（裸 model 不带 provider，维持旧继承语义）', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1)
    await d.dispatch(makeReq('t1'), ctx())
    expect(client.requests[0]!.agentOptions).toMatchObject({ model: 'deepseek-v4-flash' })
    expect(client.requests[0]!.agentOptions).not.toHaveProperty('provider')
  })

  it('spec 009：model 与 modelProvider 成对时 provider 一起下发（火山方舟不再掉包成英伟达）', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1)
    const req = makeReq('t1')
    req.frozenConfig = {
      mcp: [],
      skills: [],
      model: 'deepseek-v4-flash',
      modelProvider: 'arkcode',
    }
    await d.dispatch(req, ctx())
    expect(client.requests[0]!.agentOptions).toEqual({
      model: 'deepseek-v4-flash',
      provider: 'arkcode',
    })
  })

  it('spec 009：model 为空时即使带了 provider 也不下发任何路由键（禁止悬空 provider）', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1)
    const req = makeReq('t1')
    req.frozenConfig = { mcp: [], skills: [], model: '   ', modelProvider: 'arkcode' }
    await d.dispatch(req, ctx())
    expect(client.requests[0]!.agentOptions).not.toHaveProperty('model')
    expect(client.requests[0]!.agentOptions).not.toHaveProperty('provider')
  })
})

describe('resolveFrozenModelRoute（spec 009 回落表）', () => {
  it('冻结配置带 model + provider：原样成对返回', () => {
    expect(
      resolveFrozenModelRoute({
        frozen: { model: 'm1', modelProvider: 'arkcode' },
        role: { defaultModel: 'role-m', defaultModelProvider: 'nvida' },
      }),
    ).toEqual({ model: 'm1', modelProvider: 'arkcode' })
  })

  it('冻结配置有裸 model（历史数据）：不跨层借用角色 provider，返回无 provider 的 model', () => {
    expect(
      resolveFrozenModelRoute({
        frozen: { model: 'm1' },
        role: { defaultModel: 'role-m', defaultModelProvider: 'arkcode' },
      }),
    ).toEqual({ model: 'm1' })
  })

  it('冻结 model 为空、角色默认成对：回落角色层并成对返回', () => {
    expect(
      resolveFrozenModelRoute({
        frozen: { model: '', modelProvider: '' },
        role: { defaultModel: '  role-m  ', defaultModelProvider: '  arkcode  ' },
      }),
    ).toEqual({ model: 'role-m', modelProvider: 'arkcode' })
  })

  it('角色只有裸 defaultModel：返回无 provider 的 model（旧 roles.json 兼容）', () => {
    expect(resolveFrozenModelRoute({ frozen: { model: '' }, role: { defaultModel: 'role-m' } })).toEqual({
      model: 'role-m',
    })
  })

  it('两层都为空：返回空 model 且无 provider 键（完全继承父会话）', () => {
    expect(resolveFrozenModelRoute({ frozen: { model: '' }, role: { defaultModel: '   ' } })).toEqual({
      model: '',
    })
  })

  it('入参全缺省时安全返回空路由', () => {
    expect(resolveFrozenModelRoute({})).toEqual({ model: '' })
  })

  it('provider trim 后为空串视为未绑定，不返回该键', () => {
    expect(
      resolveFrozenModelRoute({ frozen: { model: 'm1', modelProvider: '   ' } }),
    ).toEqual({ model: 'm1' })
  })
})

/**
 * 问题 1：执行预算下发 + 总时长看门狗。
 *  - maxTokens / maxDepth：任务级优先，缺省由分发器默认兜底，都为 0 则不下发（= 不限制）；
 *  - runTimeoutMs：run 超时未结则 abort 子 agent 信号、登记一次性超时标记（供收口判 timeout）。
 */
describe('问题 1：执行预算透传（maxTokens / maxDepth）', () => {
  it('任务级 maxTokens 优先于分发器默认', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1, { defaultMaxTokens: 100 })
    const req = makeReq('t1')
    req.maxTokens = 500
    await d.dispatch(req, ctx())
    expect(client.requests[0]!.agentOptions).toMatchObject({ maxTokens: 500 })
  })

  it('任务级缺省时用分发器默认 maxTokens 兜底', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1, { defaultMaxTokens: 100 })
    await d.dispatch(makeReq('t1'), ctx())
    expect(client.requests[0]!.agentOptions).toMatchObject({ maxTokens: 100 })
  })

  it('两层都为 0 时不下发 maxTokens（= 不限制，避免误压正常回复）', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1)
    await d.dispatch(makeReq('t1'), ctx())
    expect(client.requests[0]!.agentOptions).not.toHaveProperty('maxTokens')
  })

  it('任务级 maxDepth 优先于分发器默认', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1, { defaultMaxDepth: 2 })
    const req = makeReq('t1')
    req.maxDepth = 3
    await d.dispatch(req, ctx())
    expect(client.requests[0]!.maxDepth).toBe(3)
  })

  it('任务级缺省时用分发器默认 maxDepth 兜底（防孙 agent 无限派生）', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1, { defaultMaxDepth: 1 })
    await d.dispatch(makeReq('t1'), ctx())
    expect(client.requests[0]!.maxDepth).toBe(1)
  })

  it('两层都为 0 时不下发 maxDepth', async () => {
    const client = new FakeClient()
    const d = new RequirementDispatcher(client, 1)
    await d.dispatch(makeReq('t1'), ctx())
    expect(client.requests[0]).not.toHaveProperty('maxDepth')
  })
})

describe('问题 1：run 总时长看门狗', () => {
  it('超过 runTimeoutMs 未结则 abort 信号并登记一次性超时标记', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1, { runTimeoutMs: 50 })
      const p = d.dispatch(makeReq('t1'), ctx())
      // 仅 flush 启动链 microtask（不推进 50ms 看门狗），dispatch 拿到 run 句柄即返回。
      await vi.advanceTimersByTimeAsync(0)
      await expect(p).resolves.toMatchObject({ taskId: 't1' })
      expect(client.requests[0]!.signal.aborted).toBe(false)
      // 推进超过看门狗阈值：子 agent 信号被 abort。
      await vi.advanceTimersByTimeAsync(60)
      expect(client.requests[0]!.signal.aborted).toBe(true)
      // 收口侧通过 consumeTimeout 一次性消费该标记（消费后即清除，不重复判 timeout）。
      expect(d.consumeTimeout('t1')).toBe(true)
      expect(d.consumeTimeout('t1')).toBe(false)
      // 让 run 落定、释放并发槽，避免悬挂。
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })

  it('runTimeoutMs 缺省（0）时不装看门狗，run 不会被 abort', async () => {
    vi.useFakeTimers()
    try {
      const client = new FakeClient()
      const d = new RequirementDispatcher(client, 1)
      const p = d.dispatch(makeReq('t1'), ctx())
      await vi.advanceTimersByTimeAsync(0)
      await p
      await vi.advanceTimersByTimeAsync(10_000)
      expect(client.requests[0]!.signal.aborted).toBe(false)
      expect(d.consumeTimeout('t1')).toBe(false)
      client.runs[0]!.resolve()
      await vi.advanceTimersByTimeAsync(0)
    } finally {
      vi.useRealTimers()
    }
  })
})

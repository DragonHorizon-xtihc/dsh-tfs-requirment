/**
 * `host/subagent-access.ts` 回归测试（2026-09-21 事故 + 2026-10-29 API 换代）。
 *
 * ## 复现的三个缺陷
 *
 * 1. **apply 期捕获**：旧实现 `apply()` 里 `const sub = ctx.get('subagents')` 一次定终身。
 *    cordis 的 `ctx.get(name)` 默认严格模式，在提供方 fiber 激活前返回 `undefined`
 *    （`vendor/cordis/lib/index.js:762-771`），而本插件 `inject = []`、apply 又极早 ⇒
 *    分发器被永久钉成"永远抛错的桩"（实机 board.json 里有该 attempt 记录）。
 * 2. **丢接收者**：`const start = sub.start; start(...)` 丢掉 `this` ⇒ `TypeError`
 *    （服务方法要用 `this.providers`）。与缺陷 1 的报错完全不同，不能混淆。
 * 3. **API 换代（2026-10-29 实机）**：宿主 0.2.1-rc.2 的 `SubagentRuntime`
 *    **没有 `start` / `startContinuable`**，只有 `startActivation(spec)`
 *    （`packages/subagent/subagent/src/index.ts:194-290`）。插件的探针只认 `start`
 *    ⇒ 面板永久报 *「subagents 服务缺少 start 方法（宿主版本不匹配？）」*、派发按钮被禁用。
 *    因此本文件同时锁住"两代 API 都能派发"与"探测与派发同源"。
 *
 * 下面的 Context 桩**模仿 cordis 的严格 get 语义**（未激活 ⇒ undefined），
 * 因此"先建 client、后激活服务"的顺序能真实检验惰性解析。
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import {
  createSubagentClient,
  probeSubagents,
  resolveSubagents,
  startContinuableOn,
} from '../src/host/subagent-access.js'

/**
 * 形如**旧宿主**（≤0.2.0）的服务桩：`start` 依赖 `this.providers`，
 * 一旦接收者丢失就会抛 TypeError（用于验证"保留接收者"这条纪律）。
 */
class FakeLegacyRuntime {
  private readonly providers = new Map<string, string>([['spawn', 'in-process'], ['fork', 'in-process']])

  list(): string[] {
    return [...this.providers.keys()]
  }

  start(name: string, _request: SubagentStartRequest): SubagentRun {
    const impl = this.providers.get(name)
    if (impl === undefined) throw new Error(`unknown subagent provider "${name}"`)
    return { id: `run:${name}:${impl}` } as unknown as SubagentRun
  }
}

/**
 * 形如**现行宿主**（0.2.1+）的服务桩：只有 `startActivation`，没有 `start`。
 *
 * `startActivation` 依赖 `this.providers`（与宿主 `expectProvider` 同构），
 * 因此也能验证接收者保留。
 */
class FakeActivationRuntime {
  private readonly providers = new Map<string, string>([['spawn', 'in-process'], ['fork', 'in-process']])

  /** 记录每次 startActivation 的入参（断言 spec 形状用）。 */
  readonly calls: Array<Record<string, unknown>> = []

  list(): string[] {
    return [...this.providers.keys()]
  }

  startActivation(spec: {
    provider: string
    label: string
    request: Record<string, unknown>
    signal: AbortSignal
    delivery: 'parent' | 'caller'
  }): {
    childId: string
    messageId: string
    result: Promise<{ output: never[]; stopReason: 'completed' }>
    dispose: () => Promise<void>
  } {
    const impl = this.providers.get(spec.provider)
    if (impl === undefined) throw new Error(`no subagent provider registered for "${spec.provider}"`)
    this.calls.push(spec as unknown as Record<string, unknown>)
    return {
      childId: `child:${spec.provider}:${impl}`,
      messageId: 'msg-1',
      result: Promise.resolve({ output: [], stopReason: 'completed' as const }),
      dispose: () => Promise.resolve(),
    }
  }
}

/**
 * Context 桩：`active=false` 时 `get()` 返回 undefined（等价于 cordis 的"fiber 未激活"）。
 * @param held - 服务实例（用对象包装，便于测试中途切换）。
 * @returns 桩 ctx。
 */
function makeCtx(held: { service?: unknown }): Context {
  return {
    get: (name: string, strict = true) => {
      if (name !== 'subagents') return undefined
      if (strict && held.service === undefined) return undefined
      return held.service
    },
  } as unknown as Context
}

describe('subagent-access：调用期解析 subagents 服务', () => {
  it('apply 期服务未激活 ⇒ 不在那一刻定论；激活后 start 能真正打达服务（核心回归）', async () => {
    const held: { service?: unknown } = {} // 等价于"插件的 apply 已跑完，但 subagent fiber 还没激活"
    const client = createSubagentClient(makeCtx(held))

    // apply 期（此处）解析不到 —— 这正是旧实现永久降级的触发条件。
    expect(resolveSubagents(makeCtx(held))).toBeUndefined()

    // 宿主随后完成装载（fiber 激活）。
    held.service = new FakeLegacyRuntime()

    const run = await client.start('spawn', { parent: {} } as unknown as SubagentStartRequest)
    expect(run.id).toBe('run:spawn:in-process')
  })

  it('旧宿主 start 必须保留接收者：丢 `this` 的实现会在这里抛 TypeError', () => {
    const held = { service: new FakeLegacyRuntime() as unknown }
    const client = createSubagentClient(makeCtx(held))
    expect(client.start('fork', {} as unknown as SubagentStartRequest)).toMatchObject({
      id: 'run:fork:in-process',
    })
  })

  it('服务始终不可用 ⇒ 抛出可执行的中文原因（含缺哪个包）', () => {
    const client = createSubagentClient(makeCtx({}))
    expect(() => client.start('spawn', {} as unknown as SubagentStartRequest)).toThrow(/subagents 服务不可用/)
    expect(() => client.start('spawn', {} as unknown as SubagentStartRequest)).toThrow(/dsh-subagent/)
  })

  it('两代 API 都没有 ⇒ 报"结构异常"，不误报成"服务不可用"', () => {
    const client = createSubagentClient(makeCtx({ service: { list: () => [] } }))
    expect(() => client.start('spawn', {} as unknown as SubagentStartRequest)).toThrow(/结构异常/)
    expect(() => client.start('spawn', {} as unknown as SubagentStartRequest)).toThrow(/startActivation/)
  })
})

describe('subagent-access：现行宿主 startActivation 适配（2026-10-29）', () => {
  it('只有 startActivation 也能派发，并把 childId 归一成 run.id', async () => {
    const runtime = new FakeActivationRuntime()
    const client = createSubagentClient(makeCtx({ service: runtime }))
    const run = await client.start('spawn', {
      prompt: [{ type: 'text', text: 'do it' }],
      parent: {},
      signal: new AbortController().signal,
      label: 'tag-1',
    } as unknown as SubagentStartRequest)

    expect(run.id).toBe('child:spawn:in-process')
    // result/dispose 必须透传：分发器的收口、看门狗终止都依赖它们。
    await expect(run.result).resolves.toMatchObject({ stopReason: 'completed' })
    await expect(run.dispose()).resolves.toBeUndefined()
  })

  it('spec 形状与宿主一致：label/signal 上提到 spec 层，request 里不再重复', async () => {
    const runtime = new FakeActivationRuntime()
    const client = createSubagentClient(makeCtx({ service: runtime }))
    const ac = new AbortController()
    await client.start('fork', {
      prompt: [{ type: 'text', text: 'x' }],
      parent: {},
      signal: ac.signal,
      label: 'task-1',
    } as unknown as SubagentStartRequest)

    const call = runtime.calls[0]!
    expect(call['provider']).toBe('fork')
    expect(call['label']).toBe('task-1')
    expect(call['signal']).toBe(ac.signal)
    // `delivery:'caller'`：任务结果由看板收口，不往父聊天里逐条投结算消息。
    expect(call['delivery']).toBe('caller')
    const request = call['request'] as Record<string, unknown>
    expect(request['label']).toBeUndefined()
    expect(request['signal']).toBeUndefined()
    expect(request['prompt']).toEqual([{ type: 'text', text: 'x' }])
  })

  it('startContinuableOn 在现行宿主上退化为 startActivation（同一 provider 语义）', async () => {
    const runtime = new FakeActivationRuntime()
    const started = await startContinuableOn(makeCtx({ service: runtime }), {
      provider: 'spawn',
      label: '编排 1@WN_HIS',
      request: { prompt: [{ type: 'text', text: 'boot' }], parent: {} } as never,
      signal: new AbortController().signal,
    })
    expect(started.childId).toBe('child:spawn:in-process')
    expect(runtime.calls[0]!['delivery']).toBe('caller')
  })

  it('startContinuableOn 缺两代 API ⇒ 抛"不支持 continuable"的可读错误', async () => {
    await expect(
      startContinuableOn(makeCtx({ service: { list: () => [] } }), {
        provider: 'spawn',
        label: 'x',
        request: { prompt: [], parent: {} } as never,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/continuable/)
  })

  it('dispose 缺失时不抛（旧形状兼容）', async () => {
    const service = {
      startActivation: async () => ({
        childId: 'c1',
        result: Promise.resolve({ output: [], stopReason: 'completed' }),
      }),
    }
    const client = createSubagentClient(makeCtx({ service }))
    const run = await client.start('spawn', {} as unknown as SubagentStartRequest)
    await expect(run.dispose()).resolves.toBeUndefined()
  })

  it('provider 不支持独立 preset（如 fork）⇒ 抛可操作中文原因，不留给宿主一句英文错误', async () => {
    const service = {
      startActivation: vi.fn(),
      getProvider: () => ({ capabilities: { agentPreset: false }, inheritsParentContext: true }),
    }
    const client = createSubagentClient(makeCtx({ service }))
    // 同步抛（派发器的 try/catch 会把任何同步抛转成「分发失败」的可读原因）。
    expect(() => client.start('fork', { agentPreset: 'p1' } as unknown as SubagentStartRequest))
      .toThrow(/不支持为子 agent 单独指定预设/)
    expect(service.startActivation).not.toHaveBeenCalled()
  })

  it('provider 支持独立 preset ⇒ 正常下发 agentPreset', async () => {
    const runtime = new FakeActivationRuntime()
    const withCaps = Object.assign(runtime, {
      getProvider: () => ({ capabilities: { agentPreset: true }, inheritsParentContext: false }),
    })
    const client = createSubagentClient(makeCtx({ service: withCaps }))
    await client.start('spawn', {
      prompt: [],
      parent: {},
      signal: new AbortController().signal,
      agentPreset: 'p1',
    } as unknown as SubagentStartRequest)
    expect((runtime.calls[0]!['request'] as Record<string, unknown>)['agentPreset']).toBe('p1')
  })
})

describe('probeSubagents：面板用的可达性探测', () => {
  it('未激活 ⇒ available:false 且带原因；激活后 ⇒ available:true + 真实 provider 清单', () => {
    const held: { service?: unknown } = {}
    expect(probeSubagents(makeCtx(held))).toMatchObject({ available: false })

    held.service = new FakeLegacyRuntime()
    expect(probeSubagents(makeCtx(held))).toMatchObject({
      available: true,
      providers: ['spawn', 'fork'],
      api: 'start',
    })
  })

  it('现行宿主（只有 startActivation）⇒ available:true（本次修复的核心断言）', () => {
    const result = probeSubagents(makeCtx({ service: new FakeActivationRuntime() }))
    expect(result).toMatchObject({ available: true, providers: ['spawn', 'fork'], api: 'startActivation' })
    expect(result.reason).toBeUndefined()
  })

  it('服务可达但方法调用失败 ⇒ available:false 并透出原因（不静默当成功）', () => {
    const service = {
      startActivation: vi.fn(),
      list: () => {
        throw new Error('boom')
      },
    }
    const result = probeSubagents(makeCtx({ service }))
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/boom/)
  })

  it('缺 list 的老版本服务不判为不可用（派发入口才是所需能力）', () => {
    const service = { start: () => ({}) as unknown as SubagentRun }
    expect(probeSubagents(makeCtx({ service }))).toMatchObject({ available: true, providers: [], api: 'start' })
  })

  it('两代 API 都没有 ⇒ 不可用，且原因点明两者都缺（不再误导"重装包"）', () => {
    const result = probeSubagents(makeCtx({ service: { list: () => [] } }))
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/startActivation/)
    expect(result.reason).toMatch(/start/)
  })
})

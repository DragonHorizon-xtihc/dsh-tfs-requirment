import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import {
  canPrepareParent,
  createParentResolver,
  type AgentRegistryLike,
} from '../src/host/parent-resolver.js'

/** Agent 桩：解析器只读 `id`，其余字段由宿主驱动在真实会话上使用。 */
const agent = (id: string): Agent => ({ id }) as unknown as Agent

/** 收集插件注册的事件监听器的 Context 桩。 */
function makeCtx(
  registry: AgentRegistryLike | undefined,
  listeners: Record<string, (payload: unknown) => void> = {},
  sessionController?: unknown,
): Context {
  return {
    get: (name: string) =>
      name === 'agents' ? registry : name === 'sessionController' ? sessionController : undefined,
    on: (name: string, cb: (payload: unknown) => void) => {
      listeners[name] = cb
      return () => {}
    },
  } as unknown as Context
}

describe('createParentResolver：派发用 parent 解析（2026-09-21 假执行修复）', () => {
  it('优先返回 currentInitiator（调用方在 agent 驱动链内时最精确）', () => {
    const initiator = agent('init-1')
    const ctx = makeCtx({
      currentInitiator: () => initiator,
      get: () => agent('recent'),
      roots: () => [agent('root-1')],
    })
    expect(createParentResolver(ctx)()).toBe(initiator)
  })

  it('无 initiator 时返回最近活跃且仍存活的顶层 Agent', () => {
    const listeners: Record<string, (payload: unknown) => void> = {}
    const recent = agent('recent-1')
    const root = agent('root-old')
    const ctx = makeCtx({
      currentInitiator: () => undefined,
      get: (id: string) => (id === 'recent-1' ? recent : undefined),
      roots: () => [root, recent],
    }, listeners)

    const resolve = createParentResolver(ctx)
    // 尚无任何生命周期事件 → 只能兜底到最近注册的顶层会话。
    expect(resolve()).toBe(recent)

    // agent/status=running 把 'recent-2' 记为最近活跃。
    const recent2 = agent('recent-2')
    listeners['agent/status']!({ agent: recent2, status: 'running' })
    // 该 id 尚未出现在 roots 里（未注册）→ 不得采用，仍回退 roots 末尾。
    expect(resolve()).toBe(recent)
  })

  it('捕获的最近活跃 Agent 必须同时是存活的顶层会话，subagent 不得当 parent', () => {
    const listeners: Record<string, (payload: unknown) => void> = {}
    const root = agent('root-1')
    const child = agent('child-1')
    const ctx = makeCtx({
      currentInitiator: () => undefined,
      // child 在注册表里存活，但它不在 roots() 里（它是子 agent）。
      get: (id: string) => (id === 'child-1' ? child : undefined),
      roots: () => [root],
    }, listeners)

    const resolve = createParentResolver(ctx)
    listeners['agent/created']!({ agent: child })
    expect(resolve()).toBe(root)
  })

  it('无 lifecycle 事件时兜底到 roots() 的最后一个顶层会话', () => {
    const ctx = makeCtx({
      currentInitiator: () => undefined,
      roots: () => [agent('r1'), agent('r2')],
    })
    expect(createParentResolver(ctx)().id).toBe('r2')
  })

  it('注册表不可用 → 抛可读错误（绝不返回伪造对象）', () => {
    const ctx = makeCtx(undefined)
    expect(() => createParentResolver(ctx)()).toThrow(/agent 注册表不可用/)
  })

  it('没有任何存活顶层会话 → 抛可读错误，而不是拿 ctx 顶替', () => {
    const ctx = makeCtx({ currentInitiator: () => undefined, roots: () => [] })
    expect(() => createParentResolver(ctx)()).toThrow(/无法获取可用的宿主 Agent 会话/)
  })

  it('事件名在该宿主版本不存在时不影响解析（降级而非崩溃）', () => {
    const ctx = {
      get: () => ({ currentInitiator: () => undefined, roots: () => [agent('r1')] }),
      on: () => {
        throw new Error('unknown event')
      },
    } as unknown as Context
    expect(createParentResolver(ctx)().id).toBe('r1')
  })
})

// ───────────────────── ensure：无活跃会话时现场准备父会话（2026-11-03） ─────────────────────

/**
 * 带 sessionController 的 ctx 桩。
 *
 * `live` 是"注册表里活着的 agent 表"，`create` 成功后要把新会话放进去，
 * 才能复现宿主真实行为（create → agents.get(sessionId) 拿到 live Agent）。
 */
function makeCtxWithSessions(options: {
  live: Map<string, Agent>
  roots: Agent[]
  sessionController: unknown
  listeners?: Record<string, (payload: unknown) => void>
}): Context {
  const { live, roots, sessionController } = options
  const listeners = options.listeners ?? {}
  return makeCtx(
    {
      currentInitiator: () => undefined,
      get: (id: string) => live.get(id),
      roots: () => [...roots],
      list: () => [...live.values()],
    },
    listeners,
    sessionController,
  )
}

describe('ParentResolver.ensure：同步链失败时恢复/新建会话', () => {
  it('同步链能解析时直接返回，且**不碰** sessionController（无副作用）', async () => {
    const root = agent('root-1')
    const create = vi.fn()
    const resolveAgent = vi.fn()
    const ctx = makeCtxWithSessions({
      live: new Map([['root-1', root]]),
      roots: [root],
      sessionController: { create, resolveAgent },
    })
    await expect(createParentResolver(ctx).ensure()).resolves.toBe(root)
    expect(create).not.toHaveBeenCalled()
    expect(resolveAgent).not.toHaveBeenCalled()
  })

  it('① 恢复"上次见过的会话"（resolveAgent），不必新建', async () => {
    const revived = agent('session-9')
    const create = vi.fn()
    const resolveAgent = vi.fn(async () => ({ agent: revived }))
    const live = new Map<string, Agent>()
    const listeners: Record<string, (payload: unknown) => void> = {}
    const ctx = makeCtxWithSessions({
      live,
      roots: [],
      sessionController: { create, resolveAgent },
      listeners,
    })
    const resolver = createParentResolver(ctx)
    // 会话曾被创建过（随后被回收，注册表里已经没有了）。
    listeners['agent/created']!({ agent: agent('session-9') })
    expect(() => resolver()).toThrow(/无法获取可用的宿主 Agent 会话/)

    await expect(resolver.ensure()).resolves.toBe(revived)
    expect(resolveAgent).toHaveBeenCalledWith('session-9')
    expect(create).not.toHaveBeenCalled()
  })

  it('恢复失败（宿主返回 { error }）⇒ 降级为新建会话并取回 live Agent', async () => {
    const created = agent('minted-1')
    const live = new Map<string, Agent>()
    const resolveAgent = vi.fn(async () => ({ error: { code: 'session/not-found' } }))
    const create = vi.fn(async () => {
      live.set('minted-1', created)
      return { sessionId: 'minted-1' }
    })
    const listeners: Record<string, (payload: unknown) => void> = {}
    const ctx = makeCtxWithSessions({ live, roots: [], sessionController: { create, resolveAgent }, listeners })
    const resolver = createParentResolver(ctx)
    listeners['agent/created']!({ agent: agent('dead-1') })

    await expect(resolver.ensure()).resolves.toBe(created)
    expect(create).toHaveBeenCalledTimes(1)
    // 没有合法工作目录 ⇒ 不带 cwd 调用（宿主用默认目录）。
    expect(create).toHaveBeenCalledWith({})
  })

  it('工作目录合法时以它为会话 cwd；宿主拒绝该目录则退回默认目录重试', async () => {
    const created = agent('minted-2')
    const live = new Map<string, Agent>()
    const create = vi.fn(async (request: { cwd?: string }) => {
      if (request.cwd !== undefined) throw new Error('cwd rejected')
      live.set('minted-2', created)
      return { sessionId: 'minted-2' }
    })
    const ctx = makeCtxWithSessions({ live, roots: [], sessionController: { create } })

    await expect(createParentResolver(ctx).ensure(process.cwd())).resolves.toBe(created)
    expect(create).toHaveBeenCalledTimes(2)
    expect(create.mock.calls[0]![0]).toEqual({ cwd: process.cwd() })
    expect(create.mock.calls[1]![0]).toEqual({})
  })

  it('不存在的目录不会被当作 cwd（避免让宿主建出指向空目录的会话）', async () => {
    const created = agent('minted-3')
    const live = new Map<string, Agent>()
    const create = vi.fn(async () => {
      live.set('minted-3', created)
      return { sessionId: 'minted-3' }
    })
    const ctx = makeCtxWithSessions({ live, roots: [], sessionController: { create } })
    await createParentResolver(ctx).ensure('D:/__not_exist_e2e__')
    expect(create).toHaveBeenCalledWith({})
  })

  it('还有别的存活 Agent（如子会话）时优先用它，不新建会话', async () => {
    const child = agent('child-1')
    const create = vi.fn()
    const ctx = makeCtxWithSessions({
      live: new Map([['child-1', child]]),
      roots: [], // 顶层为空：子会话不在 roots 里
      sessionController: { create },
    })
    await expect(createParentResolver(ctx).ensure()).resolves.toBe(child)
    expect(create).not.toHaveBeenCalled()
  })

  it('所有降级路径都失败 ⇒ 抛**原始**可读错误，并附上准备失败的原因', async () => {
    const create = vi.fn(async () => {
      throw new Error('no default model')
    })
    const ctx = makeCtxWithSessions({ live: new Map(), roots: [], sessionController: { create } })
    await expect(createParentResolver(ctx).ensure()).rejects.toThrow(/无法获取可用的宿主 Agent 会话/)
    await expect(createParentResolver(ctx).ensure()).rejects.toThrow(/自动准备会话也失败：no default model/)
  })

  it('并发 ensure 只准备一次（批量分波不会造出 N 个空会话）', async () => {
    const created = agent('minted-4')
    const live = new Map<string, Agent>()
    const create = vi.fn(
      () =>
        new Promise(resolve => {
          setTimeout(() => {
            live.set('minted-4', created)
            resolve({ sessionId: 'minted-4' })
          }, 5)
        }),
    )
    const ctx = makeCtxWithSessions({ live, roots: [], sessionController: { create } })
    const resolver = createParentResolver(ctx)
    const [a, b, c] = await Promise.all([resolver.ensure(), resolver.ensure(), resolver.ensure()])
    expect([a, b, c]).toEqual([created, created, created])
    expect(create).toHaveBeenCalledTimes(1)
  })
})

describe('canPrepareParent：能否在需要时准备父会话（面板探测用）', () => {
  it('sessionController.create 存在 ⇒ true（无活跃会话也不该判死）', () => {
    expect(canPrepareParent(makeCtx({ roots: () => [] }, {}, { create: async () => ({}) }))).toBe(true)
  })

  it('sessionController 缺失 / 没有 create ⇒ false（行为退回旧版：必须先开会话）', () => {
    expect(canPrepareParent(makeCtx({ roots: () => [] }))).toBe(false)
    expect(canPrepareParent(makeCtx({ roots: () => [] }, {}, { resolveAgent: async () => ({}) }))).toBe(false)
  })
})

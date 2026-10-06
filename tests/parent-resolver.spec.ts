import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createParentResolver, type AgentRegistryLike } from '../src/host/parent-resolver.js'

/** Agent 桩：解析器只读 `id`，其余字段由宿主驱动在真实会话上使用。 */
const agent = (id: string): Agent => ({ id }) as unknown as Agent

/** 收集插件注册的事件监听器的 Context 桩。 */
function makeCtx(
  registry: AgentRegistryLike | undefined,
  listeners: Record<string, (payload: unknown) => void> = {},
): Context {
  return {
    get: (name: string) => (name === 'agents' ? registry : undefined),
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

/**
 * `host/subagent-access.ts` 回归测试（2026-09-21 实机事故）。
 *
 * ## 复现的两个缺陷
 *
 * 1. **apply 期捕获**：旧实现 `apply()` 里 `const sub = ctx.get('subagents')` 一次定终身。
 *    cordis 的 `ctx.get(name)` 默认严格模式，在提供方 fiber 激活前返回 `undefined`
 *    （`vendor/cordis/lib/index.js:762-771`），而本插件 `inject = []`、apply 又极早 ⇒
 *    分发器被永久钉成"永远抛错的桩"，用户点派发只得到
 *    *宿主 subagents 服务不可用（US4 编排能力禁用）*（实机 board.json 里有该 attempt 记录）。
 * 2. **丢接收者**：`const start = sub.start; start(...)` 丢掉 `this` ⇒ `TypeError`
 *    （服务方法要用 `this.providers`）。与缺陷 1 的报错完全不同，不能混淆。
 *
 * 下面的 Context 桩**模仿 cordis 的严格 get 语义**（未激活 ⇒ undefined），
 * 因此"先建 client、后激活服务"的顺序能真实检验惰性解析。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import { createSubagentClient, probeSubagents, resolveSubagents } from '../src/host/subagent-access.js'

/**
 * 形如宿主 `SubagentRuntime` 的服务桩：`start` 依赖 `this.providers`，
 * 一旦接收者丢失就会抛 TypeError（用于验证"保留接收者"这条纪律）。
 */
class FakeSubagentRuntime {
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
 * Context 桩：`active=false` 时 `get()` 返回 undefined（等价于 cordis 的"fiber 未激活"）。
 * @param held - 服务实例（用对象包装，便于测试中途切换）。
 * @returns 桩 ctx 与激活开关。
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
    held.service = new FakeSubagentRuntime()

    const run = await client.start('spawn', { parent: {} } as unknown as SubagentStartRequest)
    expect(run.id).toBe('run:spawn:in-process')
  })

  it('start 必须保留接收者：丢 `this` 的实现会在这里抛 TypeError', () => {
    const held = { service: new FakeSubagentRuntime() as unknown }
    const client = createSubagentClient(makeCtx(held))
    // start 内部读 this.providers；若实现写成 `const f = svc.start; f(...)` 则此处必抛。
    expect(client.start('fork', {} as unknown as SubagentStartRequest)).toMatchObject({
      id: 'run:fork:in-process',
    })
  })

  it('服务始终不可用 ⇒ 抛出可执行的中文原因（含缺哪个包）', () => {
    const client = createSubagentClient(makeCtx({}))
    expect(() => client.start('spawn', {} as unknown as SubagentStartRequest)).toThrow(/subagents 服务不可用/)
    expect(() => client.start('spawn', {} as unknown as SubagentStartRequest)).toThrow(/dsh-subagent/)
  })

  it('服务存在但缺 start ⇒ 报"结构异常"，不误报成"不可用"', () => {
    const client = createSubagentClient(makeCtx({ service: { list: () => [] } }))
    expect(() => client.start('spawn', {} as unknown as SubagentStartRequest)).toThrow(/缺少 start/)
  })
})

describe('probeSubagents：面板用的可达性探测', () => {
  it('未激活 ⇒ available:false 且带原因；激活后 ⇒ available:true + 真实 provider 清单', () => {
    const held: { service?: unknown } = {}
    expect(probeSubagents(makeCtx(held))).toMatchObject({ available: false })

    held.service = new FakeSubagentRuntime()
    expect(probeSubagents(makeCtx(held))).toEqual({ available: true, providers: ['spawn', 'fork'] })
  })

  it('服务可达但方法调用失败 ⇒ available:false 并透出原因（不静默当成功）', () => {
    const service = {
      start: () => ({}) as unknown as SubagentRun,
      list: () => {
        throw new Error('boom')
      },
    }
    const result = probeSubagents(makeCtx({ service }))
    expect(result.available).toBe(false)
    expect(result.reason).toMatch(/boom/)
  })

  it('缺 list 的老版本服务不判为不可用（start 才是派发所需能力）', () => {
    const service = { start: () => ({}) as unknown as SubagentRun }
    expect(probeSubagents(makeCtx({ service }))).toEqual({ available: true, providers: [] })
  })
})

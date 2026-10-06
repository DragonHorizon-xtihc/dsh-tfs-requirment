import { describe, expect, it, vi } from 'vitest'

/**
 * `collectSkills` **主路径**（`acquireScope`）回归测试 —— 0.1.7+ / 0.2.x 宿主实际走的那条路。
 *
 * ## 为什么必须有这个文件（2026-10-02 复核 t5 验证报告时发现的盲区）
 *
 * `dsh-catalog-skills-scope.spec.ts` 的 7 个用例**只桩了 `standingKeyFor`**，那是 ≤0.1.6 的
 * **legacy 兼容路径**；而当前宿主（`dsh 0.2.0-rc.2`）早已删除 `standingKeyFor`
 * （`packages/preset/agent-preset-registry/src` 内零命中），主路径是
 * `acquireScope(id): Promise<{ key: ScopeKey } & AsyncDisposable>`。
 *
 * 叠加另两个事实，主路径此前**完全没有回归防护**：
 *   1. `grep acquireScope tests/` 零命中；
 *   2. 那份 spec `vi.mock` 的是**旧包名** `dsh-agent-presets`，而 `dsh-catalog.ts:365-374`
 *      **先试新名** `dsh-agent-preset-registry` 并在成功后 `break`；两个包名在 node_modules
 *      都不存在 ⇒ 新名 import 必抛、旧名 mock 才生效 ⇒ 测试实际跑的是"新名失败→旧名兜底"，
 *      **恰好绕开主路径**，于是 7/7 全绿也证明不了修复有效。
 *
 * 本文件 `vi.mock` 的正是**代码优先尝试的新包名**，让主路径真正被执行。
 *
 * ## 锁定的契约（对齐 `src/host/dsh-catalog.ts:298-351`）
 *
 * - 主路径取到作用域后并入并集（`acquireScope` 存在时**不得**调用 `standingKeyFor`，能力探测一次定路径）；
 * - 租约**必须在 finally 里释放**，且恰好释放一次（泄漏后果：registry `generation.users` 滞留）；
 * - 单个 preset 抛错只跳过它自己，其余照常且 warning 可归因；
 * - 与 import 层（存活挂载）**按作用域对象身份去重**，同一 key 只 `skills.list` 一次。
 */
const mountsMock = vi.hoisted(() => ({
  mounts: [] as Array<{ key: unknown }>,
  live: vi.fn((): Array<{ key: unknown }> => mountsMock.mounts),
}))
vi.mock('@deepseek-ai/dsh-agent-preset-registry', () => ({
  livePresetMounts: mountsMock.live,
}))

import { createDshCatalog, type DshCatalogHost } from '../src/host/dsh-catalog.js'

/** 一次 `acquireScope` 产生的租约桩（宿主契约：`{ key } & AsyncDisposable`）。 */
interface LeaseStub {
  key: unknown
  [Symbol.asyncDispose]: () => Promise<void>
}

/** `agentPresets` 服务桩：主路径 `acquireScope` 必备，可选带 legacy 的 `standingKeyFor`。 */
interface AcquirePresetsStub {
  list: ReturnType<typeof vi.fn>
  acquireScope: ReturnType<typeof vi.fn>
  standingKeyFor?: ReturnType<typeof vi.fn>
}

/** 构造 host 桩：skills 按 scope 身份返回行；记录每次 list 的入参以便断言去重。 */
function makeHost(
  rowsByScope: Map<unknown, Array<Record<string, unknown>>>,
  agentPresets?: AcquirePresetsStub,
): { host: DshCatalogHost; calls: unknown[] } {
  const calls: unknown[] = []
  const skills = {
    list: async (opts: { cwd?: string; scope?: unknown } = {}) => {
      calls.push(opts.scope)
      return rowsByScope.get(opts.scope) ?? []
    },
  }
  const host: DshCatalogHost = {
    get: (name: string) => {
      if (name === 'skills') return skills
      if (name === 'agentPresets') return agentPresets ?? undefined
      return undefined
    },
  }
  return { host, calls }
}

/** 造一个可计数的租约：key 为作用域身份，dispose 计数 +1。 */
function makeLease(key: unknown, disposals: { count: number }): LeaseStub {
  return {
    key,
    [Symbol.asyncDispose]: async () => {
      disposals.count += 1
    },
  }
}

/** 生成 N 条用户级技能行。 */
function userSkills(n: number, prefix = 'user-skill'): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${String(i + 1).padStart(2, '0')}` }))
}

describe('collectSkills 主路径 acquireScope（0.1.7+ / 0.2.x 宿主实际路径）', () => {
  it('经 acquireScope 取到用户级技能，且租约恰好释放一次', async () => {
    mountsMock.mounts = []
    const scopeStandard = { agentPreset: 'standard' }
    const disposals = { count: 0 }
    const agentPresets: AcquirePresetsStub = {
      list: vi.fn(async () => [{ id: 'standard', name: 'Standard' }]),
      acquireScope: vi.fn(async () => makeLease(scopeStandard, disposals)),
    }
    const bundled = Array.from({ length: 24 }, (_, i) => ({
      name: `bundled-${String(i + 1).padStart(2, '0')}`,
      source: 'bundled',
    }))
    const { host, calls } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, bundled],
        [scopeStandard, userSkills(100)],
      ]),
      agentPresets,
    )

    const catalog = await createDshCatalog({ host }).refresh()

    // 突破「只有全局层」的卡点：24 内置 + 100 用户级。
    expect(catalog.skills).toHaveLength(24 + 100)
    expect(agentPresets.acquireScope).toHaveBeenCalledWith('standard')
    expect(calls).toContain(scopeStandard)
    // 租约归还：恰好一次（多一次=重复释放，少一次=泄漏）。
    expect(disposals.count).toBe(1)
    // 主路径成功 ⇒ 不得误报「仅含全局层」。
    expect(catalog.warnings.join('\n')).not.toContain('仅含全局层')
    expect(catalog.skills.some(s => s.name === 'user-skill-01')).toBe(true)
  })

  it('acquireScope 存在时绝不调用 standingKeyFor（能力探测一次定路径，杜绝双路径重复条目）', async () => {
    mountsMock.mounts = []
    const scopeA = { agentPreset: 'a' }
    const standingKeyFor = vi.fn(async () => ({ agentPreset: 'legacy-should-not-be-used' }))
    const disposals = { count: 0 }
    const agentPresets: AcquirePresetsStub = {
      list: vi.fn(async () => [{ id: 'a' }]),
      acquireScope: vi.fn(async () => makeLease(scopeA, disposals)),
      standingKeyFor,
    }
    const { host } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, [{ name: 'g' }]],
        [scopeA, [{ name: 'user-a' }]],
      ]),
      agentPresets,
    )

    const catalog = await createDshCatalog({ host }).refresh()

    expect(standingKeyFor).not.toHaveBeenCalled()
    expect(catalog.skills.map(s => s.name).sort()).toEqual(['g', 'user-a'])
    expect(disposals.count).toBe(1)
  })

  it('某个 preset 的 acquireScope 抛错：只跳过该 preset，其余照常且 warning 可归因、不误报仅含全局层', async () => {
    mountsMock.mounts = []
    const scopeB = { agentPreset: 'b' }
    const goodDisposals = { count: 0 }
    const agentPresets: AcquirePresetsStub = {
      list: vi.fn(async () => [{ id: 'bad' }, { id: 'b' }]),
      acquireScope: vi.fn(async (id: string) => {
        if (id === 'bad') throw new Error('agent-preset/invalid: 预设未激活')
        return makeLease(scopeB, goodDisposals)
      }),
    }
    const { host } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, [{ name: 'global-skill' }]],
        [scopeB, [{ name: 'user-b' }]],
      ]),
      agentPresets,
    )

    const catalog = await createDshCatalog({ host }).refresh()

    expect(catalog.skills.map(s => s.name).sort()).toEqual(['global-skill', 'user-b'])
    // 坏 preset 根本没拿到租约 ⇒ 不存在"坏租约泄漏"；好 preset 的租约仍归还一次。
    expect(goodDisposals.count).toBe(1)
    const text = catalog.warnings.join('\n')
    expect(text).toContain('bad')
    expect(text).toContain('预设未激活')
    // 仍取到了可用作用域 ⇒ 不该报「仅含全局层」。
    expect(text).not.toContain('仅含全局层')
  })

  it('broken 预设直接跳过，不调用 acquireScope（不制造注定失败的租约请求）', async () => {
    mountsMock.mounts = []
    const scopeStandard = { agentPreset: 'standard' }
    const disposals = { count: 0 }
    const acquireScope = vi.fn(async () => makeLease(scopeStandard, disposals))
    const agentPresets: AcquirePresetsStub = {
      list: vi.fn(async () => [{ id: 'standard' }, { id: 'broken-one', broken: '配置缺失' }]),
      acquireScope,
    }
    const { host } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, [{ name: 'g' }]],
        [scopeStandard, [{ name: 'u' }]],
      ]),
      agentPresets,
    )

    const catalog = await createDshCatalog({ host }).refresh()

    expect(acquireScope).toHaveBeenCalledWith('standard')
    expect(acquireScope).not.toHaveBeenCalledWith('broken-one')
    expect(acquireScope).toHaveBeenCalledTimes(1)
    expect(catalog.skills.map(s => s.name).sort()).toEqual(['g', 'u'])
    expect(disposals.count).toBe(1)
  })

  it('与 import 层（存活挂载）按作用域身份去重：同一 key 只 list 一次、条目不重复', async () => {
    // preset 作用域与存活挂载**返回同一个对象** ⇒ addScope 的 WeakSet 必须吃掉重复。
    const shared = { agentPreset: 'standard' }
    mountsMock.mounts = [{ key: shared }]
    const disposals = { count: 0 }
    const agentPresets: AcquirePresetsStub = {
      list: vi.fn(async () => [{ id: 'standard' }]),
      acquireScope: vi.fn(async () => makeLease(shared, disposals)),
    }
    const { host, calls } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, [{ name: 'g' }]],
        [shared, [{ name: 'u-shared' }]],
      ]),
      agentPresets,
    )

    const catalog = await createDshCatalog({ host }).refresh()

    // 全局 1 次 + 该作用域 1 次（存活挂载与 preset 作用域同源，不重复 list）。
    expect(calls.filter(scope => scope === shared)).toHaveLength(1)
    expect(catalog.skills.map(s => s.name).sort()).toEqual(['g', 'u-shared'])
    expect(disposals.count).toBe(1)
  })

  it('存活挂载作为补充来源与主路径并集（进程内已建立但清单未列出的挂载）', async () => {
    const scopeLive = { live: true }
    mountsMock.mounts = [{ key: scopeLive }]
    const scopeStandard = { agentPreset: 'standard' }
    const disposals = { count: 0 }
    const agentPresets: AcquirePresetsStub = {
      list: vi.fn(async () => [{ id: 'standard' }]),
      acquireScope: vi.fn(async () => makeLease(scopeStandard, disposals)),
    }
    const { host } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, [{ name: 'g' }]],
        [scopeStandard, [{ name: 'u-standard' }]],
        [scopeLive, [{ name: 'u-live' }]],
      ]),
      agentPresets,
    )

    const catalog = await createDshCatalog({ host }).refresh()

    expect(catalog.skills.map(s => s.name).sort()).toEqual(['g', 'u-live', 'u-standard'])
    expect(catalog.warnings.join('\n')).not.toContain('仅含全局层')
  })
})

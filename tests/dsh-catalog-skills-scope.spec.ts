import { describe, expect, it, vi } from 'vitest'

/**
 * 问题 12 / spec 006 US1：执行配置「技能选择」下拉冷启动缺项（用户级技能 89+ 条，旧实现只出 24 条）。
 *
 * 根因（见 specs/006-skill-catalog-and-task-detail/research.md）：
 *   - `skills.list({})` 只读全局层（内置 bundled，约 24 条）；
 *   - 用户级技能由 standard preset 的 skill-filesystem 挂在 **preset standing 作用域层**；
 *   - 该作用域冷进程懒挂载，`livePresetMounts()` 为空 —— 旧实现只合并存活挂载，故冷启动只剩全局层。
 *
 * ## ⚠️ 本文件覆盖的是 **legacy（≤0.1.6）兼容路径**，不是当前主路径
 *
 * 修复采用**三级能力探测**（`src/host/dsh-catalog.ts:298-351`）：
 *   1. `acquireScope(id)` —— **0.1.7+/0.2.x 主路径**，返回 `{ key } & AsyncDisposable` 租约；
 *   2. `standingKeyFor(id)` —— ≤0.1.6 兼容路径，无租约语义；
 *   3. 动态 `import()` 双包名回退，取 `livePresetMounts()` 作补充。
 *
 * 当前宿主（`dsh 0.2.0-rc.2`）**已删除 `standingKeyFor`**
 * （`packages/preset/agent-preset-registry/src` 内零命中），
 * 因此生产实际走的是**第 1 级 `acquireScope`**。
 * 本文件 7 例全部只桩 `standingKeyFor`，锁的是**第 2 级**——
 * 它仍有价值（证明能力探测的互斥与降级语义），但**不能代表主路径已被验证**。
 *
 * 主路径回归见 `dsh-catalog-skills-acquire-scope.spec.ts`（mock 的是代码**优先尝试的新包名**
 * `dsh-agent-preset-registry`）；import 层的告警分支见 `dsh-catalog-skills-import-fallback.spec.ts`。
 *
 * 另注：本文件 `vi.mock` 的是**旧包名** `dsh-agent-presets`，而代码先试新名并 `break`；
 * 新旧两个包名在本仓库 node_modules 均不存在 ⇒ 新名 import 必抛、旧名 mock 才生效。
 * 这正是主路径一度零覆盖却仍能全绿的原因，改动前请先读本段。
 *
 * 本文件用 vi.mock 钉死 `livePresetMounts`（真实测试进程没有存活挂载），agentPresets 服务以 host 桩
 * 注入，重点锁定：**冷启动（mounts=[]）也能经 standingKeyFor 拿到 89 条**，以及并集/去重/隔离/降级。
 */
const mountsMock = vi.hoisted(() => ({
  mounts: [] as Array<{ key: unknown }>,
  live: vi.fn((): Array<{ key: unknown }> => mountsMock.mounts),
}))
vi.mock('@deepseek-ai/dsh-agent-presets', () => ({
  livePresetMounts: mountsMock.live,
}))

import { createDshCatalog, type DshCatalogHost } from '../src/host/dsh-catalog.js'

interface ListCall {
  scope: unknown
}

interface AgentPresetsStub {
  list: ReturnType<typeof vi.fn>
  standingKeyFor: ReturnType<typeof vi.fn>
}

/** 构造 host 桩：skills 按 scope 返回行；agentPresets 服务桩原样透传；记录每次 list 的入参。 */
function makeHost(
  rowsByScope: Map<unknown, Array<Record<string, unknown>>>,
  agentPresets?: AgentPresetsStub,
  listImpl?: (opts: { scope?: unknown }) => Promise<unknown> | unknown,
): { host: DshCatalogHost; calls: ListCall[] } {
  const calls: ListCall[] = []
  const skills = {
    list: async (opts: { cwd?: string; scope?: unknown } = {}) => {
      calls.push({ scope: opts.scope })
      if (listImpl) return listImpl(opts)
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

/** 生成 N 条用户级技能行。 */
function userSkills(n: number, prefix = 'user-skill'): Array<Record<string, unknown>> {
  return Array.from({ length: n }, (_, i) => ({ name: `${prefix}-${String(i + 1).padStart(2, '0')}` }))
}

describe('collectSkills 冷启动 standing 作用域（spec 006 US1）', () => {
  it('【回归】冷进程无存活挂载时，经 standingKeyFor 取到全部 89 条用户技能，且不报“仅含全局层”', async () => {
    mountsMock.mounts = []
    const scopeStandard = { agentPreset: 'standard' }
    const agentPresets: AgentPresetsStub = {
      list: vi.fn(async () => [{ id: 'standard', name: 'Standard' }]),
      standingKeyFor: vi.fn(async () => scopeStandard),
    }
    const bundled = Array.from({ length: 24 }, (_, i) => ({
      name: `bundled-${String(i + 1).padStart(2, '0')}`,
      source: 'bundled',
    }))
    const { host, calls } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, bundled],
        [scopeStandard, userSkills(89)],
      ]),
      agentPresets,
    )

    const catalog = await createDshCatalog({ host }).refresh()

    // 关键断言：冷启动也能拿到 24 内置 + 89 用户级并集。
    expect(catalog.skills).toHaveLength(24 + 89)
    expect(agentPresets.standingKeyFor).toHaveBeenCalledWith('standard')
    expect(calls.some(c => c.scope === scopeStandard)).toBe(true)
    // 不得再把冷启动误报成“仅含全局层”。
    expect(catalog.warnings.join('\n')).not.toContain('仅含全局层')
    // 用户技能确实在列。
    expect(catalog.skills.some(s => s.name === 'user-skill-01')).toBe(true)
    expect(catalog.skills.some(s => s.name === 'user-skill-89')).toBe(true)
  })

  it('全局层 + 多个 standing 作用域取并集，同名全局层优先，重复 scope 只采一次', async () => {
    mountsMock.mounts = []
    const scopeA = { agentPreset: 'a' }
    const scopeB = { agentPreset: 'b' }
    const agentPresets: AgentPresetsStub = {
      // 同一个 preset 出现两次（list 重复行），standingKeyFor 返回同一对象，应去重。
      list: vi.fn(async () => [{ id: 'a' }, { id: 'a' }, { id: 'b' }]),
      standingKeyFor: vi.fn(async (id: string) => (id === 'a' ? scopeA : scopeB)),
    }
    const rows = new Map<unknown, Array<Record<string, unknown>>>([
      [undefined, [{ name: 'global-skill', source: 'global', description: '来自全局层' }]],
      [scopeA, [{ name: 'user-a' }, { name: 'global-skill', description: '作用域同名应被忽略' }]],
      [scopeB, [{ name: 'user-b' }]],
    ])
    const { host, calls } = makeHost(rows, agentPresets)

    const catalog = await createDshCatalog({ host }).refresh()
    expect(catalog.skills.map(s => s.name)).toEqual(['global-skill', 'user-a', 'user-b'])
    expect(catalog.skills.find(s => s.name === 'global-skill')?.description).toBe('来自全局层')
    // 全局 1 次 + scopeA 1 次（重复 preset 去重）+ scopeB 1 次。
    expect(calls.filter(c => c.scope === undefined)).toHaveLength(1)
    expect(calls.filter(c => c.scope === scopeA)).toHaveLength(1)
    expect(calls.filter(c => c.scope === scopeB)).toHaveLength(1)
    expect(catalog.warnings.join('\n')).not.toContain('技能')
  })

  it('某个 preset 的 standingKeyFor 抛错：只跳过该 preset，其余照常且 warning 可见', async () => {
    mountsMock.mounts = []
    const scopeB = { agentPreset: 'b' }
    const agentPresets: AgentPresetsStub = {
      list: vi.fn(async () => [{ id: 'bad' }, { id: 'b' }]),
      standingKeyFor: vi.fn(async (id: string) => {
        if (id === 'bad') throw new Error('preset 损坏或未激活')
        return scopeB
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
    expect(catalog.warnings.join('\n')).toContain('bad')
    expect(catalog.warnings.join('\n')).toContain('preset 损坏或未激活')
  })

  it('broken 预设直接跳过，不调用 standingKeyFor', async () => {
    mountsMock.mounts = []
    const scopeStandard = { agentPreset: 'standard' }
    const agentPresets: AgentPresetsStub = {
      list: vi.fn(async () => [{ id: 'standard' }, { id: 'broken-one', broken: '配置缺失' }]),
      standingKeyFor: vi.fn(async () => scopeStandard),
    }
    const { host } = makeHost(
      new Map<unknown, Array<Record<string, unknown>>>([
        [undefined, [{ name: 'g' }]],
        [scopeStandard, [{ name: 'u' }]],
      ]),
      agentPresets,
    )
    const catalog = await createDshCatalog({ host }).refresh()
    expect(agentPresets.standingKeyFor).toHaveBeenCalledWith('standard')
    expect(agentPresets.standingKeyFor).not.toHaveBeenCalledWith('broken-one')
    expect(catalog.skills.map(s => s.name).sort()).toEqual(['g', 'u'])
  })

  it('存活挂载作为补充来源仍被合并（即使 preset 清单未列出）', async () => {
    const scopeLive = { live: true }
    mountsMock.mounts = [{ key: scopeLive }]
    const scopeStandard = { agentPreset: 'standard' }
    const agentPresets: AgentPresetsStub = {
      list: vi.fn(async () => [{ id: 'standard' }]),
      standingKeyFor: vi.fn(async () => scopeStandard),
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

  it('旧宿主无 agentPresets 服务且无存活挂载：降级为仅全局层并明确告警（不静默少技能）', async () => {
    mountsMock.mounts = []
    const { host } = makeHost(new Map([[undefined, [{ name: 'bundled-only' }]]]))
    const catalog = await createDshCatalog({ host }).refresh()
    expect(catalog.skills.map(s => s.name)).toEqual(['bundled-only'])
    const text = catalog.warnings.join('\n')
    expect(text).toContain('仅含全局层')
    expect(text).toContain('升级 dsh 宿主')
  })

  it('某作用域 list 抛错：只丢该作用域，全局与其他作用域照常', async () => {
    mountsMock.mounts = []
    const scopeA = { agentPreset: 'a' }
    const scopeB = { agentPreset: 'b' }
    const agentPresets: AgentPresetsStub = {
      list: vi.fn(async () => [{ id: 'a' }, { id: 'b' }]),
      standingKeyFor: vi.fn(async (id: string) => (id === 'a' ? scopeA : scopeB)),
    }
    const { host } = makeHost(new Map(), agentPresets, async opts => {
      if (opts.scope === undefined) return [{ name: 'global-skill' }]
      if (opts.scope === scopeA) throw new Error('scope 未激活')
      return [{ name: 'user-b' }]
    })
    const catalog = await createDshCatalog({ host }).refresh()
    expect(catalog.skills.map(s => s.name).sort()).toEqual(['global-skill', 'user-b'])
    expect(catalog.warnings.join('\n')).toContain('scope 未激活')
  })
})

import { describe, expect, it, vi } from 'vitest'

/**
 * `collectSkills` 第 3 级回退（动态 `import()` 存活挂载）的**告警分支**回归测试。
 *
 * ## 为什么单独一个文件（2026-10-02 复核 t5 验证报告时发现的缺口）
 *
 * `dsh-catalog.ts:364-401` 的 import 层有三条互斥结论，t5 报告只验证了其中"旧名兜底成功"一条，
 * 另两条**在测试套件里零断言**：
 *
 * | 分支 | 代码位置 | 触发条件 | 原覆盖 |
 * |---|---|---|---|
 * | 缺少 `livePresetMounts` 导出 | `:388-391` | 模块能 import 但没这个导出（宿主实现漂移） | ❌ 零断言 |
 * | 全部候选不可读 | `:398-400` | 新旧两个包名都 import 失败 | ❌ 零断言 |
 * | 新名失败/旧名成功属预期回退，**不刷** warning | `:375-376` | 改名兼容的正常路径 | ❌ 零断言 |
 *
 * 三条都是"降级可见性"的契约：静默当空 = 用户技能悄悄消失，正是本模块要杜绝的。
 *
 * ## 为什么用 `vi.resetModules()` + 动态 import 重载被测模块
 *
 * `dsh-catalog.ts` 里的包名 import 是**运行时动态**的（`import('@deepseek-ai/dsh-agent-preset-registry')`），
 * 要让同一进程内分别构造"新名有/无 mock"两种世界，必须让模块内的 import 重新求值。
 * `vi.mock` 是文件级静态提升、一次写死；`vi.doMock` + `resetModules` 才能在同一文件里切换。
 */

import type { DshCatalogHost } from '../src/host/dsh-catalog.js'

/** 构造 host 桩：只提供 skills（全局层 1 条），其余服务缺失。 */
function hostWith(skillsImpl?: (opts: { scope?: unknown }) => unknown): DshCatalogHost {
  return {
    get: (name: string) =>
      name === 'skills'
        ? { list: async (opts: { scope?: unknown } = {}) => skillsImpl?.(opts) ?? [{ name: 'g' }] }
        : undefined,
  }
}

/** 动态载入一份全新的被测模块（让其中的包名 import 重新求值）。 */
async function loadCatalog(): Promise<typeof import('../src/host/dsh-catalog.js')> {
  vi.resetModules()
  return import('../src/host/dsh-catalog.js')
}

describe('collectSkills 第 3 级回退：动态 import 的告警分支', () => {
  it('新旧两个包名都不可读 ⇒ 暴露「全部候选不可读」并附每个候选的可归因原因', async () => {
    // 不 mock 任何包名 ⇒ 两个 import 都抛（模块在测试环境确实不存在）。
    vi.doUnmock('@deepseek-ai/dsh-agent-preset-registry')
    vi.doUnmock('@deepseek-ai/dsh-agent-presets')
    const { createDshCatalog } = await loadCatalog()
    const host = hostWith()

    const catalog = await createDshCatalog({ host }).refresh()
    const text = catalog.warnings.join('\n')

    expect(text).toContain('全部候选不可读')
    // 可归因：两个包名都要出现在原因里，否则用户不知道该升级什么。
    expect(text).toContain('@deepseek-ai/dsh-agent-preset-registry')
    expect(text).toContain('@deepseek-ai/dsh-agent-presets')
    expect(text).toContain('仅回退服务层作用域')
    // 冷读三路全不可用 ⇒ 还必须报「仅含全局层」，否则就是静默少技能。
    expect(text).toContain('仅含全局层')
    // 降级仍要返回全局层，不整体失败。
    expect(catalog.skills.map(s => s.name)).toEqual(['g'])
  })

  it('新名模块可读但 livePresetMounts 不是函数 ⇒ 点名 specifier，不静默当空', async () => {
    // 模拟"宿主实现漂移"：`import()` **成功**，但导出缺失或不是函数
    // （真实场景如 CJS/legacy 互操作时 named export 取不到）。
    //
    // ⚠️ 不能写成 `vi.doMock(path, () => ({}))`：vitest 的 mock 工厂在访问**缺失**导出时
    // 会主动抛 `No "x" export is defined on the mock`，那会让 `import()` reject ⇒
    // 落进"全部候选不可读"分支（已由上一例覆盖），**永远到不了**本分支。
    // 必须显式提供该键且值非函数，才能忠实复现"模块可读但拿不到可用导出"。
    vi.doMock('@deepseek-ai/dsh-agent-preset-registry', () => ({ livePresetMounts: undefined }))
    try {
      const { createDshCatalog } = await loadCatalog()
      const host = hostWith()

      const catalog = await createDshCatalog({ host }).refresh()
      const text = catalog.warnings.join('\n')

      expect(text).toContain('缺少 livePresetMounts 导出')
      expect(text).toContain('@deepseek-ai/dsh-agent-preset-registry')
      // 关键：新名"可读"但无可用导出时**不再回退旧名**（代码 `break`），因此不刷"全部候选不可读"。
      expect(text).not.toContain('全部候选不可读')
      expect(catalog.skills.map(s => s.name)).toEqual(['g'])
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-agent-preset-registry')
      vi.resetModules()
    }
  })

  it('新名失败但旧名兜底成功（改名兼容的预期路径）⇒ 不刷任何 import 告警', async () => {
    // 新名不存在（不 mock），旧名有 livePresetMounts ⇒ 走改名兼容回退，属**预期内**，必须静默。
    vi.doUnmock('@deepseek-ai/dsh-agent-preset-registry')
    vi.doMock('@deepseek-ai/dsh-agent-presets', () => ({ livePresetMounts: () => [] }))
    try {
      const { createDshCatalog } = await loadCatalog()
      const host = hostWith()

      const catalog = await createDshCatalog({ host }).refresh()
      const text = catalog.warnings.join('\n')

      // 预期内回退不刷 warning（`dsh-catalog.ts:375-376`）。
      expect(text).not.toContain('不可读')
      expect(text).not.toContain('全部候选不可读')
      expect(text).not.toContain('缺少 livePresetMounts 导出')
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-agent-presets')
      vi.resetModules()
    }
  })

  it('旧名兜底带出非全局作用域时：并集生效且不报「仅含全局层」', async () => {
    // 旧名导出带回一个存活挂载作用域 ⇒ 即便服务层无 preset 入口，也能带出用户级技能。
    const scopeLive = { live: true }
    vi.doUnmock('@deepseek-ai/dsh-agent-preset-registry')
    vi.doMock('@deepseek-ai/dsh-agent-presets', () => ({ livePresetMounts: () => [{ key: scopeLive }] }))
    try {
      const { createDshCatalog } = await loadCatalog()
      const host = hostWith(opts => (opts.scope === undefined ? [{ name: 'g' }] : [{ name: 'u-live' }]))

      const catalog = await createDshCatalog({ host }).refresh()

      expect(catalog.skills.map(s => s.name).sort()).toEqual(['g', 'u-live'])
      // 有可用作用域 ⇒ 绝不能报"仅含全局层"（这正是旧实现误报的那条）。
      expect(catalog.warnings.join('\n')).not.toContain('仅含全局层')
    } finally {
      vi.doUnmock('@deepseek-ai/dsh-agent-presets')
      vi.resetModules()
    }
  })
})

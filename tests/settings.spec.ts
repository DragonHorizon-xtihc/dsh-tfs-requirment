import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { installSettingsSection, SETTINGS_NAMESPACE, type SettingsSectionHooks } from '../src/host/settings.js'
import type { TfsRequirmentConfig } from '../src/config.js'

/**
 * 设置区注册单测（T028 / US1）。
 *
 * 用假 settings 服务驱动 `installSection`，断言：
 *  - 无 settings 服务时返回 false（能力降级，不抛）；
 *  - 基线配置违规时**装配期即抛**（配置错误要可见）；
 *  - 命名空间为小写连字符 `tfs-requirment`，entry 透传；
 *  - `validate` 钩子对违规配置抛错（表达 schema 无法承载的约束）；
 *  - `onChange` 触发解析回调；`setSource` 注入的 thunk 成为权威读取口。
 */

/** 完整配置构造器（与 config.ts 默认值一致）。 */
function cfg(over: Partial<TfsRequirmentConfig> = {}): TfsRequirmentConfig {
  return {
    collections: ['WN_HIS'],
    defaultCollection: 'WN_HIS',
    pollIntervalMinutes: 5,
    defaultLabel: 'dsh',
    maxConcurrentRequirements: 3,
    auditRetentionDays: 90,
    enabled: true,
    // 问题 1/4/6 新增配置（与 config.ts 默认值一致）。
    autoChainTasks: true,
    autoWriteBack: true,
    defaultMaxDepth: 1,
    defaultMaxTokens: 0,
    runTimeoutMinutes: 120,
    runTimeoutGraceMinutes: 30,
    // spec 010 编排主 agent 新增配置（与 config.ts 默认值一致）。
    orchestratorEnabled: true,
    orchestratorProvider: '',
    reuseTaskSessions: true,
    summarizeTimeoutSeconds: 120,
    summarizeGraceSeconds: 20,
    finalizeTimeoutSeconds: 180,
    finalizeGraceSeconds: 60,
    taskSessionSettleTimeoutMinutes: 30,
    // 运行期假执行巡检（与 config.ts 默认值一致）。
    staleRunningReapMinutes: 10,
    staleRunningSweepSeconds: 60,
    // 写门禁2 的模型写总闸（与 config.ts 默认值一致）：默认关闭。
    allowModelWrites: false,
    queryOptionsConcurrency: 8,
    allowExternalDownloadDir: false,
    ...over,
  }
}

/**
 * 捕获 installSection 入参的假 settings 服务。
 *
 * ⚠️ 必须复刻**真实 cordis 的取服务方式** `ctx.get(name)`：`Context` 是 Proxy，对"已注册但未
 * inject"的服务做属性读取会抛 `cannot get property "X" without inject`
 * （`vendor/cordis/lib/index.js:672-681`），而 `ctx.get(name)` 未提供时**返回 undefined**
 * （同文件 `:762-765`）。早期桩写成"属性 `settings`"是照着一个不存在的契约写的，已纠正。
 */
function fakeCtx(): {
  ctx: Context
  captured: {
    ns?: string
    entry?: TfsRequirmentConfig
    hooks?: SettingsSectionHooks<TfsRequirmentConfig>
  }
} {
  const captured: { ns?: string; entry?: TfsRequirmentConfig; hooks?: SettingsSectionHooks<TfsRequirmentConfig> } = {}
  const settings = {
    installSection<T>(
      _owner: Context,
      ns: string,
      _schema: unknown,
      entry: T,
      hooks: SettingsSectionHooks<T>,
    ): void {
      captured.ns = ns
      captured.entry = entry as TfsRequirmentConfig
      captured.hooks = hooks as unknown as SettingsSectionHooks<TfsRequirmentConfig>
    },
  }
  const ctx = {
    // 真实语义：未提供的服务名返回 undefined，而不是抛错。
    get(name: string) {
      return name === 'settings' ? settings : undefined
    },
  } as unknown as Context
  return { ctx, captured }
}

describe('installSettingsSection', () => {
  it('无 settings 服务 → 返回 false（降级不抛）', () => {
    const ok = installSettingsSection({} as Context, cfg(), { onResolved: () => {} })
    expect(ok).toBe(false)
  })

  it('基线配置违规 → 装配期抛错（配置错误可见）', () => {
    expect(() =>
      installSettingsSection({ settings: { installSection: () => {} } } as unknown as Context, cfg({ pollIntervalMinutes: 0 }), {
        onResolved: () => {},
      }),
    ).toThrow(/不合规/)
  })

  it('注册命名空间为 tfs-requirment 并透传 entry', () => {
    const { ctx, captured } = fakeCtx()
    const entry = cfg({ collections: ['WN_HIS', 'WN_TJ'], defaultCollection: 'WN_TJ' })
    const ok = installSettingsSection(ctx, entry, { onResolved: () => {} })
    expect(ok).toBe(true)
    expect(captured.ns).toBe('tfs-requirment')
    expect(captured.ns).toBe(SETTINGS_NAMESPACE)
    expect(captured.entry?.defaultCollection).toBe('WN_TJ')
  })

  it('validate 钩子对违规配置抛错', () => {
    const { ctx, captured } = fakeCtx()
    installSettingsSection(ctx, cfg(), { onResolved: () => {} })
    expect(() => captured.hooks!.validate?.(cfg({ maxConcurrentRequirements: 0 }))).toThrow()
    expect(() => captured.hooks!.validate?.(cfg())).not.toThrow()
  })

  it('onResolved 在 setSource / onChange 时以权威值回调', () => {
    const { ctx, captured } = fakeCtx()
    const seen: string[] = []
    installSettingsSection(ctx, cfg({ defaultCollection: 'WN_HIS' }), {
      onResolved: next => seen.push(next.defaultCollection),
    })
    // 宿主契约：attach 时先 setSource(权威值) 再 onChange()，故同一值回调两次。
    captured.hooks!.setSource(() => cfg({ defaultCollection: 'WN_TECH' }))
    captured.hooks!.onChange()
    expect(seen).toEqual(['WN_TECH', 'WN_TECH'])
  })
})

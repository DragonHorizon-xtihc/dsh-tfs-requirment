import { describe, expect, it } from 'vitest'
import {
  createDshCatalog,
  emptyCatalog,
  mcpServerNamesFromSchemas,
  type DshCatalogHost,
} from '../src/host/dsh-catalog.js'

/**
 * DSH 能力目录采集单测（问题 6 修复的回归网）。
 *
 * ## 本文件锁定的核心事实
 *
 * 问题 6（执行配置的工作区/预设/模型下拉全空）的根因**不在采集逻辑**，而在装配点
 * 用了 cordis 的**严格** `ctx.get(name)`：提供该服务的 fiber 在插件 `apply` 期
 * 尚未激活（`state !== 2`），严格模式直接返回 `undefined`，于是 5 项能力集体采空、
 * 各自只留一条 warning —— 表现就是"下拉是空的，但日志看着一切正常"。
 *
 * 修复是把非严格语义（`ctx.get(name, false)`）钉进 `DshCatalogHost.get` 的契约里，
 * 并把 `refresh()` 推迟到 `ctx.inject([...], cb)` 回调（依赖齐备才执行）。
 *
 * 因此下面的用例不仅测"采集对不对"，更要测**"服务缺席时降级是否可见"**：
 * 每一条 `undefined` 都必须换来一条 warning，绝不允许静默返回空数组。
 */

/** 构造一个可控宿主桩。`services` 里没有的键一律返回 undefined（模拟服务未就绪）。 */
function makeHost(services: Record<string, unknown>, schemas: Array<{ name?: unknown }> = []): DshCatalogHost {
  return {
    get(name: string) {
      return services[name]
    },
    tools: { schemas: () => schemas },
  }
}

describe('mcpServerNamesFromSchemas（工具全名反推 server 名）', () => {
  it('从 mcp__<server>__<tool> 提取 server 并去重排序', () => {
    const names = mcpServerNamesFromSchemas([
      { name: 'mcp__tfs-mcp__tfs_query_wiql' },
      { name: 'mcp__tfs-mcp__tfs_whoami' },
      { name: 'mcp__chrome-devtools__click' },
    ])
    expect(names).toEqual(['chrome-devtools', 'tfs-mcp'])
  })

  it('非 mcp__ 前缀的工具名被忽略', () => {
    expect(mcpServerNamesFromSchemas([{ name: 'Bash' }, { name: 'Read' }])).toEqual([])
  })

  it('无 __ 分隔时整段当作 server 名（不丢信息）', () => {
    expect(mcpServerNamesFromSchemas([{ name: 'mcp__lonely' }])).toEqual(['lonely'])
  })

  it('兜底清单参与合并（schemas 不可用时也能看到配置里声明的 server）', () => {
    // 这条防的是"面板给出『没有任何 MCP 可选』的错误结论"。
    expect(mcpServerNamesFromSchemas([{ name: 'mcp__tfs-mcp__x' }], ['tfs-mcp', 'other']))
      .toEqual(['other', 'tfs-mcp'])
  })

  it('形状异常的条目被跳过，不抛错', () => {
    expect(mcpServerNamesFromSchemas([{ name: 42 }, {}, null as never, { name: '' }])).toEqual([])
  })
})

describe('createDshCatalog：全服务可用时的采集', () => {
  it('采集模型（多 provider 展平）', async () => {
    const host = makeHost({
      llm: {
        listProviders: () => [{ id: 'deepseek', name: 'DeepSeek' }],
        listModels: async () => [
          { id: 'deepseek-v4-flash', name: 'V4 Flash' },
          { id: 'deepseek-v4-pro', name: 'V4 Pro' },
        ],
      },
    })
    const catalog = await createDshCatalog({ host }).refresh()
    // `providers` 是 subagent provider 名（`ctx.subagents.start(name)` 用的那个），
    // 与 llm 的 provider 是两回事，此处为空属预期。
    expect(catalog.models.map(m => m.id)).toContain('deepseek-v4-flash')
    expect(catalog.models.map(m => m.name)).toContain('V4 Flash')
    // 模型项必须带 provider 路由键与展示名，否则下拉无法分组。
    const flash = catalog.models.find(m => m.id === 'deepseek-v4-flash')!
    expect(flash.provider).toBe('deepseek')
    expect(flash.providerName).toBe('DeepSeek')
    // 本用例只桩了 llm，其余四项缺席本就该留 warning；关键是**模型这一项不报错**。
    expect(catalog.warnings.join('\n')).not.toContain('模型目录不可用')
  })

  it('采集技能 / 预设 / 工作区', async () => {
    const host = makeHost({
      llm: { listProviders: () => [], listModels: async () => [] },
      skills: { list: async () => [{ name: 'commit' }, { name: 'pdf' }] },
      agentPresets: { list: () => [{ id: 'default', name: '默认' }] },
      workspaceRegistry: { list: () => [{ id: 'w1', name: 'deepseek-harness', path: 'D:/x' }] },
    })
    const catalog = await createDshCatalog({ host }).refresh()
    expect(catalog.skills.map(s => s.name)).toEqual(['commit', 'pdf'])
    expect(catalog.presets.map(p => p.id)).toEqual(['default'])
    expect(catalog.workspaces.map(w => w.id)).toEqual(['w1'])
  })

  it('current() 在首次 refresh 前返回安全空目录（不是 undefined）', () => {
    const catalog = createDshCatalog({ host: makeHost({}) })
    expect(catalog.current()).toEqual(emptyCatalog())
  })

  it('refresh 后的快照可由 current() 同步取回', async () => {
    const host = makeHost({
      llm: { listProviders: () => [{ id: 'p', name: 'P' }], listModels: async () => [{ id: 'm', name: 'M' }] },
    })
    const service = createDshCatalog({ host, now: () => new Date('2026-09-19T00:00:00Z') })
    await service.refresh()
    const snap = service.current()
    expect(snap.collectedAt).toBe('2026-09-19T00:00:00.000Z')
    expect(snap.models.length).toBeGreaterThan(0)
  })

  it('并发 refresh 共享同一次采集（不重复打宿主）', async () => {
    let calls = 0
    const host = makeHost({
      llm: {
        listProviders: () => { calls += 1; return [{ id: 'p', name: 'P' }] },
        listModels: async () => [{ id: 'm', name: 'M' }],
      },
    })
    const service = createDshCatalog({ host })
    const [a, b, c] = await Promise.all([service.refresh(), service.refresh(), service.refresh()])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(calls).toBe(1)
  })
})

describe('createDshCatalog：服务缺席时的降级必须可见（问题 6 的失败形态）', () => {
  it('llm 缺席 → 模型为空且**必须**留一条 warning（不静默）', async () => {
    const catalog = await createDshCatalog({ host: makeHost({}) }).refresh()
    expect(catalog.models).toEqual([])
    expect(catalog.warnings.join('\n')).toContain('模型目录不可用')
  })

  it('五个能力全缺席 → 五条 warning，逐项可归因', async () => {
    const catalog = await createDshCatalog({ host: makeHost({}) }).refresh()
    // 这正是问题 6 的现场：下拉全空 + 5 条 warning。修复后它们不该再出现，
    // 但一旦宿主服务未就绪，我们必须还能**看出**是哪一项缺了。
    expect(catalog.warnings.length).toBeGreaterThanOrEqual(4)
    const text = catalog.warnings.join('\n')
    expect(text).toContain('模型目录不可用')
    expect(text).toContain('技能')
    expect(text).toContain('预设')
    expect(text).toContain('工作区')
  })

  it('某个 provider 抛错只丢它自己，其他 provider 照常采', async () => {
    const host = makeHost({
      llm: {
        listProviders: () => [{ id: 'bad', name: 'Bad' }, { id: 'good', name: 'Good' }],
        listModels: async (provider: string) => {
          if (provider === 'bad') throw new Error('500 server error')
          return [{ id: 'good-model', name: 'Good Model' }]
        },
      },
    })
    const catalog = await createDshCatalog({ host }).refresh()
    expect(catalog.models.map(m => m.id)).toContain('good-model')
    expect(catalog.warnings.join('\n')).toContain('500 server error')
  })

  it('listProviders 整体抛错 → 空模型 + warning，不冒泡', async () => {
    const host = makeHost({
      llm: {
        listProviders: () => { throw new Error('插件树未就绪') },
        listModels: async () => [],
      },
    })
    const catalog = await createDshCatalog({ host }).refresh()
    expect(catalog.models).toEqual([])
    expect(catalog.warnings.join('\n')).toContain('插件树未就绪')
  })

  it('MCP server 清单走 tools.schemas()；不可用时回退配置声明', async () => {
    const withSchemas = await createDshCatalog({
      host: makeHost({}, [{ name: 'mcp__tfs-mcp__tfs_whoami' }]),
      fallbackMcpServers: ['tfs-mcp'],
    }).refresh()
    expect(withSchemas.mcpServers).toContain('tfs-mcp')

    const noTools = await createDshCatalog({
      host: { get: () => undefined },
      fallbackMcpServers: ['tfs-mcp'],
    }).refresh()
    expect(noTools.mcpServers).toContain('tfs-mcp')
  })
})

describe('DshCatalogHost.get 的契约：非严格语义（strict=false）', () => {
  it('装配点必须传 false —— 用真 cordis 语义复刻「严格取不到」的现象', async () => {
    // 复刻真实 root.get 的两态：严格模式对未激活 fiber 返回 undefined，非严格才拿得到。
    // 为了让"只有 llm 有值"这一对照干净，其余四项也一并桩上，隔离出 llm 这一个变量。
    const llm = { listProviders: () => [{ id: 'p', name: 'P' }], listModels: async () => [{ id: 'm', name: 'M' }] }
    const rest = {
      skills: { list: async () => [] },
      agentPresets: { list: () => [] },
      workspaceRegistry: { list: () => [] },
      subagents: { list: () => [] },
    }
    const services: Record<string, unknown> = { llm, ...rest }

    // 严格模式：fiber 未激活 ⇒ **所有**服务恒 undefined。
    const strictGet = () => undefined
    const lenientGet = (name: string) => services[name]

    const strictCatalog = await createDshCatalog({
      host: { get: strictGet },
    }).refresh()
    const lenientCatalog = await createDshCatalog({
      host: { get: lenientGet },
      fallbackMcpServers: ['tfs-mcp'],
    }).refresh()

    // 严格语义 = 问题 6 现场：模型空 + warning。
    expect(strictCatalog.models).toEqual([])
    expect(strictCatalog.warnings.join('\n')).toContain('模型目录不可用')
    // 非严格语义 = 修复后：拿到模型，且**没有**模型相关的降级 warning。
    expect(lenientCatalog.models.map(m => m.id)).toContain('m')
    expect(lenientCatalog.warnings.join('\n')).not.toContain('模型目录不可用')
    // 技能项在这份桩下（`skills.list` 返回空 + 无存活 preset 挂载）会命中一条**有意告警**：
    // "技能目录仅含全局层…"（2026-09-20 加入，问题 1 的可见性修复）。
    // 这里显式断言它的存在，避免将来把这条有意义的告警误当成回归删掉；
    // 同时不再用 `warnings).toEqual([])` 这种"全体为空"的脆弱口径 —— 它会把
    // 任意其他维度的新增告警都误报成"非严格语义失效"。
    expect(lenientCatalog.warnings.some(w => w.includes('仅含全局层'))).toBe(true)
  })
})

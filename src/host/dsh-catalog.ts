/**
 * DSH 能力目录：把宿主**真实**可选的模型 / 技能 / 预设 / 工作区 / subagent provider /
 * MCP server 名枚举出来，供面板下拉使用。
 *
 * ## 为什么必须存在这个模块（2026-09-18 用户反馈 4/5/6/7/9/11）
 *
 * 此前 `src/index.ts` 的面板数据是**硬编码**的：
 * ```ts
 * models: ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'glm-4.6'],
 * mcpServers: [config.tfsServerName],   // 永远只有 TFS 那一个实例（该配置项与实例声明均已废弃）
 * skills: [],                           // 永远空
 * ```
 * 后果是面板里能选的模型/MCP/技能与 dsh 实际配置**对不上**：用户换了模型或装了技能，
 * 面板里看不到，也没法选；`skills` 恒空更是直接让"技能选择"整块失效。
 *
 * ## 数据来源（全部经源码核实，逐条标注 file:line）
 *
 * | 目录 | 宿主 API | 依据 |
 * |---|---|---|
 * | 模型 | `ctx.llm.listProviders(): LlmProviderInfo[]` + `ctx.llm.listModels(provider): Promise<LlmModelInfo[]>` | `dsh-llm/lib/types/index.d.ts`（LlmRuntime 方法表） |
 * | 技能 | `ctx.skills.list(options?): Promise<SkillSummary[]>` | `dsh-skill/lib/types/index.d.ts`（SkillRegistry.list） |
 * | 预设 | `ctx.agentPresets.list(): Promise<AgentPreset[]>` | `dsh-agent-preset-registry/lib/types/index.d.ts`（AgentPresetRegistry.list） |
 * | 工作区 | `ctx.workspaceRegistry.list(): Workspace[]` | `dsh-workspace/lib/types/index.d.ts`（WorkspaceRegistry.list） |
 * | provider | `ctx.subagents.list(): string[]` | `dsh-subagent/lib/types/index.d.ts:283` |
 * | MCP server | 从 `ctx.tools.schemas()` 的 `mcp__<server>__<tool>` 前缀反推 | `dsh-mcp-client/src/tools.ts:81`（工具全名规则） |
 *
 * ## 三类取值方式（决定本模块的形态）
 *
 * 1. **同步**：`workspaceRegistry.list()`、`subagents.list()`、`tools.schemas()`；
 * 2. **异步**：`skills.list()`、`agentPresets.list()`、`llm.listModels()`；
 * 3. **需两跳**：模型要先 `listProviders()` 再逐个 `listModels(provider)`。
 *
 * 因为存在异步项，目录**不能**在 `panel-data` 的同步返回里现算，故本模块实现为
 * **带缓存 + 可刷新**：`refresh()` 重新采集，`current()` 同步取上一份（首次可能为空）。
 * 面板先渲染缓存、再异步刷新，避免"打开面板要等所有 provider 走完一轮网络"。
 *
 * ## 降级纪律（沿用插件既有约定）
 *
 * 每一项独立 try/catch：某项失败只让该项为空并把**可读原因**收进 `warnings`，
 * 绝不让"某宿主服务缺失"把整个面板数据打没。`warnings` 会在 UI 上显式展示，
 * 保证"能力降级可见"而不是静默变空。
 *
 * @module @deepseek-ai/dsh-requirment/host/dsh-catalog
 */

// 下列类型已上移至 `src/shared/contracts.ts`（客户端半/宿主半共享，避免客户端半勾到 node:fs）。
// 此处既本地 import（供本文件方法签名使用）又 re-export（保持历史引用 `import { DshCatalog }` 有效）。
import type {
  DshModelOption,
  DshSkillOption,
  DshPresetOption,
  DshWorkspaceOption,
  DshCatalog,
} from '../shared/contracts.js'

export type {
  DshModelOption,
  DshSkillOption,
  DshPresetOption,
  DshWorkspaceOption,
  DshCatalog,
} from '../shared/contracts.js'

/** 空目录（首次采集前 / 宿主服务全不可用时的安全初值）。 */
export function emptyCatalog(): DshCatalog {
  return {
    models: [],
    skills: [],
    presets: [],
    workspaces: [],
    providers: [],
    mcpServers: [],
    warnings: [],
    collectedAt: '',
  }
}

/**
 * 宿主上下文的最小访问面。
 *
 * 只声明本模块用到的两个能力：`get(name)`（**非抛出**服务访问器）与 `tools.schemas()`。
 * 这样本模块不 import cordis，可在单测里用普通对象驱动。
 */
export interface DshCatalogHost {
  /**
   * 取宿主服务，未提供时返回 `undefined`。
   *
   * **必须是 cordis 的「非严格」`ctx.get` 语义**（即 `ctx.get(name, false)`）：
   *   - 属性读取（`ctx.llm`）对未 inject 的服务会抛错，见 `vendor/cordis/lib/index.js:672-681`；
   *   - **严格模式**（`ctx.get(name)` / `ctx.get(name, true)`）在提供该服务的 fiber
   *     `state !== 2`（尚未激活）时**返回 `undefined`**，见同文件 `:762-772`（`_getImpl` 在 `:766`）。
   *
   * 2026-09-19 实测坐实（用真实 cordis 根上下文做一次性探针，探针用完即删）：
   * ```
   * root.get("llm", true)  → undefined    ← 严格模式：fiber 未激活
   * root.get("llm", false) → 有值          ← 非严格模式：拿得到
   * ```
   * 装配点（`src/index.ts`）据此显式传 `false`，否则模型/技能/预设/工作区/provider 五项
   * 会在插件 `apply` 期集体采空（且各自只留一条 warning）。
   */
  get(name: string): unknown
  /** 工具运行时（用于反推 MCP server 名）。 */
  tools?: { schemas(scope?: unknown): Array<{ name?: unknown }> } | undefined
}

/** 从工具全名 `mcp__<serverName>__<rawName>` 反推 server 名。 */
export function mcpServerNamesFromSchemas(
  schemas: Array<{ name?: unknown }>,
  fallback: readonly string[] = [],
): string[] {
  const found = new Set<string>()
  for (const schema of schemas) {
    const name = schema?.name
    if (typeof name !== 'string' || !name.startsWith('mcp__')) continue
    // `mcp__` 之后到下一个 `__` 之间即 serverName（serverName 约束 `^[A-Za-z0-9_-]{1,32}$`，
    // 不含 `_` 之外的分隔歧义；`__` 是宿主固定分隔符）。
    const rest = name.slice('mcp__'.length)
    const at = rest.indexOf('__')
    const server = at < 0 ? rest : rest.slice(0, at)
    if (server.length > 0) found.add(server)
  }
  for (const name of fallback) if (name.length > 0) found.add(name)
  return [...found].sort()
}

/** 采集器构造参数。 */
export interface DshCatalogOptions {
  host: DshCatalogHost
  /**
   * MCP server 兜底清单：`tools.schemas()` 不可用时至少要能看到配置里声明的那个，
   * 否则面板会给出"没有任何 MCP 可选"的错误结论。
   */
  fallbackMcpServers?: readonly string[]
  /** 注入的时钟（单测可固定）。 */
  now?: () => Date
}

/** DSH 能力目录服务。 */
export interface DshCatalogService {
  /** 重新采集（并发安全：并发调用共享同一次采集）。 */
  refresh(): Promise<DshCatalog>
  /** 同步取上一份快照（首次为 `emptyCatalog()`）。 */
  current(): DshCatalog
}

/** 把任意抛出物转成可读单行原因。 */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * 构造 DSH 能力目录服务。
 * @param options - 见 {@link DshCatalogOptions}。
 * @returns 目录服务（`refresh` / `current`）。
 */
export function createDshCatalog(options: DshCatalogOptions): DshCatalogService {
  const { host, fallbackMcpServers = [], now = () => new Date() } = options
  let snapshot: DshCatalog = emptyCatalog()
  let inflight: Promise<DshCatalog> | null = null

  /** 逐个 provider 采集模型；任一 provider 失败只丢它自己的模型并记一条 warning。 */
  async function collectModels(warnings: string[]): Promise<DshModelOption[]> {
    const llm = host.get('llm') as
      | {
          listProviders?: () => Array<{ id?: unknown; name?: unknown }>
          listModels?: (provider: string) => Promise<Array<{ id?: unknown; name?: unknown; description?: unknown }>>
        }
      | undefined
    if (!llm || typeof llm.listProviders !== 'function' || typeof llm.listModels !== 'function') {
      warnings.push('模型目录不可用：宿主 llm 服务未提供 listProviders/listModels')
      return []
    }
    let providers: Array<{ id?: unknown; name?: unknown }>
    try {
      providers = llm.listProviders()
    } catch (error) {
      warnings.push(`模型目录不可用：listProviders 抛错（${reasonOf(error)}）`)
      return []
    }
    const out: DshModelOption[] = []
    for (const provider of providers) {
      const pid = typeof provider?.id === 'string' ? provider.id : ''
      if (!pid) continue
      const providerName = typeof provider?.name === 'string' && provider.name ? provider.name : pid
      try {
        const models = await llm.listModels(pid)
        for (const model of models) {
          const id = typeof model?.id === 'string' ? model.id : ''
          if (!id) continue
          out.push({
            provider: pid,
            providerName,
            id,
            name: typeof model?.name === 'string' && model.name ? model.name : id,
            ...(typeof model?.description === 'string' && model.description
              ? { description: model.description }
              : {}),
          })
        }
      } catch (error) {
        // 单个 provider 探测失败（未配 key / 端点不可达）不代表模型目录整体不可用。
        warnings.push(`provider「${providerName}」模型清单获取失败（${reasonOf(error)}）`)
      }
    }
    return out
  }

  /**
   * 把一批 skills.list 行规范化为下拉选项（同名保留首个命中：全局层优先，其后按作用域顺序）。
   */
  function normalizeSkillRows(rows: unknown, out: Map<string, DshSkillOption>): void {
    if (!Array.isArray(rows)) return
    for (const row of rows) {
      const r = row as {
        name?: unknown
        description?: unknown
        source?: unknown
        invocation?: { modelInvocable?: unknown; userInvocable?: unknown }
      }
      const name = typeof r.name === 'string' ? r.name : ''
      if (!name || out.has(name)) continue
      out.set(name, {
        name,
        description: typeof r.description === 'string' ? r.description : '',
        source: typeof r.source === 'string' ? r.source : '',
        modelInvocable: r.invocation?.modelInvocable !== false,
        userInvocable: r.invocation?.userInvocable !== false,
      })
    }
  }

  /**
   * 采集技能（问题 12 / 006：作用域并集 + **冷启动可用**）。
   *
   * ## 为什么旧实现冷启动只有 24 条（2026-09-23 复发 / 0.1.7 复诊的根因）
   *
   * `skills.list({})` 省略 scope 时**只读全局层**；用户级技能（`~/.agents/skills`、
   * `$DSH_HOME/skills`，实测 89~100 条）只挂在 preset 的 standing 作用域层
   * （web profile 明确禁用宿主级 skill-filesystem，"presets own local discovery"）。
   * 0.1.6 时代的作用域来自 `agentPresets.standingKeyFor(id)`；dsh 0.1.7 提交 d1e22a7e24
   * （#4569，preset 声明化改造）**删除了该 API**，替代入口是
   * `AgentPresetRegistry.acquireScope(id)`（`dsh-agent-preset-registry/lib/types/index.d.ts`
   * 「Read current registrations for cold transcript presentation」，返回
   * `{ key: ScopeKey } & AsyncDisposable` 租约）。旧实现两条腿全部失效：
   * `standingKeyFor` typeof 守卫为假被整段跳过，动态 `import('@deepseek-ai/dsh-agent-presets')`
   * 也因包改名 `@deepseek-ai/dsh-agent-preset-registry` 而 ERR_MODULE_NOT_FOUND ——
   * 于是 scopeRefs 为空，只剩全局层约 24 条。另注意 0.1.7 的 registry 在 `register()`
   * 时即**预挂载**（activate → mountPreset），因此 `acquireScope(id)` 冷进程即可用，
   * 无需任何会话。
   *
   * ## 正确做法（能力探测三级回退）
   *
   *   1. 先取全局层 `list({})`；
   *   2. 能力探测：`acquireScope`（0.1.7+，主路径）→ `standingKeyFor`（≤0.1.6 兼容）→
   *      动态 `import()` 双包名回退（`@deepseek-ai/dsh-agent-preset-registry` 优先，
   *      旧名 `@deepseek-ai/dsh-agent-presets` 兜底），只取 `livePresetMounts()` 作补充；
   *   3. 逐非损坏 preset 取作用域并入并集：
   *      acquireScope 返回的租约**必须**在 finally 里 `Symbol.asyncDispose()` 释放
   *      （泄漏后果：generation 计数滞留、无法被 registry 回收），取技能前先取 key，
   *      list 抛错也要释放；
   *   4. 作用域去重（同一 scope 只 list 一次）、按技能名并集（全局层优先）。
   * 单个 preset / 作用域 / import 失败只记 warning 并继续（降级纪律，不静默吞错）。
   */
  async function collectSkills(warnings: string[]): Promise<DshSkillOption[]> {
    const skills = host.get('skills') as
      | { list?: (options?: { cwd?: string; scope?: unknown }) => Promise<unknown> }
      | undefined
    if (!skills || typeof skills.list !== 'function') {
      warnings.push('技能目录不可用：宿主 skills 服务未提供 list')
      return []
    }
    const merged = new Map<string, DshSkillOption>()
    // 1) 全局层（内置 / 部署级注册技能）。
    try {
      normalizeSkillRows(await skills.list({}), merged)
    } catch (error) {
      warnings.push(`技能目录不可用：全局层 list 抛错（${reasonOf(error)}）`)
    }
    const globalCount = merged.size

    // 作用域去重：key 是不透明身份对象（dsh-scope ScopeKey），也兼容原始值。
    const seenObjects = new WeakSet<object>()
    const seenPrimitives = new Set<string>()
    const scopeRefs: Array<{ scope: unknown; label: string }> = []
    const addScope = (scope: unknown, label: string): void => {
      if (scope === undefined || scope === null) return
      if (typeof scope === 'object') {
        if (seenObjects.has(scope as object)) return
        seenObjects.add(scope as object)
      } else {
        const tag = String(scope)
        if (seenPrimitives.has(tag)) return
        seenPrimitives.add(tag)
      }
      scopeRefs.push({ scope, label })
    }

    // 2) preset standing 作用域（冷安全）：能力探测三级回退的第 1/2 级。
    //    - 0.1.7+：`acquireScope(id)` 返回 `{ key } & AsyncDisposable` 租约，主路径；
    //      租约**必须**释放（finally + asyncDispose），异常路径绝不泄漏
    //      （泄漏后果：registry generation 计数滞留，无法被回收）。
    //    - ≤0.1.6：回退 `standingKeyFor(id)`（直接返回作用域 key，无租约）。
    //    - 两者皆无：落到底 3) 的动态 import 双包名回退。
    //    同一个 preset 只走其中一条路径（能力探测一次定路径），杜绝双路径重复条目。
    const agentPresets = host.get('agentPresets') as
      | {
          list?: () => Promise<unknown>
          acquireScope?: (id?: string) => Promise<{ key: unknown } & AsyncDisposable>
          standingKeyFor?: (id?: string) => Promise<unknown>
        }
      | undefined
    const scopeAcquireAvailable = typeof agentPresets?.acquireScope === 'function'
    const scopeStandingAvailable = !scopeAcquireAvailable && typeof agentPresets?.standingKeyFor === 'function'
    let standingAvailable = false
    if (agentPresets && typeof agentPresets.list === 'function' && (scopeAcquireAvailable || scopeStandingAvailable)) {
      let rows: unknown = []
      try {
        rows = await agentPresets.list()
      } catch (error) {
        warnings.push(`技能目录：预设清单读取失败（${reasonOf(error)}），用户级技能可能缺失`)
        rows = []
      }
      if (Array.isArray(rows)) {
        for (const row of rows) {
          const r = row as { id?: unknown; broken?: unknown }
          const id = typeof r?.id === 'string' ? r.id : ''
          if (!id) continue
          // 损坏预设不可挂载（retain/resolveMountable 会抛错），直接跳过，避免无谓的失败噪声。
          if (r.broken) continue
          try {
            if (scopeAcquireAvailable) {
              // 主路径（0.1.7+）：先取租约，入并集，finally 里必还。
              //
              // ⚠️ 为什么"先释放租约、后面才 list"是安全的（2026-10-02 核实）：
              // 宿主的 `collect(generation)` 仅在 `retired === true && users === 0` 时才
              // `scope.dispose()`，而 `retired` **只在 `unregister()` 时置位**
              // （`packages/preset/agent-preset-registry/src/index.ts:93`）；
              // `acquireScope` 的 retain 只做 `users++/--`，**不置 retired**。
              // ⇒ 此处提前释放**不会**销毁作用域，第 4 步 `skills.list({ scope })` 仍读得到。
              //
              // ⚠️ 这依赖上述实现细节：**若宿主将来改成 `users === 0` 即回收，
              // 本行的提前释放会变成 use-after-dispose**。届时必须把 list 移进
              // 租约作用域内（acquire → addScope + list → finally dispose），不要只改这里。
              const lease = await agentPresets.acquireScope!(id)
              try {
                addScope(lease.key, `预设「${id}」`)
                standingAvailable = true
              } finally {
                await lease[Symbol.asyncDispose]()
              }
            } else {
              // 兼容路径（≤0.1.6）：standingKeyFor 无租约语义，直接取 key。
              const key = await agentPresets.standingKeyFor!(id)
              addScope(key, `预设「${id}」`)
              standingAvailable = true
            }
          } catch (error) {
            warnings.push(`技能目录：预设「${id}」standing 作用域不可用（${reasonOf(error)}），已跳过该预设`)
          }
        }
      }
    }

    // 3) 存活挂载（第 3 级回退 + 补充来源，**恒常运行**）：
    //    - **回退**：服务层没有任何作用域入口（acquireScope/standingKeyFor 均缺）时，
    //      import 模块枚举进程内存活挂载兜底；
    //    - **补充**：服务层可用时也照跑（与 0.1.6 时代行为一致），覆盖"进程内已建立、
    //      但不在 preset 清单"的挂载（如清单读取失败、手工挂载的临时作用域）；
    //    重复作用域由 addScope 去重（同一 scope 对象/原始值只入并集一次），不产生重复条目。
    //    包在 0.1.7 改名 `@deepseek-ai/dsh-agent-preset-registry`：先试新名、回退旧名；
    //    两次 import 各自独立 catch，失败原因全部可见（不静默吞错）。
    let liveModuleOk = false
    let liveMountsFound = 0
    let importErrorsTotal = 0
    {
      const importCandidates: ReadonlyArray<{ specifier: string; load: () => Promise<unknown> }> = [
        {
          specifier: '@deepseek-ai/dsh-agent-preset-registry',
          load: () => import('@deepseek-ai/dsh-agent-preset-registry'),
        },
        {
          specifier: '@deepseek-ai/dsh-agent-presets',
          load: () => import('@deepseek-ai/dsh-agent-presets'),
        },
      ]
      // 新名 import 失败、旧名兜底成功属于**预期内回退**（0.1.7 改名兼容），
      // 不刷 warning；只有全部候选都失败时，才把每个候选的失败原因一起暴露（可归因）。
      const importErrors: string[] = []
      for (const candidate of importCandidates) {
        try {
          const presetsModule = (await candidate.load()) as {
            livePresetMounts?: () => ReadonlyArray<{ key?: unknown }>
          }
          if (typeof presetsModule.livePresetMounts === 'function') {
            liveModuleOk = true
            const mounts = presetsModule.livePresetMounts() ?? []
            liveMountsFound += mounts.length
            for (const mount of mounts) addScope(mount.key, '存活 preset 挂载')
          } else {
            // 装上了却没有承诺的导出：宿主实现漂移，必须可见而不是静默当空。
            warnings.push(`技能目录：preset 挂载模块「${candidate.specifier}」缺少 livePresetMounts 导出`)
          }
          break
        } catch (error) {
          importErrorsTotal += 1
          importErrors.push(`「${candidate.specifier}」不可读（${reasonOf(error)}）`)
        }
      }
      if (!liveModuleOk && importErrors.length > 0) {
        warnings.push(`技能目录：preset 挂载模块全部候选不可读——${importErrors.join('；')}，仅回退服务层作用域`)
      }
    }

    // 4) 逐作用域 list 并集。
    for (const { scope, label } of scopeRefs) {
      try {
        normalizeSkillRows(await skills.list({ scope }), merged)
      } catch (error) {
        warnings.push(`技能目录：${label}作用域层 list 抛错（${reasonOf(error)}）`)
      }
    }

    const result = [...merged.values()].sort((a, b) => a.name.localeCompare(b.name))

    // 仅当「一个可用作用域都没枚举到」且结果确实只有全局层时，才提示仅全局层。
    // 服务层 acquireScope / standingKeyFor 任一成功（冷启动主路径）时 scopeRefs 必含
    // preset 作用域，不会误报；import 层"能读模块但零存活挂载"同样构不成可用作用域，
    // 也要告警 —— 否则冷进程上（挂载尚未建立）会静默只见 24 条全局技能。
    const coldReadUnavailable = !standingAvailable && (importErrorsTotal > 0 || liveMountsFound === 0)
    if (scopeRefs.length === 0 && result.length === globalCount && coldReadUnavailable) {
      warnings.push(
        '技能目录仅含全局层：宿主既未提供 preset 作用域冷读取入口（acquireScope/standingKeyFor），'
          + '也无法读取存活 preset 挂载，用户级技能缺失。请升级 dsh 宿主，'
          + '或开一个会话后点「重新采集目录」。',
      )
    }
    return result
  }

  /** 采集 agent preset。 */
  async function collectPresets(warnings: string[]): Promise<DshPresetOption[]> {
    const presets = host.get('agentPresets') as { list?: () => Promise<unknown> } | undefined
    if (!presets || typeof presets.list !== 'function') {
      warnings.push('预设目录不可用：宿主 agentPresets 服务未提供 list')
      return []
    }
    try {
      const rows = await presets.list()
      if (!Array.isArray(rows)) return []
      return rows
        .map(row => {
          const r = row as { id?: unknown; name?: unknown; description?: unknown; isDefault?: unknown; broken?: unknown }
          const id = typeof r.id === 'string' ? r.id : ''
          if (!id) return undefined
          return {
            id,
            name: typeof r.name === 'string' && r.name ? r.name : id,
            description: typeof r.description === 'string' ? r.description : '',
            isDefault: r.isDefault === true,
            ...(typeof r.broken === 'string' && r.broken ? { broken: r.broken } : {}),
          } satisfies DshPresetOption
        })
        .filter((x): x is DshPresetOption => x !== undefined)
    } catch (error) {
      warnings.push(`预设目录不可用：list 抛错（${reasonOf(error)}）`)
      return []
    }
  }

  /** 采集工作区（同步 API，但仍包 try/catch 统一降级口径）。 */
  function collectWorkspaces(warnings: string[]): DshWorkspaceOption[] {
    const registry = host.get('workspaceRegistry') as { list?: () => unknown } | undefined
    if (!registry || typeof registry.list !== 'function') {
      warnings.push('工作区目录不可用：宿主 workspaceRegistry 服务未提供 list')
      return []
    }
    try {
      const rows = registry.list()
      if (!Array.isArray(rows)) return []
      return rows
        .map(row => {
          const r = row as { id?: unknown; title?: unknown; path?: unknown }
          const path = typeof r.path === 'string' ? r.path : ''
          if (!path) return undefined
          return {
            id: typeof r.id === 'string' ? r.id : path,
            title: typeof r.title === 'string' && r.title ? r.title : path,
            path,
          } satisfies DshWorkspaceOption
        })
        .filter((x): x is DshWorkspaceOption => x !== undefined)
    } catch (error) {
      warnings.push(`工作区目录不可用：list 抛错（${reasonOf(error)}）`)
      return []
    }
  }

  /** 采集 subagent provider 名。 */
  function collectProviders(warnings: string[]): string[] {
    const subagents = host.get('subagents') as { list?: () => unknown } | undefined
    if (!subagents || typeof subagents.list !== 'function') {
      warnings.push('provider 目录不可用：宿主 subagents 服务未提供 list')
      return []
    }
    try {
      const rows = subagents.list()
      if (!Array.isArray(rows)) return []
      return rows.filter((x): x is string => typeof x === 'string' && x.length > 0).sort()
    } catch (error) {
      warnings.push(`provider 目录不可用：list 抛错（${reasonOf(error)}）`)
      return []
    }
  }

  /** 采集 MCP server 名（工具名前缀反推 + 配置兜底）。 */
  function collectMcpServers(warnings: string[]): string[] {
    let schemas: Array<{ name?: unknown }> = []
    try {
      schemas = host.tools?.schemas?.() ?? []
    } catch (error) {
      warnings.push(`MCP 目录：工具清单读取失败（${reasonOf(error)}），已退化为配置兜底清单`)
    }
    const names = mcpServerNamesFromSchemas(schemas, fallbackMcpServers)
    if (names.length === 0) warnings.push('MCP 目录为空：既无已注册的 mcp__* 工具，也无配置兜底清单')
    return names
  }

  async function doRefresh(): Promise<DshCatalog> {
    const warnings: string[] = []
    const [models, skills, presets] = await Promise.all([
      collectModels(warnings),
      collectSkills(warnings),
      collectPresets(warnings),
    ])
    const workspaces = collectWorkspaces(warnings)
    const providers = collectProviders(warnings)
    const mcpServers = collectMcpServers(warnings)
    snapshot = { models, skills, presets, workspaces, providers, mcpServers, warnings, collectedAt: now().toISOString() }
    return snapshot
  }

  return {
    refresh(): Promise<DshCatalog> {
      // 并发共享同一次采集：面板打开 + 手动刷新同时发生时不重复打一轮 provider。
      if (inflight) return inflight
      inflight = doRefresh()
        .catch(error => {
          // doRefresh 内部已逐项兜底；走到这里说明出现未预期错误，返回上一份快照而不是抛给路由。
          snapshot = { ...snapshot, warnings: [...snapshot.warnings, `目录采集异常：${reasonOf(error)}`] }
          return snapshot
        })
        .finally(() => {
          inflight = null
        })
      return inflight
    },
    current(): DshCatalog {
      return snapshot
    },
  }
}

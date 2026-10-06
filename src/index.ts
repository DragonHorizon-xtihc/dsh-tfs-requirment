/**
 * `@deepseek-ai/dsh-tfs-requirment` —— 宿主半入口。
 *
 * 一个 DSH 插件的最小形态是这里的三个导出：`name`、`inject`、`apply`（外加 `Config`）。
 * 宿主半负责一切有状态、有权限的动作：**TFS REST 直连**、凭据 profile、看板状态持久化、
 * 回写四道门禁、角色编排。
 *
 * ## 铁律：TFS 查询与操作一律走 REST，不经 tfs-mcp（2026-09-19）
 *
 * 适配层 `TfsAdapter.call(raw, args)` 把操作键直接分派到 `/_apis/...` 端点，
 * **不经过** `ctx.tools.execute('mcp__<server>__*')`。因此：
 *   - 插件运行期**不需要**宿主装载任何 tfs-mcp 实例；
 *   - `cordis.patch.yml` 不再声明 `@deepseek-ai/dsh-mcp-client` 行；
 *   - 凭据（URL/集合/PAT）由本插件的连接档案服务提供，不依赖 MCP 子进程 env。
 * 参数名仍叫 `raw`（旧工具名形态），只是为了让适配层分支表与历史审计记录不失配。
 *
 * 界面由客户端半（exports `./client`，由 `dsh.client.platform:'web'` 自动加载）承载。
 *
 * ## 装配纪律：每个能力独立降级，且失败要看得见
 *
 * 实测确认（见 dsh-optimized-prompt 先例）：插件模块加载失败时 loader 只打日志并跳过该行，
 * 本插件 id 也不在 `requiredStartupEntryIds` 里，所以不会拖垮 `dsh web`。但 `dsh web` 的启动
 * 审计可能只传空 warn —— 错误在 Web 下不可见，插件会静默消失。因此后续各阶段能力逐个
 * try/catch，单项失败只禁用那一项并把原因写进日志，绝不因为一个可选能力缺失让整个插件消失。
 *
 * @module @deepseek-ai/dsh-tfs-requirment
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, mkdirSync, readdirSync, copyFileSync, statSync, readFileSync } from 'node:fs'
import { Config } from './config.js'
import type { TfsRequirmentConfig } from './config.js'
import { RoleStore, ensureBuiltinRoles } from './orchestration/roles.js'
import { TfsAdapter, IMPLEMENTED_OPERATIONS, type TfsTools } from './tfs/adapter.js'
import { WriteGuard } from './write-guard/index.js'
import { AuditLog } from './write-guard/audit.js'
import { RequirementDispatcher } from './orchestration/dispatch.js'
import { Board } from './core/board/board.js'
import { BoardService } from './host/board-service.js'
import { AuditArchive } from './host/audit-archive.js'
import { ProfileService } from './host/profile-service.js'
import { createHostApi, type HostApi, type ReusedTaskLaunchInput } from './host/api.js'
import { createSubagentClient, probeSubagents } from './host/subagent-access.js'
import { TaskTraceService } from './host/task-trace.js'
import { RequirementFinalizer } from './host/requirement-finalizer.js'
import { createSystemWriteBack } from './tfs/system-writeback.js'
import { registerTfsRoutes } from './host/route.js'
import { createParentResolver } from './host/parent-resolver.js'
import { OrchestratorSessionManager } from './host/orchestrator-session.js'
import { createDshCatalog, type DshCatalogService, type DshCatalogHost } from './host/dsh-catalog.js'
import { pluginToolName, catalogSpecs, catalogView, toolParameterSpec } from './tfs/tool-catalog.js'
import { installSettingsSection, SETTINGS_NAMESPACE } from './host/settings.js'
import { realFs } from './persistence/fs-like.js'

/** 插件名，同时用作 loader 行 id 与客户端 bundle id。 */
export const name = 'tfs-requirment'

/**
 * 依赖的宿主服务（扁平字符串数组，cordis 按元素取服务名）。
 *
 * **不再注入 `tools`**（2026-09-19 REST 化）：旧实现必须靠 `ctx.tools.execute` 才能调
 * 外部 tfs-mcp 实例的 `mcp__tfs-mcp__*` 工具；REST 化后适配层直接用 `fetch` 打 `/_apis/*`，
 * `ctx.tools` 只剩
 * "注册本插件的 `tfs_req_*` 工具"这一个用途 —— 那是**可选能力**（headless 部署没有工具
 * 运行时也不该让插件整体加载失败），故改为 `ctx.get('tools', false)` 惰性取用。
 *
 * `settings`/`slots`/`subagents`/`webServer` 本就用 `ctx.inject` 惰性获取，
 * 这样在缺少 web 服务的装配下本插件仍能加载（只是对应 UI/编排能力不可用），
 * 沿用 dsh-optimized-prompt 的装配纪律。
 */
export const inject = [] as const

export { Config }
export type { TfsRequirmentConfig }

/**
 * 尽力写一行插件日志（可选访问，避免宿主未装 logger 时加载失败）。
 *
 * **必须走 `ctx.get('logger')`**：cordis 的 Context 是 Proxy，对"已注册但未出现在本插件
 * `inject` 里的服务"做**属性读取会抛错**（`vendor/cordis/lib/index.js:672-681`：
 * `cannot get property "X" without inject`）；而 `ctx.get(name, strict)` 明确实现为
 * **未提供时返回 `undefined`**（同文件 `:762-765`），是唯一的非抛出访问器。
 *
 * @param ctx - 宿主上下文。
 * @param level - 日志级别。
 * @param message - 日志正文。
 */
function log(ctx: Context, level: 'info' | 'warn', message: string): void {
  const logger = ctx.get('logger') as Record<string, ((message: string) => void) | undefined> | undefined
  logger?.[level]?.(message)
}

/**
 * 定位**本插件包根目录**（含本插件 package.json 的目录）。
 *
 * 同时兼容两种运行位置（2026-09-19）：
 *   - 源码/tsx：`<root>/src/index.ts`（包根在上一级）；
 *   - tsc 产物：`<root>/lib/types/index.js`（包根在上两级）。
 * 从 `import.meta.url` 所在目录逐级向上，找到 `package.json` 且 `name` 为本插件的目录即止；
 * 最多上溯 8 级，找不到返回 `undefined`（调用方回退 CWD）。
 */
function pluginPackageRoot(): string | undefined {
  try {
    let dir = dirname(fileURLToPath(import.meta.url))
    for (let i = 0; i < 8; i++) {
      const pkgPath = join(dir, 'package.json')
      if (existsSync(pkgPath)) {
        try {
          const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { name?: unknown }
          if (pkg.name === '@deepseek-ai/dsh-tfs-requirment') return dir
        } catch {
          // 旁置 package.json 不可读/非 JSON：继续向上。
        }
      }
      const parent = dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  } catch {
    // import.meta.url 不可用（极老运行时）：回退 CWD。
  }
  return undefined
}

/**
 * 尽力解析插件数据目录（roles.json / 连接档案 / audit 落盘处）。
 *
 * 优先级：宿主 `dataDir` 服务 → `DSH_DATA_DIR` 环境变量 → **插件包根下的
 * `.tfs-requirment-data`** → CWD 相对目录（最终兜底）。
 *
 * 2026-09-19 修复：旧实现缺省回退到 `process.cwd()` 相对目录，而 dsh web 的 CWD
 * 随启动方式变化（实测：插件目录下有完整 profiles.json/凭据，仓库根下只有 roles.json），
 * 导致换个启动方式就读不到连接档案、下拉全空。锚定包根后，任何 CWD 下数据目录都一致。
 *
 * @param ctx - 宿主上下文。
 * @returns 数据目录路径。
 */
function resolveDataDir(ctx: Context): string {
  const get = (ctx as unknown as { get?: (name: string) => unknown }).get
  if (typeof get === 'function') {
    const d = get.call(ctx, 'dataDir')
    if (typeof d === 'string' && d.length > 0) return d
  }
  if (process.env.DSH_DATA_DIR && process.env.DSH_DATA_DIR.length > 0) return process.env.DSH_DATA_DIR
  const root = pluginPackageRoot()
  return join(root ?? process.cwd(), '.tfs-requirment-data')
}

/**
 * 一次性迁移旧 CWD 相对数据目录里的遗留文件到锚定后的包根数据目录。
 *
 * 背景：修复 CWD 漂移前，数据曾被写进 `<仓库根>/.tfs-requirment-data`（如 roles.json），
 * 而连接档案在 `<插件根>/.tfs-requirment-data`。锚定包根后只认后者，需把前者独有的文件
 * 补拷过来，避免角色配置"看似丢失"。**只补目标不存在的文件，绝不覆盖**；任何失败只告警。
 *
 * @param targetDir - 锚定后的目标数据目录。
 * @param ctx - 宿主上下文（用于日志）。
 * @returns 迁移的文件名清单（用于日志）。
 */
function migrateLegacyDataDir(targetDir: string, ctx: Context): string[] {
  const migrated: string[] = []
  try {
    const legacy = join(process.cwd(), '.tfs-requirment-data')
    if (legacy === targetDir || !existsSync(legacy) || !statSync(legacy).isDirectory()) return migrated
    if (!existsSync(targetDir)) mkdirSync(targetDir, { recursive: true })
    for (const name of readdirSync(legacy)) {
      const from = join(legacy, name)
      const to = join(targetDir, name)
      if (!statSync(from).isFile() || existsSync(to)) continue
      copyFileSync(from, to)
      migrated.push(name)
    }
  } catch (error) {
    log(ctx, 'warn', `tfs-requirment: 遗留数据目录迁移失败（${error instanceof Error ? error.message : String(error)}），不影响插件加载`)
  }
  return migrated
}

/**
 * 把封装工具的输出安全字符串化（超限截断，避免超大 TFS 响应撑爆面板/日志）。
 * @param value - 工具返回的任何值。
 * @returns 可展示文本。
 */
function safeToolText(value: unknown): string {
  try {
    const text = typeof value === 'string' ? value : JSON.stringify(value)
    if (text && text.length > 20000) {
      return `${text.slice(0, 20000)}\n…（已截断，原长 ${text.length} 字符）`
    }
    return text ?? ''
  } catch {
    return String(value)
  }
}

/**
 * 装配插件。
 * @param ctx - 宿主上下文。所有依赖（settings / slots / subagents / webServer / dataDir）
 *   均经 `ctx.get()` 惰性读取；`tools` 仅用于注册本插件的 `tfs_req_*` 工具。
 * @param config - 经 `Config` 校验并填过默认值的配置。
 */
export function apply(ctx: Context, config: TfsRequirmentConfig): void {
  log(
    ctx,
    'info',
    `tfs-requirment: 插件加载（Phase 3 集成；collections=${config.collections.join(',')} default=${config.defaultCollection}）`,
  )

  // 宿主依赖读取纪律（**只读不要抓**）：
  //
  // ⚠️ **必须用 `ctx.get(dep)`，绝不能写 `ctx[dep]`**（2026-09-18 真实事故）：
  // cordis 的 Context 是 Proxy，对"已在本 profile 注册、但不在本插件 `inject` 里的服务"
  // 做属性读取会**抛错**（`vendor/cordis/lib/index.js:672-681` → `cannot get property
  // "settings" without inject`），且抛在 `apply` 内 ⇒ loader 判定 `plugin tree failed to load`
  // ⇒ **整个 `dsh web` 起不来**（不是"本插件降级"，是启动整体失败）。
  // 本插件 `inject = []`（REST 化后不再静态依赖任何服务），而 `settings` 在 web profile 里
  // 确实已注册，因此旧写法（`(ctx as Record<string, unknown>)[dep]`）在真实装配下必炸。
  //
  // ⚠️ **apply 期不得据此下"能力禁用"的结论，更不得把结果捕获进闭包**（2026-09-21 真实事故）：
  // `ctx.get(name)` 默认 `strict = true`，在提供方 fiber 尚未激活（`state !== 2`）时返回
  // `undefined`（同文件 `:762-771`）。而本插件 `inject = []`、模块又小，`apply` 往往**早于**
  // `@deepseek-ai/dsh-subagent` 等插件的模块 `import()` 完成 ⇒ 此处探测**必然**为 false。
  // 旧实现据此把"永远抛错的 subagents 桩"钉死进分发器，用户点「派发执行」就得到
  // *宿主 subagents 服务不可用（US4 编排能力禁用）* —— 而运行期该服务其实是好的。
  // 故这里只记录一份快照日志（info，措辞如实），真实能力一律在**调用时**解析
  // （见 `host/subagent-access.ts`）；运行期可达性由面板的 `orchestration` 字段透出。
  const optionalDeps = ['settings', 'slots', 'subagents', 'webServer', 'dataDir', 'tools'] as const
  const notReadyAtApply = optionalDeps.filter(dep => ctx.get(dep) === undefined)
  if (notReadyAtApply.length > 0) {
    log(
      ctx,
      'info',
      `tfs-requirment: apply 期依赖快照：${notReadyAtApply.join(', ')} 尚未激活（正常——这些服务按调用时惰性解析；`
      + '若运行期仍不可用，对应能力才会降级，届时面板/日志会给出具体项与原因）',
    )
  }

  // 持久层：roles.json + 审计日志（凭据不落盘由 AuditLog 保证）。
  const dataDir = resolveDataDir(ctx)
  // CWD 漂移修复的一次性兼容：把旧 CWD 相对目录里独有的文件补拷到包根数据目录。
  const migrated = migrateLegacyDataDir(dataDir, ctx)
  if (migrated.length > 0) {
    log(ctx, 'info', `tfs-requirment: 已从旧数据目录迁移 ${migrated.length} 个文件到 ${dataDir}：${migrated.join(', ')}`)
  }
  const roleStore = new RoleStore(dataDir, realFs)
  const audit = new AuditLog(dataDir, realFs)
  const guard = new WriteGuard(audit)

  // T063 审计滚动归档：`rollOver` 此前无任何调用点，90 天保留策略在运行期并不存在（现补上）。
  const auditArchive = new AuditArchive({
    baseDir: dataDir,
    audit,
    retentionDays: config.auditRetentionDays,
    fs: realFs,
  })

  // T031 连接档案（FR-002/FR-031/S-12）：此前 `ProfileStore` 全项目零引用，此处接入。
  //
  // REST 化后 `ProfileService` 的角色**扩大了**：它不再只是"给 tfs-mcp 子进程准备 env"，
  // 而是本插件 TFS 凭据的**唯一来源** —— `restConfig()` 按调用实时给出 url/集合/PAT，
  // 经 `TfsAdapter` 的 `restConfigProvider` 注入（改 PAT 当场生效、无需重启 dsh）。
  const profileService = new ProfileService({
    baseDir: dataDir,
    fs: realFs,
  })

  /**
   * 可切换集合清单（FR-025/T030）。
   *
   * 用**同一数组实例就地增删**（而非每次重建）：`createHostApi` 的 deps 是值捕获，
   * 配置页保存后若换成新数组，api 里那份仍是旧引用——表现为"设置里改了集合清单，
   * 但切换器里还是旧的"。就地变更让两侧始终看到同一份。
   */
  const allowedCollections: string[] = [...config.collections]

  // 内置角色对账（spec 008 US2）：不再"roles.json 为空才播种"——老店升级时新增的内置角色
  // （如「通用工程师」）永远补不进去。改为按 id 对账：缺失的内置角色补写，已存在的（含用户
  // 改名/改模型）一律不动；同名自定义角色存在时不重复写（展示名必须唯一）。
  try {
    const addedIds = ensureBuiltinRoles(roleStore)
  // `roles.json` 读不到时 `RoleStore.list()` 会回退内置角色（而非抛错，见 roles.ts），
  // 于是 `ensureBuiltinRoles` 看到每个内置 id 都已存在、直接跳过，不会抛异常。因此
  // 「面板显示的是内置角色、保存/删除已被禁用」这件事必须在这里显式说一声——
  // 启动日志原本承诺了这个回退，但此前既没有实现、也没有任何可观测信号。
  if (roleStore.degradedReason) {
    log(ctx, 'warn',
      `tfs-requirment: roles.json 读不到，已回退内置默认角色（读路径可用；保存/删除被拒，避免覆盖原文件）：${roleStore.degradedReason}`)
  }
    if (addedIds.length > 0) {
      const addedNames = addedIds
        .map(id => roleStore.get(id)?.name ?? id)
        .join('、')
      log(ctx, 'info', `tfs-requirment: 已补写 ${addedIds.length} 个内置角色（${addedNames}）到 ${dataDir}/roles.json`)
    }
  } catch (error) {
    log(ctx, 'warn', `tfs-requirment: 角色初始化失败（${error instanceof Error ? error.message : String(error)}），面板将回退内置默认角色`)
  }

  // 适配层：TFS 唯一出口（Principle IV）—— **REST 化（2026-09-19）**。
  //
  // 直连 REST API（铁律：不依赖 tfs-mcp）。凭据来源 = 活动连接档案（ProfileService.restConfig）：
  // PAT 只进 rest 配置在调用栈内拼 Basic 头，不进日志/审计/响应体。
  // 活动档案缺失时 adapter 的调用会失败并给出可读指引（到「连接与凭据」页配置），
  // 这里不硬失败 —— 插件其余能力（角色管理/执行配置等）仍可用。
  const restConfig = profileService.restConfig(config.defaultCollection)
  const adapter = new TfsAdapter({
    // 无连接档案/PAT 时**不传** `rest`：适配层会抛可执行诊断
    // （"TFS 连接未配置（缺少 REST 凭据）：请到「连接与凭据」页…"）。
    // 反例（曾用）：塞 `http://tfs.invalid` 占位 → 用户看到的是"网络不可达/DNS 解析失败"，
    // 被误导去查网络，而真实原因是没配 PAT。
    ...(restConfig ? { rest: restConfig } : {}),
    writeGuard: guard,
    collection: config.defaultCollection,
    // 审计/诊断里的标签用集合名而非 server 名（REST 化后 server 概念已不存在）。
    profileLabel: config.defaultCollection,
    // 活项目清单旁路：REST 主路径已直连 `_apis/projects`，此旁路保留为测试/覆盖点。
    liveProjects: collection => profileService.listLiveProjects(collection),
    // 动态凭据（2026-09-19）：每次 REST 调用都读**当前活动档案**的最新 url/PAT。
    // 装配期无档案（rest 未传）或用户运行时激活/修改档案后，无需重启即可生效，
    // 修掉"项目清单有值、工作类型/状态下拉为空"（类型/状态走 adapter 冻结配置、
    // 项目清单走 liveProjects 动态读取所造成的割裂）。
    restConfigProvider: () => profileService.restConfig(config.defaultCollection),
    // 问题 13：服务器级 /_apis/projectCollections 在此部署 404，集合清单以本地配置为权威兜底。
    knownCollections: allowedCollections,
    // 附件/TFVC 文件下载根目录（问题 13 下载类端点）：锚定插件数据目录，避免 CWD 漂移。
    downloadsDir: join(dataDir, 'downloads'),
    // 「采集可选项」是 O(项目×类型) 次 GET，限流由配置决定（缺省 8）。
    queryOptionsConcurrency: config.queryOptionsConcurrency,
    allowExternalDownloadDir: config.allowExternalDownloadDir,
  })

  // DSH 真实能力目录（问题 4/5/6/7/9/11）：枚举宿主真实可选的模型/MCP/技能/预设/工作区/provider。
  //
  // ⚠️ **必须用 `ctx.get(name, false)`（非严格模式），且首次采集要等宿主服务就绪**（问题 6 根因）。
  //
  // 2026-09-19 实测坐实：`ctx.get(name)` 默认 `strict=true`，当提供该服务的 fiber
  // `state !== 2`（尚未激活）时**返回 `undefined`**（`vendor/cordis/lib/index.js:762-772`，
  // `_getImpl` 在 `:766`）。而本插件的 `void catalog.refresh()` 是在 `apply` 期同步触发的，
  // 此刻 llm/skills/agentPresets/workspaceRegistry/subagents 的 fiber 都还没起来
  // ⇒ 五项全空 + 恰好 5 条 warning，正是用户看到的"工作区/预设/模型下拉为空"。
  //
  // 真实 cordis 复现（一次性探针，用完即删）：
  //   root.get("llm", true)  → undefined    ← 严格模式：fiber 未激活
  //   root.get("llm", false) → 有值          ← 非严格模式：拿得到
  //
  // 因此这里做两件事：
  //   ① `host.get` 用非严格查阅（见下方 `catalogHost`），能读到"已 provide 但 fiber 未激活"的服务；
  //   ② 首次采集不在 `apply` 里裸跑，而是经 `ctx.inject([...])` 延迟到这些服务**真正可用**时再跑
  //      （`ctx.inject` 语义见 `vendor/cordis/lib/types/registry.d.ts:111`：依赖齐备才执行 callback）。
  //      `ctx.inject` 的 callback 跑在嵌套 fiber 里，插件卸载时随父 fiber 一并 dispose，无悬挂。
  const catalogHost: DshCatalogHost = {
    get: (name: string) => (ctx.get as (n: string, strict?: boolean) => unknown)(name, false),
    get tools() {
      // `tools` 已不在 `inject` 里（REST 化后非必需），改用非严格访问器读取。
      return (ctx.get as (n: string, strict?: boolean) => unknown)('tools', false) as DshCatalogHost['tools']
    },
  }
  const catalog: DshCatalogService = createDshCatalog({
    host: catalogHost,
    // 兜底 MCP 清单：本插件**不再依赖**任何 mcp server（TFS 走 REST），
    // 但 DSH 里可能装着其它用途的 server，面板仍需如实呈现"宿主当前有哪些 MCP"。
    // 故留空数组，由 `tools.schemas()` 的 `mcp__<server>__*` 前缀反推真实清单。
    fallbackMcpServers: [],
  })
  // 依赖名取"本插件想读、但不敢放进 `inject`"的那几个（放进 `inject` 会在缺服务的部署上
  // 让插件整体加载失败）。`ctx.inject` 只在**全部**就绪时执行，故缺任何一个都不会触发；
  // 此时退化为"面板打开时经 refreshPanelData 再采"，能力降级但不静默变空（warnings 会带原因）。
  ctx.inject(
    ['llm', 'skills', 'agentPresets', 'workspaceRegistry', 'subagents'] as never,
    () => {
      void catalog.refresh()
    },
  )

  // ── 原始 mcp 工具黑名单：**REST 化后已不再需要**（2026-09-19） ──
  //
  // 旧实现（问题 8 / 12）在派发时把 `mcp__<server>__*` 工具名从子 agent 的工具面上剔除，
  // 防止模型绕过写门禁直接调 tfs-mcp。REST 化后**本插件不再依赖任何 tfs mcp 实例**：
  // 宿主若没装 tfs-mcp，那些工具根本不存在，黑名单是空操作；宿主若装了，那也是用户
  // 自己的独立配置，不属于本插件该管的事（管了反而是越权 + 让本插件偷偷依赖它）。
  //
  // 写门禁的保障随之变为**结构性**的，比黑名单更强：
  //   - TFS 写操作在本插件里**只有** `adapter.executeWrite` 一条路径，且必过四道门禁；
  //   - 写操作落地为 `fetch('PATCH /_apis/wit/workitems/{id}')`，凭据由连接档案提供 ——
  //     模型即使想绕，也没有第二条带凭据的通路可走。
  //
  // 故 `tfsToolDeny` 已被移除（配置里的 `tfsServerName` 也同步废弃）。

  // 分发器：并发上限来自配置（FR-029）。
  //
  // ⚠️ `createSubagentClient(ctx)` 传的是 **ctx**，不是服务实例：服务在每次 `start` 时
  // 重新解析（apply 期解析必然拿到 undefined，理由见上方依赖读取纪律与
  // `host/subagent-access.ts` 的模块注释）。
  const dispatcher = new RequirementDispatcher(
    createSubagentClient(ctx),
    config.maxConcurrentRequirements,
    {
      // 问题 1：单次 run 总时长看门狗（0 = 不启用），防止子 agent 死循环 / 失控空转永久占用。
      ...(config.runTimeoutMinutes > 0 ? { runTimeoutMs: config.runTimeoutMinutes * 60_000 } : {}),
      // 问题 1：委派深度默认上限（0 = 不限制），硬限制在分发器层强制，prompt 纪律段与之保持一致。
      ...(config.defaultMaxDepth > 0 ? { defaultMaxDepth: config.defaultMaxDepth } : {}),
      // 问题 1：单次输出 token 默认上限（0 = 不限制）；任务级 maxTokens 优先于此默认。
      ...(config.defaultMaxTokens > 0 ? { defaultMaxTokens: config.defaultMaxTokens } : {}),
    },
  )

  // 看板服务：把核心看板引擎 + JSON 权威落盘 + 事件日志 + Markdown 渲染 + tfs 写出口接起来
  // （US2 领取同步 / US3 任务中心 / T048 打标签 / US6 跨重启恢复）。
  let boardService: BoardService | undefined
  try {
    boardService = new BoardService({
      baseDir: dataDir,
      fs: realFs,
      board: new Board(),
      adapter,
      roles: roleStore,
      defaultLabel: config.defaultLabel,
      getRuntimeCounts: () => ({ running: dispatcher.activeCount, queued: dispatcher.queuedCount }),
      // 取消任务（D5）：复用 continuable 任务由编排器取消（中断当前轮 + 让本轮等待收口 + 释放槽），
      // 命中即返回；否则回退 ONE-SHOT 派发器取消（abort + dispose + 归还并发槽）。
      // 闭包延迟引用下方才声明的 orchestrator —— 取消只可能发生在装配完成之后，无 TDZ 问题。
      cancelRun: async (taskId: string) => {
        if (orchestrator && orchestrator.cancelReusedTask(taskId)) return
        await dispatcher.cancel(taskId)
      },
      // D4：还原需求时释放其 continuable 任务子会话（best-effort，返回可读 warning）。
      disposeRequirementSessions: (sessionIds: string[]) =>
        orchestrator
          ? orchestrator.drainRequirementSessions(sessionIds)
          : Promise.resolve(undefined),
    })
    const restored = boardService.load()
    if (!restored.ok) {
      // FR-020：解析失败保留原文件、不静默重建。看板能力降级但插件照常加载。
      log(ctx, 'warn', `tfs-requirment: 看板恢复失败（${restored.reason}）——看板读写已降级，原文件未被改动`)
      boardService = undefined
    } else {
      if (restored.recovered) log(ctx, 'info', `tfs-requirment: 已从 ${dataDir}/board.json 恢复看板`)
      // T060/S-10 崩溃对账：把重启后悬空的 running 任务标失败并提示人工核对（不自动重跑）。
      // 同时做**需求完成对账**（问题 3）：升级前已全部做完、但需求记录里还没有 execState 的历史数据，
      // 在这里一次性补齐并落盘（实机：需求 1997179 三个任务全 completed 却留在「任务中心」）。
      const rec = boardService.reconcile()
      if (rec.dangling.length > 0) {
        log(ctx, 'warn', `tfs-requirment: 崩溃对账发现 ${rec.dangling.length} 个悬空任务已标失败（待人工核对 S-10）：${rec.dangling.join(', ')}`)
      }
      if (rec.migratedRequirements.length > 0) {
        log(ctx, 'info', `tfs-requirment: 需求完成对账补齐 ${rec.migratedRequirements.length} 条已完成需求（已迁入「已完成」页）：${rec.migratedRequirements.join(', ')}`)
      }
    }
  } catch (error) {
    log(ctx, 'warn', `tfs-requirment: 看板服务初始化失败（${error instanceof Error ? error.message : String(error)}），任务中心能力禁用`)
  }

  // ── 运行期假执行巡检（补 `Board.reconcileUnboundRunning` 的调用点） ──
  //
  // 装载时的崩溃对账只覆盖重启前遗留的悬空；进程长驻期间新产生的悬空（丢失的 HTTP
  // 请求、复用会话投递后无人观测、`getRun` 未返回 run）没有第二次巡检就会永远停在
  // 「执行中」，并挡住该任务的全部编辑。只收割**未绑定 runId** 的打开尝试：已绑定的
  // 说明子 agent 在跑，交给分发器的总时长看门狗，插件不代它下结论。
  const reapStaleMs = Math.max(1, Math.floor(config.staleRunningReapMinutes)) * 60_000
  const sweepMs = Math.max(1, Math.floor(config.staleRunningSweepSeconds)) * 1000
  if (boardService && config.staleRunningReapMinutes > 0 && config.staleRunningSweepSeconds > 0) {
    const sweep = boardService
    ctx.effect(() => {
      const timer = setInterval(() => {
        try {
          const reaped = sweep.reapStaleRunning(reapStaleMs)
          if (reaped.length > 0) {
            log(
              ctx,
              'warn',
              `tfs-requirment: 运行期巡检把 ${reaped.length} 个未绑定子会话的悬空任务标失败（待人工核对）：${reaped.join(', ')}`,
            )
          }
        } catch (error) {
          log(ctx, 'warn', `tfs-requirment: 运行期巡检失败（${error instanceof Error ? error.message : String(error)}）`)
        }
      }, sweepMs)
      return () => clearInterval(timer)
    })
  }

  // ── 已实现的操作清单（T028b 面板展示能力面/缺口，降级可见） ──
  //
  // REST 化后不再需要"从 ctx.tools 反推实例注册了哪些工具"：能力面由适配层
  // `call()` 的分支表**静态决定**（见 `IMPLEMENTED_OPERATIONS`）。这条替代了旧的
  // `listTfsTools()`（读 `ctx.tools.schemas()` 再按 `mcp__<server>__` 前缀过滤），
  // 好处是**不再依赖宿主装载任何 MCP 实例**，且不会因为工具面滞后于代码而误报缺失。
  const listImplementedOperations = (): string[] => [...IMPLEMENTED_OPERATIONS]

  // spec 006 US2：任务执行轨迹服务。按 attempt.runId 经宿主 sessionQuery 冷读/活读子会话事件。
  // sessionQuery 用非严格惰性查阅（与 catalogHost 同一纪律）：缺失时 getTrace 返回 available:false，
  // 不进 inject、不拖垮插件加载；看板服务降级时同样不构造。
  const taskTrace = boardService
    ? new TaskTraceService({
        board: boardService.board,
        getSessionQuery: () => (ctx.get as (n: string, strict?: boolean) => unknown)('sessionQuery', false),
      })
    : undefined

  // 问题 4：需求完成自动回写器。port 走 TFS REST 系统写通道（复用 adapter 公开方法），
  // 报告经 BoardService 落进 board.json（兼作重跑幂等账本）。看板降级时不构造（api 侧 finalizer 缺失即不回写）。
  const finalizer = boardService
    ? new RequirementFinalizer({
        board: boardService.board,
        port: createSystemWriteBack(adapter),
        saveReport: (key, report) => boardService?.setRequirementWriteBack(key, report),
      })
    : undefined

  /**
   * US4 派发的硬前提：必须是**真实宿主 Agent**（理由见 `createParentResolver` 的注释）。
   * spec 010 起编排会话也用**同一个**解析器：两处各建一个会让"最近活跃 Agent"的记忆分叉，
   * 出现"任务派给了会话 A、编排会话派生自会话 B"的错位。
   */
  const getParent = createParentResolver(ctx)

  /**
   * spec 010：惰性取宿主 sessionQuery（与 taskTrace 同一纪律：缺失时降级，不进 inject）。
   * 用作 continuable 子会话收口的**兜底观测**（事件收不到时轮询会话日志）。
   */
  const getSessionQuery = (): unknown =>
    (ctx.get as (n: string, strict?: boolean) => unknown)('sessionQuery', false)

  // spec 010：需求级「编排主 agent」会话（归纳 / 最终总结）。看板降级时不构造（能力整体不可用）。
  const orchestrator: OrchestratorSessionManager | undefined = boardService
    ? new OrchestratorSessionManager({
        ctx,
        board: boardService,
        getParent,
        getSessionQuery,
        provider: config.orchestratorProvider,
        enabled: config.orchestratorEnabled,
        summarizeTimeoutMs: Math.max(1, config.summarizeTimeoutSeconds) * 1000,
        finalizeTimeoutMs: Math.max(1, config.finalizeTimeoutSeconds) * 1000,
        taskSettleTimeoutMs: Math.max(1, config.taskSessionSettleTimeoutMinutes) * 60_000,
        ...(config.defaultMaxDepth > 0 ? { maxDepth: config.defaultMaxDepth } : {}),
        ...(config.defaultMaxTokens > 0 ? { maxTokens: config.defaultMaxTokens } : {}),
        reuseTaskSessions: config.reuseTaskSessions,
        // 复用路径与 ONE-SHOT **共用同一个并发信号量**（不能顺手放大并发）。
        slot: { acquire: () => dispatcher.acquireSlot(), release: () => dispatcher.releaseSlot() },
      })
    : undefined

  // 编排核心：聚合面板数据 / 确认回写 / 派发 / 看板 / 自检 / 审计归档 / 集合切换 / 连接档案。
  const api: HostApi = createHostApi({
    roles: roleStore,
    adapter,
    dispatcher,
    ...(boardService ? { board: boardService } : {}),
    ...(taskTrace ? { trace: taskTrace } : {}),
    health: { port: adapter, availableTools: listImplementedOperations },
    audit: auditArchive,
    profiles: profileService,
    // US4 派发的硬前提：必须是**真实宿主 Agent**，理由见 createParentResolver 的注释
    // （旧实现 `ctx as unknown as Agent` 会在宿主 subagent 驱动里抛 TypeError，
    //   造成"看板 running、子 agent 从未创建、零 token"的假执行）。
    getParent,
    // spec 010：编排主 agent（归纳 / 最终总结）与任务会话复用。
    ...(orchestrator
      ? {
          orchestrator,
          reuseTaskSessions: config.reuseTaskSessions,
          launchReusedTask: (input: ReusedTaskLaunchInput) => orchestrator.launchReusedTask(input),
        }
      : {}),
    // spec 010：归纳/总结的"放行宽限" —— 链路推进不为增强能力让路。
    summarizeGraceMs: Math.max(1, config.summarizeGraceSeconds) * 1000,
    finalizeGraceMs: Math.max(1, config.finalizeGraceSeconds) * 1000,
    models: ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'glm-4.6'],
    // US4 编排能力可达性：**调用时**探测（与 `createSubagentClient` 同一访问器），
    // 面板据此在点击「发起执行」之前就告知"能不能派发"，而不是点完才炸出
    // "宿主 subagents 服务不可用"。
    probeOrchestration: () => probeSubagents(ctx),
    // REST 化后本插件不依赖任何 mcp server，故这里传空（面板的 MCP 下拉取自 catalog 真实清单）。
    mcpServers: [],
    skills: [],
    tagSuggestions: [config.defaultLabel, 'tfs-requirment', 'auto'],
    collection: config.defaultCollection,
    // 当前**生效**集合：切换集合是运行期副作用（改的是适配层，不是这份 deps 快照），
    // 可选项缓存键必须跟着它走，否则切集合后仍按旧集合名采集。
    currentCollection: () => adapter.currentCollection,
    collections: allowedCollections,
    pollIntervalMinutes: config.pollIntervalMinutes,
    // 问题 5：批量派发的单波并发上限，与 dispatcher 的并发队列对齐。
    dispatchConcurrency: config.maxConcurrentRequirements,
    // 问题 6：依赖任务完成后宿主侧自动链式启动下一条就绪任务（关闭则退回逐个手动点击）。
    autoChainTasks: config.autoChainTasks,
    // 问题 4：需求全部任务完成后自动回写 TFS（评审/自测字段、结论评论、产物附件、关联任务）。
    autoWriteBack: config.autoWriteBack,
    // 问题 1：委派深度默认上限（与分发器硬限制、prompt 纪律段保持一致；0 = 不限制）。
    ...(config.defaultMaxDepth > 0 ? { defaultMaxDepth: config.defaultMaxDepth } : {}),
    ...(finalizer ? { finalizer } : {}),
    // DSH 真实能力目录（问题 4/5/6/7/9/11）。
    catalog,
    // 能力目录现算：全表 + 标注适配层未实现的缺口（不再是"按实例收敛"）。
    tfsToolCatalog: () => catalogView(IMPLEMENTED_OPERATIONS),
    // 真实副作用：切换集合立即改变适配层的默认集合（不是只改 UI 状态）。
    onCollectionChange: next => adapter.setCollection(next),
  })

  // 路由注册失败则按钮点了没反应，这是最需要被看见的降级，单独打日志。
  // 用 ctx.inject(['webServer'], ...) 惰性注册：无 web 服务（headless/TUI）时插件照常加载。
  try {
    registerTfsRoutes(ctx, api)
    log(
      ctx,
      'info',
      'tfs-requirment: 已注册 client→host 路由（panel-data / confirm-write / dispatch / requirements / roles / board / claim / decompose / task-assign / task-state / health / audit / audit-archive / collection / profiles / profile-save / profile-delete / profile-activate / mcp-instance / mcp-env-file）',
    )
  } catch (error) {
    log(ctx, 'warn', `tfs-requirment: 注册路由失败（${error instanceof Error ? error.message : String(error)}），面板按钮将不可用`)
  }

  // US1/T028：设置区注册。失败只失去"配置页分区"，不影响工具/看板。
  try {
    const ok = installSettingsSection(ctx, config, {
      onResolved: next => {
        // 配置变更后把默认集合同步到 adapter（真实的运行期效果，非空回调）。
        adapter.setCollection(next.defaultCollection)
        // 集合清单就地刷新（保持数组引用，见 allowedCollections 注释）。
        allowedCollections.length = 0
        allowedCollections.push(...(next.collections.length > 0 ? next.collections : [next.defaultCollection]))
        log(ctx, 'info', `tfs-requirment: 配置已解析（defaultCollection=${next.defaultCollection}）`)
      /**
       * 其余配置项在**装配时**被各组件捕获（`RequirementDispatcher` 的并发上限与运行
       * 超时、`OrchestratorSessionManager` 的归纳/收口超时与复用开关、`AuditArchive`
       * 的保留天数、面板数据依赖里的 `autoChainTasks`/`autoWriteBack`），改配置后不会
       * 立即生效。此前这里只更新集合并记一条"配置已解析"的信息日志，用户在设置页改完
       * 并重启之前完全看不出改动尚未生效——于是"改了没用"。现在显式点名这些键。
       */
      const applyTimeKeys: Array<keyof typeof next> = [
        'maxConcurrentRequirements', 'runTimeoutMinutes', 'staleRunningReapMinutes',
        'staleRunningSweepSeconds', 'orchestratorEnabled', 'orchestratorProvider',
        'reuseTaskSessions', 'summarizeTimeoutSeconds', 'summarizeGraceSeconds',
        'finalizeTimeoutSeconds', 'finalizeGraceSeconds', 'taskSessionSettleTimeoutMinutes',
        'auditRetentionDays', 'autoChainTasks', 'autoWriteBack', 'allowModelWrites',
        'queryOptionsConcurrency', 'allowExternalDownloadDir', 'enabled', 'defaultMaxDepth',
        'defaultMaxTokens',
      ]
      const changed = applyTimeKeys.filter(key => next[key] !== config[key])
      if (changed.length > 0) {
        log(ctx, 'warn',
          `tfs-requirment: 以下配置项已保存但**在下次 dsh 启动后才生效**（本次运行仍用装载时的值）：${changed.join('、')}`)
      }
      },
    })
    if (ok) log(ctx, 'info', `tfs-requirment: 已注册设置区命名空间 "${SETTINGS_NAMESPACE}"`)
    else log(ctx, 'warn', 'tfs-requirment: 宿主无 settings 服务，配置页分区不可用（工具与看板不受影响）')
  } catch (error) {
    log(ctx, 'warn', `tfs-requirment: 注册设置区失败（${error instanceof Error ? error.message : String(error)}）`)
  }

  // ── 注册插件自有工具 `tfs_req_*`（可选能力） ──
  //
  // 这些工具让**主会话的模型**也能直接操作 TFS（读 + 写），写操作同样过四道门禁。
  // 但 `ctx.tools` 是**可选服务**：headless / TUI 部署可能没有工具运行时，
  // 那不是错误，插件其余能力（面板 / 看板 / 分发）照常工作 ⇒ 缺失时仅打一行 info。
  //
  // REST 化后不再需要"按实例收敛"（旧 `catalogFromRawNames(listTfsTools())`）：
  // 能力面由 `IMPLEMENTED_OPERATIONS` 静态决定，未实现的操作**不注册**，
  // 避免"工具存在但一调就报未映射"的假能力。
  const toolsRuntime = ctx.get('tools') as unknown as TfsTools | undefined
  if (!toolsRuntime || typeof toolsRuntime.register !== 'function') {
    log(ctx, 'info', 'tfs-requirment: 宿主无 tools 服务，tfs_req_* 工具未注册（面板与看板不受影响）')
  } else {
    try {
      let registered = 0
      for (const spec of catalogSpecs()) {
        if (!IMPLEMENTED_OPERATIONS.has(spec.raw)) continue
        const toolName = pluginToolName(spec.raw)
        try {
          toolsRuntime.register(
            defineTool({
              name: toolName,
              description:
                `（TFS REST 直连）${spec.title}：${spec.description}` +
                ` 参数：一个 JSON 对象，字段名见描述中的「参数」说明。` +
                // 写工具默认被门禁 2 拦住；不说清楚的话模型只会看到「未确认回写（门禁2）」，
                // 不知道这是配置决定的、且该找谁。
                (spec.access === 'write' && !config.allowModelWrites
                  ? ' 【当前部署未开启 allowModelWrites：本次写操作会被写门禁2（人工确认）拒绝，请在 TFS 工作台面板执行】'
                  : ''),
              // 参数表由契约条目的 params 生成（见 toolParameterSpec）：模型能拿到参数名与
              // 必填项，此前 `parameters: {}` 让两者都不可见，适配层的必填校验只能靠模型猜。
              parameters: toolParameterSpec(spec),
              output: {
                schema: { type: 'json' },
                render: (_args, value) => [{ type: 'text', text: safeToolText(value) }],
              },
              execute: async (args) => {
                const result =
                  spec.access === 'write'
                    ? await adapter.wrappedWrite(
                      spec.raw,
                      (args ?? {}) as Record<string, unknown>,
                      // 写门禁 2 是「人工确认」。模型发起的写**不构成**人工确认，除非部署
                      // 显式把 allowModelWrites 打开（默认 false）：否则门禁 2 恒为真，
                      // 「任何写操作必须过人工确认」就是一句空话。
                      config.allowModelWrites,
                    )
                    : await adapter.wrappedCall(spec.raw, args)
                // 输出被声明为 JSON；返回值的运行时形态即 TFS 业务载荷（JSON 兼容）。
                // 类型层用 never 桥接（JsonValue 未被包根导出，且 never 可赋值给 JsonValue）。
                return result as unknown as never
              },
            }),
          )
          registered += 1
        } catch (error) {
          log(ctx, 'warn', `tfs-requirment: 注册工具 ${toolName} 失败（${error instanceof Error ? error.message : String(error)}）`)
        }
      }
      log(
        ctx,
        'info',
        `tfs-requirment: 已注册 ${registered}/${IMPLEMENTED_OPERATIONS.size} 个 tfs_req_* 工具（REST 直连；契约表登记 ${catalogSpecs().length} 条，已全部接入 _apis 端点）`,
      )
    } catch (error) {
      log(ctx, 'warn', `tfs-requirment: 注册 tfs_req_* 工具失败（${error instanceof Error ? error.message : String(error)}）`)
    }
  }
}

/**
 * TFS 连接档案服务（T031 多 profile / FR-002 / FR-031 / S-12）。
 *
 * ## REST 化后的定位（2026-09-19）
 *
 * 本服务原先的旁支职责是"为 tfs-mcp 子进程准备启动环境"。REST 化后 **tfs-mcp 已整体移出**，
 * 本服务升格为本插件 TFS 凭据的**唯一来源**：
 *
 *   `ProfileService.restConfig()` → `TfsAdapter` 的 `restConfigProvider`
 *     → `/_apis/...` 的 `Authorization: Basic` 头
 *
 * 因此**改 PAT 当场生效、无需重启 dsh** —— 这是 REST 化带来的最直接的可用性提升。
 * 旧设计下 PAT 必须经 `cordis.patch.yml` 的 `env` 做 `!!js process.env.*` 声明，
 * 而 `!!js` 在**配置解析期**求值，早于任何插件 apply ⇒ 插件无法在运行期注入凭据。
 *
 * ## 为什么保留 `ProfileStore` 这一层
 *
 * 1. **`ProfileStore` 曾是死代码**：`src/profile/store.ts`（PAT 隔离、擦除删除）实现完整，
 *    但除自身模块外**全项目零引用**——FR-002/FR-031 在运行期并不存在。本模块把它接进宿主半。
 * 2. **凭据不落响应体/日志**是本模块的核心契约（见下方「安全契约」），
 *    而 REST 化让这条契约变得更关键：PAT 现在直接进 HTTP 头，泄漏面更大。
 *
 * ## 安全契约
 * - `list()` / `save()` / `activate()` **绝不回显 PAT**（只返回 `ProfileView`）；
 * - `getCredential()` 仅在 `restConfig()` 与导出用凭据文件这两条路径上被调用；
 * - `delete()` 走 `ProfileStore` 的随机字节覆写（S-12）。
 *
 * @module dsh-tfs-requirment/host/profile-service
 */

import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import { ProfileStore, type ProfileSummary, type TfsProfile } from '../profile/store.js'
import { JsonStore } from '../persistence/json-store.js'
import { realFs, type FsLike } from '../persistence/fs-like.js'
import type {
  EnvFileResult,
  McpEnvTemplate,
  McpInstanceInfo,
  ProfileOpResult,
  ProfileSaveInput,
  ProfileView,
} from '../shared/contracts.js'

/** 导出文件名（落插件数据目录，与 `profiles.json` 同目录）。 */
export const ENV_FILE_NAME = 'tfs-credentials.env'

/** 导出文件里的变量名。 */
export const TFS_ENV_KEYS = {
  url: 'TFS_URL',
  collection: 'TFS_COLLECTION',
  pat: 'TFS_PAT',
} as const

/** 活动档案记录（单独小文件，避免与含 PAT 的 profiles.json 混写）。 */
interface ActiveProfileRecord {
  activeId: string | null
}

/** 依赖。 */
export interface ProfileServiceDeps {
  /** 插件数据目录。 */
  baseDir: string
  /** profile 存储（可注入内存实现）。 */
  store?: ProfileStore
  /** 可注入文件系统。 */
  fs?: FsLike
}

/** 操作结果。 */
export type { ProfileOpResult } from '../shared/contracts.js'

/** 把存储层摘要转为客户端视图（二者形状一致，此处显式转换以锁死"绝不带 pat"）。 */
function toView(p: ProfileSummary): ProfileView {
  return { id: p.id, name: p.name, url: p.url, collection: p.collection }
}

/**
 * TFS 连接档案服务。
 */
export class ProfileService {
  private readonly fs: FsLike
  private readonly store: ProfileStore
  private readonly activeStore: JsonStore<ActiveProfileRecord>

  constructor(private readonly deps: ProfileServiceDeps) {
    this.fs = deps.fs ?? realFs
    this.store = deps.store ?? new ProfileStore(deps.baseDir, this.fs)
    this.activeStore = new JsonStore<ActiveProfileRecord>({
      baseDir: deps.baseDir,
      fileName: 'profile-active.json',
      fs: this.fs,
    })
  }

  /** 导出文件绝对路径。 */
  get envFilePath(): string {
    return join(this.deps.baseDir, ENV_FILE_NAME)
  }

  /** 全部档案摘要（**不含 PAT**）。 */
  list(): ProfileView[] {
    try {
      return this.store.list().map(toView)
    } catch {
      return []
    }
  }

  /** 取单个档案摘要；不存在返回 undefined。 */
  get(id: string): ProfileView | undefined {
    /**
     * 与 `list()` / `activeId()` 同样降级：`profiles.json` 解析失败时不能把异常抛出去。
     * `get()` 是 `getPanelData`、`activateProfile`、`getMcpInstance`、`writeMcpEnvFile`
     * 的共同入口，抛错会让整个面板的数据路由变成无响应、无原因的空挂请求；
     * 而"读不到档案"与"没有这个档案"对上层是同一种可用状态（未配置 / 未激活）。
     */
    try {
      const p = this.store.get(id)
      return p ? toView(p) : undefined
    } catch {
      return undefined
    }
  }

  /** 当前活动档案 id（无则 undefined）。 */
  activeId(): string | undefined {
    try {
      return this.activeStore.read()?.activeId ?? undefined
    } catch {
      return undefined
    }
  }

  /**
   * 活动档案的 REST 连接配置（REST 化改造，2026-09-19）。
   *
   * REST 化后本插件直连 TFS（不再经 tfs-mcp），adapter 需要 url/collection/pat 三件套。
   * 返回值**含 PAT 明文**，只允许交给 `TfsAdapter` 的 `rest` 配置（其内部仅在拼 Basic 头
   * 时使用，不进日志/审计/响应体）；无活动档案或凭据缺失时返回 `undefined`，
   * 调用方应提示用户先到「连接与凭据」页保存档案。
   */
  restConfig(collectionOverride?: string): { url: string; collection: string; pat: string } | undefined {
    const id = this.activeId()
    if (!id) return undefined
    const view = this.get(id)
    if (!view) return undefined
    const pat = this.store.getCredential(id)
    if (!pat) return undefined
    const collection = (collectionOverride ?? view.collection ?? '').trim()
    if (!view.url || !collection) return undefined
    return { url: view.url, collection, pat }
  }

  /**
   * 保存/更新档案。PAT 只进存储，**不回显**。
   *
   * 校验：`name` 非空、`url` 以 `http://` / `https://` 开头、`collection` 非空、`pat` 非空
   * （更新既有档案时 `pat` 可省略，表示"沿用原 PAT"——避免 UI 为了改名而被迫重新粘贴 PAT）。
   */
  save(input: ProfileSaveInput): ProfileOpResult {
    const name = (input.name ?? '').trim()
    if (name.length === 0) return { ok: false, reason: 'name 不可为空' }
    const url = (input.url ?? '').trim()
    if (!/^https?:\/\//i.test(url)) return { ok: false, reason: 'url 必须以 http:// 或 https:// 开头' }
    const collection = (input.collection ?? '').trim()
    if (collection.length === 0) return { ok: false, reason: 'collection 不可为空' }

    const id = input.id?.trim() || `p-${randomUUID().slice(0, 8)}`
    let pat = input.pat ?? ''
    if (pat.length === 0) {
      const existing = this.store.getCredential(id)
      if (!existing) return { ok: false, reason: '新建档案必须提供 pat（PAT 不会被回显，故不能留空）' }
      pat = existing
    }

    const record: TfsProfile = { id, name, url, collection, pat }
    try {
      this.store.save(record)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    return { ok: true, profile: { id, name, url, collection } }
  }

  /** 删除档案（随机字节覆写，S-12）；若删除的是活动档案则清空活动指针。 */
  remove(id: string): ProfileOpResult {
    let removed: boolean
    try {
      removed = this.store.delete(id)
    } catch (e) {
      return { ok: false, reason: (e as Error).message }
    }
    if (!removed) return { ok: false, reason: `档案 ${id} 不存在` }
    if (this.activeId() === id) {
      try {
        this.activeStore.write({ activeId: null })
      } catch {
        /* 活动指针清理失败不影响删除结果（下次 activate 会覆盖）。 */
      }
    }
    return { ok: true }
  }

  /**
   * 设为活动档案。
   *
   * **REST 化后是真的立即生效**（2026-09-19）：`TfsAdapter` 经 `restConfigProvider`
   * 每次调用都向本服务取最新凭据，故切换档案 = 下一次 TFS 调用就用新 url/PAT/集合，
   * 无需重启 dsh。调用方另需 `adapter.setCollection()` 把集合同步进本地默认值。
   *
   * （旧设计下这里只能"持久化指针"——已启动的 tfs-mcp 子进程环境改不了，必须重启。）
   */
  activate(id: string): ProfileOpResult {
    const view = this.get(id)
    if (!view) return { ok: false, reason: `档案 ${id} 不存在` }
    try {
      this.activeStore.write({ activeId: id })
    } catch (e) {
      return { ok: false, reason: `写入活动档案指针失败：${(e as Error).message}` }
    }
    return { ok: true, profile: view }
  }

  /**
   * 生成凭据导出模板（**PAT 用占位符，绝不含明文**）。
   *
   * 用途已从"给 tfs-mcp 子进程准备启动环境"变为**可移植的凭据备份/迁移**：
   * 换机器或换 dsh 实例时，按模板导出后重新导入即可，不必重新申请 PAT。
   * @param profileId - 指定档案；缺省用活动档案。
   */
  envTemplate(profileId?: string): McpEnvTemplate {
    const id = profileId ?? this.activeId()
    const view = id ? this.get(id) : undefined
    const k = TFS_ENV_KEYS
    const urlValue = view?.url ?? '<TFS_URL，如 http://tfs2018-web.winning.com.cn:8080/tfs>'
    const collectionValue = view?.collection ?? '<集合名，如 WN_HIS>'
    const patPlaceholder = '<在此填入 PAT，或先由本页「导出凭据文件」生成>'
    return {
      ok: true,
      serverName: '',
      serverNameValid: true,
      profileId: view?.id,
      envFilePath: this.envFilePath,
      // 两套 shell 语法分别显式给出：不做"从 POSIX 文本反推 PowerShell"的字符串变换，
      // 那种变换一旦 URL 里含 `=` 或引号就会生成损坏的命令。
      posixLines: [
        `export ${k.url}='${urlValue}'`,
        `export ${k.collection}='${collectionValue}'`,
        `export ${k.pat}='${patPlaceholder}'`,
      ],
      powershellLines: [
        `$env:${k.url} = '${urlValue}'`,
        `$env:${k.collection} = '${collectionValue}'`,
        `$env:${k.pat} = '${patPlaceholder}'`,
      ],
      note:
        '本插件直连 TFS REST，凭据从活动档案实时读取，**不需要**在启动 dsh 前 export 任何变量。' +
        '此处导出的文件用于凭据备份/迁移（换机器时按模板重新导入档案）。',
    }
  }

  /**
   * 直连 TFS REST 取**活的**项目清单（问题 3 修复，2026-09-19）。
   *
   * ## 为什么必须由本服务出这个口
   *
   * `tfs_get_projects` 在旧 tfs-mcp 里是**硬编码常量表**，不接受 `collection` 参数，
   * 且旧实现全库没有任何 `_apis/projects` 调用（都实测核实过）。WN_HIS 在表里只有 7 项
   * （还含拼错的 `Framework`），而真实有 **62** 项 ⇒ 体检管理 / 4.0产品后台 / ACIS / ASMC
   * 这些真实项目永远进不了下拉。
   *
   * 只有本服务同时持有 `url` 与 `pat`，所以这个 REST 调用只能放这里。凭据**只在本方法栈内**
   * 用于拼 Basic 头，不进返回值、不进日志（失败信息先过 `scrubCredentials`）。
   *
   * 用 Node 内置 `fetch`（Node ≥18），不引第三方 HTTP 依赖。
   *
   * @param collection - 目标集合；缺省用活动档案的集合。
   * @returns 项目名清单（已排序去重）；**任何失败返回 `undefined`**，调用方据此回退旧路径。
   */
  async listLiveProjects(collection?: string): Promise<string[] | undefined> {
    const id = this.activeId()
    if (!id) return undefined
    const view = this.get(id)
    if (!view) return undefined
    const pat = this.store.getCredential(id)
    if (!pat) return undefined

    const col = (collection ?? view.collection ?? '').trim()
    if (col.length === 0) return undefined

    const base = view.url.replace(/\/+$/, '')
    const url = `${base}/${encodeURIComponent(col)}/_apis/projects?api-version=4.1&$top=1000`
    const auth = `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 20_000)
    try {
      const res = await fetch(url, {
        headers: { Authorization: auth, Accept: 'application/json' },
        signal: controller.signal,
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { value?: Array<{ name?: unknown }> }
      const rows = Array.isArray(body?.value) ? body.value : []
      const names = rows
        .map(r => (typeof r?.name === 'string' ? r.name : ''))
        .filter(n => n.length > 0)
      if (names.length === 0) return undefined
      // 码点序（`<` / `>` 比较）而非 `localeCompare`：本机 full-ICU 下 `localeCompare` 是
      // "数字 < 中文 < 拉丁"（如 `4.0产品台, 体检管理, ACIS, ASMC`），与需求池下拉的
      // 项目排序不一致。适配层 `getQueryOptions` 已统一用码点序，此处必须同口径，
      // 否则两个下拉里同名项目的位置会不同。
      return [...new Set(names)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
    } catch {
      // 网络/超时/解析失败一律回退，不把异常抛给面板采集（能力降级可见在 warnings 侧）。
      return undefined
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * 把活动档案的凭据**写入导出文件**（明文只进文件，不回响应体）。
   *
   * 文件为 POSIX `export` 格式，供凭据备份/迁移使用（正常运行**不需要** source 它 ——
   * 插件直连 REST，凭据从活动档案实时读取）。真实文件系统上尽力收紧为 0600。
   * @param profileId - 指定档案；缺省用活动档案。
   */
  writeEnvFile(profileId?: string): EnvFileResult {
    const id = profileId ?? this.activeId()
    if (!id) return { ok: false, reason: '未选择档案（请先保存并设为活动档案）' }
    const view = this.get(id)
    if (!view) return { ok: false, reason: `档案 ${id} 不存在` }
    const pat = this.store.getCredential(id)
    if (!pat) return { ok: false, reason: `档案 ${id} 无凭据（PAT 缺失或存储损坏）` }

    const k = TFS_ENV_KEYS
    const content = [
      '# 由 dsh-tfs-requirment 生成：TFS 连接凭据导出。',
      '# 含明文 PAT —— 请勿提交版本库、勿粘贴到聊天/工单。',
      '# 用途：凭据备份/迁移（本插件直连 REST，无需 source 本文件即可工作）。',
      `export ${k.url}='${view.url}'`,
      `export ${k.collection}='${view.collection}'`,
      `export ${k.pat}='${pat}'`,
      '',
    ].join('\n')

    try {
      this.fs.mkdirSync(dirname(this.envFilePath), { recursive: true })
      this.fs.writeFileSync(this.envFilePath, content, 'utf8')
    } catch (e) {
      return { ok: false, reason: `写环境文件失败：${(e as Error).message}` }
    }
    let hardened = false
    if (typeof this.fs.chmodSync === 'function') {
      try {
        this.fs.chmodSync(this.envFilePath, 0o600)
        hardened = true
      } catch {
        hardened = false
      }
    }
    return { ok: true, path: this.envFilePath, bytes: Buffer.byteLength(content, 'utf8'), hardened }
  }

  /**
   * 连接诊断（T028b / REST 化后重定义）。
   *
   * **不再报告"要不要接 MCP"**（那个问题已随 REST 化消失）：现在报告本插件的真实连接形态 ——
   * 直连 `_apis/*`，凭据来自活动档案，读写路径只有适配层一条。
   *
   * 返回类型仍叫 `McpInstanceInfo`（契约稳定性：客户端半与路由都在用它），
   * 但字段语义已改为"连接诊断"，`serverName` 恒为空串、`serverNameValid` 恒 true。
   */
  instance(): McpInstanceInfo {
    const active = this.activeId()
    const view = active ? this.get(active) : undefined
    return {
      serverName: '',
      serverNameValid: true,
      toolPrefix: '',
      runtimeAddSupported: true,
      runtimeAddReason:
        'TFS 连接可在运行期随时变更：插件直连 REST（/_apis/*），凭据由本服务按调用实时读取，' +
        '保存/切换档案后**下一次调用立即生效**，无需重载插件或重启 Host。',
      serverNameConstraint: '不适用（REST 直连，无 MCP 实例名概念）',
      duplicateRisk:
        active && view
          ? `当前活动档案：${view.name}（集合 ${view.collection}）`
          : '当前无活动档案 —— 请到本页保存并选中一个连接档案，否则 TFS 调用会失败。',
      credentialPath:
        `凭据存放于插件数据目录的 profiles.json（PAT 由 ProfileStore 隔离存储，` +
        `接口层只用 ProfileView，不含 pat 字段）；` +
        `调用时由 TfsAdapter 的 restConfigProvider 实时取出并拼 Basic 头，不进日志/审计/响应体。`,
    }
  }
}

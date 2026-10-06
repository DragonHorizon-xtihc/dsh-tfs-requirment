/**
 * PAT profile 隔离存储（Principle III / FR-002 / FR-031 / S-12）。
 *
 * - 多 profile（url + pat）以独立记录存储，内存/磁盘隔离；
 * - 落插件私有目录（gitignored），绝不进 `.env`、不进日志、不进 board.json；
 * - `list()` / `get()` **绝不回显 PAT**；仅 `getCredential()` 在即将注入 MCP 时返回明文；
 * - `delete()` 先覆写随机字节（彻底擦除 S-12）再移除记录。
 *
 * 本模块不依赖任何宿主 API，纯逻辑可单测（基建待 T011 adapter 接入时再调 `getCredential`）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/profile/store
 */

import { randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { realFs, type FsLike } from '../persistence/fs-like.js'

/** 单个 TFS profile（含明文 pat，仅写入/凭证读取时持有）。 */
export interface TfsProfile {
  /** 稳定 ID。 */
  id: string
  /** 展示名。 */
  name: string
  /** 服务地址（不含集合，集合单独配）。 */
  url: string
  /** 默认集合（如 WN_HIS）。 */
  collection: string
  /** 个人访问令牌（明文，仅内部持有，对外不回显）。 */
  pat: string
}

/** 对外安全的 profile 摘要（不含 pat）。 */
export type ProfileSummary = Omit<TfsProfile, 'pat'>

/** profile 存储错误。 */
export class ProfileStoreError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ProfileStoreError'
  }
}

/** 覆写文件为随机字节（彻底擦除，S-12）。 */
function shredFile(fs: FsLike, path: string, passes = 1): void {
  if (!fs.existsSync(path)) return
  const size = Buffer.byteLength(fs.readFileSync(path, 'utf8'), 'utf8')
  for (let i = 0; i < passes; i++) {
    // hex 为合法 utf8，避免编码歧义；随机性足以消灭原明文可恢复性。
    fs.writeFileSync(path, randomBytes(size).toString('hex'), 'utf8')
  }
}

/**
 * profile 存储（落 `profiles.json`）。
 */
export class ProfileStore {
  private readonly fs: FsLike
  private readonly filePath: string

  constructor(baseDir: string, fs: FsLike = realFs) {
    this.fs = fs
    this.filePath = join(baseDir, 'profiles.json')
  }

  private readAll(): TfsProfile[] {
    if (!this.fs.existsSync(this.filePath)) return []
    try {
      return JSON.parse(this.fs.readFileSync(this.filePath, 'utf8')) as TfsProfile[]
    } catch (e) {
      throw new ProfileStoreError(`profiles.json 解析失败：${(e as Error).message}`)
    }
  }

  private writeAll(records: TfsProfile[]): void {
    this.fs.mkdirSync(dirname(this.filePath), { recursive: true })
    this.fs.writeFileSync(this.filePath, JSON.stringify(records, null, 2), 'utf8')
  }

  /** 列出所有 profile 摘要（**不含 pat**，绝不回显）。 */
  list(): ProfileSummary[] {
    return this.readAll().map(({ pat: _pat, ...rest }) => rest)
  }

  /** 取单个 profile 摘要（**不含 pat**）；不存在返回 undefined。 */
  get(id: string): ProfileSummary | undefined {
    const found = this.readAll().find(p => p.id === id)
    if (!found) return undefined
    const { pat: _pat, ...rest } = found
    return rest
  }

  /**
   * 保存/更新 profile（含 pat）。
   * @param profile - 含明文 pat 的 profile。
   */
  save(profile: TfsProfile): void {
    if (!profile.id || !profile.url || !profile.pat) {
      throw new ProfileStoreError('profile 必须含 id / url / pat')
    }
    const all = this.readAll()
    const idx = all.findIndex(p => p.id === profile.id)
    if (idx >= 0) all[idx] = profile
    else all.push(profile)
    this.writeAll(all)
  }

  /**
   * 取凭证明文（仅用于注入 MCP，**不用于展示**）。
   * @param id - profile ID。
   * @returns pat 明文；不存在返回 undefined。
   */
  getCredential(id: string): string | undefined {
    return this.readAll().find(p => p.id === id)?.pat
  }

  /**
   * 删除 profile：先彻底擦除文件（随机字节覆写），再落盘移除记录（S-12）。
   * @param id - profile ID。
   * @returns 是否实际删除了某条。
   */
  delete(id: string): boolean {
    const all = this.readAll()
    const remaining = all.filter(p => p.id !== id)
    if (remaining.length === all.length) return false
    shredFile(this.fs, this.filePath, 3)
    this.writeAll(remaining)
    return true
  }
}

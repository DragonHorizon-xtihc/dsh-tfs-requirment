/**
 * 单文件 JSON 主数据存储（Principle VI：JSON 为权威）。
 *
 * - 单 `board.json`（collection 命名空间在 BoardState 内部，S-02，不按集合分文件）；
 * - 原子写（tmp + rename），避免半写；
 * - 解析失败**保留原文件、抛错**，不静默重建（FR-020 / T062）；
 * - 可选 version 乐观锁（落盘前后版本校验，崩溃保留 S-09）。
 *
 * @module dsh-tfs-requirment/persistence/json-store
 */

import { dirname, join } from 'node:path'
import { realFs, type FsLike } from './fs-like.js'

/** 解析失败错误（原文件保留）。 */
export class JsonStoreParseError extends Error {
  constructor(
    public readonly filePath: string,
    cause?: unknown,
  ) {
    super(`JSON 解析失败，原文件已保留：${filePath}`)
    this.name = 'JsonStoreParseError'
    if (cause !== undefined) this.cause = cause
  }
}

/** 版本冲突错误（乐观锁）。 */
export class JsonStoreVersionConflict extends Error {
  constructor(
    public readonly expected: number,
    public readonly actual: number,
  ) {
    super(`版本冲突：期望 ${expected} 实得 ${actual}`)
    this.name = 'JsonStoreVersionConflict'
  }
}

export interface JsonStoreOptions {
  /** 存储基目录（插件私有数据目录，FR-031）。 */
  baseDir: string
  /** 文件名，默认 `board.json`。 */
  fileName?: string
  /** 可注入文件系统（默认真实 `node:fs`，测试用内存实现）。 */
  fs?: FsLike
}

/**
 * 通用单文件 JSON 存储。
 * @typeParam T - 存储的数据类型（应为可序列化对象）。
 */
export class JsonStore<T> {
  private readonly filePath: string
  private readonly fs: FsLike

  constructor(opts: JsonStoreOptions) {
    this.filePath = join(opts.baseDir, opts.fileName ?? 'board.json')
    this.fs = opts.fs ?? realFs
  }

  /** 读取；不存在返回 null；解析失败抛 JsonStoreParseError（原文件保留）。 */
  read(): T | null {
    if (!this.fs.existsSync(this.filePath)) return null
    let raw: string
    try {
      raw = this.fs.readFileSync(this.filePath, 'utf8')
    } catch (e) {
      throw new JsonStoreParseError(this.filePath, e)
    }
    try {
      return JSON.parse(raw) as T
    } catch (e) {
      // 关键：保留原文件，不重建（FR-020）。
      throw new JsonStoreParseError(this.filePath, e)
    }
  }

  /**
   * 原子写入。先写 tmp 再 rename。
   * @param data - 数据。
   */
  write(data: T): void {
    this.fs.mkdirSync(dirname(this.filePath), { recursive: true })
    const tmp = `${this.filePath}.tmp`
    this.fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8')
    this.fs.renameSync(tmp, this.filePath)
  }

  /**
   * 带版本乐观锁的写入：期望版本须匹配数据中的 `version` 字段。
   * @param data - 含 `version` 字段的数据。
   * @param expectedVersion - 期望版本。
   */
  writeIfVersion(data: T & { version: number }, expectedVersion: number): void {
    if (data.version !== expectedVersion) {
      throw new JsonStoreVersionConflict(expectedVersion, data.version)
    }
    this.write(data)
  }

  /** 文件路径（测试/诊断用）。 */
  get path(): string {
    return this.filePath
  }
}

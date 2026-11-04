/**
 * 内存文件系统实现（仅供测试）。
 *
 * 用途：让持久化模块（JsonStore / EventLog）在测试中完全不触碰真实磁盘，
 * 规避沙盒/杀软对临时目录的实时扫描导致 `rmSync` 等清理动作被锁超时。
 *
 * 行为尽量贴近 `node:fs` 的最小子集：
 * - 路径以字符串键存储，支持 `mkdirSync({recursive})` 递归建父目录；
 * - `renameSync` 覆盖式迁移；`readFileSync` 缺失抛 `ENOENT`；
 * - `appendFileSync` 行式追加。
 *
 * @module dsh-tfs-requirment/tests/helpers/memfs
 */

import { dirname } from 'node:path'
import type { FsLike } from '../../src/persistence/fs-like.js'

export interface MemFs extends FsLike {
  /** 返回当前全部文件内容（诊断用）。 */
  dump(): Record<string, string>
}

class MemFsError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MemFsError'
  }
}

export function createMemFs(): MemFs {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  const norm = (p: string): string => p.replace(/\\/g, '/')
  const ensureDir = (p: string): void => {
    const n = norm(p)
    dirs.add(n)
    let cur = n
    for (;;) {
      const parent = norm(dirname(cur))
      if (parent === cur || parent === '' || parent === '/') {
        if (parent === '/') dirs.add('/')
        break
      }
      dirs.add(parent)
      cur = parent
    }
  }

  return {
    existsSync(p: string): boolean {
      const n = norm(p)
      return files.has(n) || dirs.has(n)
    },
    mkdirSync(p: string): void {
      ensureDir(p)
    },
    readFileSync(p: string): string {
      const n = norm(p)
      const content = files.get(n)
      if (content === undefined) {
        const e = new MemFsError(`ENOENT: no such file: ${p}`)
        ;(e as { code?: string }).code = 'ENOENT'
        throw e
      }
      return content
    },
    writeFileSync(p: string, data: string): void {
      ensureDir(p)
      files.set(norm(p), String(data))
    },
    renameSync(oldPath: string, newPath: string): void {
      const from = norm(oldPath)
      const to = norm(newPath)
      const content = files.get(from)
      if (content === undefined) {
        const e = new MemFsError(`ENOENT: no such file: ${oldPath}`)
        ;(e as { code?: string }).code = 'ENOENT'
        throw e
      }
      files.set(to, content)
      files.delete(from)
    },
    appendFileSync(p: string, data: string): void {
      ensureDir(p)
      const n = norm(p)
      files.set(n, (files.get(n) ?? '') + String(data))
    },
    readdirSync(p: string): string[] {
      const dir = norm(p).replace(/\/$/, '')
      const out = new Set<string>()
      for (const f of files.keys()) {
        const i = f.lastIndexOf('/')
        if (i > 0 && f.slice(0, i) === dir) out.add(f.slice(i + 1))
      }
      for (const d of dirs) {
        const i = d.lastIndexOf('/')
        if (i > 0 && d.slice(0, i) === dir) out.add(d.slice(i + 1))
      }
      return [...out].sort()
    },
    dump(): Record<string, string> {
      return Object.fromEntries(files.entries())
    },
  }
}

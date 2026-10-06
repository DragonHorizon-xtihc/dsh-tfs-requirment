import { beforeEach, describe, expect, it } from 'vitest'
import {
  JsonStore,
  JsonStoreParseError,
  JsonStoreVersionConflict,
} from '../src/persistence/json-store.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

// 每个用例独立内存 fs，避免跨用例状态污染（共享实例会残留上一用例的写入）。
let memFs: MemFs
beforeEach(() => {
  memFs = createMemFs()
})

describe('JsonStore', () => {
  it('不存在时 read 返回 null', () => {
    const store = new JsonStore<{ version: number }>({ baseDir: '/mem/json', fs: memFs })
    expect(store.read()).toBeNull()
  })

  it('原子写入后可读回', () => {
    const store = new JsonStore<{ version: number }>({ baseDir: '/mem/json', fs: memFs })
    store.write({ version: 1 })
    expect(store.read()).toEqual({ version: 1 })
  })

  it('解析失败保留原文件并抛 JsonStoreParseError（FR-020）', () => {
    const store = new JsonStore<{ version: number }>({ baseDir: '/mem/json', fs: memFs })
    store.write({ version: 1 })
    // 用同一内存 fs 破坏文件内容
    memFs.writeFileSync(store.path, '{ this is not valid json', 'utf8')
    expect(() => store.read()).toThrow(JsonStoreParseError)
    // 原文件仍在（保留，未静默重建）
    expect(memFs.existsSync(store.path)).toBe(true)
  })

  it('版本乐观锁：期望不匹配抛 JsonStoreVersionConflict', () => {
    const store = new JsonStore<{ version: number }>({ baseDir: '/mem/json', fs: memFs })
    store.write({ version: 1 })
    expect(() => store.writeIfVersion({ version: 2 }, 1)).toThrow(JsonStoreVersionConflict)
    // 正确版本写入成功
    store.writeIfVersion({ version: 2 }, 2)
    expect(store.read()).toEqual({ version: 2 })
  })
})

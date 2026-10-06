import { beforeEach, describe, expect, it } from 'vitest'
import { ProfileStore } from '../src/profile/store.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

let memFs: MemFs
beforeEach(() => {
  memFs = createMemFs()
})

describe('ProfileStore（Principle III / S-12）', () => {
  it('save 后 list/get 绝不回显 pat', () => {
    const store = new ProfileStore('/mem/profile', memFs)
    store.save({ id: 'p1', name: '默认', url: 'http://tfs', collection: 'WN_HIS', pat: 'SECRET-PAT' })
    const listed = store.list()
    expect(listed).toHaveLength(1)
    expect((listed[0] as Record<string, unknown>).pat).toBeUndefined()
    const got = store.get('p1')
    expect(got?.name).toBe('默认')
    expect((got as Record<string, unknown>).pat).toBeUndefined()
  })

  it('getCredential 仅在此取回明文（用于注入 MCP）', () => {
    const store = new ProfileStore('/mem/profile', memFs)
    store.save({ id: 'p1', name: '默认', url: 'http://tfs', collection: 'WN_HIS', pat: 'SECRET-PAT' })
    expect(store.getCredential('p1')).toBe('SECRET-PAT')
    expect(store.getCredential('nope')).toBeUndefined()
  })

  it('多 profile 隔离（各自独立记录）', () => {
    const store = new ProfileStore('/mem/profile', memFs)
    store.save({ id: 'a', name: 'A', url: 'http://a', collection: 'WN_HIS', pat: 'PAT-A' })
    store.save({ id: 'b', name: 'B', url: 'http://b', collection: 'X', pat: 'PAT-B' })
    expect(store.list()).toHaveLength(2)
    expect(store.getCredential('a')).toBe('PAT-A')
    expect(store.getCredential('b')).toBe('PAT-B')
  })

  it('delete 彻底擦除：文件中不再含被删 pat', () => {
    const store = new ProfileStore('/mem/profile', memFs)
    store.save({ id: 'a', name: 'A', url: 'http://a', collection: 'WN_HIS', pat: 'PAT-A' })
    store.save({ id: 'b', name: 'B', url: 'http://b', collection: 'X', pat: 'PAT-B' })
    expect(store.delete('a')).toBe(true)
    // 仅剩 b
    expect(store.list().map(p => p.id)).toEqual(['b'])
    expect(store.getCredential('a')).toBeUndefined()
    // 落盘文件内容不再包含被删明文
    const allRaw = memFs.dump()
    const joined = JSON.stringify(allRaw)
    expect(joined).not.toContain('PAT-A')
    expect(joined).toContain('PAT-B')
  })

  it('save 校验必填字段', () => {
    const store = new ProfileStore('/mem/profile', memFs)
    expect(() => store.save({ id: '', name: 'x', url: 'u', collection: 'c', pat: 'p' })).toThrow()
    expect(() => store.save({ id: 'x', name: 'x', url: 'u', collection: 'c', pat: '' })).toThrow()
  })
})

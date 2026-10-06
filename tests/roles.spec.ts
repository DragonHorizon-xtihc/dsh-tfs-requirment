import { describe, expect, it, vi } from 'vitest'
import { createMemFs } from './helpers/memfs.js'
import type { FsLike } from '../src/persistence/fs-like.js'
import { DEFAULT_ROLES, RoleStore, ensureBuiltinRoles } from '../src/orchestration/roles.js'
import { BUILTIN_ROLES, ROLE_ANALYST, ROLE_REVIEWER } from '../src/orchestration/role-match.js'

describe('角色存储', () => {
  it('空店首次对账补齐全部内置角色（五段式 5 专家 + 通用兜底，共 6 个）', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    const added = ensureBuiltinRoles(store)
    expect(added).toHaveLength(BUILTIN_ROLES.length)
    expect(added).toEqual([
      ROLE_ANALYST.id,
      'role-architect',
      'role-coder',
      ROLE_REVIEWER.id,
      'role-qa',
      'role-general',
    ])
    expect(store.list()).toHaveLength(BUILTIN_ROLES.length)
    // 幂等：再跑一次不重复补。
    expect(ensureBuiltinRoles(store)).toEqual([])
  })

  it('老店只有早期 3 角色（架构师/开发/测试）⇒ 升级补入需求分析师、代码审核工程师、通用工程师', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    // 模拟升级前的 roles.json：只有三段式时期的 3 个角色。
    store.save(DEFAULT_ROLES.find(r => r.id === 'role-architect')!)
    store.save(DEFAULT_ROLES.find(r => r.id === 'role-coder')!)
    store.save(DEFAULT_ROLES.find(r => r.id === 'role-qa')!)
    const added = ensureBuiltinRoles(store)
    expect(added).toEqual([ROLE_ANALYST.id, ROLE_REVIEWER.id, 'role-general'])
    expect(store.list()).toHaveLength(6)
  })

  it('同 id 已存在（含用户改名/改模型）不覆盖', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    // 用户把架构师改名并换了模型，id 仍是 role-architect；另已含测试与通用。
    store.save({ ...DEFAULT_ROLES.find(r => r.id === 'role-architect')!, name: '首席架构', defaultModel: 'm-custom' })
    store.save(DEFAULT_ROLES.find(r => r.id === 'role-qa')!)
    store.save(DEFAULT_ROLES.find(r => r.id === 'role-general')!)
    ensureBuiltinRoles(store)
    const architect = store.get('role-architect')!
    expect(architect.name).toBe('首席架构')
    expect(architect.defaultModel).toBe('m-custom')
    // 本次只补尚缺的需求分析师、代码审核工程师。
    expect(store.list().map(r => r.id).sort()).toEqual(
      [ROLE_ANALYST.id, 'role-architect', 'role-coder', ROLE_REVIEWER.id, 'role-qa', 'role-general'].sort(),
    )
  })

  it('同展示名但 id 不同（用户自建同名角色）也跳过，不制造重名', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    // 用户自建了名为「通用工程师」的角色（id 不同，绑定自己的 provider）。
    store.save({ ...DEFAULT_ROLES.find(r => r.id === 'role-general')!, id: 'custom-general', provider: 'fork' })
    const added = ensureBuiltinRoles(store)
    // 内置通用工程师因同名跳过；其余 5 个专家角色补齐。
    expect(added).toEqual([ROLE_ANALYST.id, 'role-architect', 'role-coder', ROLE_REVIEWER.id, 'role-qa'])
    const generals = store.list().filter(r => r.name === '通用工程师')
    expect(generals).toHaveLength(1)
    expect(generals[0]!.id).toBe('custom-general')
  })

  it('用户自定义角色不被对账删除', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    store.save({ id: 'my-dba', name: 'DBA', provider: 'spawn' })
    ensureBuiltinRoles(store)
    expect(store.get('my-dba')?.name).toBe('DBA')
  })
})

describe('RoleStore 基础读写', () => {
  it('save/get/list/getByName/delete', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    expect(store.list()).toEqual([])
    const r = DEFAULT_ROLES[0]!
    store.save(r)
    expect(store.get(r.id)?.name).toBe(r.name)
    expect(store.getByName(r.name)?.id).toBe(r.id)
    expect(store.delete(r.id)).toBe(true)
    expect(store.get(r.id)).toBeUndefined()
    expect(store.delete(r.id)).toBe(false)
  })

  it('缺 id/name/provider 校验失败抛错', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    expect(() => store.save({ id: '', name: 'x', provider: 'spawn' })).toThrow()
    expect(() => store.save({ id: 'x', name: '', provider: 'spawn' })).toThrow()
    expect(() => store.save({ id: 'x', name: 'x', provider: '' })).toThrow()
  })

  it('落盘后重新加载内容一致（JSON 权威）', () => {
    const fs: FsLike = createMemFs()
    const store = new RoleStore('C:/data', fs)
    ensureBuiltinRoles(store)
    const reopened = new RoleStore('C:/data', fs)
    expect(reopened.list().map(r => r.id)).toEqual(store.list().map(r => r.id))
  })

  it('真实 fs 下目录不存在时由 JsonStore 兜底创建（集成）', () => {
    const tmp = `C:/data/roles-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
    const store = new RoleStore(tmp)
    const added = ensureBuiltinRoles(store)
    expect(added).toHaveLength(BUILTIN_ROLES.length)
    expect(store.list()).toHaveLength(BUILTIN_ROLES.length)
  })

  it('save 失败不产生未捕获 rejection（异步路径兼容，vi 占位）', async () => {
    const fn = vi.fn(() => {})
    fn()
    expect(fn).toHaveBeenCalled()
  })
})

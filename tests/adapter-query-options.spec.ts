import { beforeEach, describe, expect, it } from 'vitest'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'
import { makeFakeRest, type FakeRest } from './helpers/fake-rest.js'

/**
 * `getQueryOptions` 单测（问题 3/4/5 修复的回归网）—— **REST 元数据版**。
 *
 * 本文件锁定三条 2026-09-19 实测坐实的宿主事实，防止未来被"看起来更简洁"的重构改回去：
 *
 *  1. **活项目清单**：REST 化后 `tfs_get_projects` 已映射为 `GET /_apis/projects` 活清单
 *     （62 项真实数据）。`liveProjects` 旁路保留为测试/覆盖点，返回非空数组时**必须**覆盖。
 *  2. **元数据端点替代采样**（问题 4/5 根治）：类型/状态来自
 *     `GET /{project}/_apis/wit/workitemtypes?api-version=4.1`（体检管理实测 19 类型）与
 *     `GET /{project}/_apis/wit/workitemtypes/{type}/states?api-version=4.1-preview`（实测 6 状态）。
 *     **不再做 WIQL 窗口采样** —— 旧采样有三宗罪：~200 条硬上限、62 项目只采 8 个、
 *     伪错消息漏进 warnings（用户看到"项目「X」采样失败"误以为系统坏了）。
 *  3. **降级可见**：任何一环失败必须推 warning，不允许静默返回空下拉。
 */

let memFs: MemFs
let rest: FakeRest

beforeEach(() => {
  memFs = createMemFs()
})

interface AdapterExtra {
  liveProjects?: (collection: string) => Promise<string[] | undefined>
}

function makeAdapter(routes: Record<string, unknown> = {}, extra: AdapterExtra = {}): TfsAdapter {
  rest = makeFakeRest({
    '_apis/projects': { value: [{ id: 'p1', name: 'EAHis' }] },
    '_apis/wit/wiql': { workItems: [] },
    '_apis/wit/workitems?ids=': { value: [] },
    '_apis/connectionData': {
      authorizedUser: { providerDisplayName: 'zhangbo3(张波)', properties: { Account: { $value: 'zhangbo3' } } },
    },
    ...routes,
  })
  const guard = new WriteGuard(new AuditLog('/mem/audit', memFs))
  return new TfsAdapter({
    rest: rest.config,
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 'winning',
    ...(extra.liveProjects ? { liveProjects: extra.liveProjects } : {}),
  })
}

const TYPES = { value: [{ name: '需求' }, { name: '任务' }, { name: 'Bug' }] }
const STATES = { value: [{ name: '活动' }, { name: '已建议' }, { name: '已关闭' }] }

describe('问题 3：活项目清单（REST 活清单为主，liveProjects 为覆盖点）', () => {
  it('liveProjects 返回非空时覆盖 REST 活清单', async () => {
    const a = makeAdapter(
      // 类型采集现在遍历**全部**项目（不再只取前 3 个），故所有项目都要有路由；
      // 路由按 URL 子串匹配，一条 `_apis/wit/workitemtypes` 即可覆盖所有项目。
      {
        '_apis/wit/workitemtypes': TYPES,
        '_apis/wit/workitemtypes/': STATES,
      },
      { liveProjects: async () => ['ACIS', '体检管理', 'ASMC', 'EAHis'] },
    )
    const r = await a.getQueryOptions('WN_HIS')
    // 排序用**码点序**（`<`/`>`）而非 `localeCompare`：本机 full-ICU 下
    // localeCompare 是「数字 < 中文 < 拉丁」，会把中文插在拉丁字母之间，
    // 让「4.0产品台 / ACIS / 体检管理 / ASMC」这种清单顺序难以预期。
    // 码点序 = 数字 < 拉丁 < 中文，分组清晰。
    // 实测（node -e 量出真序，勿凭直觉）：
    //   码点序：['4.0产品台','ACIS','ASMC','CIS','EAHis','WN_HIS','体检管理']
    expect(r.projects.map(p => p.value)).toEqual(['ACIS', 'ASMC', 'EAHis', '体检管理'])
    // 项目清单**不得**出现降级提示（用精确子串，避免误伤元数据侧措辞）。
    expect(r.reason ?? '').not.toContain('项目清单采集失败')
    expect(r.reason ?? '').not.toContain('活项目清单旁路不可用')
    expect(r.reason ?? '').not.toContain('降级')
  })

  it('liveProjects 缺席时走 REST 活清单（不再有硬编码表）', async () => {
    const a = makeAdapter({ '_apis/projects': { value: [{ id: '1', name: '体检管理' }, { id: '2', name: 'ACIS' }] } })
    const r = await a.getQueryOptions('WN_HIS')
    // 码点序：拉丁 < 中文 ⇒ ACIS 在前。
    expect(r.projects.map(p => p.value)).toEqual(['ACIS', '体检管理'])
    expect(r.reason ?? '').not.toContain('降级')
  })

  it('liveProjects 抛错时不冒泡，走 REST 活清单并记 warning', async () => {
    const a = makeAdapter(
      { '_apis/projects': { value: [{ id: '1', name: 'EAHis' }] } },
      { liveProjects: async () => { throw new Error('TFS 401 未授权') } },
    )
    const r = await a.getQueryOptions('WN_HIS')
    expect(r.projects.map(p => p.value)).toEqual(['EAHis'])
    expect(r.reason ?? '').toContain('活项目清单旁路不可用')
    expect(r.reason ?? '').toContain('TFS 401 未授权')
  })

  it('REST 活清单也失败时项目为空 + 可读 warning（不静默）', async () => {
    const a = makeAdapter({ '_apis/projects': { status: 401, body: 'denied' } })
    const r = await a.getQueryOptions('WN_HIS')
    expect(r.projects).toEqual([])
    expect(r.reason ?? '').toContain('项目清单采集失败')
  })
})

describe('问题 4/5：类型与状态来自元数据端点（不再采样）', () => {
  it('类型来自 workitemtypes，状态来自 states（4.1-preview）', async () => {
    const a = makeAdapter({
      '_apis/wit/workitemtypes': TYPES,
      '_apis/wit/workitemtypes/': STATES,
    })
    const r = await a.getQueryOptions('WN_HIS')
    // 排序实测（码点序：拉丁 < 中文按 Unicode）——勿按直觉写断言（纪律：先量真序）。
    expect(r.types.map(t => t.value)).toEqual(['Bug', '任务', '需求'])
    expect(r.states.map(s => s.value)).toEqual(['已关闭', '已建议', '活动'])
    // 元数据路径不应触发 WIQL（旧采样已删除）。
    expect(rest.calls.filter(c => c.url.includes('/_apis/wit/wiql'))).toHaveLength(0)
  })

  it('states 请求用 api-version=4.1-preview（4.1 会 400，实测）', async () => {
    const a = makeAdapter({
      '_apis/wit/workitemtypes': TYPES,
      '_apis/wit/workitemtypes/': STATES,
    })
    await a.getQueryOptions('WN_HIS')
    const stateCalls = rest.calls.filter(c => c.url.includes('/states'))
    expect(stateCalls.length).toBeGreaterThan(0)
    for (const c of stateCalls) {
      expect(c.url).toContain('api-version=4.1-preview')
    }
  })

  it('types 请求用 api-version=4.1 且项目名 URL 编码', async () => {
    const a = makeAdapter({
      '_apis/wit/workitemtypes': TYPES,
      '_apis/wit/workitemtypes/': STATES,
    })
    await a.getQueryOptions('WN_HIS')
    const typeCall = rest.calls.find(c => c.url.includes('/_apis/wit/workitemtypes') && !c.url.includes('/states'))!
    expect(typeCall.url).toContain(`/${encodeURIComponent('EAHis')}/_apis/wit/workitemtypes`)
    expect(typeCall.url).toContain('api-version=4.1')
  })

  it('单类型 states 失败不阻断其它类型（逐类型独立降级）', async () => {
    const a = makeAdapter({
      '_apis/wit/workitemtypes': { value: [{ name: '需求' }, { name: 'Bug' }] },
      '_apis/wit/workitemtypes/%E9%9C%80%E6%B1%82/states': {
        status: 400, body: { message: 'VssInvalidPreviewVersionException' },
      },
      '_apis/wit/workitemtypes/Bug/states': { value: [{ name: '活动' }] },
    })
    const r = await a.getQueryOptions('WN_HIS')
    // 需求的 states 失败，但类型的枚举与 Bug 的 states 照常返回。
    expect(r.types.map(t => t.value)).toEqual(['Bug', '需求'])
    expect(r.states.map(s => s.value)).toEqual(['活动'])
  })

  it('元数据全部失败：types 为空 + 可读 warning（不静默返回空数组）', async () => {
    const a = makeAdapter({ '_apis/wit/workitemtypes': { status: 404, body: 'Sorry, Page Not Found' } })
    const r = await a.getQueryOptions('WN_HIS')
    expect(r.types).toEqual([])
    expect(r.reason ?? '').toContain('工作项类型为空')
  })

  it('类型全量遍历所有项目（问题 4：不再截断到前 3 个项目）', async () => {
    const projects = Array.from({ length: 62 }, (_, i) => ({ value: `P${String(i).padStart(2, '0')}`, label: `P${i}` }))
    const a = makeAdapter(
      { '_apis/wit/workitemtypes': TYPES, '_apis/wit/workitemtypes/': STATES },
    )
    rest.setRoute('_apis/projects', { value: projects.map(p => ({ id: p.value, name: p.value })) })
    const r = await a.getQueryOptions('WN_HIS')
    expect(r.projects).toHaveLength(62)

    const typeCalls = rest.calls.filter(c => c.url.includes('/_apis/wit/workitemtypes') && !c.url.includes('/states'))
    // ⚠️ 这里锁定的是**修复后的行为**：项目维度**不截断**。
    //
    // 修复前的 `MAX_TYPES_PROJECTS = 3` 正是问题 4 的直接成因 ——
    // 若前 3 个项目恰好都是无类型的项目（TFS 里很常见：仅 TFVC 仓库、无 WIT 定义的团队项目），
    // `listWorkItemTypes` 全部 404 ⇒ `typeSet` 为空 ⇒ **工作类型下拉一个选项都没有**。
    // 而 `System.WorkItemType` 的权威全集在集合内是共享的，任一有效项目即可枚举出来。
    expect(typeCalls).toHaveLength(62)
    // 类型去重后仍只有 3 个（各项目返回同一份 TYPES）。
    expect(r.types.map(t => t.value)).toEqual(['Bug', '任务', '需求'])
  })

  it('状态探测按类型维度限流（每项目最多 12 个类型），不让请求数爆炸', async () => {
    // 造 20 个类型，验证 states 请求被限到 12。
    const many = { value: Array.from({ length: 20 }, (_, i) => ({ name: `T${String(i).padStart(2, '0')}` })) }
    const a = makeAdapter({
      '_apis/wit/workitemtypes': many,
      '_apis/wit/workitemtypes/': STATES,
    })
    await a.getQueryOptions('WN_HIS')
    const stateCalls = rest.calls.filter(c => c.url.includes('/states'))
    expect(stateCalls).toHaveLength(12)
  })
})

describe('默认指派人（whoami → connectionData）', () => {
  it('从 connectionData 取账号作为默认指派人', async () => {
    const a = makeAdapter({ '_apis/wit/workitemtypes': TYPES, '_apis/wit/workitemtypes/': STATES })
    const r = await a.getQueryOptions('WN_HIS')
    expect(r.defaultAssignee).toBe('zhangbo3')
    expect(r.assignees.map(x => x.value)).toContain('zhangbo3')
  })

  it('whoami 失败不影响其它选项（独立降级）', async () => {
    const a = makeAdapter({
      '_apis/connectionData': { status: 401, body: 'denied' },
      '_apis/wit/workitemtypes': TYPES,
      '_apis/wit/workitemtypes/': STATES,
    })
    const r = await a.getQueryOptions('WN_HIS')
    expect(r.defaultAssignee).toBeUndefined()
    // 排序实测（码点序：拉丁 < 中文按 Unicode）——勿按直觉写断言（纪律：先量真序）。
    expect(r.types.map(t => t.value)).toEqual(['Bug', '任务', '需求'])
    expect(r.reason ?? '').toContain('whoami')
  })
})

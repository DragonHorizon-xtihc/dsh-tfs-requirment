import { afterEach, describe, expect, it, vi } from 'vitest'
import { ProfileService } from '../src/host/profile-service.js'
import { ProfileStore } from '../src/profile/store.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

/**
 * `ProfileService.listLiveProjects` 单测（问题 3 修复的回归网）。
 *
 * 这个方法存在的唯一理由，是 `tfs_get_projects` 是 tfs-mcp 的**硬编码常量表**
 * （WN_HIS 只列了 7 项，且 `Framework` 是错名；真实 62 项），而 tfs-mcp 全库
 * **没有任何 `_apis/projects` 调用**。活清单只能由同时持有 url + PAT 的本服务直连 REST 取。
 *
 * 契约要点（决定了下面每条断言）：
 *  - 成功 → 排序去重后的项目名数组；
 *  - **任何失败 → `undefined`**（而不是抛错或空数组）：调用方据此回退旧路径，
 *    "最差也是原来的结果"，不会让项目下拉变空。
 */

const PAT = 'p@t-明文-9f3a'
const BASE = 'http://tfs2018-web.winning.com.cn:8080/tfs'

interface Subject {
  fs: MemFs
  store: ProfileStore
  svc: ProfileService
}

function setup(): Subject {
  const baseDir = '/data'
  const fs = createMemFs()
  const store = new ProfileStore(baseDir, fs)
  const svc = new ProfileService({ baseDir, store, fs, })
  return { fs, store, svc }
}

/** 建好档案并激活，返回 svc（多数用例的前置）。 */
function setupActive(collection = 'WN_HIS'): Subject {
  const s = setup()
  const created = s.svc.save({ name: '生产', url: BASE, collection, pat: PAT })
  s.svc.activate(created.profile!.id)
  return s
}

/** 记录 fetch 调用，返回可控响应。 */
function stubFetch(responder: (url: string, init: RequestInit) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = []
  const spy = vi.fn(async (input: string | URL, init?: RequestInit) => {
    const url = String(input)
    calls.push({ url, init: init ?? {} })
    return responder(url, init ?? {})
  })
  vi.stubGlobal('fetch', spy)
  return { spy, calls }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('listLiveProjects：请求构造', () => {
  it('拼出 <url>/<collection>/_apis/projects 并带 Basic :PAT 头', async () => {
    const { svc } = setupActive('WN_HIS')
    const { calls } = stubFetch(() => jsonResponse({ value: [{ name: 'EAHis' }] }))

    const names = await svc.listLiveProjects()
    expect(names).toEqual(['EAHis'])

    expect(calls).toHaveLength(1)
    expect(calls[0]!.url).toBe(`${BASE}/WN_HIS/_apis/projects?api-version=4.1&$top=1000`)
    const headers = calls[0]!.init.headers as Record<string, string>
    // 实测可用的鉴权形态：Basic base64(":PAT")（用户名留空）。
    expect(headers.Authorization).toBe(`Basic ${Buffer.from(`:${PAT}`, 'utf8').toString('base64')}`)
    // 证据：PAT 只能进 Authorization 头，不能出现在 URL 里（URL 会进日志/进程列表）。
    expect(calls[0]!.url).not.toContain(PAT)
  })

  it('url 末尾多余斜杠被规整，不产生双斜杠', async () => {
    const s = setup()
    const created = s.svc.save({ name: '生产', url: `${BASE}/`, collection: 'WN_HIS', pat: PAT })
    s.svc.activate(created.profile!.id)
    const { calls } = stubFetch(() => jsonResponse({ value: [{ name: 'EAHis' }] }))

    await s.svc.listLiveProjects()
    // `/tfs//WN_HIS/...` 会被 TFS 判为无效路径。
    expect(calls[0]!.url).toBe(`${BASE}/WN_HIS/_apis/projects?api-version=4.1&$top=1000`)
  })

  it('显式 collection 参数优先于档案内的集合', async () => {
    const { svc } = setupActive('WN_HIS')
    const { calls } = stubFetch(() => jsonResponse({ value: [{ name: 'PEIS' }] }))

    await svc.listLiveProjects('WN_TJ')
    expect(calls[0]!.url).toContain('/WN_TJ/_apis/projects')
  })

  it('集合名需 URL 编码（防注入到路径）', async () => {
    const { svc } = setupActive('WN_HIS')
    const { calls } = stubFetch(() => jsonResponse({ value: [{ name: 'EAHis' }] }))

    await svc.listLiveProjects('WN HIS/x')
    expect(calls[0]!.url).toContain('/WN%20HIS%2Fx/_apis/projects')
  })
})

describe('listLiveProjects：结果处理', () => {
  it('去重并按码点序排序（与适配层 getQueryOptions 同口径）', async () => {
    const { svc } = setupActive()
    stubFetch(() => jsonResponse({
      value: [{ name: 'EAHis' }, { name: '体检管理' }, { name: 'EAHis' }, { name: 'ACIS' }, { name: '4.0产品后台' }],
    }))

    const names = await svc.listLiveProjects()
    // 码点序：数字 < 拉丁 < 中文（`4` = 0x34 < `A` = 0x41 < `E` = 0x45 < `体` = 0x4F53）。
    // 刻意不用 localeCompare —— 本机 full-ICU 下它给出 `4.0产品后台, 体检管理, ACIS, EAHis`
    // （数字 < 中文 < 拉丁），与需求池下拉的项目排序不一致。
    expect(names).toEqual(['4.0产品后台', 'ACIS', 'EAHis', '体检管理'])
  })

  it('丢弃缺 name / name 非字符串的条目', async () => {
    const { svc } = setupActive()
    stubFetch(() => jsonResponse({
      value: [{ name: 'EAHis' }, { id: 'x' }, { name: 42 }, { name: '' }, null],
    }))

    expect(await svc.listLiveProjects()).toEqual(['EAHis'])
  })

  it('value 不是数组 → undefined（形状异常按失败处理）', async () => {
    const { svc } = setupActive()
    stubFetch(() => jsonResponse({ value: 'oops' }))
    expect(await svc.listLiveProjects()).toBeUndefined()
  })

  it('value 为空数组 → undefined（视作旁路不可用，触发回退）', async () => {
    const { svc } = setupActive()
    stubFetch(() => jsonResponse({ value: [] }))
    expect(await svc.listLiveProjects()).toBeUndefined()
  })
})

describe('listLiveProjects：失败一律返回 undefined（不抛错、不回空数组）', () => {
  it('HTTP 非 2xx（401 未授权）→ undefined', async () => {
    const { svc } = setupActive()
    stubFetch(() => new Response('unauthorized', { status: 401 }))
    expect(await svc.listLiveProjects()).toBeUndefined()
  })

  it('HTTP 404（集合名不存在）→ undefined', async () => {
    const { svc } = setupActive()
    stubFetch(() => new Response('not found', { status: 404 }))
    expect(await svc.listLiveProjects()).toBeUndefined()
  })

  it('网络异常 → undefined（不冒泡给面板采集）', async () => {
    const { svc } = setupActive()
    stubFetch(() => { throw new Error('ECONNREFUSED') })
    expect(await svc.listLiveProjects()).toBeUndefined()
  })

  it('响应体不是合法 JSON → undefined', async () => {
    const { svc } = setupActive()
    stubFetch(() => new Response('<html>登录页</html>', { status: 200 }))
    expect(await svc.listLiveProjects()).toBeUndefined()
  })

  it('无活动档案 → undefined 且完全不发请求', async () => {
    const { svc } = setup()
    const { calls } = stubFetch(() => jsonResponse({ value: [{ name: 'EAHis' }] }))
    expect(await svc.listLiveProjects()).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('档案存在但凭据缺失 → undefined 且不发请求', async () => {
    const s = setupActive()
    const id = s.svc.activeId()!
    s.fs.writeFileSync('/data/profiles.json', JSON.stringify([{ id, name: 'a', url: BASE, collection: 'WN_HIS', pat: '' }]), 'utf8')
    const { calls } = stubFetch(() => jsonResponse({ value: [{ name: 'EAHis' }] }))

    expect(await s.svc.listLiveProjects()).toBeUndefined()
    expect(calls).toHaveLength(0)
  })

  it('集合名为空 → undefined（拼不出有效 URL，提前返回）', async () => {
    const s = setup()
    const created = s.svc.save({ name: '生产', url: BASE, collection: 'WN_HIS', pat: PAT })
    s.svc.activate(created.profile!.id)
    // 手工把集合改空，模拟档案损坏。
    s.fs.writeFileSync('/data/profiles.json', JSON.stringify([{ id: created.profile!.id, name: '生产', url: BASE, collection: '   ', pat: PAT }]), 'utf8')
    const { calls } = stubFetch(() => jsonResponse({ value: [{ name: 'EAHis' }] }))

    expect(await s.svc.listLiveProjects()).toBeUndefined()
    expect(calls).toHaveLength(0)
  })
})

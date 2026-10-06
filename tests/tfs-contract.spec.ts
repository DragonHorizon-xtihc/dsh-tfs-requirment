import { describe, expect, it } from 'vitest'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'
import { makeFakeRest, type FakeRest } from './helpers/fake-rest.js'

/**
 * T027：TFS 只读出口契约测试（**REST 版**，2026-09-19 REST 化改造）。
 *
 * 事实来源变更记录：
 *   - 旧版（2026-09-17）锁定 tfs-mcp 工具 JSON Schema（`mcp__tfs-mcp__*`，additionalProperties:false）；
 *   - REST 化后（2026-09-19）锁定 **REST 端点与请求形状**（全部经真实 TFS 探针实测，
 *     证据：`docs/plans/2026-09-19-p0-probe-and-three-questions.md`）：
 *     - `GET /_apis/projects?$top=1000&api-version=4.1`（活清单，问题 3 根治）；
 *     - `GET /_apis/connectionData`（**不带 api-version**，否则 400）；
 *     - `POST /_apis/wit/wiql?api-version=4.1` + `GET /_apis/wit/workitems?ids=...`（两段式）；
 *
 * 本测试用 **fetch 桩**（`helpers/fake-rest.ts`，不联网）把 REST 出口锁死在实测形状上。
 */

let rest: FakeRest

function makeAdapter(): TfsAdapter {
  rest = makeFakeRest({
    '_apis/projects': { value: [{ id: 'p1', name: 'EAHis', state: 'wellFormed' }] },
    '_apis/connectionData': {
      authenticatedUser: { id: 'u1', providerDisplayName: 'zhangbo3(张波)' },
      authorizedUser: {
        providerDisplayName: 'zhangbo3(张波)',
        properties: { Account: { $value: 'zhangbo3' } },
      },
      instanceId: 'inst-1',
    },
    '_apis/wit/workitems?ids=': { value: [] },
    '_apis/wit/workitemtypes': { value: [{ name: '需求' }, { name: '任务' }] },
  })
  const fs = createMemFs()
  return new TfsAdapter({
    rest: rest.config,
    writeGuard: new WriteGuard(new AuditLog('/mem/audit', fs)),
    collection: 'WN_HIS',
    profileLabel: 'tfs-mcp',
  })
}

describe('T027 只读出口契约（REST 版：端点与请求形状锁定实测）', () => {
  it('whoami 打 _apis/connectionData 且**不带 api-version**（带了会 400，实测）', async () => {
    const a = makeAdapter()
    const me = (await a.whoami()) as Record<string, unknown>
    const call = rest.calls.find(c => c.url.includes('/_apis/connectionData'))!
    expect(call.method).toBe('GET')
    expect(call.url).not.toContain('api-version')
    expect(call.url).toContain('/WN_HIS/_apis/connectionData')
    // 旧 `tfs_whoami` 形状对齐：uniqueName/displayName 顶层字段。
    expect(me['displayName']).toBe('zhangbo3(张波)')
    expect(me['uniqueName']).toBe('zhangbo3')
  })

  it('getProjects 打 _apis/projects 活清单 + api-version=4.1 + Basic 认证（问题 3 根治）', async () => {
    const a = makeAdapter()
    const rows = (await a.getProjects()) as Array<Record<string, unknown>>
    const call = rest.calls.find(c => c.url.includes('/_apis/projects'))!
    expect(call.url).toContain('/WN_HIS/_apis/projects')
    expect(call.url).toContain('api-version=4.1')
    // 列表端点按 x-ms-continuationtoken 分页取全集（A15），单页上限 500。
    expect(call.url).toContain('$top=500')
    expect(call.url).toContain('$skip=0')
    expect(call.headers['Authorization']).toMatch(/^Basic /)
    // 对齐旧 `tfs_get_projects` 返回形状 `[{id, name, collection}]`。
    expect(rows[0]).toMatchObject({ id: 'p1', name: 'EAHis', collection: 'WN_HIS' })
  })

  it('getWorkItem 必填 id:number（字符串入参被归一为 number），打 workitems/{id}', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/456', {
      id: 456,
      rev: 3,
      fields: { 'System.Title': '基础框架搭建', 'System.State': '已关闭' },
    })
    const wi = (await a.getWorkItem('456')) as Record<string, unknown>
    const call = rest.calls.find(c => c.url.includes('/_apis/wit/workitems/456'))!
    expect(call.method).toBe('GET')
    expect(call.url).toContain('api-version=4.1')
    expect(wi['id']).toBe(456)
  })

  it('getWorkItems 用 ids:number[]（不是 id/ids 字符串），URL 带 ids=1,2,3', async () => {
    const a = makeAdapter()
    await a.getWorkItems({ ids: [1, 2, 3] })
    const call = rest.calls.find(c => c.url.includes('/_apis/wit/workitems?ids=1,2,3'))!
    expect(call.method).toBe('GET')
  })

  it('queryWiql 用 query 字段（不是 wiql），POST 到 _apis/wit/wiql', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/wiql', { workItems: [] })
    const rows = (await a.queryWiql('SELECT [System.Id] FROM WorkItems')) as unknown[]
    const call = rest.calls.find(c => c.url.includes('/_apis/wit/wiql'))!
    expect(call.method).toBe('POST')
    expect(call.url).toContain('api-version=4.1')
    expect((call.body as Record<string, unknown>)['query']).toBe('SELECT [System.Id] FROM WorkItems')
    // REST 0 命中 = 空数组（对比 tfs-mcp 的 "items is not iterable" 伪错 —— REST 无此问题）。
    expect(rows).toEqual([])
  })

  it('全部请求经统一 Basic 认证头（凭据绝不进 URL/参数）', async () => {
    const a = makeAdapter()
    await a.getProjects()
    await a.whoami()
    for (const c of rest.calls) {
      expect(c.headers['Authorization']).toBe(`Basic ${Buffer.from(':PAT-TEST', 'utf8').toString('base64')}`)
      expect(c.url).not.toContain('PAT-TEST')
    }
  })
})

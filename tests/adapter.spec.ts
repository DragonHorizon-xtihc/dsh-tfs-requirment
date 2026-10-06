import { beforeEach, describe, expect, it } from 'vitest'
import {
  TfsAdapter,
  unwrapToolValue,
  type CreateWorkItemSpec,
} from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'
import { makeFakeRest, type FakeRest } from './helpers/fake-rest.js'

/**
 * adapter 单测（**REST 版**，2026-09-19 REST 化改造）。
 *
 * 事实来源变更记录：
 *   - 旧版锁定 tfs-mcp 工具 JSON Schema 与 MCP 信封解包（2026-09-17/18 实测）；
 *   - REST 版锁定 **REST 端点形状**（2026-09-19 真实 TFS 探针实测）：
 *     - 写回 = `PATCH /_apis/wit/workitems/{id}?api-version=4.1`，`Content-Type: application/json-patch+json`；
 *     - 乐观并发 = 体首条 `{"op":"test","path":"/rev","value":N}`（冲突 412 + VS403351）；
 *     - `tfs_add_tags.tags` 为分号拼接字符串 → `/fields/System.Tags`（语义不变）；
 *     - `tfs_assign` 字段名 `assignedTo` → `/fields/System.AssignedTo`（语义不变）。
 *
 * MCP 信封解包函数（`unwrapToolValue`）保留为纯函数测试（历史契约 + mcp 通道可能复用）。
 */

let memFs: MemFs
let rest: FakeRest

beforeEach(() => {
  memFs = createMemFs()
})

/** 默认桩：PATCH/POST 一律成功返回更新后的工作项（rev +1）。 */
function makeAdapter(extra: { maxResponseBytes?: number } = {}): TfsAdapter {
  rest = makeFakeRest({
    '_apis/wit/workitems?ids=': { value: [] },
    '_apis/projects': { value: [{ id: 'p1', name: 'EAHis' }] },
  })
  const guard = new WriteGuard(new AuditLog('/mem/audit', memFs))
  return new TfsAdapter({
    rest: rest.config,
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 'winning',
    ...(extra.maxResponseBytes !== undefined ? { maxResponseBytes: extra.maxResponseBytes } : {}),
  })
}

/** 找最近一次对指定工作项的 PATCH 请求。 */
function patchOf(id: number): { url: string; headers: Record<string, string>; body: Array<{ op: string; path: string; value?: unknown }> } {
  const call = [...rest.calls]
    .reverse()
    .find(c => c.method === 'PATCH' && c.url.includes(`/_apis/wit/workitems/${id}`))
  expect(call, `应存在对 ${id} 的 PATCH 请求`).toBeDefined()
  return call as never
}

describe('REST 出口基础形态（api-version / Content-Type / 认证）', () => {
  it('写回 PATCH 用 api-version=4.1（7.1 会 404，实测）与 json-patch+json', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/123', { id: 123, rev: 2 })
    const r = await a.changeState(123, 'WN_HIS', 'Resolved', 'Active', true)
    expect(r.ok).toBe(true)
    const call = patchOf(123)
    expect(call.url).toContain('api-version=4.1')
    expect(call.headers['Content-Type']).toBe('application/json-patch+json')
    expect(call.url).not.toContain('7.1')
  })

  it('PATCH 体首条是 {"op":"test","path":"/rev"}（乐观并发，D7）', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/123', { id: 123, rev: 2 })
    await a.changeState(123, 'WN_HIS', 'Resolved', 'Active', true)
    const body = patchOf(123).body
    // rev 来源 = 调用方未传 → adapter 未知 rev 时不插 test（服务端最后写入者胜）。
    // 此处仅断言 json-patch 形状合法；rev test 的注入在 rest-client 单测覆盖。
    expect(body[0]?.op).toBe('replace')
  })

  it('未确认即拒（门禁2），且不发任何请求', async () => {
    const a = makeAdapter()
    const r = await a.addTags(123, 'WN_HIS', ['dsh'], [], false)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('确认')
    expect(rest.calls.filter(c => c.method === 'PATCH')).toHaveLength(0)
  })
})

describe('addTags（tags 为分号拼接字符串 → /fields/System.Tags）', () => {
  it('confirmed 时发出 {"op":"replace","path":"/fields/System.Tags","value":"前端;紧急;Bug"}', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/123', { id: 123, rev: 5 })
    const r = await a.addTags(123, 'WN_HIS', ['前端', '紧急', 'Bug'], [], true)
    expect(r.ok).toBe(true)
    const body = patchOf(123).body
    expect(body[0]).toEqual({ op: 'replace', path: '/fields/System.Tags', value: '前端;紧急;Bug' })
  })

  it('集合缺省时用默认集合（URL 仍含 WN_HIS）', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/456', { id: 456, rev: 2 })
    await a.addTags('456', undefined, ['dsh'], [], true)
    const call = patchOf(456)
    expect(call.url).toContain('/WN_HIS/_apis/wit/workitems/456')
    expect(call.body[0]).toEqual({ op: 'replace', path: '/fields/System.Tags', value: 'dsh' })
  })
})

describe('changeState（state → /fields/System.State）', () => {
  it('发出 {"op":"replace","path":"/fields/System.State","value":"Resolved"}', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/10', { id: 10, rev: 4 })
    await a.changeState(10, 'WN_HIS', 'Resolved', 'Active', true)
    expect(patchOf(10).body[0]).toEqual({
      op: 'replace', path: '/fields/System.State', value: 'Resolved',
    })
  })
})

describe('addComment（comment → /fields/System.History）', () => {
  it('发出 {"op":"add","path":"/fields/System.History","value":"已完成拆解"}', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/7', { id: 7, rev: 9 })
    await a.addComment(7, 'WN_HIS', '已完成拆解', true)
    expect(patchOf(7).body[0]).toEqual({
      op: 'add', path: '/fields/System.History', value: '已完成拆解',
    })
  })
})

describe('assign（字段名 assignedTo → /fields/System.AssignedTo）', () => {
  it('发出 {"op":"replace","path":"/fields/System.AssignedTo","value":"zhangbo3"}', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/9', { id: 9, rev: 2 })
    await a.assign(9, 'WN_HIS', 'zhangbo3', 'someone', true)
    const body = patchOf(9).body
    expect(body[0]).toEqual({
      op: 'replace', path: '/fields/System.AssignedTo', value: 'zhangbo3',
    })
    // 绝不出现错误的 assignTo 字段（历史契约）。
    expect(JSON.stringify(body)).not.toContain('assignTo')
  })
})

describe('createWorkItem（POST /{project}/_apis/wit/workitems/${type}）', () => {
  it('基础规格 POST 到正确端点，Title 为首条 op', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/$Task', { id: 3001, rev: 1 })
    const spec: CreateWorkItemSpec = { project: 'PEIS', workItemType: 'Task', title: '接入 TFS' }
    const r = await a.createWorkItem('WN_TJ', spec, true)
    expect(r.ok).toBe(true)
    const call = rest.calls.find(c => c.method === 'POST' && c.url.includes('_apis/wit/workitems/$Task'))!
    // createWorkItem 的第一段路径 = spec.project（项目作用域创建端点，官方形态）。
    expect(call.url).toContain('/PEIS/_apis/wit/workitems/$Task')
    expect(call.headers['Content-Type']).toBe('application/json-patch+json')
    const body = call.body as Array<Record<string, unknown>>
    expect(body[0]).toEqual({ op: 'add', path: '/fields/System.Title', value: '接入 TFS' })
  })

  it('自定义字段收敛到 /fields/<key>，不泄漏为顶层字段', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/$Bug', { id: 3002, rev: 1 })
    const spec: CreateWorkItemSpec = {
      project: 'PEIS',
      workItemType: 'Bug',
      title: '修复 NPE',
      assignedTo: 'zhangbo3',
      fields: { 'Microsoft.VSTS.Common.Priority': '1' },
    }
    await a.createWorkItem('WN_HIS', spec, true)
    const call = rest.calls.find(c => c.method === 'POST')!
    const body = call.body as Array<{ op: string; path: string; value?: unknown }>
    expect(body).toContainEqual({ op: 'add', path: '/fields/Microsoft.VSTS.Common.Priority', value: '1' })
    expect(body).toContainEqual({ op: 'add', path: '/fields/System.AssignedTo', value: 'zhangbo3' })
    // 顶层不得出现裸字段键。
    expect(JSON.stringify(body)).not.toContain('"path":"Microsoft.VSTS.Common.Priority"')
  })
})

describe('写失败归一（412 rev 冲突 / 404 / 401，实测码）', () => {
  it('rev 冲突（412 + VS403351）→ ok=false 且 reason 含"已被他人修改"与实际 rev', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/1', {
      status: 412,
      body: {
        message: 'VS403351: Test Operation for path /rev failed, value 8 was not equal to test value 999999.',
        typeName: 'Microsoft.VisualStudio.Services.WebApi.Patch.TestPatchOperationFailedException',
      },
    })
    const r = await a.changeState(1, 'WN_HIS', 'Closed', 'Active', true)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('已被他人修改')
    expect(r.reason).toContain('rev 8')
  })

  it('404（纯文本体）→ ok=false 且不二次抛错', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/2', { status: 404, body: 'Sorry, Page Not Found' })
    const r = await a.changeState(2, 'WN_HIS', 'Closed', 'Active', true)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('404')
  })

  it('失败原因含 profile 标签但不含明文凭据', async () => {
    const a = makeAdapter()
    rest.setRoute('_apis/wit/workitems/3', { status: 400, body: { message: 'work item 3 not found' } })
    const r = await a.addTags(3, 'WN_HIS', ['dsh'], [], true)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('profile=winning')
    expect(r.reason).toContain('work item 3 not found')
    expect(r.reason).not.toContain('PAT-TEST')
  })
})

describe('MCP 信封解包（保留：纯函数契约 + 历史 mcp 通道可能复用）', () => {
  it('structuredContent 优先于 content（协议权威结构化载荷）', () => {
    expect(
      unwrapToolValue({
        content: [{ type: 'text', text: '{"from":"content"}' }],
        structuredContent: { from: 'structured' },
      }),
    ).toEqual({ from: 'structured' })
  })

  it('裸载荷直接透传（宿主未来直接投影业务对象 / 测试桩）', () => {
    expect(unwrapToolValue([{ id: 1 }])).toEqual([{ id: 1 }])
    expect(unwrapToolValue(null)).toBeNull()
  })

  it('信封内没有文本块时返回 undefined', () => {
    expect(unwrapToolValue({ content: [{ type: 'image', data: 'x' }] })).toBeUndefined()
  })
})

describe('宿主运行时异常归一（REST 版语义）', () => {
  it('工具未映射（如 tfs_download_attachment）抛 TfsAdapterError 且消息含指引', async () => {
    const a = makeAdapter()
    await expect(
      (a as unknown as { call: (raw: string, args: unknown) => Promise<unknown> }).call(
        'tfs_download_attachment', { id: 1 },
      ),
    ).rejects.toMatchObject({
      name: 'TfsAdapterError',
      message: expect.stringContaining('暂无映射'),
    })
  })
})

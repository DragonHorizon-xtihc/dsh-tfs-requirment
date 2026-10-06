import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TfsAdapter, IMPLEMENTED_OPERATIONS, normalizeWorkItem } from '../src/tfs/adapter.js'
import { catalogSpecs } from '../src/tfs/tool-catalog.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'
import { makeFakeRest, type FakeRest } from './helpers/fake-rest.js'

/**
 * 问题 13：契约表 49 个操作中新增接入的 34 个端点路由测试。
 *
 * 端点配方来自 2026-09-19/20 对真实 TFS 2018（WN_HIS）的探针实测（见 specs/003/spec.md）：
 * 集合管理 3、WIQL 族 7、附件 4、TFVC 6、Git 7、PR 7。本文件用 URL 子串桩锁定：
 *   1) 每个操作打到**正确的方法 + 路径 + 查询串/请求体**；
 *   2) 写操作经 wrappedWrite 过门禁（未确认不发请求）；
 *   3) 下载落盘文件名经 safeJoin/safeBasename 防目录穿越；
 *   4) TFS 2018 不支持的子资源（commits/{id}/workItems、PR workitems）给可读错误而非静默空列表。
 */

/** 问题 13 新接入的 34 个操作键（原 15 个不在此列）。 */
const NEW_OPERATIONS = [
  // 集合管理
  'tfs_set_collection', 'tfs_update_token', 'tfs_list_collections',
  // WIQL 族
  'tfs_get_work_items_by_customer', 'tfs_get_recent_resolved', 'tfs_get_bugs',
  'tfs_get_relations', 'tfs_update_workitem', 'tfs_custom_query',
  'tfs_search_work_items', 'tfs_run_saved_query',
  // 附件
  'tfs_list_attachments', 'tfs_upload_attachment', 'tfs_download_attachments', 'tfs_download_tfvc_files',
  // TFVC
  'tfs_get_tfvc_changeset_changes', 'tfs_list_tfvc_branches', 'tfs_list_tfvc_items',
  'tfs_get_tfvc_item', 'tfs_get_tfvc_file',
  // Git
  'tfs_list_repos', 'tfs_get_repo', 'tfs_get_commits', 'tfs_check_commit_work_items',
  'tfs_list_branches', 'tfs_get_branch', 'tfs_get_branch_diffs',
  // PR
  'tfs_list_prs', 'tfs_get_pr', 'tfs_get_pr_commits', 'tfs_get_pr_workitems',
  'tfs_get_pr_diffs', 'tfs_add_pr_comment', 'tfs_create_pr',
]

/** 标准 fields 形状工作项。 */
function wi(id: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    rev: 1,
    fields: {
      'System.Id': id,
      'System.Title': `标题 ${id}`,
      'System.WorkItemType': '需求',
      'System.State': 'Active',
      'System.AssignedTo': 'zhangbo3',
      'System.TeamProject': 'EAHis',
      ...over,
    },
  }
}

interface Harness {
  adapter: TfsAdapter
  rest: FakeRest
  fs: MemFs
}

function makeHarness(routes: Parameters<typeof makeFakeRest>[0] = {}): Harness {
  const rest = makeFakeRest(routes)
  const fs = createMemFs()
  const guard = new WriteGuard(new AuditLog('/mem/audit', fs))
  const adapter = new TfsAdapter({
    rest: rest.config,
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 't34',
    knownCollections: ['WN_HIS', 'WN_TJ'],
    downloadsDir: join(workDir, 'downloads'),
  })
  return { adapter, rest, fs }
}

/** 经私有单一出口 call() 调只读操作。 */
function call(adapter: TfsAdapter, raw: string, args: unknown = {}): Promise<unknown> {
  return (adapter as unknown as { call: (r: string, a: unknown) => Promise<unknown> }).call(raw, args)
}

const workDir = mkdtempSync(join(tmpdir(), 'tfs34-'))
beforeAll(() => {
  /* workDir 在模块加载时创建一次 */
})
afterAll(() => {
  rmSync(workDir, { recursive: true, force: true })
})

// ───────────────────────── 契约完整性 ─────────────────────────

describe('契约表：全部操作均已接入（问题 13）', () => {
  /**
   * 2026-10-04 改为**与契约表比对**，不再硬编码数量。
   *
   * 硬编码 49 的问题是：新增/移除操作必须同步改这个魔法数，否则测试会红得莫名其妙
   * （本次接入 `tfs_remove_tags` 就把它顶到 50）。真正的约束是
   * 「`TFS_TOOL_SPECS`（契约表）与 `IMPLEMENTED_OPERATIONS`（适配层分支表）必须一一对应」——
   * 这两份清单是手工维护的，漂移就是缺陷本身（见审计结论 3.12）。断言它即可自维护。
   */
  it('IMPLEMENTED_OPERATIONS 与契约表完全一致，且含本轮新增的全部 34 个', () => {
    const contract = catalogSpecs().map(s => s.raw)
    const missing = contract.filter(op => !IMPLEMENTED_OPERATIONS.has(op))
    const extra = [...IMPLEMENTED_OPERATIONS].filter(op => !contract.includes(op))
    expect(missing, `契约表登记但适配层未实现：${missing.join(', ')}`).toEqual([])
    expect(extra, `适配层已实现但契约表未登记：${extra.join(', ')}`).toEqual([])
    for (const op of NEW_OPERATIONS) {
      expect(IMPLEMENTED_OPERATIONS.has(op), `缺少 ${op}`).toBe(true)
    }
  })

  it('未映射操作仍报"暂无映射"（能力诚实可见，不静默假成功）', async () => {
    const { adapter } = makeHarness()
    await expect(call(adapter, 'tfs_delete_repo', {})).rejects.toThrow(/暂无映射/)
  })
})

// ───────────────────────── 集合管理（3） ─────────────────────────

describe('集合管理（tfs_list_collections / set_collection / update_token）', () => {
  it('服务器级 projectCollections 404（实测）→ 回落本地配置清单并诚实标注 source', async () => {
    const { adapter } = makeHarness({ '_apis/projectCollections': { status: 404, body: 'not found' } })
    const r = (await call(adapter, 'tfs_list_collections')) as {
      source: string
      defaultCollection: string
      collections: Array<{ name: string; isDefault: boolean }>
    }
    expect(r.source).toBe('local-config')
    expect(r.defaultCollection).toBe('WN_HIS')
    expect(r.collections.map(c => c.name).sort()).toEqual(['WN_HIS', 'WN_TJ'])
    expect(r.collections.find(c => c.name === 'WN_HIS')?.isDefault).toBe(true)
  })

  it('REST 可用时优先用 REST 枚举（source=rest）', async () => {
    const { adapter } = makeHarness({
      '_apis/projectCollections': { value: [{ name: 'WN_HIS', url: 'http://tfs/WN_HIS' }] },
    })
    const r = (await call(adapter, 'tfs_list_collections')) as { source: string; collections: Array<{ name: string }> }
    expect(r.source).toBe('rest')
    expect(r.collections[0]?.name).toBe('WN_HIS')
  })

  it('set_collection 校验已知清单：未知集合拒绝，已知集合切换', async () => {
    const { adapter } = makeHarness()
    await expect(call(adapter, 'tfs_set_collection', { collection: 'NOPE' })).rejects.toThrow(/集合不存在/)
    const ok = (await call(adapter, 'tfs_set_collection', { collection: 'WN_TJ' })) as { success: boolean }
    expect(ok.success).toBe(true)
    expect(adapter.currentCollection).toBe('WN_TJ')
  })

  it('update_token 只改进程内存（不发任何请求）', async () => {
    const { adapter, rest } = makeHarness()
    const r = (await call(adapter, 'tfs_update_token', { pat: 'new-pat' })) as { success: boolean }
    expect(r.success).toBe(true)
    expect(rest.calls).toHaveLength(0)
  })
})

// ───────────────────────── WIQL 族（7） ─────────────────────────

const wiqlRoutes = (items: Array<Record<string, unknown>>): Parameters<typeof makeFakeRest>[0] => ({
  'POST _apis/wit/wiql': { workItems: items.map(x => ({ id: (x as { id: number }).id })) },
  '_apis/wit/workitems?ids=': { value: items },
})

describe('工作项查询族（WIQL 两段式：POST wiql → 批量取字段归一化）', () => {
  it('按客户查：WIQL 含 Winning.Custom.Name 等值条件，返回归一化工作项', async () => {
    const { adapter, rest } = makeHarness(wiqlRoutes([wi(7)]))
    const r = (await call(adapter, 'tfs_get_work_items_by_customer', {
      customerName: '体检中心',
      project: 'EAHis',
    })) as Array<{ id: number; title: string }>
    expect(r[0]?.id).toBe(7)
    expect(r[0]?.title).toBe('标题 7')
    const wiqlCall = rest.calls.find(c => c.method === 'POST' && c.url.includes('_apis/wit/wiql'))!
    const body = wiqlCall.body as { query: string }
    expect(body.query).toContain('[Winning.Custom.Name]')
    expect(body.query).toContain('体检中心')
  })

  it('最近已解决：WIQL 含 ChangedDate 下界与多状态', async () => {
    const { adapter, rest } = makeHarness(wiqlRoutes([wi(8)]))
    const r = (await call(adapter, 'tfs_get_recent_resolved', { days: 30, project: 'EAHis' })) as unknown[]
    expect(r).toHaveLength(1)
    const body = (rest.calls.find(c => c.url.includes('_apis/wit/wiql'))!.body as { query: string }).query
    expect(body).toContain('System.ChangedDate')
    expect(body).toContain('Resolved')
  })

  it('未关闭缺陷：类型含 Bug/缺陷，状态排除 Closed/已关闭', async () => {
    const { adapter, rest } = makeHarness(wiqlRoutes([wi(9)]))
    const r = (await call(adapter, 'tfs_get_bugs', { project: 'EAHis' })) as unknown[]
    expect(r).toHaveLength(1)
    const body = (rest.calls.find(c => c.url.includes('_apis/wit/wiql'))!.body as { query: string }).query
    expect(body).toMatch(/Bug|缺陷/)
    expect(body).toContain('Closed')
  })

  it('自定义查询：返回 {total, returned, workItems}，top/skip 生效', async () => {
    const { adapter } = makeHarness(wiqlRoutes([wi(1), wi(2), wi(3)]))
    const r = (await call(adapter, 'tfs_custom_query', {
      project: 'EAHis',
      types: ['需求'],
      top: 2,
      skip: 1,
    })) as { total: number; returned: number; workItems: unknown[] }
    expect(r.total).toBe(3)
    expect(r.returned).toBe(2)
  })

  it('ASCII 关键字：标题/描述 OR CONTAINS 下推', async () => {
    const { adapter, rest } = makeHarness(wiqlRoutes([wi(11, { 'System.Title': 'login timeout' })]))
    const r = (await call(adapter, 'tfs_search_work_items', { keyword: 'login' })) as Array<{ title: string }>
    expect(r[0]?.title).toBe('login timeout')
    const body = (rest.calls.find(c => c.url.includes('_apis/wit/wiql'))!.body as { query: string }).query
    expect(body).toContain('CONTAINS')
  })

  it('中文关键字（CONTAINS 实测 414）：拉最近变更后客户端标题/描述过滤', async () => {
    const { adapter } = makeHarness(
      wiqlRoutes([
        wi(12, { 'System.Title': '体检系统改造' }),
        wi(13, { 'System.Title': '无关需求' }),
      ]),
    )
    const r = (await call(adapter, 'tfs_search_work_items', { keyword: '体检' })) as Array<{ title: string }>
    expect(r).toHaveLength(1)
    expect(r[0]?.title).toBe('体检系统改造')
  })

  it('已保存查询：必须打项目级 POST /{project}/_apis/wit/wiql/{id}（集合级实测 400）', async () => {
    const { adapter, rest } = makeHarness(wiqlRoutes([wi(14)]))
    const r = (await call(adapter, 'tfs_run_saved_query', {
      project: 'EAHis',
      queryId: 'abc-123',
    })) as Array<{ id: number }>
    expect(r[0]?.id).toBe(14)
    const post = rest.calls.find(c => c.method === 'POST' && c.url.includes('/wiql/abc-123'))!
    expect(post.url).toContain('/EAHis/_apis/wit/wiql/abc-123')
  })

  it('参数缺失给可读错误（customerName / queryId 等）', async () => {
    const { adapter } = makeHarness(wiqlRoutes([]))
    await expect(call(adapter, 'tfs_get_work_items_by_customer', {})).rejects.toThrow(/customerName/)
    await expect(call(adapter, 'tfs_run_saved_query', { project: 'EAHis' })).rejects.toThrow(/queryId/)
  })
})

// ───────────────────────── 关系 / 通用字段更新 / 附件列表 ─────────────────────────

describe('关系与附件元数据（读）', () => {
  it('get_relations：父子关系按 rel 过滤并从 URL 解析 targetId', async () => {
    const { adapter } = makeHarness({
      '_apis/wit/workitems/100': {
        id: 100,
        relations: [
          { rel: 'System.LinkTypes.Hierarchy-Reverse', url: 'http://tfs/WN_HIS/_apis/wit/workItems/99' },
          { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'http://tfs/WN_HIS/_apis/wit/workItems/101' },
          { rel: 'AttachedFile', url: 'http://tfs/file' },
        ],
      },
    })
    const parents = (await call(adapter, 'tfs_get_relations', { id: 100, relationType: 'parent' })) as {
      count: number
      relations: Array<{ targetId: number }>
    }
    expect(parents.count).toBe(1)
    expect(parents.relations[0]?.targetId).toBe(99)
    const children = (await call(adapter, 'tfs_get_relations', { id: 100, relationType: 'children' })) as {
      count: number
    }
    expect(children.count).toBe(1)
  })

  it('list_attachments：只列 AttachedFile，文件名取 attributes.name', async () => {
    const { adapter } = makeHarness({
      '_apis/wit/workitems/2013322': {
        id: 2013322,
        relations: [
          { rel: 'AttachedFile', url: 'http://tfs/attachments/1', attributes: { name: '设计文档.docx', resourceSize: 1234 } },
          { rel: 'System.LinkTypes.Hierarchy-Forward', url: 'http://tfs/wi/5' },
        ],
      },
    })
    const r = (await call(adapter, 'tfs_list_attachments', { id: 2013322 })) as {
      count: number
      attachments: Array<{ name: string; size: number }>
    }
    expect(r.count).toBe(1)
    expect(r.attachments[0]?.name).toBe('设计文档.docx')
    expect(r.attachments[0]?.size).toBe(1234)
  })

  it('update_workitem（写）：未确认不发请求；确认后字段名收敛到 /fields/<key>，空值清空字段', async () => {
    const { adapter, rest } = makeHarness({ 'PATCH _apis/wit/workitems/55': { id: 55, rev: 4 } })
    const blocked = await adapter.wrappedWrite(
      'tfs_update_workitem',
      { id: 55, fields: { 'System.State': 'Closed' } },
      false,
    )
    expect(blocked.ok).toBe(false)
    expect(rest.calls.filter(c => c.method === 'PATCH')).toHaveLength(0)
    const ok = await adapter.wrappedWrite(
      'tfs_update_workitem',
      { id: 55, fields: { 'System.State': 'Closed', 'System.Tags': '' }, comment: '关闭' },
      true,
    )
    expect(ok.ok).toBe(true)
    const patch = rest.calls.find(c => c.method === 'PATCH' && c.url.includes('/workitems/55'))!
    const ops = patch.body as Array<{ op: string; path: string; value?: unknown }>
    expect(ops).toContainEqual({ op: 'add', path: '/fields/System.State', value: 'Closed' })
    /**
     * 清空字段走 `add` + `null` 而不是 `remove`：TFS 的 JSON Patch 是原子的，
     * `remove /fields/X` 对"当前无值的字段"会失败，并把同一次调用里其他字段的更新一起回滚
     * （A21）。断言这条是为了钉住这个选择。
     */
    expect(ops).toContainEqual({ op: 'add', path: '/fields/System.Tags', value: null })
    expect(ops.some(o => o.path === '/fields/System.History' && o.value === '关闭')).toBe(true)
  })
})

// ───────────────────────── 附件上传 / 下载（防穿越） ─────────────────────────

describe('附件上传/下载（问题 13；safeJoin/safeBasename 防目录穿越）', () => {
  it('上传：POST attachments?fileName=（octet-stream）→ PATCH relations/- 关联 AttachedFile', async () => {
    const { adapter, rest } = makeHarness({
      'POST _apis/wit/attachments': { id: 'att-1', url: 'http://tfs.example:8080/tfs/_apis/wit/attachments/att-1' },
      'PATCH _apis/wit/workitems/88': { id: 88, rev: 3 },
    })
    const local = join(workDir, 'upload-me.txt')
    writeFileSync(local, '附件内容ABC', 'utf8')
    const r = await adapter.wrappedWrite(
      'tfs_upload_attachment',
      { id: 88, path: local, fileName: '说明.txt', comment: '见附件' },
      true,
    )
    expect(r.ok).toBe(true)
    const post = rest.calls.find(c => c.method === 'POST' && c.url.includes('_apis/wit/attachments'))!
    expect(post.url).toContain('fileName=' + encodeURIComponent('说明.txt'))
    expect(post.headers['Content-Type']).toContain('application/octet-stream')
    const patch = rest.calls.find(c => c.method === 'PATCH' && c.url.includes('/workitems/88'))!
    const ops = patch.body as Array<{ op: string; path: string; value: Record<string, unknown> }>
    const rel = ops.find(o => o.path === '/relations/-')!
    expect(rel.value.rel).toBe('AttachedFile')
    expect(String(rel.value.url)).toContain('att-1')
    expect((rel.value.attributes as { name: string }).name).toBe('说明.txt')
  })

  it('下载：按服务端文件名落盘；恶意 ../ 文件名被 basename 清洗，无法逃出目标目录', async () => {
    const target = join(workDir, 'downloads', 'dl-att')
    const { adapter } = makeHarness({
      '_apis/wit/workitems/89': {
        id: 89,
        relations: [
          { rel: 'AttachedFile', url: 'http://tfs.example:8080/att/f1?filename=正常.txt', attributes: { name: '正常.txt' } },
          { rel: 'AttachedFile', url: 'http://tfs.example:8080/att/f2', attributes: { name: '../../evil.txt' } },
        ],
      },
      'att/f1': { raw: '正常内容' },
      'att/f2': { raw: '恶意内容' },
    })
    const r = (await call(adapter, 'tfs_download_attachments', { id: 89, targetDir: target })) as {
      success: boolean
      total: number
      successCount: number
      downloaded: Array<{ name: string; path: string; error?: string }>
    }
    expect(r.successCount).toBe(2)
    expect(readFileSync(join(target, '正常.txt'), 'utf8')).toBe('正常内容')
    // 穿越文件名被清洗为 basename，落在目标目录内。
    const evil = r.downloaded.find(d => d.name === 'evil.txt')!
    expect(evil.path.startsWith(target)).toBe(true)
    expect(existsSync(join(workDir, 'evil.txt'))).toBe(false)
    expect(readFileSync(join(target, 'evil.txt'), 'utf8')).toBe('恶意内容')
  })

  it('下载落点：缺省围在下载根目录内，越界的 targetDir 被拒且不建目录（A31）', async () => {
    const { adapter } = makeHarness({
      '_apis/wit/workitems/89': {
        id: 89,
        relations: [{ rel: 'AttachedFile', url: 'http://tfs.example:8080/att/f1', attributes: { name: 'a.txt' } }],
      },
      'att/f1': { raw: '内容' },
    })
    const outside = join(workDir, 'not-downloads', 'x')
    // 越界落点必须**拒绝**，而不是先 mkdir 再写：否则一次下载等于在宿主任意位置建目录写文件。
    await expect(call(adapter, 'tfs_download_attachments', { id: 89, targetDir: outside })).rejects.toThrow(
      /不在下载根目录/,
    )
    expect(existsSync(outside)).toBe(false)
    // 落在根目录内的子目录照常可用。
    const inside = join(workDir, 'downloads', 'sub')
    const ok = (await call(adapter, 'tfs_download_attachments', { id: 89, targetDir: inside })) as {
      successCount: number
    }
    expect(ok.successCount).toBe(1)
    expect(readFileSync(join(inside, 'a.txt'), 'utf8')).toBe('内容')
  })
})

// ───────────────────────── TFVC（6） ─────────────────────────

describe('TFVC 端点（items / branches / changeset changes / 文件下载）', () => {
  it('list_tfvc_items：scopePath + OneLevel，文件夹/文件分组', async () => {
    const { adapter, rest } = makeHarness({
      '_apis/tfvc/items?scopePath=': {
        value: [
          { path: '$/PEIS', isFolder: true, version: 1 },
          { path: '$/PEIS/a.cs', isFolder: false, version: 2, size: 10 },
        ],
      },
    })
    const r = (await call(adapter, 'tfs_list_tfvc_items', { scopePath: '$/PEIS' })) as {
      count: number
      folders: unknown[]
      files: unknown[]
    }
    expect(r.count).toBe(2)
    expect(r.folders).toHaveLength(1)
    expect(r.files).toHaveLength(1)
    expect(rest.calls[0]?.url).toContain('recursionLevel=OneLevel')
  })

  it('scopePath 不以 $/ 开头 → 可读错误', async () => {
    const { adapter } = makeHarness()
    await expect(call(adapter, 'tfs_list_tfvc_items', { scopePath: 'PEIS' })).rejects.toThrow(/\$\//)
  })

  it('get_tfvc_item：?path= 单条目精简视图', async () => {
    const { adapter } = makeHarness({
      '_apis/tfvc/items?path=': { path: '$/PEIS/a.cs', isFolder: false, version: 7, size: 99 },
    })
    const r = (await call(adapter, 'tfs_get_tfvc_item', { path: '$/PEIS/a.cs' })) as { path: string; version: number }
    expect(r.path).toBe('$/PEIS/a.cs')
    expect(r.version).toBe(7)
  })

  it('get_tfvc_file：文本文件返回 utf8 content（同 URL 元数据 + 字节两次请求）', async () => {
    const { adapter, rest } = makeHarness({
      '_apis/tfvc/items?path=': { raw: JSON.stringify({ path: '$/PEIS/a.cs', version: 5 }) },
    })
    const r = (await call(adapter, 'tfs_get_tfvc_file', { path: '$/PEIS/a.cs' })) as {
      encoding: string
      content: string
      version: number
    }
    expect(r.encoding).toBe('utf8')
    expect(r.content).toContain('"version":5')
    expect(rest.calls.filter(c => c.url.includes('_apis/tfvc/items')).length).toBeGreaterThanOrEqual(2)
  })

  it('list_tfvc_branches：includeChildren=false（全量 children 实测超时），owner 拍平', async () => {
    const { adapter, rest } = makeHarness({
      '_apis/tfvc/branches?includeChildren=false': {
        value: [{ path: '$/PEIS/main', description: '主干', owner: { displayName: '张三' } }],
      },
    })
    const r = (await call(adapter, 'tfs_list_tfvc_branches', {})) as Array<{ path: string; owner: string }>
    expect(r[0]?.path).toBe('$/PEIS/main')
    expect(r[0]?.owner).toBe('张三')
    expect(rest.calls[0]?.url).toContain('includeChildren=false')
  })

  it('get_tfvc_changeset_changes：/changesets/{id}/changes?$top=N', async () => {
    const { adapter } = makeHarness({
      '_apis/tfvc/changesets/123/changes': {
        value: [{ changeType: 'add, edit', item: { path: '$/PEIS/a.cs', isFolder: false, version: 9 } }],
      },
    })
    const r = (await call(adapter, 'tfs_get_tfvc_changeset_changes', { changesetId: 123, top: 50 })) as Array<{
      path: string
      changeType: string
    }>
    expect(r[0]?.path).toBe('$/PEIS/a.cs')
    expect(r[0]?.changeType).toContain('add')
  })

  it('download_tfvc_files：保留公共根相对目录结构落盘', async () => {
    const target = join(workDir, 'downloads', 'dl-tfvc')
    const { adapter } = makeHarness({
      '_apis/tfvc/items?path=%24%2FPEIS%2FA%2Fa.txt': { raw: 'AAA' },
      '_apis/tfvc/items?path=%24%2FPEIS%2FB%2Fb.txt': { raw: 'BBB' },
    })
    const r = (await call(adapter, 'tfs_download_tfvc_files', {
      paths: ['$/PEIS/A/a.txt', '$/PEIS/B/b.txt'],
      targetDir: target,
    })) as { success: boolean; successCount: number }
    expect(r.successCount).toBe(2)
    expect(readFileSync(join(target, 'A', 'a.txt'), 'utf8')).toBe('AAA')
    expect(readFileSync(join(target, 'B', 'b.txt'), 'utf8')).toBe('BBB')
  })
})

// ───────────────────────── Git（7） ─────────────────────────

const gitArgs = { project: 'EAHis', repositoryId: 'repo-1' }

describe('Git 仓库/分支/提交（项目级前缀 /{project}/_apis/git/repositories）', () => {
  it('list_repos / get_repo：正确项目级前缀与视图字段', async () => {
    const { adapter } = makeHarness({
      '/EAHis/_apis/git/repositories': {
        value: [{ id: 'repo-1', name: 'peis', defaultBranch: 'refs/heads/main', project: { name: 'EAHis' } }],
      },
      '/EAHis/_apis/git/repositories/repo-1': { id: 'repo-1', name: 'peis', size: 1234, defaultBranch: 'refs/heads/main' },
    })
    const list = (await call(adapter, 'tfs_list_repos', { project: 'EAHis' })) as Array<{ id: string; name: string }>
    expect(list[0]?.id).toBe('repo-1')
    const one = (await call(adapter, 'tfs_get_repo', gitArgs)) as { id: string; size: number }
    expect(one.id).toBe('repo-1')
    expect(one.size).toBe(1234)
  })

  it('list_repos：跟随 x-ms-continuationtoken 取全量仓库，不把前 $top 条当全集（A15）', async () => {
    const { adapter, rest } = makeHarness({
      '/EAHis/_apis/git/repositories': {
        status: 200,
        headers: { 'x-ms-continuationtoken': 'tok-1' },
        body: { value: [{ id: 'repo-1', name: 'peis' }, { id: 'repo-2', name: 'his' }] },
      },
    })
    // 第二页没有游标 ⇒ 翻页停止。用 setRoute 无法区分页，故用调用次数与第二页内容断言。
    const list = (await call(adapter, 'tfs_list_repos', { project: 'EAHis' })) as Array<{ id: string }>
    // 服务端一直在回游标，collectPaged 有 50 页安全上限；至少证明第 2 页确实发了。
    expect(rest.calls.length).toBeGreaterThanOrEqual(2)
    expect(rest.calls[0]?.url).toContain('$skip=0')
    expect(rest.calls[1]?.url).toContain('$skip=2')
    expect(rest.calls[1]?.headers['x-ms-continuationtoken']).toBe('tok-1')
    expect(list.length).toBeGreaterThanOrEqual(2)
  })

  it('get_commits：commits?$top=', async () => {
    const { adapter, rest } = makeHarness({
      '/repositories/repo-1/commits': {
        value: [{ commitId: 'c1', comment: 'init', author: { name: '张三' } }],
      },
    })
    const r = (await call(adapter, 'tfs_get_commits', { ...gitArgs, top: 5 })) as Array<{ commitId: string }>
    expect(r[0]?.commitId).toBe('c1')
    expect(rest.calls[0]?.url).toContain('commits?$top=5')
  })

  it('list_branches / get_branch：refs?filter=heads，裸分支名剥离 refs/heads/', async () => {
    const { adapter } = makeHarness({
      'repositories/repo-1/refs?filter=heads': {
        value: [
          { name: 'refs/heads/main', objectId: 'o1' },
          { name: 'refs/heads/dev', objectId: 'o2' },
        ],
      },
    })
    const list = (await call(adapter, 'tfs_list_branches', gitArgs)) as Array<{ name: string }>
    expect(list.map(b => b.name).sort()).toEqual(['dev', 'main'])
    const one = (await call(adapter, 'tfs_get_branch', { ...gitArgs, branchName: 'dev' })) as { name: string; objectId: string }
    expect(one.name).toBe('dev')
    expect(one.objectId).toBe('o2')
  })

  it('get_branch 分支不存在 → 可读错误', async () => {
    const { adapter } = makeHarness({ 'repositories/repo-1/refs?filter=heads': { value: [] } })
    await expect(call(adapter, 'tfs_get_branch', { ...gitArgs, branchName: 'ghost' })).rejects.toThrow(/分支不存在/)
  })

  it('get_branch_diffs：POST commitsbatch，body {fromCommitId,toCommitId}（接受分支名）', async () => {
    const { adapter, rest } = makeHarness({
      'repositories/repo-1/commitsbatch': { value: [{ commitId: 'c2' }] },
    })
    const r = (await call(adapter, 'tfs_get_branch_diffs', {
      ...gitArgs,
      baseBranch: 'main',
      targetBranch: 'dev',
    })) as { commitCount: number }
    expect(r.commitCount).toBe(1)
    const post = rest.calls.find(c => c.url.includes('commitsbatch'))!
    expect(post.body).toEqual({ fromCommitId: 'main', toCommitId: 'dev' })
  })

  it('check_commit_work_items：TFS 2018 子资源 404 → 可读错误并引导反向查询（不静默空列表）', async () => {
    const { adapter } = makeHarness({
      'commits/abc12345/workitems': { status: 404, body: 'not found' },
      'commits/abc12345': { commitId: 'abc12345' },
    })
    await expect(
      call(adapter, 'tfs_check_commit_work_items', { ...gitArgs, commitId: 'abc12345' }),
    ).rejects.toThrow(/TFS 2018/)
  })
})

// ───────────────────────── Pull Request（7） ─────────────────────────

describe('Pull Request 端点', () => {
  it('list_prs：pullrequests?searchCriteria.status=active&$top=，返回 {count,pullRequests}', async () => {
    const { adapter, rest } = makeHarness({
      'repositories/repo-1/pullrequests?searchCriteria.status=active': {
        value: [{ pullRequestId: 1, title: 'PR one', status: 'active' }],
      },
    })
    const r = (await call(adapter, 'tfs_list_prs', gitArgs)) as { count: number; pullRequests: unknown[] }
    expect(r.count).toBe(1)
    expect(rest.calls[0]?.url).toContain('searchCriteria.status=active')
  })

  it('get_pr / get_pr_commits：子资源路径与 $top', async () => {
    const { adapter } = makeHarness({
      'pullrequests/7/commits': { value: [{ commitId: 'c9' }] },
      'pullrequests/7': { pullRequestId: 7, title: 'PR 7' },
    })
    const pr = (await call(adapter, 'tfs_get_pr', { ...gitArgs, pullRequestId: 7 })) as { pullRequestId: number }
    expect(pr.pullRequestId).toBe(7)
    const commits = (await call(adapter, 'tfs_get_pr_commits', { ...gitArgs, pullRequestId: 7 })) as unknown[]
    expect(commits).toHaveLength(1)
  })

  it('get_pr_workitems：TFS 2018 404 → 可读错误', async () => {
    const { adapter } = makeHarness({ 'pullrequests/8/workitems': { status: 404, body: 'x' } })
    await expect(
      call(adapter, 'tfs_get_pr_workitems', { ...gitArgs, pullRequestId: 8 }),
    ).rejects.toThrow(/TFS 2018/)
  })

  it('get_pr_diffs：iterations 取最新迭代 → iterations/{iid}/changes?$top=', async () => {
    const { adapter, rest } = makeHarness({
      'pullrequests/9/iterations/2/changes': {
        changeEntries: [{ item: { path: '/a.cs', objectId: 'o9' }, changeType: 'add' }],
      },
      'pullrequests/9/iterations': { value: [{ id: 1 }, { id: 2 }] },
    })
    const r = (await call(adapter, 'tfs_get_pr_diffs', { ...gitArgs, pullRequestId: 9 })) as {
      iterationId: number
      changeCount: number
      changes: Array<{ path: string }>
    }
    expect(r.iterationId).toBe(2)
    expect(r.changeCount).toBe(1)
    expect(r.changes[0]?.path).toBe('/a.cs')
    expect(rest.calls.some(c => c.url.includes('iterations/2/changes?$top=200'))).toBe(true)
  })

  it('add_pr_comment 无 threadId → POST threads {comments:[{content}],status:1}（写，过门禁）', async () => {
    const { adapter, rest } = makeHarness({
      'POST pullrequests/7/threads': { id: 77 },
    })
    const blocked = await adapter.wrappedWrite(
      'tfs_add_pr_comment',
      { ...gitArgs, pullRequestId: 7, content: 'LGTM' },
      false,
    )
    expect(blocked.ok).toBe(false)
    expect(rest.calls).toHaveLength(0)
    const ok = await adapter.wrappedWrite(
      'tfs_add_pr_comment',
      { ...gitArgs, pullRequestId: 7, content: 'LGTM' },
      true,
    )
    expect(ok.ok).toBe(true)
    const post = rest.calls.find(
      c => c.method === 'POST' && c.url.includes('/pullrequests/7/threads') && !c.url.includes('/comments'),
    )!
    expect(post.body).toEqual({ comments: [{ content: 'LGTM' }], status: 1 })
  })

  it('add_pr_comment 带 threadId → POST threads/{id}/comments {content}', async () => {
    const { adapter, rest } = makeHarness({
      'POST threads/77/comments': { id: 900 },
    })
    const ok = await adapter.wrappedWrite(
      'tfs_add_pr_comment',
      { ...gitArgs, pullRequestId: 7, threadId: 77, comment: '回复' },
      true,
    )
    expect(ok.ok).toBe(true)
    const post = rest.calls.find(c => c.url.includes('threads/77/comments'))!
    expect(post.body).toEqual({ content: '回复' })
  })

  it('create_pr（写）：裸分支名自动补 refs/heads/，POST pullrequests', async () => {
    const { adapter, rest } = makeHarness({
      'POST repositories/repo-1/pullrequests': { pullRequestId: 42 },
    })
    const ok = await adapter.wrappedWrite(
      'tfs_create_pr',
      { ...gitArgs, sourceBranch: 'feature/x', targetBranch: 'main', title: '特性 X', description: 'd' },
      true,
    )
    expect(ok.ok).toBe(true)
    const post = rest.calls.find(c => c.method === 'POST' && c.url.includes('/pullrequests'))!
    expect(post.body).toMatchObject({
      sourceRefName: 'refs/heads/feature/x',
      targetRefName: 'refs/heads/main',
      title: '特性 X',
    })
  })
})

// ───────────────────────── normalizeWorkItem：四段正文字段（问题 11） ─────────────────────────

describe('normalizeWorkItem（问题 11：System.Description + 三段 Winning 富文本字段）', () => {
  it('HTML 富文本转纯文本；三段 Winning 字段映射到 analysis/dataStructure/config；空段不写键', () => {
    const n = normalizeWorkItem(
      {
        id: 1997179,
        fields: {
          'System.Title': '体检需求',
          'System.WorkItemType': '需求',
          'System.State': 'Active',
          'System.Description': '<div>详细信息<b>粗体</b></div>',
          'Winning.Demand.Analysis': '<p>需求分析段</p>',
          'Winning.Data.Design': '<p>数据结构段</p>',
          'Winning.Demand.Config': '<p>需求配置段</p>',
          'System.Tags': 'dsh; 需求',
        },
      },
      'WN_HIS',
    )
    expect(n.id).toBe(1997179)
    expect(n.description).toContain('详细信息')
    expect(n.description).toContain('粗体')
    expect(n.analysis).toContain('需求分析段')
    expect(n.dataStructure).toContain('数据结构段')
    expect(n.config).toContain('需求配置段')
    expect(n.tags).toEqual(['dsh', '需求'])
  })

  it('四段全空时不产生空串键（board.json 不堆空串）', () => {
    const n = normalizeWorkItem(
      { id: 1, fields: { 'System.Title': 't', 'Winning.Demand.Analysis': '   ' } },
      'WN_HIS',
    )
    expect(n.description).toBeUndefined()
    expect(n.analysis).toBeUndefined()
    expect(n.dataStructure).toBeUndefined()
    expect(n.config).toBeUndefined()
  })
})

/**
 * 写分支的入参校验与标签合并回归（A1 / A6 / A8 / A9 / A10）。
 *
 * 这些分支此前都不校验入参：`addTags` 用 JSON-Patch `replace` 覆盖整个 `System.Tags`
 * 字段，领取需求时会把工作项上原有的标签全部抹掉；`assign` 收到空值等于无声清空负责人；
 * `change_state` / `add_comment` 收到非数字 id 会 PATCH 到 `/workitems/NaN`。
 */
describe('写分支：标签合并与入参校验回归（A1/A6/A8/A9/A10）', () => {
  const ID = 1997179

  /** 取出最后一次 PATCH 里的 JSON-Patch 操作列表。 */
  function patchOps(rest: FakeRest): Array<{ op: string; path: string; value?: unknown }> {
    const patch = rest.calls.find(c => c.method === 'PATCH' && c.url.includes(`/workitems/${ID}`))
    expect(patch).toBeDefined()
    const body = patch!.body
    return (Array.isArray(body) ? body : []) as Array<{ op: string; path: string; value?: unknown }>
  }

  it('tfs_add_tags：既有标签不会被覆盖，新标签并入（A1/A8）', async () => {
    const { adapter, rest } = makeHarness({
      [`_apis/wit/workitems/${ID}`]: wi(ID, { 'System.Tags': '需求;重要' }),
      [`PATCH _apis/wit/workitems/${ID}`]: { id: ID, rev: 2 },
    })
    // 数组入参（工具契约写的是"标签数组"），此前会被 String() 拼成一个 "a,b" 标签。
    await call(adapter, 'tfs_add_tags', { id: ID, tags: ['dsh', '自动'] })
    expect(patchOps(rest)).toEqual([
      { op: 'replace', path: '/fields/System.Tags', value: '需求;重要;dsh;自动' },
    ])
  })

  it('tfs_assign：空 assignedTo 被拒，不会清空工作项负责人（A9）', async () => {
    const { adapter, rest } = makeHarness({ [`PATCH _apis/wit/workitems/${ID}`]: { id: ID, rev: 2 } })
    await expect(call(adapter, 'tfs_assign', { id: ID, assignedTo: '  ' })).rejects.toThrow(/assignedTo/)
    expect(rest.calls.some(c => c.method === 'PATCH')).toBe(false)
  })

  it('tfs_change_state / tfs_add_comment：非数字 id 与空值都在发请求前被拒（A10）', async () => {
    const { adapter, rest } = makeHarness({ [`PATCH _apis/wit/workitems/${ID}`]: { id: ID, rev: 2 } })
    await expect(call(adapter, 'tfs_change_state', { id: 'abc', state: 'Active' })).rejects.toThrow(/id/)
    await expect(call(adapter, 'tfs_add_comment', { id: ID, comment: '' })).rejects.toThrow(/comment/)
    expect(rest.calls.some(c => c.method === 'PATCH')).toBe(false)
  })

  it('normalizeWorkItem：IdentityRef 的负责人取显示名，不再是 [object Object]（A6）', () => {
    const n = normalizeWorkItem(
      {
        id: ID,
        fields: {
          'System.Title': 't',
          'System.AssignedTo': { displayName: '张博三', uniqueName: 'zhangbo3' },
          'System.TeamProject': { displayName: 'EAHis 体检' },
        },
      },
      'WN_HIS',
    )
    expect(n.assignedTo).toBe('张博三')
    expect(n.project).toBe('EAHis 体检')
    expect(n.tags).toEqual([])
  })

  it('需求列表：负责人筛选的大小写比较落在归一化之后，IdentityRef 只留显示名（A6）', () => {
    // 这里锁的是"归一化 + 大小写比较"两段逻辑的衔接点：IdentityRef 必须先落成显示名，
    // 随后的 includes 比较才既不漏中文名、也不受大小写影响。
    const rows = [
      normalizeWorkItem({ id: 1, fields: { 'System.Title': 'a', 'System.AssignedTo': { displayName: 'ZhangBo3' } } }, 'WN_HIS'),
      normalizeWorkItem({ id: 2, fields: { 'System.Title': 'b', 'System.AssignedTo': { displayName: '李四' } } }, 'WN_HIS'),
    ]
    const needle = 'zhangbo3'
    expect(rows.filter(r => r.assignedTo.toLowerCase().includes(needle)).map(r => r.id)).toEqual([1])
    // 顺带锁住旧行为：直接 String(IdentityRef) 会得到 [object Object]，两个名字无法区分。
    expect(rows.map(r => r.assignedTo)).not.toContain('[object Object]')
  })
})

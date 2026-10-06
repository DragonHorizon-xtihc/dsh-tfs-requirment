import { describe, expect, it } from 'vitest'
import {
  TfsAdapter,
  normalizeWorkItem,
  isWiqlEmptyResult,
  isAsciiSafe,
  safeSerializedBytes,
  DEFAULT_MAX_RESPONSE_BYTES,
} from '../src/tfs/adapter.js'
import { MAX_DESCRIPTION_CHARS } from '../src/shared/text.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'
import { makeFakeRest, type DynamicRouteRequest, type FakeRest } from './helpers/fake-rest.js'
import {
  REAL_WIQL_ITEM_1_META,
  REAL_WIQL_ITEM_2,
  makeMegaParent,
} from './fixtures/tfs-wiql-real.js'

/**
 * T039 / T054：真实 TFS 形状契约测试（字段映射 + 列表出口 + 变更集回写）。
 *
 * **事实来源全部来自 2026-09-17 对真实 TFS 的实测**，不是推断：
 *   - WIQL 是列表唯一出口（`tfs_custom_query` / `tfs_get_work_items` 的 `expand+fields` 冲突已废弃）；
 *   - 旧 tfs-mcp 在 WIQL 命中 0 条时抛 `items is not iterable` 伪错（REST 直接返回空数组，
 *     但**归一为空列表**的护栏仍要保住：调用方不应因"没数据"而看到失败）；
 *   - WIQL 无视 SELECT，返回全字段 + 全 relations，根计划项可达 3.4MB（7316 条 relations）。
 *
 * ## REST 化后的桩形态变化（2026-09-19）
 *
 * 旧版用 `fake-tools`（`TfsTools.execute` 桩）直接返回**扁平工作项**；
 * REST 化后必须走**两段式**：`POST /_apis/wit/wiql` 只回 id 列表 →
 * `GET /_apis/wit/workitems?ids=` 取字段。故本文件的 `makeAdapter` 接收扁平工作项数组，
 * 自动拆成两份路由（见下），调用点无需感知两段式细节。
 */

let rest: FakeRest

/**
 * 构造 adapter（REST 桩）。
 *
 * @param items - WIQL 命中的工作项（扁平或 `{id, fields}` 形状均可，`normalizeWorkItem` 兼容两者）。
 *   空数组 ⇒ WIQL 返回 0 命中（走"空结果"分支）。
 * @param opts.failWiql - 让 WIQL 端点返回指定状态（测真实失败归一）。
 * @param opts.wiqlStatus - 非 200 的状态码。
 * @param opts.maxResponseBytes - 响应熔断阈值。
 */
function makeAdapter(
  items: Array<Record<string, unknown>> = [],
  opts: { maxResponseBytes?: number; failWiql?: string; wiqlStatus?: number } = {},
): TfsAdapter {
  const fs = createMemFs()
  rest = makeFakeRest()
  // ① WIQL：只回 id（REST 真实语义）。
  if (opts.wiqlStatus) {
    rest.setRoute('POST /_apis/wit/wiql', { status: opts.wiqlStatus, body: opts.failWiql ?? 'boom' })
  } else {
    rest.setRoute('POST /_apis/wit/wiql', { workItems: items.map(i => ({ id: Number(i['id']) })) })
  }
  // ② 批量取字段：按请求 URL 的 `ids` 参数动态返回对应项。
  //   路径 A 只取当前页 ids（如 ids=2,3），路径 B 分批 ≤200；动态路由才能同时覆盖，
  //   而不是注册某一个固定 ids 串（那样换页/分批后会 404）。
  rest.setRoute('GET /_apis/wit/workitems?ids=', (req: DynamicRouteRequest) => {
    const ids = (req.query.get('ids') ?? '')
      .split(',')
      .map(s => Number(s.trim()))
      .filter(Number.isFinite)
    return { value: items.filter(it => ids.includes(Number(it['id']))) }
  })
  return new TfsAdapter({
    rest: rest.config,
    writeGuard: new WriteGuard(new AuditLog('/mem/audit', fs)),
    collection: 'WN_HIS',
    profileLabel: 'winning',
    ...(opts.maxResponseBytes !== undefined ? { maxResponseBytes: opts.maxResponseBytes } : {}),
  })
}

/** 从记录里找**发往 WIQL 端点**的请求体（两段式后，query 只在这里）。 */
function wiqlQuery(): string | undefined {
  const call = rest.calls.find(c => c.url.includes('/_apis/wit/wiql'))
  if (!call) return undefined
  const body = call.body as { query?: unknown } | undefined
  return typeof body?.query === 'string' ? body.query : undefined
}

// ───────────────────────── T039-A 字段映射（真实样本） ─────────────────────────

describe('T039-A 字段映射契约（真实 WIQL 响应样本）', () => {
  it('实测 id=2 样本映射出确切字段值', () => {
    const r = normalizeWorkItem(REAL_WIQL_ITEM_2, 'WN_HIS')
    expect(r.id).toBe(2)
    expect(r.title).toBe('基础框架搭建')
    expect(r.type).toBe('任务')
    expect(r.state).toBe('已关闭')
    expect(r.project).toBe('EDIS')
    expect(r.areaPath).toBe('EDIS')
    expect(r.iterationPath).toBe('EDIS')
    expect(r.assignedTo).toBe('xbp（徐保平) <WINNING\\xbp>')
    expect(r.changedDate).toBe('2026-08-13T08:44:30.84Z')
    expect(r.url).toContain('/workItems/2')
    expect(r.collection).toBe('WN_HIS')
  })

  it('tags 为空串 → 空数组（实测 id=2 无标签）', () => {
    expect(normalizeWorkItem(REAL_WIQL_ITEM_2, 'WN_HIS').tags).toEqual([])
  })

  it('tags 分号字符串拆分为数组（实测 id=1："test-tag; 计划"）', () => {
    const r = normalizeWorkItem(
      { ...REAL_WIQL_ITEM_1_META, tags: 'test-tag; 计划' },
      'WN_HIS',
    )
    expect(r.tags).toEqual(['test-tag', '计划'])
  })

  it('priority 为 number 时被归一为字符串（实测 id=2 priority=1）', () => {
    expect(normalizeWorkItem(REAL_WIQL_ITEM_2, 'WN_HIS').priority).toBe('1')
  })

  it('归一化结果**不含 relations**（避免 MB 级关系数组进入下游）', () => {
    const r = normalizeWorkItem(REAL_WIQL_ITEM_2, 'WN_HIS')
    expect(Object.keys(r)).not.toContain('relations')
    expect(JSON.stringify(r)).not.toContain('vstfs:///Git/Commit')
  })

  it('离群样本（7316 条 relations）归一化后体积恒定，不随 relations 数增长', () => {
    const mega = normalizeWorkItem(makeMegaParent(REAL_WIQL_ITEM_1_META.relationsCount), 'WN_HIS')
    const small = normalizeWorkItem(makeMegaParent(0), 'WN_HIS')
    // 原始样本体积相差约 1MB 级，归一化后两者序列化长度必须相同（relations 被整体丢弃）。
    expect(JSON.stringify(mega).length).toBe(JSON.stringify(small).length)
    expect(JSON.stringify(mega).length).toBeLessThan(1024)
    expect(safeSerializedBytes(makeMegaParent(7316))).toBeGreaterThan(1024 * 1024)
  })

  it('未映射字段（reason/severity/demandAnalysis/moduleName）不外泄到摘要', () => {
    const r = normalizeWorkItem(REAL_WIQL_ITEM_2, 'WN_HIS') as unknown as Record<string, unknown>
    for (const k of ['reason', 'severity', 'demandAnalysis', 'moduleName', 'createdDate']) {
      expect(r[k]).toBeUndefined()
    }
  })

  // US3 / FR-009：'description' 在 002 之前属于"未映射字段"（上面那条用例曾把它列进去），
  // 现在是有意带出的字段——"设为目标"要把需求正文带进执行配置，而客户端半没有 TFS 凭据，
  // 只能在归一化时就把它取出来。同步更新旧断言，避免契约漂移被当成回归漏过去。
  it('正文（System.Description）映射为摘要字段，且与实测样本一致', () => {
    const r = normalizeWorkItem(REAL_WIQL_ITEM_2, 'WN_HIS')
    expect(r.description).toBe('急诊产品基础框架搭建')
  })

  it('正文为富文本 HTML → 归一为可读纯文本（不留 <div>/<br> 等标记）', () => {
    const r = normalizeWorkItem(
      { ...REAL_WIQL_ITEM_2, description: '<div><b>标题</b><br/>第一行&nbsp;&amp;第二行</div>' },
      'WN_HIS',
    )
    expect(r.description).toBe('标题\n第一行 &第二行')
    expect(r.description).not.toContain('<')
    expect(r.description).not.toContain('&nbsp;')
  })

  it('正文为空 → 摘要不带 description 字段（不在 board.json 里堆空串）', () => {
    const r = normalizeWorkItem({ ...REAL_WIQL_ITEM_2, description: '' }, 'WN_HIS')
    expect('description' in r).toBe(false)
  })

  it('超长正文被截断到 MAX_DESCRIPTION_CHARS，并带截断标记', () => {
    const long = '<div>' + '嘀'.repeat(MAX_DESCRIPTION_CHARS + 5000) + '</div>'
    const r = normalizeWorkItem({ ...REAL_WIQL_ITEM_2, description: long }, 'WN_HIS')
    expect(r.description!.length).toBeLessThan(MAX_DESCRIPTION_CHARS + 40)
    expect(r.description).toContain('已截断')
  })
})

// ───────────────────────── T039-B 列表出口契约（WIQL + 两道护栏） ─────────────────────────

describe('T039-B 列表出口契约（实测证据驱动的 WIQL 出口）', () => {
  it('走 WIQL（两段式：POST wiql → GET workitems?ids=）', async () => {
    const a = makeAdapter([REAL_WIQL_ITEM_2])
    const res = await a.listRequirements({ state: '已关闭' })
    expect(res.ok).toBe(true)
    const q = wiqlQuery()!
    expect(q).toContain("[System.State] = '已关闭'")
    expect(q).toContain('ORDER BY [System.ChangedDate] DESC')
    // 第二段确实发出（否则列表项会是空壳）。
    expect(rest.calls.some(c => c.method === 'GET' && c.url.includes('/_apis/wit/workitems?ids='))).toBe(true)
  })

  it('WIQL 请求用 POST + api-version=4.1（REST 出口，不经 tfs-mcp）', async () => {
    const a = makeAdapter([REAL_WIQL_ITEM_2])
    // 传一个收窄条件（state）以通过 D2「禁止无条件全集合扫描」护栏，请求才会真正发出。
    await a.listRequirements({ state: '已关闭' })
    const call = rest.calls.find(c => c.url.includes('/_apis/wit/wiql'))!
    expect(call.method).toBe('POST')
    expect(call.url).toContain('api-version=4.1')
    expect(call.url).toContain('/WN_HIS/')
    expect(call.headers['Content-Type']).toContain('application/json')
  })

  it('project 走 WHERE [System.TeamProject]（与多项目 OR 统一，不另作顶层参数）', async () => {
    const a = makeAdapter([])
    await a.listRequirements({ project: 'EDIS' })
    const q = wiqlQuery()!
    expect(q).toContain("[System.TeamProject] = 'EDIS'")
    // 不得成为请求体的顶层字段（否则会与 WHERE 叠加 scope 收窄查询）。
    const body = rest.calls.find(c => c.url.includes('/_apis/wit/wiql'))!.body as Record<string, unknown>
    expect(body['project']).toBeUndefined()
    expect(Object.keys(body).sort()).toEqual(['query'])
  })

  it('护栏1：WIQL 空结果归一为空列表（ok=true，不是失败）', async () => {
    // REST 真实语义：0 命中返回 `{workItems: []}`（不再有 tfs-mcp 的伪错）。
    const a = makeAdapter([])
    const res = await a.listRequirements({ keyword: '不存在的需求' })
    expect(res.ok).toBe(true)
    expect(res.items).toEqual([])
    expect(res.total).toBe(0)
    expect(res.reason).toBeUndefined()
  })

  it('护栏1 判定函数：只认空结果特征，不误吞真实错误', () => {
    expect(isWiqlEmptyResult('items is not iterable (cannot read property null)')).toBe(true)
    expect(isWiqlEmptyResult('The expand parameter can not be used with the fields parameter.')).toBe(false)
    expect(isWiqlEmptyResult('Failed request: (414)')).toBe(false)
  })

  it('护栏2：deferred 扫描响应超阈值即熔断（路径 B 体积保护），给出收窄条件建议', async () => {
    // 非 ASCII keyword 触发路径 B（deferred，无法下推 WIQL）；mega 父工作项原始响应含 7316
    // relations、远超 4096 阈值 → 第一批取字段即熔断。新架构 queryWiql 不返回 relations，故熔断
    // 只作用于取字段的 deferred 扫描，并以「部分结果 ok=true + reason」呈现而非整体失败。
    const a = makeAdapter([makeMegaParent(7316)], { maxResponseBytes: 4096 })
    const res = await a.listRequirements({ keyword: '框架' })
    expect(res.ok).toBe(true)
    expect(res.reason).toContain('熔断')
    expect(res.reason).toContain('收窄')
  })

  it('默认阈值 16MB（真实实测标定：不得把 201 条常规列表误熔断）', () => {
    expect(DEFAULT_MAX_RESPONSE_BYTES).toBe(16 * 1024 * 1024)
    // 实测一次真实常规列表 = 201 条 / 2,983,788 字节（≈15KB/条），2MB 阈值会误熔断，故上调。
    const realListBytes = 2983788
    expect(realListBytes).toBeLessThan(DEFAULT_MAX_RESPONSE_BYTES)
    // 约 1000 条常规列表仍在阈值内（16MB / 15KB ≈ 1000）
    expect(realListBytes * 5).toBeLessThan(DEFAULT_MAX_RESPONSE_BYTES)
  })

  it('分页只取当前页 ids 并回报 total（路径 A：WIQL 无分页，服务端只取当前页字段）', async () => {
    const items = [1, 2, 3, 4, 5].map(id => ({ id, title: `T${id}` }))
    const a = makeAdapter(items)
    // state 仅用于通过 D2 护栏；stub 的 WIQL 不真正过滤，hits=5，路径 A 只对当前页 ids=2,3 取字段。
    const res = await a.listRequirements({ top: 2, skip: 1, state: '已关闭' })
    expect(res.total).toBe(5)
    expect(res.items.map(i => i.id)).toEqual([2, 3])
  })

  it('assignedTo 用 CONTAINS（实测返回 `xbp（徐保平) <WINNING\\xbp>` 显示串，精确等于永不命中）', async () => {
    const a = makeAdapter([])
    // 用 ASCII 账号名：实测中文值进 CONTAINS 会 414（见 T039-C），此处测的是"用 CONTAINS 而非 ="
    await a.listRequirements({ assignedTo: ['zhangbo3'] })
    const q = wiqlQuery()!
    expect(q).toContain("[System.AssignedTo] CONTAINS 'zhangbo3'")
    expect(q).not.toContain('[System.AssignedTo] = ')
  })

  it('真实失败（非空结果）仍返回 ok=false + 擦除凭据的原因', async () => {
    const a = makeAdapter([], { wiqlStatus: 414, failWiql: 'Failed request: (414)' })
    // state 让请求通过 D2 护栏真正发出，WIQL 端点才会回放 414。
    const res = await a.listRequirements({ state: '已关闭' })
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('414')
  })
})

// ───────────────────────── T039-C CONTAINS 的 414 约束（真实 TFS 实测） ─────────────────────────

describe('T039-C 第三道护栏：CONTAINS 含非 ASCII ⇒ 414（真实 TFS 实测）', () => {
  it('中文 keyword 不下推 WIQL，改为客户端侧过滤（否则必 414）', async () => {
    const a = makeAdapter([
      { id: 2, title: '基础框架搭建', assignedTo: 'xbp', changedDate: 'x' },
      { id: 3, title: '登录失败', assignedTo: 'xbp', changedDate: 'x' },
    ])
    const res = await a.listRequirements({ keyword: '框架' })
    const q = wiqlQuery()!
    expect(q).not.toContain('CONTAINS')
    expect(res.ok).toBe(true)
    // 客户端侧生效：只留标题包含「框架」的那条
    expect(res.items.map(i => i.id)).toEqual([2])
    expect(res.total).toBe(1)
  })

  it('ASCII keyword 仍下推 CONTAINS（实测可用，服务端过滤更省流量）', async () => {
    const a = makeAdapter([])
    await a.listRequirements({ keyword: 'MEMORY' })
    expect(wiqlQuery()!).toContain("[System.Title] CONTAINS 'MEMORY'")
  })

  it('多值 assignedTo 用 OR 连接（问题 3：同字段内 OR）', async () => {
    const a = makeAdapter([])
    await a.listRequirements({ assignedTo: ['zhangbo3', 'ysh'] })
    const q = wiqlQuery()!
    expect(q).toContain("[System.AssignedTo] CONTAINS 'zhangbo3'")
    expect(q).toContain("[System.AssignedTo] CONTAINS 'ysh'")
    expect(q).toContain(' OR ')
  })

  it('遗留单值 assignedTo（HTTP body 传字符串）不按字符拆成多个 CONTAINS', async () => {
    // 契约类型是 `string[]`，但路由 body 是外部输入，历史上出现过传字符串的情形；
    // 适配层必须把它当**一个**值，否则会生成 `CONTAINS 'z' AND 'h' AND …`（曾真实发生）。
    const a = makeAdapter([])
    await a.listRequirements({ assignedTo: 'zhangbo3' as unknown as string[] })
    const q = wiqlQuery()!
    expect(q).toContain("[System.AssignedTo] CONTAINS 'zhangbo3'")
    expect(q).not.toContain("CONTAINS 'z'")
  })

  it('中文 assignedTo 不下推，客户端侧按显示串包含匹配', async () => {
    const a = makeAdapter([
      { id: 2, title: 'A', assignedTo: 'ysh（杨善辉） <WINNING\\ysh>' },
      { id: 3, title: 'B', assignedTo: 'xbp（徐保平) <WINNING\\xbp>' },
    ])
    const res = await a.listRequirements({ assignedTo: ['杨善辉'] })
    expect(wiqlQuery()!).not.toContain('CONTAINS')
    expect(res.items.map(i => i.id)).toEqual([2])
  })

  it('state 用等值 `=`，中文照常下推（实测中文等值返回正常）', async () => {
    const a = makeAdapter([])
    await a.listRequirements({ state: '已关闭' })
    expect(wiqlQuery()!).toContain("[System.State] = '已关闭'")
  })

  it('isAsciiSafe：只放行可打印 ASCII（判定依据为实测 414）', () => {
    expect(isAsciiSafe('MEMORY')).toBe(true)
    expect(isAsciiSafe('zhangbo3')).toBe(true)
    expect(isAsciiSafe('框架')).toBe(false)
    expect(isAsciiSafe('杨善辉')).toBe(false)
    expect(isAsciiSafe('')).toBe(true)
  })
})

// ───────────────────────── T054 变更集关联回写契约（沙盘） ─────────────────────────

describe('T054 TFVC 变更集关联回写契约（REST 端点实测：/_apis/tfvc/changesets）', () => {
  const changesetMeta = {
    changesetId: 12345,
    // REST 真实形状：author 是 `{displayName, uniqueName}` 对象（adapter 拍平回旧语义）。
    author: { displayName: 'zhangbo3（张波）', uniqueName: 'WINNING\\zhangbo3' },
    createdDate: '2026-09-10T02:00:00Z',
    comment: '修复 C13 导入',
  }

  /** 构造只读 TFVC 桩（写路径走 PATCH，返回工作项形状）。 */
  function makeTfvcAdapter(opts: { failChangeset?: boolean } = {}): TfsAdapter {
    const fs = createMemFs()
    rest = makeFakeRest()
    if (opts.failChangeset) {
      rest.setRoute('GET /_apis/tfvc/changesets/', { status: 404, body: 'Sorry, Page Not Found' })
    } else {
      rest.setRoute('GET /_apis/tfvc/changesets/', changesetMeta)
    }
    rest.setRoute('PATCH /_apis/wit/workitems/7', { id: 7, rev: 2, fields: {} })
    return new TfsAdapter({
      rest: rest.config,
      writeGuard: new WriteGuard(new AuditLog('/mem/audit', fs)),
      collection: 'WN_HIS',
      profileLabel: 'winning',
    })
  }

  /** 取写请求（PATCH）的 json-patch body。 */
  function patchBody(): Array<Record<string, unknown>> {
    const call = rest.calls.find(c => c.method === 'PATCH')
    return (call?.body ?? []) as Array<Record<string, unknown>>
  }

  it('未确认即拒（门禁2），且不发出任何写请求', async () => {
    const a = makeTfvcAdapter()
    const r = await a.linkChangeset(7, 12345, 'WN_HIS', false)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('确认')
    expect(rest.calls.filter(c => c.method === 'PATCH')).toHaveLength(0)
  })

  it('确认后先读变更集元数据，再以结构化评论回写', async () => {
    const a = makeTfvcAdapter()
    const r = await a.linkChangeset(7, 12345, 'WN_HIS', true)
    expect(r.ok).toBe(true)
    // 只读：GET /_apis/tfvc/changesets/12345（api-version=4.1）
    const read = rest.calls.find(c => c.method === 'GET' && c.url.includes('/_apis/tfvc/changesets/12345'))!
    expect(read.url).toContain('api-version=4.1')
    // 写：PATCH System.History 携带结构化评论
    const patch = patchBody()
    expect(patch[0]).toMatchObject({ op: 'add', path: '/fields/System.History' })
    const comment = String(patch[0]!['value'])
    expect(comment).toContain('C12345')
    expect(comment).toContain('zhangbo3（张波）')
    expect(comment).toContain('修复 C13 导入')
  })

  it('元数据读取失败 → 降级为精简评论，仍带上变更集号（不阻断关联）', async () => {
    const a = makeTfvcAdapter({ failChangeset: true })
    const r = await a.linkChangeset(7, 12345, 'WN_HIS', true)
    expect(r.ok).toBe(true)
    expect(String(patchBody()[0]!['value'])).toBe('[DSH] 关联 TFVC 变更集 C12345')
  })

  it('幂等：同一工作项重复关联同一变更集被门禁3拦截', async () => {
    const a = makeTfvcAdapter()
    expect((await a.linkChangeset(7, 12345, 'WN_HIS', true)).ok).toBe(true)
    const second = await a.linkChangeset(7, 12345, 'WN_HIS', true)
    expect(second.ok).toBe(false)
    expect(second.reason).toContain('幂等')
  })

  it('不同变更集不被误判为重复', async () => {
    const a = makeTfvcAdapter()
    expect((await a.linkChangeset(7, 12345, 'WN_HIS', true)).ok).toBe(true)
    expect((await a.linkChangeset(7, 22222, 'WN_HIS', true)).ok).toBe(true)
  })

  it('listChangesets 只发 schema 允许的查询参数（additionalProperties:false 语义）', async () => {
    rest = makeFakeRest()
    rest.setRoute('GET /_apis/tfvc/changesets?', { value: [] })
    const a = new TfsAdapter({
      rest: rest.config,
      writeGuard: new WriteGuard(new AuditLog('/mem/audit', createMemFs())),
      collection: 'WN_HIS',
      profileLabel: 'winning',
    })
    await a.listChangesets({ top: 5, author: 'zhangbo3', itemPath: '$/PEIS', fromId: 100 })
    const call = rest.calls.find(c => c.url.includes('/_apis/tfvc/changesets?'))!
    const q = new URL(call.url).searchParams
    expect(q.get('$top')).toBe('5')
    expect(q.get('author')).toBe('zhangbo3')
    expect(q.get('itemPath')).toBe('$/PEIS')
    expect(q.get('fromId')).toBe('100')
    // skip 未传 ⇒ 不得凭空出现在查询串里
    expect(q.get('$skip')).toBeNull()
  })

  it('getWorkItemCommits：客户端过滤关联工作项的变更集，不发不存在的 searchCriteria', async () => {
    rest = makeFakeRest()
    rest.setRoute('GET /_apis/tfvc/changesets?', {
      value: [
        { changesetId: 12, workItems: [{ id: 7, url: 'http://x/_apis/wit/workItems/7' }] },
        { changesetId: 11, workItems: [{ id: 8, url: 'http://x/_apis/wit/workItems/8' }] },
      ],
    })
    const a = new TfsAdapter({
      rest: rest.config,
      writeGuard: new WriteGuard(new AuditLog('/mem/audit', createMemFs())),
      collection: 'WN_HIS',
      profileLabel: 'winning',
    })
    const out = (await a.getWorkItemCommits('7')) as {
      workItemId: number
      scannedChangesets: number
      total: number
      changesets: Array<{ changesetId: number }>
    }
    const call = rest.calls.find(c => c.url.includes('/_apis/tfvc/changesets?'))!
    /**
     * TFS 2018 的 changesets 端点**没有** `searchCriteria.workItemId`：早先发这个未知维度时
     * 服务端静默忽略并返回集合里最新的变更集，"工作项关联提交"列出的是别人的提交。
     * 现在改为 `includeWorkItems=true` + 客户端过滤（A14）。
     */
    expect(call.url).not.toContain('workItemId')
    expect(call.url).toContain('includeWorkItems=true')
    expect(out.workItemId).toBe(7)
    expect(out.scannedChangesets).toBe(2)
    expect(out.total).toBe(1)
    expect(out.changesets.map(c => c.changesetId)).toEqual([12])
  })
})

describe('safeSerializedBytes', () => {
  it('循环引用/不可序列化不抛，退化为 0', () => {
    const cyclic: Record<string, unknown> = {}
    cyclic['self'] = cyclic
    expect(safeSerializedBytes(cyclic)).toBe(0)
    expect(safeSerializedBytes(null)).toBe(0)
    expect(safeSerializedBytes(undefined)).toBe(0)
  })
})

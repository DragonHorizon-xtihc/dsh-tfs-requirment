/**
 * rest-client 单测（REST 化改造，2026-09-19）。
 *
 * 全部断言锚定 **2026-09-19 真实 TFS 探针实测**（证据：
 * `docs/plans/2026-09-19-p0-probe-and-three-questions.md`），不是拍脑袋的契约：
 *   - 版本串：`4.1` 主线 / `4.1-preview` 仅 states / `connectionData` 不带 api-version；
 *   - rev 冲突：**412** + `VS403351`（不是 409）；
 *   - 404 响应体是纯文本 `Sorry, Page Not Found`（不是 JSON）；
 *   - 身份只在 `providerDisplayName` / `authorizedUser.properties.Account.$value`。
 */
import { describe, expect, it } from 'vitest'
import {
  API_VERSION,
  API_VERSION_PREVIEW,
  RestError,
  basicAuth,
  buildPatchOps,
  createRestRead,
  createRestWrite,
  extractActualRev,
  isNotFound,
  isRevConflict,
  isUnauthorized,
  parseErrorBody,
  type RestConfig,
} from '../src/tfs/rest-client.js'

/** 构造带记录功能的 fetch 桩（返回预设状态/体/响应头，并记录收到的请求）。 */
function makeFetch(responses: Array<{ status: number; body: string; headers?: Record<string, string> }>) {
  const calls: Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> = []
  const impl = (async (url: string | URL, init?: RequestInit) => {
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | undefined
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = String(v)
    calls.push({
      url: String(url),
      method: String(init?.method ?? 'GET'),
      headers,
      body: typeof init?.body === 'string' ? init.body : undefined,
    })
    const r = responses.shift() ?? { status: 200, body: '{}' }
    return {
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      text: async () => r.body,
      // 桩只实现被断言的字段；缺 headers 时让调用方按「无游标」处理
      // （`RestRequestInit.captureHeaders` 的参数类型允许 undefined）。
      ...(r.headers ? { headers: new Headers(r.headers) } : {}),
    } as Response
  }) as typeof fetch
  return {
    impl,
    calls,
    /** 取全部请求记录（分页断言需要比对第 N 条）。 */
    all(): Array<{ url: string; method: string; headers: Record<string, string>; body?: string }> {
      return calls
    },
    /**
     * 取第 N 条（默认首条）记录。
     *
     * 为什么需要：`tsconfig.tests.json` 开启了 `noUncheckedIndexedAccess`，
     * `first()` 的类型是 `T | undefined`，直接 `.url` 会报 TS2532。
     * 测试里"首条必然存在"是**前置条件**（断言失败本身就说明桩没被调用），
     * 故用本存取器把该前置条件显式化，而不是在每个断言点写 `!`。
     */
    first(n = 0) {
      const c = calls[n]
      if (!c) throw new Error(`期望至少 ${n + 1} 次请求，实际 ${calls.length} 次`)
      return c
    },
  }
}

const CFG: RestConfig = {
  url: 'http://tfs.example:8080/tfs',
  collection: 'WN_HIS',
  pat: 'PAT-SECRET-XYZ',
}

describe('basicAuth', () => {
  it('是 base64(":PAT") 形态（实测 TFS 2018 只认这个）', () => {
    expect(basicAuth('abc')).toBe(`Basic ${Buffer.from(':abc', 'utf8').toString('base64')}`)
  })
})

describe('parseErrorBody（错误归一）', () => {
  it('rev 冲突：412 + VS403351（实测原文）', () => {
    const raw = '{"$id":"1","innerException":null,"message":"VS403351: Test Operation for path /rev failed, value 8 was not equal to test value 999999.","typeName":"Microsoft.VisualStudio.Services.WebApi.Patch.TestPatchOperationFailedException, Microsoft.VisualStudio.Services.WebApi"}'
    const e = parseErrorBody(412, raw)
    expect(e.status).toBe(412)
    expect(e.code).toBe('VS403351')
    expect(e.message).toContain('HTTP 412')
    expect(e.message).toContain('value 8 was not equal to test value 999999')
  })

  it('字段不存在：400 + TF51535（实测原文）', () => {
    const raw = '{"$id":"1","innerException":null,"message":"TF51535: 找不到字段 No.Such.Field.XYZ。","typeName":"Microsoft.TeamFoundation.WorkItemTracking.Server.Metadata.WorkItemTrackingFieldDefinitionDoesNotExistException"}'
    const e = parseErrorBody(400, raw)
    expect(e.status).toBe(400)
    expect(e.code).toBe('TF51535')
    expect(e.message).toContain('找不到字段')
  })

  it('404 纯文本不抛二次错（实测体 = Sorry, Page Not Found）', () => {
    const e = parseErrorBody(404, 'Sorry, Page Not Found')
    expect(e.status).toBe(404)
    expect(e.message).toContain('Sorry, Page Not Found')
  })

  it('错误体里的 PAT 会被擦除', () => {
    const e = parseErrorBody(401, 'denied for pat=PAT-SECRET-XYZ')
    expect(e.message).not.toContain('PAT-SECRET-XYZ')
  })
})

describe('extractActualRev / isRevConflict / isNotFound / isUnauthorized', () => {
  it('从冲突消息抽实际 rev（实测消息形态）', () => {
    expect(extractActualRev('VS403351: Test Operation for path /rev failed, value 8 was not equal to test value 999999.')).toBe(8)
    expect(extractActualRev('无关消息')).toBeUndefined()
  })

  it('判定函数分支正确', () => {
    const rev = parseErrorBody(412, '{"message":"VS403351: Test Operation for path /rev failed, value 8 was not equal to test value 999999."}')
    const nf = parseErrorBody(404, 'Sorry, Page Not Found')
    const proj = parseErrorBody(400, '{"message":"在层次结构中找不到指定的项目。 该错误是由\\"X\\"引起的。"}')
    const un = parseErrorBody(401, 'denied')
    expect(isRevConflict(rev)).toBe(true)
    expect(isNotFound(nf)).toBe(true)
    expect(isNotFound(proj)).toBe(true) // 400 找不到项目也归"不存在"
    expect(isUnauthorized(un)).toBe(true)
    expect(isRevConflict(nf)).toBe(false)
  })
})

describe('createRestRead', () => {
  it('listProjects：拼 _apis/projects + 4.1 + 分页，Basic 头正确', async () => {
    const { impl, first } = makeFetch([{ status: 200, body: '{"value":[{"id":"a","name":"体检管理"},{"id":"b","name":"ACIS"}]}' }])
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    const rows = await read.listProjects()
    expect(rows.map(r => r.name)).toEqual(['体检管理', 'ACIS'])
    // 分页取代一次性 $top=1000：TFS 超过 $top 时只在响应头回 x-ms-continuationtoken，
    // 不跟随游标就会把截断结果当全集（A15）。
    expect(first().url).toBe(`http://tfs.example:8080/tfs/WN_HIS/_apis/projects?$top=500&$skip=0&api-version=${API_VERSION}`)
    expect(first().headers['Authorization']).toBe(basicAuth('PAT-SECRET-XYZ'))
  })

  it('listProjects：带游标翻页，直到服务端不再回游标', async () => {
    const { impl, all } = makeFetch([
      { status: 200, body: '{"value":[{"id":"a","name":"A"}]}', headers: { 'x-ms-continuationtoken': 'tok-1' } },
      { status: 200, body: '{"value":[{"id":"b","name":"B"}]}' },
    ])
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    const rows = await read.listProjects()
    expect(rows.map(r => r.name)).toEqual(['A', 'B'])
    // 第二页必须带上服务端给的游标（游标走请求头，不是查询串）。
    expect(all()[1]!.headers['x-ms-continuationtoken']).toBe('tok-1')
    expect(all()[1]!.url).toContain('$skip=1')
  })

  it('queryWiql：POST + 0 命中返回空数组（REST 无 tfs-mcp 的伪错）', async () => {
    const { impl, first } = makeFetch([{ status: 200, body: '{"workItems":[]}' }])
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    const rows = await read.queryWiql('SELECT [System.Id] FROM WorkItems')
    expect(rows).toEqual([])
    expect(first().method).toBe('POST')
    expect(first().url).toBe(`http://tfs.example:8080/tfs/WN_HIS/_apis/wit/wiql?api-version=${API_VERSION}`)
    expect(JSON.parse(first().body ?? '{}')).toEqual({ query: 'SELECT [System.Id] FROM WorkItems' })
  })

  it('listStates：用 4.1-preview（4.1 会 400 VssInvalidPreviewVersionException）', async () => {
    const { impl, first } = makeFetch([{ status: 200, body: '{"value":[{"name":"活动"},{"name":"已关闭"}]}' }])
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    const states = await read.listStates('体检管理', '需求')
    expect(states).toEqual(['活动', '已关闭'])
    expect(first().url).toContain(encodeURIComponent('体检管理'))
    expect(first().url).toContain(encodeURIComponent('需求'))
    expect(first().url).toContain(`api-version=${API_VERSION_PREVIEW}`)
  })

  it('listWorkItemTypes：项目名 URL 编码（中文项目名）', async () => {
    const { impl, first } = makeFetch([{ status: 200, body: '{"value":[{"name":"需求"},{"name":"任务"}]}' }])
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    const types = await read.listWorkItemTypes('体检管理')
    expect(types).toEqual(['需求', '任务'])
    expect(first().url).toBe(`http://tfs.example:8080/tfs/WN_HIS/${encodeURIComponent('体检管理')}/_apis/wit/workitemtypes?api-version=${API_VERSION}`)
  })

  it('whoAmI：裸调用（不带 api-version），身份取 providerDisplayName + Account.$value（实测形状）', async () => {
    const body = JSON.stringify({
      authenticatedUser: {
        id: '3ab5ed17-8763-4211-b092-5ef23d236c5d',
        providerDisplayName: 'zhangbo3(张波)',
        // 实测：displayName / uniqueName 是 undefined，根本没有这两个字段 —— 不 mock 它们。
      },
      authorizedUser: {
        providerDisplayName: 'zhangbo3(张波)',
        properties: { $type: 'System.String', Account: { $type: 'System.String', $value: 'zhangbo3' } },
      },
      instanceId: 'f5481b4a-9f84-4363-9ed9-03adb80b826b',
    })
    const { impl, first } = makeFetch([{ status: 200, body }])
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    const me = await read.whoAmI()
    expect(me.account).toBe('zhangbo3')
    expect(me.displayName).toBe('zhangbo3(张波)')
    expect(me.instanceId).toBe('f5481b4a-9f84-4363-9ed9-03adb80b826b')
    expect(first().url).toBe('http://tfs.example:8080/tfs/WN_HIS/_apis/connectionData')
    expect(first().url).not.toContain('api-version')
  })

  it('HTTP 错误抛 RestError 且不含 PAT', async () => {
    const { impl } = makeFetch([{ status: 404, body: 'Sorry, Page Not Found' }])
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    await expect(read.listProjects()).rejects.toMatchObject({ status: 404 })
    try {
      await createRestRead({ ...CFG, fetchImpl: impl }).listProjects()
    } catch (e) {
      expect(String(e)).not.toContain('PAT-SECRET-XYZ')
    }
  })

  it('fetch 抛错（网络层）归一为 status=0 的 RestError', async () => {
    const impl = (async () => {
      throw new Error(`Unable to connect to ${CFG.url}?pat=PAT-SECRET-XYZ`)
    }) as typeof fetch
    const read = createRestRead({ ...CFG, fetchImpl: impl })
    await expect(read.listProjects()).rejects.toMatchObject({ status: 0 })
    try {
      await read.listProjects()
    } catch (e) {
      expect((e as Error).message).not.toContain('PAT-SECRET-XYZ')
    }
  })
})

describe('createRestWrite', () => {
  it('updateWorkItem：PATCH + json-patch+json + 4.1（7.1 会 404）', async () => {
    const { impl, first } = makeFetch([{ status: 200, body: '{"id":1980540,"rev":9}' }])
    const write = createRestWrite({ ...CFG, fetchImpl: impl })
    const out = await write.updateWorkItem(1980540, [{ op: 'add', path: '/fields/System.History', value: 'x' }], 8)
    expect(out).toMatchObject({ id: 1980540, rev: 9 })
    expect(first().method).toBe('PATCH')
    expect(first().url).toBe(`http://tfs.example:8080/tfs/WN_HIS/_apis/wit/workitems/1980540?api-version=${API_VERSION}`)
    expect(first().headers['Content-Type']).toBe('application/json-patch+json')
    const body = JSON.parse(first().body ?? '[]') as Array<{ op: string; path: string; value: unknown }>
    expect(body[0]).toEqual({ op: 'test', path: '/rev', value: 8 })
    expect(body[1]?.path).toBe('/fields/System.History')
  })

  it('rev 冲突抛 RestError(412, VS403351)（实测码）', async () => {
    const { impl } = makeFetch([{
      status: 412,
      body: '{"$id":"1","message":"VS403351: Test Operation for path /rev failed, value 8 was not equal to test value 999999.","typeName":"Microsoft.VisualStudio.Services.WebApi.Patch.TestPatchOperationFailedException"}',
    }])
    const write = createRestWrite({ ...CFG, fetchImpl: impl })
    try {
      await write.updateWorkItem(1, [{ op: 'add', path: '/fields/System.History', value: 'x' }], 999999)
      throw new Error('应当抛错')
    } catch (e) {
      expect(isRevConflict(e)).toBe(true)
      expect((e as RestError).code).toBe('VS403351')
      expect(extractActualRev((e as RestError).message)).toBe(8)
    }
  })

  it('buildPatchOps：rev 未知时不插 test（服务端最后写入者胜）', () => {
    const ops = [{ op: 'replace' as const, path: '/fields/System.State', value: '活动' }]
    expect(buildPatchOps(ops)).toEqual(ops)
    expect(buildPatchOps(ops, 0)).toEqual(0 ? [] : ops) // rev=0 视为未知
    const withRev = buildPatchOps(ops, 3)
    expect(withRev[0]).toEqual({ op: 'test', path: '/rev', value: 3 })
    expect(withRev[1]).toBe(ops[0])
  })

  it('createWorkItem：POST /{project}/_apis/wit/workitems/${type}（项目作用域，官方形态）', async () => {
    const { impl, first } = makeFetch([{ status: 200, body: '{"id":3001,"rev":1}' }])
    const write = createRestWrite({ ...CFG, fetchImpl: impl })
    await write.createWorkItem('体检管理', '任务', [{ op: 'add', path: '/fields/System.Title', value: 't' }])
    expect(first().method).toBe('POST')
    expect(first().url).toBe(`http://tfs.example:8080/tfs/${encodeURIComponent('体检管理')}/_apis/wit/workitems/$${encodeURIComponent('任务')}?api-version=${API_VERSION}`)
    expect(first().headers['Content-Type']).toBe('application/json-patch+json')
  })
})

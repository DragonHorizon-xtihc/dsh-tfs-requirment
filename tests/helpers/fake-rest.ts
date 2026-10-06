/**
 * TFS REST fetch 测试桩（REST 化改造配套）。
 *
 * 为什么需要：REST 化后 adapter 的数据通道是 `fetch`（`rest-client.ts`），
 * 旧 `fake-tools`（`TfsTools.execute` 桩）不再被主路径消费。本桩按 **URL 路由** 返回预设体，
 * 让既有测试文件用最小改动迁到 REST 桩：
 *
 * ```ts
 * const rest = makeFakeRest({
 *   '_apis/projects': { value: [{ id: '1', name: 'EAHis' }] },
 *   '_apis/wit/wiql': { workItems: [{ id: 2 }] },
 * })
 * new TfsAdapter({ rest: rest.config, writeGuard: guard, ... })
 * ```
 *
 * 路由键为 **URL 路径子串**（命中多条时**取最长键 = 最特异**，与注册顺序无关）；
 * 键可加 `"METHOD "` 前缀限定方法（如同 URL 的读/写分流）；值为响应体（对象→JSON 序列化）或
 * `{ status, body }` 指定非 200。所有请求（url/method/headers/body）记录进 `calls`。
 */
import type { RestConfig } from '../../src/tfs/rest-client.js'

/** 一次被记录的 REST 请求。 */
export interface FakeRestCall {
  url: string
  method: string
  headers: Record<string, string>
  /** JSON 解析后的请求体（非 JSON 体则为原始字符串）。 */
  body?: unknown
}

/** 动态路由函数收到的本次请求信息。 */
export interface DynamicRouteRequest {
  url: string
  method: string
  headers: Record<string, string>
  body?: unknown
  /** 已解析的 URL query（如 `ids=2,3` → query.get('ids')）。 */
  query: URLSearchParams
}

/**
 * 路由表：路径子串 → 响应体、{status, body}、{raw}，或**动态函数**
 * （`(req: DynamicRouteRequest) => 响应体 | {status, body}`，用于返回内容随 query 变化的端点）。
 */
export type FakeRestRoutes = Record<
  string,
  | unknown
  | { status: number; body: unknown }
  | { raw: string | Uint8Array; contentType?: string; status?: number }
  | ((req: DynamicRouteRequest) => unknown)
>

export interface FakeRest {
  /** 传给 TfsAdapter 的 `rest` 配置（fetchImpl 已注入桩）。 */
  config: RestConfig
  /** 全部请求记录。 */
  calls: FakeRestCall[]
  /** 运行期改路由（个别用例需要中途换行为）。 */
  setRoute(key: string, res: unknown | { status: number; body: unknown }): void
}

function isFailure(res: unknown): res is { status: number; body: unknown } {
  return (
    typeof res === 'object' && res !== null && 'status' in res && 'body' in res &&
    typeof (res as { status: unknown }).status === 'number'
  )
}

/**
 * 从路由项取响应头。
 *
 * 路由项可以是裸 body，也可以是 `{ status, body, headers }`。`headers` 用于回放服务端
 * 的续页游标（`x-ms-continuationtoken`），其余头一律视为不存在。
 *
 * @param res - 路由项。
 * @param name - 请求方要的头名（大小写不敏感）。
 * @returns 头值；未提供时为 `null`（与 `Headers.get` 一致）。
 */
function routeHeader(res: unknown, name: string): string | null {
  if (typeof res !== 'object' || res === null || !('headers' in res)) return null
  const map = (res as { headers?: unknown }).headers
  if (typeof map !== 'object' || map === null) return null
  const wanted = name.toLowerCase()
  for (const [k, v] of Object.entries(map as Record<string, unknown>)) {
    if (k.toLowerCase() === wanted) return String(v)
  }
  return null
}

/**
 * 构造 REST fetch 桩。
 * @param routes 路由表（按 URL 子串匹配，多条命中取最长键）。
 * @param opts.collection 配置里的集合名（默认 WN_HIS，与既有测试一致）。
 */
export function makeFakeRest(routes: FakeRestRoutes = {}, opts: { collection?: string } = {}): FakeRest {
  const calls: FakeRestCall[] = []
  const table = new Map<string, unknown | { status: number; body: unknown }>(Object.entries(routes))

  const impl = (async (url: string | URL, init?: RequestInit) => {
    const urlStr = String(url)
    const headers: Record<string, string> = {}
    const h = init?.headers as Record<string, string> | undefined
    if (h) for (const [k, v] of Object.entries(h)) headers[k] = String(v)
    const rawBody = typeof init?.body === 'string' ? init.body : undefined
    let parsedBody: unknown
    if (rawBody !== undefined) {
      try {
        parsedBody = JSON.parse(rawBody)
      } catch {
        parsedBody = rawBody
      }
    }
    calls.push({ url: urlStr, method: String(init?.method ?? 'GET'), headers, body: parsedBody })

    // 对**完整 URL** 做子串匹配，命中多条时取**最长键**（最特异）。
    //
    // 为什么不是"先注册先命中"：路由键之间存在前缀包含关系，例如
    //   `_apis/wit/workitemtypes`（列表）  ⊂  `_apis/wit/workitemtypes/需求/states`（状态）
    // 若按注册序取首个命中，`.../states` 请求会被 `workitemtypes` 键截胡，
    // 拿到类型列表的响应体 → 测试出现"看起来自洽但其实测错了对象"的假绿/假红。
    // 最长键优先让每条路由都要求"最特异匹配"，不需要调用方关心注册顺序。
    //
    // ## method 限定（可选）
    //
    // 读写共用同一 URL（`GET /_apis/wit/workitems/200` 读、`PATCH` 同一 URL 写），
    // 纯 URL 路由无法区分二者。故键可写成 `"PATCH /_apis/wit/workitems/200"`：
    // 前缀是 HTTP 方法（后跟空格），仅当请求方法匹配时才参与竞争。
    // 带 method 的键天然更长 ⇒ 同 URL 下优先于无限定的键命中。
    const method = String(init?.method ?? 'GET').toUpperCase()
    let hit: { key: string; res: unknown } | undefined
    for (const [key, res] of table) {
      const sp = key.indexOf(' ')
      const keyMethod = sp > 0 && !key.startsWith('/') ? key.slice(0, sp).toUpperCase() : undefined
      const keyUrl = keyMethod ? key.slice(sp + 1) : key
      if (keyMethod && keyMethod !== method) continue
      if (!urlStr.includes(keyUrl)) continue
      if (!hit || key.length > hit.key.length) hit = { key, res }
    }
    if (hit) {
      let res: unknown = hit.res
      // 动态路由：值为函数时按本次请求（含解析后的 query）现算响应体，
      // 用于 workitems 这类「返回内容取决于 URL ids 参数」的端点。
      if (typeof res === 'function') {
        const parsedUrl = new URL(urlStr, 'http://tfs.local')
        res = (res as (r: DynamicRouteRequest) => unknown)({
          url: urlStr,
          method,
          headers,
          body: parsedBody,
          query: parsedUrl.searchParams,
        })
      }
      // 二进制/原始字节响应（附件、TFVC 文件下载测试用）：同时提供 text/arrayBuffer/json。
      if (typeof res === 'object' && res !== null && 'raw' in res) {
        const r = res as { raw: string | Uint8Array; contentType?: string; status?: number }
        const buf = typeof r.raw === 'string' ? Buffer.from(r.raw, 'utf8') : Buffer.from(r.raw)
        const status = r.status ?? 200
        return {
          ok: status >= 200 && status < 300,
          status,
          headers: { get: (k: string) => (k.toLowerCase() === 'content-type' ? r.contentType ?? 'application/octet-stream' : null) },
          text: async () => buf.toString('utf8'),
          arrayBuffer: async () => buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength),
          json: async () => JSON.parse(buf.toString('utf8')),
        } as unknown as Response
      }
      if (isFailure(res)) {
        const body = typeof res.body === 'string' ? res.body : JSON.stringify(res.body)
        // 路由项也可写成 `{ status: 200, body, headers }` 来回放"成功但带续页游标"的响应。
        return {
          ok: res.status >= 200 && res.status < 300,
          status: res.status,
          headers: { get: (k: string) => routeHeader(res, k) },
          text: async () => body,
        } as Response
      }
      const body = typeof res === 'string' ? res : JSON.stringify(res)
      return {
        ok: true,
        status: 200,
        // 列表端点的续页游标（`x-ms-continuationtoken`）由路由项的 `headers` 给出，
        // 用来验证"跟随游标取全量"而不是"把前 N 条当全集"。
        headers: { get: (k: string) => routeHeader(res, k) },
        text: async () => body,
      } as Response
    }
    // 未命中：404 纯文本（复刻 TFS 真实 404 形态，防止测试对未实现路径"自洽地通过"）。
    return { ok: false, status: 404, text: async () => 'Sorry, Page Not Found' } as Response
  }) as typeof fetch

  return {
    config: {
      url: 'http://tfs.example:8080/tfs',
      collection: opts.collection ?? 'WN_HIS',
      pat: 'PAT-TEST',
      fetchImpl: impl,
    },
    calls,
    setRoute: (key, res) => table.set(key, res),
  }
}

/** 标准工作项 fields 形状（REST `/_apis/wit/workitems` 返回 `{id, rev, fields}`）。 */
export function restWorkItem(
  id: number,
  fields: Record<string, unknown>,
  rev = 1,
): Record<string, unknown> {
  return { id, rev, fields }
}

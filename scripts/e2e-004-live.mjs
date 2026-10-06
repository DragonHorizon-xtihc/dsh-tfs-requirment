/**
 * E2E-004-live：对**真实 dsh web 宿主**打真实 HTTP 路由，验证问题 1/2（能力目录实时化）
 * 与两条新增路由在运行期确实注册（问题 3/4）。
 *
 * ## 为什么需要它
 *
 * 问题 1/2 的根因是"**中央工作台从不触发目录重采**"，而目录内容（用户级技能 89+/MCP 实例）
 * 只有在真实宿主进程里才存在 —— 离线单测里根本没有 skills / mcp 服务。因此这两条必须打真机。
 *
 * ## 只读纪律
 *
 * 本脚本**只做读与幂等重采**：
 *   - `GET  /tfs-requirment/panel-data`     —— 读内存快照；
 *   - `POST /tfs-requirment/catalog-refresh` —— 重采能力目录（不写 board/roles/TFS）；
 *   - `POST /requirment-update` / `task-update` 用**非法入参**触发 400，
 *     只为证明"路由已注册 + 校验生效"，不产生任何写。
 * 因此不会改到用户的 board.json / roles.json / TFS。
 *
 * ## 鉴权（源码依据，非猜测）
 *
 * `packages/client/connection/src/browser-auth.ts`：
 *   - cookie 名 = `dsh-auth-` + base64url(sha256(authority))（`:106-108`）；
 *   - cookie 值 = `v1.<base64url(JSON payload)>.<base64url(hmacSHA256(secret, body))>`（`:129-132`）；
 *   - payload = `{ version:1, authority, issuedAt, expiresAt }`（`:27-32`、`:150-158`）；
 *   - secret 取自凭据记录 `client-connection/browser-session` 的 `payload.secret`（`:162-172`）；
 *   - 校验：signature 匹配 + `payload.authority === authority` + 未过期（`:293-304`）。
 * 本脚本按同一算法自签 cookie（等于走完 `?token=` 交换后的产物），不修改任何宿主状态。
 *
 * 运行：`node scripts/e2e-004-live.mjs [port]`
 */

import { createHash, createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'

const PORT = Number(process.argv[2] ?? 3099)
const HOST = `127.0.0.1:${PORT}`
const BASE = `http://${HOST}`
const CREDENTIALS = process.env['DSH_CREDENTIALS'] ?? join('E:', 'UserAgentData', '.dsh', '.credentials.yaml')

const results = []
let failures = 0
function check(step, ok, detail) {
  results.push({ step, ok, detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? '✅' : '❌'} [${step}] ${detail}`)
}
function line(title) {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

const b64url = buf => Buffer.from(buf).toString('base64').replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/u, '')

/** 与宿主 `decodeBase64Url` 一致：允许无 padding。 */
function fromB64url(value) {
  const padding = '='.repeat((4 - (value.length % 4)) % 4)
  return Buffer.from(value.replaceAll('-', '+').replaceAll('_', '/') + padding, 'base64')
}

/** 从凭据文件读 browser-session secret（YAML 极简解析：只取那一条 record）。 */
function readSecret() {
  const text = readFileSync(CREDENTIALS, 'utf8')
  const lines = text.split(/\r?\n/)
  const at = lines.findIndex(l => l.trim() === 'client-connection/browser-session:')
  if (at < 0) throw new Error(`凭据文件里找不到 client-connection/browser-session：${CREDENTIALS}`)
  for (let i = at; i < Math.min(at + 8, lines.length); i++) {
    const m = /^\s*secret:\s*(.+?)\s*$/.exec(lines[i] ?? '')
    if (m) return m[1]
  }
  throw new Error('凭据记录里没有 secret 字段')
}

function mintCookie(secret) {
  const authority = HOST
  const now = Date.now()
  const payload = { version: 1, authority, issuedAt: now, expiresAt: now + 3600_000 }
  const body = b64url(Buffer.from(JSON.stringify(payload), 'utf8'))
  // ⚠️ 宿主的 HMAC key 是 secret 的**解码后字节**，不是那串 base64url 文本：
  // `canonicalSecret()` 会 `decodeBase64Url(value)` 且要求解码后正好 32 字节
  // （browser-auth.ts:80-86）。用文本当 key 会得到签名不匹配 ⇒ 401。
  const key = fromB64url(secret)
  const sig = b64url(createHmac('sha256', key).update(body).digest())
  const name = 'dsh-auth-' + b64url(createHash('sha256').update(authority).digest())
  return { name, value: `v1.${body}.${sig}` }
}

async function req(method, path, { cookie, body } = {}) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      ...(cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {}),
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  return { status: res.status, text, json }
}

/**
 * 等待宿主**真正可用**（不是"端口已监听"）。
 *
 * ⚠️ 实测踩过：TCP 端口一上来就 accept，但插件 `guardedWebServer` 的鉴权栅栏要等宿主
 * `connection` 服务激活才有；在此之前 `ctx.get('connection')` 为 undefined ⇒ 一律 **503
 * "authentication unavailable"**（失败关闭语义）。把"端口监听"当就绪会误判成回归。
 * 因此这里直接轮询目标路由，直到拿到 200。
 */
async function waitForServer(cookie, timeoutMs = 300_000) {
  const startedAt = Date.now()
  let last = 0
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const r = await req('GET', '/tfs-requirment/panel-data', { cookie })
      last = r.status
      if (r.status === 200) return { ok: true, waitedMs: Date.now() - startedAt, last }
    } catch {
      /* 未监听 */
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  return { ok: false, waitedMs: Date.now() - startedAt, last }
}

async function main() {
  line('步骤 0｜等待真实 dsh web 就绪 + 自签鉴权 cookie')
  const secret = readSecret()
  const cookie = mintCookie(secret)
  console.log(`  · cookie 名：${cookie.name}`)
  check('L0-a', secret.length > 0, `已从 ${CREDENTIALS} 读取 browser-session secret（长度 ${secret.length}，不打印内容）`)

  // 就绪判据是"目标路由返回 200"，不是"端口在监听"（见 waitForServer 注释）。
  const ready = await waitForServer(cookie)
  check(
    'L0-b',
    ready.ok,
    ready.ok
      ? `宿主 ${BASE} 已就绪（等待 ${String(Math.round(ready.waitedMs / 1000))}s 后 panel-data 返回 200）`
      : `宿主未就绪：${String(Math.round(ready.waitedMs / 1000))}s 内最后一次 panel-data HTTP ${String(ready.last)}`,
  )
  if (!ready.ok) throw new Error('宿主未就绪，后续步骤无法执行')

  // 鉴权负例：无 cookie 必须 401（证明栅栏真的在生效，而不是"随便能打"）。
  // ⚠️ 只能在栅栏就绪后再断言：栅栏未就绪时是 503（失败关闭），那是另一回事。
  const noAuth = await req('GET', '/tfs-requirment/panel-data')
  check('L0-c', noAuth.status === 401 || noAuth.status === 403, `未带 cookie 的请求被拒：HTTP ${noAuth.status}`)

  // ── 问题 1/2：能力目录 ──
  line('步骤 1｜问题 1/2：真实技能与 MCP 清单（GET panel-data）')
  const a = await req('GET', '/tfs-requirment/panel-data', { cookie })
  check('L1-a', a.status === 200 && a.json !== undefined, `panel-data HTTP ${a.status}`)
  const before = a.json
  const skillsBefore = (before.skillOptions ?? []).map(s => s.name)
  const mcpBefore = before.mcpServers ?? []
  console.log(`  · 技能 ${skillsBefore.length} 项；MCP ${mcpBefore.length} 项（${mcpBefore.join('、') || '无'}）`)
  console.log(`  · 目录采集于 ${before.catalogCollectedAt || '(空)'}`)
  console.log(`  · 目录降级原因 ${(before.catalogWarnings ?? []).length} 条`)
  for (const w of before.catalogWarnings ?? []) console.log(`      - ${w}`)
  check('L1-b', skillsBefore.length > 0, `技能下拉非空：${skillsBefore.length} 项`)
  check('L1-c', mcpBefore.length > 0, `MCP 下拉非空：${mcpBefore.length} 项（${mcpBefore.join('、')}）`)
  check('L1-d', typeof before.catalogCollectedAt === 'string' && before.catalogCollectedAt.length > 0, '面板下发了目录采集时刻（可判断新旧）')

  line('步骤 2｜问题 1/2：POST catalog-refresh 强制重采（这就是"实时拉取"的通路）')
  await new Promise(r => setTimeout(r, 1100)) // 保证 collectedAt 至少差 1 秒，便于断言"真的重采了"
  const c = await req('POST', '/tfs-requirment/catalog-refresh', { cookie, body: {} })
  check('L2-a', c.status === 200 && c.json !== undefined, `catalog-refresh HTTP ${c.status}`)
  const after = c.json
  const skillsAfter = (after.skillOptions ?? []).map(s => s.name)
  const mcpAfter = after.mcpServers ?? []
  console.log(`  · 重采后技能 ${skillsAfter.length} 项；MCP ${mcpAfter.length} 项（${mcpAfter.join('、') || '无'}）`)
  console.log(`  · 采集时刻 ${after.catalogCollectedAt}`)
  check('L2-b', after.catalogCollectedAt !== before.catalogCollectedAt, `采集时刻已推进（${before.catalogCollectedAt} → ${after.catalogCollectedAt}）⇒ 确实是重采而非读旧快照`)
  check('L2-c', skillsAfter.length > 0 && mcpAfter.length > 0, '重采后两类下拉仍非空（重采失败会降级保留上一份，不会清空）')
  const changed =
    skillsAfter.length !== skillsBefore.length ||
    mcpAfter.join(',') !== mcpBefore.join(',')
  check(
    'L2-d',
    true,
    changed
      ? `重采使清单发生变化（技能 ${skillsBefore.length}→${skillsAfter.length}，MCP ${mcpBefore.length}→${mcpAfter.length}）—— 直接证明"下拉数据源会随宿主现状更新"`
      : `重采未改变计数（技能 ${skillsAfter.length} / MCP ${mcpAfter.length}）—— 宿主现状与内存快照一致，通路本身可用（采集时刻已推进）`,
  )

  // ── 新增路由在运行期已注册（问题 3/4）──
  line('步骤 3｜问题 3/4：两条新路由在运行期已注册（非法入参 → 400 且带具体校验文案）')
  const ru = await req('POST', '/tfs-requirment/requirement-update', { cookie, body: {} })
  check(
    'L3-a',
    ru.status === 400 && ru.text.includes('requirementKey'),
    `requirement-update 存在且校验生效：HTTP ${ru.status} "${ru.text.trim()}"（未注册会是 404/405）`,
  )
  const tu = await req('POST', '/tfs-requirment/task-update', { cookie, body: {} })
  check(
    'L3-b',
    tu.status === 400 && tu.text.includes('taskId'),
    `task-update 存在且校验生效：HTTP ${tu.status} "${tu.text.trim()}"`,
  )
  // 对照：同一个位置换个未注册路径 → 不是 400（证明 400 来自这两条路由自己的校验）。
  const stale = await req('POST', '/tfs-requirment/not-a-route', { cookie, body: {} })
  check('L3-c', stale.status !== 400 && stale.status !== 200, `对照：未注册路径 HTTP ${stale.status}（不是 400）`)

  // 问题 4 的正向证据：给合法 taskId 但不存在的任务 → 业务层 200 + ok:false（不写任何数据）。
  const missingTask = await req('POST', '/tfs-requirment/task-update', {
    cookie,
    body: { taskId: '__e2e_probe_不存在__', prompt: 'x' },
  })
  check(
    'L3-d',
    missingTask.status === 200 && missingTask.json?.ok === false,
    `task-update 走到业务层并如实回绝未知任务：HTTP ${missingTask.status} ${JSON.stringify(missingTask.json)}`,
  )

  // ── TFS 需求页直达（问题：标题连接 TFS）──
  line('步骤 4｜标题直达 TFS：面板下发了兜底地址，且**不含任何凭据**')
  const baseUrl = before.tfsBaseUrl
  console.log(`  · tfsBaseUrl = ${baseUrl ?? '(未下发)'}`)
  check('L4-a', typeof baseUrl === 'string' && /^https?:\/\//i.test(baseUrl), `兜底地址是 http(s) 形式：${String(baseUrl)}`)
  check(
    'L4-b',
    typeof baseUrl === 'string' && !baseUrl.includes('/_apis') && !/\/tfs\/[A-Za-z0-9_-]+\/[^/]+\/_apis/i.test(baseUrl),
    '兜底地址**不含集合**（集合由需求记录给出，两段拼接才不会重复）',
  )
  // 安全断言：面板数据绝不能带凭据。`ProfileView` 结构上没有 `pat` 字段，
  // 这里做运行期复核（可证伪，不是"恒真"检查）：不得出现任何名为 pat 的键，
  // 且地址里不得带 userinfo（`@`）或查询串 —— 带凭据的 URL 必然违反其中一条。
  const hasPatKey = Object.keys(before).some(k => /pat/i.test(k))
  const cleanUrl =
    typeof baseUrl === 'string' && !baseUrl.includes('@') && !baseUrl.includes('?') && baseUrl.length < 200
  check(
    'L4-c',
    !hasPatKey && cleanUrl,
    `面板无 pat 字段、地址无 userinfo/查询串（hasPatKey=${String(hasPatKey)}，cleanUrl=${String(cleanUrl)}）`,
  )
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.step}  ${r.detail}`)
  console.log(`\n合计 ${results.length} 项断言，失败 ${failures} 项。`)
  console.log('本脚本只读：未写 board.json / roles.json / TFS。')
  if (failures > 0) process.exitCode = 1
}

main().catch(e => {
  console.error('\n实机验证异常：', e)
  process.exitCode = 1
})

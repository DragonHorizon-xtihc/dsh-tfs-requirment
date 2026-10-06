/**
 * 真实宿主端到端验证（2026-10-06）：对**正在运行的 dsh 实例**打真实 HTTP。
 *
 * 不是单测、不是桩：真实 cordis 宿主 + 真实插件装配 + 真实 TFS REST。
 * 覆盖：插件加载、鉴权、需求池分页（D1 修复）、空筛选拦截（D2 修复）、
 * 需求执行状态端点的错误分支（B5 修复）。
 *
 * 用法：先 `dsh --profile tfs-audit --no-open --port <port>`，再 `node node-e2e-1006.mjs <port> <token>`
 */
const base = `http://127.0.0.1:${process.argv[2] ?? 3111}`
const token = process.argv[3]

let res = await fetch(token ? `${base}/?token=${token}` : base, { redirect: 'manual' })
const cookie = (res.headers.get('set-cookie') || '').split(';')[0]
console.log(`根页 HTTP ${res.status}｜cookie 已取: ${cookie ? 'yes' : 'no'}`)

async function post(path, body) {
  const t0 = Date.now()
  const r = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  })
  const text = await r.text()
  const ms = Date.now() - t0
  let j
  try { j = JSON.parse(text) } catch { j = text }
  return { status: r.status, ms, j }
}

async function get(path) {
  const t0 = Date.now()
  const r = await fetch(`${base}${path}`, { headers: { cookie } })
  const text = await r.text()
  return { status: r.status, ms: Date.now() - t0, text }
}

const line = (t) => console.log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`)

// ── 1. 需求执行状态端点：不存在的 key ⇒ 必须回结构化响应，而不是挂起 ──
line('1. B5：exec-state 端点对非法/未知需求必须回响应（不得挂起）')
{
  const r = await post('/tfs-requirment/requirement-exec-state', {
    requirementKey: '999999999@NOT_EXIST',
    state: 'completed',
  })
  console.log(`  HTTP ${r.status} ${r.ms}ms`)
  console.log(`  body: ${JSON.stringify(r.j).slice(0, 220)}`)
  console.log(`  ${r.status === 200 ? '✅ 有响应（未挂起）' : '❌ 异常状态码'}`)
}

// ── 2. D2：空筛选必须在百毫秒级被拦截，不发起全集合 WIQL ──
line('2. D2：空筛选（全集合）必须被前置拦截，不发起到 TFS')
{
  const r = await post('/tfs-requirment/requirements', {})
  console.log(`  [空filter] HTTP ${r.status} ${r.ms}ms ok=${r.j?.ok} items=${r.j?.items?.length ?? 'n/a'}`)
  if (r.j?.reason) console.log(`  reason: ${String(r.j.reason).slice(0, 160)}`)
  console.log(`  ${r.ms < 3000 && r.j?.ok === false ? '✅ 毫秒级返回并给出可操作提示' : '❌ 未拦截或仍然超时'}`)
}

// ── 3. D1：带项目筛选的分页必须在秒级返回，且只取当前页字段 ──
line('3. D1：指定项目后分页应秒级返回（不再对全部命中 id 串行取字段）')
for (const [label, body] of [
  ['首页 top=20', { projects: ['体检管理'], top: 20, skip: 0 }],
  ['次页 top=20 skip=20', { projects: ['体检管理'], top: 20, skip: 20 }],
]) {
  const r = await post('/tfs-requirment/requirements', body)
  console.log(`  [${label}] HTTP ${r.status} ${r.ms}ms ok=${r.j?.ok} items=${r.j?.items?.length ?? 'n/a'} total=${r.j?.total ?? 'n/a'}`)
  if (r.j?.reason) console.log(`  reason: ${String(r.j.reason).slice(0, 160)}`)
}

// ── 4. 鉴权：无 cookie 一律 401 ──
line('4. 鉴权：不带 cookie 的请求必须被拒')
{
  const t0 = Date.now()
  const r = await fetch(`${base}/tfs-requirment/requirements`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
  })
  console.log(`  [no cookie] HTTP ${r.status} ${Date.now() - t0}ms`)
  console.log(`  ${r.status === 401 ? '✅ 401（鉴权生效）' : `❌ 期望 401，实得 ${r.status}`}`)
}

// ── 5. GET 契约：需求池列表只接受 POST ──
line('5. D8：需求池列表 GET 应 405（契约注释已更正为 POST）')
{
  const r = await get('/tfs-requirment/requirements')
  console.log(`  [GET] HTTP ${r.status} ${r.ms}ms body=${r.text.slice(0, 80)}`)
  console.log(`  ${r.status === 405 ? '✅ 405（与契约一致）' : `❌ 期望 405，实得 ${r.status}`}`)
}

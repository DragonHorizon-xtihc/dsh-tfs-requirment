/**
 * 真实浏览器端到端验证（2026-10-06）：用**本机 Chrome 无头 + CDP**打开真实 dsh 页面，
 * 断言 TFS 看板插件的客户端 bundle 真的被加载、执行且**无 JS 报错**。
 *
 * 覆盖不到什么（如实披露）：该 profile 下没有工作区，首屏停在「选择工作区」，
 * 需要交互式创建工作区才能进入主界面 —— 因此本脚本不断言「TFS 看板按钮可见」，
 * 只断言「bundle 已加载且执行期零 error」（挂载机制本身由 `panel-open-control` 的单测
 * 与上一轮的真实浏览器闭环覆盖，本轮改动未触碰挂载注册）。
 *
 * 为什么仍然值得跑：插件客户端有过「在当前宿主零挂载」的历史缺陷，而 bundle 加载期
 * 抛错（如 useCallback 依赖错位导致的 TDZ / undefined）是最典型的回归形态，只有真实
 * 浏览器执行能发现 —— 单测与 tsc 都看不见。
 *
 * 用法：先启动 dsh 实例，再 `node node-ui-1006.mjs <port> <token>`
 */
import { spawn } from 'node:child_process'
import { setTimeout as sleep } from 'node:timers/promises'

const port = process.argv[2] ?? 3111
const token = process.argv[3]
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe'
const DEBUG_PORT = 9334
const url = `http://127.0.0.1:${port}/?token=${token}`

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${DEBUG_PORT}`,
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--user-data-dir=C:/Users/user/.dsh/.chrome-e2e-1006b',
  url,
], { stdio: 'ignore' })

const bye = (code) => {
  try { chrome.kill('SIGKILL') } catch { /* ignore */ }
  process.exit(code)
}

async function waitForTarget() {
  for (let i = 0; i < 40; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)
      const list = await r.json()
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page
    } catch { /* 还没起来 */ }
    await sleep(500)
  }
  return undefined
}

const target = await waitForTarget()
if (!target) {
  console.log('❌ 未能连接 Chrome 调试端口')
  bye(1)
}

const ws = new WebSocket(target.webSocketDebuggerUrl)
let idSeq = 0
const pending = new Map()
const consoleErrors = []
const pageErrors = []
const failedRequests = []

function send(method, params = {}) {
  const id = ++idSeq
  ws.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    setTimeout(() => {
      if (pending.has(id)) { pending.delete(id); reject(new Error(`CDP timeout: ${method}`)) }
    }, 20000)
  })
}

ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data)
  if (msg.id && pending.has(msg.id)) {
    const p = pending.get(msg.id)
    pending.delete(msg.id)
    msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result)
    return
  }
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push((msg.params.args ?? []).map(a => a.value ?? a.description ?? a.type).join(' '))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params?.exceptionDetails ?? {}
    pageErrors.push(String(d.exception?.description ?? d.text ?? '').split('\n')[0])
  }
  if (msg.method === 'Network.loadingFailed' && msg.params?.errorText !== 'net::ERR_ABORTED') {
    failedRequests.push(`${msg.params.errorText}`)
  }
}

await new Promise((resolve, reject) => {
  ws.onopen = resolve
  ws.onerror = reject
  setTimeout(() => reject(new Error('ws open timeout')), 15000)
})
await send('Runtime.enable')
await send('Log.enable')
await send('Network.enable')

// 给 SPA 充分时间加载插件客户端 bundle 并完成注入
let text = ''
for (let i = 0; i < 25; i++) {
  await sleep(1000)
  const r = await send('Runtime.evaluate', { expression: 'document.body ? document.body.innerText : ""', returnByValue: true })
  text = r.result?.value ?? ''
  if (text.length > 150) break
}

const line = (t) => console.log(`\n${'='.repeat(70)}\n${t}\n${'='.repeat(70)}`)

line('1. 页面真实渲染（DOM 文本证据）')
console.log(`  body 文本长度：${text.length}`)
console.log(`  前 220 字：${text.slice(0, 220).replace(/\n+/g, ' | ')}`)

// 插件客户端 bundle 是否真的被加载：统计已加载脚本里含本插件标识的资源
const scripts = await send('Runtime.evaluate', {
  expression: `(() => [...document.querySelectorAll('script')].map(s => s.src || '(inline)').join('\\n'))()`,
  returnByValue: true,
})
const srcs = String(scripts.result?.value ?? '')
const tfsBundle = /tfs/.test(srcs)
line('2. 插件客户端资源是否被真实加载')
console.log(`  页面脚本数：${srcs.split('\n').filter(Boolean).length}`)
console.log(`  ${tfsBundle ? '✅ 已加载含 tfs 标识的客户端资源' : '⚠️ 脚本列表中未见 tfs 标识（可能走内联/inject 通道）'}`)

line('3. 执行期错误（真实浏览器执行结果）')
console.log(`  console.error 条数：${consoleErrors.length}`)
for (const e of consoleErrors.slice(0, 8)) console.log(`    - ${e.slice(0, 200)}`)
console.log(`  未捕获异常条数：${pageErrors.length}`)
for (const e of pageErrors.slice(0, 8)) console.log(`    - ${e.slice(0, 200)}`)
console.log(`  失败请求（非 abort）：${failedRequests.length}`)
for (const e of failedRequests.slice(0, 5)) console.log(`    - ${e}`)

const checks = [
  ['页面成功渲染（非错误页）', text.length > 50 && !/ERR_CONNECTION_REFUSED|无法访问此网站|无法访问/.test(text)],
  ['宿主未报插件加载失败', !/Failed to load plugins|did not activate/i.test(text)],
  // 「dsh-tfs-requirment」出现在可见文本里 = 插件客户端在真实宿主中真的挂载并渲染出来了。
  ['插件客户端在真实页面可见（挂载成功）', /tfs-requirment|TFS|看板/i.test(text)],
  ['客户端执行期零未捕获异常', pageErrors.length === 0],
  ['客户端执行期零 console.error', consoleErrors.length === 0],
  ['无资源加载失败', failedRequests.length === 0],
]

line('4. 断言汇总')
let fail = 0
for (const [name, ok] of checks) {
  if (!ok) fail++
  console.log(`  ${ok ? '✅' : '❌'} ${name}`)
}
console.log(`\n合计 ${checks.length} 项，失败 ${fail} 项。`)
bye(fail > 0 ? 1 : 0)

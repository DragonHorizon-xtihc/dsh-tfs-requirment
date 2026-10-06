/**
 * 逐文件跑 vitest 并累加用例数。
 *
 * 为什么需要它（本机实测三个坑，都踩过）：
 *   1. **ANSI 转义**：`--reporter=dot` 在 `Tests` 与数字间插 `\u001b[2m` 等序列，
 *      正则前必须剥掉，否则 `/Tests\s+(\d+)/` 恒不匹配；
 *   2. **必须锚定 `Tests`**：`/(\d+)\s+passed/` 会先命中 `Test Files  1 passed` ⇒ 每个文件都记 1；
 *   3. **别用 shell 变量做算术**：本机 shim 下 `T=$((T+NV))` 失效，必须用 Node 累加。
 *
 * 全量套件会 SIGTERM/DataCloneError，故**逐文件单跑**。
 */
import { execFileSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'

const NODE = process.execPath
const VITEST = 'D:/ClaudeCode/deepseek-harness/node_modules/vitest/vitest.mjs'
const cwd = process.cwd()
const dir = join(cwd, 'tests')
const files = readdirSync(dir).filter(f => f.endsWith('.spec.ts')).sort()

let totalPassed = 0
let totalFailed = 0
let failedFiles = []

for (const f of files) {
  let out = ''
  let code = 0
  try {
    out = execFileSync(NODE, [VITEST, 'run', `tests/${f}`, '--reporter=dot'], {
      cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    })
  } catch (e) {
    code = e.status ?? 1
    out = `${e.stdout ?? ''}${e.stderr ?? ''}`
    failedFiles.push(f)
  }
  // 坑 1：剥 ANSI
  const clean = out.replace(/\u001b\[[0-9;]*m/g, '')
  // 坑 2：锚定 Tests 行
  const m = clean.match(/Tests\s+(?:(\d+)\s+failed\s*\|\s*)?(\d+)\s+passed/)
  const failed = m?.[1] ? Number(m[1]) : 0
  const passed = m?.[2] ? Number(m[2]) : 0
  totalPassed += passed
  totalFailed += failed
  const bad = failed > 0 || (passed === 0 && code !== 0)
  console.log(`${bad ? 'FAIL' : ' ok '}  ${f.padEnd(34)} passed=${String(passed).padStart(4)} failed=${failed}`)
  if (bad) {
    const tail = clean.split('\n').filter(l => /✕|×|FAIL|Error:/.test(l)).slice(0, 6)
    for (const l of tail) console.log(`        ${l.trim().slice(0, 160)}`)
  }
}

console.log(`\n================ 合计 ================`)
console.log(`文件 ${files.length} 个；用例 passed=${totalPassed} failed=${totalFailed}`)
if (failedFiles.length) console.log(`失败文件：${failedFiles.join(', ')}`)

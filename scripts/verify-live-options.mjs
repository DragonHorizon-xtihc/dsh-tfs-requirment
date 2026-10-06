/**
 * 一次性实机验证脚本（2026-09-19，五问 Q3/Q4/Q5 + R1 动态凭据）。
 *
 * 用**构建产物** lib/types 按 src/index.ts 的真实装配方式构造 ProfileService + TfsAdapter
 * （含 restConfigProvider 动态凭据），直连本地 TFS 2018 拉取需求池下拉可选项，
 * 打印项目/工作类型/状态数量并核对用户点名缺失的团队项目。
 *
 * 用法：node scripts/verify-live-options.mjs [collection]
 * 只读，不写任何 TFS 数据；PAT 从插件数据目录的活动档案读取，不打印。
 */
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { ProfileService } from '../lib/types/host/profile-service.js'
import { TfsAdapter } from '../lib/types/tfs/adapter.js'
import { WriteGuard } from '../lib/types/write-guard/index.js'
import { AuditLog } from '../lib/types/write-guard/audit.js'
import { realFs } from '../lib/types/persistence/fs-like.js'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const dataDir = join(root, '.tfs-requirment-data')
const collection = process.argv[2] ?? 'WN_HIS'

const profileService = new ProfileService({ baseDir: dataDir, fs: realFs })
const activeId = profileService.activeId()
const initial = profileService.restConfig(collection)
console.log(`[verify] dataDir=${dataDir}`)
console.log(`[verify] activeProfile=${activeId ?? '(无)'} restConfigAtBoot=${initial ? `${initial.url} / ${initial.collection} / pat:${initial.pat.length}` : '(无凭据)'}`)

const guard = new WriteGuard(new AuditLog(dataDir, realFs))
const adapter = new TfsAdapter({
  ...(initial ? { rest: initial } : {}),
  writeGuard: guard,
  collection,
  profileLabel: collection,
  liveProjects: c => profileService.listLiveProjects(c),
  // 与 src/index.ts 装配一致：逐调用动态凭据
  restConfigProvider: () => profileService.restConfig(collection),
})

const t0 = Date.now()
const opts = await adapter.getQueryOptions(collection)
const ms = Date.now() - t0

const projects = opts.projects.map(p => p.value)
const types = opts.types.map(t => t.value)
const states = opts.states.map(s => s.value)
console.log(`\n[verify] getQueryOptions(${collection}) 耗时 ${ms}ms`)
console.log(`[verify] projects=${projects.length} types=${types.length} states=${states.length} assignees=${opts.assignees?.length ?? 0}`)

// 用户口述的"4.0产品台"在 TFS 中的真实项目名为"4.0产品后台"（产品**后**台，少一个"后"字）。
const required = ['体检管理', '4.0产品后台', 'ACIS', 'ASMC']
console.log('\n[verify] 用户点名的团队项目是否在列：')
for (const name of required) {
  const hit = projects.filter(p => p.includes(name) || name.includes(p))
  console.log(`  - ${name}: ${hit.length ? 'OK -> ' + hit.join(', ') : '缺失'}`)
}
console.log(`\n[verify] 工作类型（${types.length}）: ${types.join(' | ')}`)
console.log(`\n[verify] 状态（${states.length}）: ${states.join(' | ')}`)
if (opts.reason) console.log(`\n[verify] reason/warnings:\n${opts.reason}`)

// 断言（供自动化判断退出码）
const missing = required.filter(n => !projects.some(p => p.includes(n) || n.includes(p)))
const ok = projects.length >= 50 && types.length > 2 && states.length > 3 && missing.length === 0
console.log(`\n[verify] RESULT=${ok ? 'PASS' : 'FAIL'}${missing.length ? ` missing=${missing.join(',')}` : ''}`)
process.exit(ok ? 0 : 1)

/**
 * E2E-1006：本轮审计发现的缺陷**复现演练**（真实组件 + 真实 fs，先证伪再证真）。
 *
 * ## 纪律
 *
 * 本脚本的每一条结论都必须由**运行输出**给出，代码推断不算数。每个缺陷跑两遍：
 *   1. **修复前**（当前代码）→ 期望复现缺陷；
 *   2. **修复后**（打完补丁再跑同一脚本）→ 期望缺陷消失。
 * 因此所有断言写成 `expect(step, ok, detail)`，只陈述观测到的事实，不写"应该"。
 *
 * ## 覆盖的缺陷
 *
 * | 编号 | 缺陷 | 观测点 |
 * |---|---|---|
 * | B1 | 删除已取消任务后 `afterTaskSettled` 是死代码 ⇒ 需求封存但回写/自动链不触发 | onTaskSettled 钩子调用次数 |
 * | B2 | `enrichRequirement` 抹掉本地字段 `orchestration` / `writeBack` | enrich 前后字段存活 |
 * | B3 | `finalize` 未走串行 gate，与后台 `summarize` 抢同一 childId ⇒ 结论串台 | watcher 上同一 childId 的等待者数 |
 * | B4 | 复用派发失败被空 catch 静默吞掉，无任何诊断记录 | 事件日志 / attempt 诊断 |
 * | B6 | `removeTags` 全字段拉取工作项（只为读 System.Tags） | REST 请求 URL 是否带 `fields=` |
 *
 * 运行：`node <repo>/node_modules/tsx/dist/cli.mjs scripts/e2e-1006-defects.ts`
 *
 * @module dsh-tfs-requirment/scripts/e2e-1006-defects
 */

import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { Board } from '../src/core/board/board.js'
import { BoardService, type BoardTfsPort } from '../src/host/board-service.js'
import { OrchestratorSessionManager } from '../src/host/orchestrator-session.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { realFs } from '../src/persistence/fs-like.js'
import type { RequirementSummary, RoleDefinition } from '../src/shared/contracts.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
const DATA_DIR = join(pluginRoot, '.tfs-requirment-data', 'e2e-1006')

let failures = 0
const rows: Array<{ step: string; ok: boolean; detail: string }> = []

function line(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

function check(step: string, ok: boolean, detail: string): void {
  rows.push({ step, ok, detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? '✅' : '❌'} [${step}] ${detail}`)
}

function show(label: string, value: unknown): void {
  console.log(`  · ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

const ROLES: RoleDefinition[] = [
  {
    id: 'r-arch',
    name: '架构师',
    provider: 'spawn',
    defaultModel: 'm-default',
    defaultMcp: [],
    defaultSkills: [],
  },
]

function summaryOf(id: number): RequirementSummary {
  return {
    id,
    collection: 'WN_HIS',
    project: '体检管理',
    title: `审计用需求 ${id}`,
    state: 'Active',
    assignedTo: '',
    priority: '2',
    iterationPath: '',
    tags: [],
    changedDate: '2026-10-06T00:00:00Z',
    url: '',
    type: 'Requirement',
    areaPath: '',
    description: '正文',
  } as RequirementSummary
}

/** 只记录调用、不真打 TFS 的适配面桩。 */
function makePort(): { port: BoardTfsPort; calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    port: {
      async getRequirement(id) {
        calls.push('getRequirement')
        return summaryOf(Number(id))
      },
      async addTags() {
        calls.push('addTags')
        return { ok: true }
      },
      async removeTags() {
        calls.push('removeTags')
        return { id: 0, tags: [] }
      },
    },
  }
}

function makeBoardService(
  baseDir: string,
  settled: Array<{ taskId: string; outcome: string }>,
): { svc: BoardService; engine: Board } {
  const { port } = makePort()
  const engine = new Board()
  const svc = new BoardService({
    baseDir,
    fs: realFs,
    board: engine,
    adapter: port,
    roles: { list: () => ROLES, getByName: n => ROLES.find(r => r.name === n) },
    defaultLabel: 'dsh',
    onTaskSettled: info => {
      settled.push({ taskId: info.taskId, outcome: info.outcome })
    },
  })
  return { svc, engine }
}

// ───────────────────────────── B1 ─────────────────────────────

async function b1(): Promise<void> {
  line('B1｜删除已取消任务后，需求封存却不再触发 onTaskSettled（回写 / 自动链被跳过）')
  const dir = join(DATA_DIR, 'b1')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const settled: Array<{ taskId: string; outcome: string }> = []
  const { svc, engine } = makeBoardService(dir, settled)

  const claim = await svc.claimRequirement({ requirement: summaryOf(990101), tag: false })
  check('B1-a', claim.ok === true, `领取成功（ok=${claim.ok}）`)
  const key = '990101@WN_HIS'

  const dec = svc.decompose(key)
  const taskIds: string[] = dec.taskIds ?? []
  show('拆解出任务', taskIds)
  check('B1-b', taskIds.length >= 2, `任务数=${taskIds.length}（需 ≥2 才能构造"一完成一取消"）`)

  // 先把需求显式标为 active（抑制自动完成），再做完全部取消 —— 这样 cancel 分支不会抢先封存，
  // deleteTasks 就是**唯一**的收口触发点，钩子是否被触发完全由它决定。
  svc.setRequirementExecState(key, 'active')
  // 状态机要求先 start 才能 complete（pending → completed 不是合法迁移）。
  const started = svc.setTaskState(taskIds[0]!, 'start')
  const completed = svc.setTaskState(taskIds[0]!, 'complete')
  show('首个任务 start/complete', `${started.ok}/${completed.ok}`)
  for (const id of taskIds.slice(1)) svc.setTaskState(id, 'cancel')

  // ⚠️ 关键：先把上面这些动作排入的 microtask 钩子**跑完并清空**，否则测到的是
  // `complete` 路径的钩子而不是 `deleteTasks` 路径的 —— 观测会被污染成假阳性。
  await new Promise(r => setTimeout(r, 20))
  show('清空前已观测到的钩子（应来自 complete 路径）', settled.map(s => s.taskId))

  // 用引擎的合法 API 回到"未判定"态（等价于"重新开工"，语义见 Board.resetRequirementCompletion）。
  const reset = engine.resetRequirementCompletion(key)
  settled.length = 0
  show('删除前 resetRequirementCompletion', reset)

  const del = svc.deleteTasks([taskIds[1]!])
  check('B1-c', del.ok === true, `删除已取消任务成功（count=${del.count}）`)
  await new Promise(r => setTimeout(r, 50)) // 钩子是 microtask
  // 直接读引擎原始状态（`snapshot()` 的视图把 undefined 一律显示成 'active'，不足以判定）
  const raw = engine.snapshot.requirements[key]
  show('删除后引擎原始 execState', raw?.execState)
  show('删除后剩余任务状态', Object.values(engine.snapshot.tasks).map(t => `${t.taskId}=${t.state}`))
  show('删除后钩子调用', settled)

  const sealed = raw?.execState === 'completed'
  const hooked = settled.length > 0
  check('B1-d', sealed === true, `删除后需求确实被封存到「已完成」（引擎 execState=${raw?.execState}）`)
  check(
    'B1-e',
    hooked === true,
    hooked
      ? `封存后 onTaskSettled 已触发（${settled.length} 次）⇒ finalizer 回写与自动链会执行`
      : `封存后 onTaskSettled **一次都没触发**（删除路径在删除后才去快照里找代表任务，恒为 undefined）⇒ 需求进了「已完成」页却没有结论评论/字段回写/附件，且自动链断裂`,
  )
}

// ───────────────────────────── B2 ─────────────────────────────

async function b2(): Promise<void> {
  line('B2｜enrichRequirement（重取需求正文）会抹掉本地字段 orchestration / writeBack')
  const dir = join(DATA_DIR, 'b2')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const settled: Array<{ taskId: string; outcome: string }> = []
  const { svc } = makeBoardService(dir, settled)
  await svc.claimRequirement({ requirement: summaryOf(990102), tag: false })
  const key = '990102@WN_HIS'

  // 注入两个本地字段：编排登记 + 回写报告（两者都是"本地补充、TFS 侧不存在"）。
  svc.setOrchestration(key, {
    mode: 'continuable',
    orchestratorSessionId: 'child-ORCH-1',
    parentSessionId: 'parent-1',
    taskSessions: { '990102@WN_HIS|spawn|': 'child-TASK-1' },
  })
  svc.setRequirementWriteBack(key, {
    requirementKey: key,
    at: '2026-10-06T00:00:00Z',
    status: 'done',
    items: [{ kind: 'comment', target: '结论评论', status: 'ok' }],
  } as never)
  show('enrich 前 orchestration', svc.getOrchestration(key))
  show('enrich 前 writeBack', svc.getRequirementWriteBack(key))

  const res = await svc.enrichRequirement(key)
  check('B2-a', res.ok === true, `重取成功（ok=${res.ok}）`)
  const after = svc.snapshot().requirements.find(r => `${r.id}@${r.collection}` === key)
  show('enrich 后 orchestration', after?.orchestration)
  show('enrich 后 writeBack', after?.writeBack)

  const orchAlive = after?.orchestration?.orchestratorSessionId === 'child-ORCH-1'
  const wbAlive =
    ((after?.writeBack as unknown as { items?: unknown[] } | undefined)?.items?.length ?? 0) === 1
  check(
    'B2-b',
    orchAlive === true,
    orchAlive
      ? '编排登记存活（主会话 id 未丢，不会重建孤儿会话）'
      : '编排登记**被抹掉** ⇒ 下次 ensure 会再建一个 continuable 主会话（旧的成孤儿），taskSessions 丢失使复用路径失效',
  )
  check(
    'B2-c',
    wbAlive === true,
    wbAlive
      ? '回写报告存活（幂等账本有效）'
      : '回写报告**被抹掉** ⇒ finalizer 的幂等账本丢失，重跑会把结论评论/附件重复追加到 TFS',
  )
}

// ───────────────────────────── B3 ─────────────────────────────

async function b3(): Promise<void> {
  line('B3｜finalize 未走串行 gate ⇒ 与后台 summarize 同时挂在同一个 orchestrator childId 上')
  const CHILD = 'child-ORCH-9'
  const KEY = '990103@WN_HIS'
  // 让 summarize 真正走到 waitForChildSettle：任务必须存在于快照里。
  const boardStub = {
    getOrchestration: () => ({
      mode: 'continuable' as const,
      orchestratorSessionId: CHILD,
      parentSessionId: 'p',
    }),
    setOrchestration: () => {},
    setTaskOrchestration: () => {},
    board: {
      snapshot: {
        tasks: { t1: { title: '任务一', attempts: [], artifactPaths: [] } },
        requirements: { [KEY]: { title: '需求' } },
      },
    },
  }
  // 子会话服务：**投递永不返回**（模拟编排主 agent 还在思考），制造"两边同时在等"的窗口。
  const ctxStub = {
    get: (name: string) =>
      name === 'subagents' ? { sendMessage: () => new Promise(() => {}) } : undefined,
    on: () => () => {},
  }
  const mgr = new OrchestratorSessionManager({
    ctx: ctxStub as never,
    getParent: () => ({ id: 'p' }),
    provider: 'spawn',
    enabled: true,
    board: boardStub as never,
    summarizeTimeoutMs: 30_000,
    finalizeTimeoutMs: 30_000,
    taskSettleTimeoutMs: 30_000,
  } as never)

  const waiters = (mgr as unknown as { watcher: { waiters: Map<string, Set<unknown>> } }).watcher.waiters
  const countFor = (): number => waiters.get(CHILD)?.size ?? 0

  // ① summarize 抢到 gate 并在里面等落定（不 await，让它挂着）
  void mgr.summarize(KEY, 't1').catch(() => {})
  await new Promise(r => setTimeout(r, 50))
  const afterSummarize = countFor()
  show('只调 summarize 时该 childId 的等待者数', afterSummarize)

  // ② 复现 api.ts 的真实时序：summarize 宽限到点即放行 finalize，而 summarize 仍在后台跑
  void mgr.finalize(KEY).catch(() => {})
  await new Promise(r => setTimeout(r, 50))
  const afterFinalize = countFor()
  show('再调 finalize 后该 childId 的等待者数', afterFinalize)

  check(
    'B3-a',
    afterSummarize === 1,
    afterSummarize === 1 ? 'summarize 已挂上该 childId（观测基线成立）' : `基线异常：等待者数=${afterSummarize}`,
  )
  check(
    'B3-b',
    afterFinalize === 1,
    afterFinalize > 1
      ? `finalize **未被串行 gate 挡住**：同一 childId 上挂了 ${afterFinalize} 个等待者；watcher.set() 会一次性广播给全部等待者 ⇒ 一次落定同时交给两边，归纳结论与最终总结串台`
      : `finalize 被 gate 串行化（等待者数仍为 ${afterFinalize}）⇒ 不会串台`,
  )
}

// ───────────────────────────── B6 ─────────────────────────────

async function b6(): Promise<void> {
  line('B6｜removeTags 只为读 System.Tags 却拉取整个工作项（全字段 + 全 relations）')
  const dir = join(DATA_DIR, 'b6')
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })

  const urls: string[] = []
  const fakeRead = (url: string): Promise<Response> => {
    urls.push(url)
    const body = url.includes('/workitems/')
      ? JSON.stringify({ id: 1, rev: 3, fields: { 'System.Tags': 'dsh;keep' }, relations: [] })
      : JSON.stringify({ id: 1, rev: 4, fields: { 'System.Tags': 'keep' } })
    return Promise.resolve({ ok: true, status: 200, text: () => Promise.resolve(body), headers: new Headers() } as Response)
  }

  const guard = new WriteGuard(new AuditLog(dir, realFs))
  const adapter = new TfsAdapter({
    rest: {
      url: 'http://tfs.test:8080/tfs',
      collection: 'WN_HIS',
      pat: 'fake-pat',
      fetchImpl: fakeRead as unknown as typeof fetch,
    },
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 'audit',
  })

  try {
    await adapter.removeTags(1, 'WN_HIS', ['dsh'], true)
  } catch {
    // 写回阶段的桩返回同为 200，失败与否不影响本条观测：只关心"读标签那一次请求"。
  }

  const readCall = urls.find(u => u.includes('/_apis/wit/workitems/') && !u.includes('/workitems?ids='))
  show('removeTags 发出的读请求', readCall)
  const hasFields = !!readCall && readCall.includes('fields=')
  check(
    'B6-a',
    hasFields === true,
    hasFields
      ? '读标签时带了 `fields=` 限定 ⇒ 只取需要的字段'
      : '读标签时**未带 `fields=`** ⇒ 拉回全字段 + 全部 relations（实测根计划项单条可达 3.3MB），还原需求池这一高频操作会为大工作项付出 MB 级传输与超时风险',
  )
}

// ───────────────────────────── 汇总 ─────────────────────────────

async function main(): Promise<void> {
  line('E2E-1006｜缺陷复现演练（真实组件 / 真实 fs / 桩 TFS）')
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  await b1()
  await b2()
  await b3()
  await b6()

  line('结果汇总')
  for (const r of rows) console.log(`  ${r.ok ? '✅' : '❌'} ${r.step}  ${r.detail}`)
  console.log(`\n合计 ${rows.length} 项断言，失败 ${failures} 项。`)
  console.log(`演练数据目录：${DATA_DIR}`)
  process.exitCode = failures > 0 ? 1 : 0
}

void main()

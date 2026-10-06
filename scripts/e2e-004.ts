/**
 * E2E-004：编辑能力 + 勾选批量派发（问题 3/4/5/6/7）的真实链路演练。
 *
 * ## 为什么用这个形态
 *
 * 这五个问题的共同点是"**宿主半的真实语义**"（落盘、乐观锁、依赖门禁、prompt 组装），
 * 而不是 UI 像素。因此本脚本用**真实组件**、真实 fs、真实 `Board` / `BoardService` /
 * `createHostApi` 跑一遍，只有一个东西是桩：`dispatcher`（**刻意不真派子代理**，
 * 否则一次演练会真的去跑模型、耗 token、改代码）。
 *
 * 唯一接的"外部系统"是 TFS，而这里**完全不需要它**：
 *   - 领取走 `requirement` 对象 + `tag:false`（不打标签 ⇒ 无 TFS 写）；
 *   - 需求/任务的编辑只改本地补充字段（`prompt` / `workspace` / `frozenConfig`）。
 * 脚本对 adapter 的所有调用计数并断言为 **0**（沿用 real-chain.ts 的纪律）。
 *
 * ## 覆盖矩阵
 *
 * | 步骤 | 问题 | 断言 |
 * |---|---|---|
 * | 1 | 6 需求池领取带提示词+工作目录 | board.json 落盘且回读一致 |
 * | 2 | 3 已领取需求编辑 | 改 prompt/workspace 生效；相对路径被 fail-loud 拒绝 |
 * | 3 | 4 任务编辑 | prompt + frozenConfig(模型/技能/MCP) 生效；revision 乐观锁 |
 * | 4 | 3/4/6/1/5 派发 prompt 组装 | 顺序 = 工作目录 → 需求提示词 → 任务提示词 → 执行纪律/完成协议，需求改后实时生效 |
 * | 5 | 6 宿主自动链式 + 5 依赖门禁 | 提前派 impl 被拒且未触达 dispatcher；首批后由宿主钩子按 analyze→plan→impl→review→verify 自动拉起下游 |
 * | 6 | 7 重复项去重 | 跨 provider 同 id → 唯一选项；MultiSelect 折叠后无重复 chip |
 *
 * 运行：`node <repo>/node_modules/tsx/dist/cli.mjs scripts/e2e-004.ts`
 *
 * @module @deepseek-ai/dsh-tfs-requirment/scripts/e2e-004
 */

import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Board } from '../src/core/board/board.js'
import { BoardService, type BoardTfsPort } from '../src/host/board-service.js'
import { createHostApi } from '../src/host/api.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { realFs } from '../src/persistence/fs-like.js'
import { dedupeOptions } from '../src/client/components/MultiSelect.js'
import {
  groupModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from '../src/shared/model-route.js'
import type { DshModelOption, RoleDefinition } from '../src/shared/contracts.js'
import type { RequirementDispatcher } from '../src/orchestration/dispatch.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')
/** 演练数据目录（gitignored，且每次运行前清空，保证断言确定性）。 */
const DATA_DIR = join(pluginRoot, '.tfs-requirment-data', 'e2e-004')
/** 真实存在的目录（workspace 校验是 fail-loud 的：必须绝对路径 + 真实目录）。 */
const WORKSPACE_A = pluginRoot
const WORKSPACE_B = join(pluginRoot, 'src')

const REQUIREMENT_ID = 990004
const KEY = `${REQUIREMENT_ID}@WN_HIS`

const results: Array<{ step: string; ok: boolean; detail: string }> = []
let failures = 0

function line(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}

function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? '✅' : '❌'} [${step}] ${detail}`)
}

function show(label: string, value: unknown): void {
  console.log(`  · ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/** 记录 TFS 调用的 instrumented adapter（断言"演练不碰 TFS"）。 */
function instrumentAdapter(inner: TfsAdapter): { port: BoardTfsPort; calls: string[] } {
  const calls: string[] = []
  const port: BoardTfsPort = {
    getRequirement: (id, collection) => {
      calls.push('getRequirement')
      return inner.getRequirement(id, collection)
    },
    addTags: (id, collection, tags, before, confirmed) => {
      calls.push('addTags')
      return inner.addTags(id, collection, tags, before, confirmed)
    },
    removeTags: (id, collection, tags, confirmed) => {
      calls.push('removeTags')
      return inner.removeTags!(id, collection, tags, confirmed)
    },
    getQueryOptions: collection => {
      calls.push('getQueryOptions')
      return inner.getQueryOptions!(collection)
    },
  }
  return { port, calls }
}

/** 记录派发请求的桩 dispatcher（**不真派**子代理）。 */
function makeRecordingDispatcher(): {
  dispatcher: Pick<RequirementDispatcher, 'dispatch'>
  requests: Array<{ taskId: string; requirementId: string; prompt: string }>
} {
  const requests: Array<{ taskId: string; requirementId: string; prompt: string }> = []
  return {
    requests,
    dispatcher: {
      dispatch: async req => {
        requests.push({
          taskId: String(req.taskId ?? ''),
          requirementId: String(req.requirementId ?? ''),
          prompt: (req.prompt ?? []).map(b => (b.type === 'text' ? b.text : '')).join('\n'),
        })
        return {
          taskId: String(req.taskId ?? ''),
          requirementId: String(req.requirementId ?? ''),
          runId: `run-${String(requests.length)}`,
          provider: req.role.provider,
        }
      },
    },
  }
}

const ROLES: RoleDefinition[] = [
  {
    id: 'e2e-arch',
    name: '架构师',
    provider: 'spawn',
    defaultModel: 'm-default',
    defaultMcp: ['mcp-default'],
    defaultSkills: ['skill-default'],
  },
]

async function main(): Promise<void> {
  line('步骤 0｜准备：真实 Board/BoardService/createHostApi + 计数 adapter + 桩 dispatcher')
  if (existsSync(DATA_DIR)) rmSync(DATA_DIR, { recursive: true, force: true })
  mkdirSync(DATA_DIR, { recursive: true })
  check('S0', existsSync(WORKSPACE_A) && existsSync(WORKSPACE_B), `真实 workspace 存在：${WORKSPACE_A} / ${WORKSPACE_B}`)

  const audit = new AuditLog(DATA_DIR, realFs)
  const guard = new WriteGuard(audit)
  // 刻意**不传 rest**：本演练不应需要任何 TFS 凭据；真被调用会抛可读的"未配置"错误。
  const innerAdapter = new TfsAdapter({ writeGuard: guard, collection: 'WN_HIS', profileLabel: 'e2e' })
  const { port, calls: tfsCalls } = instrumentAdapter(innerAdapter)
  const boardService = new BoardService({
    baseDir: DATA_DIR,
    fs: realFs,
    board: new Board(),
    adapter: port,
    roles: { list: () => ROLES, getByName: n => ROLES.find(r => r.name === n) },
    defaultLabel: 'dsh',
  })
  const { dispatcher, requests } = makeRecordingDispatcher()
  const api = createHostApi({
    roles: {
      list: () => ROLES,
      getByName: n => ROLES.find(r => r.name === n),
      save: () => {},
      delete: () => true,
    },
    adapter: innerAdapter,
    dispatcher,
    board: boardService,
    getParent: () => ({}) as Agent,
    models: [],
    mcpServers: [],
    skills: [],
    tagSuggestions: ['dsh'],
    collection: 'WN_HIS',
    dispatchConcurrency: 3,
  })

  // ── 步骤 1：问题 6（领取入池带提示词 + 工作目录） ──
  line('步骤 1｜问题 6：领取入池带「增加提示词 + 工作目录」')
  const claim = await api.claimRequirement({
    requirement: {
      id: REQUIREMENT_ID,
      collection: 'WN_HIS',
      project: 'PEIS',
      title: 'E2E-004 需求',
      type: '需求',
      state: '活动',
      assignedTo: 'zhangbo3',
      priority: '2',
      areaPath: 'PEIS',
      iterationPath: 'Sprint 1',
      tags: [],
      changedDate: '2026-09-20T00:00:00Z',
      url: `http://tfs/wit/workItems/${REQUIREMENT_ID}`,
    },
    workspace: WORKSPACE_A,
    prompt: '需求级背景：只改后端，遵循 Tjgl 代码规范。',
    tag: false,
  })
  check('S1-a', claim.ok === true && claim.added === true, `领取成功（added=${String(claim.added)}）`)
  const afterClaim = api.getBoard().requirements.find(r => `${r.id}@${r.collection}` === KEY)
  check(
    'S1-b',
    afterClaim?.prompt === '需求级背景：只改后端，遵循 Tjgl 代码规范。' && afterClaim?.workspace === WORKSPACE_A,
    `看板回读 prompt/workspace 一致（prompt=${String(afterClaim?.prompt?.slice(0, 12))}… workspace=${String(afterClaim?.workspace)}）`,
  )
  const boardFile = join(DATA_DIR, 'board.json')
  const persisted = JSON.parse(readFileSync(boardFile, 'utf8')) as { requirements: Record<string, { prompt?: string }> }
  check(
    'S1-c',
    persisted.requirements[KEY]?.prompt === '需求级背景：只改后端，遵循 Tjgl 代码规范。',
    'JSON 权威：board.json 里确实落盘了 prompt（不是只活在内存）',
  )

  // ── 步骤 2：问题 3（已领取需求编辑） ──
  line('步骤 2｜问题 3：编辑已领取需求（提示词 / 工作目录）')
  const upd1 = await api.updateRequirement({ requirementKey: KEY, prompt: '需求级背景 v2', workspace: WORKSPACE_B })
  check('S2-a', upd1.ok === true, `编辑成功（reason=${String(upd1.reason ?? '—')}）`)
  const afterEdit = api.getBoard().requirements.find(r => `${r.id}@${r.collection}` === KEY)
  check(
    'S2-b',
    afterEdit?.prompt === '需求级背景 v2' && afterEdit?.workspace === WORKSPACE_B,
    `prompt/workspace 已更新（workspace=${String(afterEdit?.workspace)}）`,
  )
  const badWs = await api.updateRequirement({ requirementKey: KEY, workspace: 'relative/path' })
  check('S2-c', badWs.ok === false && (badWs.reason ?? '').includes('绝对路径'), `相对路径被 fail-loud 拒绝：${String(badWs.reason)}`)
  const cleared = await api.updateRequirement({ requirementKey: KEY, workspace: null })
  const afterClear = api.getBoard().requirements.find(r => `${r.id}@${r.collection}`)
  check(
    'S2-d',
    cleared.ok === true && afterClear?.workspace === undefined && afterClear?.prompt === '需求级背景 v2',
    'null=清空 workspace 且 prompt 不受影响（两种语义独立）',
  )
  // 复原，供后续步骤使用
  await api.updateRequirement({ requirementKey: KEY, workspace: WORKSPACE_A })

  // ── 步骤 3：问题 4（任务编辑） ──
  line('步骤 3｜问题 4：编辑拆解出的任务（提示词 / 模型 / 技能 / MCP / 工作目录）')
  const dec = await api.decomposeRequirement(KEY)
  check('S3-a', dec.ok === true && dec.created === 5, `拆解出 ${String(dec.created)} 个任务：${(dec.taskIds ?? []).join('、')}`)
  const implId = `${KEY}#impl`
  const analyzeId = `${KEY}#analyze`
  const before = api.getBoard().tasks.find(t => t.taskId === implId)!
  check('S3-b', before.prompt === undefined, '拆解出的任务初始无任务级提示词（需求提示词不被复制，避免两份真相）')
  const upTask = await api.updateTask({
    taskId: implId,
    prompt: '按分析结果实现，只跑单测。',
    model: 'm-impl',
    skills: ['skill-a', 'skill-b'],
    mcp: ['mcp-x'],
    expectedRevision: before.revision,
  })
  check('S3-c', upTask.ok === true, `编辑成功（reason=${String(upTask.reason ?? '—')}）`)
  const after = api.getBoard().tasks.find(t => t.taskId === implId)!
  show('frozenConfig', after.frozenConfig)
  check(
    'S3-d',
    after.prompt === '按分析结果实现，只跑单测。' &&
      after.frozenConfig.model === 'm-impl' &&
      after.frozenConfig.skills.join(',') === 'skill-a,skill-b' &&
      after.frozenConfig.mcp.join(',') === 'mcp-x',
    'prompt 与 frozenConfig 三件套均已生效',
  )
  const conflict = await api.updateTask({ taskId: implId, prompt: 'x', expectedRevision: 999 })
  check('S3-e', conflict.ok === false && (conflict.reason ?? '').includes('revision 冲突'), `乐观锁冲突被拒：${String(conflict.reason)}`)

  // ── 步骤 4：派发 prompt 三段式组装 ──
  line('步骤 4｜问题 3/4/6：派发 prompt 组装顺序（工作目录 → 需求提示词 → 任务提示词）')
  /**
   * 波次记录：第 1 波（analyze）在步骤 4 派发，后续波在步骤 5 派发 —— 两处共用一个数组，
   * 才能断言"整条依赖链的实际派发顺序"，而不是只看到后半段。
   */
  const waves: string[][] = []
  // 用 analyze 任务（依赖为空）做组装验证，避免触发依赖门禁。
  const analyzeTask = api.getBoard().tasks.find(t => t.taskId === analyzeId)!
  await api.updateTask({ taskId: analyzeId, prompt: '分析阶段：列出验收点。', expectedRevision: analyzeTask.revision })
  const okDispatch = await api.dispatch({
    draft: {
      roleName: '架构师',
      prompt: '（客户端不传有效 prompt）',
      frozenConfig: { mcp: [], skills: [], model: '' },
      permission: 'read-only',
      },
    targetWorkItem: KEY,
    collection: 'WN_HIS',
    taskId: analyzeId,
  })
  check('S4-a', okDispatch.ok === true, `依赖为空的 analyze 派发成功（runId=${String(okDispatch.runId)}）`)
  if (okDispatch.ok) waves.push([analyzeId])
  const prompt1 = requests[requests.length - 1]!.prompt
  show('prompt', prompt1.replace(/\n/g, ' ⏎ '))
  const iWs = prompt1.indexOf('【工作目录')
  const iReq = prompt1.indexOf('【需求提示词】')
  const iTask = prompt1.indexOf('分析阶段：列出验收点。')
  const iDisc = prompt1.indexOf('【执行纪律')
  check(
    'S4-b',
    iWs >= 0 && iReq > iWs && iTask > iReq && iDisc > iTask,
    '四段顺序正确（工作目录 → 需求提示词 → 任务提示词 → 执行纪律/完成协议）',
  )
  check('S4-c', prompt1.includes('需求级背景 v2'), '需求提示词为**当前值**（实时读取，未被冻结）')
  check(
    'S4-d',
    prompt1.includes('TASK_DONE') && prompt1.includes('NEEDS_HUMAN_CONFIRM'),
    '执行纪律段含完成 / 人工确认协议标记（问题 1/5 收口判据）',
  )

  // ── 步骤 5：问题 5（分波 + 依赖门禁） ──
  line('步骤 5｜问题 5：依赖门禁 + 勾选批量派发的分波顺序')
  // 5-1 先证明"不等依赖会被引擎拒绝"，且**不触达 dispatcher**（= 不会真的起子代理）。
  const beforeCount = requests.length
  const earlyImpl = await api.dispatch({
    draft: {
      roleName: '架构师',
      prompt: '',
      frozenConfig: { mcp: [], skills: [], model: '' },
      permission: 'read-only',
      },
    targetWorkItem: KEY,
    collection: 'WN_HIS',
    taskId: implId,
  })
  check(
    'S5-a',
    earlyImpl.ok === false && (earlyImpl.reason ?? '').includes('依赖未就绪'),
    `analyze 未完成时派发 impl 被拒：${String(earlyImpl.reason)}`,
  )
  check('S5-b', requests.length === beforeCount, '被拒的派发**没有**触达 dispatcher（不会凭空起一个子代理进程）')

  // 5-2 问题 6：宿主自动链式执行。首批只手动派发 analyze（步骤 4 已做），之后每收口一个任务，
  //     由宿主收口钩子（handleTaskSettled → boardService.autoStartRunnable → launchBoardTaskExecution）
  //     自动拉起并派发已就绪的下游——前端无需逐个点击、也不再靠 1.5s 轮询驱动 DAG。
  const stages = ['analyze', 'plan', 'impl', 'review', 'verify']
  const selected = stages.map(s => `${KEY}#${s}`)
  /** 让 queueMicrotask 收口钩子及其 fire-and-forget 派发跑完。 */
  const tick = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 30))
  for (let guard = 0; guard < 20; guard += 1) {
    const running = api.getBoard().tasks.filter(t => selected.includes(t.taskId) && t.execState === 'running')
    if (running.length === 0) break
    // 模拟子 run 成功回绑：把当前运行中的任务收口为 completed（success 才会触发自动链）。
    for (const t of running) api.setTaskState(t.taskId, 'complete')
    await tick()
  }

  // 真实派发顺序 = 桩 dispatcher 记录到的、属于本链的任务去重保序序列。
  const seenReq = new Set<string>()
  const order: string[] = []
  for (const r of requests) {
    if (!selected.includes(r.taskId) || seenReq.has(r.taskId)) continue
    seenReq.add(r.taskId)
    order.push(r.taskId.split('#')[1] ?? r.taskId)
  }
  check(
    'S5-e',
    order.join('>') === 'analyze>plan>impl>review>verify',
    `宿主自动链按依赖顺序派发 analyze>plan>impl>review>verify（实测 ${order.join('>')}）`,
  )
  const chainTasks = api.getBoard().tasks.filter(t => selected.includes(t.taskId))
  const allDone = chainTasks.every(t => t.state === 'completed')
  check('S5-f', allDone, '五个任务最终全部 completed（依赖链在宿主侧自动闭环，无需逐个点击）')
  // 首批 analyze 为手动启动（无自动标记）；下游四个均由宿主自动链式拉起（autoLaunched）。
  const autoStages = chainTasks.filter(t => t.autoLaunched === true).map(t => t.taskId.split('#')[1])
  const analyzeView = chainTasks.find(t => t.taskId === analyzeId)
  check(
    'S5-g',
    autoStages.join('>') === 'plan>impl>review>verify' && analyzeView?.autoLaunched !== true,
    `下游任务带 autoLaunched 标记（实测 ${autoStages.join('>')}），首批 analyze 为手动启动`,
  )

  // ── 步骤 6：spec 009（模型供应商路由 + 组内去重） ──
  line('步骤 6｜spec 009：模型按 provider 分组，跨 provider 同名保留、组内去重、复合值不丢供应商')
  const models: DshModelOption[] = []
  for (const p of ['deepseek-official', 'wincode', 'opencode', 'codex', 'claude', 'gemini']) {
    models.push({ provider: p, providerName: p, id: 'deepseek-v4-flash-0731', name: 'deepseek-v4-flash-0731' })
  }
  for (const p of ['deepseek-official', 'wincode', 'opencode']) {
    models.push({ provider: p, providerName: p, id: 'glm-5.3-flash', name: 'glm-5.3-flash' })
  }
  // 同一 provider 内的重复条目（目录本身可能重复）必须折叠。
  models.push({
    provider: 'deepseek-official',
    providerName: 'deepseek-official',
    id: 'deepseek-v4-flash-0731',
    name: 'deepseek-v4-flash-0731',
  })
  const groups = groupModelOptions(models)
  const values = groups.flatMap(g => g.items.map(m => modelOptionValue(m.provider, m.id)))
  show('原始条目', `${models.length} 条（含跨 provider 同名 9 条 + 1 条组内重复）`)
  show('分组后', groups.map(g => `${g.providerName}[${g.items.map(m => m.id).join(',')}]`))
  check('S6-a', groups.length === 6, `6 个 provider 各成一组（实测 ${groups.length}）`)
  check(
    'S6-b',
    values.length === 9 && new Set(values).size === 9,
    `跨 provider 同名保留为 9 个唯一复合选项、组内重复折叠（实测 ${values.length}）`,
  )
  // 复合值解码必须同时拿回 provider 与 id——旧裸值在点击瞬间丢供应商，是"选火山方舟跑英伟达"的根因。
  const decoded = parseModelOptionValue(values[0]!)
  check(
    'S6-c',
    !!decoded && decoded.id === 'deepseek-v4-flash-0731' && decoded.provider.length > 0,
    '复合值可解码回 provider + id（供应商不再丢失）',
  )
  // MultiSelect 入口去重仍用于技能 / MCP 下拉：同 value 折叠为一个 chip。
  const chips = dedupeOptions(
    Array.from({ length: 3 }, () => ({ value: 'x', label: 'X', hint: 'h' })),
  )
  check('S6-d', chips.length === 1, 'dedupeOptions 同一 value 只产出一个 chip（旧实现会产出同 key chip ⇒ 删不掉）')

  // ── 收尾 ──
  line('步骤 7｜隔离性断言：整个演练未触碰 TFS')
  check('S7', tfsCalls.length === 0, `adapter 调用次数 = ${tfsCalls.length}（期望 0；标签写入用 tag:false 显式关闭）`)

  line('结果汇总')
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.step}  ${r.detail}`)
  console.log(`\n合计 ${results.length} 项断言，失败 ${failures} 项。`)
  console.log(`演练数据目录：${DATA_DIR}`)
  if (failures > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('\n演练异常：', error)
  process.exitCode = 1
})

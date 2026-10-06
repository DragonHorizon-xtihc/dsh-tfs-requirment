import { describe, expect, it } from 'vitest'
import { Board, BoardError } from '../src/core/board/board.js'
import { decomposeRequirement } from '../src/core/board/decompose.js'
import { BoardService, summaryToRequirement } from '../src/host/board-service.js'
import type { BoardTfsPort } from '../src/host/board-service.js'
import type { RequirementSummary, RoleDefinition, UiState } from '../src/shared/contracts.js'
import type { Requirement } from '../src/tfs/types.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'
import { join } from 'node:path'

/**
 * specs/003 看板生命周期测试（问题 7/8/9/10 + 问题 1/2 的两个落盘 Store + 问题 11 enrich）。
 *
 * 与既有 board.spec.ts / board-service.spec.ts 的分工：
 *  - 本文件只覆盖**本轮新增**的引擎三方法（decomposeTasks 复活重建 / deleteTasks 整批门禁级联 /
 *    restoreRequirement 门禁级联）、BoardService 对应编排与中文结论、query-options.json /
 *    ui-state.json 两个落盘 Store、enrichRequirement 四段回写。
 * 全程内存 fs + 桩 adapter，不触碰真实磁盘/TFS。
 */

const ROLES: RoleDefinition[] = [
  { id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm1', defaultMcp: [], defaultSkills: [] },
  { id: 'r2', name: '开发', provider: 'spawn', defaultModel: 'm2' },
  { id: 'r3', name: '测试', provider: 'spawn', defaultModel: 'm3' },
  { id: 'r4', name: '需求分析师', provider: 'spawn', defaultModel: 'm0' },
  { id: 'r5', name: '代码审核工程师', provider: 'spawn', defaultModel: 'm4' },
]
/** 五段式阶段后缀（顺序即 DAG：分析→架构师拆解→开发→代码审核→测试）。 */
const STAGE_SUFFIXES = ['#analyze', '#plan', '#impl', '#review', '#verify'] as const
const rolesRepo = {
  list: () => ROLES,
  getByName: (n: string) => ROLES.find(r => r.name === n),
}

function summary(id: number, over: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id,
    collection: 'WN_HIS',
    project: 'PEIS',
    title: `需求 ${id}`,
    type: '产品需求',
    state: 'Active',
    assignedTo: 'zhangbo3',
    priority: '2',
    areaPath: 'PEIS',
    iterationPath: 'Sprint 1',
    tags: [],
    changedDate: '2026-09-17T00:00:00Z',
    url: `http://tfs/wit/workItems/${id}`,
    ...over,
  }
}

/** 领一个需求进看板，返回其 key 与五段式草稿。 */
function seedRequirement(board: Board, id: number): { key: string; drafts: ReturnType<typeof decomposeRequirement> } {
  const s = summary(id)
  const req = summaryToRequirement(s)
  board.claimRequirement(req)
  const key = `${id}@WN_HIS`
  // spec 008：decomposeRequirement 按「阶段 → 角色」映射出草稿（匹配在 BoardService 层完成）。
  return {
    key,
    drafts: decomposeRequirement(req as Requirement, {
      analyze: ROLES[3],
      plan: ROLES[0],
      impl: ROLES[1],
      review: ROLES[4],
      verify: ROLES[2],
    }),
  }
}

/** 取消（deleted）任务的合法路径：pending → finishTask('cancelled')。 */
function cancel(board: Board, taskId: string): void {
  const rev = board.snapshot.tasks[taskId]!.revision
  board.finishTask(taskId, 'cancelled', rev)
}

// ───────────────────────── 引擎：decomposeTasks（问题 9/10） ─────────────────────────

describe('Board.decomposeTasks（问题 9：已取消任务原地复活重建）', () => {
  it('首次拆解：五个任务全部新建（含代码审核段）', () => {
    const board = new Board()
    const { drafts } = seedRequirement(board, 1)
    const r = board.decomposeTasks(drafts)
    expect(r.created).toHaveLength(5)
    expect(r.skipped).toEqual([])
    expect(Object.keys(board.snapshot.tasks)).toHaveLength(5)
  })

  it('任务全部已取消后重新拆解：删旧历史、原地重建为全新 pending（不再被当"已存在"跳过）', () => {
    const board = new Board()
    const { key, drafts } = seedRequirement(board, 1997179)
    board.decomposeTasks(drafts)
    // 模拟现场：analyze 跑过一次，随后五个任务都被取消（state=deleted/execState=cancelled）。
    board.startTask(`${key}#analyze`, 0)
    for (const suffix of STAGE_SUFFIXES) {
      cancel(board, `${key}${suffix}`)
    }
    const cancelledTask = board.snapshot.tasks[`${key}#analyze`]!
    expect(cancelledTask.state).toBe('deleted')
    expect(cancelledTask.attempts.length).toBeGreaterThan(0)

    const r = board.decomposeTasks(drafts)
    expect(r.created).toHaveLength(5)
    expect(r.skipped).toEqual([])
    const reborn = board.snapshot.tasks[`${key}#analyze`]!
    expect(reborn.state).toBe('pending')
    expect(reborn.execState).toBe('queued')
    expect(reborn.attempts).toEqual([])
    expect(reborn.revision).toBe(0)
  })

  it('部分在办：已取消的复活、在办/已完成的跳过（计数与不覆盖运行成果）', () => {
    const board = new Board()
    const { key, drafts } = seedRequirement(board, 2)
    board.decomposeTasks(drafts)
    // analyze 完成；impl 取消；plan/review/verify 保持 pending。
    board.startTask(`${key}#analyze`, 0)
    board.finishTask(`${key}#analyze`, 'success', 1)
    cancel(board, `${key}#impl`)

    const r = board.decomposeTasks(drafts)
    expect(r.created.map(t => t.taskId).sort()).toEqual([`${key}#impl`])
    expect(r.skipped.sort()).toEqual([
      `${key}#analyze`,
      `${key}#plan`,
      `${key}#review`,
      `${key}#verify`,
    ])
    // 已完成任务的成果（revision/尝试记录）原封不动。
    expect(board.snapshot.tasks[`${key}#analyze`]!.state).toBe('completed')
  })

  it('草稿需求不存在 → BoardError（不半写）', () => {
    const board = new Board()
    const { drafts } = seedRequirement(board, 3)
    const bad = drafts.map(d => ({ ...d, requirementId: '999@WN_HIS' }))
    expect(() => board.decomposeTasks(bad)).toThrow(BoardError)
  })
})

// ───────────────────────── 引擎：deleteTasks（问题 8） ─────────────────────────

describe('Board.deleteTasks（问题 8：仅删已取消，整批门禁 + blockedBy 级联）', () => {
  it('任务不存在 / 非已取消 → 整批拒绝，错误带 id 清单，且不删任何任务', () => {
    const board = new Board()
    const { key, drafts } = seedRequirement(board, 4)
    board.decomposeTasks(drafts)
    const analyze = `${key}#analyze`
    const impl = `${key}#impl`
    cancel(board, analyze)

    expect(() => board.deleteTasks([analyze, 'nope@WN_HIS#verify'])).toThrow(/nope@WN_HIS#verify/)
    expect(() => board.deleteTasks([analyze, impl])).toThrow(impl)
    // 整批语义：连合法的那个也还在。
    expect(board.snapshot.tasks[analyze]).toBeDefined()
    expect(board.snapshot.tasks[impl]).toBeDefined()
  })

  it('空数组 → 拒绝', () => {
    const board = new Board()
    expect(() => board.deleteTasks([])).toThrow(BoardError)
  })

  it('全部已取消 → 删除并去重；其他任务 blockedBy 悬挂引用被级联清理', () => {
    const board = new Board()
    const a = seedRequirement(board, 10)
    board.decomposeTasks(a.drafts)
    const b = seedRequirement(board, 11)
    board.decomposeTasks(b.drafts)
    // B 的 analyze 依赖 A 的 verify（跨需求依赖）。
    const bAnalyze = `${b.key}#analyze`
    board.snapshot.tasks[bAnalyze]!.blockedBy.push(`${a.key}#verify`)
    // 取消 A 的五个任务并批量删除。
    for (const suffix of STAGE_SUFFIXES) cancel(board, `${a.key}${suffix}`)
    const deleted = board.deleteTasks(
      STAGE_SUFFIXES.map(s => `${a.key}${s}`).concat([`${a.key}#verify`]),
    )
    expect(deleted.sort()).toEqual(STAGE_SUFFIXES.map(s => `${a.key}${s}`).sort())
    expect(board.snapshot.tasks[`${a.key}#analyze`]).toBeUndefined()
    // 级联：B 的悬挂依赖被清掉，任务本身保留。
    expect(board.snapshot.tasks[bAnalyze]!.blockedBy).toEqual([])
    expect(board.snapshot.tasks[bAnalyze]).toBeDefined()
  })
})

// ───────────────────────── 引擎：restoreRequirement（问题 7） ─────────────────────────

describe('Board.restoreRequirement（问题 7：还原到需求池）', () => {
  it('名下仍有非 deleted 任务 → 拒绝', () => {
    const board = new Board()
    const { key, drafts } = seedRequirement(board, 20)
    board.decomposeTasks(drafts)
    expect(() => board.restoreRequirement(key)).toThrow(/请先取消/)
    expect(board.snapshot.requirements[key]).toBeDefined()
  })

  it('需求不在本地池 → 拒绝', () => {
    const board = new Board()
    expect(() => board.restoreRequirement('404@WN_HIS')).toThrow(/需求不在本地池/)
  })

  it('无任务或仅剩已取消任务 → 移除需求与已取消任务，级联清 blockedBy', () => {
    const board = new Board()
    const a = seedRequirement(board, 21)
    board.decomposeTasks(a.drafts)
    const b = seedRequirement(board, 22)
    board.decomposeTasks(b.drafts)
    board.snapshot.tasks[`${b.key}#analyze`]!.blockedBy.push(`${a.key}#verify`)
    for (const suffix of STAGE_SUFFIXES) cancel(board, `${a.key}${suffix}`)

    const removed = board.restoreRequirement(a.key)
    expect(removed.sort()).toEqual(STAGE_SUFFIXES.map(s => `${a.key}${s}`).sort())
    expect(board.snapshot.requirements[a.key]).toBeUndefined()
    expect(board.snapshot.tasks[`${a.key}#analyze`]).toBeUndefined()
    expect(board.snapshot.tasks[`${b.key}#analyze`]!.blockedBy).toEqual([])
    // B 不受影响。
    expect(board.snapshot.requirements[b.key]).toBeDefined()
  })
})

// ───────────────────── BoardService：编排、中文结论、落盘事件 ─────────────────────

interface StubAdapter extends BoardTfsPort {
  /** 记录每次抽标签调用，含 `confirmed`（2026-10-04 起抽标签同样过人工确认门禁）。 */
  removeTagCalls: Array<{ id: number; collection: string; tags: string[]; confirmed: boolean }>
  removeTagsShouldFail?: boolean
  freshSummary?: RequirementSummary
}

function makeStubAdapter(): StubAdapter {
  return {
    removeTagCalls: [],
    async getRequirement(id, collection) {
      return (
        this.freshSummary ??
        summary(id, { collection: collection ?? 'WN_HIS' })
      )
    },
    async addTags() {
      return { ok: true }
    },
    async removeTags(id, collection, tags, confirmed) {
      this.removeTagCalls.push({
        id: Number(id),
        collection: collection ?? 'WN_HIS',
        tags,
        confirmed: confirmed === true,
      })
      if (this.removeTagsShouldFail) throw new Error('TFS 500')
      return { id: Number(id), tags: [] }
    },
  }
}

function makeService(adapter?: StubAdapter, fs?: MemFs): { svc: BoardService; fs: MemFs; adapter: StubAdapter } {
  const memFs = fs ?? createMemFs()
  const ad = adapter ?? makeStubAdapter()
  const svc = new BoardService({
    baseDir: 'C:/data',
    fs: memFs,
    board: new Board(),
    adapter: ad,
    roles: rolesRepo,
    defaultLabel: 'dsh',
  })
  return { svc, fs: memFs, adapter: ad }
}

async function seedViaService(svc: BoardService, id: number): Promise<string> {
  const r = await svc.claimRequirement({ id })
  expect(r.ok).toBe(true)
  return `${id}@WN_HIS`
}

describe('BoardService.decompose（问题 9/10：中文结论 + 计数 + 落事件）', () => {
  it('全新拆解：reason 只报新增数（五段 5 个任务）', async () => {
    const { svc } = makeService()
    const key = await seedViaService(svc, 30)
    const r = svc.decompose(key)
    expect(r.ok).toBe(true)
    expect(r.created).toBe(5)
    expect(r.skipped).toBe(0)
    expect(r.reason).toBe(`已拆解 ${key}：新增 5 个任务`)
  })

  it('全部已存在：reason 报全部跳过，created=0', async () => {
    const { svc } = makeService()
    const key = await seedViaService(svc, 31)
    svc.decompose(key)
    const again = svc.decompose(key)
    expect(again.created).toBe(0)
    expect(again.skipped).toBe(5)
    expect(again.reason).toContain('均已存在，全部跳过')
  })

  it('已取消后重新拆解：reason 报新增（复活），任务列表实时可见', async () => {
    const { svc } = makeService()
    const key = await seedViaService(svc, 1997179)
    svc.decompose(key)
    for (const suffix of STAGE_SUFFIXES) {
      svc.setTaskState(`${key}${suffix}`, 'cancel')
    }
    const r = svc.decompose(key)
    expect(r.created).toBe(5)
    expect(r.skipped).toBe(0)
    // 问题 10：拆解结果即时进入快照（无需重新加载）。
    const snap = svc.snapshot()
    expect(snap.tasks).toHaveLength(5)
    expect(snap.tasks.every(t => t.state === 'pending')).toBe(true)
    expect(svc.replayEvents().some(e => e.action === 'decompose')).toBe(true)
  })

  it('需求未领取 → ok:false 可读原因', () => {
    const { svc } = makeService()
    expect(svc.decompose('999@WN_HIS').ok).toBe(false)
  })
})

describe('BoardService.deleteTasks（问题 8 服务层）', () => {
  it('批量删除已取消任务并落事件；非法整批拒绝', async () => {
    const { svc } = makeService()
    const key = await seedViaService(svc, 40)
    svc.decompose(key)
    // 含在办任务 → 整批拒绝。
    const blocked = svc.deleteTasks([`${key}#analyze`, `${key}#impl`])
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('已取消')
    // 全部取消 → 删除成功。
    for (const suffix of STAGE_SUFFIXES) svc.setTaskState(`${key}${suffix}`, 'cancel')
    const ok = svc.deleteTasks(STAGE_SUFFIXES.map(s => `${key}${s}`))
    expect(ok.ok).toBe(true)
    expect(ok.count).toBe(5)
    expect(svc.snapshot().tasks).toHaveLength(0)
    expect(svc.replayEvents().some(e => e.action === 'task-delete')).toBe(true)
  })

  it('空选择 → ok:false', () => {
    const { svc } = makeService()
    expect(svc.deleteTasks([]).ok).toBe(false)
  })
})

describe('BoardService.restoreRequirement（问题 7 服务层：含 TFS 标签 best-effort）', () => {
  it('有在办任务 → 拒绝且不调用 TFS', async () => {
    const { svc, adapter } = makeService()
    const key = await seedViaService(svc, 50)
    svc.decompose(key)
    const r = await svc.restoreRequirement(key)
    expect(r.ok).toBe(false)
    expect(adapter.removeTagCalls).toHaveLength(0)
  })

  it('全部取消后还原：需求移除、调用 removeTags 摘 dsh 标签、落事件', async () => {
    const { svc, adapter } = makeService()
    const key = await seedViaService(svc, 51)
    svc.decompose(key)
    for (const suffix of STAGE_SUFFIXES) svc.setTaskState(`${key}${suffix}`, 'cancel')
    const r = await svc.restoreRequirement(key)
    expect(r.ok).toBe(true)
    expect(r.removedTasks).toHaveLength(5)
    expect(r.tagWarning).toBeUndefined()
    // `confirmed: true` 是本次修复的关键断言：「还原到需求池」是用户显式操作，
    // 必须被当作人工确认传给写门禁，否则抽标签会被门禁 2 直接拒掉。
    expect(adapter.removeTagCalls).toEqual([
      { id: 51, collection: 'WN_HIS', tags: ['dsh'], confirmed: true },
    ])
    expect(svc.snapshot().requirements.find(x => x.id === 51)).toBeUndefined()
    expect(svc.replayEvents().some(e => e.action === 'requirement-restore')).toBe(true)
  })

  it('摘标签失败不阻断还原：ok:true 且回带 tagWarning', async () => {
    const adapter = makeStubAdapter()
    adapter.removeTagsShouldFail = true
    const { svc } = makeService(adapter)
    const key = await seedViaService(svc, 52)
    const r = await svc.restoreRequirement(key)
    expect(r.ok).toBe(true)
    expect(r.tagWarning).toContain('TFS 500')
    expect(svc.snapshot().requirements.find(x => x.id === 52)).toBeUndefined()
  })
})

// ───────────────────── 两个落盘 Store（问题 1/2/4/6） ─────────────────────

describe('BoardService 可选项落盘（问题 1：query-options.json）', () => {
  it('采集后落盘；load 读回同一内容并带 savedAt；按集合隔离', async () => {
    const data = {
      projects: [{ value: 'EAHis', label: 'EAHis' }],
      types: [{ value: '产品需求', label: '产品需求' }],
      states: [],
      assignees: [],
    }
    const adapter = {
      async getQueryOptions() {
        return data
      },
    }
    const svc2 = new BoardService({
      baseDir: 'C:/q',
      fs: createMemFs(),
      board: new Board(),
      adapter: adapter as unknown as BoardTfsPort,
      roles: rolesRepo,
      defaultLabel: 'dsh',
    })
    const w = await svc2.collectQueryOptions('WN_HIS')
    expect(w.ok).toBe(true)
    const hit = svc2.loadQueryOptions('WN_HIS')
    expect(hit.data).toStrictEqual(data)
    expect(typeof hit.savedAt).toBe('string')
    // 另一集合无缓存。
    expect(svc2.loadQueryOptions('OTHER').data).toBeNull()
  })

  it('全空结果不落盘（一次抖动不锁死空下拉）', async () => {
    const adapter = {
      async getQueryOptions() {
        return { projects: [], types: [], states: [], assignees: [] }
      },
    }
    const svc = new BoardService({
      baseDir: 'C:/q2',
      fs: createMemFs(),
      board: new Board(),
      adapter: adapter as unknown as BoardTfsPort,
      roles: rolesRepo,
      defaultLabel: 'dsh',
    })
    const w = await svc.collectQueryOptions('WN_HIS')
    expect(w.ok).toBe(true)
    expect(svc.loadQueryOptions('WN_HIS').data).toBeNull()
  })

  it('落盘文件损坏 → load 返回 data=null（不抛错、不锁死）', () => {
    const fs = createMemFs()
    const svc = new BoardService({
      baseDir: 'C:/q3',
      fs,
      board: new Board(),
      adapter: makeStubAdapter(),
      roles: rolesRepo,
      defaultLabel: 'dsh',
    })
    fs.writeFileSync(join('C:/q3', 'query-options.json'), '{ broken json', 'utf8')
    expect(svc.loadQueryOptions('WN_HIS').data).toBeNull()
  })
})

describe('BoardService UI 状态落盘（问题 2/4/6：ui-state.json 筛选记忆与每页条数）', () => {
  it('缺省空对象；保存按集合浅合并、poolFilters 整体替换；两集合隔离', () => {
    const { svc } = makeService()
    expect(svc.loadUiState('WN_HIS')).toEqual({})
    const first: Partial<UiState> = {
      poolFilters: { projects: ['EAHis'], types: ['产品需求'], states: ['活动'], assignedTo: ['zhangbo3'] },
      poolPageSize: 50,
    }
    expect(svc.saveUiState(first, 'WN_HIS').ok).toBe(true)
    // 再存另一个键：浅合并不丢 poolPageSize；poolFilters 整体替换。
    const second = svc.saveUiState(
      { poolFilters: { projects: ['EDIS'] }, taskPageSize: 100 },
      'WN_HIS',
    )
    expect(second.ok).toBe(true)
    const got = svc.loadUiState('WN_HIS')
    expect(got.poolPageSize).toBe(50)
    expect(got.taskPageSize).toBe(100)
    expect(got.poolFilters?.projects).toEqual(['EDIS'])
    expect(got.poolFilters?.types).toBeUndefined()
    // 另一集合互不干扰。
    expect(svc.loadUiState('OTHER')).toEqual({})
    svc.saveUiState({ claimedPageSize: 5 }, 'OTHER')
    expect(svc.loadUiState('OTHER').claimedPageSize).toBe(5)
    expect(svc.loadUiState('WN_HIS').claimedPageSize).toBeUndefined()
  })

  it('落盘文件损坏 → load 返回空对象（客户端回退默认值）', () => {
    const fs = createMemFs()
    const svc = new BoardService({
      baseDir: 'C:/ui',
      fs,
      board: new Board(),
      adapter: makeStubAdapter(),
      roles: rolesRepo,
      defaultLabel: 'dsh',
    })
    fs.writeFileSync(join('C:/ui', 'ui-state.json'), 'not-json{', 'utf8')
    expect(svc.loadUiState('WN_HIS')).toEqual({})
  })
})

// ───────────────────── enrichRequirement（问题 11：四段正文回写） ─────────────────────

describe('BoardService.enrichRequirement（问题 11：重取并回写四段正文）', () => {
  it('重取后 description/analysis/dataStructure/config 全部回写，workspace 保留', async () => {
    const adapter = makeStubAdapter()
    const { svc } = makeService(adapter)
    const key = await seedViaService(svc, 60)
    // 领取时桩只给裸摘要（四段为空，复刻现场 board.json 无 description 的情形）。
    expect(svc.snapshot().requirements.find(r => r.id === 60)!.description).toBeUndefined()
    // 给本地需求挂一个 workspace（本地字段，enrich 不得覆盖）。
    svc.board.updateRequirement(summaryToRequirement({ ...summary(60), workspace: 'D:/repo' }))
    // 随后 TFS 上四段正文齐备（重取拿到新值）。
    adapter.freshSummary = summary(60, {
      description: '详细信息正文（799 字符的那段）',
      analysis: '需求分析正文',
      dataStructure: '数据结构正文',
      config: '需求配置正文',
    })

    const r = await svc.enrichRequirement(key)
    expect(r.ok).toBe(true)
    const after = svc.snapshot().requirements.find(x => x.id === 60)!
    expect(after.description).toContain('详细信息正文')
    expect(after.analysis).toBe('需求分析正文')
    expect(after.dataStructure).toBe('数据结构正文')
    expect(after.config).toBe('需求配置正文')
    expect(after.workspace).toBe('D:/repo')
    expect(svc.replayEvents().some(e => e.action === 'requirement-enrich')).toBe(true)
  })

  it('需求不在本地池 → ok:false', async () => {
    const { svc } = makeService()
    const r = await svc.enrichRequirement('404@WN_HIS')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('需求不在本地池')
  })
})

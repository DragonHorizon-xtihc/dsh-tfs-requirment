import { describe, expect, it } from 'vitest'
import { Board, BoardError } from '../src/core/board/board.js'
import { BoardService } from '../src/host/board-service.js'
import { createHostApi } from '../src/host/api.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'
import { makeFakeRest, type FakeRest } from './helpers/fake-rest.js'
import type { BoardTfsPort } from '../src/host/board-service.js'
import type { RequirementSummary, RoleDefinition } from '../src/shared/contracts.js'
import type { RequirementDispatcher } from '../src/orchestration/dispatch.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { buildExecBudgetSection } from '../src/shared/exec-protocol.js'

/**
 * 编辑能力（问题 3/4/6）三层验证：
 *
 * - **引擎层** `Board.updateTask`：字段语义（不传=不动 / `null`=清空）、revision 乐观锁、终态拒改；
 * - **服务层** `BoardService`：需求/任务的本地字段落盘与 fail-loud 工作目录校验；
 * - **编排层** `api.dispatch`：三段式 prompt 组装（工作目录 → 需求级提示词 → 任务级正文），
 *   且需求级提示词**实时读取**（改了立刻对未派发任务生效）。
 *
 * 全程内存 fs + 桩 adapter，不触碰真实磁盘/TFS。
 */

const ROLES: RoleDefinition[] = [{ id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm1' }]

/** 记录写调用的桩 adapter（领取要打标签）。 */
function makeAdapter(): BoardTfsPort {
  return {
    async getRequirement(id, collection) {
      return summary(id, collection ?? 'WN_HIS')
    },
    async addTags() {
      return { ok: true }
    },
  }
}

function summary(id: number, collection = 'WN_HIS', over: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id,
    collection,
    project: 'PEIS',
    title: `需求 ${id}`,
    type: '需求',
    state: '活动',
    assignedTo: 'zhangbo3',
    priority: '2',
    areaPath: 'PEIS',
    iterationPath: 'Sprint 1',
    tags: [],
    changedDate: '2026-09-20T00:00:00Z',
    url: `http://tfs/wit/workItems/${id}`,
    ...over,
  }
}

function makeService(): BoardService {
  return new BoardService({
    baseDir: '/mem/edit',
    fs: createMemFs(),
    board: new Board(),
    adapter: makeAdapter(),
    roles: { list: () => ROLES, getByName: n => ROLES.find(r => r.name === n) },
    defaultLabel: 'dsh',
  })
}

// ───────────────────────── 引擎层：Board.updateTask ─────────────────────────

describe('Board.updateTask（问题 4：任务字段编辑）', () => {
  function seeded(): Board {
    const b = new Board()
    b.claimRequirement({
      workItemId: 100,
      collection: 'WN_HIS',
      project: 'PEIS',
      title: 'T',
      state: '活动',
      assignedTo: 'u',
      priority: '2',
      iteration: 'S1',
      tags: [],
      createdAt: '',
      updatedAt: '',
      revision: 0,
    })
    b.addTask({
      taskId: '100@WN_HIS#impl',
      requirementId: '100@WN_HIS',
      idempotencyKey: 'k',
      title: '实现',
      description: 'desc',
      roleAgent: '架构师',
      frozenConfig: { mcp: ['tfs-mcp'], skills: [], model: 'm1' },
    })
    return b
  }

  it('改 prompt / frozenConfig / workspace 并 bump revision', () => {
    const b = seeded()
    const next = b.updateTask(
      '100@WN_HIS#impl',
      {
        prompt: '只跑单测',
        workspace: 'D:\\repo',
        frozenConfig: { mcp: ['a', 'b'], skills: ['s1'], model: 'm2' },
      },
      0,
    )
    expect(next.prompt).toBe('只跑单测')
    expect(next.workspace).toBe('D:\\repo')
    expect(next.frozenConfig).toEqual({ mcp: ['a', 'b'], skills: ['s1'], model: 'm2' })
    expect(next.revision).toBe(1)
  })

  it('null = 清空；undefined/缺省 = 不动（必须能区分，否则删不掉已填提示词）', () => {
    const b = seeded()
    b.updateTask('100@WN_HIS#impl', { prompt: 'x', workspace: 'D:\\repo' }, 0)
    const cleared = b.updateTask('100@WN_HIS#impl', { prompt: null }, 1)
    expect(cleared.prompt).toBeUndefined()
    expect(cleared.workspace).toBe('D:\\repo')
    expect(cleared.revision).toBe(2)
  })

  it('空串视同清空（用户在 UI 里清空文本框）', () => {
    const b = seeded()
    b.updateTask('100@WN_HIS#impl', { prompt: 'x' }, 0)
    const cleared = b.updateTask('100@WN_HIS#impl', { prompt: '   ' }, 1)
    expect(cleared.prompt).toBeUndefined()
  })

  it('无实际变化时不 bump revision（不制造无意义的乐观锁版本）', () => {
    const b = seeded()
    b.updateTask('100@WN_HIS#impl', { prompt: 'x' }, 0)
    const same = b.updateTask('100@WN_HIS#impl', { prompt: 'x' }, 1)
    expect(same.revision).toBe(1)
  })

  it('revision 冲突抛错（S-11 禁自动覆盖）', () => {
    const b = seeded()
    expect(() => b.updateTask('100@WN_HIS#impl', { prompt: 'x' }, 99)).toThrowError(/revision 冲突/)
  })

  it('未知任务抛错', () => {
    const b = seeded()
    expect(() => b.updateTask('nope', { prompt: 'x' }, 0)).toThrowError(/未知任务/)
  })

  it('已取消（终态）任务拒改', () => {
    const b = seeded()
    b.finishTask('100@WN_HIS#impl', 'cancelled', 0)
    expect(() => b.updateTask('100@WN_HIS#impl', { prompt: 'x' }, 1)).toThrowError(/已取消（终态）/)
  })

  it('frozenConfig 结构非法抛 BoardError（非字符串数组 / 非字符串 model）', () => {
    const b = seeded()
    expect(() =>
      b.updateTask('100@WN_HIS#impl', { frozenConfig: { mcp: [1 as unknown as string], skills: [], model: 'm' } }, 0),
    ).toThrowError(BoardError)
    expect(() =>
      b.updateTask('100@WN_HIS#impl', { frozenConfig: { mcp: [], skills: [], model: 7 as unknown as string } }, 0),
    ).toThrowError(/model 必须是字符串/)
  })

  it('frozenConfig 是整体替换语义（未传的字段由调用方补齐，引擎不做部分合并）', () => {
    const b = seeded()
    const next = b.updateTask('100@WN_HIS#impl', { frozenConfig: { mcp: [], skills: [], model: '' } }, 0)
    expect(next.frozenConfig).toEqual({ mcp: [], skills: [], model: '' })
  })

  it('spec 009：modelProvider 与 model 成对落盘并 bump revision', () => {
    const b = seeded()
    const next = b.updateTask(
      '100@WN_HIS#impl',
      { frozenConfig: { mcp: [], skills: [], model: 'deepseek-v4-flash', modelProvider: 'arkcode' } },
      0,
    )
    expect(next.frozenConfig).toEqual({
      mcp: [],
      skills: [],
      model: 'deepseek-v4-flash',
      modelProvider: 'arkcode',
    })
    expect(next.revision).toBe(1)
  })

  it('spec 009：modelProvider trim 后为空串不写 JSON 键（保持旧数据形状）', () => {
    const b = seeded()
    const next = b.updateTask(
      '100@WN_HIS#impl',
      { frozenConfig: { mcp: [], skills: [], model: 'm1', modelProvider: '   ' } },
      0,
    )
    expect(next.frozenConfig).toEqual({ mcp: [], skills: [], model: 'm1' })
    expect(next.frozenConfig).not.toHaveProperty('modelProvider')
  })

  it('spec 009：modelProvider 非字符串抛 BoardError', () => {
    const b = seeded()
    expect(() =>
      b.updateTask(
        '100@WN_HIS#impl',
        { frozenConfig: { mcp: [], skills: [], model: 'm', modelProvider: 7 as unknown as string } },
        0,
      ),
    ).toThrowError(/modelProvider 必须是字符串/)
  })

  it('spec 009：重写冻结配置不带 modelProvider 时，旧供应商键被移除（整体替换）', () => {
    const b = seeded()
    b.updateTask(
      '100@WN_HIS#impl',
      { frozenConfig: { mcp: [], skills: [], model: 'm1', modelProvider: 'arkcode' } },
      0,
    )
    const cleared = b.updateTask('100@WN_HIS#impl', { frozenConfig: { mcp: [], skills: [], model: 'm1' } }, 1)
    expect(cleared.frozenConfig).toEqual({ mcp: [], skills: [], model: 'm1' })
    expect(cleared.frozenConfig).not.toHaveProperty('modelProvider')
  })
})

// ───────────────────────── 服务层：BoardService ─────────────────────────

describe('BoardService · 需求/任务本地字段编辑（问题 3/4/6）', () => {
  it('领取时带 prompt → 落盘并可从快照回读（跨重启保留）', async () => {
    const svc = makeService()
    const r = await svc.claimRequirement({ requirement: summary(101), prompt: '本次只改后端' })
    expect(r.ok).toBe(true)
    const snap = svc.snapshot()
    expect(snap.requirements[0]!.prompt).toBe('本次只改后端')
    // JSON 权威：board.json 里确实写进去了（不是只活在内存快照里）。
    const raw = JSON.stringify(snap)
    expect(raw).toContain('本次只改后端')
    expect(svc.readMarkdown() ?? '').toContain('需求 101')
  })

  it('领取时空 prompt 不写入该键（不在 board.json 留空字段）', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(102), prompt: '   ' })
    expect(svc.snapshot().requirements[0]!.prompt).toBeUndefined()
  })

  it('updateRequirementMeta 改 prompt / workspace 并落盘', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(103) })
    const r = svc.updateRequirementMeta('103@WN_HIS', { prompt: '背景说明', workspace: 'D:\\repo' })
    expect(r.ok).toBe(true)
    expect(r.requirement?.prompt).toBe('背景说明')
    expect(r.requirement?.workspace).toBe('D:\\repo')
  })

  it('updateRequirementMeta：workspace 用 null 清空，prompt 不传则不动（两者语义独立）', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(104) })
    svc.updateRequirementMeta('104@WN_HIS', { prompt: 'p', workspace: 'D:\\repo' })
    const r = svc.updateRequirementMeta('104@WN_HIS', { workspace: null })
    expect(r.ok).toBe(true)
    expect(r.requirement?.workspace).toBeUndefined()
    expect(r.requirement?.prompt).toBe('p')
  })

  it('updateRequirementMeta：相对路径被 fail-loud 拒绝（与领取同一口径）', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(105) })
    const r = svc.updateRequirementMeta('105@WN_HIS', { workspace: 'repo/relative' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('绝对路径')
  })

  it('updateRequirementMeta：需求不在池中 → 拒绝', () => {
    const svc = makeService()
    const r = svc.updateRequirementMeta('999@WN_HIS', { prompt: 'x' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不在本地池')
  })

  it('updateTask：改 frozenConfig 三件套 + prompt，且部分传参时其余字段保持原值', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(106) })
    svc.decompose('106@WN_HIS')
    const taskId = '106@WN_HIS#impl'
    const r = svc.updateTask(taskId, { prompt: '按分析结果实现', model: 'm-new' })
    expect(r.ok).toBe(true)
    expect(r.task?.prompt).toBe('按分析结果实现')
    expect(r.task?.frozenConfig.model).toBe('m-new')
    // 拆解时由角色带入的 defaultMcp 不被这次"只改 model"清空。
    expect(r.task?.frozenConfig.mcp).toEqual([])
  })

  it('updateTask：revision 冲突返回可读原因（不抛到路由层）', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(107) })
    svc.decompose('107@WN_HIS')
    const r = svc.updateTask('107@WN_HIS#impl', { prompt: 'x' }, 99)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('revision 冲突')
  })

  it('spec 009：updateTask 的 modelProvider 与 model 成对透传；空串清空供应商但不动 model', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(109) })
    svc.decompose('109@WN_HIS')
    const taskId = '109@WN_HIS#impl'
    const r = svc.updateTask(taskId, { model: 'deepseek-v4-flash', modelProvider: '  arkcode  ' })
    expect(r.ok).toBe(true)
    expect(r.task?.frozenConfig.model).toBe('deepseek-v4-flash')
    expect(r.task?.frozenConfig.modelProvider).toBe('arkcode')
    // 只传 provider：model 沿用现值（服务层禁止产出"有 provider 没 model"的悬空路由）。
    const r2 = svc.updateTask(taskId, { modelProvider: 'nvida' })
    expect(r2.ok).toBe(true)
    expect(r2.task?.frozenConfig).toMatchObject({ model: 'deepseek-v4-flash', modelProvider: 'nvida' })
    // 显式空串 = 清空供应商；model 保持现值。
    const r3 = svc.updateTask(taskId, { modelProvider: '' })
    expect(r3.ok).toBe(true)
    expect(r3.task?.frozenConfig.model).toBe('deepseek-v4-flash')
    expect(r3.task?.frozenConfig.modelProvider).toBeUndefined()
  })

  it('decompose 后任务不带 prompt（需求级提示词不复制进任务，避免两份真相）', async () => {
    const svc = makeService()
    await svc.claimRequirement({ requirement: summary(108), prompt: '需求级背景' })
    svc.decompose('108@WN_HIS')
    for (const t of svc.snapshot().tasks) expect(t.prompt).toBeUndefined()
  })
})

// ───────────────────────── 编排层：api.dispatch 三段式 prompt ─────────────────────────

describe('api.dispatch · 三段式 prompt 组装（问题 3/4/6/8）', () => {
  let rest: FakeRest

  /** 只看 dispatch 需要的两个面：快照（任务+需求）与 setTaskState。 */
  function boardStub(opts: {
    requirements?: Record<string, { prompt?: string }>
    tasks?: Array<{ taskId: string; title?: string; description?: string; workspace?: string; prompt?: string }>
  }): BoardService {
    return {
      snapshot: () => ({ tasks: opts.tasks ?? [] }),
      setTaskState: () => ({ ok: true }),
      // spec 006：launchRun 落定链路用到的新方法（本文件只测 prompt 组装，给 no-op 桩）。
      bindRun: () => ({ ok: true }),
      settleTask: () => ({ ok: true }),
      openFollowUp: () => ({ ok: true }),
      // 问题 6：无 taskId 的派发会先登记一条手工看板任务（本文件用例均带 taskId，这里给桩以防漏网）。
      createManualTask: () => ({ ok: true, taskId: '200@WN_HIS#manual-架构师' }),
      board: { snapshot: { requirements: opts.requirements ?? {} } },
    } as unknown as BoardService
  }

  function makeApi(board: BoardService): { api: ReturnType<typeof createHostApi>; dispatched: () => unknown } {
    const fs = createMemFs()
    const guard = new WriteGuard(new AuditLog('/mem/audit2', fs))
    rest = makeFakeRest({ '_apis/projects': { value: [] }, '_apis/wit/workitems/': { id: 0, rev: 1 } })
    const adapter = new TfsAdapter({ rest: rest.config, writeGuard: guard, collection: 'WN_HIS', profileLabel: 'x' })
    let captured: unknown = null
    const dispatcher: Pick<RequirementDispatcher, 'dispatch'> = {
      dispatch: async req => {
        captured = req
        return { taskId: req.taskId, requirementId: req.requirementId, runId: 'r', provider: req.role.provider }
      },
    }
    const api = createHostApi({
      roles: {
        list: () => ROLES,
        getByName: n => ROLES.find(r => r.name === n),
        save: () => {},
        delete: () => true,
      },
      adapter,
      dispatcher,
      board,
      getParent: () => ({}) as Agent,
      models: [],
      mcpServers: [],
      skills: [],
      tagSuggestions: [],
      collection: 'WN_HIS',
    })
    return { api, dispatched: () => captured }
  }

  const textOf = (v: unknown): string => {
    const req = v as { prompt: Array<{ type: string; text: string }> }
    return req.prompt.map(b => b.text).join('\n')
  }

  const TASK_ID = '200@WN_HIS#impl'

  it('顺序恒为 工作目录 → 需求提示词 → 任务提示词', async () => {
    const board = boardStub({
      requirements: { '200@WN_HIS': { prompt: '需求级背景' } },
      tasks: [{ taskId: TASK_ID, title: '实现', description: 'd', workspace: 'D:\\repo', prompt: '任务级指令' }],
    })
    const { api, dispatched } = makeApi(board)
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '（客户端不传有效 prompt）',
        frozenConfig: { mcp: [], skills: [], model: 'm1' },
        permission: 'read-only',
        },
      targetWorkItem: '200@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK_ID,
    })
    expect(r.ok).toBe(true)
    const text = textOf(dispatched())
    expect(text).toContain('【工作目录')
    expect(text).toContain('【需求提示词】')
    expect(text.indexOf('【工作目录')).toBeLessThan(text.indexOf('【需求提示词】'))
    expect(text.indexOf('【需求提示词】')).toBeLessThan(text.indexOf('任务级指令'))
    // 任务级提示词存在时，不掺入 title/description（避免噪声）。
    expect(text).not.toContain('实现\nd')
  })

  it('任务无 prompt → 回落 title + description（不产出空 prompt）', async () => {
    const board = boardStub({
      requirements: {},
      tasks: [{ taskId: TASK_ID, title: '实现', description: '按分析落地' }],
    })
    const { api, dispatched } = makeApi(board)
    await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '',
        frozenConfig: { mcp: [], skills: [], model: 'm1' },
        permission: 'read-only',
        },
      targetWorkItem: '200@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK_ID,
    })
    // 问题 1/5：正文后固定追加「执行纪律 + 完成/人工确认 + 产物协议」段（depth 未配置 ⇒ 克制版）。
    expect(textOf(dispatched())).toBe('实现\n\n按分析落地\n\n' + buildExecBudgetSection())
  })

  it('需求提示词实时读取：改需求即改派发内容（未冻结在任务上）', async () => {
    const reqs: Record<string, { prompt?: string }> = { '200@WN_HIS': { prompt: '第一版' } }
    const board = boardStub({ requirements: reqs, tasks: [{ taskId: TASK_ID, title: 'T' }] })
    const { api, dispatched } = makeApi(board)
    await api.dispatch({
      draft: { roleName: '架构师', prompt: '', frozenConfig: { mcp: [], skills: [], model: '' }, permission: 'read-only' },
      targetWorkItem: '200@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK_ID,
    })
    expect(textOf(dispatched())).toContain('第一版')

    reqs['200@WN_HIS'] = { prompt: '第二版' }
    await api.dispatch({
      draft: { roleName: '架构师', prompt: '', frozenConfig: { mcp: [], skills: [], model: '' }, permission: 'read-only' },
      targetWorkItem: '200@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK_ID,
    })
    const second = textOf(dispatched())
    expect(second).toContain('第二版')
    expect(second).not.toContain('第一版')
  })

  it('无需求提示词 / 无工作目录时零噪声（不出现空段与空行）', async () => {
    const board = boardStub({ requirements: {}, tasks: [{ taskId: TASK_ID, title: 'T', description: 'D' }] })
    const { api, dispatched } = makeApi(board)
    await api.dispatch({
      draft: { roleName: '架构师', prompt: '用户指令', frozenConfig: { mcp: [], skills: [], model: '' }, permission: 'read-only' },
      targetWorkItem: '200@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK_ID,
    })
    const text = textOf(dispatched())
    // 问题 1/5：除固定追加的「执行纪律」段外，不得出现空工作目录 / 空需求提示词段（零噪声）。
    expect(text).toBe('用户指令\n\n' + buildExecBudgetSection())
    expect(text).not.toContain('【工作目录')
    expect(text).not.toContain('【需求提示词】')
  })
})

// ───────────────────────── 编排层：api.updateRequirement / updateTask 入参白名单 ─────────────────────────

describe('api · 编辑入参校验（宿主侧白名单，非透传 body）', () => {
  let rest: FakeRest

  function makeApiWithBoard(board: BoardService): ReturnType<typeof createHostApi> {
    const fs = createMemFs()
    const guard = new WriteGuard(new AuditLog('/mem/audit3', fs))
    rest = makeFakeRest({ '_apis/projects': { value: [] }, '_apis/wit/workitems/': { id: 0, rev: 1 } })
    const adapter = new TfsAdapter({ rest: rest.config, writeGuard: guard, collection: 'WN_HIS', profileLabel: 'x' })
    return createHostApi({
      roles: { list: () => ROLES, getByName: n => ROLES.find(r => r.name === n), save: () => {}, delete: () => true },
      adapter,
      dispatcher: { dispatch: async () => ({ runId: 'r' }) as never },
      board,
      getParent: () => ({}) as Agent,
      models: [],
      mcpServers: [],
      skills: [],
      tagSuggestions: [],
      collection: 'WN_HIS',
    })
  }

  function svcWithClaim(id: number): BoardService {
    const svc = makeService()
    svc.claimRequirement({ requirement: summary(id) })
    svc.decompose(`${id}@WN_HIS`)
    return svc
  }

  it('updateRequirement 缺 requirementKey → 拒绝', async () => {
    const api = makeApiWithBoard(svcWithClaim(300))
    const r = await api.updateRequirement({ requirementKey: '' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('requirementKey')
  })

  it('updateRequirement 无任何可改字段 → 拒绝（不做空写）', async () => {
    const api = makeApiWithBoard(svcWithClaim(301))
    const r = await api.updateRequirement({ requirementKey: '301@WN_HIS' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('未提供任何可改字段')
  })

  it('updateRequirement 类型非法 → 拒绝', async () => {
    const api = makeApiWithBoard(svcWithClaim(302))
    const r = await api.updateRequirement({ requirementKey: '302@WN_HIS', prompt: 5 as unknown as string })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('prompt 必须是字符串或 null')
  })

  it('updateTask 缺 taskId / 无字段 / skills 非法 → 分别拒绝', async () => {
    const api = makeApiWithBoard(svcWithClaim(303))
    expect((await api.updateTask({ taskId: '' })).reason).toContain('taskId 必填')
    expect((await api.updateTask({ taskId: '303@WN_HIS#impl' })).reason).toContain('未提供任何可改字段')
    expect(
      (await api.updateTask({ taskId: '303@WN_HIS#impl', skills: [1 as unknown as string] })).reason,
    ).toContain('skills 必须是字符串数组')
  })

  it('updateTask 正常路径写入 prompt/frozenConfig（端到端到引擎）', async () => {
    const api = makeApiWithBoard(svcWithClaim(304))
    const r = await api.updateTask({
      taskId: '304@WN_HIS#impl',
      prompt: '按分析实现',
      model: 'm-z',
      skills: ['s1'],
      mcp: ['mcp-a'],
      expectedRevision: 0,
    })
    expect(r.ok).toBe(true)
    expect(r.task?.prompt).toBe('按分析实现')
    expect(r.task?.frozenConfig).toEqual({ model: 'm-z', skills: ['s1'], mcp: ['mcp-a'] })
  })
})

import { describe, expect, it } from 'vitest'
import { createHostApi } from '../src/host/api.js'
import { BoardService } from '../src/host/board-service.js'
import { Board, type TaskDraft } from '../src/core/board/board.js'
import { createMemFs } from './helpers/memfs.js'
import { validateRole } from '../src/orchestration/roles.js'
import { requirementDedupKey, type Requirement } from '../src/tfs/types.js'
import type { RoleDefinition } from '../src/shared/contracts.js'
import type { RequirementDispatcher, DispatchRequest } from '../src/orchestration/dispatch.js'
import type { SubagentResult, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { TfsAdapter } from '../src/tfs/adapter.js'
import type { OrchestratorSessionManager } from '../src/host/orchestrator-session.js'

const TASK = '1@WN_HIS#analyze'

function makeReq(workItemId = 1): Requirement {
  return {
    workItemId,
    collection: 'WN_HIS',
    project: 'PEIS',
    title: `需求 ${workItemId}`,
    state: 'Active',
    assignedTo: 'zhangbo3',
    priority: 'High',
    iteration: 'Sprint1',
    tags: [],
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    revision: 1,
  }
}

function draft(roleAgent = '架构师'): TaskDraft {
  return {
    taskId: TASK,
    requirementId: requirementDedupKey(makeReq()),
    idempotencyKey: 'k1',
    title: '分析需求',
    description: '把需求拆成可执行任务',
    roleAgent,
    frozenConfig: { mcp: ['tfs-mcp'], skills: ['skill-a'], model: 'm-deep' },
    blockedBy: [],
  }
}

const rolesData: RoleDefinition[] = [
  { id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm-deep', defaultMcp: ['tfs-mcp'] },
]
const fakeRoles = {
  list: () => rolesData,
  getByName: (n: string) => rolesData.find(r => r.name === n),
  save: (role: RoleDefinition) => {
    const errors = validateRole(role)
    if (errors.length) throw new Error(errors.map(e => e.message).join(';'))
  },
  delete: () => true,
}

/** 可控分发器：dispatch 返回 deferred run 句柄，测试手动 resolve/reject 落定结果。 */
class FakeDispatcher implements Pick<RequirementDispatcher, 'dispatch' | 'getRun'> {
  readonly calls: DispatchRequest[] = []
  private readonly handles = new Map<
    string,
    { run: SubagentRun; resolve: (r: SubagentResult) => void; reject: (e: unknown) => void }
  >()

  async dispatch(req: DispatchRequest): Promise<{ taskId: string; requirementId: string; runId: string; provider: string }> {
    this.calls.push(req)
    let resolve!: (r: SubagentResult) => void
    let reject!: (e: unknown) => void
    const result = new Promise<SubagentResult>((res, rej) => {
      resolve = res
      reject = rej
    })
    const run: SubagentRun = {
      id: `run-${this.calls.length}`,
      result,
      dispose: async () => {},
    } as unknown as SubagentRun
    this.handles.set(req.taskId, { run, resolve, reject })
    return { taskId: req.taskId, requirementId: req.requirementId, runId: run.id, provider: req.role.provider }
  }

  getRun(taskId: string): SubagentRun | undefined {
    return this.handles.get(taskId)?.run
  }

  settle(taskId: string, r: SubagentResult): void {
    this.handles.get(taskId)!.resolve(r)
  }

  crash(taskId: string, e: Error): void {
    this.handles.get(taskId)!.reject(e)
  }
}

const flush = (): Promise<void> => new Promise(r => setTimeout(r, 0))

function text(output: string): ContentBlock[] {
  return [{ type: 'text', text: output }] as unknown as ContentBlock[]
}

function harness(roleAgent = '架构师', getParent: () => Agent = () => ({}) as Agent): {
  api: ReturnType<typeof createHostApi>
  svc: BoardService
  dispatcher: FakeDispatcher
} {
  const svc = new BoardService({
    baseDir: '/mem/board',
    fs: createMemFs(),
    board: new Board(),
    adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as unknown as TfsAdapter,
    roles: { list: fakeRoles.list, getByName: fakeRoles.getByName },
    defaultLabel: 'dsh',
  })
  svc.board.claimRequirement(makeReq())
  svc.board.addTask(draft(roleAgent))
  const dispatcher = new FakeDispatcher()
  const api = createHostApi({
    roles: fakeRoles,
    adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as unknown as TfsAdapter,
    dispatcher,
    board: svc,
    getParent,
    models: ['m-deep'],
    mcpServers: ['tfs-mcp'],
    skills: [],
    tagSuggestions: ['dsh'],
    collection: 'WN_HIS',
    // 分类用例只测收口分类，不测扫尾（扫尾默认开启会把 failed/needs_confirmation
    // 自动续跑重开任务）；扫尾行为在「主 agent 扫尾」专项 describe 里显式开启。
    sweepEnabled: false,
  })
  return { api, svc, dispatcher }
}

const dispatchDraft = {
  roleName: '架构师',
  prompt: '开始分析',
  frozenConfig: { mcp: ['tfs-mcp'], skills: ['skill-a'], model: 'm-deep' },
  permission: 'workspace-write' as const,
  }

function taskView(svc: BoardService) {
  return svc.snapshot().tasks.find(t => t.taskId === TASK)!
}

describe('dispatch 落定收口（spec 006 US2：修复"模型失败却显示成功"）', () => {
  it('模型失败（result resolve + stopReason=error）→ 任务 failed 且落 diagnostic/runId/输出', async () => {
    const { api, svc, dispatcher } = harness()
    const r = await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    // 派发返回即绑定 runId（运行中也能读轨迹）。
    expect(taskView(svc).attempts.at(-1)?.runId).toBe('run-1')

    dispatcher.settle(TASK, {
      output: text('这是失败前的部分输出'),
      stopReason: 'error',
      diagnostic: 'Provider error: 401 invalid api key',
    })
    await flush()

    const t = taskView(svc)
    expect(t.state).toBe('in_progress') // 失败可重试，不进终态
    expect(t.execState).toBe('failed')
    const a = t.attempts.at(-1)!
    expect(a.outcome).toBe('failed')
    expect(a.stopReason).toBe('error')
    expect(a.diagnostic).toContain('401')
    expect(a.output).toContain('部分输出')
    expect(a.runId).toBe('run-1')
  })

  it('stopReason=completed → 任务 completed/success', async () => {
    const { api, svc, dispatcher } = harness()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, { output: text('全部完成'), stopReason: 'completed' })
    await flush()
    const t = taskView(svc)
    expect(t.state).toBe('completed')
    expect(t.execState).toBe('success')
    expect(t.attempts.at(-1)?.stopReason).toBe('completed')
    expect(t.attempts.at(-1)?.output).toContain('全部完成')
  })

  it('refusal / max-tokens 也算失败（只有 completed 成功）', async () => {
    const { api, svc, dispatcher } = harness()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, { output: [], stopReason: 'max-tokens' })
    await flush()
    expect(taskView(svc).execState).toBe('failed')
    expect(taskView(svc).attempts.at(-1)?.diagnostic).toContain('token')
  })

  it('基础设施 reject → failed 且 stopReason=infrastructure-error', async () => {
    const { api, svc, dispatcher } = harness()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.crash(TASK, new Error('session bus down'))
    await flush()
    const a = taskView(svc).attempts.at(-1)!
    expect(taskView(svc).execState).toBe('failed')
    expect(a.stopReason).toBe('infrastructure-error')
    expect(a.diagnostic).toContain('session bus down')
  })
})

describe('followUpTask 追问（spec 006 US3）', () => {
  it('失败任务追问：同冻结配置起新一轮，prompt 带上一轮诊断+追问，历史 attempt 保留', async () => {
    const { api, svc, dispatcher } = harness()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, { output: text('部分输出'), stopReason: 'error', diagnostic: 'Provider error: 401' })
    await flush()
    expect(taskView(svc).attempts).toHaveLength(1)

    const r = await api.followUpTask({ taskId: TASK, message: '请改用只读方式再分析一次' })
    expect(r.ok).toBe(true)
    expect(r.runId).toBe('run-2')
    expect(r.attempt).toBe(1)

    // 新一轮运行中：两条 attempt，最新 running。
    const running = taskView(svc)
    expect(running.state).toBe('in_progress')
    expect(running.execState).toBe('running')
    expect(running.attempts).toHaveLength(2)
    expect(running.attempts[1]!.outcome).toBe('running')
    expect(running.attempts[1]!.runId).toBe('run-2')

    // 派发给子 agent 的请求：同冻结配置 + prompt 含上一轮诊断与追问。
    const req2 = dispatcher.calls.at(-1)!
    expect(req2.frozenConfig).toEqual({ mcp: ['tfs-mcp'], skills: ['skill-a'], model: 'm-deep' })
    const promptText = req2.prompt.map(b => ('text' in b ? b.text : '')).join('\n')
    expect(promptText).toContain('Provider error: 401')
    expect(promptText).toContain('部分输出')
    expect(promptText).toContain('请改用只读方式再分析一次')

    // 新一轮成功 → completed；首轮失败历史保留。
    dispatcher.settle(TASK, { output: text('重做完成'), stopReason: 'completed' })
    await flush()
    const done = taskView(svc)
    expect(done.state).toBe('completed')
    expect(done.attempts[0]!.outcome).toBe('failed')
    expect(done.attempts[1]!.outcome).toBe('success')
  })

  it('completed 任务追问：显式重开为 in_progress 并追加 running attempt', async () => {
    const { api, svc, dispatcher } = harness()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, { output: [], stopReason: 'completed' })
    await flush()
    expect(taskView(svc).state).toBe('completed')

    const r = await api.followUpTask({ taskId: TASK, message: '再补充一点' })
    expect(r.ok).toBe(true)
    expect(r.attempt).toBe(1)
    expect(taskView(svc).state).toBe('in_progress')
    expect(taskView(svc).execState).toBe('running')
  })

  it('空追问被拒绝', async () => {
    const { api } = harness()
    const r = await api.followUpTask({ taskId: TASK, message: '   ' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('为空')
  })

  it('deleted 任务追问被拒绝', async () => {
    const { api, svc, dispatcher } = harness()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, { output: [], stopReason: 'completed' })
    await flush()
    svc.setTaskState(TASK, 'cancel')
    const r = await api.followUpTask({ taskId: TASK, message: '再来' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('终态')
  })

  it('角色缺失/未绑定 provider 时拒绝，且不留半截 running attempt', async () => {
    const { api, svc } = harness('ghost-role')
    const before = taskView(svc).attempts.length
    const r = await api.followUpTask({ taskId: TASK, message: '再来' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('角色')
    expect(taskView(svc).attempts).toHaveLength(before)
  })
})

describe('getTaskTrace 降级（spec 006 US2）', () => {
  it('未注入轨迹服务时返回 available:false 而非抛错', async () => {
    const { api } = harness()
    const r = await api.getTaskTrace(TASK)
    expect(r.available).toBe(false)
    expect(r.ok).toBe(false)
    expect(Array.isArray(r.entries)).toBe(true)
  })
})

/**
 * 2026-09-21 假执行事故回归：看板显示"执行中"但子 agent 从未创建、零 token。
 *
 * 两个成因：
 * 1. `start` / `retry` 只改状态、不派发（`Board.startTask` 没有派发语义）；
 * 2. 派发用 `ctx as unknown as Agent` 伪造 parent，在宿主 subagent 驱动里必抛，
 *    而任务已被置为 running，于是永久悬空。
 */
describe('假执行修复（2026-09-21）', () => {
  it('start 必须真的派发（不是只把任务置为 running）', async () => {
    const { api, svc, dispatcher } = harness()
    const r = api.setTaskState(TASK, 'start')
    expect(r.ok).toBe(true)
    expect(taskView(svc).execState).toBe('running')
    await flush()
    // 修复前：dispatcher.calls 为空 → 任务永远 running、零 token。
    expect(dispatcher.calls).toHaveLength(1)
    expect(dispatcher.calls[0]!.taskId).toBe(TASK)
    // runId 已回绑，任务运行中即可读轨迹。
    expect(taskView(svc).attempts.at(-1)?.runId).toBe('run-1')
    // 落定后可正常收口，不再悬空。
    dispatcher.settle(TASK, { output: text('ok'), stopReason: 'completed' })
    await flush()
    expect(taskView(svc).state).toBe('completed')
  })

  it('retry 同样真的派发（"重试"名副其实）', async () => {
    const { api, svc, dispatcher } = harness()
    api.setTaskState(TASK, 'start')
    await flush()
    dispatcher.settle(TASK, { output: [], stopReason: 'error', diagnostic: 'boom' })
    await flush()
    expect(taskView(svc).execState).toBe('failed')

    const r = api.setTaskState(TASK, 'retry')
    expect(r.ok).toBe(true)
    await flush()
    expect(dispatcher.calls).toHaveLength(2)
    expect(taskView(svc).attempts.at(-1)?.runId).toBe('run-2')
  })

  it('拿不到真实 parent：dispatch 拒绝派发，且**不**把任务置为 running', async () => {
    const { api, svc, dispatcher } = harness('架构师', () => {
      throw new Error('无可用会话')
    })
    const r = await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('无可用会话')
    expect(dispatcher.calls).toHaveLength(0)
    // 关键：状态没有被改成 running，attempt 也没开（修复前会留下 running + 空 attempt）。
    const t = taskView(svc)
    expect(t.state).toBe('pending')
    expect(t.execState).toBe('queued')
    expect(t.attempts).toHaveLength(0)
  })

  it('start 拿不到 parent：收口为 failed 并写诊断，不留悬空 running', async () => {
    const { api, svc, dispatcher } = harness('架构师', () => {
      throw new Error('无可用会话')
    })
    const r = api.setTaskState(TASK, 'start')
    expect(r.ok).toBe(true)
    await flush()
    expect(dispatcher.calls).toHaveLength(0)
    const t = taskView(svc)
    expect(t.execState).toBe('failed')
    expect(t.attempts.at(-1)?.diagnostic).toContain('无可用会话')
  })

  it('start 遇到角色未绑 provider：同样收口为 failed，不留悬空 running', async () => {
    const { api, svc, dispatcher } = harness('ghost-role')
    api.setTaskState(TASK, 'start')
    await flush()
    expect(dispatcher.calls).toHaveLength(0)
    const t = taskView(svc)
    expect(t.execState).toBe('failed')
    expect(t.attempts.at(-1)?.diagnostic).toContain('ghost-role')
  })
})

// spec 009：LLM 供应商必须随 model 成对冻结、成对透传（看板任务派发 + 追问两条路径）。
describe('模型供应商成对路由（spec 009）', () => {
  it('任务冻结 modelProvider 后，看板派发与追问都成对透传 provider', async () => {
    const { api, svc, dispatcher } = harness()
    // 经服务层把任务冻结配置改成成对路由（模拟任务编辑弹层保存"火山方舟 / deepseek-v4-flash"）。
    const up = svc.updateTask(TASK, { model: 'deepseek-v4-flash', modelProvider: 'arkcode' })
    expect(up.ok).toBe(true)

    // 看板任务派发路径以**看板冻结配置**为准（draft 仅用于无 taskId 的手工任务）。
    const r = await api.dispatch({
      draft: {
        ...dispatchDraft,
        frozenConfig: {
          mcp: ['tfs-mcp'],
          skills: ['skill-a'],
          model: 'deepseek-v4-flash',
          modelProvider: 'arkcode',
        },
      },
      targetWorkItem: '1@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK,
    })
    expect(r.ok).toBe(true)
    const req1 = dispatcher.calls.at(-1)!
    expect(req1.frozenConfig).toMatchObject({
      model: 'deepseek-v4-flash',
      modelProvider: 'arkcode',
    })

    // 首轮失败后追问：沿同一任务冻结配置起新一轮，provider 不丢。
    dispatcher.settle(TASK, {
      output: text('部分输出'),
      stopReason: 'error',
      diagnostic: 'Provider error: 401',
    })
    await flush()
    const fr = await api.followUpTask({ taskId: TASK, message: '换火山方舟再试一次' })
    expect(fr.ok).toBe(true)
    const req2 = dispatcher.calls.at(-1)!
    expect(req2.frozenConfig).toMatchObject({
      model: 'deepseek-v4-flash',
      modelProvider: 'arkcode',
    })
  })

  it('历史任务只有裸 model（无 modelProvider）：派发与追问均不伪造 provider 键', async () => {
    const { api, dispatcher } = harness()
    const r = await api.dispatch({
      draft: dispatchDraft,
      targetWorkItem: '1@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK,
    })
    expect(r.ok).toBe(true)
    expect(dispatcher.calls.at(-1)!.frozenConfig).toEqual({
      mcp: ['tfs-mcp'],
      skills: ['skill-a'],
      model: 'm-deep',
    })
    dispatcher.settle(TASK, {
      output: text('部分输出'),
      stopReason: 'error',
      diagnostic: 'Provider error: 401',
    })
    await flush()
    const fr = await api.followUpTask({ taskId: TASK, message: '再来一轮' })
    expect(fr.ok).toBe(true)
    expect(dispatcher.calls.at(-1)!.frozenConfig).toEqual({
      mcp: ['tfs-mcp'],
      skills: ['skill-a'],
      model: 'm-deep',
    })
  })
})

/**
 * 2026-10-29（诉求 3 / 4）：所选技能 / MCP / 工作流必须**真的**作用于子 agent。
 *
 * 宿主的 `SubagentStartRequest` 没有工具限制字段（`toolFilter` 不存在），
 * 因此插件用「预检 → 下发 → 落定验收」三段实现，这组测试逐段锁定：
 *   ① 预检：工作流不在技能清单、技能取不到正文、所选 MCP 无注册工具 ⇒ 派发被拒；
 *   ② 下发：技能正文 + MCP 真实工具名 + 逐步纪律进入 prompt；
 *   ③ 验收：技能/MCP 未使用、步骤未逐条报告 ⇒ 收口为 needs_confirmation（不是静默成功）。
 */
describe('所选技能 / MCP / 工作流：预检 → 下发 → 验收', () => {
  /** 带扩展依赖的 harness（在基础 harness 之上补 deps，并按需改写任务冻结配置）。 */
  function harnessWith(
    extra: Record<string, unknown>,
    frozen?: { skills?: string[]; mcp?: string[]; workflow?: string },
  ): { api: ReturnType<typeof createHostApi>; svc: BoardService; dispatcher: FakeDispatcher } {
    const svc = new BoardService({
      baseDir: '/mem/board',
      fs: createMemFs(),
      board: new Board(),
      adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as unknown as TfsAdapter,
      roles: { list: fakeRoles.list, getByName: fakeRoles.getByName },
      defaultLabel: 'dsh',
    })
    svc.board.claimRequirement(makeReq())
    svc.board.addTask(draft())
    if (frozen) {
      svc.board.updateTask(TASK, {
        frozenConfig: {
          mcp: frozen.mcp ?? ['tfs-mcp'],
          skills: frozen.skills ?? ['skill-a'],
          model: 'm-deep',
          ...(frozen.workflow ? { workflow: frozen.workflow } : {}),
        },
      }, svc.snapshot().tasks.find(t => t.taskId === TASK)!.revision)
    }
    const dispatcher = new FakeDispatcher()
    const api = createHostApi({
      roles: fakeRoles,
      adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as unknown as TfsAdapter,
      dispatcher,
      board: svc,
      getParent: () => ({}) as Agent,
      models: ['m-deep'],
      mcpServers: ['tfs-mcp'],
      skills: [],
      tagSuggestions: ['dsh'],
      collection: 'WN_HIS',
      // 同 harness()：分类用例不测扫尾；extra 可覆盖（如扫尾专项用例显式开启）。
      sweepEnabled: false,
      ...extra,
    })
    return { api, svc, dispatcher }
  }

  /** 带工作流的派发草稿（dispatch 以 draft.frozenConfig 为准，任务上的旧值不参与本次派发）。 */
  const wfDraft = (workflow: string | undefined, skills: string[] = ['skill-a'], mcp: string[] = ['tfs-mcp']) => ({
    ...dispatchDraft,
    frozenConfig: { mcp, skills, model: 'm-deep', ...(workflow ? { workflow } : {}) },
  })

  it('工作流不在技能清单内 ⇒ 派发被拒（工作流从技能中选择）', async () => {
    const { api, svc } = harnessWith({})
    const r = await api.dispatch({ draft: wfDraft('not-selected'), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('工作流')
    expect(r.reason).toContain('not-selected')
    // 预检在动看板状态**之前**完成 ⇒ 不产生"执行中"的假象，也不留下空 attempt。
    const t = svc.snapshot().tasks.find(x => x.taskId === TASK)!
    expect(t.execState).toBe('queued')
    expect(t.attempts).toHaveLength(0)
  })

  it('其它所选技能取不到正文 ⇒ 不打死派发（降级为"必须先加载技能"的纪律）', async () => {
    const { api, dispatcher } = harnessWith({ loadSkillBodies: async () => [] })
    const r = await api.dispatch({ draft: wfDraft(undefined, ['skill-a', 'skill-b']), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    const body = (dispatcher.calls.at(-1)!.prompt as Array<{ text?: string }>).map(b => b.text ?? '').join('\n')
    expect(body).toContain('`skill-a`')
    expect(body).toContain('正文未能预载')
  })

  it('工作流技能取不到正文 ⇒ 硬失败（"按该技能流程执行"会变成空话）', async () => {
    const { api } = harnessWith({ loadSkillBodies: async () => [] })
    const r = await api.dispatch({ draft: wfDraft('skill-a'), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('工作流技能')
    expect(r.reason).toContain('取不到正文')
  })

  it('所选 MCP 一个工具都没注册 ⇒ 不打死派发，但在 prompt 里显式声明不可用', async () => {
    const { api, dispatcher } = harnessWith(
      { listToolNames: () => ['read_file', 'mcp__other__x'], loadSkillBodies: async () => [{ name: 'skill-a', content: '内容' }] },
    )
    const r = await api.dispatch({ draft: wfDraft(undefined, ['skill-a'], ['tfs-mcp']), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    const body = (dispatcher.calls.at(-1)!.prompt as Array<{ text?: string }>).map(b => b.text ?? '').join('\n')
    expect(body).toContain('tfs-mcp')
    expect(body).toContain('当前不可用')
  })

  it('下发：技能正文 + MCP 真实工具名 + 工作流步骤都进入子 agent prompt', async () => {
    const skillContent = ['# 工作流', '## 阶段 1：读取', '## 阶段 2：编码'].join('\n')
    const { api, dispatcher } = harnessWith(
      {
        loadSkillBodies: async () => [{ name: 'skill-a', content: skillContent }],
        listToolNames: () => ['mcp__tfs-mcp__get_workitem'],
      },
    )
    const r = await api.dispatch({ draft: wfDraft('skill-a'), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    const prompt = dispatcher.calls.at(-1)!.prompt as Array<{ text?: string }>
    const body = prompt.map(b => b.text ?? '').join('\n')
    expect(body).toContain('【必须使用的技能与 MCP（强制执行')
    expect(body).toContain('## 阶段 1：读取')
    expect(body).toContain('mcp__tfs-mcp__get_workitem')
    expect(body).toContain('【强制工作流：skill-a】')
    expect(body).toContain('禁止跳过、合并、乱序执行任何步骤')
  })

  it('验收不达标（技能未加载 / 步骤未逐条报告）⇒ 收口为 needs_confirmation', async () => {
    const { api, svc, dispatcher } = harnessWith(
      {
        loadSkillBodies: async () => [{ name: 'skill-a', content: '## 阶段 1：A\n## 阶段 2：B' }],
        listToolNames: () => ['mcp__tfs-mcp__get_workitem'],
        readChildToolCalls: async () => [],
        // 技能工具**确实存在**却没调用 —— 这才是"未加载"的可判形态
        //（2026-11-03 问题 4：工具表里没有 skill 工具时正文已随 prompt 交付，不再判未加载）。
        readChildToolNames: async () => ['skill', 'mcp__tfs-mcp__get_workitem'],
      },
    )
    const r = await api.dispatch({ draft: wfDraft('skill-a'), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    dispatcher.settle(TASK, { output: text('我按流程做完了，但没写勾选清单'), stopReason: 'completed' })
    await flush()

    const t = svc.snapshot().tasks.find(x => x.taskId === TASK)!
    // 待人工确认：产出可能有效，但没按纪律留痕 —— 不直接判失败（否则丢掉有效产出）。
    expect(t.execState).toBe('needs_confirmation')
    const note = t.attempts.at(-1)?.note ?? ''
    expect(note).toContain('未按要求使用所选能力')
    expect(note).toContain('未加载所选技能')
    expect(note).toContain('未调用所选 MCP')
    expect(note).toContain('工作流未逐步执行')
  })

  it('技能工具不在子会话工具表（正文随 prompt 交付）⇒ 不判未加载，不再连环误杀（2026-11-03 问题 4）', async () => {
    const { api, svc, dispatcher } = harnessWith(
      {
        loadSkillBodies: async () => [{ name: 'skill-a', content: '## 阶段 1：A\n## 阶段 2：B' }],
        listToolNames: () => ['mcp__tfs-mcp__get_workitem'],
        readChildToolCalls: async () => [],
        // 工具表可读且**没有**技能工具：与 dsh 子会话实况一致（技能靠 prompt 整篇下发）。
        readChildToolNames: async () => ['bash', 'read', 'mcp__tfs-mcp__get_workitem'],
      },
    )
    const r = await api.dispatch({ draft: wfDraft('skill-a'), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    dispatcher.settle(TASK, { output: text('✅ 步骤 1/2：A\n✅ 步骤 2/2：B\n\n（技能正文已按 prompt 内容执行）'), stopReason: 'completed' })
    await flush()

    const t = svc.snapshot().tasks.find(x => x.taskId === TASK)!
    const note = t.attempts.at(-1)?.note ?? ''
    expect(note).not.toContain('未加载所选技能')
  })

  it('验收达标（技能已加载 + MCP 已调用 + 步骤齐报）⇒ 正常 success', async () => {
    const { api, svc, dispatcher } = harnessWith(
      {
        loadSkillBodies: async () => [{ name: 'skill-a', content: '## 阶段 1：A\n## 阶段 2：B' }],
        listToolNames: () => ['mcp__tfs-mcp__get_workitem'],
        readChildToolCalls: async () => [
          { name: 'skill', args: JSON.stringify({ name: 'skill-a' }) },
          { name: 'mcp__tfs-mcp__get_workitem', args: '{}' },
        ],
      },
    )
    const r = await api.dispatch({ draft: wfDraft('skill-a'), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    dispatcher.settle(TASK, {
      output: text('✅ 步骤 1/2：A\n✅ 步骤 2/2：B\n工作流：skill-a（已完成 2/2 步）'),
      stopReason: 'completed',
    })
    await flush()
    const t = svc.snapshot().tasks.find(x => x.taskId === TASK)!
    expect(t.execState).toBe('success')
  })

  it('伪工具调用（输出是 <read> 文本）⇒ 直接判 failed（诉求 2：不降级待确认）', async () => {
    const { api, svc, dispatcher } = harnessWith(
      {
        loadSkillBodies: async () => [{ name: 'skill-a', content: '## 阶段 1：A' }],
        readChildToolCalls: async () => [],
        readChildToolNames: async () => ['bash', 'read', 'mcp__tfs-mcp__tfs_add_tags'],
      },
      { skills: ['skill-a'], mcp: ['tfs-mcp'], workflow: 'skill-a' },
    )
    const r = await api.dispatch({ draft: wfDraft('skill-a'), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    dispatcher.settle(TASK, {
      output: text('<read>\n<file_path>D:\\x.cs</file_path>\n</read>\n<read>\n<file_path>D:\\x.cs</file_path>\n</read>'),
      stopReason: 'completed',
    })
    await flush()
    const t = svc.snapshot().tasks.find(x => x.taskId === TASK)!
    expect(t.execState).toBe('failed')
    expect(t.attempts.at(-1)?.note ?? '').toContain('并未真正调用工具')
  })

  it('谎称工具未注入（工具表里确有）⇒ 待确认且诊断写明谎报（诉求 1：以工具表为事实源）', async () => {
    const { api, svc, dispatcher } = harnessWith(
      {
        loadSkillBodies: async () => [{ name: 'skill-a', content: '内容' }],
        readChildToolCalls: async () => [],
        readChildToolNames: async () => ['bash', 'read', 'mcp__tfs-mcp__tfs_add_tags'],
      },
      { skills: ['skill-a'], mcp: ['tfs-mcp'] },
    )
    const r = await api.dispatch({ draft: wfDraft(undefined, ['skill-a'], ['tfs-mcp']), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    dispatcher.settle(TASK, {
      output: text('MCP 工具（tfs-mcp）未注入本会话的工具列表，无法直接以工具调用。'),
      stopReason: 'completed',
    })
    await flush()
    const t = svc.snapshot().tasks.find(x => x.taskId === TASK)!
    expect(t.execState).toBe('needs_confirmation')
    expect(t.attempts.at(-1)?.note ?? '').toContain('谎称')
  })

  it('事件不可读（readChildToolCalls 返回 undefined）⇒ 不因观测缺失误杀任务', async () => {
    const { api, svc, dispatcher } = harnessWith(
      {
        loadSkillBodies: async () => [{ name: 'skill-a', content: '内容' }],
        readChildToolCalls: async () => undefined,
      },
    )
    const r = await api.dispatch({ draft: wfDraft(undefined, ['skill-a'], []), targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    dispatcher.settle(TASK, { output: text('做完了'), stopReason: 'completed' })
    await flush()
    expect(svc.snapshot().tasks.find(x => x.taskId === TASK)!.execState).toBe('success')
  })
})

/**
 * 主 agent 扫尾（2026-11-03 问题 7）集成用例。
 *
 * 扫尾默认开启；本组用例显式开启（`sweepEnabled: true`）并桩掉编排决断（decide），
 * 验证收口后的三条扫尾路径：
 *   ① 瞬时失败 ⇒ 自动续跑同一子 agent（sweepRound+1，prompt 带扫尾指令）；
 *   ② 待人工确认 ⇒ 主 agent 按 RECOMMEND 推荐项续跑；
 *   ③ 拒绝 / 扫尾轮数耗尽 ⇒ 主 agent 亲自完成（decide 收口）。
 * 纯决策矩阵在 tests/sweep.spec.ts；此处只测 api 层接线与看板状态流转。
 */
describe('主 agent 扫尾（问题 7）', () => {
  function harnessSweep(
    opts: {
      decide?: (requirementKey: string, prompt: string) => Promise<string>
      sweepMaxRounds?: number
    } = {},
  ): {
    api: ReturnType<typeof createHostApi>
    svc: BoardService
    dispatcher: FakeDispatcher
    decideCalls: string[]
  } {
    const svc = new BoardService({
      baseDir: '/mem/board',
      fs: createMemFs(),
      board: new Board(),
      adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as unknown as TfsAdapter,
      roles: { list: fakeRoles.list, getByName: fakeRoles.getByName },
      defaultLabel: 'dsh',
    })
    svc.board.claimRequirement(makeReq())
    svc.board.addTask(draft())
    const dispatcher = new FakeDispatcher()
    const decideCalls: string[] = []
    const decide = opts.decide ?? (async (_key: string, _prompt: string) => 'CHOICE: 默认方案')
    const orchestrator = {
      ensure: async () => ({ ok: true }),
      summarize: async () => '',
      finalize: async () => '',
      decide: async (key: string, prompt: string) => {
        decideCalls.push(prompt)
        return decide(key, prompt)
      },
    } as unknown as Pick<OrchestratorSessionManager, 'ensure' | 'summarize' | 'finalize' | 'decide'>
    const api = createHostApi({
      roles: fakeRoles,
      adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as unknown as TfsAdapter,
      dispatcher,
      board: svc,
      getParent: () => ({}) as Agent,
      models: ['m-deep'],
      mcpServers: ['tfs-mcp'],
      skills: [],
      tagSuggestions: ['dsh'],
      collection: 'WN_HIS',
      orchestrator,
      sweepEnabled: true,
      sweepMaxRounds: opts.sweepMaxRounds ?? 2,
    })
    return { api, svc, dispatcher, decideCalls }
  }

  /** 扫尾是 fire-and-forget（`void maybeSweep`），多排空一轮微任务保证 followUp/decide 链走完。 */
  const drain = async (): Promise<void> => {
    await flush()
    await flush()
  }

  const promptTextOf = (req: DispatchRequest): string =>
    req.prompt.map(b => ('text' in b ? b.text : '')).join('\n')

  it('瞬时失败 ⇒ 扫尾自动续跑同一子 agent（sweepRound+1、prompt 带扫尾指令与上一轮输出）', async () => {
    const { api, svc, dispatcher } = harnessSweep()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, { output: text('部分输出'), stopReason: 'error', diagnostic: 'Provider error: 500' })
    await drain()

    // 扫尾已自动追问：第二次派发、任务回到 running、扫尾轮数记 1。
    expect(dispatcher.calls.length).toBe(2)
    const t = taskView(svc)
    expect(t.state).toBe('in_progress')
    expect(t.execState).toBe('running')
    expect(t.attempts).toHaveLength(2)
    expect(t.orchestration?.sweepRound).toBe(1)
    const promptText = promptTextOf(dispatcher.calls.at(-1)!)
    expect(promptText).toContain('主 agent 扫尾')
    expect(promptText).toContain('部分输出')
    expect(promptText).toContain('TASK_DONE')
  })

  it('待人工确认且输出带 RECOMMEND ⇒ 主 agent 按推荐选项续跑（无需人工点选）', async () => {
    const { api, svc, dispatcher, decideCalls } = harnessSweep()
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, {
      output: text('主体已完成。\nNEEDS_HUMAN_CONFIRM: 请选择参数方案\nRECOMMEND: 方案A'),
      stopReason: 'completed',
    })
    await drain()

    expect(dispatcher.calls.length).toBe(2)
    const promptText = promptTextOf(dispatcher.calls.at(-1)!)
    expect(promptText).toContain('主 agent 扫尾')
    expect(promptText).toContain('方案A')
    // 推荐项解析得出 ⇒ 不打扰主 agent 决断。
    expect(decideCalls.length).toBe(0)
    expect(taskView(svc).orchestration?.sweepRound).toBe(1)
    expect(taskView(svc).execState).toBe('running')
  })

  it('子 agent 拒绝（stopReason=refusal）⇒ 转主 agent 亲做，按 TASK_DONE 收口成功', async () => {
    const { api, svc, dispatcher, decideCalls } = harnessSweep({
      decide: async () => 'TASK_DONE\nARTIFACTS:\n- D:/tmp/out.md',
    })
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })
    dispatcher.settle(TASK, { output: text('这个任务我无法执行。'), stopReason: 'refusal' })
    await drain()

    // 不再派发子 agent；主 agent 决策一次并亲自收口。
    expect(dispatcher.calls.length).toBe(1)
    expect(decideCalls.length).toBe(1)
    expect(decideCalls[0]).toContain('亲自完成')
    expect(decideCalls[0]).toContain('refusal')
    const t = taskView(svc)
    expect(t.state).toBe('completed')
    expect(t.execState).toBe('success')
    expect(t.attempts).toHaveLength(2)
    expect(t.attempts.at(-1)?.outcome).toBe('success')
    expect(t.attempts.at(-1)?.note ?? '').toContain('主 agent 亲自完成')
  })

  it('needs_confirmation 反复出现 ⇒ 扫尾轮数耗尽转主 agent 亲做（防死循环）', async () => {
    const { api, svc, dispatcher, decideCalls } = harnessSweep({
      decide: async () => 'TASK_DONE',
      sweepMaxRounds: 1,
    })
    await api.dispatch({ draft: dispatchDraft, targetWorkItem: '1@WN_HIS', collection: 'WN_HIS', taskId: TASK })

    // 第一次待确认：sweepRound(0) < max(1) ⇒ 带推荐项续跑。
    dispatcher.settle(TASK, {
      output: text('NEEDS_HUMAN_CONFIRM: 请选择配置\nRECOMMEND: 默认方案'),
      stopReason: 'completed',
    })
    await drain()
    expect(dispatcher.calls.length).toBe(2)
    expect(decideCalls.length).toBe(0)

    // 第二次仍待确认：sweepRound(1) >= max(1) ⇒ 不再续跑，转主 agent 亲做。
    dispatcher.settle(TASK, {
      output: text('NEEDS_HUMAN_CONFIRM: 请选择配置\nRECOMMEND: 默认方案'),
      stopReason: 'completed',
    })
    await drain()
    expect(dispatcher.calls.length).toBe(2)
    expect(decideCalls.length).toBe(1)
    expect(decideCalls[0]).toContain('亲自完成')
    expect(decideCalls[0]).toContain('反复请求人工确认')
    const t = taskView(svc)
    expect(t.state).toBe('completed')
    expect(t.execState).toBe('success')
    expect(t.orchestration?.sweepRound).toBe(1)
  })
})

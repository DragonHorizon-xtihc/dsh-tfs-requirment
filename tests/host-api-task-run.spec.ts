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
      localAgent: undefined,
      result,
      dispose: async () => {},
    } as SubagentRun
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

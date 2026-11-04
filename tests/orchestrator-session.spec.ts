import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Board } from '../src/core/board/board.js'
import { BoardService } from '../src/host/board-service.js'
import { OrchestratorSessionManager } from '../src/host/orchestrator-session.js'
import type { Requirement } from '../src/tfs/types.js'
import { createMemFs } from './helpers/memfs.js'

/**
 * 编排主 agent 会话管理（spec 010）。
 *
 * 这里驱动的是**真实 BoardService + 假宿主服务**：断言的重点不是"能不能调通宿主"，
 * 而是"**宿主不给力时会不会静默失败**" —— 编排是增强能力，任何一步失败都必须：
 *   ① 落到 `mode:'off'` + 可读 reason；② 不抛错打断任务链路；③ 不留 running 悬挂。
 */

const KEY = '1997179@WN_HIS'
const TASK = `${KEY}#analyze`

/** 记录注册的生命周期监听器，供测试手工触发。 */
function makeCtx(services: Record<string, unknown> = {}): {
  ctx: Context
  emit: (name: string, info: unknown) => void
  services: Record<string, unknown>
} {
  const listeners = new Map<string, Set<(info: unknown) => void>>()
  const api = {
    on(name: string, cb: (info: unknown) => void) {
      const set = listeners.get(name) ?? new Set()
      set.add(cb)
      listeners.set(name, set)
      return () => set.delete(cb)
    },
    get(name: string) {
      return services[name]
    },
  }
  return {
    ctx: api as unknown as Context,
    emit: (name: string, info: unknown) => {
      for (const cb of [...(listeners.get(name) ?? [])]) cb(info)
    },
    services,
  }
}

/** 假 subagent 服务：可编程支持/拒绝 continuable。 */
function fakeSubagents(): {
  service: Record<string, unknown>
  calls: { start: number; send: string[] }
  sentPrompt: () => string
} {
  const calls = { start: 0, send: [] as string[] }
  let lastPrompt = ''
  let n = 0
  const service = {
    list: () => ['spawn'],
    startContinuable: (spec: { label?: string; request?: { prompt?: Array<{ text?: string }> } }) => {
      calls.start += 1
      n += 1
      lastPrompt = spec?.request?.prompt?.[0]?.text ?? ''
      return { childId: `child-${n}`, messageId: `m-${n}` }
    },
    sendMessage: (_sender: unknown, targetId: string, content: Array<{ text?: string }>) => {
      calls.send.push(targetId)
      lastPrompt = content?.[0]?.text ?? ''
      return `msg-${calls.send.length}`
    },
  }
  return { service, calls, sentPrompt: () => lastPrompt }
}

function makeBoard(): BoardService {
  const svc = new BoardService({
    baseDir: '/mem/board',
    fs: createMemFs(),
    board: new Board(),
    adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as never,
    roles: { list: () => [], getByName: () => undefined } as never,
    defaultLabel: 'dsh',
  })
  const req: Requirement = {
    workItemId: 1997179,
    collection: 'WN_HIS',
    project: 'P',
    title: '汇总改造',
    state: '已建议',
    assignedTo: '',
    priority: '',
    iteration: '',
    tags: [],
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    revision: 1,
    description: '需求正文全文：改造体检报告汇总模块，涉及 A、B、C 三个子流程……',
    prompt: '需求提示词全文（用户填写的执行约束）',
  }
  svc.board.claimRequirement(req)
  svc.board.addTask({
    taskId: TASK,
    requirementId: KEY,
    idempotencyKey: 'k',
    title: '分析',
    description: 'd',
    roleAgent: '架构师',
    frozenConfig: { mcp: [], skills: [], model: '' },
  })
  return svc
}

function manager(
  ctx: Context,
  board: BoardService,
  over: Partial<ConstructorParameters<typeof OrchestratorSessionManager>[0]> = {},
): OrchestratorSessionManager {
  return new OrchestratorSessionManager({
    ctx,
    board,
    getParent: () => ({ session: { id: 'parent-1' } }) as unknown as Agent,
    provider: '',
    enabled: true,
    summarizeTimeoutMs: 50,
    finalizeTimeoutMs: 50,
    taskSettleTimeoutMs: 1000,
    ...over,
  })
}

describe('ensure（幂等 + fail-loud 降级）', () => {
  it('首次创建 continuable 会话，重复调用不再创建', async () => {
    const { ctx } = makeCtx({ subagents: fakeSubagents().service })
    const board = makeBoard()
    const mgr = manager(ctx, board)

    const a = await mgr.ensure(KEY, { title: '汇总改造' })
    expect(a.mode).toBe('continuable')
    expect(a.orchestratorSessionId).toBe('child-1')
    expect(a.parentSessionId).toBe('parent-1')

    const b = await mgr.ensure(KEY, { title: '汇总改造' })
    expect(b.orchestratorSessionId).toBe('child-1')
    expect(board.board.snapshot.requirements[KEY]?.orchestration?.orchestratorSessionId).toBe('child-1')
  })

  it('startContinuable 抛错 ⇒ mode=off + 可读原因（不抛）', async () => {
    const ctx = makeCtx({
      subagents: {
        list: () => ['spawn'],
        startContinuable: () => {
          throw new Error('provider spawn 不支持 continuable')
        },
      },
    }).ctx
    const board = makeBoard()
    const mgr = manager(ctx, board)
    const r = await mgr.ensure(KEY)
    expect(r.mode).toBe('off')
    expect(r.reason).toContain('不支持 continuable')
    expect(board.board.snapshot.requirements[KEY]?.orchestration?.mode).toBe('off')
  })

  it('宿主无 subagents 服务 ⇒ mode=off（不抛）', async () => {
    const { ctx } = makeCtx({})
    const mgr = manager(ctx, makeBoard())
    const r = await mgr.ensure(KEY)
    expect(r.mode).toBe('off')
    expect(r.reason).toBeTruthy()
  })

  it('配置关闭 ⇒ mode=off，且不触碰宿主', async () => {
    const { ctx } = makeCtx({ subagents: fakeSubagents().service })
    const mgr = manager(ctx, makeBoard(), { enabled: false })
    const r = await mgr.ensure(KEY)
    expect(r.mode).toBe('off')
    expect(r.reason).toContain('orchestratorMode=off')
  })
})

describe('summarize（归纳 + 简报增量；超时降级）', () => {
  it('收到 subagent/end 后结论落进任务与共享简报', async () => {
    const fake = fakeSubagents()
    const { ctx, emit } = makeCtx({ subagents: fake.service })
    const board = makeBoard()
    const mgr = manager(ctx, board)
    await mgr.ensure(KEY, { title: '汇总改造', digestSeed: '种子摘要' })

    const p = mgr.summarize(KEY, TASK)
    // 主 agent 通过 subagent/end 报回落定（continuable 没有 per-message result）。
    await Promise.resolve()
    emit('subagent/end', {
      id: 'child-1',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: 'SUMMARY:\n改了 A 模块，注意 B 的兼容性' }],
    })
    const summary = await p

    expect(summary).toBe('改了 A 模块，注意 B 的兼容性')
    expect(board.snapshot().tasks.find(t => t.taskId === TASK)?.orchestration?.summary).toBe('改了 A 模块，注意 B 的兼容性')
    const brief = board.board.snapshot.requirements[KEY]?.orchestration?.brief
    expect(brief?.conclusions.map(c => c.taskId)).toEqual([TASK])
    expect(brief?.digest).toBe('种子摘要')
  })

  it('观测不到收口 ⇒ summaryState=timeout，抛错为零、任务不受影响', async () => {
    const fake = fakeSubagents()
    const { ctx } = makeCtx({ subagents: fake.service })
    const board = makeBoard()
    const mgr = manager(ctx, board, { summarizeTimeoutMs: 20 })
    await mgr.ensure(KEY)

    const summary = await mgr.summarize(KEY, TASK)
    expect(summary).toBe('')
    expect(board.snapshot().tasks.find(t => t.taskId === TASK)?.orchestration?.summaryState).toBe('timeout')
  })

  it('编排未启用 ⇒ summaryState=skipped，且不向宿主投递消息', async () => {
    const fake = fakeSubagents()
    const { ctx } = makeCtx({ subagents: fake.service })
    const board = makeBoard()
    const mgr = manager(ctx, board)
    const summary = await mgr.summarize(KEY, TASK)
    expect(summary).toBe('')
    expect(board.snapshot().tasks.find(t => t.taskId === TASK)?.orchestration?.summaryState).toBe('skipped')
    expect(fake.calls.send).toEqual([])
  })
})

describe('finalize（最终总结；拿不到就回退）', () => {
  it('拿到总结文本（去协议标记）', async () => {
    const fake = fakeSubagents()
    const { ctx, emit } = makeCtx({ subagents: fake.service })
    const board = makeBoard()
    const mgr = manager(ctx, board)
    await mgr.ensure(KEY)

    const p = mgr.finalize(KEY)
    await Promise.resolve()
    emit('subagent/end', {
      id: 'child-1',
      stopReason: 'completed',
      lastAssistantMessage: [{ type: 'text', text: '本次改造达成了 X\nTASK_DONE' }],
    })
    const text = await p
    expect(text).toContain('本次改造达成了 X')
    expect(text).not.toContain('TASK_DONE')
  })

  it('超时 ⇒ undefined（调用方用模板总结兜底）', async () => {
    const { ctx } = makeCtx({ subagents: fakeSubagents().service })
    const mgr = manager(ctx, makeBoard(), { finalizeTimeoutMs: 20 })
    await mgr.ensure(KEY)
    expect(await mgr.finalize(KEY)).toBeUndefined()
  })
})

describe('launchReusedTask（AC3.3/AC3.4）', () => {
  it('首次建立持久子会话并登记复用键；第二次复用同一会话', async () => {
    const fake = fakeSubagents()
    const { ctx } = makeCtx({ subagents: fake.service })
    const board = makeBoard()
    const mgr = manager(ctx, board, { taskSettleTimeoutMs: 20 })
    await mgr.ensure(KEY)

    const input = {
      requirementId: KEY,
      taskId: TASK,
      parent: { session: { id: 'parent-1' } } as unknown as Agent,
      prompt: [{ type: 'text', text: '干活' }] as never,
      role: { provider: 'spawn' },
      frozenConfig: {},
    }
    // child-1 是 ensure 建的**编排**会话；任务子会话是 child-2 —— 两者必须是不同会话。
    const first = await mgr.launchReusedTask(input)
    expect(first.reused).toBe(false)
    expect(first.id).toBe('child-2')
    expect(await first.result).toMatchObject({ stopReason: 'error' }) // 20ms 观测超时 → 失败收口

    const second = await mgr.launchReusedTask({ ...input, taskId: `${KEY}#impl` })
    expect(second.reused).toBe(true)
    expect(second.id).toBe('child-2')
    expect(fake.calls.start).toBe(2) // 1 次编排会话 + 1 次任务会话（第二次复用，不新建）
    expect(fake.calls.send).toContain('child-2')
    await second.result
  })

  it('同一复用键并发 ⇒ 串行（E6：第二个必须等第一个落定后才投递）', async () => {
    const fake = fakeSubagents()
    const { ctx } = makeCtx({ subagents: fake.service })
    const board = makeBoard()
    const mgr = manager(ctx, board, { taskSettleTimeoutMs: 30 })
    await mgr.ensure(KEY)

    const base = {
      requirementId: KEY,
      parent: { session: { id: 'parent-1' } } as unknown as Agent,
      prompt: [{ type: 'text', text: '干活' }] as never,
      role: { provider: 'spawn' },
      frozenConfig: {},
    }
    const a = mgr.launchReusedTask({ ...base, taskId: TASK })
    // 第一个还在跑（30ms 观测超时未到），此刻第二个必须**还没**投递。
    const b = mgr.launchReusedTask({ ...base, taskId: `${KEY}#impl` })
    await new Promise(r => setTimeout(r, 5))
    expect(fake.calls.send).toEqual([])

    const ha = await a
    expect(fake.calls.send).toEqual([]) // 仍是首轮（新建会话，不走 sendMessage）
    await ha.result // 首轮落定 ⇒ 让出"发言权"

    const hb = await b
    expect(hb.reused).toBe(true)
    expect(fake.calls.send).toEqual([hb.id])
    await hb.result
  })

  it('观测超时 ⇒ 合成 failed（绝不留 running 悬挂，AC3.4）', async () => {
    const fake = fakeSubagents()
    const { ctx } = makeCtx({ subagents: fake.service })
    const board = makeBoard()
    const mgr = manager(ctx, board, { taskSettleTimeoutMs: 20 })
    await mgr.ensure(KEY)
    const r = await mgr.launchReusedTask({
      requirementId: KEY,
      taskId: TASK,
      parent: { session: { id: 'parent-1' } } as unknown as Agent,
      prompt: [{ type: 'text', text: '干活' }] as never,
      role: { provider: 'spawn' },
      frozenConfig: {},
    })
    const outcome = await r.result
    expect(outcome.stopReason).toBe('error')
    expect(String((outcome as { diagnostic?: string }).diagnostic)).toContain('停滞超时')
  })

  it('复用会话 turn/end 事件 ⇒ 立即落定（不再等超时；2026-10-31 根因修复）', async () => {
    /**
     * 2030877 现场：turn 2 干了 88 分钟真活、`turn/end {turn:2, reason:completed}` 已写入
     * 会话日志，但旧实现在 `source==='live'` 时永远 return（复用会话长期 live），
     * 只能等 30 分钟超时误判失败。现在以 turn/end 为收口信号。
     */
    const fake = fakeSubagents()
    /** 可控的 sessionQuery 桩：turn/end 事件在 settleFromSessionLog 第二次轮询后出现。 */
    let pollCount = 0
    const sessionQuery = {
      observeSession: async () => {
        pollCount += 1
        const events = pollCount >= 2
          ? [
              { type: 'turn/start', data: { turn: 1 } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '第一轮完成' }] } } },
              { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } },
              { type: 'turn/start', data: { turn: 2 } },
              { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: '✅ 步骤 1/2：完成\n✅ 步骤 2/2：完成\nTASK_DONE' }] } } },
              { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } },
            ]
          : [{ type: 'turn/start', data: { turn: 2 } }]
        return { source: 'live', events, dispose: () => {} }
      },
    }
    const { ctx } = makeCtx({ subagents: fake.service, sessionQuery })
    const board = makeBoard()
    // 停滞超时给大（5 秒）：若 turn/end 检测失效会走超时路径（5s 后才失败），
    // 而正确行为应在第 2 次轮询（约 2s）就落定为 completed。
    const mgr = manager(ctx, board, {
      taskSettleTimeoutMs: 5000,
      pollIntervalMs: 100,
      getSessionQuery: () => sessionQuery,
    })
    await mgr.ensure(KEY)
    const start = Date.now()
    const r = await mgr.launchReusedTask({
      requirementId: KEY,
      taskId: TASK,
      parent: { session: { id: 'parent-1' } } as unknown as Agent,
      prompt: [{ type: 'text', text: '干活' }] as never,
      role: { provider: 'spawn' },
      frozenConfig: {},
    })
    const outcome = await r.result
    const elapsed = Date.now() - start
    // 落定为 completed（不是超时 error），且在停滞超时（5s）之前。
    expect(outcome.stopReason).toBe('completed')
    expect(elapsed).toBeLessThan(5000)
    // 输出取自 turn 2 的最后一条 assistant 文本。
    expect(JSON.stringify(outcome.output)).toContain('TASK_DONE')
  })
})

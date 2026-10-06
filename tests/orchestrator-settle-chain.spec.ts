import { describe, expect, it } from 'vitest'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Board } from '../src/core/board/board.js'
import { BoardService } from '../src/host/board-service.js'
import { createHostApi } from '../src/host/api.js'
import type { Requirement } from '../src/tfs/types.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

/**
 * 收口链路的两个回归（2026-10-01 修复）：
 *
 * 1. **钩子是 async，`try/catch` 抓不到它的 rejection** ⇒ 一旦拒绝就静默中断，
 *    "下一个任务不启动、不回写"，且面板上没有任何线索。修复后必须落进事件日志。
 * 2. **归纳不能阻塞放行**：continuable 子没有 per-message result，归纳可能一直观测不到收口；
 *    若把 `await summarize()` 放在 `autoStartRunnable` 前面，用户就会看到
 *    "上一个任务完成了，下一个迟迟不启动"。
 */

const KEY = '1997179@WN_HIS'
const A = `${KEY}#analyze`
const B = `${KEY}#impl`

const sleep = (ms: number): Promise<void> => new Promise(r => setTimeout(r, ms))

function makeBoard(fs?: MemFs): { svc: BoardService; fs: MemFs } {
  const mem = fs ?? createMemFs()
  const svc = new BoardService({
    baseDir: '/mem/board',
    fs: mem,
    board: new Board(),
    adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as never,
    roles: { list: () => [], getByName: () => undefined } as never,
    defaultLabel: 'dsh',
  })
  svc.board.claimRequirement({
    workItemId: 1997179,
    collection: 'WN_HIS',
    project: 'P',
    title: '汇总改造',
    state: '已建议',
    assignedTo: '',
    priority: '',
    iteration: '',
    tags: [],
    createdAt: '2026-09-30T00:00:00.000Z',
    updatedAt: '2026-09-30T00:00:00.000Z',
    revision: 1,
  } as Requirement)
  svc.board.addTask({
    taskId: A,
    requirementId: KEY,
    idempotencyKey: 'k1',
    title: '分析',
    description: '',
    roleAgent: '架构师',
    frozenConfig: { mcp: [], skills: [], model: '' },
  })
  svc.board.addTask({
    taskId: B,
    requirementId: KEY,
    idempotencyKey: 'k2',
    title: '开发',
    description: '',
    roleAgent: '架构师',
    frozenConfig: { mcp: [], skills: [], model: '' },
    blockedBy: [A],
  })
  return { svc, fs: mem }
}

/**
 * A 任务成功收口（触发宿主侧收口钩子）。
 *
 * 必须先 `start`：真实链路里 `dispatch` 会先把任务置为 in_progress/running 再派发，
 * 引擎的状态机不接受 pending → completed 的跳跃（与 `canTransition` 表一致）。
 */
function settleSuccess(svc: BoardService, taskId: string): void {
  const started = svc.setTaskState(taskId, 'start')
  if (!started.ok) throw new Error(`测试前置失败：${started.reason}`)
  svc.settleTask(taskId, 'success', { runId: `run-${taskId}`, stopReason: 'completed' })
}

function harness(opts: {
  summarize: (key: string, taskId: string) => Promise<string>
  graceMs?: number
}): { svc: BoardService; dispatched: () => string[] } {
  const { svc } = makeBoard()
  const dispatched: string[] = []
  const role = { id: 'r', name: '架构师', provider: 'spawn', permission: 'read-only' as const }
  // createHostApi 内部会 `deps.board?.setSettledHook?.(handleTaskSettled)`。
  createHostApi({
    roles: { list: () => [role], getByName: () => role, save: () => {}, delete: () => {} } as never,
    adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as never,
    dispatcher: {
      dispatch: async (r: { taskId: string }) => {
        dispatched.push(r.taskId)
        return { taskId: r.taskId, requirementId: KEY, runId: `run-${r.taskId}`, provider: 'spawn' }
      },
      getRun: () => undefined,
    } as never,
    board: svc,
    getParent: () => ({ session: { id: 'parent-1' } }) as unknown as Agent,
    models: [],
    mcpServers: [],
    skills: [],
    tagSuggestions: [],
    collection: 'WN_HIS',
    orchestrator: {
      ensure: async () => ({
        mode: 'continuable' as const,
        orchestratorSessionId: 'child-1',
        parentSessionId: 'parent-1',
      }),
      summarize: async (key: string, taskId: string) => opts.summarize(key, taskId),
      finalize: async () => undefined,
    } as never,
    summarizeGraceMs: opts.graceMs ?? 10,
    finalizeGraceMs: 10,
  })
  return { svc, dispatched: () => dispatched }
}

describe('收口钩子：async 拒绝必须可见（不能静默吞掉）', () => {
  it('钩子 reject ⇒ events.jsonl 出现 settle-hook-failed', async () => {
    const { svc, fs } = makeBoard()
    let calls = 0
    svc.setSettledHook(() => {
      calls += 1
      return Promise.reject(new Error('钩子内部炸了'))
    })
    settleSuccess(svc, A)
    await sleep(20)

    expect(calls).toBe(1)
    const raw = fs.dump()['/mem/board/events.jsonl'] ?? ''
    expect(raw).toContain('settle-hook-failed')
    expect(raw).toContain('钩子内部炸了')
  })

  it('钩子正常 resolve ⇒ 不产生 settle-hook-failed', async () => {
    const { svc, fs } = makeBoard()
    svc.setSettledHook(() => Promise.resolve())
    settleSuccess(svc, A)
    await sleep(20)
    expect(fs.dump()['/mem/board/events.jsonl'] ?? '').not.toContain('settle-hook-failed')
  })
})

describe('归纳不阻塞放行（2026-10-01）', () => {
  it('归纳永不返回 ⇒ 宽限到期后下一个任务仍被自动启动', async () => {
    // 模拟"观测不到 continuable 收口"：summarize 永远 pending。
    const { svc, dispatched } = harness({ summarize: () => new Promise<string>(() => {}) })
    settleSuccess(svc, A)
    await sleep(80)
    expect(dispatched()).toContain(B)
    expect(svc.snapshot().tasks.find(t => t.taskId === B)?.autoLaunched).toBe(true)
  })

  it('归纳快速返回 ⇒ 归纳确实被调用（结论落盘由 orchestrator-session 覆盖），且下一个任务照常放行', async () => {
    // 这里的 orchestrator 是**桩**：它只负责返回结论，落盘由真实的
    // `OrchestratorSessionManager.summarize` 完成（已在 orchestrator-session.spec.ts 断言）。
    const seen: string[] = []
    const { svc, dispatched } = harness({
      summarize: async (_key: string, taskId: string) => {
        seen.push(taskId)
        return '改了 A'
      },
    })
    settleSuccess(svc, A)
    await sleep(80)
    expect(seen).toContain(A)
    expect(dispatched()).toContain(B)
  })

  it('归纳抛错 ⇒ 不影响放行', async () => {
    const { svc, dispatched } = harness({
      summarize: () => Promise.reject(new Error('sendMessage 失败')),
    })
    settleSuccess(svc, A)
    await sleep(80)
    expect(dispatched()).toContain(B)
  })
})

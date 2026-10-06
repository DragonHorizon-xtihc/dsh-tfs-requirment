/**
 * 2026-10-06 审计修复的**可执行回归**（每条断言对应一个已复现并修掉的缺陷）。
 *
 * 纪律：这些用例锁的是**行为**，不是实现。若将来有人改动了 deleteTasks / enrichRequirement /
 * finalize / removeTags 的语义，这里必须红；也正因为如此，本文件里每个 describe 的注释都写清了
 * 「不修会怎样」，避免后人把它当成可以顺手跳过的形式化测试。
 *
 * 复现证据见 `scripts/e2e-1006-defects.ts`（真实组件 + 真实 fs 跑出的实测输出）。
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'

import { Board } from '../src/core/board/board.js'
import { BoardService, LOCAL_REQUIREMENT_FIELDS } from '../src/host/board-service.js'
import { OrchestratorSessionManager } from '../src/host/orchestrator-session.js'
import { createRequirementExecStateHandler } from '../src/host/route.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import type { BoardTfsPort } from '../src/host/board-service.js'
import type { RequirementSummary, RoleDefinition } from '../src/shared/contracts.js'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { createMemFs } from './helpers/memfs.js'

const ROLES: RoleDefinition[] = [
  { id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm1' },
]

/**
 * **纯 TFS 侧字段**（`summaryToRequirement` 由服务端摘要产出、本地不得覆盖的那些）。
 *
 * 与"混合字段"（workspace/prompt/execState/completedAt/writeBack：摘要里可能有、但权威值在本地）
 * 区分开。enrich 保留本地值的正确性前提，就是它只覆盖后者而不碰前者。
 */
const PURE_TFS_FIELDS = [
  'workItemId', 'collection', 'project', 'title', 'state', 'assignedTo', 'priority',
  'iteration', 'tags', 'createdAt', 'updatedAt', 'type', 'url', 'areaPath',
  'description', 'analysis', 'dataStructure', 'config',
] as const

function summary(id: number, over: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id,
    collection: 'WN_HIS',
    project: 'PEIS',
    title: `需求 ${id}`,
    type: '产品需求',
    state: 'Active',
    assignedTo: '',
    priority: '2',
    areaPath: 'PEIS',
    iterationPath: 'Sprint 1',
    tags: [],
    changedDate: '2026-09-17T00:00:00Z',
    url: '',
    ...over,
  }
}

function makePort(): BoardTfsPort {
  return {
    async getRequirement(id, collection) {
      return summary(Number(id), { collection })
    },
    async addTags() {
      return { ok: true }
    },
    async removeTags() {
      return { id: 0, tags: [] }
    },
  }
}

interface SettledCall {
  taskId: string
  requirementKey: string
  outcome: string
}

function makeService(baseDir: string, settled: SettledCall[]): { svc: BoardService; engine: Board } {
  const engine = new Board()
  const svc = new BoardService({
    baseDir,
    fs: createMemFs(),
    board: engine,
    adapter: makePort(),
    roles: { list: () => ROLES, getByName: n => ROLES.find(r => r.name === n) },
    defaultLabel: 'dsh',
    onTaskSettled: info => {
      settled.push({ taskId: info.taskId, requirementKey: info.requirementKey, outcome: info.outcome })
    },
  })
  return { svc, engine }
}

/** 让 microtask 钩子落地（钩子是 `queueMicrotask` 排的，同步断言看不到）。 */
const flush = (): Promise<void> => new Promise(r => setTimeout(r, 10))

// ───────────────────────────── B1 ─────────────────────────────

describe('B1 deleteTasks：删除已取消任务后必须触发收口钩子', () => {
  it('删到"全部终态"⇒ 需求封存 **且** onTaskSettled 被触发（代表任务取仍存活的那个）', async () => {
    const settled: SettledCall[] = []
    const { svc, engine } = makeService('C:/b1', settled)
    await svc.claimRequirement({ requirement: summary(900001), tag: false })
    const key = '900001@WN_HIS'
    const ids = svc.decompose(key).taskIds ?? []
    expect(ids.length).toBeGreaterThanOrEqual(2)

    // 用 active 抑制自动完成，再 reset 回"未判定"，让 deleteTasks 成为**唯一**收口触发点。
    svc.setRequirementExecState(key, 'active')
    svc.setTaskState(ids[0]!, 'start')
    svc.setTaskState(ids[0]!, 'complete')
    for (const id of ids.slice(1)) svc.setTaskState(id, 'cancel')
    await flush()
    settled.length = 0
    engine.resetRequirementCompletion(key)

    const del = svc.deleteTasks([ids[1]!])
    await flush()

    expect(del.ok).toBe(true)
    // 需求确实被封存了 —— 这正是旧实现"封存了却不发钩子"的荒谬之处。
    expect(engine.snapshot.requirements[key]?.execState).toBe('completed')
    // 核心断言：钩子必须触发，且带的是一个**仍存在**的任务 id（不是被删掉的那个）。
    expect(settled).toHaveLength(1)
    expect(settled[0]?.taskId).toBe(ids[0])
    expect(engine.snapshot.tasks[settled[0]!.taskId]).toBeDefined()
  })

  it('代表任务不存在（名下任务被删空）⇒ 不封存也不发钩子，不抛错', async () => {
    const settled: SettledCall[] = []
    const { svc } = makeService('C:/b1-empty', settled)
    await svc.claimRequirement({ requirement: summary(900002), tag: false })
    const key = '900002@WN_HIS'
    const ids = svc.decompose(key).taskIds ?? []
    for (const id of ids) svc.setTaskState(id, 'cancel')
    await flush()
    settled.length = 0

    const del = svc.deleteTasks(ids)
    await flush()
    expect(del.ok).toBe(true)
    // 名下已无任何任务 ⇒ "全部终态"判据不成立（且没有已完成任务）⇒ 不封存、不发钩子。
    expect(settled).toHaveLength(0)
  })
})

// ───────────────────────────── B2 ─────────────────────────────

describe('B2 enrichRequirement：重取正文不得抹掉本地补充字段', () => {
  it('orchestration / writeBack / workspace / prompt / execState 全部存活', async () => {
    const settled: SettledCall[] = []
    const { svc } = makeService('C:/b2', settled)
    await svc.claimRequirement({ requirement: summary(900003), tag: false, workspace: 'C:/repo', prompt: '背景' })
    const key = '900003@WN_HIS'
    svc.setOrchestration(key, {
      mode: 'continuable',
      orchestratorSessionId: 'child-ORCH-1',
      parentSessionId: 'p',
      taskSessions: { '900003@WN_HIS|spawn|': 'child-TASK-1' },
    })
    svc.setRequirementWriteBack(key, {
      requirementKey: key,
      at: '2026-10-06T00:00:00Z',
      status: 'done',
      items: [{ kind: 'comment', target: '结论评论', status: 'ok' }],
    } as never)
    svc.setRequirementExecState(key, 'active')

    const res = await svc.enrichRequirement(key)
    expect(res.ok).toBe(true)

    const raw = svc.snapshot().requirements.find(r => `${r.id}@${r.collection}` === key)
    expect(raw?.orchestration?.orchestratorSessionId).toBe('child-ORCH-1')
    expect(raw?.orchestration?.taskSessions?.['900003@WN_HIS|spawn|']).toBe('child-TASK-1')
    expect((raw?.writeBack as { items?: unknown[] } | undefined)?.items).toHaveLength(1)
    expect(raw?.workspace).toBe('C:/repo')
    expect(raw?.prompt).toBe('背景')
    expect(raw?.execState).toBe('active')
  })

  it('TFS 侧字段仍然被刷新（保留本地字段 ≠ 不更新服务端字段）', async () => {
    const settled: SettledCall[] = []
    const { svc } = makeService('C:/b2-fresh', settled)
    await svc.claimRequirement({ requirement: summary(900004, { title: '旧标题' }), tag: false })
    // 让重取返回新标题
    const port = makePort()
    port.getRequirement = async () => summary(900004, { title: '新标题', state: 'Resolved' })
    const engine = new Board()
    const svc2 = new BoardService({
      baseDir: 'C:/b2-fresh2',
      fs: createMemFs(),
      board: engine,
      adapter: port,
      roles: { list: () => ROLES, getByName: n => ROLES.find(r => r.name === n) },
      defaultLabel: 'dsh',
    })
    await svc2.claimRequirement({ requirement: summary(900004, { title: '旧标题' }), tag: false })
    const r = await svc2.enrichRequirement('900004@WN_HIS')
    expect(r.ok).toBe(true)
    expect(engine.snapshot.requirements['900004@WN_HIS']?.title).toBe('新标题')
    expect(engine.snapshot.requirements['900004@WN_HIS']?.state).toBe('Resolved')
  })

  it('清单完整性：本次漏掉的两个字段在列，且不得混入 TFS 侧字段', () => {
    // 守卫一：本轮被抹掉的正是这两个，单独点名，避免清单被整体替换时也"看起来齐全"。
    expect(LOCAL_REQUIREMENT_FIELDS).toContain('orchestration')
    expect(LOCAL_REQUIREMENT_FIELDS).toContain('writeBack')
    // 守卫二：其余本地补充字段同样在列。
    for (const k of ['workspace', 'prompt', 'execState', 'completedAt', 'revision']) {
      expect(LOCAL_REQUIREMENT_FIELDS).toContain(k)
    }
    // 守卫三：清单里不得混入**纯 TFS 字段** —— 混入会让重取无法刷新服务端数据
    // （"保留本地字段"的正确性前提是它确实只覆盖本地字段）。
    // 注意 workspace/prompt/execState/completedAt/writeBack 是"混合字段"：视图与摘要都会带，
    // 但权威值在本地，故保留本地值是有意的，不计入纯 TFS 集合。
    for (const k of PURE_TFS_FIELDS) {
      expect(LOCAL_REQUIREMENT_FIELDS as readonly string[]).not.toContain(k)
    }
  })
})

// ───────────────────────────── B3 ─────────────────────────────

describe('B3 finalize：必须与 summarize 共用串行 gate（防结论串台）', () => {
  const CHILD = 'child-ORCH-9'
  const KEY = '900005@WN_HIS'

  function makeManager(): OrchestratorSessionManager {
    const board = {
      getOrchestration: () => ({ mode: 'continuable' as const, orchestratorSessionId: CHILD, parentSessionId: 'p' }),
      setOrchestration: () => {},
      setTaskOrchestration: () => {},
      board: {
        snapshot: {
          tasks: { t1: { title: '任务一', attempts: [], artifactPaths: [] } },
          requirements: { [KEY]: { title: '需求' } },
        },
      },
    }
    return new OrchestratorSessionManager({
      ctx: {
        get: (n: string) => (n === 'subagents' ? { sendMessage: () => new Promise(() => {}) } : undefined),
        on: () => () => {},
      } as unknown as Context,
      getParent: () => ({ id: 'p' }),
      provider: 'spawn',
      enabled: true,
      board: board as never,
      summarizeTimeoutMs: 30_000,
      finalizeTimeoutMs: 30_000,
      taskSettleTimeoutMs: 30_000,
    } as never)
  }

  it('后台 summarize 仍挂着时，finalize 不得再挂到同一个 childId 上', async () => {
    const mgr = makeManager()
    const waiters = (mgr as unknown as { watcher: { waiters: Map<string, Set<unknown>> } }).watcher.waiters
    void mgr.summarize(KEY, 't1').catch(() => {})
    await new Promise(r => setTimeout(r, 20))
    expect(waiters.get(CHILD)?.size).toBe(1)

    void mgr.finalize(KEY).catch(() => {})
    await new Promise(r => setTimeout(r, 20))
    // 关键：仍是 1 —— finalize 在 gate 里排队，没有叠加第二个等待者。
    // 叠加 = 一次落定会同时唤醒两边（watcher 按 childId 广播）⇒ 结论串台。
    expect(waiters.get(CHILD)?.size).toBe(1)
  })

  it('summarize / finalize 异常退出时 abort，等待者不残留在 watcher 上', async () => {
    const mgr = new OrchestratorSessionManager({
      ctx: { get: () => undefined, on: () => () => {} } as unknown as Context,
      getParent: () => ({ id: 'p' }),
      provider: 'spawn',
      enabled: true,
      board: {
        getOrchestration: () => ({ mode: 'continuable' as const, orchestratorSessionId: 'c9', parentSessionId: 'p' }),
        setOrchestration: () => {},
        setTaskOrchestration: () => {},
        board: { snapshot: { tasks: {}, requirements: {} } },
      } as never,
      summarizeTimeoutMs: 30_000,
      finalizeTimeoutMs: 30_000,
    } as never)
    const waiters = (mgr as unknown as { watcher: { waiters: Map<string, Set<unknown>> } }).watcher.waiters
    // subagents 服务不存在 ⇒ sendMessageOn 抛错 ⇒ 走 catch 分支
    await expect(mgr.finalize('k@C')).resolves.toBeUndefined()
    expect(waiters.get('c9')?.size ?? 0).toBe(0)
  })
})

// ───────────────────────────── B6 ─────────────────────────────

describe('B6 removeTags：只读 System.Tags，不拉全字段全 relations', () => {
  it('发出的读请求带 `fields=System.Tags`', async () => {
    const urls: string[] = []
    const fetchImpl = ((url: string) => {
      urls.push(url)
      const body = JSON.stringify({
        id: 1,
        rev: 3,
        fields: { 'System.Tags': 'dsh;keep' },
        // 故意塞一大坨 relations：不带 fields 时真实 TFS 会把它们一起返回（实测可达 3.3MB）
        relations: Array.from({ length: 50 }, (_, i) => ({ rel: 'AttachedFile', url: `http://x/${i}` })),
      })
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () => Promise.resolve(body),
        headers: new Headers(),
      } as Response)
    }) as unknown as typeof fetch

    const fs = createMemFs()
    const adapter = new TfsAdapter({
      rest: { url: 'http://tfs.test:8080/tfs', collection: 'WN_HIS', pat: 'fake', fetchImpl },
      writeGuard: new WriteGuard(new AuditLog('C:/b6', fs)),
      collection: 'WN_HIS',
      profileLabel: 'audit',
    })

    try {
      await adapter.removeTags(1, 'WN_HIS', ['dsh'], true)
    } catch {
      // 写回阶段桩返回同形响应，成败不影响本条观测：只关心"读标签那一次请求"。
    }
    const read = urls.find(u => u.includes('/_apis/wit/workitems/1'))
    expect(read).toBeDefined()
    expect(read).toContain('fields=System.Tags')
  })
})

// ───────────────── M1 已完成任务的「撤销完成」出口 ─────────────────

describe('M1 已完成任务可撤销完成 ⇒ 需求才可能还原回需求池', () => {
  it('completed 任务经 cancel 回到 deleted 后，restoreRequirement 才放行', async () => {
    const settled: SettledCall[] = []
    const { svc } = makeService('C:/m1', settled)
    await svc.claimRequirement({ requirement: summary(900006), tag: false })
    const key = '900006@WN_HIS'
    const ids = svc.decompose(key).taskIds ?? []

    svc.setTaskState(ids[0]!, 'start')
    svc.setTaskState(ids[0]!, 'complete')
    for (const id of ids.slice(1)) svc.setTaskState(id, 'cancel')
    await flush()
    // 先解除「需求已完成」这道前置门禁，才能观测到"任务层面"的门禁。
    svc.setRequirementExecState(key, 'active')

    // 死结的原状：名下还有 completed 任务 ⇒ 还原被拒（这是引擎的正确门禁）。
    const blocked = await svc.restoreRequirement(key)
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toMatch(/请先取消该需求的全部任务/)

    // 出口：把已完成任务「撤销完成」（引擎 TASK_TRANSITIONS 允许 completed → deleted）。
    // UI 此前从未暴露这个动作（`actionsFor` 对 completed 返回 []），于是需求永远还原不回去。
    const undone = svc.setTaskState(ids[0]!, 'cancel')
    expect(undone.ok).toBe(true)
    await flush()

    const ok = await svc.restoreRequirement(key)
    expect(ok.ok).toBe(true)
  })
})

// ───────────────── M2 setOrchestration 不得覆盖并发登记的 taskSessions ─────────────────

describe('M2 ensure 建会话期间并发登记的 taskSessions 不被陈旧快照覆盖', () => {
  it('写回前重读：新建的 orchestration 带上 await 期间登记的复用键', async () => {
    const KEY = '900007@WN_HIS'
    let readCount = 0
    const written: Array<Record<string, unknown> | undefined> = []
    const board = {
      // 第一次读（await 前）：还没有 taskSessions；第二次读（写回前重读）：期间被登记了一条。
      getOrchestration: () => {
        readCount += 1
        return readCount === 1
          ? { mode: 'off' as const }
          : { mode: 'off' as const, taskSessions: { '900007@WN_HIS|spawn|': 'child-NEW' } }
      },
      setOrchestration: (_k: string, next: Record<string, unknown>) => {
        written.push(next)
      },
      setTaskOrchestration: () => {},
      board: { snapshot: { tasks: {}, requirements: {} } },
    }
    const mgr = new OrchestratorSessionManager({
      ctx: {
        get: (n: string) =>
          n === 'subagents'
            ? {
                // `pickProvider` 要求 list() 返回 provider 名字符串数组。
                list: () => ['spawn'],
                startContinuable: async () => ({ childId: 'child-ORCH-2' }),
              }
            : undefined,
        on: () => () => {},
      } as unknown as Context,
      // 父会话必须带 session.id，否则 ensure 以"未携带会话 id"降级。
      getParent: () => ({ id: 'p', session: { id: 'parent-session-1' } }),
      provider: 'spawn',
      enabled: true,
      board: board as never,
      getSessionQuery: () => undefined,
      summarizeTimeoutMs: 1_000,
      finalizeTimeoutMs: 1_000,
    } as never)

    const out = await mgr.ensure(KEY, { force: true })
    expect(out.mode).toBe('continuable')
    expect(readCount).toBeGreaterThanOrEqual(2) // 确实发生了"写回前重读"
    const last = written[written.length - 1]
    // 关键：并发登记进来的复用键不能被陈旧快照覆盖掉。
    expect((last?.taskSessions as Record<string, string> | undefined)?.['900007@WN_HIS|spawn|']).toBe('child-NEW')
  })
})

// ───────────────── B5 route：exec-state handler 的 rejection 分支 ─────────────────

describe('B5 需求执行状态端点：失败必须回响应，不能让请求挂起', () => {
  /** 最小 `IncomingMessage` 桩：把 body 一次喂完（readJsonBody 监听 data/end/aborted/close）。 */
  function makeReq(body: unknown): IncomingMessage {
    const listeners = new Map<string, Array<(...a: unknown[]) => void>>()
    const req = {
      method: 'POST',
      url: '/x',
      complete: false,
      on: (ev: string, fn: (...a: unknown[]) => void) => {
        const arr = listeners.get(ev) ?? []
        arr.push(fn)
        listeners.set(ev, arr)
        return req
      },
      destroy: () => {},
    }
    // 下一个宏任务再派发，让 handler 先挂上监听。
    setImmediate(() => {
      const raw = JSON.stringify(body)
      for (const fn of listeners.get('data') ?? []) fn(Buffer.from(raw, 'utf8'))
      req.complete = true
      for (const fn of listeners.get('end') ?? []) fn()
      for (const fn of listeners.get('close') ?? []) fn()
    })
    return req as unknown as IncomingMessage
  }

  it('api 抛错 ⇒ 端点回错误响应（而非 unhandled rejection + 无响应）', async () => {
    // ⚠️ 真实的 `api.setRequirementExecState` 是 async：失败表现为 **rejected promise**，
    // 不是同步抛。同步抛会被 `guardedWebServer` 的 try/catch 接住，而 rejection 不会 ——
    // 所以桩必须同样是 async，才能复现"响应挂起 + unhandled rejection"这个真实故障形态。
    const api = {
      setRequirementExecState: async () => {
        throw new Error('需求不在本地池：x@C')
      },
    }
    let status = 0
    let sent = false
    const res = {
      writableEnded: false,
      setHeader: () => {},
      writeHead: (s: number) => {
        status = s
      },
      end: () => {
        sent = true
      },
    } as unknown as ServerResponse

    const handler = createRequirementExecStateHandler(api as never)
    await handler(makeReq({ requirementKey: 'x@C', state: 'completed' }), res)
    // 核心断言：必须有响应。旧实现（单参 .then）在 rejection 时既不回响应、
    // 也产生一条 unhandled rejection，客户端只能干等到浏览器超时。
    expect(sent).toBe(true)
    expect(status).toBeGreaterThanOrEqual(400)
  })
})

import { describe, expect, it } from 'vitest'
import { Board } from '../src/core/board/board.js'
import { BoardService } from '../src/host/board-service.js'
import { createMemFs } from './helpers/memfs.js'
import type { BoardTfsPort } from '../src/host/board-service.js'
import type { RequirementSummary, RoleDefinition } from '../src/shared/contracts.js'

/**
 * 问题 5 / 问题 6 / 问题 3 的看板状态机集成测试（真实 Board + BoardService，内存 fs，桩适配层）。
 *
 *  - 问题 5：子 agent 输出"请人工确认"时落 needs_confirmation（看板态保持 in_progress），
 *    不被判成功、不触发下游；必须经 confirm 人工确认通过后才 completed、下游才就绪。
 *  - 问题 6：任务 success 收口后 autoStartRunnable 自动启动已就绪下游（autoLaunched 标记），
 *    待确认 / 失败会自然阻断；受并发上限约束。
 *  - 问题 3：未执行（pending）/ 待人工确认任务可编辑 preset 与预算；running 中禁编。
 */

const KEY = '500@WN_HIS'
const ROLES: RoleDefinition[] = [{ id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm1' }]

function summary(): RequirementSummary {
  return {
    id: 500,
    collection: 'WN_HIS',
    project: 'PEIS',
    title: '需求 500',
    type: '需求',
    state: '活动',
    assignedTo: 'zhangbo3',
    priority: '2',
    areaPath: 'PEIS',
    iterationPath: 'Sprint 1',
    tags: [],
    changedDate: '2026-09-20T00:00:00Z',
    url: 'http://tfs/wit/workItems/500',
  }
}

function makeAdapter(): BoardTfsPort {
  return {
    async getRequirement(id, collection) {
      return { ...summary(), id, collection: collection ?? 'WN_HIS' }
    },
    async addTags() {
      return { ok: true }
    },
  } as BoardTfsPort
}

async function harness() {
  const board = new Board()
  const svc = new BoardService({
    baseDir: '/mem/chain',
    fs: createMemFs(),
    board,
    adapter: makeAdapter(),
    roles: { list: () => ROLES, getByName: n => ROLES.find(r => r.name === n) },
    defaultLabel: 'dsh',
  })
  const claim = await svc.claimRequirement({ requirement: summary() })
  if (!claim.ok) throw new Error(claim.reason ?? 'claim failed')
  const add = (taskId: string, title: string, blockedBy: string[] = []) =>
    board.addTask({
      taskId,
      requirementId: KEY,
      idempotencyKey: taskId,
      title,
      description: title,
      roleAgent: '架构师',
      frozenConfig: { mcp: [], skills: [], model: 'm1' },
      blockedBy,
    })
  return { board, svc, add }
}

describe('问题 5：needs_confirmation 不再被当成功，人工确认后才放行', () => {
  it('收口为待确认：保持 in_progress、阻断下游与自动链；confirm 后 completed 且下游就绪', async () => {
    const { board, svc, add } = await harness()
    add('a', '分析')
    add('b', '实现', ['a'])
    add('c', '测试', ['b'])

    board.startTask('a', 0)
    const settled = svc.settleTask('a', 'needs_confirmation', { note: '口径待拍板：是否下线旧接口' })
    expect(settled.ok).toBe(true)

    const sa = board.snapshot.tasks['a']!
    // 看板态刻意保持 in_progress，执行链路态为待确认。
    expect(sa.state).toBe('in_progress')
    expect(sa.execState).toBe('needs_confirmation')
    expect(sa.attempts[sa.attempts.length - 1]!.outcome).toBe('needs_confirmation')

    // 下游依赖未 completed ⇒ 不就绪，自动链不启动。
    expect(board.pickRunnable(3)).not.toContain('b')
    expect(svc.autoStartRunnable(3).taskIds).toEqual([])

    // 非待确认态（pending 的 c）不能 confirm。
    expect(svc.setTaskState('c', 'confirm').ok).toBe(false)

    // 人工确认通过。
    const cr = svc.setTaskState('a', 'confirm', sa.revision)
    expect(cr.ok).toBe(true)
    const after = board.snapshot.tasks['a']!
    expect(after.state).toBe('completed')
    expect(after.execState).toBe('success')

    // 审计链：既保留 needs_confirmation 记录，又补了一条 success 收口。
    const outcomes = after.attempts.map(x => x.outcome)
    expect(outcomes).toContain('needs_confirmation')
    expect(outcomes[outcomes.length - 1]).toBe('success')

    // 下游此刻就绪。
    expect(board.pickRunnable(3)).toContain('b')
  })

  it('对已经 completed 的任务 confirm 报错（防重复确认）', async () => {
    const { board, svc, add } = await harness()
    add('a', '分析')
    board.startTask('a', 0)
    svc.settleTask('a', 'success')
    expect(svc.setTaskState('a', 'confirm').ok).toBe(false)
  })
})

describe('问题 6：依赖任务完成后自动链式执行，无需逐个点击', () => {
  it('success 收口 → autoStartRunnable 启动就绪下游并打 autoLaunched，逐级推进', async () => {
    const { board, svc, add } = await harness()
    add('a', '分析')
    add('b', '实现', ['a'])
    add('c', '测试', ['b'])

    // 首批手动启动 a（等价于批量派发只点一次）。
    board.startTask('a', 0)
    svc.settleTask('a', 'success')

    const first = svc.autoStartRunnable(3)
    expect(first.taskIds).toEqual(['b'])
    const tb = board.snapshot.tasks['b']!
    expect(tb.state).toBe('in_progress')
    expect(tb.execState).toBe('running')
    expect(tb.autoLaunched).toBe(true)

    // b 在跑、c 依赖 b：暂无可启动任务（幂等，重复调用不重复启动）。
    expect(svc.autoStartRunnable(3).taskIds).toEqual([])

    // b 收口后 c 自动就绪并启动。
    svc.settleTask('b', 'success')
    expect(svc.autoStartRunnable(3).taskIds).toEqual(['c'])
    expect(board.snapshot.tasks['c']!.autoLaunched).toBe(true)
  })

  it('待人工确认阻断自动链：a 待确认时 b 不被启动', async () => {
    const { board, svc, add } = await harness()
    add('a', '分析')
    add('b', '实现', ['a'])
    board.startTask('a', 0)
    svc.settleTask('a', 'needs_confirmation', { note: '需人工' })
    // a 占着 in_progress 槽且未 completed，b 依赖不满足。
    expect(svc.autoStartRunnable(3).taskIds).toEqual([])
    expect(board.snapshot.tasks['b']!.state).toBe('pending')
  })

  it('并发上限：limit 控制同时自动启动数量，FIFO 字典序', async () => {
    const { board, svc, add } = await harness()
    add('x1', 'x1')
    add('x2', 'x2')
    add('x3', 'x3')
    const r = svc.autoStartRunnable(2)
    expect(r.taskIds.sort()).toEqual(['x1', 'x2'])
    expect(board.snapshot.tasks['x3']!.state).toBe('pending')
    // 两个槽被占满，再调也不放行。
    expect(svc.autoStartRunnable(2).taskIds).toEqual([])
  })
})

describe('问题 3：未执行 / 待确认任务可编辑（preset、预算、提示词），running 禁编', () => {
  it('pending 编辑 preset/预算/提示词落盘；空串清空 preset', async () => {
    const { board, svc, add } = await harness()
    add('b', '实现')
    const r = svc.updateTask('b', { preset: 'p-fast', maxDepth: 2, maxTokens: 12345, prompt: '按补丁落地' })
    expect(r.ok).toBe(true)
    const t = board.snapshot.tasks['b']!
    expect(t.frozenConfig.preset).toBe('p-fast')
    expect(t.frozenConfig.maxDepth).toBe(2)
    expect(t.frozenConfig.maxTokens).toBe(12345)
    expect(t.prompt).toBe('按补丁落地')

    // 传空串 = 清空 preset（整体替换语义，空串不写键）；其余字段保留。
    const cleared = svc.updateTask('b', { preset: '' })
    expect(cleared.ok).toBe(true)
    expect(board.snapshot.tasks['b']!.frozenConfig.preset).toBeUndefined()
    expect(board.snapshot.tasks['b']!.frozenConfig.maxDepth).toBe(2)
  })

  it('running 中禁止编辑（避免实际配置与看板记录不一致）', async () => {
    const { board, svc, add } = await harness()
    add('a', '分析')
    add('b', '实现', ['a'])
    board.startTask('a', 0)
    svc.settleTask('a', 'success')
    board.startTask('b', board.snapshot.tasks['b']!.revision)
    const r = svc.updateTask('b', { prompt: '运行中想改' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('正在执行')
  })

  it('待人工确认任务允许编辑（便于按确认意见调整后追问重跑）', async () => {
    const { board, svc, add } = await harness()
    add('a', '分析')
    board.startTask('a', 0)
    svc.settleTask('a', 'needs_confirmation', { note: '待确认' })
    const r = svc.updateTask('a', { prompt: '补充确认后的口径' })
    expect(r.ok).toBe(true)
    expect(board.snapshot.tasks['a']!.prompt).toBe('补充确认后的口径')
  })
})

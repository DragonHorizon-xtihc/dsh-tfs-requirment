import { describe, expect, it } from 'vitest'
import { Board, BoardError, type TaskDraft } from '../src/core/board/board.js'
import { bumpRevision, canTransition, type TaskSnapshot } from '../src/core/board/task.js'
import { requirementDedupKey, type Requirement } from '../src/tfs/types.js'
import { decomposeRequirement } from '../src/core/board/decompose.js'

function makeReq(workItemId = 1, collection = 'WN_HIS'): Requirement {
  return {
    workItemId,
    collection,
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

function draft(taskId: string, requirementId: string, blockedBy: string[] = []): TaskDraft {
  return {
    taskId,
    requirementId,
    idempotencyKey: `${taskId}:dsh`,
    title: taskId,
    description: '',
    roleAgent: 'general',
    frozenConfig: { mcp: [], skills: [], model: '' },
    blockedBy,
  }
}

describe('任务状态机', () => {
  it('合法转换集合', () => {
    expect(canTransition('pending', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'completed')).toBe(true)
    expect(canTransition('completed', 'deleted')).toBe(true)
    expect(canTransition('pending', 'deleted')).toBe(true)
  })

  it('非法转换被拒绝', () => {
    expect(canTransition('completed', 'in_progress')).toBe(false)
    expect(canTransition('deleted', 'pending')).toBe(false)
    expect(canTransition('pending', 'completed')).toBe(false)
  })

  it('bumpRevision 自增', () => {
    expect(bumpRevision(0)).toBe(1)
    expect(bumpRevision(5)).toBe(6)
  })

  it('transition 校验状态机与 revision 乐观锁', () => {
    const b = new Board()
    const key = requirementDedupKey(makeReq())
    b.claimRequirement(makeReq())
    b.addTask(draft('t1', key))
    // revision 当前为 0，期望 0 → 成功
    b.transition('t1', 'in_progress', 0)
    // 再次用旧 revision 0 → 冲突
    expect(() => b.transition('t1', 'completed', 0)).toThrow(BoardError)
    // 用正确 revision 1 → 成功
    b.transition('t1', 'completed', 1)
    // completed → in_progress 非法
    expect(() => b.transition('t1', 'in_progress', 2)).toThrow(BoardError)
  })
})

describe('DAG 依赖求解', () => {
  it('blockedBy 全部 completed 才可运行', () => {
    const b = new Board()
    const key = requirementDedupKey(makeReq())
    b.claimRequirement(makeReq())
    b.addTask(draft('a', key))
    b.addTask(draft('b', key, ['a']))
    expect(b.isReady('a')).toBe(true)
    expect(b.isReady('b')).toBe(false)
    b.transition('a', 'in_progress', 0)
    b.transition('a', 'completed', 1)
    expect(b.isReady('b')).toBe(true)
  })
})

describe('FIFO 并发排队', () => {
  it('按 limit 释放就绪任务', () => {
    const b = new Board()
    const key = requirementDedupKey(makeReq())
    b.claimRequirement(makeReq())
    for (const id of ['t1', 't2', 't3', 't4', 't5']) b.addTask(draft(id, key))
    // limit=3，5 个 pending 全就绪 → 取前 3（字典序）
    expect(b.pickRunnable(3).sort()).toEqual(['t1', 't2', 't3'])
    // 用 startTask 标记 t1 运行中（只有它会把 execState 置为 running，占住分发器的并发槽；
    // 裸 transition 只改四态，不改 execState，不代表真的在跑）
    b.startTask('t1', 0)
    // 仍剩 2 槽 → 取 t2,t3（已取出的 t1 不在 pending）
    expect(b.pickRunnable(3).sort()).toEqual(['t2', 't3'])
    // limit=1 且已有 1 个在跑 → 无空槽
    b.startTask('t2', 0)
    expect(b.pickRunnable(1)).toEqual([])
  })

  it('失败/待人工确认的任务不占并发槽（B30）', () => {
    const b = new Board()
    const key = requirementDedupKey(makeReq())
    b.claimRequirement(makeReq())
    for (const id of ['t1', 't2', 't3', 't4']) b.addTask(draft(id, key))
    // 三个任务分别落定成 失败 / 待人工确认 / 取消：四态上仍是 in_progress，
    // 但早已把 RequirementDispatcher 的并发槽还了回去。若照旧按 in_progress 计槽，
    // 这三个"不占资源"的任务会把 maxConcurrentRequirements 预算吃满，
    // 自动链式执行全局停摆，而分发器那边其实三个槽都空着。
    b.startTask('t1', 0)
    b.finishTask('t1', 'failed', b.snapshot.tasks['t1']!.revision)
    b.startTask('t2', 0)
    b.finishTask('t2', 'needs_confirmation', b.snapshot.tasks['t2']!.revision)
    b.startTask('t3', 0)
    b.finishTask('t3', 'cancelled', b.snapshot.tasks['t3']!.revision)
    expect(b.pickRunnable(1)).toEqual(['t4'])
  })
})

describe('领取幂等（S-01）', () => {
  it('重复领取返回 false 且不覆盖', () => {
    const b = new Board()
    expect(b.claimRequirement(makeReq())).toBe(true)
    const again = makeReq()
    again.title = '篡改'
    expect(b.claimRequirement(again)).toBe(false)
    expect(b.snapshot.requirements['1@WN_HIS']?.title).toBe('需求 1')
  })
})

describe('拆解（T020 / spec 008，五段式扩展）', () => {
  it('默认五段式带线性 DAG（分析→架构师拆解→开发→代码审核→测试）', () => {
    const drafts = decomposeRequirement(makeReq(), {
      analyze: { name: '需求分析师' },
      plan: { name: '架构师' },
      impl: { name: '开发工程师' },
      review: { name: '代码审核工程师' },
      verify: { name: '测试工程师' },
    })
    expect(drafts).toHaveLength(5)
    expect(drafts.map(d => d.taskId)).toEqual([
      '1@WN_HIS#analyze',
      '1@WN_HIS#plan',
      '1@WN_HIS#impl',
      '1@WN_HIS#review',
      '1@WN_HIS#verify',
    ])
    expect(drafts[0]!.blockedBy).toEqual([])
    expect(drafts[1]!.blockedBy).toEqual(['1@WN_HIS#analyze'])
    expect(drafts[2]!.blockedBy).toEqual(['1@WN_HIS#plan'])
    expect(drafts[3]!.blockedBy).toEqual(['1@WN_HIS#impl'])
    expect(drafts[4]!.blockedBy).toEqual(['1@WN_HIS#review'])
  })

  it('五段草稿各带阶段角色与冻结配置；缺角色时以「通用工程师」占位', () => {
    const drafts = decomposeRequirement(makeReq(), {
      analyze: { name: '需求分析师', defaultModel: 'm0' },
      plan: { name: '架构师', defaultModel: 'm1', defaultMcp: ['tfs-mcp'] },
      impl: { name: '开发工程师', defaultModel: 'm2' },
      review: undefined,
      verify: { name: '测试工程师', defaultModel: 'm3' },
    })
    expect(drafts.map(d => d.roleAgent)).toEqual([
      '需求分析师',
      '架构师',
      '开发工程师',
      '通用工程师',
      '测试工程师',
    ])
    expect(drafts[1]!.frozenConfig).toEqual({ mcp: ['tfs-mcp'], skills: [], model: 'm1' })
    // 缺角色的代码审核段以通用工程师占位、冻结配置为空快照。
    expect(drafts[3]!.roleAgent).toBe('通用工程师')
    expect(drafts[3]!.frozenConfig).toEqual({ mcp: [], skills: [], model: '' })
  })

  it('spec 009：角色默认模型带 defaultModelProvider 时冻结配置成对落键；裸 model 保持旧形状', () => {
    const drafts = decomposeRequirement(makeReq(), {
      analyze: { name: '需求分析师', defaultModel: 'deepseek-v4-flash', defaultModelProvider: '  arkcode  ' },
      plan: { name: '架构师', defaultModel: 'm1' },
      impl: { name: '开发工程师' },
      review: { name: '代码审核工程师' },
      verify: { name: '测试工程师' },
    })
    // provider 随角色默认模型成对冻结，并做 trim。
    expect(drafts[0]!.frozenConfig).toEqual({
      mcp: [],
      skills: [],
      model: 'deepseek-v4-flash',
      modelProvider: 'arkcode',
    })
    // 旧角色（只有裸 defaultModel）形状不变——不伪造 provider 键。
    expect(drafts[1]!.frozenConfig).toEqual({ mcp: [], skills: [], model: 'm1' })
    expect(drafts[1]!.frozenConfig).not.toHaveProperty('modelProvider')
  })

  it('五段任务标题语义齐全（含独立的代码审核段）', () => {
    const drafts = decomposeRequirement(makeReq(), {
      analyze: { name: '需求分析师' },
      plan: { name: '架构师' },
      impl: { name: '开发工程师' },
      review: { name: '代码审核工程师' },
      verify: { name: '测试工程师' },
    })
    expect(drafts.map(d => d.title)).toEqual([
      '分析任务：需求 1',
      '架构师拆解任务：需求 1',
      '开发任务：需求 1',
      '审核代码任务：需求 1',
      '测试代码任务：需求 1',
    ])
  })
})

/**
 * 需求级执行状态（问题 3/4/5）。
 *
 * 这里锁的是**引擎口径**：老数据按"进行中"读、全完成才迁移、取消完成是显式动作、
 * 已完成需求不能直接还原。服务层的自动迁移触发时机在 board-service.spec.ts 覆盖。
 */
describe('需求级执行状态（问题 3/4/5）', () => {
  function seeded(): { b: Board; key: string } {
    const b = new Board()
    const key = requirementDedupKey(makeReq())
    b.claimRequirement(makeReq())
    return { b, key }
  }

  it('缺省读为 active（历史 board.json 没有该字段）', () => {
    const { b, key } = seeded()
    expect(b.requirementExecState(key)).toBe('active')
    expect(b.snapshot.requirements[key]?.execState).toBeUndefined()
  })

  it('未拆解的需求不会被判为已完成（至少要有任务）', () => {
    const { b, key } = seeded()
    expect(b.isRequirementAllTasksDone(key)).toBe(false)
    expect(b.markRequirementCompletedIfAllDone(key)).toBe(false)
    expect(b.requirementExecState(key)).toBe('active')
  })

  it('全部任务完成后自动置为已完成（问题 3）', () => {
    const { b, key } = seeded()
    b.addTask(draft('t1', key))
    b.addTask(draft('t2', key))
    b.startTask('t1', 0)
    b.finishTask('t1', 'success', 1)
    // t2 未完成 ⇒ 不迁移
    expect(b.markRequirementCompletedIfAllDone(key)).toBe(false)
    expect(b.requirementExecState(key)).toBe('active')
    b.startTask('t2', 0)
    b.finishTask('t2', 'success', 1)
    expect(b.markRequirementCompletedIfAllDone(key)).toBe(true)
    expect(b.requirementExecState(key)).toBe('completed')
    expect(b.snapshot.requirements[key]?.completedAt).toBeTruthy()
    // 幂等：已完成后再调用不再变更（调用方据此跳过落盘）。
    expect(b.markRequirementCompletedIfAllDone(key)).toBe(false)
  })

  it('全部任务被取消（无 completed）不算完成', () => {
    const { b, key } = seeded()
    b.addTask(draft('t1', key))
    b.startTask('t1', 0)
    b.finishTask('t1', 'cancelled', 1)
    expect(b.isRequirementAllTasksDone(key)).toBe(false)
    expect(b.markRequirementCompletedIfAllDone(key)).toBe(false)
  })

  it('已取消任务不阻碍完成判定（放弃的子任务不该把需求永远挂在"进行中"）', () => {
    const { b, key } = seeded()
    b.addTask(draft('t1', key))
    b.addTask(draft('t2', key))
    b.startTask('t1', 0)
    b.finishTask('t1', 'success', 1)
    b.startTask('t2', 0)
    b.finishTask('t2', 'cancelled', 1)
    expect(b.isRequirementAllTasksDone(key)).toBe(true)
    expect(b.markRequirementCompletedIfAllDone(key)).toBe(true)
  })

  it('setRequirementExecState：确认完成 / 取消完成（问题 5）', () => {
    const { b, key } = seeded()
    b.setRequirementExecState(key, 'completed')
    expect(b.requirementExecState(key)).toBe('completed')
    b.setRequirementExecState(key, 'active')
    expect(b.requirementExecState(key)).toBe('active')
    /**
     * 取消完成**显式**写 `'active'`（而不是删键）：显式 active 是"人声明还没完"的抑制标记，
     * 必须持久化以对抗"任务全完成 ⇒ 自动标完成"的判定（否则用户会以为按钮没生效）。
     * 「重新开工」（拆解/手工任务）才会把键删回未判定（`resetRequirementCompletion`）。
     */
    expect(b.snapshot.requirements[key]?.execState).toBe('active')
    expect(b.snapshot.requirements[key]?.completedAt).toBeUndefined()
  })

  it('已完成需求还原被拒，且原因指明"先取消完成"（问题 5）', () => {
    const { b, key } = seeded()
    b.setRequirementExecState(key, 'completed')
    expect(() => b.restoreRequirement(key)).toThrow(/先点「取消完成」/)
    // 取消完成后仍受第二道门禁约束（有未取消任务）——两道门禁各司其职。
    b.setRequirementExecState(key, 'active')
    b.addTask(draft('t1', key))
    expect(() => b.restoreRequirement(key)).toThrow(/请先取消该需求的全部任务/)
  })

  it('对未领取需求设置执行状态抛错', () => {
    const b = new Board()
    expect(() => b.setRequirementExecState('404@WN_HIS', 'completed')).toThrow(BoardError)
  })
})

/**
 * 需求完成对账（问题 3，2026-09-21 实机补修）。
 *
 * 实机场景：需求 `1997179@WN_HIS` 的 3 个任务在**升级前**就全部 completed（旧代码没有"需求级
 * 执行状态"的概念），需求记录里没有 `execState` 键 ⇒ 永远不会被自动迁移，一直留在「任务中心」。
 * 对账（`reconcileRequirementCompletion`）在插件加载时补齐这类历史数据。
 */
describe('需求完成对账（问题 3 实机场景）', () => {
  const KEY = '1997179@WN_HIS'

  function taskRec(taskId: string, state: 'completed' | 'pending' = 'completed'): TaskSnapshot {
    return {
      taskId,
      requirementId: KEY,
      idempotencyKey: `${taskId}:dsh`,
      title: taskId,
      description: '',
      roleAgent: 'general',
      frozenConfig: { mcp: [], skills: [], model: '' },
      state,
      execState: state === 'completed' ? 'success' : 'queued',
      blockedBy: [],
      revision: 1,
      attempts: [],
      artifactPaths: [],
    }
  }

  /** 构造"升级前的 board.json"形状：需求存在、任务全 completed，但需求**没有** execState 键。 */
  function legacyBoard(tasks: TaskSnapshot[]): Board {
    const b = new Board()
    b.load({
      version: 7,
      updatedAt: '2026-09-21T04:05:00.000Z',
      requirements: { [KEY]: makeReq(1997179) },
      tasks: Object.fromEntries(tasks.map(t => [t.taskId, t])),
    })
    return b
  }

  it('三任务全 completed、需求缺 execState ⇒ 一次性补齐为已完成（1997179 实机形态）', () => {
    const b = legacyBoard([taskRec(`${KEY}#analyze`), taskRec(`${KEY}#impl`), taskRec(`${KEY}#verify`)])
    expect(b.requirementExecState(KEY)).toBe('active')
    expect(b.reconcileRequirementCompletion()).toEqual([KEY])
    expect(b.requirementExecState(KEY)).toBe('completed')
    expect(b.snapshot.requirements[KEY]?.completedAt).toBeTruthy()
    // 幂等：无变更时返回空数组（调用方据此跳过落盘）。
    expect(b.reconcileRequirementCompletion()).toEqual([])
  })

  it('仍有未完成任务（或全部被取消）的历史需求不被误迁', () => {
    expect(legacyBoard([taskRec(`${KEY}#analyze`), taskRec(`${KEY}#impl`, 'pending')]).reconcileRequirementCompletion()).toEqual([])
    // 全部 deleted（没有一个 completed）= 整条需求被放弃，不是完成。
    const allDeleted = legacyBoard([
      taskRec(`${KEY}#analyze`),
      taskRec(`${KEY}#impl`),
      taskRec(`${KEY}#verify`),
    ])
    for (const t of Object.values(allDeleted.snapshot.tasks)) {
      t.state = 'deleted'
      t.execState = 'cancelled'
    }
    expect(allDeleted.reconcileRequirementCompletion()).toEqual([])
  })

  it('用户显式「取消完成」的需求（execState=active）对账不得改写，重新开工后才解除抑制', () => {
    const b = legacyBoard([taskRec(`${KEY}#analyze`), taskRec(`${KEY}#impl`), taskRec(`${KEY}#verify`)])
    b.setRequirementExecState(KEY, 'active') // 人声明"还没完"
    expect(b.reconcileRequirementCompletion()).toEqual([]) // 对账不动它
    // 重新开工（拆解出新任务 / 手工任务）⇒ resetRequirementCompletion 删回未判定 ⇒ 对账恢复效力。
    expect(b.resetRequirementCompletion(KEY)).toBe(true)
    expect(b.reconcileRequirementCompletion()).toEqual([KEY])
    expect(b.requirementExecState(KEY)).toBe('completed')
  })

  it('对账只补不撤：已 completed 的需求即使任务状态回退也不会退回进行中', () => {
    const b = legacyBoard([taskRec(`${KEY}#analyze`), taskRec(`${KEY}#impl`), taskRec(`${KEY}#verify`)])
    b.reconcileRequirementCompletion()
    // 任务被改回 pending（对账后的历史操作）⇒ 需求仍保持 completed（单向迁移）。
    for (const t of Object.values(b.snapshot.tasks)) t.state = 'pending'
    expect(b.reconcileRequirementCompletion()).toEqual([])
    expect(b.requirementExecState(KEY)).toBe('completed')
  })
})

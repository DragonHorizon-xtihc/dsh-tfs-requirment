import { describe, expect, it } from 'vitest'
import {
  filterCompletedRequirements,
  isRequirementCompleted,
  splitRequirementsByExecState,
  summarizeRequirementExec,
} from '../src/shared/requirement-status.js'

/**
 * 需求级执行状态派生（问题 2/3/4）。
 *
 * 这些规则全在 `src/shared/requirement-status.ts` 里，UI 只负责渲染 —— 组件层没有渲染测试手段，
 * 派生逻辑写进 JSX 就只能靠人眼保证，因此把它们锁在这里。
 */

describe('isRequirementCompleted（缺省 = 进行中）', () => {
  it("只有显式 execState='completed' 才算完成", () => {
    expect(isRequirementCompleted({ execState: 'completed' })).toBe(true)
    expect(isRequirementCompleted({ execState: 'active' })).toBe(false)
    // 历史 board.json 没有该字段：必须按"进行中"处理，否则老数据会整体消失到已完成页。
    expect(isRequirementCompleted({})).toBe(false)
  })
})

describe('splitRequirementsByExecState（问题 3：两页拆分）', () => {
  it('按 execState 分桶，且保持输入顺序', () => {
    const r = [
      { id: 1, execState: undefined },
      { id: 2, execState: 'completed' as const },
      { id: 3, execState: 'active' as const },
      { id: 4, execState: 'completed' as const },
    ]
    const { active, completed } = splitRequirementsByExecState(r)
    expect(active.map(x => x.id)).toEqual([1, 3])
    expect(completed.map(x => x.id)).toEqual([2, 4])
  })

  it('全空输入得到两个空数组（不是 undefined）', () => {
    expect(splitRequirementsByExecState([])).toEqual({ active: [], completed: [] })
  })
})

describe('filterCompletedRequirements（问题 2：按需求 ID 与标题检索）', () => {
  const items = [
    { id: 1997179, title: '体检报告导出' },
    { id: 2000001, title: '设备联机改造' },
    { id: 1997180, title: 'report export v2' },
  ]

  it('关键字为空 → 原样返回（浅拷贝，不共享引用）', () => {
    const out = filterCompletedRequirements(items, '   ')
    expect(out).toEqual(items)
    expect(out).not.toBe(items)
  })

  it('按 ID 片段命中（用户常只记得后四位）', () => {
    expect(filterCompletedRequirements(items, '7179').map(x => x.id)).toEqual([1997179])
  })

  it('按标题命中，且大小写不敏感', () => {
    expect(filterCompletedRequirements(items, 'REPORT').map(x => x.id)).toEqual([1997180])
    expect(filterCompletedRequirements(items, '联机').map(x => x.id)).toEqual([2000001])
  })

  it('无命中返回空数组', () => {
    expect(filterCompletedRequirements(items, '不存在的关键字')).toEqual([])
  })
})

describe('summarizeRequirementExec（问题 4：需求行执行状态）', () => {
  const t = (state: 'pending' | 'in_progress' | 'completed' | 'deleted', execState: string): {
    state: 'pending' | 'in_progress' | 'completed' | 'deleted'
    execState: string
  } => ({ state, execState })

  it('需求级已完成优先于一切任务状态', () => {
    expect(summarizeRequirementExec({ execState: 'completed' }, [t('pending', 'queued')])).toEqual({
      text: '已完成',
      tone: 'done',
    })
  })

  it('未拆解（名下无任务）', () => {
    expect(summarizeRequirementExec({ execState: 'active' }, [])).toEqual({ text: '未拆解', tone: 'todo' })
    expect(summarizeRequirementExec({}, [])).toEqual({ text: '未拆解', tone: 'todo' })
  })

  it('有任务在跑 → 执行中 N（优先级高于失败/待办）', () => {
    const s = summarizeRequirementExec({}, [t('in_progress', 'running'), t('in_progress', 'failed'), t('pending', 'queued')])
    expect(s).toEqual({ text: '执行中 1', tone: 'running' })
  })

  it('无在跑但有失败 → 有失败 N', () => {
    const s = summarizeRequirementExec({}, [t('in_progress', 'failed'), t('pending', 'queued')])
    expect(s).toEqual({ text: '有失败 1', tone: 'failed' })
  })

  it('无失败但有未收口任务 → 待办 N', () => {
    const s = summarizeRequirementExec({}, [t('pending', 'queued'), t('completed', 'success')])
    expect(s).toEqual({ text: '待办 1', tone: 'pending' })
  })

  it('全部收口 → 已完成 c/t（分母排除已取消任务）', () => {
    const s = summarizeRequirementExec({}, [
      t('completed', 'success'),
      t('completed', 'success'),
      t('deleted', 'cancelled'),
    ])
    expect(s).toEqual({ text: '已完成 2/2', tone: 'done' })
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  computeChatPhase,
  REF_RELEASE_GRACE_MS,
  RefreshTickStore,
  resolveChatFocusKey,
  SessionRefCache,
  type ReleasableReference,
} from '../src/shared/chat-panel.js'

/**
 * 「主对话框」纯逻辑（2026-11-03 问题 1/2）。
 *
 * - 相位公式锁死与宿主官方 `ui-subagent/.../sidebar-chat/index.tsx:132-147`
 *   `ConversationSlotPanel` **逐字同口径**（尤其 `settling` 分支——缺了它，
 *   重挂后历史 loading 期间会画成"输入框顶置 + 转录空白"的坏布局）；
 * - 焦点键推导锁死「行点选 > 需求筛选 > 首条」优先级；
 * - 引用缓存锁死"复用 / grace 释放 / 陈旧换新"的行为面（问题 2 根因链的插件侧解法）。
 */

describe('computeChatPhase（官方 ConversationSlotPanel 同口径）', () => {
  it('运行中会话 ⇒ active', () => {
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: { blank: true, awaitingFirstTurn: true, running: true },
      summaryBlank: undefined,
    })
    expect(r.shellPhase).toBe('active')
    expect(r.phase).toBe('active')
    expect(r.hero).toBe(false)
    expect(r.settling).toBe(false)
  })

  it('非空白会话（已有内容）⇒ active', () => {
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: { blank: false, awaitingFirstTurn: false },
      summaryBlank: false,
    })
    expect(r.phase).toBe('active')
  })

  it('有激活目标 ⇒ active', () => {
    const r = computeChatPhase({
      activeTargetsSize: 2,
      session: { blank: true, awaitingFirstTurn: true },
      summaryBlank: undefined,
    })
    expect(r.phase).toBe('active')
  })

  it('空白会话 + 历史已打开 ⇒ hero', () => {
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: { blank: true, awaitingFirstTurn: true, openState: 'open' },
      summaryBlank: false,
    })
    expect(r.shellPhase).toBe('blank')
    expect(r.hero).toBe(true)
    expect(r.phase).toBe('hero')
  })

  it('★ 空白会话 + 历史 loading + 列表行未定 ⇒ settling（问题 2 截图态的正解）', () => {
    // 旧插件口径在这里产出 phase='active'：转录区空白、输入框浮到转录区顶部。
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: { blank: true, awaitingFirstTurn: true, openState: 'loading' },
      summaryBlank: undefined,
    })
    expect(r.settling).toBe(true)
    expect(r.phase).toBe('settling')
    expect(r.hero).toBe(false)
  })

  it('空白会话 + 历史 loading + 列表行明说 blank ⇒ 不算 settling，落 hero', () => {
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: { blank: true, awaitingFirstTurn: true, openState: 'loading' },
      summaryBlank: true,
    })
    expect(r.settling).toBe(false)
    expect(r.hero).toBe(true)
    expect(r.phase).toBe('hero')
  })

  it('已尝试发送、仍在等首个 turn ⇒ engaging 壳相位，phase=active', () => {
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: { blank: true, awaitingFirstTurn: true, promptAttempted: true, openState: 'loading' },
      summaryBlank: undefined,
    })
    expect(r.shellPhase).toBe('engaging')
    // shellPhase 非 blank ⇒ 既不 settling 也不 hero。
    expect(r.phase).toBe('active')
  })

  it('continuable 子会话且父可用性未解析 ⇒ settling（无论壳相位）', () => {
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: {
        blank: false,
        awaitingFirstTurn: false,
        subagent: { address: { mode: 'continuable' }, parentAvailable: undefined },
      },
      summaryBlank: false,
    })
    expect(r.parentAvailabilityPending).toBe(true)
    expect(r.phase).toBe('settling')
  })

  it('父可用性已定（true/false）⇒ 不再 settling', () => {
    for (const parentAvailable of [true, false]) {
      const r = computeChatPhase({
        activeTargetsSize: 0,
        session: {
          blank: false,
          awaitingFirstTurn: false,
          subagent: { address: { mode: 'continuable' }, parentAvailable },
        },
        summaryBlank: false,
      })
      expect(r.parentAvailabilityPending).toBe(false)
      expect(r.phase).toBe('active')
    }
  })

  it('one-shot 子会话的父可用性不参与 settling 判定', () => {
    const r = computeChatPhase({
      activeTargetsSize: 0,
      session: {
        blank: false,
        awaitingFirstTurn: false,
        subagent: { address: { mode: 'one-shot' }, parentAvailable: undefined },
      },
      summaryBlank: false,
    })
    expect(r.parentAvailabilityPending).toBe(false)
  })
})

describe('resolveChatFocusKey（对话框焦点需求键）', () => {
  const keys = ['111@WN_HIS', '222@WN_HIS', '333@WN_HIS']

  it('行点选优先（且仍在进行中）', () => {
    expect(resolveChatFocusKey({
      explicitKey: '222@WN_HIS',
      requirementFilter: '111@WN_HIS',
      activeRequirementKeys: keys,
    })).toBe('222@WN_HIS')
  })

  it('行点选的需求已不在进行中 ⇒ 回落到筛选', () => {
    expect(resolveChatFocusKey({
      explicitKey: '999@WN_HIS',
      requirementFilter: '111@WN_HIS',
      activeRequirementKeys: keys,
    })).toBe('111@WN_HIS')
  })

  it('未行点选 ⇒ 筛选优先于首条', () => {
    expect(resolveChatFocusKey({
      explicitKey: '',
      requirementFilter: '333@WN_HIS',
      activeRequirementKeys: keys,
    })).toBe('333@WN_HIS')
  })

  it('都未选 ⇒ 首条进行中需求', () => {
    expect(resolveChatFocusKey({
      explicitKey: '',
      requirementFilter: '',
      activeRequirementKeys: keys,
    })).toBe('111@WN_HIS')
  })

  it('筛选的需求已不在进行中 ⇒ 回落到首条（焦点键必须指向进行中需求）', () => {
    expect(resolveChatFocusKey({
      explicitKey: '',
      requirementFilter: '999@WN_HIS',
      activeRequirementKeys: keys,
    })).toBe('111@WN_HIS')
  })

  it('无进行中需求 ⇒ 空串', () => {
    expect(resolveChatFocusKey({
      explicitKey: '111@WN_HIS',
      requirementFilter: '111@WN_HIS',
      activeRequirementKeys: [],
    })).toBe('')
  })
})

/** 测试用引用：记录 release 次数。 */
class FakeRef implements ReleasableReference {
  released = 0
  release(): void {
    this.released += 1
  }
}

describe('SessionRefCache（会话引用缓存）', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('同键复用：factory 只跑一次', () => {
    const cache = new SessionRefCache<FakeRef>()
    const factory = vi.fn(() => new FakeRef())
    const a = cache.acquire('s1', factory)
    const b = cache.acquire('s1', factory)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(b).toBe(a)
  })

  it('grace 期内归还再取：复用同一引用，不 release', () => {
    const cache = new SessionRefCache<FakeRef>()
    const factory = vi.fn(() => new FakeRef())
    const a = cache.acquire('s1', factory)
    cache.release('s1')
    // grace 未到：仍持有
    expect(a.released).toBe(0)
    const b = cache.acquire('s1', factory)
    expect(b).toBe(a)
    expect(factory).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(REF_RELEASE_GRACE_MS * 2)
    expect(a.released).toBe(0)
  })

  it('最后一个持有者离开且过了 grace ⇒ 真正 release', () => {
    const cache = new SessionRefCache<FakeRef>()
    const a = cache.acquire('s1', () => new FakeRef())
    cache.release('s1')
    vi.advanceTimersByTime(REF_RELEASE_GRACE_MS - 1)
    expect(a.released).toBe(0)
    vi.advanceTimersByTime(1)
    expect(a.released).toBe(1)
    expect(cache.has('s1')).toBe(false)
  })

  it('多持有者：最后一个离开才进入 grace 倒计时', () => {
    const cache = new SessionRefCache<FakeRef>()
    const a = cache.acquire('s1', () => new FakeRef())
    cache.acquire('s1', () => new FakeRef())
    cache.release('s1')
    vi.advanceTimersByTime(REF_RELEASE_GRACE_MS * 2)
    expect(a.released).toBe(0) // 还有一个持有者
    cache.release('s1')
    vi.advanceTimersByTime(REF_RELEASE_GRACE_MS * 2)
    expect(a.released).toBe(1)
  })

  it('markStale 后 acquire 换新引用，旧引用在换新时释放（不提前）', () => {
    const cache = new SessionRefCache<FakeRef>()
    const a = cache.acquire('s1', () => new FakeRef())
    cache.markStale('s1')
    // 标记陈旧不立刻释放（此刻 UI 还渲染着旧引用）
    expect(a.released).toBe(0)
    const factory = vi.fn(() => new FakeRef())
    const b = cache.acquire('s1', factory)
    expect(factory).toHaveBeenCalledTimes(1)
    expect(b).not.toBe(a)
    expect(a.released).toBe(1)
  })

  it('markStale 时无人持有 ⇒ 立即释放', () => {
    const cache = new SessionRefCache<FakeRef>()
    const a = cache.acquire('s1', () => new FakeRef())
    cache.release('s1')
    cache.markStale('s1')
    expect(a.released).toBe(1)
    expect(cache.has('s1')).toBe(false)
  })
})

describe('RefreshTickStore（重开会话刻度）', () => {
  it('bump 递增并通知订阅者', () => {
    const store = new RefreshTickStore()
    const seen: number[] = []
    const un = store.subscribe(() => seen.push(store.getSnapshot()))
    expect(store.getSnapshot()).toBe(0)
    store.bump()
    store.bump()
    un()
    store.bump()
    expect(seen).toEqual([1, 2])
    expect(store.getSnapshot()).toBe(3)
  })
})

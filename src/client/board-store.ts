/**
 * 客户端共享看板 store（问题 1 / 6 / 7）。
 *
 * ## 为什么需要它
 *
 * 改造前看板数据有三份**互不同步**的拉取逻辑：
 *   - 中央 `Workbench` 持有一份 board state，只在挂载 / 切入任务中心 / 动作后各拉一次，
 *     「执行配置 → 发起执行」后任务中心不实时同步（问题 7）；
 *   - 右栏 `SidePanel` 又是**另一份**独立 board state，与中央互不可见；
 *   - 批量派发 `dispatchBatch` 在前端用 `setInterval(1.5s) × 最多 400 轮` 全量 `getBoard`
 *     驱动 DAG（页面关闭即停，且是无意义请求风暴）。
 *
 * 本模块把看板读取收敛为**模块级单例**：
 *   1. **单飞（in-flight de-dup）**：任意时刻同一个 `getBoard` 只有一个在途请求，并发订阅者/
 *      动作共享同一个 Promise，杜绝同一内容的重复请求；
 *   2. **自适应轮询**：有任务运行中 3s 一拍、仅待人工确认 5s 一拍、全部空闲则**停止周期轮询**
 *      （看板变化在动作后由 `invalidate()` 立即拉取，或由宿主自动链式在运行期内被下一拍观测到）；
 *   3. **后台标签页暂停加速**：`document.hidden` 时放慢到 15s，不可见时不烧请求；
 *   4. **动作即失效**：所有写动作（派发 / 状态 / 编辑 / 领取 / 拆解 / 回写…）后调 `invalidate()`，
 *      立即重拉并重置节拍，中央任务中心与右栏**同一份数据**实时同步；
 *   5. **跨视图共享**：中央 main 面板与右栏 tab 即便同时挂载，也只共用这一份快照与一条轮询链。
 *
 * DAG 的自动推进已下沉到宿主（任务收口钩子 → `Board.autoStartRunnable`，问题 6），
 * 前端不再靠轮询驱动任务，轮询只用于**展示**进展，因此全空闲时可以安全停拍。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/client/board-store
 */

import { useEffect, useState } from 'react'
import type { BoardSnapshotView, BoardTaskView } from '../shared/contracts.js'

/** 有任务运行中的轮询节拍（毫秒）。 */
const RUNNING_INTERVAL_MS = 3000
/** 仅有任务待人工确认时的节拍（毫秒；等人工，不必频繁）。 */
const NEEDS_CONFIRM_INTERVAL_MS = 5000
/** 看板不可用（连不上宿主）时的慢重试节拍（毫秒）。 */
const UNAVAILABLE_INTERVAL_MS = 10000
/** 后台 / 不可见标签页的统一慢节拍（毫秒）。 */
const HIDDEN_INTERVAL_MS = 15000

type Listener = () => void

/** 判断任务是否仍在执行（看板态 in_progress 且执行态 running；旧数据缺 execState 时按 in_progress 视为运行中）。 */
function isTaskRunning(t: BoardTaskView): boolean {
  return t.state === 'in_progress' && (t.execState === undefined || t.execState === 'running')
}

/** 判断任务是否停在「待人工确认」（问题 5）。 */
function isTaskWaitingConfirm(t: BoardTaskView): boolean {
  return t.state === 'in_progress' && t.execState === 'needs_confirmation'
}

/**
 * 框架无关的共享看板 store。`slots.tsx` 用宿主桥创建一个模块级单例，
 * 中央 Workbench、右栏 SidePanel、任务中心等通过 {@link useBoardStore} 订阅同一份快照。
 */
export class BoardStore {
  private snapshot: BoardSnapshotView | null = null
  private readonly listeners = new Set<Listener>()
  private inflight: Promise<BoardSnapshotView> | null = null
  private timer: ReturnType<typeof setTimeout> | undefined
  /** 活跃订阅者数（React 组件挂载数）；为 0 时停止轮询链。 */
  private active = 0
  private started = false
  /** 连续失败计数（仅用于避免后台无限快重试，不对外暴露）。 */
  private failures = 0

  constructor(private readonly fetcher: () => Promise<BoardSnapshotView>) {}

  /** 当前快照（可能为 null：尚未首次加载）。 */
  getSnapshot(): BoardSnapshotView | null {
    return this.snapshot
  }

  /** 订阅快照变化；返回取消订阅函数。 */
  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  private emit(): void {
    for (const l of this.listeners) {
      try {
        l()
      } catch {
        // 单个订阅者渲染异常不应影响 store 轮询。
      }
    }
  }

  /**
   * 拉取一次看板（**单飞**）：并发调用共享同一个在途 Promise，不会发出重复请求。
   * 拉取成功后更新快照、通知订阅者，并按新状态重排轮询节拍。
   */
  refresh(): Promise<BoardSnapshotView> {
    if (this.inflight) return this.inflight
    const p = Promise.resolve()
      .then(() => this.fetcher())
      .then(snap => {
        this.snapshot = snap
        this.failures = 0
        this.emit()
        return snap
      })
      .catch(e => {
        this.failures += 1
        // 不在 store 内制造假快照；错误由首次加载/各视图既有兜底承载。抛出以便调用方按需提示。
        throw e
      })
      .finally(() => {
        // 清空在途标记必须在通知/重排之后：finally 在 then 的 emit 之后执行。
        if (this.inflight === p) this.inflight = null
        this.schedule()
      })
    this.inflight = p
    return p
  }

  /**
   * 动作后调用：立即作废当前节拍并马上重拉一次（不等下一拍），
   * 让中央任务中心 / 右栏 / 角标计数实时同步（问题 7）。失败不外溢。
   */
  invalidate(): void {
    this.clearTimer()
    void this.refresh().catch(() => {
      // 立即刷新失败：schedule() 已在 finally 里安排慢重试，这里不打扰调用方。
    })
  }

  /** 组件挂载时激活：首个订阅者启动轮询链并立即拉一次。 */
  activate(): void {
    this.active += 1
    if (this.started) return
    this.started = true
    this.clearTimer()
    void this.refresh().catch(() => {})
  }

  /** 组件卸载时去激活；最后一个订阅者离开后停止轮询（保留最后快照）。 */
  deactivate(): void {
    this.active = Math.max(0, this.active - 1)
    if (this.active === 0) {
      this.started = false
      this.clearTimer()
    }
  }

  private clearTimer(): void {
    if (this.timer !== undefined) {
      clearTimeout(this.timer)
      this.timer = undefined
    }
  }

  /**
   * 计算当前状态下的轮询延迟（毫秒）；返回 0 表示**全部空闲、停止周期轮询**。
   */
  private delayFor(snap: BoardSnapshotView | null): number {
    // ⚠️ 顺序即语义（2026-10-06 修复）：旧实现把 hidden / 不可用两条分支排在空闲判定**之前**，
    // 于是"全部空闲"这个唯一能停拍的分支**永远到不了** —— 标签页切到后台且看板空闲时，
    // 会**永久 15s 一拍**直到组件卸载，与文件头「全部空闲则停止周期轮询」的设计契约相反。
    //
    // 现在的顺序：
    //   1. 看板不可用 ⇒ 慢重试。这一支必须**优先于**空闲判定：不可用时 `tasks` 本来就是空的，
    //      若先判空闲会直接停拍，宿主/插件恢复后再也不会自愈。
    //   2. 空闲 ⇒ 停拍（0），等待下一次 invalidate / activate 唤醒。
    //   3. 有活动且标签页不可见 ⇒ 放慢到 15s（保留进展观测，但不按 3s/5s 烧请求）。
    if (!snap || !snap.ok) return UNAVAILABLE_INTERVAL_MS
    const tasks = snap.tasks ?? []
    let delay = 0
    if (tasks.some(isTaskRunning)) delay = RUNNING_INTERVAL_MS
    else if (tasks.some(isTaskWaitingConfirm)) delay = NEEDS_CONFIRM_INTERVAL_MS
    if (delay === 0) return 0
    if (typeof document !== 'undefined' && document.hidden) return HIDDEN_INTERVAL_MS
    return delay
  }

  /** 按当前快照状态安排下一拍（delay=0 则停拍，等待下次 invalidate/activate）。 */
  private schedule(): void {
    this.clearTimer()
    if (!this.started || this.active === 0) return
    const delay = this.delayFor(this.snapshot)
    if (delay <= 0) return
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh().catch(() => {})
    }, delay)
  }
}

/**
 * React 订阅钩子：组件挂载即激活共享轮询、卸载即去激活，返回最新看板快照。
 * 多个组件调用同一 store 时只共享一条轮询链与一份快照。
 */
export function useBoardStore(store: BoardStore): BoardSnapshotView | null {
  const [snap, setSnap] = useState<BoardSnapshotView | null>(store.getSnapshot())
  useEffect(() => {
    const un = store.subscribe(() => setSnap(store.getSnapshot()))
    store.activate()
    // 挂载后若 store 已有首拍在途，也立刻同步一次（覆盖 useState 初值之后、订阅之前的间隙）。
    setSnap(store.getSnapshot())
    return () => {
      un()
      store.deactivate()
    }
  }, [store])
  return snap
}

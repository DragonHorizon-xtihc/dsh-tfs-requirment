/**
 * 面板「开 / 关」状态的共享控制器（纯逻辑，无 DOM / React 依赖）。
 *
 * ## 为什么需要它
 *
 * 在较旧 / 精简的宿主（无 `main` 中央槽与 `sidebar.panellist` 菜单槽，只有
 * `sidebar.footer.action` 入口槽与 `shell.overlay` 浮层槽）上，TFS 面板的
 * **入口按钮**（footer.action）与**全屏面板本体**（shell.overlay）是两个
 * 不同槽里的独立组件，彼此不能直接传 props。本控制器作为模块级单例，
 * 让入口按钮 `show()`、面板本体订阅状态并在打开时渲染、`hide()` 时卸载，
 * 从而既复用 shell.overlay（全屏覆盖）又不会"开机即盖住应用"
 * （shell.overlay 是常驻 list 槽，组件默认 getSnapshot()===false ⇒ 返回 null）。
 *
 * API 形状对齐 React `useSyncExternalStore`：`subscribe` / `getSnapshot`，
 * 客户端半直接 `useSyncExternalStore(control.subscribe, control.getSnapshot)`。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/panel-open-control
 */
export class PanelOpenControl {
  private open = false
  private listeners = new Set<() => void>()

  /** 当前是否打开（稳定返回同一布尔值，供 getSnapshot 避免无限重渲染）。 */
  getSnapshot = (): boolean => this.open

  /**
   * 订阅开关变化。
   * @param fn 状态变化回调。
   * @returns 退订函数（幂等，重复调用安全）。
   */
  subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }

  /** 打开面板（已打开时为 no-op，不产生多余通知）。 */
  show(): void {
    if (this.open) return
    this.open = true
    this.emit()
  }

  /** 关闭面板（已关闭时为 no-op）。 */
  hide(): void {
    if (!this.open) return
    this.open = false
    this.emit()
  }

  private emit(): void {
    // 复制一份遍历，退订在回调中发生也不会影响本次通知。
    for (const fn of [...this.listeners]) fn()
  }
}

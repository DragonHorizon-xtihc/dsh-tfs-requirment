/**
 * 与 DOM 接管型家族面板（`@linxin666/dsh-client-ui-task-board`、`@linxin666/dsh-ssh`）
 * 共存的互斥协议（问题 1：切到其他看板后 TFS 看板无法重新显示）。
 *
 * ## 背景（均有源码依据）
 *
 * 这两个面板不走宿主 `main` 槽，而是在 DOM 层接管中央列：
 *   - 打开时在 `<html>` 置 `data-dsh-taskboard-active` / `data-dsh-ssh-active`；
 *   - 向 `[class*='centerCol']` append 自己的 `[data-dsh-*-view]` 容器；
 *   - 用 CSS 隐藏中央列其余直接子节点（含宿主 MainPanel 与本插件 Workbench）：
 *       html[data-dsh-taskboard-active] [class*='centerCol']
 *         > :not([data-dsh-taskboard-view]) { display: none !important; }
 *   - 只在两种情况下关闭（panel-mount-core.ts）：
 *       ① capture 阶段点击会话/项目/搜索/新建会话行（选择器不含 sidebar.panellist 面板行）；
 *       ② 收到全局 `dsh-panel-activate` 事件且 detail 为兄弟面板名
 *         （任务看板认 'ssh'，SSH 面板认 'taskboard'）。
 *
 * 本插件的面板行走宿主槽位系统，两者都不满足，故必须在自己被激活时主动"驱逐"接管面板，
 * 否则 React 树里 Workbench 已挂载/已切换，却被 `display:none !important` 永久隐藏，
 * 表现为"点其他看板后再点 TFS 看板无效"。
 *
 * ## 为什么不会误开对方
 *
 * 面板只在"自己的侧边栏行被点击"时打开；它们的 onOtherActivate 只 close 不 open，
 * 且对自身同名 detail 直接忽略。故派发兄弟名事件只会让开着的一方关闭。
 *
 * 本文件为纯 DOM 工具，不依赖 React/cordis，便于在 jsdom 下单测。
 */

/** 跨插件激活事件名（与 task-board/ssh 的 panel-mount-core 常量一致）。 */
const ACTIVATE_EVENT = 'dsh-panel-activate'
const TASKBOARD_ACTIVE_ATTR = 'data-dsh-taskboard-active'
const SSH_ACTIVE_ATTR = 'data-dsh-ssh-active'

/** 本插件 panellist 图标根节点上的钩子属性（见 slots.tsx 的 TfsPanelIcon）。 */
export const PANEL_ROW_HOOK = 'data-tfs-panel-row'

/** 本插件在跨插件协议中的面板名（现有两个面板忽略未知 detail，无副作用；供未来面板识别）。 */
export const PANEL_NAME = 'tfs-requirment'

/**
 * 让任务看板 / SSH 面板让位，确保宿主 `main` 槽（本看板）可见。
 *
 * 顺序：先走对方已发布的事件协议（其控制器自行 close，状态同步、容器按其自身逻辑隐藏），
 * 再兜底移除 `<html>` 激活属性（对方插件未安装/旧版本未消费事件时，CSS 隐藏规则同样失效）。
 *
 * @param broadcast - 是否广播自身激活事件；重复触发（如挂载+点击同帧）时可传 false。
 */
export function evictTakeoverPanels(broadcast = true): void {
  try {
    const html = document.documentElement
    if (html.hasAttribute(TASKBOARD_ACTIVE_ATTR)) {
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'ssh' }))
    }
    if (html.hasAttribute(SSH_ACTIVE_ATTR)) {
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: 'taskboard' }))
    }
    // 兜底：事件无人消费时直接清属性，使 [class*='centerCol'] > * 的隐藏规则失效。
    html.removeAttribute(TASKBOARD_ACTIVE_ATTR)
    html.removeAttribute(SSH_ACTIVE_ATTR)
    if (broadcast) {
      document.dispatchEvent(new CustomEvent(ACTIVATE_EVENT, { detail: PANEL_NAME }))
    }
  } catch (e) {
    // 壳层兼容逻辑绝不能把整个 GUI 拖垮。
    console.warn('[tfs-requirment] 驱逐接管面板失败', e)
  }
}

/**
 * capture 阶段监听本插件 panellist 行点击。
 *
 * 不能只靠 Workbench 挂载 effect：TFS 已打开过（Workbench 已挂载但被接管面板隐藏）时，
 * 再点本行不会 remount，挂载 effect 不会触发——所以必须在点击链路上再挂一道。
 *
 * @returns dispose 函数（调用方负责挂到 ctx.effect / useEffect cleanup）。
 */
export function bindPanelRowEviction(): () => void {
  const onClick = (event: MouseEvent): void => {
    const el = event.target as Element | null
    if (!el || typeof el.closest !== 'function') return
    // ① 目标本身在钩子节点上（真实点击通常命中 svg 图标本身）；
    // ② 目标落在包含钩子的整行按钮内（点到按钮 padding/span，或合成 click 以 button 为 target）。
    //    钩子挂在 svg 上、按钮是宿主渲染的，closest 只会向上找祖先，故必须再补一次"行内包含"判断。
    const rowButton = el.closest('button,a,[role="button"]')
    if (el.closest(`[${PANEL_ROW_HOOK}]`) || rowButton?.querySelector(`[${PANEL_ROW_HOOK}]`)) {
      evictTakeoverPanels()
    }
  }
  document.addEventListener('click', onClick, true)
  return () => document.removeEventListener('click', onClick, true)
}

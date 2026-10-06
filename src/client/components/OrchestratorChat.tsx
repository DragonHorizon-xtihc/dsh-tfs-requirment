// 任务中心「主对话框」：需求级编排主 agent 会话 + 主/子 agent 双向切换（spec 010 US1/US4）。
//
// ───────────────────────── 为什么必须走宿主官方槽位 ─────────────────────────
//
// 客户端半只能 require `PLATFORM_MODULES`
// （`packages/client/web/src/platform.ts:8-14`：react / cordis / client-store / ui-slots /
// ui-primitives / ui-dockkit），**没有** `ui-conversation` / `ui-session` / `ui-subagent`。
// 因此"显示一个真实会话"的**唯一**合法路径是宿主给出的三段式协议（与官方「侧边对话」同构，
// 见 `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:145-198`）：
//
//   ① 父条目声明一个 `scope:'session'` 的子槽
//      ⇒ 框架在父条目 props 上注入 `SessionProvider`（`ui-renderer/src/client/scoped-slots.tsx:575-590`）；
//   ② 用 `ctx.sessions.retain(target, { source, signal })` 拿 `SessionReference`
//      （`api/session-controller/src/client/contract/sessions.ts:58`）；
//   ③ `<SessionProvider session={reference}>` 包住 `renderSlot(子槽)`，子槽组件里再
//      `renderFactorySlot('conversation.content', { variant:'embedded', … },
//        { slots: { views } })` 渲染会话正文。
//
// **禁止**自己画一套消息气泡来"假装"是会话：那不是会话，不能输入、拿不到流式状态，
// 且会在宿主升级时静默漂移。
//
// ───────────────────────── 降级 ─────────────────────────
//
// 宿主无 `sessions` 服务 / 无 `renderFactorySlot` / retain 失败 ⇒ 面板显示**可读原因** +
// 「在侧边栏打开」（宿主 `sidebarRight.openResource`）。绝不白屏、绝不假装可用。

import { useCallback, useEffect, useState } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { buildChatAddress, type ChatSessionMode } from '../../shared/chat-address.js'

/** 一个可切换的会话目标。 */
export interface ChatTarget {
  /** 子会话 id（编排主 agent = continuable childId；任务 = attempt.runId/复用 childId）。 */
  childSessionId: string
  /** 直接父会话 id（构造 SubagentAddress 与地址都需要）。 */
  parentSessionId: string
  /** 子会话模式。 */
  mode: ChatSessionMode
}

/** 切换条的一项。 */
export interface ChatSwitcherItem {
  /** 稳定键（`'orchestrator'` 或 taskId）。 */
  key: string
  /** 展示文案（主 agent / 任务标题）。 */
  label: string
  /** 是否有可用会话；false 时按钮禁用并给出原因。 */
  enabled: boolean
  /** 禁用原因（enabled=false 时展示）。 */
  reason?: string
  /** 该项对应的会话目标。 */
  target?: ChatTarget
  /** 执行态药丸文本与配色（可选）。 */
  badge?: { text: string; color: string; bg: string }
}

/** 面板模型：由任务中心（持有看板快照）写入，对话框读取。 */
export interface ChatPanelModel {
  /** 是否显示（仅在任务中心「进行中」子 Tab 为 true）。 */
  visible: boolean
  /** 当前焦点需求键（会用于「创建编排会话」）。 */
  requirementKey: string
  /** 当前焦点需求标题。 */
  requirementTitle: string
  /** 编排上下文摘要（`mode='off'` 时带 reason）。 */
  orchestrator?: { sessionId?: string; parentSessionId?: string; mode: 'continuable' | 'off'; reason?: string }
  /** 切换条。 */
  items: ChatSwitcherItem[]
  /** 当前选中项键。 */
  activeKey: string
}

/** 空模型（未选择任何需求）。 */
export const EMPTY_CHAT_MODEL: ChatPanelModel = {
  visible: false,
  requirementKey: '',
  requirementTitle: '',
  items: [],
  activeKey: '',
}

/**
 * 模块级可见 store。
 *
 * 为什么不用 props 穿透：对话框由**父槽位条目**（工作台）渲染，而"当前焦点需求 / 选中会话"
 * 是**任务中心组件内部**的状态（它才有看板快照与焦点需求）。二者之间隔着槽位边界，
 * props 传不过去；用一个极小的 store 让两边解耦，比把任务中心的全部状态上提到工作台更干净
 * （上提会让工作台重新渲染整棵面板树）。
 */
class ChatPanelStore {
  private model: ChatPanelModel = EMPTY_CHAT_MODEL
  private readonly listeners = new Set<() => void>()

  get(): ChatPanelModel {
    return this.model
  }

  set(next: ChatPanelModel): void {
    this.model = next
    for (const fn of [...this.listeners]) fn()
  }

  /**
   * 只改选中项（切换条点击用）。
   *
   * 选中项由 store 单向持有，任务中心发布新快照时**不再**覆盖它——否则看板每 3 秒
   * 轮询一次就会把用户刚点的子会话弹回「主 agent」。
   */
  selectKey(key: string): void {
    if (this.model.activeKey === key) return
    this.model = { ...this.model, activeKey: key }
    for (const fn of [...this.listeners]) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}

/** 全局单例（一个前端只有一块任务中心）。 */
export const chatPanelStore = new ChatPanelStore()

/**
 * 子会话「父会话是否在线」的运行时状态。
 *
 * ## 为什么单独一个 store（而不是塞进 ChatPanelModel）
 *
 * `ChatPanelModel` 由**任务中心**写入（它才有看板快照），而"父会话在不在"只有**会话体内**的
 * `useSession` 知道（`session.subagent.parentAvailable`，宿主在 catalog 解析后才填）。
 * 两者是**不同的数据源、不同的写入时刻**，硬合并会让任一侧都要等另一侧刷新。
 *
 * ## 口径必须与宿主输入栏逐字一致
 *
 * `packages/client/ui-conversation/src/client/skeleton/InputBar.tsx:133-134`：
 * `continuable = address.mode === 'continuable'`；`parentOffline = continuable && parentAvailable !== true`。
 * `parentAvailable` 的语义是"**直到 catalog 解析前都缺席**"（`snapshot.ts:77` 注释），
 * 所以 `!== true` 把"还不知道"也算作离线 —— 此处照抄同一判定，
 * 否则会出现"输入框已禁写、面板却说在线"的自相矛盾。
 */
class ParentStatusStore {
  private state: { childSessionId: string; parentOffline: boolean } = { childSessionId: '', parentOffline: false }
  private readonly listeners = new Set<() => void>()

  get(): { childSessionId: string; parentOffline: boolean } {
    return this.state
  }

  set(next: { childSessionId: string; parentOffline: boolean }): void {
    if (this.state.childSessionId === next.childSessionId && this.state.parentOffline === next.parentOffline) return
    this.state = next
    for (const fn of [...this.listeners]) fn()
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn)
    return () => {
      this.listeners.delete(fn)
    }
  }
}

/** 子会话父在线状态单例。 */
export const parentStatusStore = new ParentStatusStore()

/** React 侧订阅（与 {@link useChatModel} 同款手写订阅，理由见该函数注释）。 */
function useParentStatus(): { childSessionId: string; parentOffline: boolean } {
  const [state, setState] = useState(() => parentStatusStore.get())
  useEffect(() => {
    const un = parentStatusStore.subscribe(() => setState(parentStatusStore.get()))
    setState(parentStatusStore.get())
    return un
  }, [])
  return state
}

/** React 侧订阅（React 18 的 useSyncExternalStore 在插件冻结模块表里可用性不确定，故手写）。 */
function useChatModel(): ChatPanelModel {
  const [model, setModel] = useState<ChatPanelModel>(() => chatPanelStore.get())
  useEffect(() => {
    const un = chatPanelStore.subscribe(() => setModel(chatPanelStore.get()))
    setModel(chatPanelStore.get())
    return un
  }, [])
  return model
}

/** 客户端半看得到的 `ctx.sessions` 结构面（不 import 宿主包）。 */
interface SessionsFace {
  retain?: (target: unknown, options: { source: string; signal: AbortSignal }) => {
    sessionId?: unknown
    ready?: Promise<unknown>
    release?: () => void
  }
}

/** 客户端半看得到的 `ctx.sidebarRight` 结构面。 */
interface SidebarRightFace {
  openResource?: (address: string, options: { kind: string; preferNewPane?: boolean }) => void
}

/**
 * 客户端半看得到的 `ctx.uiWorkspace` 结构面。
 *
 * 已核实（`packages/client/ui-workspace/src/client/navigation.ts`）：
 *  - 服务注册名就是 `'uiWorkspace'`（`navigation.ts:151` 的 `super(ctx, 'uiWorkspace')`）；
 *  - `openSession(target: SessionTarget)`（`:200`）内部走 `replaceMain(target, …, 'reveal')`
 *    ⇒ 既切换主会话又**把主会话面板显示出来**（'reveal'），正是"回主会话"要的行为。
 *
 * 宿主自己就是这么用的：`ui-conversation/src/client/apply.ts:157`、
 * `ui-sidebar/src/client/index.ts:46` 均 `ctx.get('uiWorkspace')`。
 */
interface UiWorkspaceFace {
  openSession?: (target: unknown) => void
}

interface ChatKit {
  /** 父条目声明了 session 子槽时框架注入；缺失 = 宿主版本/装配不支持内嵌会话。 */
  SessionProvider?: (props: { session?: unknown; children: React.ReactNode }) => JSX.Element
  /** 渲染子槽（收窄在子槽键上）。 */
  renderSlot?: (key: string, owner: Record<string, unknown>) => React.ReactNode
  /** 子槽键（与注册时一致）。 */
  childKey: string
}

/** 一个 session 引用（`SessionReference` 的结构面）。 */
interface ReferenceLike {
  release(): void
}

/**
 * retain/release 一个子会话引用（AC1.4）。
 *
 * 纪律：
 *   - `ctx.sessions` **调用时**解析（不能闭包捕获，见项目纪律 6）；
 *   - 切换目标 / 卸载时 `release()`，且**只 release 一次**；
 *   - retain 抛错（会话不存在 / 服务缺失）⇒ 返回 `{ error }`，由 UI 如实展示。
 */
function useSessionReference(
  ctx: ClientContext,
  target: ChatTarget | null,
  enabled: boolean,
): { reference: ReferenceLike | null; error?: string } {
  const [state, setState] = useState<{ reference: ReferenceLike | null; error?: string }>({ reference: null })
  const childId = target?.childSessionId ?? ''
  const parentId = target?.parentSessionId ?? ''

  useEffect(() => {
    if (!enabled || !childId) {
      setState({ reference: null })
      return
    }
    const sessions = (ctx.get as (n: string, strict?: boolean) => unknown)('sessions', false) as SessionsFace | undefined
    if (!sessions || typeof sessions.retain !== 'function') {
      setState({ reference: null, error: '宿主未提供 sessions 服务，无法内嵌会话（可在侧边栏打开）' })
      return
    }
    const ac = new AbortController()
    let reference: ReferenceLike | null = null
    try {
      // 有父会话 id 时用 SubagentAddress（宿主的"持久直接父地址"，最稳）；
      // 缺父会话时退回裸会话 id（`SessionTarget` 两种都接受）。
      const targetRef = parentId ? { parentSessionId: parentId, childSessionId: childId, mode: target?.mode ?? 'unknown' } : childId
      reference = (sessions.retain(targetRef, {
        source: 'tfsOrchestratorChat',
        signal: ac.signal,
      }) ?? null) as ReferenceLike | null
      setState({ reference })
    } catch (e) {
      setState({ reference: null, error: `会话不可读：${e instanceof Error ? e.message : String(e)}` })
      return
    }
    return () => {
      try {
        reference?.release?.()
      } catch {
        // 释放失败不影响 UI；引用计数最终由宿主在 scope 销毁时回收。
      }
    }
    // 依赖只取 id：对象身份每次都新建，用它会让 effect 每次渲染都重跑并抖动引用计数。
  }, [ctx, childId, parentId, enabled, target?.mode])

  return state
}

/**
 * 子槽组件：把绑定好的会话渲染成**宿主自己的会话正文**（US1 / AC1.3）。
 *
 * 与官方侧边对话的 `ConversationSlotPanel` 同构
 * （`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:121-148`）：
 * 用工厂渲染 `conversation.content`，并把 `views` 位置固定为 `chat`。
 */
export function OrchestratorChatBody(props: Record<string, unknown>): JSX.Element {
  const renderFactorySlot = props['renderFactorySlot'] as
    | ((name: string, input: Record<string, unknown>, options?: Record<string, unknown>) => React.ReactNode)
    | undefined
  const useSession = props['useSession'] as ((sel: (s: Record<string, unknown>) => unknown) => unknown) | undefined
  const useConversation = props['useConversation'] as
    | ((sel: (s: Record<string, unknown>) => unknown) => unknown)
    | undefined

  const session = (useSession?.(v => v) ?? {}) as {
    blank?: boolean
    awaitingFirstTurn?: boolean
    running?: boolean
    promptAttempted?: boolean
    openState?: string
    subagent?: { address?: { mode?: string; childSessionId?: string }; parentAvailable?: boolean } | null
  }
  const conversation = (useConversation?.(v => v) ?? {}) as { activeTargets?: { size?: number } }

  /**
   * 把「父会话是否在线」发布给对话框 chrome（父离线提示 + 回主会话入口要用）。
   *
   * 只有**这个位置**知道答案：`subagent.parentAvailable` 由宿主在 catalog 解析后才填
   * （`session-controller/.../snapshot.ts:77`），且会话体外拿不到。
   * 判定口径逐字照抄宿主输入栏（`InputBar.tsx:133-134`），见 {@link ParentStatusStore} 注释。
   */
  const sub = session.subagent
  const continuable = sub?.address?.mode === 'continuable'
  const parentOffline = continuable && sub?.parentAvailable !== true
  useEffect(() => {
    parentStatusStore.set({ childSessionId: sub?.address?.childSessionId ?? '', parentOffline })
    return () => parentStatusStore.set({ childSessionId: '', parentOffline: false })
  }, [sub?.address?.childSessionId, parentOffline])

  if (typeof renderFactorySlot !== 'function') {
    return (
      <FallbackNotice
        title="当前宿主不支持内嵌会话渲染"
        detail="缺少 renderFactorySlot（宿主版本较旧）。可点右上角「在侧边栏打开」查看会话。"
      />
    )
  }

  // phase 口径与官方一致：正在跑 / 有绑定 ⇒ active；空白会话 ⇒ hero；其余 active。
  const active = (conversation.activeTargets?.size ?? 0) > 0
    || (session.blank !== true && session.awaitingFirstTurn !== true)
    || session.running === true
  const hero = !active && session.promptAttempted !== true && session.openState === 'open'

  return (
    <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
      {renderFactorySlot(
        'conversation.content',
        { variant: 'embedded', phase: hero ? 'hero' : 'active', hero },
        {
          slots: { views: FixedChatView },
        },
      )}
    </div>
  )
}

/** 固定为 `chat` 视图的会话正文（与官方 `FixedChatConversationView` 同义）。 */
function FixedChatView(props: Record<string, unknown>): React.ReactNode {
  const renderSlot = props['renderSlot'] as
    | ((key: string, owner: Record<string, unknown>) => React.ReactNode)
    | undefined
  if (typeof renderSlot !== 'function') return null
  return <>{renderSlot('conversation.session', { view: 'chat' })}</>
}

/** 可读的降级提示（不白屏、不假装可用）。 */
function FallbackNotice(props: { title: string; detail: string; action?: JSX.Element }): JSX.Element {
  return (
    <div
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        alignItems: 'center',
        justifyContent: 'center',
        padding: 24,
        textAlign: 'center',
        color: '#6b7280',
        fontSize: 12,
      }}
    >
      <div style={{ fontWeight: 600, color: '#374151' }}>{props.title}</div>
      <div style={{ lineHeight: 1.6, maxWidth: 420 }}>{props.detail}</div>
      {props.action}
    </div>
  )
}

const buttonStyle: React.CSSProperties = {
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#f9fafb',
  cursor: 'pointer',
  fontSize: 12,
}

/**
 * 父会话离线提示条（#3 的正解：把"为什么不能打字"讲清楚，并给出唯一可行的下一步）。
 *
 * ## 为什么面板必须自己讲这件事
 *
 * 宿主输入栏的占位符只说"父会话已离线，无法继续发送"，但**没说该去哪、为什么**。
 * 真实原因（已核实）：编排主 agent 是**用户主会话的 continuable 子会话**
 * （`orchestrator-session.ts:384` 取 `parent.session.id`），而本面板是**独立 Client Session**，
 * 它的 session 列表里根本没有主会话那条记录 ⇒ `agentAvailable(parent)` 恒为 false
 * （`session-controller/.../manager.ts:378-380`）⇒ 宿主按"子随父活"冻结输入。
 * 这是**正常保护**（父不在时禁止子空转），不是故障。
 *
 * ## 面板里仍然可以做什么（必须如实告知，别让用户以为全坏了）
 *
 * - 看完整会话记录与归纳/总结产物（只读，随时可看）；
 * - 停止正在运行的这一轮（continuable 的 Stop 独立保留，见 `InputBar.tsx:460-475`）；
 * - 切到别的任务子会话；
 * - 任务的**自动归纳与最终总结照常运行** —— 它们走宿主侧真实 live Agent
 *   （`orchestrator-session.ts:454-459`/`512-515`），与本面板视图无关。
 */
function ParentOfflineNotice(props: {
  onOpenParent?: () => void
  onOpenAside?: () => void
}): JSX.Element {
  return (
    <div
      data-tfs-parent-offline=""
      style={{
        padding: '7px 10px',
        fontSize: 11,
        lineHeight: 1.6,
        color: '#92400e',
        background: '#fffbeb',
        borderBottom: '1px solid #fde68a',
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: 2 }}>
        这是「主会话」的子会话 —— 主会话不在当前视图里，所以暂时不能在这里直接发消息。
      </div>
      <div style={{ color: '#a16207' }}>
        主会话恢复后即可继续对话；期间可自由查看记录、停止本轮、切换其它任务。
        任务的自动归纳与最终总结由宿主在后台继续执行，<strong>不受影响</strong>。
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
        {props.onOpenParent && (
          <button type="button" style={{ ...buttonStyle, borderColor: '#fcd34d', background: '#fff' }} onClick={props.onOpenParent}>
            回到主会话继续
          </button>
        )}
        {props.onOpenAside && (
          <button type="button" style={buttonStyle} onClick={props.onOpenAside} title="在侧边栏查看这个子会话（仍为只读，父会话在线后才能输入）">
            在侧边栏查看
          </button>
        )}
      </div>
    </div>
  )
}

/**
 * 任务中心右侧「主对话框」（US1/US4）。
 *
 * 组成：切换条（主 agent + 各任务子会话）+ 会话体（父条目注入的 SessionProvider 内嵌真实会话）
 *      + 「在侧边栏打开」兜底 + 降级提示。
 *
 * @param props.kit - 父条目（工作台）透传下来的槽位能力（SessionProvider / renderSlot）。
 * @param props.ctx - 客户端 cordis 上下文（**调用时**解析 sessions / sidebarRight）。
 * @param props.onEnsureOrchestrator - 「创建编排会话」按钮回调（走宿主路由）。
 * @param props.onClose - 收起对话框。
 */
export function OrchestratorChatDock(props: {
  kit: ChatKit
  ctx: ClientContext
  onEnsureOrchestrator?: (requirementKey: string) => Promise<{ ok: boolean; reason?: string }>
  onClose?: () => void
}): JSX.Element | null {
  const model = useChatModel()
  const active = model.items.find(i => i.key === model.activeKey)
  const target = active?.enabled ? (active.target ?? null) : null
  const { reference, error } = useSessionReference(props.ctx, target, model.visible)
  const [busy, setBusy] = useState(false)
  const [notice, setNotice] = useState<string>('')
  const parentStatus = useParentStatus()

  /**
   * 「回到主会话继续对话」（父会话离线时的唯一出路）。
   *
   * 为什么必须走宿主导航而不是自己拼界面：continuable 子会话的输入权限**由宿主按
   * "父是否在线"裁决**（`InputBar.tsx:133-139` 的 `parentOffline ⇒ disabled`），
   * 插件侧任何绕过都只是假输入框，消息根本进不了宿主的 inbox。
   * `uiWorkspace.openSession(parentSessionId)` 会 `replaceMain(…, 'reveal')`
   * ⇒ 主会话被选中**且面板被显示**，用户落到真正能打字的地方。
   *
   * @returns 是否成功导航（服务缺失/抛错 ⇒ false，由调用方如实告知）。
   */
  const openParentSession = useCallback(
    (t: ChatTarget | null): boolean => {
      if (!t || !t.parentSessionId) return false
      // 调用时解析（项目纪律 6：绝不闭包捕获宿主服务）。
      const nav = (props.ctx.get as (n: string, strict?: boolean) => unknown)('uiWorkspace', false) as
        | UiWorkspaceFace
        | undefined
      if (!nav || typeof nav.openSession !== 'function') return false
      try {
        nav.openSession(t.parentSessionId)
        return true
      } catch {
        return false
      }
    },
    [props.ctx],
  )

  const openAside = useCallback(
    (t: ChatTarget | null) => {
      if (!t) return false
      const sidebar = (props.ctx.get as (n: string, strict?: boolean) => unknown)('sidebarRight', false) as
        | SidebarRightFace
        | undefined
      if (!sidebar || typeof sidebar.openResource !== 'function') return false
      const address = buildChatAddress(t)
      if (!address) return false
      try {
        sidebar.openResource(address, { kind: 'subagentchat', preferNewPane: true })
        return true
      } catch {
        return false
      }
    },
    [props.ctx],
  )

  if (!model.visible) return null

  const canUseInline = Boolean(props.kit.SessionProvider && props.kit.renderSlot)
  const asideAvailable = (() => {
    const sidebar = (props.ctx.get as (n: string, strict?: boolean) => unknown)('sidebarRight', false)
    return Boolean(sidebar && typeof (sidebar as SidebarRightFace).openResource === 'function')
  })()

  const body = ((): JSX.Element => {
    if (!model.requirementKey) {
      return <FallbackNotice title="未选择需求" detail="在上方需求列表里点一行，右侧就会显示该需求的编排主 agent 会话。" />
    }
    if (!model.orchestrator || model.orchestrator.mode !== 'continuable') {
      return (
        <FallbackNotice
          title="尚未创建编排主 agent"
          detail={
            model.orchestrator?.reason
            ?? '该需求还没有可对话的编排会话。创建后，任务完成后会自动归纳结论、全部完成时出最终总结并回写 TFS。'
          }
          action={
            props.onEnsureOrchestrator
              ? (
                <button
                  type="button"
                  style={buttonStyle}
                  disabled={busy}
                  onClick={() => {
                    setBusy(true)
                    setNotice('')
                    void props
                      .onEnsureOrchestrator!(model.requirementKey)
                      .then(r => setNotice(r.ok ? '编排会话已创建' : `创建失败：${r.reason ?? '未知原因'}`))
                      .finally(() => setBusy(false))
                  }}
                >
                  {busy ? '创建中…' : '创建编排会话'}
                </button>
              )
              : undefined
          }
        />
      )
    }
    if (!canUseInline) {
      return (
        <FallbackNotice
          title="当前宿主不支持内嵌会话"
          detail="宿主未注入 SessionProvider/renderSlot（版本较旧）。仍可用下方的「在侧边栏打开」查看会话。"
        />
      )
    }
    if (error) {
      return (
        <FallbackNotice
          title="会话不可读"
          detail={error}
          action={
            asideAvailable
              ? (
                <button type="button" style={buttonStyle} onClick={() => openAside(target)}>
                  在侧边栏打开
                </button>
              )
              : undefined
          }
        />
      )
    }
    if (!target) {
      return <FallbackNotice title="该任务还没有会话" detail="任务派发成功后，这里可以切到它的子 agent 会话。" />
    }
    if (!reference) {
      return <FallbackNotice title="正在打开会话…" detail="正在向宿主申请会话引用。" />
    }
    /**
     * ⚠️ **必须用 JSX 渲染 `SessionProvider`，不能当普通函数调用**（2026-10-01 白屏根因）。
     *
     * 宿主注入的 `SessionProvider` 是**真组件**：内部调用 `useScopeBinding()` 与
     * `useSyncExternalStore(...)`
     * （`ui-renderer/src/client/scoped-slots.tsx:510-518`）。写成
     * `kit.SessionProvider({ session, children })` 会把这两个 hook **内联进本组件的 hook 序列**，
     * 而它又在 `body()` 的条件分支里 —— `reference` 由 null 变成有值那一次渲染，
     * hook 数量发生变化 ⇒ React 抛 "Rendered more hooks than during the previous render"
     * ⇒ 整个面板条目崩溃被宿主摘除 ⇒ **白屏**。
     *
     * 官方侧边对话用的就是 JSX（同文件 `:163`），这里必须同形。
     */
    const SessionProvider = props.kit.SessionProvider!
    return (
      <>
        <SessionProvider session={reference}>{props.kit.renderSlot!(props.kit.childKey, {})}</SessionProvider>
        {active?.key !== 'orchestrator' && (
          <div style={{ padding: '6px 10px', borderTop: '1px solid #f1f5f9', display: 'flex', gap: 8 }}>
            <button
              type="button"
              style={buttonStyle}
              onClick={() => chatPanelStore.selectKey('orchestrator')}
            >
              ← 返回主 agent
            </button>
            <span style={{ fontSize: 11, color: '#9ca3af', alignSelf: 'center' }}>
              ONE-SHOT 子会话结束后不可继续输入；需要补充指令请用任务详情里的「追问」。
            </span>
          </div>
        )}
      </>
    )
  })()

  return (
    <div
      data-tfs-orchestrator-chat=""
      style={{
        width: 420,
        minWidth: 280,
        maxWidth: '60%',
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        border: '1px solid #e5e7eb',
        borderRadius: 8,
        background: '#fff',
        overflow: 'hidden',
      }}
    >
      {/* 头部：标题 + 侧栏兜底 + 收起 */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '8px 10px',
          borderBottom: '1px solid #f1f5f9',
          background: '#fafafa',
        }}
      >
        <strong style={{ fontSize: 13 }}>主对话框</strong>
        <span style={{ fontSize: 11, color: '#9ca3af', flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {model.requirementTitle || '未选择需求'}
        </span>
        {asideAvailable && active?.enabled && (
          <button type="button" style={buttonStyle} onClick={() => openAside(target)} title="用宿主的侧边对话打开当前会话">
            在侧边栏打开
          </button>
        )}
        {props.onClose && (
          <button type="button" style={buttonStyle} onClick={props.onClose} title="收起对话框">
            收起
          </button>
        )}
      </div>

      {/* 切换条（AC4.1/AC4.3） */}
      {model.items.length > 0 && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 10px', borderBottom: '1px solid #f1f5f9' }}>
          {model.items.map(item => {
            const isActive = item.key === model.activeKey
            return (
              <button
                key={item.key}
                type="button"
                disabled={!item.enabled}
                title={item.enabled ? item.label : (item.reason ?? '该任务还没有会话')}
                onClick={() => chatPanelStore.selectKey(item.key)}
                style={{
                  ...buttonStyle,
                  cursor: item.enabled ? 'pointer' : 'not-allowed',
                  opacity: item.enabled ? 1 : 0.5,
                  borderColor: isActive ? '#93c5fd' : '#d1d5db',
                  background: isActive ? '#eff6ff' : '#f9fafb',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 6,
                  maxWidth: 200,
                }}
              >
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.label}</span>
                {item.badge && (
                  <span style={{ fontSize: 10, color: item.badge.color, background: item.badge.bg, borderRadius: 8, padding: '0 5px' }}>
                    {item.badge.text}
                  </span>
                )}
              </button>
            )
          })}
        </div>
      )}

      {notice && (
        <div style={{ padding: '6px 10px', fontSize: 11, color: '#92400e', background: '#fffbeb' }}>{notice}</div>
      )}

      {/*
        父会话离线提示（#3）。只在**编排主 agent**（key='orchestrator'）上出现：
        编排会话是主会话的 continuable 子会话，任务子会话（ONE-SHOT）本就不支持续输入，
        对它们提示"父会话离线"是噪音。
        判定用 `parentStatus`（由会话体内的 useSession 发布）+ 当前 target 的 childId 对齐，
        避免切换瞬间拿上一个会话的状态去误判新会话。
      */}
      {active?.key === 'orchestrator'
        && parentStatus.parentOffline
        && parentStatus.childSessionId !== ''
        && parentStatus.childSessionId === target?.childSessionId
        && (
          <ParentOfflineNotice
            onOpenParent={target?.parentSessionId ? () => { openParentSession(target) } : undefined}
            onOpenAside={asideAvailable ? () => { openAside(target) } : undefined}
          />
        )}

      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>{body}</div>
    </div>
  )
}

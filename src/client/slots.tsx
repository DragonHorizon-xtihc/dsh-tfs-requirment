/**
 * 客户端半槽位接线（T047 / T034 / T055）+ 真实 HostBridge（Phase 3）。
 *
 * 「TFS 看板」有两种承载形态，共用同一份数据与同一个 `ExecutionPanel`：
 *
 *   1. **中央看板**（全流程）——需求池 / 任务中心 / 执行配置 / 角色管理 / 连接与凭据五个标签页：
 *      - `sidebar.panellist` 左侧菜单行（只画图标，宿主拥有行样式/文案/点击）；
 *      - `main` 中央面板，`key` 与菜单行的 `id` 同为 `PANEL_ID`。
 *   2. **右侧栏「TFS 执行」标签页**（与对话并排，优化项 R1）——
 *      - `ctx.sidebarRightTabs.register(...)` 声明页类型；
 *      - `sidebar.right.pane.tab` 槽渲染页体（key 同为该类型 id）。
 *
 * 早期版本注册在 `shell.overlay`（`kind:'list'` 的**常驻**浮层，宿主会一直渲染其中每个 entry），
 * 于是把全屏面板放进去 = 打开 dsh 就弹框盖住应用。改成 `main` 槽后由用户点菜单才挂载。
 *
 * 五个标签页由**单一面板条目**承载而非五个条目：`main` 是 keyed 槽，同 key 会互相顶掉。
 *
 * **客户端半 / 宿主半边界（重要，不臆造）**：客户端半是独立打包的，不能直接访问宿主服务
 * （如 `ctx.subagents.start`；工具经 `ToolRuntime.execute` 调用，**不是**服务上的可调用属性）。
 * 所有动作经 `HostBridge` 用 `fetch` 打到宿主半的 HTTP 路由
 * （路径见 `TFS_ROUTES`，实现见 `src/host/route.ts`）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/client/slots
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { ExecutionPanel } from './components/ExecutionPanel.js'
import {
  SidePanel,
  TFS_EXEC_KIND,
  TFS_EXEC_TAB_ID,
  TFS_EXEC_TITLE,
} from './components/SidePanel.js'
import { RequirementPool } from './components/RequirementPool.js'
import { RoleSettings } from './components/RoleSettings.js'
import { TaskCenter } from './components/TaskCenter.js'
import {
  OrchestratorChatBody,
  OrchestratorChatDock,
} from './components/OrchestratorChat.js'

/**
 * spec 010：任务中心右侧「主对话框」的子槽键。
 *
 * 命名带插件前缀，避免与宿主/其它插件的槽键撞名（子槽键是全局命名空间，
 * 只能被一个父条目声明）。
 */
const TFS_CHAT_SLOT_KEY = 'tfs.orchestrator.chat'

/** 父条目透传给对话框的槽位能力（`SessionProvider` / `renderSlot`）。 */
interface ChatSlotKit {
  SessionProvider?: (props: { session?: unknown; children: React.ReactNode }) => JSX.Element
  renderSlot?: (key: string, owner: Record<string, unknown>) => React.ReactNode
  childKey: string
}
import { ConnectionPanel } from './components/ConnectionPanel.js'
import type {
  ArchiveResult,
  AuditView,
  BoardSnapshotView,
  BoardTaskView,
  ClaimRequirementInput,
  ClaimRequirementResult,
  EnvFileResult,
  ExecutionPanelData,
  ExecutionActions,
  HealthResult,
  HostBridge,
  McpSetup,
  OrchestratorEnsureResult,
  ProfileListResult,
  ProfileOpResult,
  ProfileSaveInput,
  RequirementFilter,
  RequirementListResult,
  RequirementQueryOptions,
  RequirementExecStateResult,
  RequirementSummary,
  RoleDefinition,
  SetRequirementExecStateInput,
  TargetRef,
  TaskAction,
  TaskOpResult,
  TaskTraceResult,
  FollowUpTaskInput,
  FollowUpTaskResult,
  TfsToolCatalogView,
  UiState,
  WriteOpDraft,
  DispatchDraft,
  DeleteTasksResult,
  RestoreResult,
  EnrichResult,
  DispatchBatchResult,
  DispatchBatchWave,
  DispatchActionResult,
  UpdateRequirementInput,
  UpdateRequirementResult,
  UpdateTaskInput,
} from '../shared/contracts.js'
import { TFS_ROUTES } from '../shared/contracts.js'
import {
  planBatchStep,
  type BatchTaskLike,
} from '../shared/batch-dispatch.js'
import type { SlotRegistryLike } from '../shared/slot-registration.js'
import { PanelOpenControl } from '../shared/panel-open-control.js'
import { targetRefFromKey } from '../shared/target.js'
import { bindPanelRowEviction, evictTakeoverPanels, PANEL_ROW_HOOK } from './takeover.js'
import { BoardStore, useBoardStore } from './board-store.js'

/**
 * 最小结构类型：仅覆盖本插件实际使用的 `ctx.slots` 子集。
 * 运行期宿主一定注入 `slots` 服务（否则面板根本无法注册）。
 */
interface SlotSpec {
  name: string
  /** list 槽的单元格键（如 `sidebar.panellist` 的菜单行 id）。 */
  id?: string
  /** keyed 槽的单元格键（如 `main` 槽的面板 key）。 */
  key?: string
  order?: number
  label?: string
  /** 子槽声明表（spec 010：`tfs.orchestrator.chat`，见 `shared/slot-registration.ts`）。 */
  children?: Record<string, { kind: string; scope?: string }>
}
/**
 * 槽位组件签名。
 *
 * 宿主按各槽的 ownerProps 注入 props（`sidebar.panellist` 给 `{ size, active }`，
 * `main` 不给），这里不逐槽建模。形参用 `never`：既允许"不接 props"的组件，
 * 也允许"声明了自己 props 形状"的组件（参数按逆变检查，`never` 可赋给任何形状）。
 */
type SlotComponent = (props: never) => JSX.Element

interface SlotRegistry extends SlotRegistryLike {
  inject(slot: string, factory: () => unknown): void
  register(spec: SlotSpec, component: SlotComponent): unknown
  /**
   * 订阅某槽的注册变化（`ui-renderer/src/client/registry.ts:462`）。
   *
   * 标可选：更老的部署上本插件的类型面与运行期服务可能不完全对齐，
   * 缺该探针时退回"只看一次当前快照"（见 `panelRowRegistered`）。
   */
  subscribe?: (slot: string, fn: () => void) => (() => void)
}
type ClientCtx = ClientContext & { slots: SlotRegistry }

/**
 * 幂等注册（问题 1 修复）。
 *
 * 实现下沉到 `src/shared/slot-registration.ts`：那里**不依赖 DOM/JSX**，
 * 因而 `tsconfig.tests.json`（排除 `src/client`，无 `--jsx`）也能直接对
 * 它做类型检查与单测。根因链的完整推导见该模块的文档。
 */
export { registerOnce } from '../shared/slot-registration.js'
import { registerOnce } from '../shared/slot-registration.js'

/**
 * 「左侧菜单行是否已注册成功」的控制器（2026-10-08 修：菜单里出现两次「TFS 看板」）。
 *
 * ## 事实（本机 DOM 实测，非推断）
 *
 * 侧边栏里确实存在**两个** TFS 入口：
 *   - `sidebar.panellist` 的菜单行（top≈400），宿主 `SidebarRoot.tsx:71` 渲染，带文案；
 *   - `sidebar.footer.action` 的兼容入口按钮（top≈622），宿主 `SidebarRoot.tsx:307`
 *     渲染在 `footArea` 里 —— 位置恰好在第三方「今日用量」卡片（top≈582-618）**下方**，
 *     正是用户报告要取消的那一个。
 *
 * ## 为什么会有两个（源码依据）
 *
 * footer/overlay 这对入口是给**旧 / 精简宿主**（没有 `main` 与 `sidebar.panellist`，
 * 只有 `sidebar.footer.action` + `shell.overlay`）准备的兼容通道。当时的注释写着
 * "在新版宿主（用 main / panellist）上这两条不触发"——依据是"`slots.inject` 仅在该槽
 * **已被宿主声明时**才执行回调"。
 *
 * 这条依据是**错的**：`ui-sidebar` 在新版宿主里**同样声明了** `sidebar.footer.action`
 * （`packages/client/ui-sidebar/src/client/contract/slots.ts` 的 `SlotMap` 有该键，
 * 且 `SidebarRoot.tsx:307` 无条件 `renderSlot` 它），并且 `shell.overlay` 也照旧存在。
 * 于是两条"兼容"注入在新版宿主上**照常跑**，菜单行之外多出一个 footer 入口 ——
 * 两个入口点开还是同一个 Workbench，纯属重复。
 *
 * ## 修法
 *
 * 不去猜宿主版本，而是**看菜单行到底注册上了没有**：
 *   - 菜单行注册成功 ⇒ 用户已有一条正规入口 ⇒ footer 入口不再需要，不注册；
 *   - 菜单行未注册（旧宿主确实没有 panellist 槽）⇒ 保留 footer 入口作为唯一入口。
 *
 * 直接用 `PanelOpenControl` 复用其订阅语义：它的 `getSnapshot` 返回稳定布尔值，
 * 配合 `useSyncExternalStore` 不会触发无限重渲染（见该类的文档）。
 *
 * ## 为什么还需要 subscribe
 *
 * `slots.inject('sidebar.footer.action', ...)` 的回调可能**早于**
 * `sidebar.panellist` 的注册完成（两者声明顺序由宿主的注册顺序决定，不在本插件控制内）。
 * 那一刻探测结果还是 false，若就此定下"注册 footer 入口"，又会回到两个入口。
 * 故订阅 panellist 的注册变化：菜单行一出现就把开关翻到 true，footer 组件随即返回 null。
 */
export const panelRowRegistered = new PanelOpenControl()

/**
 * 启动对 `sidebar.panellist` 的观测，把「菜单行是否已注册」同步进 {@link panelRowRegistered}。
 *
 * 同步探测一次作为初值；能拿到 `subscribe` 时再订阅后续变化。
 * 任何一步失败都退化为"当前快照即结论"——最坏结果是保留 footer 入口（回到修复前的状态），
 * 不会出现入口消失（那才是真的功能丢失）。
 *
 * @param slots - 宿主 `ctx.slots`。
 * @returns dispose（交给 `ctx.effect`，随插件卸载一并退订）。
 */
function watchPanelRow(slots: SlotRegistry): () => void {
  const sync = (): void => {
    try {
      const probe = slots.entriesOfSlot
      if (typeof probe !== 'function') return
      const has = probe.call(slots, 'sidebar.panellist').some(entry => entry.options?.id === PANEL_ID)
      if (has) panelRowRegistered.show()
    } catch {
      // 槽尚未声明：等 subscribe 回调，或退化为"未注册"。
    }
  }
  sync()
  try {
    if (typeof slots.subscribe !== 'function') return () => {}
    return slots.subscribe('sidebar.panellist', sync)
  } catch {
    return () => {}
  }
}

/**
 * 宿主布局服务面（宿主 `ILayout` 的**结构子集**）。
 *
 * 只声明本插件真正用到的 `selectPanel`。完整契约见
 * `dsh-client-ui-layout/lib/types/client/service.d.ts:28-52`。
 *
 * `selectPanel(null)` 是"回到 Conversation"的官方语义；对**未注册**的非 null id 会抛错
 * （`ui-layout/src/client/service.ts:68-74`），故调用方必须 try/catch。
 */
interface ILayoutFace {
  selectPanel?: (panelId: string | null) => void
}

/**
 * 右栏页类型定义（宿主 `SidebarRightTabDefinition` 的**结构子集**）。
 *
 * 只声明本插件真正提供的字段。宿主契约见：
 * `dsh-client-ui-sidebar-right/lib/types/client/tab-registry.d.ts:68-109`。
 */
interface SidebarRightTabDefinitionFace {
  /** 该实现的身份，同时是它在 `sidebar.right.pane.tab` 座席里注册用的 key。 */
  id: string
  /** 页类型判别符（`openTab` 收的就是它）。不能与内建 kind（如 `'guide'`）撞。 */
  kind: string
  /** 页签 chip 的初始文案。 */
  title: (address: string) => string
  /** 向导页条目；省略则不出现在右栏 `+` 的向导里。 */
  guide?: Array<{ title: () => string; description?: () => string }>
}

/** 右栏页类型注册表（宿主 `SidebarRightTabRegistry` 的结构子集，见 `tab-registry.d.ts:130-153`）。 */
interface SidebarRightTabRegistry {
  register(definition: SidebarRightTabDefinitionFace): () => void
}

/** 右栏对外服务面（宿主 `ISidebarRight` 的结构子集，见 `service.d.ts:105-142`）。 */
interface ISidebarRightFace {
  /** 收起已展开的右栏，或展开已收起的。 */
  toggleExpanded?: () => void
  /** 按 kind 打开一个页类型；未注册的 kind 会抛错。 */
  openTab?: (kind: string, options?: unknown) => void
}

/**
 * 本插件面板的唯一 id。
 *
 * 它**同时**是两处的键，二者必须同名：
 *   - `sidebar.panellist` 的 entry id（左侧菜单行）；
 *   - `main` 槽的 key（中央面板）。
 *
 * 依据（宿主源码，逐条核实）：
 *   - 侧边栏行的点击动作就是 `selectPanel(id)`：`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:68`；
 *   - 中央面板按该 id 派发：`packages/client/ui-layout/src/client/index.ts` 的 `MainPanel` →
 *     `renderSlot('main', {}, { entryKey: usePanelInfo(info => info.activePanelId) ?? 'conversation' })`；
 *   - `layout.selectPanel` 只接受**已注册**的 main key，否则抛错：`ui-layout/src/client/service.ts:67-74`。
 * 名字对不上的后果是"点了菜单没反应"，故用同一常量而非两处字面量。
 */
const PANEL_ID = 'tfs-requirment'

/** 左侧菜单行文案（宿主 `resolveSlotLabel` 也接受 thunk，此处给字面量即可）。 */
const PANEL_LABEL = 'TFS 看板'

/**
 * 左侧菜单行图标。
 *
 * 宿主按 `renderSlot('sidebar.panellist', { size, active }, { only: id })` 渲染，
 * 故 props 形状是 `SidebarPanelIconOwnerProps { size: number; active: boolean }`
 * （`packages/client/ui-sidebar/src/client/contract/slots.ts`）。
 * 颜色用 `currentColor`：选中态由宿主行样式（`panelActive`）改前景色，图标自动跟随。
 */
function TfsPanelIcon(props: { size?: number; active?: boolean }): JSX.Element {
  const size = props.size ?? 18
  return (
    <svg
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.3}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      // 问题 1：供 takeover.ts 的 capture 点击监听识别"本插件面板行"。
      // 行点击后任务看板/SSH 的 DOM 接管不会自动让位（它们只认会话行与 dsh-panel-activate 事件），
      // 需要据此钩子在点击本图标时主动驱逐接管面板。
      {...{ [PANEL_ROW_HOOK]: '' }}
    >
      <rect x="2" y="2.5" width="12" height="11" rx="1.5" />
      <path d="M2 6.5h12" />
      <path d="M5.5 6.5v7M10.5 6.5v7" />
    </svg>
  )
}

/**
 * 「宿主不可达」原因的前缀。
 *
 * 兜底面板数据与"宿主正常但确实没有数据"在字段上无法区分（都是空清单），
 * 而桥方法一律降级返回、从不 reject，所以面板顶部的错误横幅此前永远不会被触发 ——
 * 插件没装进 profile 时，用户看到的是"暂无角色，点击右上「＋ 新建角色」"，
 * 完全没有"宿主不可达"这个事实。用带前缀的告警把两者区分开，横幅据此显示。
 */
const HOST_UNREACHABLE = '宿主不可达：'

/**
 * 网络/业务失败的兜底面板数据。
 *
 * **刻意全部给空清单**（问题 4/5/6/7）：兜底数据只在"连不上宿主"时出现，
 * 此时给任何假模型/假 MCP 名都会让用户以为那是 dsh 真实可选的，选了必然失败。
 * 空清单 + 一条带 {@link HOST_UNREACHABLE} 前缀的告警，才是诚实的降级。
 *
 * @param reason - 不可达的判定依据（HTTP 状态或网络异常），会并入告警。
 */
function fallbackPanelData(reason: string): ExecutionPanelData {
  return {
    targetWorkItem: '—',
    collection: 'WN_HIS',
    roles: [] as RoleDefinition[],
    models: [],
    mcpServers: [],
    skills: [],
    modelOptions: [],
    workspaces: [],
    presets: [],
    providers: [],
    skillOptions: [],
    tagSuggestions: ['dsh', 'tfs-requirment', 'auto'],
    collections: ['WN_HIS'],
    pollIntervalMinutes: 5,
    catalogWarnings: [`${HOST_UNREACHABLE}${reason}`],
  }
}

/**
 * 统一 POST JSON 并解析响应。
 *
 * 失败状态必须翻成 `{ ok: false, reason }`：宿主统一用 `sendError` 回 `{ error: message }`
 * （`host/http-util.ts`），而此前这里不看 `res.ok`，直接把这个体当成正常结果返回 ——
 * 于是 400/405/413/500 全部变成 `ok === undefined`，界面只能显示兜底的"操作失败"，
 * 宿主给出的可读原因（"expectedRevision 必须是非负整数"、"角色字段 defaultMcp 必须是字符串数组"…）
 * 永远到不了用户眼前。
 */
async function postJson<T>(path: string, body: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    cache: 'no-store',
    body: JSON.stringify(body),
  })
  const data = (await res.json().catch(() => null)) as T | { error?: string } | null
  if (res.ok) return data as T
  const reason = (data as { error?: string } | null)?.error
  return { ok: false, reason: reason ?? `请求失败（HTTP ${res.status}）` } as T
}

/**
 * 真实宿主桥：经 HTTP 路由调宿主半（Principle IV：写操作唯一出口在宿主半）。
 */
class HttpHostBridge implements HostBridge {
  private last: ExecutionPanelData | null = null

  async getPanelData(): Promise<ExecutionPanelData> {
    try {
      const res = await fetch(TFS_ROUTES.panelData, { method: 'GET', cache: 'no-store' })
      if (!res.ok) return fallbackPanelData(`面板数据路由返回 HTTP ${res.status}`)
      const data = (await res.json()) as ExecutionPanelData
      this.last = data
      return data
    } catch (e) {
      return fallbackPanelData(e instanceof Error ? e.message : String(e))
    }
  }

  /**
   * 强制重采能力目录后再取面板数据（问题 4/5/6/7/9/11 的"事后配置"场景）。
   *
   * 用户完全可能先打开插件、后配模型 / 装技能 / 加 MCP server。`getPanelData` 只读宿主
   * 内存快照，此时会永远显示首次采集的结果。本方法走 `catalog-refresh` 路由触发重采。
   * 失败时回退到普通 `getPanelData`（不把"刷新失败"变成"面板空白"）。
   */
  async refreshPanelData(): Promise<ExecutionPanelData> {
    try {
      const res = await fetch(TFS_ROUTES.catalogRefresh, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      })
      if (!res.ok) return this.getPanelData()
      const data = (await res.json()) as ExecutionPanelData
      this.last = data
      return data
    } catch {
      return this.getPanelData()
    }
  }

  /**
   * 确认回写（过四道门禁后直连 TFS REST 写入）。
   *
   * ## 目标必须由调用方显式传入（2026-09-21 实机事故修复）
   *
   * 宿主下发的 `panel-data.targetWorkItem` 是**占位符** `'—'`（`host/api.ts#getPanelData` 硬编码）：
   * "当前目标"是**客户端会话内**的状态（用户在需求池/任务中心点了谁），宿主根本无从知晓。
   * 旧实现只取 `this.last?.targetWorkItem` ⇒ 用户明明"选为目标"了，确认回写仍发出 `'—'`，
   * 得到 *targetWorkItem 缺少有效工作项 id：—*。
   * 故目标一律以调用方（正在渲染的那份面板数据）为准，`this.last` 只作最后兜底。
   *
   * @param ops - 回写草稿。
   * @param target - 目标需求（`id@collection` + 集合）。
   * @returns 回写结果。
   */
  async confirmWrite(ops: WriteOpDraft[], target?: TargetRef): Promise<{ ok: boolean; reason?: string }> {
    try {
      const body = await postJson<{ ok: boolean; reason?: string }>(TFS_ROUTES.confirmWrite, {
        ops,
        targetWorkItem: target?.targetWorkItem ?? this.last?.targetWorkItem ?? '—',
        collection: target?.collection ?? this.last?.collection ?? '',
      })
      return { ok: body.ok, reason: body.reason }
    } catch {
      return { ok: false, reason: '无法连接到宿主回写服务（请确认插件已在 profile 启用并重启界面）' }
    }
  }

  /**
   * 发起执行（并发派发到角色智能体）。
   *
   * 目标口径与 {@link confirmWrite} 完全一致：以调用方传入的 target 为准，
   * `this.last` 只作兜底（否则 exec 面板发出的 taskId 会退化成 `—#role-coder`）。
   *
   * @param req - 派发草稿。
   * @param taskId - 看板任务 id（有则宿主据此回绑状态/轨迹）。
   * @param target - 目标需求。
   * @returns 派发结果。
   */
  async dispatch(req: DispatchDraft, taskId?: string, target?: TargetRef): Promise<DispatchActionResult> {
    try {
      const body = await postJson<{
        ok: boolean
        reason?: string
        taskId?: string
        createdTask?: boolean
        workspace?: string
      }>(TFS_ROUTES.dispatch, {
        draft: req,
        targetWorkItem: target?.targetWorkItem ?? this.last?.targetWorkItem ?? '—',
        collection: target?.collection ?? this.last?.collection ?? '',
        ...(taskId ? { taskId } : {}),
      })
      // 问题 1/6：把宿主回带的 taskId / createdTask / workspace 原样透出 ——
      // 执行面板要显示"创建了哪条任务、实际用哪个工作目录"，而不是它以为的那个。
      return {
        ok: body.ok,
        ...(body.reason ? { reason: body.reason } : {}),
        ...(body.taskId ? { taskId: body.taskId } : {}),
        ...(body.createdTask ? { createdTask: true } : {}),
        ...(body.workspace ? { workspace: body.workspace } : {}),
      }
    } catch {
      return { ok: false, reason: '无法连接到宿主分发服务（请确认插件已在 profile 启用并重启界面）' }
    }
  }

  async listRequirements(filter: RequirementFilter): Promise<RequirementListResult> {
    try {
      return await postJson<RequirementListResult>(TFS_ROUTES.requirements, filter)
    } catch {
      return { ok: false, items: [], reason: '无法连接到宿主需求服务（请确认插件已在 profile 启用并重启界面）' }
    }
  }

  /** 需求筛选可选项（问题 3：项目/类型/状态/指派人，宿主从真实 TFS 采集；命中宿主缓存则不重采）。 */
  async getQueryOptions(): Promise<RequirementQueryOptions> {
    try {
      const res = await fetch(TFS_ROUTES.queryOptions, { method: 'GET', cache: 'no-store' })
      if (!res.ok) throw new Error(`返回 ${res.status}`)
      return (await res.json()) as RequirementQueryOptions
    } catch {
      // 采集失败时返回"四项皆空 + 可读原因"：UI 据此提示"下拉为空但仍可按 ID 拉取"，
      // 而不是把失败伪装成"没有可选项"。
      return {
        projects: [],
        types: [],
        states: [],
        assignees: [],
        reason: '无法连接到宿主筛选选项服务（请确认插件已在 profile 启用并重启界面）',
      }
    }
  }

  /**
   * 强制重采可选项（FR-003）。
   *
   * 宿主对可选项做了进程内缓存（避免每次打开页签都跑数百次 TFS 元数据请求），
   * 代价是 TFS 上新建项目/类型后会滞后。本方法走 `POST /query-options-refresh` 绕过缓存。
   * 路由不存在（旧宿主）时退回普通读取 —— 拿不到新鲜数据，但不比现状更差。
   */
  async refreshQueryOptions(): Promise<RequirementQueryOptions> {
    try {
      // 问题 1：强制重采走「采集并落盘」路由（query-options-collect），
      // 旧的 query-options-refresh（仅绕过进程内缓存）保留兼容但不再使用。
      const body = await postJson<{ ok: boolean; data?: RequirementQueryOptions; reason?: string }>(
        TFS_ROUTES.queryOptionsCollect,
        {},
      )
      if (body.ok && body.data) return body.data
      if (body.reason) return { projects: [], types: [], states: [], assignees: [], reason: body.reason }
      return this.getQueryOptions()
    } catch {
      return this.getQueryOptions()
    }
  }

  /** 问题 1：只读本地落盘的可选项，不触发 TFS 采集；无缓存 data=null。 */
  async loadQueryOptions(
    collection?: string,
  ): Promise<{ ok: boolean; data: RequirementQueryOptions | null; savedAt?: string }> {
    try {
      const qs = collection ? `?collection=${encodeURIComponent(collection)}` : ''
      const res = await fetch(`${TFS_ROUTES.queryOptionsLoad}${qs}`, { method: 'GET', cache: 'no-store' })
      if (!res.ok) return { ok: false, data: null }
      return (await res.json()) as { ok: boolean; data: RequirementQueryOptions | null; savedAt?: string }
    } catch {
      return { ok: false, data: null }
    }
  }

  /** 问题 1：强制重采可选项并落盘覆盖（「采集可选项」按钮）。 */
  async collectQueryOptions(
    collection?: string,
  ): Promise<{ ok: boolean; data?: RequirementQueryOptions; reason?: string }> {
    try {
      return await postJson<{ ok: boolean; data?: RequirementQueryOptions; reason?: string }>(
        TFS_ROUTES.queryOptionsCollect,
        collection ? { collection } : {},
      )
    } catch {
      return { ok: false, reason: '无法连接到宿主筛选选项服务（请确认插件已在 profile 启用并重启界面）' }
    }
  }

  /** 问题 2/4/6：读 UI 状态（筛选记忆/每页条数）。 */
  async loadUiState(collection?: string): Promise<UiState> {
    try {
      const qs = collection ? `?collection=${encodeURIComponent(collection)}` : ''
      const res = await fetch(`${TFS_ROUTES.uiState}${qs}`, { method: 'GET', cache: 'no-store' })
      if (!res.ok) return {}
      return (await res.json()) as UiState
    } catch {
      return {}
    }
  }

  /** 问题 2/4/6：合并保存 UI 状态。 */
  async saveUiState(
    patch: Partial<UiState>,
    collection?: string,
  ): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await postJson<{ ok: boolean; reason?: string }>(
        TFS_ROUTES.uiState,
        collection ? { ...patch, collection } : patch,
      )
    } catch {
      // UI 状态落盘失败不打扰用户主流程（筛选/分页仍在当前会话内有效）。
      return { ok: false, reason: 'UI 状态保存失败（本地文件不可写）' }
    }
  }

  async listRoles(): Promise<RoleDefinition[]> {
    try {
      const res = await fetch(TFS_ROUTES.roles, { method: 'GET', cache: 'no-store' })
      const body = (await res.json()) as { roles?: RoleDefinition[] }
      return body.roles ?? []
    } catch {
      return []
    }
  }

  async saveRole(role: RoleDefinition): Promise<{ ok: boolean; reason?: string }> {
    try {
      return await postJson<{ ok: boolean; reason?: string }>(TFS_ROUTES.roleSave, role)
    } catch {
      return { ok: false, reason: '无法连接到宿主角色服务' }
    }
  }

  async deleteRole(id: string, force?: boolean): Promise<{ ok: boolean; reason?: string; references?: string[] }> {
    try {
      return await postJson<{ ok: boolean; reason?: string; references?: string[] }>(
        TFS_ROUTES.roleDelete,
        { id, force },
      )
    } catch {
      return { ok: false, reason: '无法连接到宿主角色服务' }
    }
  }

  async getBoard(): Promise<BoardSnapshotView> {
    try {
      const res = await fetch(TFS_ROUTES.board, { method: 'GET', cache: 'no-store' })
      if (!res.ok) return boardUnavailable(`看板路由返回 ${res.status}`)
      return (await res.json()) as BoardSnapshotView
    } catch {
      return boardUnavailable('无法连接到宿主看板服务（请确认插件已在 profile 启用并重启界面）')
    }
  }

  async claimRequirement(input: ClaimRequirementInput): Promise<ClaimRequirementResult> {
    try {
      return await postJson<ClaimRequirementResult>(TFS_ROUTES.claim, input)
    } catch {
      return { ok: false, added: false, reason: '无法连接到宿主领取服务' }
    }
  }

  async decomposeRequirement(
    requirementId: string,
  ): Promise<{ ok: boolean; taskIds?: string[]; created?: number; skipped?: number; createdRoles?: string[]; reason?: string }> {
    try {
      return await postJson<{ ok: boolean; taskIds?: string[]; created?: number; skipped?: number; createdRoles?: string[]; reason?: string }>(
        TFS_ROUTES.decompose,
        { requirementId },
      )
    } catch {
      return { ok: false, reason: '无法连接到宿主拆解服务' }
    }
  }

  /** 问题 7：还原已领取需求回需求池。 */
  async restoreRequirement(requirementKey: string): Promise<RestoreResult> {
    try {
      return await postJson<RestoreResult>(TFS_ROUTES.requirementRestore, { requirementKey })
    } catch {
      return { ok: false, reason: '无法连接到宿主看板服务' }
    }
  }

  /** 问题 11：实时重取需求四段描述并回写看板。 */
  async enrichRequirement(requirementKey: string): Promise<EnrichResult> {
    try {
      return await postJson<EnrichResult>(TFS_ROUTES.requirementEnrich, { requirementKey })
    } catch {
      return { ok: false, reason: '无法连接到宿主看板服务' }
    }
  }

  /** 问题 8：删除已取消任务（批量，整批门禁）。 */
  async deleteTasks(taskIds: string[]): Promise<DeleteTasksResult> {
    try {
      return await postJson<DeleteTasksResult>(TFS_ROUTES.taskDelete, { taskIds })
    } catch {
      return { ok: false, reason: '无法连接到宿主看板服务' }
    }
  }

  /** 问题 3：编辑已领取需求的本地字段（提示词 / 工作目录）。 */
  async updateRequirement(input: UpdateRequirementInput): Promise<UpdateRequirementResult> {
    try {
      return await postJson<UpdateRequirementResult>(TFS_ROUTES.requirementUpdate, input)
    } catch {
      return { ok: false, reason: '无法连接到宿主看板服务（需求编辑）' }
    }
  }

  /** 问题 4：编辑任务字段（提示词 / 模型 / 技能 / MCP / 工作目录）。 */
  async updateTask(input: UpdateTaskInput): Promise<TaskOpResult> {
    try {
      return await postJson<TaskOpResult>(TFS_ROUTES.taskUpdate, input)
    } catch {
      return { ok: false, reason: '无法连接到宿主看板服务（任务编辑）' }
    }
  }

  /**
   * 问题 5：设置需求级执行状态（确认完成 / 取消完成）。
   *
   * 「已完成」页的「取消完成」与「还原到需求池」的前置门禁都走这里 —— 完成与撤销是两个
   * 显式动作，不提供"一步跨过"的捷径。
   */
  async setRequirementExecState(input: SetRequirementExecStateInput): Promise<RequirementExecStateResult> {
    try {
      return await postJson<RequirementExecStateResult>(TFS_ROUTES.requirementExecState, input)
    } catch {
      return { ok: false, reason: '无法连接到宿主看板服务（需求执行状态）' }
    }
  }

  async assignTask(taskId: string, roleName: string): Promise<TaskOpResult> {
    try {
      return await postJson<TaskOpResult>(TFS_ROUTES.taskAssign, { taskId, roleName })
    } catch {
      return { ok: false, reason: '无法连接到宿主任务服务' }
    }
  }

  async setTaskState(taskId: string, action: TaskAction, expectedRevision?: number): Promise<TaskOpResult> {
    try {
      return await postJson<TaskOpResult>(TFS_ROUTES.taskState, { taskId, action, expectedRevision })
    } catch {
      return { ok: false, reason: '无法连接到宿主任务服务' }
    }
  }

  /** spec 006 US2：读取某次任务执行的过程轨迹（技能/MCP/工具调用时间线）。 */
  async getTaskTrace(taskId: string, attemptIndex?: number): Promise<TaskTraceResult> {
    try {
      const qs = new URLSearchParams({ taskId })
      if (attemptIndex !== undefined) qs.set('attempt', String(attemptIndex))
      const res = await fetch(`${TFS_ROUTES.taskTrace}?${qs.toString()}`, { method: 'GET', cache: 'no-store' })
      if (!res.ok) {
        return { ok: false, taskId, attempt: attemptIndex ?? -1, available: false, entries: [], reason: `轨迹路由返回 ${res.status}` }
      }
      return (await res.json()) as TaskTraceResult
    } catch {
      return {
        ok: false,
        taskId,
        attempt: attemptIndex ?? -1,
        available: false,
        entries: [],
        reason: '无法连接到宿主任务轨迹服务（请确认插件已在 profile 启用并重启界面）',
      }
    }
  }

  /** spec 006 US3：对任务追问 / 补充指令（同角色同配置起新一轮执行）。 */
  async followUpTask(input: FollowUpTaskInput): Promise<FollowUpTaskResult> {
    try {
      return await postJson<FollowUpTaskResult>(TFS_ROUTES.taskFollowUp, input)
    } catch {
      return { ok: false, reason: '无法连接到宿主任务服务（追问失败）' }
    }
  }

  /**
   * 问题 4：需求完成自动回写（评审/自测字段、结论评论、产物附件、关联任务收口）。
   * POST 触发 / 强制重跑；逐项结果在 `report` 中。成功后让共享看板 store 立即失效刷新。
   */
  async writeBackRequirement(
    input: { requirementKey: string; force?: boolean },
  ): Promise<{ ok: boolean; reason?: string; report?: import('../shared/contracts.js').RequirementWriteBackReport }> {
    try {
      const res = await postJson<{
        ok: boolean
        reason?: string
        report?: import('../shared/contracts.js').RequirementWriteBackReport
      }>(TFS_ROUTES.requirementWriteBack, input)
      if (res.ok) boardStore.invalidate()
      return res
    } catch {
      return { ok: false, reason: '无法连接到宿主回写服务（请确认插件已在 profile 启用并重启界面）' }
    }
  }

  /**
   * spec 010：确保需求有编排主 agent 会话（幂等；失败给可读降级原因）。
   * 成功后让共享看板 store 失效，任务中心下一次刷新即可看到会话 id 并接上对话框。
   */
  async orchestratorEnsure(requirementKey: string, force?: boolean): Promise<OrchestratorEnsureResult> {
    try {
      const res = await postJson<OrchestratorEnsureResult>(TFS_ROUTES.orchestratorEnsure, {
        requirementKey,
        ...(force === true ? { force: true } : {}),
      })
      if (res.ok) boardStore.invalidate()
      return res
    } catch {
      return { ok: false, reason: '无法连接到宿主编排服务（请确认插件已在 profile 启用并重启界面）' }
    }
  }

  async healthCheck(): Promise<HealthResult> {
    try {
      const res = await fetch(TFS_ROUTES.health, { method: 'GET', cache: 'no-store' })
      if (!res.ok) return { ok: false, kind: 'unknown', reason: `自检路由返回 ${res.status}` }
      return (await res.json()) as HealthResult
    } catch {
      return { ok: false, kind: 'unknown', reason: '无法连接到宿主自检服务' }
    }
  }

  // ── T063 审计归档 ──

  async getAudit(): Promise<AuditView> {
    try {
      const res = await fetch(TFS_ROUTES.audit, { method: 'GET', cache: 'no-store' })
      if (!res.ok) {
        return {
          ok: false,
          total: 0,
          expired: 0,
          retentionDays: 0,
          archiveFiles: [],
          reason: `审计路由返回 ${res.status}`,
        }
      }
      return (await res.json()) as AuditView
    } catch {
      return {
        ok: false,
        total: 0,
        expired: 0,
        retentionDays: 0,
        archiveFiles: [],
        reason: '无法连接到宿主审计服务',
      }
    }
  }

  async archiveAudit(): Promise<ArchiveResult> {
    try {
      return await postJson<ArchiveResult>(TFS_ROUTES.auditArchive, {})
    } catch {
      return { ok: false, reason: '无法连接到宿主审计服务' }
    }
  }

  // ── T030 集合切换 ──

  async setCollection(collection: string): Promise<{ ok: boolean; reason?: string; collection?: string }> {
    try {
      return await postJson<{ ok: boolean; reason?: string; collection?: string }>(TFS_ROUTES.collection, {
        collection,
      })
    } catch {
      return { ok: false, reason: '无法连接到宿主集合服务' }
    }
  }

  // ── T031 连接档案 / T028b MCP 接入 ──

  async listProfiles(): Promise<ProfileListResult> {
    try {
      const res = await fetch(TFS_ROUTES.profiles, { method: 'GET', cache: 'no-store' })
      if (!res.ok) return { ok: false, profiles: [], reason: `档案路由返回 ${res.status}` }
      return (await res.json()) as ProfileListResult
    } catch {
      return { ok: false, profiles: [], reason: '无法连接到宿主档案服务' }
    }
  }

  async saveProfile(input: ProfileSaveInput): Promise<ProfileOpResult> {
    try {
      return await postJson<ProfileOpResult>(TFS_ROUTES.profileSave, input)
    } catch {
      return { ok: false, reason: '无法连接到宿主档案服务' }
    }
  }

  async deleteProfile(id: string): Promise<ProfileOpResult> {
    try {
      return await postJson<ProfileOpResult>(TFS_ROUTES.profileDelete, { id })
    } catch {
      return { ok: false, reason: '无法连接到宿主档案服务' }
    }
  }

  async activateProfile(id: string): Promise<ProfileOpResult> {
    try {
      return await postJson<ProfileOpResult>(TFS_ROUTES.profileActivate, { id })
    } catch {
      return { ok: false, reason: '无法连接到宿主档案服务' }
    }
  }

  async getMcpSetup(_profileId?: string): Promise<McpSetup> {
    try {
      const res = await fetch(TFS_ROUTES.mcpInstance, { method: 'GET', cache: 'no-store' })
      if (!res.ok) throw new Error(`返回 ${res.status}`)
      return (await res.json()) as McpSetup
    } catch {
      // 路由不可用时给出"为什么不可用"的最小结构，避免面板崩掉（能力降级可见）。
      const serverName = ''
      return {
        ok: false,
        instance: {
          serverName,
          serverNameValid: false,
          toolPrefix: '',
          runtimeAddSupported: false,
          runtimeAddReason: '无法连接到宿主的连接诊断服务（插件未启用或无 web 服务）',
          serverNameConstraint: '不适用（REST 直连）',
          duplicateRisk: '未知（诊断不可用）',
          credentialPath: '未知（诊断不可用）',
        },
        template: {
          ok: false,
          serverName,
          serverNameValid: false,
          envFilePath: '',
          posixLines: [],
          powershellLines: [],
          note: '诊断不可用，无法生成凭据导出模板',
        },
      }
    }
  }

  async writeMcpEnvFile(profileId?: string): Promise<EnvFileResult> {
    try {
      return await postJson<EnvFileResult>(TFS_ROUTES.mcpEnvFile, { ...(profileId ? { profileId } : {}) })
    } catch {
      return { ok: false, reason: '无法连接到宿主连接诊断服务' }
    }
  }

  /** 能力目录：`tfs_req_*` 工具 ⇄ REST 操作键，含"端点是否已接入"的缺口标注。 */
  async getTfsToolCatalog(): Promise<TfsToolCatalogView> {
    try {
      const res = await fetch(TFS_ROUTES.tfsTools, { method: 'GET', cache: 'no-store' })
      if (!res.ok) throw new Error(`返回 ${res.status}`)
      return (await res.json()) as TfsToolCatalogView
    } catch {
      return {
        ok: false,
        rawCount: 0,
        wrappedCount: 0,
        tools: [],
        missingCount: 0,
        reason: '无法连接到宿主工具目录服务（请确认插件已在 profile 启用并重启界面）',
      }
    }
  }
}

/** 看板不可用时的降级快照（区别于"空看板"：ok=false 让 UI 显式提示而不是静默显示 0）。 */
function boardUnavailable(reason: string): BoardSnapshotView {
  return {
    ok: false,
    reason,
    version: 0,
    updatedAt: '',
    requirements: [],
    tasks: [],
    counts: { pending: 0, inProgress: 0, completed: 0, running: 0, queued: 0 },
  }
}

// 真实桥单例（客户端半所有动作经 fetch 转发到宿主半路由）。
const bridge: HostBridge = new HttpHostBridge()

/**
 * 模块级共享看板 store（问题 1/6/7）。
 *
 * 中央 Workbench 与右栏 SidePanel 即便同时挂载，也共用这一份快照、一条自适应轮询链：
 * 单飞合并并发 getBoard、运行中 3s/待确认 5s/全空闲停拍、动作后立即失效刷新。
 * DAG 推进由宿主收口钩子负责（问题 6），前端轮询只用于展示，故全空闲可安全停拍。
 */
export const boardStore = new BoardStore(() => bridge.getBoard())

/**
 * 旧 / 精简宿主（无 main 槽）上，连接 footer.action 入口与 shell.overlay 面板的
 * 开关控制器单例（见 shared/panel-open-control.ts）。
 */
export const panelOpen = new PanelOpenControl()

type TabKey = 'pool' | 'tasks' | 'exec' | 'roles' | 'diag'

/**
 * TFS 工作台：单浮层容器，内含 需求池 / 任务中心 / 执行配置 / 角色管理 / 连接诊断 五个标签页。
 *
 * 端到端链路（真实接线，非占位）：
 *   需求池「按 ID 领取」→ BoardService.claimRequirement（入本地池 + 打 dsh 标签）
 *   → 任务中心「拆解为任务」→ decomposeRequirement（五段式 DAG：分析→架构师拆解→开发→代码审核→测试）
 *   → 「启动/完成/重试/取消」→ setTaskState（四态 + 乐观锁）
 *   → 需求池/任务中心「选为目标」→ 执行配置的目标变为 `id@collection`
 *   → 执行配置「确认回写」→ confirmWrite（过 WriteGuard 四道门禁，直连 REST 写 TFS）
 */
function Workbench(props: {
  onClose?: () => void
  chatKit?: ChatSlotKit
  /** spec 010：客户端上下文（主对话框在**调用时**解析 sessions / sidebarRight）。 */
  ctx: ClientContext
}): JSX.Element {
  // 面板现在注册在 `main` 槽（key = `PANEL_ID`），由左侧「TFS 看板」菜单行切换。
  //
  // 宿主**只为当前选中的面板挂载组件**（`MainPanel` 按 `activePanelId` 派发，见上），
  // 所以这里不再需要"是否打开"的本地状态——被挂载即显示，卸载即隐藏。
  //
  // 这同时彻底修掉了用户反馈 1（打开 dsh 就弹框盖住应用）：`shell.overlay` 是
  // `kind:'list'` 的**常驻**浮层，宿主会一直渲染其中每个 entry，把全屏面板放进去必然一开机就盖屏。
  // 现在常驻层里本插件什么都没有，全屏形态只存在于 `main` 槽且由用户点选才出现。
  const [tab, setTabState] = useState<TabKey>('pool')
  const [data, setData] = useState<ExecutionPanelData | null>(null)
  // 问题 1/6/7：看板快照改为订阅模块级共享 store（单飞去重 + 自适应轮询 + 中央/右栏实时同步）。
  const board = useBoardStore(boardStore)
  const [health, setHealth] = useState<HealthResult | null>(null)
  const [target, setTarget] = useState<RequirementSummary | null>(null)
  /**
   * 「选为目标」填充序号（spec 008 US4）：每次显式点击 chooseTarget 自增。
   *
   * 纯客户端会话态：随 execData 注入给执行面板，触发其把标题/描述/执行 Prompt 重新填入表单。
   * 不能用"目标键"去重——同一需求第二次选为目标（如发起执行清空表单后想恢复正文）
   * 目标键不变，旧实现因此静默跳过填充。轮询刷新不产生新序号，不会顶掉手工编辑。
   */
  const [targetFillNonce, setTargetFillNonce] = useState(0)
  const [error, setError] = useState<string | null>(null)
  // 「连接与凭据」页数据（T063/T031/T028b）。纯本地读取，随页签打开拉取。
  const [audit, setAudit] = useState<AuditView | null>(null)
  const [profiles, setProfiles] = useState<ProfileListResult | null>(null)
  const [mcp, setMcp] = useState<McpSetup | null>(null)
  // 能力目录（tfs_req_* 工具 ⇄ REST 操作键 + 端点接入缺口）。
  const [toolCatalog, setToolCatalog] = useState<TfsToolCatalogView | null>(null)
  /**
   * 问题 6：批量派发已改为"只启动首批 + 宿主自动链式"，不再有前端轮询进度，
   * 故进度文案恒为 null（结果摘要在批量动作的返回 reason 中即时展示）。保留 props 形状，
   * 避免 TaskCenter 签名改动。
   */
  const [batchProgress] = useState<string | null>(null)

  /**
   * 问题 3：Tab 保活——每个 Tab 首次访问后**挂载一次、之后只隐藏不卸载**
   * （容器 `display:none`），切回时保留筛选、分页、已拉列表与表单状态，不重新请求数据。
   */
  const [visited, setVisited] = useState<Record<TabKey, boolean>>({
    pool: true,
    tasks: false,
    exec: false,
    roles: false,
    diag: false,
  })
  const setTab = useCallback((next: TabKey): void => {
    setTabState(next)
    setVisited(prev => (prev[next] ? prev : { ...prev, [next]: true }))
  }, [])

  /**
   * 面板数据的**唯一落地口**（2026-10-06 修复）。
   *
   * 桥方法一律降级返回、从不 reject，所以"宿主不可达"只能靠兜底数据带出的告警识别。
   * 这条信息改由面板顶部横幅独占展示：从 catalogWarnings 里摘掉，避免与页签内的
   * 能力目录告警区重复显示同一条。
   *
   * ⚠️ 必须**所有**取到面板数据的路径都过这里（此前只有首屏 `reload()` 走，
   * 手动重采与后台续采都直接 `setData`）：于是运行期宿主失联时（面板打开时还是好的），
   * 「宿主不可达」只会静静躺在 `data.catalogWarnings` 里 —— 而那个字段只在
   * 「执行配置 / 角色管理」页渲染，停留在需求池 / 任务中心的用户**完全看不到任何提示**。
   */
  const applyPanelData = useCallback((d: ExecutionPanelData): void => {
    const unreachable = (d.catalogWarnings ?? []).find(w => w.startsWith(HOST_UNREACHABLE))
    setData(unreachable
      ? { ...d, catalogWarnings: (d.catalogWarnings ?? []).filter(w => w !== unreachable) }
      : d)
    setError(unreachable ?? null)
  }, [])

  const reload = useCallback((): void => {
    bridge
      .getPanelData()
      .then(applyPanelData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [applyPanelData])

  /**
   * 重新拉取看板快照（问题 5/10：领取/拆解/还原/删除/状态动作后 await 本函数，
   * 保证任务中心与需求池行内标记实时同步）。
   *
   * 走共享 store 的**单飞** refresh：与自适应轮询、其他动作共享同一个在途 getBoard，
   * 不会因为"轮询正好在跑 + 动作后又拉一次"而发出重复请求（问题 1）。
   */
  const reloadBoard = useCallback(async (): Promise<void> => {
    try {
      await boardStore.refresh()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }, [])

  /**
   * 强制重采 DSH 能力目录（问题 1/2）。
   *
   * 这是"用户先打开插件、后装技能 / 加 MCP / 加模型"场景的唯一自救入口。
   * 走 `POST /catalog-refresh`（宿主 `api.refreshPanelData`）→ 重采后再取面板数据。
   */
  const refreshCatalog = useCallback(async (): Promise<void> => {
    const next = await bridge.refreshPanelData()
    applyPanelData(next)
  }, [])

  /**
   * 问题 1/2：进入「执行配置」「角色管理」时自动重采能力目录。
   *
   * 之前只有右侧栏的 TFS 执行页会重采（`SidePanel.tsx`），中央工作台**从不**重采 ——
   * 于是这两个页签的下拉永远是"首次采集那一刻"的结果，用户新装的技能/MCP 看不到。
   * 这里挂在 **Tab 激活**上（而不是挂载时一次）：与 003 的 Tab 保活机制一致，
   * 既覆盖"每次要看下拉时都拿最新的"，又不会周期性打 provider 接口。
   *
   * 5 秒节流：`catalog.refresh()` 内部已做 inflight 去重，但连续点两个页签仍会真实重采两轮
   * （第一轮已结束），而 `listModels()` 会逐 provider 发请求 —— 用户手速不该变成负载。
   */
  const lastCatalogRefreshRef = useRef(0)
  useEffect(() => {
    if (tab !== 'exec' && tab !== 'roles') return
    if (Date.now() - lastCatalogRefreshRef.current < 5000) return
    lastCatalogRefreshRef.current = Date.now()
    void bridge.refreshPanelData().then(applyPanelData).catch(() => {
      // 重采失败保留上一份数据（refreshPanelData 内部已回退到 getPanelData）。
    })
  }, [tab, applyPanelData])

  /**
   * 问题 1/2：已访问过「执行配置 / 角色管理」后，按宿主下发的轮询间隔**后台续采**能力目录。
   *
   * 为什么还需要它（不是画蛇添足）：用户级技能挂在 agent preset 的**standing mount** 上，
   * 而那个挂载是"某个会话按该预设启动"时才建立的（`dsh-agent-presets` 的 `ensureStanding`）。
   * 用户完全可能是"先开面板、后开会话"，此时一次性重采仍然只拿到全局层；
   * 按需间隔再采一次就能自动补齐，无需用户记得点按钮。间隔取 `pollIntervalMinutes`（默认 5 分钟），
   * 与需求池的轮询同一节奏，一次采集的成本是 `listModels() × provider + list(skills)` 的量级。
   */
  const catalogPolling = visited.exec || visited.roles
  const catalogIntervalMinutes = data?.pollIntervalMinutes ?? 5
  useEffect(() => {
    if (!catalogPolling) return
    const id = setInterval(
      () => {
        void bridge.refreshPanelData().then(applyPanelData).catch(() => {})
      },
      Math.max(1, catalogIntervalMinutes) * 60 * 1000,
    )
    return () => clearInterval(id)
  }, [catalogPolling, catalogIntervalMinutes, applyPanelData])

  /**
   * 选为目标（问题 11）：先经宿主实时重取工作项四段正文（详细信息/需求分析/数据结构/需求配置）
   * 并回写看板，再刷新快照、设置目标、跳到执行配置页。重取失败时降级用列表项自带字段，不阻断。
   */
  const chooseTarget = useCallback(
    async (item: RequirementSummary): Promise<void> => {
      const key = `${item.id}@${item.collection}`
      let enriched = item
      try {
        const r = await bridge.enrichRequirement(key)
        if (r.ok && r.requirement) enriched = r.requirement
      } catch {
        // 降级：列表项已带 description；三段 Winning 缺失时执行面板会显示空段提示。
      }
      await reloadBoard()
      setTarget(enriched)
      // 每次显式点击都产生新序号（包括对同一需求的第二次点击、enrich 降级路径）：
      // 执行面板据 nonce 重新带入标题/描述/执行 Prompt。
      setTargetFillNonce(n => n + 1)
      setTab('exec')
    },
    [reloadBoard, setTab],
  )

  /**
   * 派发一个看板任务（单行「派发执行」与批量派发共用）。
   *
   * prompt 交给宿主组装（`api.dispatch` 会拼「工作目录 → 需求提示词 → 任务提示词 → 标题/描述」），
   * 这里只传任务自己的提示词：客户端拼 prompt 会把"需求提示词实时生效"这条语义丢掉。
   */
  const dispatchBoardTask = useCallback(
    async (t: BoardTaskView): Promise<{ ok: boolean; reason?: string }> => {
      const role = data?.roles.find(r => r.name === t.roleAgent)
      return bridge.dispatch(
        {
          roleName: t.roleAgent,
          prompt: t.prompt ?? '',
          frozenConfig: t.frozenConfig,
          permission: role?.defaultPermission ?? 'read-only',
          ...(t.workspace ? { workspace: t.workspace } : {}),
        },
        t.taskId,
        // 目标 = 任务所属需求（`t.requirementId`，形如 `1997179@WN_HIS`）；
        // **不能**直接用 `t.taskId`（`…#analyze`），否则集合会被切成 `WN_HIS#analyze`。
        targetRefFromKey(t.requirementId || t.taskId, data?.collection ?? ''),
      )
    },
    [data],
  )

  /**
   * 问题 5/6/1：勾选批量派发 —— 只负责把**当前就绪的首批**任务派出去，后续波次交给宿主自动链式。
   *
   * ## 为什么不再在前端轮询驱动 DAG
   *
   * 旧实现用 `setInterval(1.5s) × 最多 400 轮` 全量 getBoard 来"等上游完成 → 派下游"：
   *   - 页面关闭 / 切走即停，任务链断在半路；
   *   - 每拍一次全量看板请求，是无意义的请求风暴（问题 1）；
   *   - 与宿主收口逻辑各跑一套，容易重复派发。
   *
   * 现在 DAG 推进下沉到宿主：每条任务收口（成功）时，收口钩子调用 `Board.autoStartRunnable`
   * 自动启动所有"依赖已完成、并发槽有空"的就绪任务（问题 6），与页面是否打开无关。
   * 因此前端批量派发只需：取一次最新快照 → 用纯逻辑 `planBatchStep` 算出"现在能派谁"
   * → 派发就绪首批（≤ 并发上限）→ 动作后失效刷新；其余任务在 skipped 里标注"将自动执行"。
   *
   * @param ids - 勾选的任务 id。
   * @returns 首批分波明细与自动排队 / 未能派发的可读原因。
   */
  const dispatchBatch = useCallback(
    async (ids: string[]): Promise<DispatchBatchResult> => {
      const waves: DispatchBatchWave[] = []
      const skipped: Array<{ taskId: string; reason: string }> = []
      if (ids.length === 0) {
        return { ok: false, dispatched: 0, skipped, waves, reason: '未选择任何任务' }
      }
      const limit = Math.max(1, data?.dispatchConcurrency ?? 3)

      let snap: BoardSnapshotView
      try {
        // 单飞取最新快照（若自适应轮询恰好在跑，复用同一个在途 Promise）。
        snap = await boardStore.refresh()
      } catch (e) {
        return {
          ok: false,
          dispatched: 0,
          skipped: ids.map(taskId => ({ taskId, reason: '读取看板快照失败' })),
          waves,
          reason: `读取看板快照失败：${e instanceof Error ? e.message : String(e)}`,
        }
      }
      if (!snap.ok) {
        return {
          ok: false,
          dispatched: 0,
          skipped: ids.map(taskId => ({ taskId, reason: '看板不可用' })),
          waves,
          reason: `看板不可用：${snap.reason ?? '未知原因'}`,
        }
      }

      const step = planBatchStep(snap.tasks as BatchTaskLike[], ids)

      // 1) 已完成：计入 dispatched（口径与旧实现一致，= 本次范围内已收口数）。
      const doneIds = step.done
      // 2) 结构性卡住（依赖失败/取消/被删）：出队并给出可读原因。
      for (const s of step.stuck) skipped.push(s)

      // 3) 派发当前就绪的首批（≤ 并发上限）；超出上限与"在等上游"的任务交宿主自动链式。
      const wave = step.ready.slice(0, limit)
      const failures: Array<{ taskId: string; reason: string }> = []
      const okIds: string[] = []
      for (const id of wave) {
        const t = snap.tasks.find(x => x.taskId === id)
        if (!t) {
          failures.push({ taskId: id, reason: '任务不存在（可能已被删除）' })
          continue
        }
        const r = await dispatchBoardTask(t)
        if (r.ok) okIds.push(id)
        else failures.push({ taskId: id, reason: r.reason ?? '派发失败' })
      }
      if (okIds.length > 0 || failures.length > 0) waves.push({ taskIds: okIds, failures })

      // 4) 其余勾选任务（等待依赖 / 就绪但超出本波并发）：宿主会在每条任务收口后自动拉起，
      //    无需用户逐个点击；这里如实标注，而非在前端空转轮询。
      const accounted = new Set<string>([
        ...doneIds,
        ...skipped.map(s => s.taskId),
        ...okIds,
        ...failures.map(f => f.taskId),
      ])
      for (const id of ids) {
        if (accounted.has(id)) continue
        skipped.push({ taskId: id, reason: '已排队：上游任务完成后将自动执行（无需逐个点击）' })
      }

      // 动作后立即失效刷新，让任务中心/右栏马上看到首批进入运行态。
      boardStore.invalidate()

      const dispatched = doneIds.length
      if (failures.length === 0) {
        const queued = skipped.filter(s => s.reason.startsWith('已排队')).length
        return {
          ok: true,
          dispatched,
          skipped,
          waves,
          reason:
            `已启动首批 ${okIds.length} 个任务` +
            (queued > 0 ? `，其余 ${queued} 个将在上游完成后自动执行` : '') +
            (dispatched > 0 ? `；已完成 ${dispatched} 个` : ''),
        }
      }
      return {
        ok: false,
        dispatched,
        skipped,
        waves,
        reason: `首批有 ${failures.length} 个任务派发失败（可单独点「重试」）；其余任务将在依赖满足后自动执行`,
      }
    },
    [data, dispatchBoardTask],
  )

  useEffect(() => {
    // 问题 1：本面板挂载时（如从任务看板/SSH 首次切过来），驱逐 DOM 接管型面板，
    // 否则宿主 MainPanel（本面板）会被它们的
    // `[data-dsh-*-active] [class*='centerCol'] > :not([data-dsh-*-view]){display:none!important}`
    // 永久隐藏。Workbench 已挂载但被隐藏时再点本行不会 remount，那条路径由行点击监听覆盖。
    evictTakeoverPanels()
    reload()
    // 看板首拉与周期刷新由 useBoardStore(boardStore) 的 activate 负责（单飞、自适应节拍），
    // 这里不再单独拉一次，避免与 store 首拍并发重复请求（问题 1）。
  }, [reload])

  // 「连接与凭据」页数据：**首次进入该 Tab 时拉取一次**（问题 3：之后切走再切回不重新加载）。
  // 读本地文件/配置，不触碰 TFS，故无配额顾虑；页内各区块另有手动刷新按钮。
  const diagVisited = visited.diag
  useEffect(() => {
    if (!diagVisited) return
    void bridge.getAudit().then(setAudit)
    void bridge.listProfiles().then(setProfiles)
    void bridge.getMcpSetup().then(setMcp)
    void bridge.getTfsToolCatalog().then(setToolCatalog)
  }, [diagVisited])

  // spec 009 问题2 / 问题 7：切入「任务中心」时让共享 store 立即失效重拉一次。
  // 全空闲时 store 已停止周期轮询，这里的 invalidate 保证用户切入瞬间看到最新任务与角标计数；
  // 运行期则复用在途单飞，不会产生重复请求。
  useEffect(() => {
    if (tab !== 'tasks') return
    boardStore.invalidate()
  }, [tab])

  // 问题 2：Esc 关闭面板（与「关闭」按钮同一收口路径）。
  //
  // 关闭 = 回到会话：`layout.selectPanel(null)` 是宿主"返回 Conversation"的官方入口
  // （`packages/client/ui-layout/src/client/service.ts:67-74`：传 null 即回到会话）。
  //
  // 三重让路，缺一不可：
  // ① 事件冒泡到 window 说明没有任何内层弹框消费它 —— 内层**没有**自己的 Esc 处理，
  //    所以一旦这里收下，整块面板会被卸载，五个页签的筛选/分页/表单状态全部丢失；
  // ② 焦点在输入控件里时，Esc 的常见语义是"收起输入法/清空建议"，不是"离开页面"；
  // ③ contenteditable 同理（自定义文案框）。
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return
      const el = e.target as HTMLElement | null
      if (el) {
        const tag = el.tagName
        if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable) return
      }
      props.onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [props.onClose])

  const actions = (): ExecutionActions => ({
    // 目标由**执行面板正在渲染的那份数据**显式带下来（`ExecutionPanel` 内部构造），
    // 不再由桥从宿主快照里猜（那份快照里的 targetWorkItem 恒是占位符 '—'）。
    confirmWrite: (ops, target) => bridge.confirmWrite(ops, target),
    // spec 009 问题2：执行配置页「发起执行」成功后立即刷新看板快照——
    // 宿主在该动作里新建看板任务并异步派发，不刷新则任务中心（含 Tab 角标计数）要手动刷新才看得到。
    dispatch: async (req, taskId, target) => {
      const res = await bridge.dispatch(req, taskId, target)
      if (res.ok) await reloadBoard()
      return res
    },
    // 注：原 `parse: bridge.parse` 已移除——桥上从未实现该方法，传下去的恒是 undefined，
    // 「AI 解析」按钮因此长期恒定禁用。详见 `shared/contracts.ts` 的移除说明。
    // 问题 1/2：执行配置页的「重新采集目录」。
    refreshCatalog,
  })

  const tabButton = (key: TabKey, label: string): JSX.Element => (
    <button
      key={key}
      type="button"
      aria-current={tab === key ? 'page' : undefined}
      onClick={() => setTab(key)}
      style={{
        padding: '8px 14px',
        border: 'none',
        borderBottom: tab === key ? '2px solid #2563eb' : '2px solid transparent',
        background: 'transparent',
        color: tab === key ? '#2563eb' : '#6b7280',
        cursor: 'pointer',
        fontSize: 14,
        fontWeight: tab === key ? 600 : 400,
      }}
    >
      {label}
    </button>
  )

  /**
   * 「连接与凭据」页（T029 自检 + T063 审计归档 + T031 档案 + 连接诊断）。
   *
   * 自检仍保持"点击才发起"（不在挂载时就打 TFS）；审计状态与连接诊断为**纯本地读取**
   * （读 audit.jsonl / 读档案），故随页签切换自动拉取即可，不会给 TFS 造成压力。
   */
  const diagBody = (): JSX.Element => (
    <ConnectionPanel
      health={health}
      onHealthCheck={() => {
        setHealth(null)
        void bridge.healthCheck().then(setHealth)
      }}
      audit={audit}
      onAuditRefresh={() => void bridge.getAudit().then(setAudit)}
      onArchive={() => bridge.archiveAudit()}
      profiles={profiles}
      onProfilesRefresh={() => void bridge.listProfiles().then(setProfiles)}
      onSaveProfile={input => bridge.saveProfile(input)}
      onDeleteProfile={id => bridge.deleteProfile(id)}
      onActivateProfile={async id => {
        const res = await bridge.activateProfile(id)
        if (res.ok) reload()
        return res
      }}
      mcp={mcp}
      onMcpRefresh={() => void bridge.getMcpSetup().then(setMcp)}
      onWriteEnvFile={() => bridge.writeMcpEnvFile()}
      toolCatalog={toolCatalog}
      onToolCatalogRefresh={() => void bridge.getTfsToolCatalog().then(setToolCatalog)}
    />
  )

  /**
   * 问题 3：五个 Tab 的面板节点。
   *
   * 关键：**首次访问即挂载，之后只通过外层容器 `display:none` 隐藏、永不卸载**——
   * React 保留组件 state（筛选/分页/已拉列表/表单），切 Tab 不触发任何重新加载。
   * 每个面板外层是 `flex:1 + overflow:auto` 的滚动容器（隐藏时 display:none）。
   */
  const panelWrap = (key: TabKey, node: JSX.Element): JSX.Element => (
    <div
      key={key}
      style={{
        flex: 1,
        minHeight: 0,
        overflow: 'auto',
        display: tab === key ? 'block' : 'none',
      }}
      aria-hidden={tab !== key}
    >
      {node}
    </div>
  )

  const poolPanel = panelWrap(
    'pool',
    <RequirementPool
      collection={data?.collection ?? ''}
      collections={data?.collections ?? []}
      onCollectionChange={async c => {
        const res = await bridge.setCollection(c)
        if (res.ok) {
          reload()
          void reloadBoard()
        }
        return res
      }}
      listRequirements={f => bridge.listRequirements(f)}
      getQueryOptions={() => bridge.getQueryOptions()}
      // 问题 1：读盘优先 + 「采集可选项」强制重采落盘。
      loadQueryOptions={col => bridge.loadQueryOptions(col)}
      onCollectQueryOptions={col => bridge.collectQueryOptions(col)}
      // 问题 2/4：筛选记忆与每页条数。
      loadUiState={col => bridge.loadUiState(col)}
      saveUiState={(patch, col) => bridge.saveUiState(patch, col)}
      claimRequirement={input => bridge.claimRequirement(input)}
      // 问题 6：领取弹框里选工作目录（来自 dsh 真实工作区清单）+ 填需求级提示词。
      workspaces={data?.workspaces ?? []}
      // 标题直达 TFS 需求页的兜底地址（首选数据源仍是工作项自带的 REST url）。
      tfsBaseUrl={data?.tfsBaseUrl}
      // 问题 5：领取成功 → await 刷新看板快照（任务中心因保活常驻，立即看到新需求）。
      onClaimed={() => void reloadBoard()}
      // 已入池需求清单：来自本地池快照，不额外增加任何 TFS 读取。
      claimedRequirements={board?.requirements ?? []}
      onSelect={item => void chooseTarget(item)}
      // FR-024：轮询间隔由宿主配置下发（此前需求池写死 5 分钟，配置项形同虚设）。
      pollIntervalMinutes={data?.pollIntervalMinutes}
    />,
  )

  /**
   * spec 010：任务中心改**左右分栏** —— 左任务表 + 右「主对话框」。
   *
   * 为什么对话框在这里而不是 TaskCenter 内部：`SessionProvider` / `renderSlot` 由**父槽位条目**
   * （就是本组件所属的 `main` 条目）持有，TaskCenter 拿不到；因此由这里包裹，
   * 组件之间的数据经模块级 store 传递（见 `OrchestratorChat.tsx`）。
   * 对话框自身在「已完成」子 Tab / 未选择需求时返回 null，不影响原有布局。
   */
  const tasksPanel = visited.tasks
    ? panelWrap(
        'tasks',
        data ? (
            <div style={{ display: 'flex', gap: 12, alignItems: 'stretch', minHeight: 0, height: '100%' }}>
            {/* spec 010：左右分栏后，任务列表与主对话框必须各自独立滚动，
                否则二者共用 panelWrap 的滚动条（任务一多整个面板一起滚，主对话框也被带着走）。
                左列（任务列表）自己 overflowY:auto；右列（主对话框）靠 dock 内部 overflow:hidden
                + flex:1 让宿主会话体独立滚动。整行高度锁死为面板高度，避免溢出到 panelWrap。 */}
            <div style={{ flex: 1, minWidth: 0, minHeight: 0, overflowY: 'auto' }}>
          <TaskCenter
            snapshot={board}
            roles={data.roles}
            collection={data.collection}
            onRefresh={reloadBoard}
            onDecompose={async id => {
              const r = await bridge.decomposeRequirement(id)
              // spec 008 US3：匹配不到角色时宿主会自动创建并落 roles.json，
              // 刷新面板数据让角色下拉/筛选立即包含新角色（不必等 5 分钟轮询或重启）。
              if (r.ok && r.createdRoles && r.createdRoles.length > 0) reload()
              return r
            }}
            // 问题 7/8：还原需求池、删除已取消任务。
            onRestore={key => bridge.restoreRequirement(key)}
            onDeleteTasks={ids => bridge.deleteTasks(ids)}
            // 问题 5：已完成需求先「取消完成」，之后才能还原到需求池。
            onSetRequirementExecState={input => bridge.setRequirementExecState(input)}
            onWriteBackRequirement={key => bridge.writeBackRequirement({ requirementKey: key, force: true })}
            // 问题 6：每页条数记忆。
            loadUiState={col => bridge.loadUiState(col)}
            saveUiState={(patch, col) => bridge.saveUiState(patch, col)}
            onAssign={(taskId, roleName) => bridge.assignTask(taskId, roleName)}
            onTaskState={(taskId, action, rev) => bridge.setTaskState(taskId, action, rev)}
            // spec 006 US2/US3：任务执行详情（轨迹时间线 + 失败原因）与二次对话追问。
            onGetTaskTrace={(taskId, attempt) => bridge.getTaskTrace(taskId, attempt)}
            onFollowUpTask={async input => {
              const res = await bridge.followUpTask(input)
              await reloadBoard()
              return res
            }}
            // 问题 3/4/5：需求编辑 / 任务编辑 / 勾选批量派发（+ 下拉数据源）。
            onUpdateRequirement={(key, patch) => bridge.updateRequirement({ requirementKey: key, ...patch })}
            onUpdateTask={input => bridge.updateTask(input)}
            onDispatchBatch={dispatchBatch}
            batchProgress={batchProgress}
            // D7：把编排能力现算结果（含无顶层会话判断）传入，批量/单任务派发按钮据此前置禁用。
            orchestration={data.orchestration}
            workspaces={data.workspaces}
            modelOptions={data.modelOptions}
            skillOptions={data.skillOptions}
            mcpServers={data.mcpServers}
            // 问题 3：任务编辑弹框的预设下拉数据源。
            presets={data.presets}
            // 标题/需求列直达 TFS 需求页的兜底地址。
            tfsBaseUrl={data.tfsBaseUrl}
            onDispatchTask={async t => {
              // 派发看板任务：prompt 交给宿主组装（工作目录 → 需求提示词 → 任务提示词），
              // 冻结配置取自任务快照（问题 4 的编辑入口写的就是这份）。
              const res = await dispatchBoardTask(t)
              await reloadBoard()
              return res
            }}
            onSelectRequirement={item => void chooseTarget(item)}
          />
            </div>
            {/* spec 010：右侧主对话框（宿主真实会话；不支持时给出可读降级提示）。 */}
            {props.chatKit && (
              <OrchestratorChatDock
                kit={props.chatKit}
                ctx={props.ctx}
                onEnsureOrchestrator={key => bridge.orchestratorEnsure(key, true)}
              />
            )}
          </div>
        ) : (
          <div style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>加载面板数据中…</div>
        ),
      )
    : null

  const execPanel = visited.exec
    ? panelWrap(
        'exec',
        data ? (
          (() => {
            // 选中需求时，执行面板的目标改为该需求的 dedupKey（`id@collection`）。
            //
            // US3 / 问题 11：目标摘要带四段正文（chooseTarget 已先 enrich 重取），
            // buildTargetFill 在共享层拼成【详细信息】【需求分析】【数据结构】【需求配置】。
            const execData: ExecutionPanelData = target
              ? { ...data, target, targetWorkItem: `${target.id}@${target.collection}`, collection: target.collection, targetFillNonce }
              : data
            return <ExecutionPanel data={execData} actions={actions()} />
          })()
        ) : (
          <div style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>加载面板数据中…</div>
        ),
      )
    : null

  const rolesPanel = visited.roles
    ? panelWrap(
        'roles',
        data ? (
          <RoleSettings
            roles={data.roles}
            // 问题 9/11：provider / 模型 / 预设 / 技能 / MCP 全部来自 dsh 真实枚举。
            providers={data.providers}
            modelOptions={data.modelOptions}
            skillOptions={data.skillOptions}
            mcpServers={data.mcpServers}
            presets={data.presets}
            // 问题 1/2：同一份目录快照，角色管理页也要能重采 + 看到降级原因。
            onRefreshCatalog={refreshCatalog}
            catalogWarnings={data.catalogWarnings}
            catalogCollectedAt={data.catalogCollectedAt}
            onSave={async role => {
              const res = await bridge.saveRole(role)
              if (res.ok) {
                reload()
                void reloadBoard()
              }
              return res
            }}
            onDelete={async (id, force) => {
              const res = await bridge.deleteRole(id, force)
              if (res.ok) {
                reload()
                void reloadBoard()
              }
              return res
            }}
          />
        ) : (
          <div style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>加载面板数据中…</div>
        ),
      )
    : null

  const diagPanel = visited.diag ? panelWrap('diag', diagBody()) : null

  // 面板形态：填满中央列。宿主只为**选中面板**挂载本组件，故无需本地显隐状态。
  // 用 `flex column + 内容区 flex:1`：页签固定、各面板容器自己滚（页签不会滚出视口）。
  return (
    <section
      aria-label="TFS 看板"
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minHeight: 0,
        background: '#fff',
        color: '#111827',
        fontFamily: 'system-ui, sans-serif',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '8px 12px 0', borderBottom: '1px solid #e5e7eb' }}>
        {tabButton('pool', '需求池')}
        {tabButton('tasks', board && board.ok ? `任务中心(${board.tasks.length})` : '任务中心')}
        {tabButton('exec', '执行配置')}
        {tabButton('roles', '角色管理')}
        {tabButton('diag', '连接与凭据')}
        <span style={{ marginLeft: 'auto', fontSize: 12, color: '#9ca3af' }}>
          目标：{target ? `${target.id}@${target.collection}` : '未选择'}
          {data ? ` ｜ 集合：${data.collection}` : ''}
        </span>
        {/* 问题 2：关闭按钮（此前一旦打开就关不掉）。这里关闭 = 返回会话面板。 */}
        <button
          type="button"
          onClick={() => props.onClose?.()}
          title="关闭并返回会话（Esc）"
          aria-label="关闭并返回会话"
          style={{
            marginLeft: 8,
            width: 28,
            height: 28,
            borderRadius: 6,
            border: '1px solid #e5e7eb',
            background: '#fff',
            color: '#6b7280',
            fontSize: 16,
            lineHeight: '24px',
            cursor: 'pointer',
          }}
        >
          ×
        </button>
      </div>
      {error && (
        <div style={{ padding: '6px 12px', fontSize: 12, color: '#b91c1c', background: '#fef2f2' }}>
          面板数据加载失败：{error}
        </div>
      )}
      {/* 问题 3：五个面板常驻、按需隐藏，切 Tab 不卸载、不重载。 */}
      <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        {poolPanel}
        {tasksPanel}
        {execPanel}
        {rolesPanel}
        {diagPanel}
      </div>
    </section>
  )
}

/**
 * 客户端半槽位接线：把「TFS 看板」注册进**左侧菜单** + **中央面板**。
 *
 * 两处注册缺一不可，且必须共用同一个 `PANEL_ID`：
 *   1. `sidebar.panellist`（kind: list，scope: root）—— 左侧菜单行。组件只负责画图标，
 *      行样式、文案、点击动作全由宿主 `SidebarRoot` 的 `PanelRow` 拥有；
 *   2. `main`（kind: keyed，scope: root）—— 中央面板，key = 同一 id。
 *
 * ## 关于"放在任务看板下方"——这是实测推出来的，不是猜的
 *
 * 侧边栏自上而下的真实结构（`packages/client/ui-sidebar/src/client/SidebarRoot.tsx:218-265`）：
 * 品牌行 →「新建会话」按钮 → **`<nav>` 面板行列表** → 工作区浏览区 → 底部设置。
 * 「任务看板」那一行并**不是**槽位注册，而是第三方插件 DOM 注入：
 * `@linxin666/dsh-client-ui-task-board` 的 `sidebar-entry-core.ts` 明确写着
 * "dsh's sidebar shell exposes no slot an external plugin can register into"（该结论对
 * `sidebar.workspaces`/`sidebar.settings` 成立，但 `sidebar.panellist` 是 list 槽、可注册），
 * 它把自己插在「新建会话」之后。因此走槽位注册的面板行落在它**之后**，即下方。
 *
 * @param ctx - 客户端根上下文（运行期必含 slots 服务；此处经结构类型访问）。
 */
export function registerExecutionPanel(ctx: ClientContext): void {
  const slots = (ctx as ClientCtx).slots

  // 问题 1：capture 阶段监听本插件面板行点击，主动驱逐任务看板/SSH 的 DOM 接管。
  // 必须挂在点击链路上：Workbench 已挂载（但被接管面板 CSS 隐藏）时再点本行不会 remount，
  // 仅靠挂载 effect 覆盖不到该场景。生命周期随插件 fiber，卸载时自动解绑。
  ctx.effect(() => bindPanelRowEviction(), 'tfs-requirment: takeover-panel eviction')

  /**
   * 关闭动作：返回会话面板。
   *
   * ## 为什么**延迟**到点击时才解析 `layout`（2026-09-19 修复"关闭按钮无效"）
   *
   * 旧实现把 `ctx.get('layout')` 放在 `registerExecutionPanel` 的**同步执行期**并闭包捕获。
   * 这是错的：`ctx.get(name, ...)` 在提供服务 `ui-layout` 的 fiber **尚未激活**时返回
   * `undefined`（cordis `vendor/cordis/lib/index.js` `_getImpl` 的 `state !== 2` 分支，
   * `:769`），而插件加载期宿主服务普遍还没激活 —— 实测坐实：
   * `root.get('llm', true) → undefined` / `root.get('llm', false) → 有值`。
   *
   * 后果：捕获到的 `layout` 恒为 `undefined` ⇒ `close()` 里 `layout?.selectPanel?.(null)`
   * 恒为静默 no-op ⇒ 用户点右上角关闭**没有任何反应**（正是用户报告的问题 2）。
   *
   * 修法：把服务解析推迟到**点击那一刻**（那时宿主早已完成激活）。
   *
   * ## 关闭语义
   *
   * 传 `null` = 宿主语义上的"回到 Conversation"
   * （`ui-layout/src/client/service.ts:68-74`：`panelId === null` 时跳过
   * `hasMainPanel` 校验并直接 `panels.selectPanel(null)`）。
   * 这是**唯一**合法的"关掉中央面板"路径 —— 面板本身不是开关，选中权在宿主布局里。
   *
   * ## 诊断
   *
   * 两条解析通路都试（`ctx.get` 与 `ctx.layout`），任一可用即成功。
   * 全失败时给出**可操作**的 console 警告而非静默吞掉 —— 静默失败正是本缺陷潜伏的原因。
   */
  const resolveLayout = (): ILayoutFace | undefined => {
    // 通路 1：`ctx.get(name)` —— 非严格取法，服务未激活时也能拿到实现。
    try {
      const viaGet = ctx.get('layout') as ILayoutFace | undefined
      if (typeof viaGet?.selectPanel === 'function') return viaGet
    } catch {
      // `ctx.get` 在极老版本上可能不存在，落到通路 2。
    }
    // 通路 2：`ctx.layout` —— 已 `inject` 时可经服务代理直取（cordis `reflect` handler
    // `vendor/cordis/lib/index.js:674` 的 `Reflect.has` 分支）。本插件未把 `layout`
    // 写进 `inject`（写了会让缺该服务的部署整包加载失败），故这条通常抛错，兜住即可。
    try {
      const direct = (ctx as ClientContext & { layout?: ILayoutFace }).layout
      if (typeof direct?.selectPanel === 'function') return direct
    } catch {
      // 未 inject ⇒ cordis 抛 "cannot get property layout without inject"。属预期。
    }
    return undefined
  }

  const close = (): void => {
    try {
      const layout = resolveLayout()
      if (typeof layout?.selectPanel !== 'function') {
        console.warn(
          '[dsh-tfs-requirment] 无法关闭面板：宿主 layout 服务不可用。'
          + '请确认 dsh 客户端已加载 ui-layout；若右侧栏按钮有效但此处无效，'
          + '说明该部署未提供 ctx.layout.selectPanel。',
        )
        return
      }
      layout.selectPanel(null)
    } catch (e) {
      // `selectPanel` 对**未注册**的 id 会抛错（`service.ts:69-71`）；null 恒合法。
      // 此处只兜住异常不让它冒到 UI，但要留下痕迹。
      console.warn('[dsh-tfs-requirment] 关闭面板失败：', e)
    }
  }

  // 1) 左侧菜单行。`order` 只在本槽内排序（当前 profile 的 panellist 无其它注册者）。
  //    用 registerOnce：该 callback 会随槽声明生命周期重跑，重复注册会抛错并
  //    永久注销注入（详见 registerOnce 的文档）。
  slots.inject(
    'sidebar.panellist',
    () => registerOnce(
      slots,
      { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: PANEL_LABEL },
      TfsPanelIcon,
    ),
  )

  // 2) 中央面板。key 必须与菜单行的 id 一致，否则点击菜单不会切到这里。
  //    `main` 是 keyed 槽 ⇒ 同 key 重复注册**抛错**（问题 1 根因），必须走 registerOnce。
  //
  //    spec 010：本条目额外**声明一个 session 作用域的子槽** `TFS_CHAT_SLOT_KEY`。
  //    这是内嵌真实会话的**唯一**合法入口 —— 只有声明了 session 子槽的条目才会被渲染器
  //    注入 `SessionProvider`（`ui-renderer/src/client/scoped-slots.tsx:575-590`）。
  //    子槽键**只能被一个父条目声明**（`ui-slots/src/index.ts:1241-1245`），故右栏若将来
  //    也要内嵌会话，必须用另一个键。
  slots.inject(
    'main',
    () => registerOnce(
      slots,
      {
        name: 'main',
        key: PANEL_ID,
        children: { [TFS_CHAT_SLOT_KEY]: { kind: 'single', scope: 'session' } },
      },
      (slotProps: never) => {
        const kit = slotProps as unknown as {
          SessionProvider?: ChatSlotKit['SessionProvider']
          renderSlot?: ChatSlotKit['renderSlot']
        }
        return (
          <Workbench
            ctx={ctx}
            onClose={close}
            chatKit={{
              ...(kit.SessionProvider ? { SessionProvider: kit.SessionProvider } : {}),
              ...(kit.renderSlot ? { renderSlot: kit.renderSlot } : {}),
              childKey: TFS_CHAT_SLOT_KEY,
            }}
          />
        )
      },
    ),
  )

  // 3) 会话体子槽（spec 010）。`slots.inject` 的回调在**声明出现后**才跑，
  //    因此这里不依赖注册顺序；`registerOnce` 保证重复声明周期里只注册一份。
  slots.inject(
    TFS_CHAT_SLOT_KEY,
    () => registerOnce(
      slots,
      { name: TFS_CHAT_SLOT_KEY },
      (slotProps: never) => <OrchestratorChatBody {...(slotProps as unknown as Record<string, unknown>)} />,
    ),
  )

  // 4) 旧 / 精简宿主兼容（无 main / panellist，只有 shell.overlay + sidebar.footer.action）：
  //    footer 入口按钮 + shell.overlay 全屏面板。
  //
  //    ⚠️ 旧注释曾写"slots.inject 仅在该槽已被宿主声明时才执行回调，故在新版宿主上
  //    这两条不触发"——这条依据是**错的**，已实测推翻（见 `panelRowRegistered` 的注释）：
  //    `ui-sidebar` 在新版宿主上同样声明并渲染 `sidebar.footer.action`，`shell.overlay`
  //    也照旧存在，于是新版宿主上出现了**两个** TFS 入口（panellist 菜单行 + footArea
  //    里、紧挨着第三方「今日用量」卡片下方的 footer 按钮），点开还是同一个 Workbench。
  //
  //    现在改为**按菜单行是否存在**决定：菜单行注册成功 ⇒ footer/overlay 两个组件
  //    自身返回 null（注册保留、渲染为空，比"不注册"更安全——`registerOnce` 的
  //    重跑语义靠注册路径维护）。判断逻辑见 `panelRowRegistered`。
  //    先启动观测，再注册，保证注册那一刻起就能读到正确开关值。
  ctx.effect(() => watchPanelRow(slots), 'tfs-requirment: watch sidebar.panellist')

  slots.inject(
    'sidebar.footer.action',
    () =>
      registerOnce(
        slots,
        { name: 'sidebar.footer.action', id: PANEL_ID, label: PANEL_LABEL },
        () => <TfsFooterEntry />,
      ),
  )
  slots.inject(
    'shell.overlay',
    () =>
      registerOnce(
        slots,
        { name: 'shell.overlay', id: PANEL_ID },
        () => <TfsOverlayEntry ctx={ctx} />,
      ),
  )

  registerSideTab(ctx)
}

/**
 * 旧 / 精简宿主：`sidebar.footer.action`（list, root）里的 TFS 入口按钮。
 * 点击经 {@link panelOpen}.show() 打开 shell.overlay 中的全屏面板。
 *
 * 菜单行（`sidebar.panellist`）已注册时返回 `null` —— 那时用户已有一条正规入口，
 * 本按钮就是重复的第二个「TFS 看板」（2026-10-08）。返回 null 而非不注册，
 * 是为了保持 `registerOnce` 的重跑语义与 disposer 链路完整。
 */
function TfsFooterEntry(): JSX.Element | null {
  const hasPanelRow = useSyncExternalStore(panelRowRegistered.subscribe, panelRowRegistered.getSnapshot)
  if (hasPanelRow) return null
  return (
    <button
      type="button"
      title={PANEL_LABEL}
      aria-label={PANEL_LABEL}
      onClick={() => panelOpen.show()}
      style={{
        width: '100%',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 6,
        padding: '8px',
        border: 'none',
        borderRadius: 8,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      }}
    >
      <TfsPanelIcon size={18} />
    </button>
  )
}

/**
 * 旧 / 精简宿主：`shell.overlay`（list, root）里的 TFS 全屏面板。
 * overlay 层本身 click-through、其直接子元素自动获得 pointer-events；
 * 默认关闭时返回 null（不会开机即盖住应用），打开时渲染遮罩 + Workbench，
 * 点遮罩、Workbench 的关闭按钮或 Esc 收口到 {@link panelOpen}.hide()。
 */
function TfsOverlayEntry(props: { ctx: ClientContext }): JSX.Element | null {
  const open = useSyncExternalStore(panelOpen.subscribe, panelOpen.getSnapshot)
  // 菜单行已注册 ⇒ 面板走 `main` 槽，这条旧宿主全屏通道不再需要（同上）。
  const hasPanelRow = useSyncExternalStore(panelRowRegistered.subscribe, panelRowRegistered.getSnapshot)
  if (!open || hasPanelRow) return null
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={PANEL_LABEL}
      onClick={() => panelOpen.hide()}
      style={{
        position: 'absolute',
        inset: 0,
        background: 'rgba(17,24,39,0.45)',
        display: 'flex',
        alignItems: 'stretch',
        justifyContent: 'center',
        padding: 24,
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          flex: 1,
          maxWidth: 1400,
          borderRadius: 12,
          overflow: 'hidden',
          background: '#fff',
          boxShadow: '0 20px 60px rgba(0,0,0,0.35)',
        }}
      >
        <Workbench ctx={props.ctx} onClose={() => panelOpen.hide()} />
      </div>
    </div>
  )
}

/**
 * 注册右侧栏「TFS 执行」标签页（优化项 R1：与对话并排的执行配置）。
 *
 * ## 为什么必须走官方注册表，而不是自己往 DOM 里塞
 *
 * 右栏是宿主自己管理的停靠系统（分屏 / 浮动 / 拖拽 / 每会话一份布局），
 * DOM 注入进去的节点在宿主每次重排时都会被丢弃，且拿不到 `openTab` / `focus` / `close` 语义。
 * 宿主为此显式开放了两段式协议（见 `SidePanel.tsx` 文件头的 file:line 依据）：
 *   ① `ctx.sidebarRightTabs.register({ id, kind, title, guide })`；
 *   ② 该 `id` 再注册进 `sidebar.right.pane.tab` 槽。
 *
 * ## 为什么整块包在 try/catch 里
 *
 * `sidebarRightTabs` 与 `sidebarRight` 都是**较新**的宿主服务（本机 0.1.5-rc.2 有，
 * 但更老的部署可能没有）。右栏是这个插件的**增强**形态，不是它的唯一入口——
 * 拿不到服务时应当安静退化成"只有中央看板"，而不是把整套 UI 一起拖死。
 *
 * 注意这里用 `ctx.get()`（非抛出）而非把它加进 `inject`：`inject` 缺服务会让插件
 * **加载失败**，那才是真正的拖死。
 *
 * @param ctx - 客户端根上下文。
 */
function registerSideTab(ctx: ClientContext): void {
  try {
    const tabs = ctx.get('sidebarRightTabs') as SidebarRightTabRegistry | undefined
    if (tabs === undefined || typeof tabs.register !== 'function') return

    const slots = (ctx as ClientCtx).slots

    /**
     * 声明页类型。
     *
     * `title` 在**打开时**被读取并固化进布局记录，故给固定文案即可
     * （与 `SidebarRightTabDefinition.title` 的契约一致）。
     * `guide` 让该类型出现在右栏 `+` 的向导页里——没有它，用户只能靠
     * `openTab(kind)` 从代码打开，等于"注册了但没人知道怎么进"。
     */
    const dispose = tabs.register({
      id: TFS_EXEC_TAB_ID,
      kind: TFS_EXEC_KIND,
      title: () => TFS_EXEC_TITLE,
      guide: [
        {
          title: () => TFS_EXEC_TITLE,
          description: () => '与对话并排配置执行参数、派发看板任务',
        },
      ],
    })
    // 注册表的生命周期挂在 `ctx.effect` 上（宿主实现即如此），此处保持同样纪律：
    // 插件卸载时页类型一并撤下，避免留下一个"打不开的 kind"。
    ctx.effect(() => dispose, 'tfs-requirment: sidebar-right tab type')

    /**
     * 页体。key 必须等于 `definition.id`：注册表文档明写
     * "it is the key its body and title register under in the
     * `sidebar.right.pane.tab` and `sidebar.right.pane.tab.title` seats"。
     *
     * ⚠️ `sidebarRight` **必须在此回调内解析**（不能提到 `registerSideTab` 顶部并闭包捕获）：
     * 该服务与 `sidebarRightTabs` 同批提供，而 `slots.inject` 的回调在槽就绪后才跑 ——
     * 提到顶部会在宿主服务尚未激活时取到 `undefined` 并被永久闭包捕获，
     * 导致"关闭/收起按钮点了没反应"（同一类缺陷，见 `close()` 的注释）。
     */
    slots.inject(
      'sidebar.right.pane.tab',
      () =>
        registerOnce(
          slots,
          { name: 'sidebar.right.pane.tab', key: TFS_EXEC_TAB_ID },
          () => (
            <SidePanel
              bridge={bridge}
              boardStore={boardStore}
              onClose={() => {
                // 右栏的"关闭"语义是收起列，不是回会话——`closeCentral` 在这里不适用。
                // 同样在**点击时**重新解析（而非闭包捕获）：服务可能晚于本次渲染就绪。
                try {
                  ;(ctx.get('sidebarRight') as ISidebarRightFace | undefined)?.toggleExpanded?.()
                } catch {
                  // 拿不到右栏服务时退化为"按钮无动作"，不影响面板其余功能。
                }
              }}
            />
          ),
        ),
    )
  } catch {
    // 宿主没有右栏扩展面（或版本不兼容）：本次增强整体跳过。
    // 这里刻意不加 console.warn —— 该分支在旧部署上是**预期**路径，不是异常。
  }
}

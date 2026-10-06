// 任务中心面板（T040~T044 / US3，2026-09-20 问题 6/7/8/9/10 增强）。
//
// 常驻侧栏/工作台视图：已领取需求 + 任务列表（四态 + 执行态）+ 筛选 + 拆解 + 指派 + 启停重试取消。
// 纯展示层：看板快照与动作经 props 注入（由 HostBridge → 宿主半 BoardService 落地），不直接 fetch。
//
// 关键设计：
// - 乐观锁可见：每个写动作都带上该任务的 `revision`（宿主半校验），并发冲突时给出可读原因，
//   **不自动覆盖**（S-11）；UI 提示"刷新后重试"。
// - 排队可见：并发器读数（running/queued）显示在顶部角标，让"超额排队"对用户可见（S-06/T044）。
// - 依赖可见：`blockedBy` 非空且未完成的 pending 任务标「等待依赖」，避免用户以为是卡住了。
// - 问题 6：已领取需求、任务列表各自分页，每页条数可选并落盘（ui-state.json）。
// - 问题 7：需求可「还原到需求池」（仅当其任务全部已取消）。
// - 问题 8：仅「已取消」任务可删除（单行 + 复选框批量），宿主半整批门禁并级联清理依赖引用。
// - 问题 9/10：拆解走宿主半新语义（deleted 原地重建为全新 pending），await 完成后刷新快照，
//   结论文案直接用宿主返回的 reason（新增 N / 跳过 M）。
//
// ── 2026-09-21 增强（本文件的问题编号为**本轮反馈**）──
// - 问题 2：本页分「进行中 / 已完成」两个子 Tab。已完成页：上表 = 已完成需求
//   （分页 + 按需求 ID/标题检索），下表 = 焦点需求的任务，任务标题点开即执行过程详情；
// - 问题 3：进行中 Tab **不再显示**已完成需求（及其任务），全部任务完成后需求自动迁到已完成页；
// - 问题 4：需求行显示**执行状态**（未拆解 / 执行中 N / 有失败 N / 待办 N / 已完成 c/t）；
// - 问题 5：已完成需求必须先「取消完成」，才允许「还原到需求池」。
//
// 派生规则（执行状态、两页拆分、已完成页检索）放在 `shared/requirement-status.ts`：
// 组件层无渲染测试手段，派生逻辑写在 JSX 里就只能靠人眼保证。

import { useEffect, useMemo, useRef, useState } from 'react'
import { PaginationBar, CLAIMED_PAGE_SIZE_OPTIONS, TASK_PAGE_SIZE_OPTIONS } from './PaginationBar.js'
import { MultiSelect, dedupeOptions } from './MultiSelect.js'
import { TaskDetailDialog } from './TaskDetailDialog.js'
import {
  EMPTY_CHAT_MODEL,
  chatPanelStore,
  type ChatSwitcherItem,
} from './OrchestratorChat.js'
import { usePagination } from '../hooks/usePagination.js'
import { buildWorkItemUrl } from '../../shared/workitem-url.js'
import {
  filterCompletedRequirements,
  splitRequirementsByExecState,
  summarizeRequirementExec,
  type RequirementExecTone,
} from '../../shared/requirement-status.js'
import {
  decodeModelValue,
  formatModelRoute,
  groupModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from '../../shared/model-route.js'
import type {
  BoardSnapshotView,
  BoardTaskView,
  DeleteTasksResult,
  DispatchBatchResult,
  DshModelOption,
  DshPresetOption,
  DshSkillOption,
  DshWorkspaceOption,
  FollowUpTaskResult,
  RequirementSummary,
  RequirementWriteBackReport,
  RestoreResult,
  RoleDefinition,
  TaskAction,
  TaskOpResult,
  TaskTraceResult,
  UpdateTaskInput,
  UiState,
} from '../../shared/contracts.js'

const sectionStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  background: '#fff',
}
const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: 13,
}
const buttonStyle: React.CSSProperties = {
  padding: '4px 9px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#f9fafb',
  cursor: 'pointer',
  fontSize: 12,
}
const dangerButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: '#fef2f2',
  borderColor: '#fca5a5',
  color: '#b91c1c',
}
const cellStyle: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f1f5f9', fontSize: 12 }

const DEFAULT_CLAIMED_PAGE_SIZE = 10
const DEFAULT_TASK_PAGE_SIZE = 20
/** 已完成页「已完成需求」每页条数（问题 2；默认 10，档位复用 CLAIMED_PAGE_SIZE_OPTIONS）。 */
const DEFAULT_DONE_PAGE_SIZE = 10

/** 看板四态配色。 */
const STATE_STYLE: Record<string, { color: string; bg: string; label: string }> = {
  pending: { color: '#b45309', bg: '#fef3c7', label: '待办' },
  in_progress: { color: '#1d4ed8', bg: '#dbeafe', label: '进行中' },
  completed: { color: '#047857', bg: '#d1fae5', label: '已完成' },
  deleted: { color: '#6b7280', bg: '#f3f4f6', label: '已取消' },
}

/** 执行链路态配色。 */
const EXEC_STYLE: Record<string, { color: string; label: string }> = {
  queued: { color: '#b45309', label: '排队中' },
  running: { color: '#1d4ed8', label: '运行中' },
  // 问题 5：子 agent 结论为"请人工确认"时停在此态，**不会**被自动当作完成而推进下游。
  needs_confirmation: { color: '#c2410c', label: '待人工确认' },
  success: { color: '#047857', label: '成功' },
  failed: { color: '#b91c1c', label: '失败' },
  cancelled: { color: '#6b7280', label: '已取消' },
}

/**
 * 需求级执行状态配色（问题 4）。
 *
 * 与 `shared/requirement-status.ts` 的 `tone` 一一对应：派生层只给语义，
 * 配色留在这里 —— 纯逻辑层不该知道"失败=红色"这类界面事实。
 */
/**
 * 需求完成回写报告的状态标签与配色。
 *
 * `running` 黄色（正在写）、`ok` 绿色、`partial` 橙色（部分失败，可重跑）、
 * `error` 红色（全部失败）。索引类型取自契约里的 `RequirementWriteBackReport.status`，
 * 因此宿主新增状态时会在这里编译报错，而不是悄悄落到"无标签"分支。
 */
const WRITEBACK_TONE: Record<RequirementWriteBackReport['status'], { label: string; color: string }> = {
  running: { label: '进行中', color: '#92400e' },
  ok: { label: '已完成', color: '#047857' },
  partial: { label: '部分失败', color: '#b45309' },
  error: { label: '失败', color: '#b91c1c' },
}
const REQ_EXEC_STYLE: Record<RequirementExecTone, { color: string; bg: string }> = {
  done: { color: '#047857', bg: '#d1fae5' },
  running: { color: '#1d4ed8', bg: '#dbeafe' },
  failed: { color: '#b91c1c', bg: '#fee2e2' },
  pending: { color: '#b45309', bg: '#fef3c7' },
  todo: { color: '#6b7280', bg: '#f3f4f6' },
}

/** 状态药丸。 */
function Pill(props: { text: string; color: string; bg: string }): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        padding: '1px 7px',
        borderRadius: 10,
        fontSize: 11,
        color: props.color,
        background: props.bg,
        whiteSpace: 'nowrap',
      }}
    >
      {props.text}
    </span>
  )
}

/** 该任务当前可用的动作（按四态与执行态推导，非法动作不渲染，避免用户点了才报错）。 */
function actionsFor(t: BoardTaskView): TaskAction[] {
  if (t.state === 'pending') return ['start', 'cancel']
  if (t.state === 'in_progress') {
    // 问题 5：停在「待人工确认」时，不再提供"标记完成"（那是绕过人工），
    // 而是显式「确认通过」(confirm) 或「标记失败 / 取消」；追问/补充在执行详情弹层。
    if (t.execState === 'needs_confirmation') return ['confirm', 'fail', 'cancel']
    if (t.execState === 'running') return ['complete', 'fail', 'cancel']
    return ['retry', 'complete', 'fail', 'cancel']
  }
  // ⚠️ 已完成任务必须给出「撤销完成」的出口（2026-10-06 修复）。
  //
  // 引擎 `TASK_TRANSITIONS` 明确允许 `completed → deleted`（撤销），此前 UI 却对
  // completed 返回 `[]`，于是形成**死结**：
  //   - 「还原到需求池」的门禁要求名下**没有非 deleted 任务**（`Board.restoreRequirement`），
  //     而 completed 正属于非 deleted ⇒ 按钮恒 `disabled`（`activeCount > 0`）；
  //   - 用户又没有任何办法把 completed 任务变成 deleted（UI 无入口、API 入口用不了）。
  // 结果：跑完任务的需求**永远无法还原回需求池**，只能手工改 board.json。
  // 这里复用 `cancel`（引擎侧就是 finishTask(...,'cancelled') → deleted），文案按状态区分。
  if (t.state === 'completed') return ['cancel']
  return []
}

const ACTION_LABEL: Record<TaskAction, string> = {
  start: '启动',
  retry: '重试',
  complete: '标记完成',
  fail: '标记失败',
  cancel: '取消',
  // 问题 5：人工核对子 agent 产出后显式放行，才置成功并触发下游自动链式。
  confirm: '确认通过',
}

/**
 * 动作文案（同一 action 在不同状态下语义不同，必须按状态区分）。
 *
 * `cancel` 对在办任务是"取消"，对已完成任务则是"撤销完成"——后者是把它退回 deleted
 * 以便需求能还原，混用"取消"会让人以为要丢掉已完成的产出。
 */
function actionLabel(action: TaskAction, state: string): string {
  if (action === 'cancel' && state === 'completed') return '撤销完成'
  return ACTION_LABEL[action]
}

/**
 * 问题 3：任务是否可编辑（未执行 / 失败待修正 / 待人工确认）。
 * 运行中（execState=running）由宿主 Board 门禁拒绝，这里直接不显示入口。
 */
function taskEditable(t: BoardTaskView): boolean {
  if (t.state === 'deleted' || t.state === 'completed') return false
  if (t.state === 'pending') return true
  // in_progress 且非运行中（失败 / 待人工确认）允许在重试前调整。
  return t.execState === 'failed' || t.execState === 'needs_confirmation'
}

/** 问题 5：从看板任务的 lastNote 中取出"待人工确认："后面的具体原因。 */
function stripConfirmPrefix(note?: string): string {
  if (!note) return ''
  const m = note.match(/^待人工确认[：:]\s*([\s\S]*)$/)
  return m && m[1] ? m[1].trim() : note
}

/**
 * 任务中心面板。
 * @param props.snapshot - 看板快照（null = 未加载/不可用）。
 * @param props.roles - 可指派角色（US5）。
 * @param props.collection - 当前集合（UI 状态命名空间；缺省用默认集合节点）。
 * @param props.onRefresh - 重新拉取快照（async；动作完成后 await，保证列表实时同步）。
 * @param props.onDecompose - 拆解需求为任务（T041，问题 9/10：返回 created/skipped/reason）。
 * @param props.onRestore - 还原需求回需求池（问题 7）。
 * @param props.onDeleteTasks - 删除已取消任务（问题 8，整批门禁）。
 * @param props.onAssign - 指派/改派任务角色（T042）。
 * @param props.onTaskState - 任务状态操作（T043）。
 */
export function TaskCenter(props: {
  snapshot: BoardSnapshotView | null
  roles: RoleDefinition[]
  collection?: string
  onRefresh: () => Promise<void> | void
  onDecompose: (requirementId: string) => Promise<{
    ok: boolean
    taskIds?: string[]
    created?: number
    skipped?: number
    /** spec 008 US3：匹配不到合适角色时宿主自动创建的角色展示名。 */
    createdRoles?: string[]
    reason?: string
  }>
  onRestore?: (requirementKey: string) => Promise<RestoreResult>
  onDeleteTasks?: (taskIds: string[]) => Promise<DeleteTasksResult>
  /**
   * 设置需求级执行状态（问题 5）：`'active'` = 取消完成（退回「进行中」页），
   * `'completed'` = 人工确认完成。
   *
   * 「已完成」页的「取消完成」按钮与「还原到需求池」的前置门禁都靠它 ——
   * 未接线时（老宿主）该按钮不渲染，避免点了没反应。
   */
  onSetRequirementExecState?: (input: {
    requirementKey: string
    state: 'active' | 'completed'
  }) => Promise<{ ok: boolean; reason?: string }>
  /**
   * 需求完成回写（TFS 结论评论 / 评审自测字段 / 产物附件 / 关联任务归位）的手动重跑入口。
   *
   * 自动回写（`autoWriteBack`）在 `partial` / `error` 时不会自行重试，而回写报告
   * （`RequirementSummary.writeBack`）此前既没有展示也没有入口：一条部分失败的需求会
   * 永远停在"回写不全"的状态，界面上看不到哪几项失败、也没有「重新回写」按钮
   * （`HostBridge.writeBackRequirement` 早已实现却无调用方）。未接线时不渲染该入口。
   */
  onWriteBackRequirement?: (requirementKey: string) => Promise<{ ok: boolean; reason?: string }>
  onAssign: (taskId: string, roleName: string) => Promise<TaskOpResult>
  onTaskState: (taskId: string, action: TaskAction, expectedRevision?: number) => Promise<TaskOpResult>
  /** spec 006 US2：读取某次任务执行的过程轨迹（技能/MCP/工具调用时间线）。 */
  onGetTaskTrace?: (taskId: string, attemptIndex?: number) => Promise<TaskTraceResult>
  /** spec 006 US3：对任务追问 / 补充指令（同角色同配置起新一轮）。 */
  onFollowUpTask?: (input: { taskId: string; message: string }) => Promise<FollowUpTaskResult>
  /**
   * 派发该看板任务给角色智能体执行（US3→US4 的闭环）。
   * 传入 `task.taskId`，宿主半据此把 run 结果自动回绑到看板任务（见 host/api.ts#dispatch）。
   */
  onDispatchTask?: (task: BoardTaskView) => Promise<{ ok: boolean; reason?: string }>
  onSelectRequirement?: (item: RequirementSummary) => void
  /** 问题 6：每页条数记忆（与需求池共用 ui-state.json）。 */
  loadUiState?: (collection?: string) => Promise<UiState>
  saveUiState?: (patch: Partial<UiState>, collection?: string) => Promise<{ ok: boolean; reason?: string }>
  // ── 问题 3/4/5：编辑与勾选批量派发 ──
  /** 编辑已领取需求的本地字段（问题 3：提示词 / 工作目录）。 */
  onUpdateRequirement?: (
    requirementKey: string,
    patch: { workspace?: string | null; prompt?: string | null },
  ) => Promise<{ ok: boolean; reason?: string }>
  /** 编辑任务字段（问题 4：提示词 / 模型 / 技能 / MCP / 工作目录）。 */
  onUpdateTask?: (input: UpdateTaskInput) => Promise<TaskOpResult>
  /**
   * 勾选批量派发（问题 5）。
   *
   * 依赖顺序（"必须等依赖完成才能开始"）由**编排层**保证，不在本组件里 ——
   * 组件只负责把勾选集合交出去并把结果/进度显示出来（分波算法见
   * `src/shared/batch-dispatch.ts`，I/O 见 `slots.tsx#dispatchBatch`）。
   */
  onDispatchBatch?: (taskIds: string[]) => Promise<DispatchBatchResult>
  /** 批量派发进行中的进度文案（由编排层下发；null = 未在跑）。 */
  batchProgress?: string | null
  /** dsh 已添加的工作区（问题 3/4：编辑弹框里选工作目录）。 */
  workspaces?: DshWorkspaceOption[]
  /** dsh 真实模型清单（问题 4：编辑弹框里切模型）。 */
  modelOptions?: DshModelOption[]
  /** dsh 真实技能清单（问题 4）。 */
  skillOptions?: DshSkillOption[]
  /** 宿主真实注册的 MCP server（问题 4）。 */
  mcpServers?: string[]
  /** dsh 真实预设清单（问题 3：任务编辑弹框里选预设 / preset；value 用 preset id）。 */
  presets?: DshPresetOption[]
  /**
   * 活动档案的服务地址（不含集合）。
   *
   * 只在工作项自带 REST `url` 缺失时作为**兜底**参与 TFS 需求页拼接。
   */
  tfsBaseUrl?: string
  /**
   * 编排能力现算结果（D7）：`available===false` 时（subagents 不可达 **或无顶层会话**），
   * 批量/单任务派发按钮前置禁用并提示，避免点完才在 dispatch 内失败。
   */
  orchestration?: { available: boolean; reason?: string }
}): JSX.Element {
  const [stateFilter, setStateFilter] = useState('')
  const [roleFilter, setRoleFilter] = useState('')
  const [requirementFilter, setRequirementFilter] = useState('')
  const [keyword, setKeyword] = useState('')
  const [busy, setBusy] = useState(false)
  // D7：无顶层会话 / subagents 不可达时前置阻断派发（与 ExecutionPanel 同一判据）。
  const orchestrationBlocked = props.orchestration?.available === false
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err' | 'warn'; text: string } | null>(null)
  const [claimedPageSize, setClaimedPageSize] = useState(DEFAULT_CLAIMED_PAGE_SIZE)
  const [taskPageSize, setTaskPageSize] = useState(DEFAULT_TASK_PAGE_SIZE)
  /** 问题 8：勾选待删的已取消任务 id 集合。 */
  const [selectedDeleted, setSelectedDeleted] = useState<Set<string>>(new Set())
  /** 问题 5：勾选待派发的任务 id 集合。 */
  const [selectedTasks, setSelectedTasks] = useState<Set<string>>(new Set())
  /** 问题 3：正在编辑的已领取需求（null = 关闭）。 */
  const [reqEdit, setReqEdit] = useState<RequirementSummary | null>(null)
  /** 问题 4：正在编辑的任务（null = 关闭）。 */
  const [taskEdit, setTaskEdit] = useState<BoardTaskView | null>(null)
  /** spec 006：正在查看执行详情的任务 id（null = 关闭）；存 id 以便快照刷新后拿到最新任务对象。 */
  const [detailTaskId, setDetailTaskId] = useState<string | null>(null)
  /** 问题 2：本页子 Tab（进行中 / 已完成）。 */
  const [viewTab, setViewTab] = useState<'active' | 'done'>('active')
  /** 问题 2：已完成页的需求检索词（对需求 ID 与标题）。 */
  const [doneKeyword, setDoneKeyword] = useState('')
  /** 问题 2：已完成需求列表每页条数（落盘记忆）。 */
  const [donePageSize, setDonePageSize] = useState(DEFAULT_DONE_PAGE_SIZE)
  /** 问题 2：已完成页当前焦点需求（null = 未选，回落为第一条）。 */
  const [focusKey, setFocusKey] = useState<string | null>(null)

  const hydratedRef = useRef(false)
  const loadUiStateRef = useRef(props.loadUiState)
  loadUiStateRef.current = props.loadUiState
  const saveUiStateRef = useRef(props.saveUiState)
  saveUiStateRef.current = props.saveUiState
  const uiKey = props.collection ?? 'default'

  const snap = props.snapshot
  const tasks = snap?.tasks ?? []
  const requirements = snap?.requirements ?? []
  // 详情弹层始终用最新快照里的任务对象（追问后轮次/状态会变）；任务消失则自动关闭。
  const detailTask = detailTaskId ? tasks.find(t => t.taskId === detailTaskId) ?? null : null

  // ── 问题 2/3/4：需求分页（进行中 / 已完成）与执行状态派生 ──
  //
  // 全部派生都是纯函数（`shared/requirement-status.ts`）＋ `useMemo`：
  // 快照刷新、切页、检索都只是重算这些派生量，不产生额外请求。
  const { active: activeRequirements, completed: doneRequirementsAll } = useMemo(
    () => splitRequirementsByExecState(requirements),
    [requirements],
  )
  /** 已完成页经过检索过滤后的需求（问题 2）。 */
  const doneRequirements = useMemo(
    () => filterCompletedRequirements(doneRequirementsAll, doneKeyword),
    [doneRequirementsAll, doneKeyword],
  )
  /**
   * 已完成需求键集合。进行中 Tab 的**任务表**也按它过滤（问题 3）：需求迁走后其任务
   * 一并从"进行中"消失 —— 否则会出现"需求不见、任务还在"的半迁移状态。
   */
  const doneReqKeys = useMemo(() => {
    const s = new Set<string>()
    for (const r of doneRequirementsAll) s.add(`${r.id}@${r.collection}`)
    return s
  }, [doneRequirementsAll])
  const activeTasks = useMemo(() => tasks.filter(t => !doneReqKeys.has(t.requirementId)), [tasks, doneReqKeys])

  // ── spec 010：把「焦点需求 + 可切换会话清单」发布给右侧主对话框 ──
  //
  // 对话框由**父槽位条目**（工作台）渲染，拿不到本组件的状态，故经模块级 store 传递。
  // 焦点需求口径：用户显式选择的需求筛选优先，否则取第一条进行中需求。
  const chatFocusKey = useMemo(() => {
    if (requirementFilter) return requirementFilter
    const first = activeRequirements[0]
    return first ? `${first.id}@${first.collection}` : ''
  }, [requirementFilter, activeRequirements])
  const chatFocusReq = useMemo(
    () => requirements.find(r => `${r.id}@${r.collection}` === chatFocusKey),
    [requirements, chatFocusKey],
  )
  /**
   * 焦点需求变化时把切换条选中项回到「主 agent」。
   *
   * 选中项本身存在 `chatPanelStore` 里（切换条与对话框在槽位两侧，只能经 store 通信），
   * 本组件**不再**用自己的 state 复制一份：复制出来的副本只会被本组件自己写回
   * `'orchestrator'`，看板每 3 秒轮询一次就把用户刚点的子会话弹回去。
   */
  useEffect(() => {
    chatPanelStore.selectKey('orchestrator')
  }, [chatFocusKey])

  useEffect(() => {
    if (viewTab !== 'active' || !chatFocusKey) {
      chatPanelStore.set({ ...EMPTY_CHAT_MODEL })
      return
    }
    const orch = chatFocusReq?.orchestration
    const parentSessionId = orch?.parentSessionId ?? ''
    const orchestratorSessionId = orch?.mode === 'continuable' ? orch.orchestratorSessionId : undefined
    const items: ChatSwitcherItem[] = [
      {
        key: 'orchestrator',
        label: '主 agent',
        enabled: Boolean(orchestratorSessionId && parentSessionId),
        ...(orchestratorSessionId && parentSessionId
          ? {
              target: {
                childSessionId: orchestratorSessionId,
                parentSessionId,
                mode: 'continuable' as const,
              },
            }
          : { reason: orch?.reason ?? '该需求尚未创建编排主 agent 会话' }),
      },
    ]
    for (const t of tasks.filter(t => t.requirementId === chatFocusKey)) {
      // 会话 id：优先任务级编排字段（复用会话时是持久 childId），否则取最后一次尝试的 runId。
      const sessionId = t.orchestration?.sessionId
        ?? [...t.attempts].reverse().find(a => a.runId)?.runId
      const enabled = Boolean(sessionId && parentSessionId)
      const exec = EXEC_STYLE[t.execState]
      items.push({
        key: t.taskId,
        label: t.title || t.taskId,
        enabled,
        ...(enabled
          ? {
              target: {
                childSessionId: sessionId as string,
                parentSessionId,
                mode: (t.orchestration?.reused ? 'continuable' : 'one-shot') as 'continuable' | 'one-shot',
              },
            }
          : { reason: '该任务还没有会话（尚未派发过，或宿主未回绑会话 id）' }),
        ...(exec ? { badge: { text: exec.label, color: exec.color, bg: '#f3f4f6' } } : {}),
      })
    }
    chatPanelStore.set({
      visible: true,
      requirementKey: chatFocusKey,
      requirementTitle: chatFocusReq?.title ?? chatFocusKey,
      ...(orch
        ? {
            orchestrator: {
              mode: orch.mode === 'continuable' ? 'continuable' : 'off',
              ...(orch.orchestratorSessionId ? { sessionId: orch.orchestratorSessionId } : {}),
              ...(orch.parentSessionId ? { parentSessionId: orch.parentSessionId } : {}),
              ...(orch.reason ? { reason: orch.reason } : {}),
            },
          }
        : {}),
      items,
      // 保留用户在切换条上的选择：同一需求下该键仍在列表中就沿用，否则回落「主 agent」。
      activeKey: items.some(i => i.key === chatPanelStore.get().activeKey)
        ? chatPanelStore.get().activeKey
        : 'orchestrator',
    })
  }, [viewTab, chatFocusKey, chatFocusReq, tasks])

  // 问题 6：水合每页条数（只在集合/首次挂载时跑一次）。
  useEffect(() => {
    let cancelled = false
    hydratedRef.current = false
    setClaimedPageSize(DEFAULT_CLAIMED_PAGE_SIZE)
    setTaskPageSize(DEFAULT_TASK_PAGE_SIZE)
    if (!loadUiStateRef.current) {
      hydratedRef.current = true
      return
    }
    void (async (): Promise<void> => {
      try {
        const ui = await loadUiStateRef.current?.(uiKey === 'default' ? undefined : uiKey)
        if (cancelled || !ui) return
        if (typeof ui.claimedPageSize === 'number' && ui.claimedPageSize > 0) setClaimedPageSize(ui.claimedPageSize)
        if (typeof ui.taskPageSize === 'number' && ui.taskPageSize > 0) setTaskPageSize(ui.taskPageSize)
        if (typeof ui.donePageSize === 'number' && ui.donePageSize > 0) setDonePageSize(ui.donePageSize)
      } finally {
        if (!cancelled) hydratedRef.current = true
      }
    })()
    return () => {
      cancelled = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uiKey])

  const filtered = useMemo(
    () =>
      // 只筛「进行中」需求的任务（问题 3）：已完成需求的任务整体在已完成页里看。
      activeTasks.filter(t => {
        if (stateFilter && t.state !== stateFilter) return false
        if (roleFilter && t.roleAgent !== roleFilter) return false
        if (requirementFilter && t.requirementId !== requirementFilter) return false
        if (keyword) {
          const kw = keyword.toLowerCase()
          if (!t.title.toLowerCase().includes(kw) && !t.taskId.toLowerCase().includes(kw)) return false
        }
        return true
      }),
    [activeTasks, stateFilter, roleFilter, requirementFilter, keyword],
  )

  /** 当前筛选命中的全部已取消任务（批量删除/表头全选的作用域 = 筛选全集，不仅是当前页）。 */
  const filteredDeletedIds = useMemo(() => filtered.filter(t => t.state === 'deleted').map(t => t.taskId), [filtered])

  // 快照刷新后，剪掉已不存在或已不是 deleted 的勾选项（防止陈旧选择误删）。
  useEffect(() => {
    setSelectedDeleted(prev => {
      const alive = new Set(filteredDeletedIds)
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (alive.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
  }, [filteredDeletedIds.join('|')])

  /**
   * 问题 5：可勾选派发的任务 = 当前筛选命中的 `pending` / `in_progress` 任务。
   * `completed` / `deleted` 是终态（引擎 `Board.startTask` 会拒），故不提供勾选框。
   */
  const dispatchableIds = useMemo(
    () => filtered.filter(t => t.state === 'pending' || t.state === 'in_progress').map(t => t.taskId),
    [filtered],
  )

  // 快照刷新后剪掉已不可派发的勾选项（防止陈旧选择派到已终态任务）。
  useEffect(() => {
    setSelectedTasks(prev => {
      if (prev.size === 0) return prev
      const alive = new Set(dispatchableIds)
      let changed = false
      const next = new Set<string>()
      for (const id of prev) {
        if (alive.has(id)) next.add(id)
        else changed = true
      }
      return changed ? next : prev
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dispatchableIds.join('|')])

  const claimedPaging = usePagination(activeRequirements.length, claimedPageSize)
  const taskPaging = usePagination(filtered.length, taskPageSize)
  // 问题 2：已完成需求列表独立分页（档位与「已领取需求」复用，语义同为"需求列表"）。
  const donePaging = usePagination(doneRequirements.length, donePageSize)
  const pageRequirements = claimedPaging.paginate(activeRequirements)
  const pageDone = donePaging.paginate(doneRequirements)
  const pageTasks = taskPaging.paginate(filtered)

/**
 * 表头全选的作用域：**当前页**（与行复选框一致）。
 *
 * 原来两个表头复选框作用在整个 `filtered` 上，而行复选框是页内局部、全选后确认框只报一个
 * 数字：于是在 8 页的第 2 页点一下表头，会把 213 条看不见的记录一次性删掉，而用户看到的
 * 只有"已选 213 个"和一次例行确认。跨页全选并非需求：批量删除是**不可撤销**的破坏性操作，
 * 它的选择范围必须与用户当下能看见、能逐条核对的内容一致；确实要处理多页时翻页再全选即可
 * （选中集合跨页累积，不会被翻页清掉）。
 */
const pageDispatchableIds = useMemo(
() => pageTasks.filter(t => t.state === 'pending' || t.state === 'in_progress').map(t => t.taskId),
[pageTasks],
)
const pageDeletedIds = useMemo(() => pageTasks.filter(t => t.state === 'deleted').map(t => t.taskId), [pageTasks])

  /**
   * 问题 2：已完成页的焦点需求（决定下方任务表显示谁）。
   *
   * 焦点必须落在**当前检索命中**的集合里：检索把焦点需求过滤掉后，若不回落，
   * 下方任务表会继续显示一个"列表里根本看不到"的需求，用户会以为列表和详情对不上。
   */
  const focusRequirementKey = useMemo(() => {
    if (focusKey && doneRequirements.some(r => `${r.id}@${r.collection}` === focusKey)) return focusKey
    const first = doneRequirements[0]
    return first ? `${first.id}@${first.collection}` : null
  }, [focusKey, doneRequirements])
  const focusRequirement = useMemo(
    () => (focusRequirementKey ? requirements.find(r => `${r.id}@${r.collection}` === focusRequirementKey) : undefined),
    [focusRequirementKey, requirements],
  )
  const focusTasks = useMemo(
    () => (focusRequirementKey ? tasks.filter(t => t.requirementId === focusRequirementKey) : []),
    [focusRequirementKey, tasks],
  )

  const allTasksChecked = pageDispatchableIds.length > 0 && pageDispatchableIds.every(id => selectedTasks.has(id))
  const toggleTask = (id: string, checked: boolean): void => {
    setSelectedTasks(prev => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }
  const toggleAllTasks = (checked: boolean): void => {
    setSelectedTasks(prev => {
      const next = new Set(prev)
      for (const id of pageDispatchableIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  const persistPageSize = (patch: Partial<UiState>): void => {
    if (hydratedRef.current && saveUiStateRef.current) {
      void saveUiStateRef.current(patch, uiKey === 'default' ? undefined : uiKey)
    }
  }

  /** 统一跑一个可能失败的动作并刷新；服务端 reason 优先作为结论文案。 */
  const run = async (
    fn: () => Promise<{ ok: boolean; reason?: string; tagWarning?: string }>,
    okText: string,
    opts?: { resetTaskPage?: boolean },
  ): Promise<boolean> => {
    setBusy(true)
    setMsg(null)
    try {
      const r = await fn()
      if (r.ok) {
        await props.onRefresh()
        if (r.tagWarning) setMsg({ tone: 'warn', text: `${r.reason ?? okText}\n告警：${r.tagWarning}` })
        else setMsg({ tone: 'ok', text: r.reason ?? okText })
        if (opts?.resetTaskPage) taskPaging.resetPage()
      } else {
        setMsg({ tone: 'err', text: r.reason ?? '操作失败' })
      }
      return r.ok
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
      return false
    } finally {
      setBusy(false)
    }
  }

  /** 问题 8：删除一批已取消任务（单行/批量共用）。 */
  const deleteTasks = async (ids: string[]): Promise<void> => {
    if (!props.onDeleteTasks || ids.length === 0) return
    if (!window.confirm(`确认删除 ${ids.length} 个已取消任务？\n会同时清理其他任务对它们的依赖引用，此操作只影响本地看板（不删除 TFS 工作项）。`)) {
      return
    }
    await run(
      async () => {
        const r = await props.onDeleteTasks!(ids)
        if (r.ok) {
          setSelectedDeleted(prev => {
            const next = new Set(prev)
            for (const id of ids) next.delete(id)
            return next
          })
          return { ok: true, reason: `已删除 ${r.count ?? ids.length} 个已取消任务` }
        }
        return { ok: false, reason: r.reason }
      },
      `已删除 ${ids.length} 个任务`,
    )
  }

  /** 问题 7：还原需求回需求池。 */
  const restore = async (key: string): Promise<void> => {
    if (!props.onRestore) return
    if (
      !window.confirm(
        '确认把该需求还原到需求池？\n\n· 需求将从任务中心移除并重新出现在需求池；\n· 其名下「已取消」的任务会被一并清理；\n· 仍有待办/进行中/已完成任务时会被拒绝；\n· 不删除 TFS 工作项（仅移除本地入池标签，移除失败会给出告警）。',
      )
    ) {
      return
    }
    await run(async () => props.onRestore!(key), `已还原 ${key} 到需求池`)
  }

  const toggleDeleted = (id: string, checked: boolean): void => {
    setSelectedDeleted(prev => {
      const next = new Set(prev)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })
  }

  const allDeletedChecked = pageDeletedIds.length > 0 && pageDeletedIds.every(id => selectedDeleted.has(id))
  const toggleAllDeleted = (checked: boolean): void => {
    setSelectedDeleted(prev => {
      const next = new Set(prev)
      for (const id of pageDeletedIds) {
        if (checked) next.add(id)
        else next.delete(id)
      }
      return next
    })
  }

  /**
   * 问题 5：勾选批量派发。
   *
   * 本方法只负责"交出去 + 展示结果"：依赖顺序（有依赖的必须等依赖完成）由编排层
   * （`slots.tsx#dispatchBatch` + `shared/batch-dispatch.ts`）保证 ——
   * 放在这里会让组件同时承担 I/O 编排与渲染两件事，而组件层没有测试手段
   * （客户端半无 React 测试库），出问题时既测不到也说不清。
   */
  const dispatchBatch = async (): Promise<void> => {
    if (!props.onDispatchBatch || selectedTasks.size === 0) return
    setBusy(true)
    setMsg(null)
    const ids = [...selectedTasks]
    try {
      const r = await props.onDispatchBatch(ids)
      const lines: string[] = [
        r.reason ?? (r.ok ? `已按依赖顺序派发 ${r.dispatched} 个任务` : `批量派发未完成（已派发 ${r.dispatched} 个）`),
      ]
      if (r.waves.length > 0) {
        lines.push(
          r.waves
            .map((w, i) => `第 ${i + 1} 波：${w.taskIds.join('、')}${w.failures.length > 0 ? `（失败 ${w.failures.length}）` : ''}`)
            .join('\n'),
        )
      }
      if (r.skipped.length > 0) {
        lines.push(r.skipped.map(s => `未派发 ${s.taskId}：${s.reason}`).join('\n'))
      }
      setMsg({ tone: r.ok ? 'ok' : 'warn', text: lines.join('\n') })
      setSelectedTasks(new Set())
      await props.onRefresh()
    } catch (e) {
      setMsg({ tone: 'err', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 问题 3：保存需求本地字段（提示词 / 工作目录）。
   *
   * 只在成功时关弹框：宿主会因工作目录不存在等原因拒绝保存，此时关闭弹框等于
   * 把用户刚填的一整张表单静默丢弃，用户只能重新打开再填一遍。
   */
  const saveRequirement = async (
    key: string,
    patch: { workspace?: string | null; prompt?: string | null },
  ): Promise<void> => {
    if (!props.onUpdateRequirement) return
    const ok = await run(async () => {
      const r = await props.onUpdateRequirement!(key, patch)
      return r.ok ? { ok: true, reason: `已更新需求 ${key}` } : { ok: false, reason: r.reason }
    }, `已更新需求 ${key}`)
    if (ok) setReqEdit(null)
  }

  /** 问题 4：保存任务字段（提示词 / 模型 / 技能 / MCP / 工作目录）。失败时保留弹框（同 {@link saveRequirement}）。 */
  const saveTask = async (input: UpdateTaskInput): Promise<void> => {
    if (!props.onUpdateTask) return
    const ok = await run(async () => {
      const r = await props.onUpdateTask!(input)
      return r.ok ? { ok: true, reason: `已更新任务 ${input.taskId}` } : { ok: false, reason: r.reason }
    }, `已更新任务 ${input.taskId}`)
    if (ok) setTaskEdit(null)
  }

  /**
   * 问题 5：设置需求执行状态。
   *
   * `'active'`（取消完成）会让需求退回「进行中」页 —— 这是它**唯一**的用途：先取消完成，
   * 之后才可能走到「取消任务 → 还原到需求池」。宿主侧 `Board.restoreRequirement` 对已完成需求
   * 直接拒绝并给出"请先点取消完成"的可读原因，本函数就是那条原因对应的按钮。
   */
  /**
   * 手动重跑需求完成回写。
   *
   * 传给宿主的是 `force=true`：即便上一份报告是 `ok` 也重跑一遍。回写账本仍会跳过
   * 已成功的项，因此重跑只补 `partial` / `error` 里没写进去的部分，不会把已成功的
   * 字段、结论评论、附件再写一份（这条语义就是 `RequirementFinalizer.runWriteBack`
   * 里 `doneTargets` 不再随 force 清空的依据）。
   *
   * @param key - 需求去重键。
   */
  const writeBackRequirement = async (key: string): Promise<void> => {
    if (!props.onWriteBackRequirement) return
    await run(() => props.onWriteBackRequirement!(key), `回写 ${key}`)
  }
  const setReqExecState = async (key: string, state: 'active' | 'completed'): Promise<void> => {
    if (!props.onSetRequirementExecState) return
    await run(
      async () => {
        const r = await props.onSetRequirementExecState!({ requirementKey: key, state })
        if (!r.ok) return { ok: false, reason: r.reason }
        return {
          ok: true,
          reason: state === 'active' ? `已取消完成：${key} 已退回「进行中」` : `已确认完成：${key} 已迁入「已完成」`,
        }
      },
      state === 'active' ? `已取消完成 ${key}` : `已确认完成 ${key}`,
    )
  }

  /**
   * 需求去重键 → 需求摘要。
   *
   * 任务表只有 `requirementId`（形如 `1997179@WN_HIS`），要拼 TFS 需求页必须回查
   * 需求记录拿 `project` 与 REST `url` —— 任务本身在 TFS 上**没有**对应工作项。
   */
  const requirementByKey = useMemo(() => {
    const m = new Map<string, RequirementSummary>()
    for (const r of requirements) m.set(`${r.id}@${r.collection}`, r)
    return m
  }, [requirements])

  /**
   * 需求 → TFS 需求页（编辑页）。
   * 拼不出完整地址时返回 `undefined`，调用方渲染回退为纯文本（不产出打不开的假链接）。
   */
  const workItemUrlOf = (r: RequirementSummary | undefined): string | undefined =>
    r === undefined
      ? undefined
      : buildWorkItemUrl({
          id: r.id,
          restUrl: r.url,
          project: r.project,
          baseUrl: props.tfsBaseUrl,
          collection: r.collection,
        })

  if (!snap) {
    return <div style={{ padding: 20, color: '#6b7280', fontSize: 13 }}>看板加载中…</div>
  }
  if (!snap.ok) {
    return (
      <div style={{ padding: 20, fontSize: 13, color: '#b91c1c' }}>
        <strong>看板不可用：</strong>
        {snap.reason ?? '未知原因'}
        <div style={{ marginTop: 6, color: '#7f1d1d', fontSize: 12 }}>
          看板状态落在插件数据目录的 <code>board.json</code>。若该文件存在但无法解析，插件会保留原文件而不重建
          （FR-020），请人工检查后再处理。
        </div>
      </div>
    )
  }

  const roles = props.roles
  const msgColor = msg?.tone === 'ok' ? '#047857' : msg?.tone === 'warn' ? '#b45309' : '#b91c1c'

  /** 问题 2：本页两个子 Tab 的按钮（与「已完成」页并列，不占用外层工作台的页签）。 */
  const subTabButton = (key: 'active' | 'done', label: string): JSX.Element => {
    const active = viewTab === key
    return (
      <button
        type="button"
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          setViewTab(key)
          // 切页只换视图，不重置筛选：用户常在两页之间来回核对同一条需求。
        }}
        style={{
          padding: '4px 12px',
          borderRadius: 6,
          border: `1px solid ${active ? '#2563eb' : '#d1d5db'}`,
          background: active ? '#eff6ff' : '#fff',
          color: active ? '#2563eb' : '#4b5563',
          cursor: 'pointer',
          fontSize: 13,
          fontWeight: active ? 600 : 400,
        }}
      >
        {label}
      </button>
    )
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', color: '#111827' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
        <h3 style={{ margin: 0 }}>任务中心</h3>
        {/* 问题 2：子 Tab —— 进行中 / 已完成。计数让用户一眼知道两边各有多少条。 */}
        <span style={{ display: 'inline-flex', gap: 6 }}>
          {subTabButton('active', `进行中（${activeRequirements.length}）`)}
          {subTabButton('done', `已完成（${doneRequirementsAll.length}）`)}
        </span>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          待办 {snap.counts.pending} ｜ 进行中 {snap.counts.inProgress} ｜ 已完成 {snap.counts.completed} ｜
          运行 {snap.counts.running} ｜ 排队 {snap.counts.queued}
        </span>
        <button
          style={{ ...buttonStyle, marginLeft: 'auto' }}
          disabled={busy}
          onClick={() => {
            void Promise.resolve(props.onRefresh())
          }}
        >
          刷新
        </button>
      </div>

      {msg && (
        <div style={{ marginBottom: 10, fontSize: 13, color: msgColor, whiteSpace: 'pre-wrap' }}>{msg.text}</div>
      )}

      {viewTab === 'active' && snap.version === 0 && requirements.length === 0 && (
        <div style={{ ...sectionStyle, color: '#6b7280', fontSize: 13 }}>
          看板为空。请到「需求池」按工作项 ID 领取需求，再回到此处拆解为任务。
        </div>
      )}

      {viewTab === 'active' && activeRequirements.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            已领取需求（{activeRequirements.length}）
            {/* 问题 3：已完成需求从这里"搬走"了，明确告知搬到哪 —— 否则用户以为记录丢了。 */}
            {doneRequirementsAll.length > 0 && (
              <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>
                ｜ {doneRequirementsAll.length} 条已完成在「已完成」页
              </span>
            )}
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                  <th style={cellStyle}>去重键</th>
                  <th style={cellStyle}>标题</th>
                  {/* 问题 4：需求行此前只有 TFS 状态，本地执行进度看不见。 */}
                  <th style={cellStyle}>执行状态</th>
                  <th style={cellStyle}>TFS 状态</th>
                  <th style={cellStyle}>标签</th>
                  <th style={cellStyle} />
                </tr>
              </thead>
              <tbody>
                {pageRequirements.map(r => {
                  const key = `${r.id}@${r.collection}`
                  const ownTasks = tasks.filter(t => t.requirementId === key)
                  const activeCount = ownTasks.filter(t => t.state !== 'deleted').length
                  const deletedCount = ownTasks.length - activeCount
                  return (
                    <tr key={key}>
                      <td style={cellStyle}>{key}</td>
                      <td style={{ ...cellStyle, maxWidth: 320 }} title={r.title}>
                        {(() => {
                          const href = workItemUrlOf(r)
                          return href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer noopener"
                              style={{ color: '#2563eb', textDecoration: 'none' }}
                              title={`在 TFS 中打开需求 #${r.id}：${href}`}
                            >
                              {r.title}
                              <span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>↗</span>
                            </a>
                          ) : (
                            <span>{r.title}</span>
                          )
                        })()}
                        {/* 问题 3：把已设的提示词/工作目录露出来，否则用户不知道"编辑过了没有"。 */}
                        {r.prompt && (
                          <div style={{ color: '#6d28d9', fontSize: 11 }} title={r.prompt}>
                            提示词：{r.prompt.slice(0, 40)}
                            {r.prompt.length > 40 ? '…' : ''}
                          </div>
                        )}
                        {r.workspace && (
                          <div style={{ color: '#9ca3af', fontSize: 11 }} title={r.workspace}>
                            工作目录：{r.workspace}
                          </div>
                        )}
                      </td>
                      {/* 问题 4：执行状态（由任务集合派生：未拆解/执行中/有失败/待办/已完成 c/t）。 */}
                      <td style={cellStyle}>
                        {(() => {
                          const s = summarizeRequirementExec(r, ownTasks)
                          const st = REQ_EXEC_STYLE[s.tone]
                          return <Pill text={s.text} color={st.color} bg={st.bg} />
                        })()}
                      </td>
                      <td style={cellStyle}>{r.state}</td>
                      <td style={cellStyle}>{r.tags.join('、') || '-'}</td>
                      <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                        <button
                          style={{ ...buttonStyle, marginRight: 6 }}
                          disabled={busy}
                          onClick={() =>
                            run(
                              () => props.onDecompose(key),
                              `已拆解 ${key}`,
                              { resetTaskPage: true },
                            )
                          }
                          title="重新拆解会把已取消的任务原地重建为全新待办任务；在办/已完成任务跳过"
                        >
                          {ownTasks.length > 0
                            ? `重新拆解（在办 ${activeCount}${deletedCount ? ` / 已取消 ${deletedCount}` : ''}）`
                            : '拆解为任务'}
                        </button>
                        {props.onSelectRequirement && (
                          <button style={{ ...buttonStyle, marginRight: 6 }} onClick={() => props.onSelectRequirement?.(r)}>
                            选为目标
                          </button>
                        )}
                        {/* 问题 3：编辑已领取需求（提示词 / 工作目录）。 */}
                        {props.onUpdateRequirement && (
                          <button
                            style={{ ...buttonStyle, marginRight: 6 }}
                            disabled={busy}
                            title="编辑该需求的提示词与工作目录"
                            onClick={() => setReqEdit(r)}
                          >
                            编辑
                          </button>
                        )}
{/*
           * 「标记完成」：把「全部任务已取消」的需求收进「已完成」页。
           *
           * 看板引擎的 `isRequirementAllTasksDone` 要求**至少一个**任务 completed 才允许自动
           * 收口，于是"名下任务全被取消"的需求会永远停在进行中（执行状态显示「已全部取消」）。
           * 手动入口此前不存在：`SetRequirementExecStateInput.state` 的契约支持 `'completed'`，
           * 但 UI 只调过 `'active'`，这条需求因此无法归档——只能一直挂着，或手工去改 board.json。
           * 条件与"可还原"按钮同源（无未取消任务且至少有一个已取消任务），两者互斥。
           */}
          {props.onSetRequirementExecState && activeCount === 0 && deletedCount > 0 && (
            <button
              style={{ ...buttonStyle, marginRight: 6 }}
              disabled={busy}
              title="全部任务都已取消：手动确认需求已处理完，归入「已完成」页（可再「取消完成」撤回）"
              onClick={() => void setReqExecState(key, 'completed')}
            >
              标记完成
            </button>
          )}
          {props.onRestore && (
            <button
              style={dangerButtonStyle}
              disabled={busy || activeCount > 0}
                            title={activeCount > 0 ? '仍有未取消的任务，无法还原' : '还原到需求池（清理已取消任务）'}
                            onClick={() => void restore(key)}
                          >
                            还原到需求池
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
          <PaginationBar
            label="已领取需求"
            total={activeRequirements.length}
            page={claimedPaging.page}
            pageCount={claimedPaging.pageCount}
            pageSize={claimedPageSize}
            pageSizeOptions={CLAIMED_PAGE_SIZE_OPTIONS}
            onPageChange={claimedPaging.setPage}
            onPageSizeChange={size => {
              setClaimedPageSize(size)
              claimedPaging.resetPage()
              persistPageSize({ claimedPageSize: size })
            }}
          />
        </div>
      )}

      {/* 问题 3：筛选条与任务表只服务「进行中」页；已完成需求的任务改在已完成页按焦点需求查看。 */}
      {viewTab === 'active' && (
      <div style={sectionStyle}>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select
            style={inputStyle}
            value={stateFilter}
            onChange={e => {
              setStateFilter(e.target.value)
              taskPaging.resetPage()
            }}
          >
            <option value="">全部状态</option>
            <option value="pending">待办</option>
            <option value="in_progress">进行中</option>
            <option value="completed">已完成</option>
            <option value="deleted">已取消</option>
          </select>
          <select
            style={inputStyle}
            value={roleFilter}
            onChange={e => {
              setRoleFilter(e.target.value)
              taskPaging.resetPage()
            }}
          >
            <option value="">全部角色</option>
            {roles.map(r => (
              <option key={r.id} value={r.name}>
                {r.name}
              </option>
            ))}
          </select>
          <select
            style={inputStyle}
            value={requirementFilter}
            onChange={e => {
              setRequirementFilter(e.target.value)
              taskPaging.resetPage()
            }}
          >
            <option value="">全部需求</option>
            {activeRequirements.map(r => (
              <option key={`${r.id}@${r.collection}`} value={`${r.id}@${r.collection}`}>
                {r.id} {r.title.slice(0, 24)}
              </option>
            ))}
          </select>
          <input
            style={inputStyle}
            placeholder="标题/任务 ID 关键字"
            value={keyword}
            onChange={e => {
              setKeyword(e.target.value)
              taskPaging.resetPage()
            }}
          />
          <span style={{ fontSize: 12, color: '#6b7280' }}>
            命中 {filtered.length} / 共 {activeTasks.length}
          </span>
        </div>
        {/* 问题 8：批量删除已取消任务的操作条。 */}
        {props.onDeleteTasks && selectedDeleted.size > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
              padding: '6px 10px',
              background: '#fef2f2',
              border: '1px solid #fecaca',
              borderRadius: 6,
              fontSize: 12,
              color: '#b91c1c',
            }}
          >
            <span>已选 {selectedDeleted.size} 个已取消任务</span>
            <button style={dangerButtonStyle} disabled={busy} onClick={() => void deleteTasks([...selectedDeleted])}>
              批量删除
            </button>
            <button style={buttonStyle} onClick={() => setSelectedDeleted(new Set())}>
              清空选择
            </button>
          </div>
        )}
        {/* 问题 5：勾选批量派发的操作条（依赖顺序由编排层保证）。 */}
        {props.onDispatchBatch && selectedTasks.size > 0 && (
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 10,
              marginTop: 8,
              padding: '6px 10px',
              background: '#eff6ff',
              border: '1px solid #bfdbfe',
              borderRadius: 6,
              fontSize: 12,
              color: '#1d4ed8',
            }}
          >
            <span>已选 {selectedTasks.size} 个任务</span>
            <button
              style={{ ...buttonStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }}
              disabled={busy || orchestrationBlocked}
              title={
                orchestrationBlocked
                  ? `派发已被前置阻断：${props.orchestration?.reason ?? '编排能力不可用'}`
                  : '按 DAG 分波派发：依赖未完成的任务会等到依赖完成后再开始'
              }
              onClick={() => void dispatchBatch()}
            >
              批量派发执行
            </button>
            <button style={buttonStyle} disabled={busy} onClick={() => setSelectedTasks(new Set())}>
              清空选择
            </button>
            {props.batchProgress && <span style={{ color: '#1e40af' }}>{props.batchProgress}</span>}
          </div>
        )}
      </div>
      )}

      {viewTab === 'active' && activeTasks.length > 0 && (
        <div style={sectionStyle}>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                  {/* 问题 8：表头全选（作用域 = 当前筛选命中的全部已取消任务）。 */}
                  {props.onDeleteTasks && (
                    <th style={{ ...cellStyle, width: 32 }}>
                      <input
                        type="checkbox"
                        aria-label="全选当前筛选下的已取消任务"
                        checked={allDeletedChecked}
                        disabled={pageDeletedIds.length === 0}
                        onChange={e => toggleAllDeleted(e.target.checked)}
                      />
                    </th>
                  )}
                  {/* 问题 5：勾选列（作用域 = 当前筛选下的可派发任务，不仅是当前页）。 */}
                  {props.onDispatchBatch && (
                    <th style={{ ...cellStyle, width: 32 }}>
                      <input
                        type="checkbox"
                        aria-label="全选当前筛选下可派发的任务"
                        checked={allTasksChecked}
                        disabled={pageDispatchableIds.length === 0}
                        onChange={e => toggleAllTasks(e.target.checked)}
                      />
                    </th>
                  )}
                  <th style={cellStyle}>任务</th>
                  <th style={cellStyle}>需求</th>
                  <th style={cellStyle}>状态</th>
                  <th style={cellStyle}>执行</th>
                  <th style={cellStyle}>工作目录</th>
                  <th style={cellStyle}>角色</th>
                  <th style={cellStyle}>依赖</th>
                  <th style={cellStyle}>尝试</th>
                  <th style={cellStyle} />
                </tr>
              </thead>
              <tbody>
                {pageTasks.map(t => {
                  const st = STATE_STYLE[t.state] ?? { color: '#374151', bg: '#f3f4f6', label: t.state }
                  const ex = EXEC_STYLE[t.execState] ?? { color: '#374151', label: t.execState }
                  const waiting = t.state === 'pending' && t.blockedBy.length > 0
                  const deletable = t.state === 'deleted' && !!props.onDeleteTasks
                  const dispatchable = (t.state === 'pending' || t.state === 'in_progress') && !!props.onDispatchBatch
                  return (
                    <tr key={t.taskId} style={t.state === 'deleted' ? { color: '#9ca3af' } : undefined}>
                      {props.onDeleteTasks && (
                        <td style={cellStyle}>
                          {deletable && (
                            <input
                              type="checkbox"
                              aria-label={`选择已取消任务 ${t.taskId}`}
                              checked={selectedDeleted.has(t.taskId)}
                              onChange={e => toggleDeleted(t.taskId, e.target.checked)}
                            />
                          )}
                        </td>
                      )}
                      {props.onDispatchBatch && (
                        <td style={cellStyle}>
                          {dispatchable && (
                            <input
                              type="checkbox"
                              aria-label={`选择待派发任务 ${t.taskId}`}
                              checked={selectedTasks.has(t.taskId)}
                              disabled={busy}
                              onChange={e => toggleTask(t.taskId, e.target.checked)}
                            />
                          )}
                        </td>
                      )}
                      <td style={cellStyle}>
                        <div style={{ display: 'flex', alignItems: 'baseline', gap: 4 }}>
                          {props.onGetTaskTrace ? (
                            <button
                              type="button"
                              onClick={() => setDetailTaskId(t.taskId)}
                              title="查看任务执行过程详情（技能/MCP/工具调用时间线、失败原因、追问）"
                              style={{
                                background: 'none',
                                border: 'none',
                                padding: 0,
                                margin: 0,
                                textAlign: 'left',
                                font: 'inherit',
                                fontWeight: 600,
                                color: '#1d4ed8',
                                cursor: 'pointer',
                                textDecoration: 'underline',
                                textDecorationStyle: 'dotted',
                                textUnderlineOffset: 3,
                              }}
                            >
                              {t.title}
                            </button>
                          ) : (
                            <div>{t.title}</div>
                          )}
                        </div>
                        <div style={{ color: '#9ca3af', fontSize: 11 }}>
                          {t.taskId}
                          {/* 问题 6：由宿主收口钩子自动拉起的任务打标，和用户手动派发区分开。 */}
                          {t.autoLaunched && (
                            <span
                              title="上游任务完成后由宿主自动启动（自动链式执行）"
                              style={{
                                display: 'inline-block',
                                marginLeft: 6,
                                padding: '0 5px',
                                borderRadius: 4,
                                background: '#ecfdf5',
                                color: '#047857',
                                fontSize: 10,
                              }}
                            >
                              自动
                            </span>
                          )}
                          {t.lastNote ? ` ｜ ${t.lastNote}` : ''}
                        </div>
                        {/* 问题 5：待人工确认时在标题下给醒目条，提示必须人工放行，不会自动进入下游。 */}
                        {t.state === 'in_progress' && t.execState === 'needs_confirmation' && (
                          <div
                            style={{
                              marginTop: 3,
                              padding: '2px 6px',
                              borderRadius: 4,
                              background: '#fff7ed',
                              border: '1px solid #fed7aa',
                              color: '#c2410c',
                              fontSize: 11,
                            }}
                            title={t.lastNote ?? '子代理提示需要人工确认'}
                          >
                            待人工确认：{stripConfirmPrefix(t.lastNote) || '子代理已产出结论，请人工核对后点「确认通过」'}
                          </div>
                        )}
                        {/* 问题 4：把已设的任务级提示词露出来（否则用户看不出"编辑过没有"）。 */}
                        {t.prompt && (
                          <div style={{ color: '#6d28d9', fontSize: 11 }} title={t.prompt}>
                            提示词：{t.prompt.slice(0, 40)}
                            {t.prompt.length > 40 ? '…' : ''}
                          </div>
                        )}
                        <div style={{ color: '#9ca3af', fontSize: 10 }}>
                          模型 {t.frozenConfig.model ? formatModelRoute(props.modelOptions, t.frozenConfig.model, t.frozenConfig.modelProvider) : '（默认）'}
                          {t.frozenConfig.skills.length > 0 ? ` ｜ 技能 ${t.frozenConfig.skills.length}` : ''}
                          {t.frozenConfig.mcp.length > 0 ? ` ｜ MCP ${t.frozenConfig.mcp.join('、')}` : ''}
                        </div>
                      </td>
                      {/* 需求列 → 所属需求的 TFS 页（任务本身在 TFS 上没有工作项）。 */}
                      <td style={cellStyle}>
                        {(() => {
                          const href = workItemUrlOf(requirementByKey.get(t.requirementId))
                          return href ? (
                            <a
                              href={href}
                              target="_blank"
                              rel="noreferrer noopener"
                              style={{ color: '#2563eb', textDecoration: 'none' }}
                              title={`在 TFS 中打开需求 ${t.requirementId}：${href}`}
                            >
                              {t.requirementId}
                              <span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>↗</span>
                            </a>
                          ) : (
                            t.requirementId
                          )
                        })()}
                      </td>
                      <td style={cellStyle}>
                        <Pill text={st.label} color={st.color} bg={st.bg} />
                      </td>
                      <td style={cellStyle}>
                        <Pill
                          text={ex.label}
                          color={ex.color}
                          bg={t.execState === 'failed' ? '#fee2e2' : t.execState === 'running' ? '#dbeafe' : '#f3f4f6'}
                        />
                        {waiting && (
                          <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
                            等待依赖（{t.blockedBy.length}）
                          </div>
                        )}
                      </td>
                      <td style={{ ...cellStyle, maxWidth: 200 }}>
                        {t.workspace ? (
                          <span
                            title={t.workspace}
                            style={{
                              display: 'inline-block',
                              maxWidth: 190,
                              overflow: 'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace: 'nowrap',
                              verticalAlign: 'bottom',
                              fontFamily: 'monospace',
                              fontSize: 11,
                              color: '#374151',
                            }}
                          >
                            {t.workspace}
                          </span>
                        ) : (
                          <span style={{ color: '#9ca3af', fontSize: 11 }}>未接线</span>
                        )}
                      </td>
                      <td style={cellStyle}>
                        <select
                          style={{ ...inputStyle, padding: '2px 4px', fontSize: 11 }}
                          value={t.roleAgent}
                          disabled={busy || t.state === 'completed' || t.state === 'deleted'}
                          onChange={e =>
                            run(() => props.onAssign(t.taskId, e.target.value), `已改派 ${t.taskId} → ${e.target.value}`)
                          }
                        >
                          {!roles.some(r => r.name === t.roleAgent) && <option value={t.roleAgent}>{t.roleAgent}（未知）</option>}
                          {roles.map(r => (
                            <option key={r.id} value={r.name}>
                              {r.name}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td style={cellStyle}>{t.blockedBy.join(', ') || '-'}</td>
                      <td style={cellStyle}>{t.attemptCount}</td>
                      <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                        {/* 问题 3：未执行 / 失败 / 待确认任务可就地编辑（提示词/模型/预设/技能/MCP/预算）。 */}
                        {props.onUpdateTask && taskEditable(t) && (
                          <button
                            style={{ ...buttonStyle, marginRight: 4 }}
                            disabled={busy}
                            title="编辑该任务的提示词、模型、预设、技能、MCP 与执行预算"
                            onClick={() => setTaskEdit(t)}
                          >
                            编辑
                          </button>
                        )}
                        {props.onDispatchTask && (t.state === 'pending' || t.state === 'in_progress') && (
                          <button
                            style={{ ...buttonStyle, marginRight: 4, background: '#eff6ff', borderColor: '#93c5fd' }}
                            disabled={busy || orchestrationBlocked}
                            title={
                              orchestrationBlocked
                                ? `派发已被前置阻断：${props.orchestration?.reason ?? '编排能力不可用'}`
                                : undefined
                            }
                            onClick={() =>
                              run(
                                () => props.onDispatchTask!(t),
                                `已派发 ${t.taskId} → ${t.roleAgent}（run 结束后自动回写看板）`,
                              )
                            }
                          >
                            派发执行
                          </button>
                        )}
                        {actionsFor(t).map(a => (
                          <button
                            key={a}
                            style={{ ...buttonStyle, marginRight: 4 }}
                            disabled={busy}
                            onClick={() =>
                              run(
                                () => props.onTaskState(t.taskId, a, t.revision),
                                `${actionLabel(a, t.state)}：${t.taskId} 已更新`,
                              )
                            }
                          >
                            {actionLabel(a, t.state)}
                          </button>
                        ))}
                        {deletable && (
                          <button
                            style={{ ...dangerButtonStyle, marginRight: 4 }}
                            disabled={busy}
                            title="删除该已取消任务（同时清理依赖引用）"
                            onClick={() => void deleteTasks([t.taskId])}
                          >
                            删除
                          </button>
                        )}
                      </td>
                    </tr>
                  )
                })}
                {pageTasks.length === 0 && (
                  <tr>
                    <td
                      colSpan={9 + (props.onDeleteTasks ? 1 : 0) + (props.onDispatchBatch ? 1 : 0)}
                      style={{ ...cellStyle, color: '#9ca3af', textAlign: 'center', padding: 16 }}
                    >
                      当前筛选无任务
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          <PaginationBar
            label="任务"
            total={filtered.length}
            page={taskPaging.page}
            pageCount={taskPaging.pageCount}
            pageSize={taskPageSize}
            pageSizeOptions={TASK_PAGE_SIZE_OPTIONS}
            onPageChange={taskPaging.setPage}
            onPageSizeChange={size => {
              setTaskPageSize(size)
              taskPaging.resetPage()
              persistPageSize({ taskPageSize: size })
            }}
          />
        </div>
      )}

      {/* ───────── 问题 2：已完成页 ─────────
          上表 = 已完成需求（按需求 ID / 标题检索 + 分页）；下表 = 焦点需求的任务（点任务名看执行过程）。
          问题 3：这些需求与其任务在「进行中」页已被整体隐藏。 */}
      {viewTab === 'done' && (
        <div style={sectionStyle}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            <div style={{ fontSize: 13, fontWeight: 600 }}>已完成需求（{doneRequirementsAll.length}）</div>
            <input
              style={{ ...inputStyle, minWidth: 220 }}
              placeholder="按需求 ID 或标题检索…"
              aria-label="检索已完成需求"
              value={doneKeyword}
              onChange={e => {
                setDoneKeyword(e.target.value)
                // 命中集合变了 ⇒ 页码回第 1 页；焦点需求若不在命中里由派生层自动回落。
                donePaging.resetPage()
              }}
            />
            <span style={{ fontSize: 12, color: '#6b7280' }}>命中 {doneRequirements.length}</span>
            <span style={{ fontSize: 12, color: '#6b7280', marginLeft: 'auto' }}>
              全部任务完成后自动迁入；点「取消完成」退回「进行中」
            </span>
          </div>

          {doneRequirementsAll.length === 0 ? (
            <div style={{ fontSize: 13, color: '#6b7280', padding: 12 }}>
              暂无已完成需求。一条需求名下的任务全部完成后，它会自动出现在这里。
            </div>
          ) : (
            <>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                  <thead>
                    <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                      <th style={cellStyle}>去重键</th>
                      <th style={cellStyle}>标题</th>
                      <th style={cellStyle}>执行状态</th>
                      <th style={cellStyle}>完成时间</th>
                      <th style={cellStyle}>标签</th>
                      <th style={cellStyle} />
                    </tr>
                  </thead>
                  <tbody>
                    {pageDone.map(r => {
                      const key = `${r.id}@${r.collection}`
                      const ownTasks = tasks.filter(t => t.requirementId === key)
                      const isFocus = key === focusRequirementKey
                      return (
                        <tr
                          key={key}
                          onClick={() => setFocusKey(key)}
                          title="点击选中：下方显示该需求的任务"
                          style={{ cursor: 'pointer', background: isFocus ? '#f0f9ff' : undefined }}
                        >
                          <td style={cellStyle}>{key}</td>
                          <td style={{ ...cellStyle, maxWidth: 320 }} title={r.title}>
                            {(() => {
                              const href = workItemUrlOf(r)
                              return href ? (
                                <a
                                  href={href}
                                  target="_blank"
                                  rel="noreferrer noopener"
                                  style={{ color: '#2563eb', textDecoration: 'none' }}
                                  title={`在 TFS 中打开需求 #${r.id}：${href}`}
                                  onClick={e => e.stopPropagation()}
                                >
                                  {r.title}
                                  <span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>↗</span>
                                </a>
                              ) : (
                                <span>{r.title}</span>
                              )
                            })()}
                            {r.workspace && (
                              <div style={{ color: '#9ca3af', fontSize: 11 }} title={r.workspace}>
                                工作目录：{r.workspace}
                              </div>
                            )}
                          </td>
                          <td style={cellStyle}>
                            {(() => {
                              const s = summarizeRequirementExec(r, ownTasks)
                              const st = REQ_EXEC_STYLE[s.tone]
                              return <Pill text={s.text} color={st.color} bg={st.bg} />
                            })()}
                          </td>
                          <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                            {r.completedAt ? new Date(r.completedAt).toLocaleString() : '-'}
                          </td>
                          <td style={cellStyle}>{r.tags.join('、') || '-'}</td>
                          <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                            {props.onSelectRequirement && (
                              <button
                                style={{ ...buttonStyle, marginRight: 6 }}
                                onClick={e => {
                                  e.stopPropagation()
                                  props.onSelectRequirement?.(r)
                                }}
                              >
                                选为目标
                              </button>
                            )}
                            {/* 问题 5：已完成需求**先取消完成**，之后才允许还原到需求池。 */}
                            {/*
                         * 回写状态与手动重跑入口。
                         *
                         * 报告此前完全不渲染：`partial` / `error` 的需求看不出哪几项
                         * 失败，而 `HostBridge.writeBackRequirement` 没有任何调用方，
                         * 等于自动回写失败后既无诊断也无补救手段（`autoWriteBack:false`
                         * 时更是连入口都没有）。失败项明细放在 title 里，不额外占一列。
                         */}
                        {r.writeBack && (
                          <span
                            style={{
                              fontSize: 11,
                              marginRight: 6,
                              color: WRITEBACK_TONE[r.writeBack.status].color,
                            }}
                            title={
                              r.writeBack.items
                                .filter(i => i.status !== 'ok')
                                .map(i => `${i.target}：${i.reason ?? i.status}`)
                                .join('\n') || r.writeBack.summary || ''
                            }
                          >
                            回写 {WRITEBACK_TONE[r.writeBack.status].label}
                          </span>
                        )}
                        {props.onWriteBackRequirement && r.writeBack && r.writeBack.status !== 'ok' && (
                          <button
                            style={{ ...buttonStyle, marginRight: 6 }}
                            disabled={busy}
                            title="重跑需求完成回写：只补上次未成功的项，已成功的字段/评论/附件不会重复写入"
                            onClick={e => {
                              e.stopPropagation()
                              void writeBackRequirement(key)
                            }}
                          >
                            重新回写
                          </button>
                        )}                        {props.onSetRequirementExecState && (
                              <button
                                style={{ ...buttonStyle, marginRight: 6 }}
                                disabled={busy}
                                title="取消完成：该需求退回「进行中」页；之后可取消其任务并还原到需求池"
                                onClick={e => {
                                  e.stopPropagation()
                                  void setReqExecState(key, 'active')
                                }}
                              >
                                取消完成
                              </button>
                            )}
                            {props.onRestore && (
                              <button
                                style={dangerButtonStyle}
                                // 问题 5 的护栏：已完成需求禁止直接还原（避免一步抹掉一次已完成的交付）。
                                disabled
                                title="已完成需求不可直接还原：请先点「取消完成」退回进行中，再取消其任务后还原"
                                onClick={e => e.stopPropagation()}
                              >
                                还原到需求池
                              </button>
                            )}
                          </td>
                        </tr>
                      )
                    })}
                    {pageDone.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ ...cellStyle, color: '#9ca3af', textAlign: 'center', padding: 16 }}>
                          当前检索无匹配的已完成需求
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
              <PaginationBar
                label="已完成需求"
                total={doneRequirements.length}
                page={donePaging.page}
                pageCount={donePaging.pageCount}
                pageSize={donePageSize}
                pageSizeOptions={CLAIMED_PAGE_SIZE_OPTIONS}
                onPageChange={donePaging.setPage}
                onPageSizeChange={size => {
                  setDonePageSize(size)
                  donePaging.resetPage()
                  persistPageSize({ donePageSize: size })
                }}
              />
            </>
          )}
        </div>
      )}

      {/* 已完成页下半：焦点需求的任务（问题 2「下面列表显示当前焦点行需求的对应的任务」）。 */}
      {viewTab === 'done' && focusRequirement && (
        <div style={sectionStyle}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            需求 {focusRequirementKey} 的任务（{focusTasks.length}）
            <span style={{ fontWeight: 400, color: '#6b7280', marginLeft: 6 }}>
              ｜ 点任务名查看执行过程（工具调用时间线 / 失败原因 / 追问）
            </span>
          </div>
          {focusTasks.length === 0 ? (
            <div style={{ fontSize: 12, color: '#9ca3af', padding: 8 }}>该需求下暂无任务记录。</div>
          ) : (
            <div style={{ overflowX: 'auto' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                <thead>
                  <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                    <th style={cellStyle}>任务</th>
                    <th style={cellStyle}>状态</th>
                    <th style={cellStyle}>执行</th>
                    <th style={cellStyle}>角色</th>
                    <th style={cellStyle}>尝试</th>
                    <th style={cellStyle}>
                      <span style={{ fontWeight: 400 }}>执行过程</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {focusTasks.map(t => {
                    const st = STATE_STYLE[t.state] ?? { color: '#374151', bg: '#f3f4f6', label: t.state }
                    const ex = EXEC_STYLE[t.execState] ?? { color: '#374151', label: t.execState }
                    return (
                      <tr key={t.taskId}>
                        <td style={cellStyle}>
                          <div style={{ fontWeight: 600 }}>{t.title}</div>
                          <div style={{ color: '#9ca3af', fontSize: 11 }}>{t.taskId}</div>
                          {t.lastNote && (
                            <div style={{ color: '#9ca3af', fontSize: 11 }} title={t.lastNote}>
                              {t.lastNote.slice(0, 60)}
                            </div>
                          )}
                        </td>
                        <td style={cellStyle}>
                          <Pill text={st.label} color={st.color} bg={st.bg} />
                        </td>
                        <td style={cellStyle}>
                          <Pill
                            text={ex.label}
                            color={ex.color}
                            bg={t.execState === 'failed' ? '#fee2e2' : t.execState === 'running' ? '#dbeafe' : '#f3f4f6'}
                          />
                        </td>
                        <td style={cellStyle}>{t.roleAgent || '-'}</td>
                        <td style={cellStyle}>{t.attemptCount}</td>
                        <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                          {props.onGetTaskTrace ? (
                            <button
                              style={{ ...buttonStyle, marginRight: 4 }}
                              title="查看该任务的执行过程（技能/MCP/工具调用时间线）"
                              onClick={() => setDetailTaskId(t.taskId)}
                            >
                              查看执行过程
                            </button>
                          ) : (
                            <span style={{ color: '#9ca3af', fontSize: 11 }}>宿主未提供轨迹服务</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* 问题 3：已领取需求编辑弹框（提示词 / 工作目录） */}
      {reqEdit && (
        <RequirementEditDialog
          requirement={reqEdit}
          workspaces={props.workspaces ?? []}
          busy={busy}
          onCancel={() => setReqEdit(null)}
          onSave={patch => void saveRequirement(`${reqEdit.id}@${reqEdit.collection}`, patch)}
        />
      )}

      {/* 问题 4：任务编辑弹框（提示词 / 模型 / 技能 / MCP / 工作目录） */}
      {taskEdit && (
        <TaskEditDialog
          task={taskEdit}
          workspaces={props.workspaces ?? []}
          modelOptions={props.modelOptions ?? []}
          skillOptions={props.skillOptions ?? []}
          mcpServers={props.mcpServers ?? []}
          presets={props.presets ?? []}
          busy={busy}
          onCancel={() => setTaskEdit(null)}
          onSave={input => void saveTask(input)}
        />
      )}

      {/* spec 006 US2/US3：任务执行详情弹层（过程时间线 + 失败原因 + 二次对话追问） */}
      {detailTask && props.onGetTaskTrace && (
        <TaskDetailDialog
          task={detailTask}
          onClose={() => setDetailTaskId(null)}
          onGetTrace={props.onGetTaskTrace}
          onFollowUp={async input => {
            if (!props.onFollowUpTask) return { ok: false as const, reason: '当前宿主不支持追问' }
            return props.onFollowUpTask(input)
          }}
          onFollowedUp={async () => {
            await props.onRefresh()
          }}
          // 问题 5：待人工确认时在详情弹层显式放行（置成功 → 宿主自动拉起下游任务）。
          onConfirm={async () => {
            const r = await props.onTaskState(detailTask.taskId, 'confirm', detailTask.revision)
            return { ok: r.ok, reason: r.reason }
          }}
        />
      )}
    </div>
  )
}

export default TaskCenter

// ───────────────────────── 编辑弹框（问题 3 / 4） ─────────────────────────
//
// 两个弹框都是**纯展示 + 一次性提交**：打开时用传入对象的初值初始化本地 state，
// 点保存才调回调。刻意**不**做"随 props 变化同步 draft"——异步目录到达后写回 state
// 会顶掉用户正在输入的内容（项目既有纪律：只读侧回落，不在 effect 里覆盖用户输入）。

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(0,0,0,0.35)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 60,
}
const dialogStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 10,
  padding: 18,
  maxWidth: 640,
  width: '92%',
  maxHeight: '82vh',
  overflow: 'auto',
}
const fieldLabelStyle: React.CSSProperties = { display: 'block', fontSize: 12, color: '#6b7280', margin: '10px 0 4px' }
const fieldStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: 13,
}

/**
 * 需求编辑弹框（问题 3：已领取需求增加提示词、切换工作目录）。
 *
 * 只改**本地补充字段**：TFS 侧字段（标题/状态/标签）走执行配置页的「确认回写」，
 * 那里过写门禁与审计。弹框里明确写出这条边界，避免用户以为这里能改 TFS 上的东西。
 */
export function RequirementEditDialog(props: {
  requirement: RequirementSummary
  workspaces: DshWorkspaceOption[]
  busy: boolean
  onCancel: () => void
  onSave: (patch: { workspace?: string | null; prompt?: string | null }) => void
}): JSX.Element {
  const key = `${props.requirement.id}@${props.requirement.collection}`
  const [prompt, setPrompt] = useState(props.requirement.prompt ?? '')
  const [workspace, setWorkspace] = useState(props.requirement.workspace ?? '')
  const listed = props.workspaces.some(w => w.path === workspace)

  return (
    <div style={overlayStyle} onClick={props.onCancel}>
      <div style={dialogStyle} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>
          编辑需求：{props.requirement.id} {props.requirement.title}
        </h3>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {key} ｜ 只编辑本地补充字段（提示词/工作目录）；TFS 上的标题/状态/标签请用「执行配置 → 确认回写」（过写门禁）。
        </div>

        <label style={fieldLabelStyle}>增加提示词（需求级；派发该需求下任一任务时拼在任务提示词之前）</label>
        <textarea
          style={{ ...fieldStyle, minHeight: 110 }}
          placeholder="留空 = 清空该需求已有的提示词"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
        />

        <label style={fieldLabelStyle}>工作目录（由拆解出的任务继承；不改变子代理进程 cwd）</label>
        {props.workspaces.length > 0 && (
          <select style={{ ...fieldStyle, marginBottom: 6 }} value={listed ? workspace : ''} onChange={e => setWorkspace(e.target.value)}>
            <option value="">— 从 dsh 已添加的工作区选择 —</option>
            {props.workspaces.map(w => (
              <option key={w.id} value={w.path}>
                {w.title}
                {w.path ? `（${w.path}）` : ''}
              </option>
            ))}
          </select>
        )}
        <input
          style={fieldStyle}
          placeholder="绝对路径，如 D:\\code\\his；留空 = 清空"
          value={workspace}
          onChange={e => setWorkspace(e.target.value)}
        />
        {props.workspaces.length === 0 && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
            宿主未返回工作区清单（能力降级）：只能手填绝对路径。
          </div>
        )}

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            style={{ ...buttonStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }}
            disabled={props.busy}
            onClick={() => props.onSave({ prompt: prompt.trim() || null, workspace: workspace.trim() || null })}
          >
            保存
          </button>
          <button type="button" style={buttonStyle} disabled={props.busy} onClick={props.onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

/**
 * 任务编辑弹框（问题 4：拆解出的任务增加提示词、切换模型、选择技能/MCP）。
 *
 * 保存时带上 `expectedRevision`：宿主用乐观锁校验，冲突时返回可读原因
 * （"请刷新后重试"），不做自动覆盖（S-11）。
 */
export function TaskEditDialog(props: {
  task: BoardTaskView
  workspaces: DshWorkspaceOption[]
  modelOptions: DshModelOption[]
  skillOptions: DshSkillOption[]
  /** 宿主真实注册的 MCP server（问题 4）。 */
  mcpServers: string[]
  /** 问题 3：dsh 真实预设清单（任务级 preset；value 用 preset id）。 */
  presets: DshPresetOption[]
  busy: boolean
  onCancel: () => void
  onSave: (input: UpdateTaskInput) => void
}): JSX.Element {
  const t = props.task
  const [prompt, setPrompt] = useState(t.prompt ?? '')
  const [workspace, setWorkspace] = useState(t.workspace ?? '')
  // spec 009：下拉 value 为 (provider,id) 复合值；历史任务只有裸 id 时保留裸值（=未绑定供应商）。
  const [modelValue, setModelValue] = useState(
    t.frozenConfig.model
      ? (t.frozenConfig.modelProvider
          ? modelOptionValue(t.frozenConfig.modelProvider, t.frozenConfig.model)
          : t.frozenConfig.model)
      : '',
  )
  const [skills, setSkills] = useState<string[]>(t.frozenConfig.skills)
  const [mcp, setMcp] = useState<string[]>(t.frozenConfig.mcp)
  // 问题 3：任务级预设（preset）。
  const [preset, setPreset] = useState<string>(t.frozenConfig.preset ?? '')
  // 问题 1：执行预算（留空 = 不限制/沿用默认；整体替换冻结配置，留空即移除该上限）。
  const [maxDepth, setMaxDepth] = useState<string>(
    t.frozenConfig.maxDepth && t.frozenConfig.maxDepth > 0 ? String(t.frozenConfig.maxDepth) : '',
  )
  const [maxTokens, setMaxTokens] = useState<string>(
    t.frozenConfig.maxTokens && t.frozenConfig.maxTokens > 0 ? String(t.frozenConfig.maxTokens) : '',
  )

  /** 模型按 provider 分组（spec 009：分组/去重复用 shared/model-route.ts）。 */
  const groupedModels = useMemo(() => groupModelOptions(props.modelOptions), [props.modelOptions])
  /** 历史裸值兼容：残留裸 id 时追加一项，显式标注"未绑定供应商"。 */
  const legacyModel =
    modelValue && !parseModelOptionValue(modelValue)
      ? { value: modelValue, label: `${modelValue}（未绑定供应商，沿用会话供应商）` }
      : undefined
  const modelRoute = decodeModelValue(modelValue)

  const listed = props.workspaces.some(w => w.path === workspace)

  return (
    <div style={overlayStyle} onClick={props.onCancel}>
      <div style={dialogStyle} onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: '0 0 6px' }}>编辑任务：{t.title}</h3>
        <div style={{ fontSize: 12, color: '#6b7280' }}>
          {t.taskId} ｜ revision {t.revision} ｜ 依赖 {t.blockedBy.join('、') || '无'}
        </div>

        <label style={fieldLabelStyle}>增加提示词（任务级；留空时派发用「需求提示词 + 标题/描述」）</label>
        <textarea
          style={{ ...fieldStyle, minHeight: 110 }}
          placeholder="例：只跑单元测试并给出失败用例清单；不要动 public API。"
          value={prompt}
          onChange={e => setPrompt(e.target.value)}
        />

        <label style={fieldLabelStyle}>工作目录（该任务；不改变子代理进程 cwd）</label>
        {props.workspaces.length > 0 && (
          <select style={{ ...fieldStyle, marginBottom: 6 }} value={listed ? workspace : ''} onChange={e => setWorkspace(e.target.value)}>
            <option value="">— 从 dsh 已添加的工作区选择 —</option>
            {props.workspaces.map(w => (
              <option key={w.id} value={w.path}>
                {w.title}
                {w.path ? `（${w.path}）` : ''}
              </option>
            ))}
          </select>
        )}
        <input style={fieldStyle} placeholder="绝对路径；留空 = 清空" value={workspace} onChange={e => setWorkspace(e.target.value)} />

        <label style={fieldLabelStyle}>模型（写进冻结配置；供应商与模型成对冻结，spec 009）</label>
        <select style={fieldStyle} value={modelValue} onChange={e => setModelValue(e.target.value)}>
          <option value="">— 不指定（派发时取角色默认）—</option>
          {legacyModel && <option value={legacyModel.value}>{legacyModel.label}</option>}
          {groupedModels.map(g => (
            <optgroup key={g.provider} label={g.providerName}>
              {g.items.map(m => {
                const v = modelOptionValue(m.provider, m.id)
                return (
                  <option key={v} value={v}>
                    {m.name || m.id}
                  </option>
                )
              })}
            </optgroup>
          ))}
        </select>
        {groupedModels.length === 0 && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
            宿主未返回模型清单（能力降级）：请到「执行配置」点「重新采集目录」。
          </div>
        )}

        {/* 问题 3：任务级预设（preset）。 */}
        <label style={fieldLabelStyle}>预设（preset；不指定 = 沿用角色 / 会话预设）</label>
        <select style={fieldStyle} value={preset} onChange={e => setPreset(e.target.value)}>
          <option value="">— 不指定 —</option>
          {props.presets.map(p => (
            <option key={p.id} value={p.id} disabled={!!p.broken} title={p.broken ?? p.description}>
              {p.name}
              {p.isDefault ? '（默认）' : ''}
            </option>
          ))}
        </select>
        {props.presets.length === 0 && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
            宿主未返回预设清单（能力降级）：可到「执行配置」点「重新采集目录」。
          </div>
        )}

        <label style={fieldLabelStyle}>技能（写进冻结配置，当前可选 {dedupeOptions(props.skillOptions.map(s => ({ value: s.name, label: s.name }))).length} 项）</label>
        <MultiSelect
          options={props.skillOptions.map(s => ({
            value: s.name,
            label: s.name,
            hint: `${s.source}${s.modelInvocable ? ' · 模型可调用' : ''}`,
          }))}
          value={skills}
          onChange={setSkills}
          placeholder="未选择技能"
          searchPlaceholder="按技能名刷选…"
        />

        <label style={fieldLabelStyle}>MCP（写进冻结配置，当前可选 {props.mcpServers.length} 项）</label>
        <MultiSelect
          options={props.mcpServers.map(m => ({ value: m, label: m }))}
          value={mcp}
          onChange={setMcp}
          placeholder="未选择 MCP"
          searchPlaceholder="按 server 名刷选…"
        />

        {/* 问题 1：执行预算（硬限制在分发器层强制）。留空 = 不限制 / 沿用默认。 */}
        <label style={fieldLabelStyle}>执行预算（留空 = 不限制 / 沿用默认；用于抑制失控空转、降低 token）</label>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          <label style={{ fontSize: 12, color: '#4b5563' }}>
            最大委派深度&nbsp;
            <input
              type="number"
              min={0}
              step={1}
              style={{ ...fieldStyle, width: 110 }}
              placeholder="如 1"
              value={maxDepth}
              onChange={e => setMaxDepth(e.target.value)}
            />
          </label>
          <label style={{ fontSize: 12, color: '#4b5563' }}>
            单次最大输出 token&nbsp;
            <input
              type="number"
              min={0}
              step={1000}
              style={{ ...fieldStyle, width: 150 }}
              placeholder="如 20000"
              value={maxTokens}
              onChange={e => setMaxTokens(e.target.value)}
            />
          </label>
        </div>
        <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
          深度限制子代理再委派的层数（0/空 = 不限）；输出 token 限制单次模型回复上限（0/空 = 不限）。
        </div>

        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button
            type="button"
            style={{ ...buttonStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }}
            disabled={props.busy}
            onClick={() => {
              // 问题 1：预算仅在填了合法非负整数时写入；留空 = 整体替换后不含该键（= 不限制）。
              const depthNum = Number(maxDepth)
              const tokensNum = Number(maxTokens)
              props.onSave({
                taskId: t.taskId,
                prompt: prompt.trim() || null,
                workspace: workspace.trim() || null,
                // spec 009：model 与 modelProvider 成对提交；选"不指定"时显式传空串清空供应商。
                model: modelRoute?.id ?? '',
                modelProvider: modelRoute?.provider ?? '',
                skills,
                mcp,
                // 问题 3：预设（选"不指定"传空串，整体替换后清空）。
                preset: preset.trim(),
                ...(maxDepth.trim() !== '' && Number.isFinite(depthNum) && depthNum >= 0
                  ? { maxDepth: Math.floor(depthNum) }
                  : {}),
                ...(maxTokens.trim() !== '' && Number.isFinite(tokensNum) && tokensNum >= 0
                  ? { maxTokens: Math.floor(tokensNum) }
                  : {}),
                expectedRevision: t.revision,
              })
            }}
          >
            保存
          </button>
          <button type="button" style={buttonStyle} disabled={props.busy} onClick={props.onCancel}>
            取消
          </button>
        </div>
      </div>
    </div>
  )
}

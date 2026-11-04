// 需求池面板（US2 / FR-001…016，2026-09-20 问题 1/2/4/5/11 增强）。
//
// 职责：
//   - 从 TFS 拉候选需求（多值筛选：项目 / 工作项类型 / 状态 / 指派给），领取入本地池；
//   - 问题 1：筛选可选项**优先读本地落盘缓存**（query-options.json），不再每次切页/重开都打 TFS；
//     「采集可选项」按钮强制重采并覆盖落盘；
//   - 问题 2：记住上次筛选（团队项目/类型/状态/指派给），重开面板默认恢复（ui-state.json）；
//   - 问题 4：客户端分页，每页条数可选（10/20/50/100，默认 20），选择随 UI 状态落盘；
//   - 问题 11：详情展示四段正文（详细信息/需求分析/数据结构/需求配置）。
//
// 纯展示层：数据与动作经 props 注入（HostBridge → 宿主半），不直接 fetch。

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { MultiSelect } from './MultiSelect.js'
import { PaginationBar, POOL_PAGE_SIZE_OPTIONS } from './PaginationBar.js'
import { usePagination } from '../hooks/usePagination.js'
import { claimedKeysOf, shouldCacheQueryOptions } from '../../shared/pool.js'
import { buildWorkItemUrl } from '../../shared/workitem-url.js'
import type {
  DshWorkspaceOption,
  RequirementFilter,
  RequirementListResult,
  RequirementQueryOptions,
  RequirementSummary,
  NamedOption,
  UiState,
} from '../../shared/contracts.js'

/**
 * 领取弹框草稿缓存（2026-11-03 问题 2）。
 *
 * 弹框曾因遮罩 click（含"弹框内按下、遮罩上释放"的拖拽手势）被误关，已填内容
 * 随 openClaim 的重置一并丢失。现在按需求键缓存工作目录/提示词：误关、重开、
 * 甚至组件重挂载（模块级 Map 存活）都恢复得回来；领取成功才清除。
 */
const claimDrafts = new Map<string, { workspace: string; prompt: string }>()

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
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#f9fafb',
  cursor: 'pointer',
  fontSize: 13,
}
const cellStyle: React.CSSProperties = { padding: '6px 8px', borderBottom: '1px solid #f1f5f9', fontSize: 12 }

/**
 * 模块级可选项缓存（问题 1 的**第二道**缓存）。
 *
 * 权威缓存是宿主数据目录的 `query-options.json`（跨会话、跨面板挂载）；这里只做
 * 同会话内的去重，配合问题 3 的 Tab 保活后基本不再触发，保留可让保活前的旧路径也不重复请求。
 * key = 集合名。
 */
const optionsMemory = new Map<string, RequirementQueryOptions>()

/** 默认每页条数（问题 4；与宿主侧默认值、PaginationBar 档位保持一致）。 */
const DEFAULT_POOL_PAGE_SIZE = 20

/**
 * 需求池面板。
 * @param props.collection - 当前集合。
 * @param props.collections - 可切换集合清单。
 * @param props.onCollectionChange - 切集合。
 * @param props.listRequirements - 拉候选需求。
 * @param props.getQueryOptions - 取筛选可选项（宿主侧已改为读盘优先、未命中才采集并落盘）。
 * @param props.loadQueryOptions - 只读本地落盘可选项（问题 1，无缓存 data=null）。
 * @param props.loadUiState / saveUiState - 筛选记忆与每页条数持久化（问题 2/4）。
 * @param props.claimRequirement - 领取入池。
 * @param props.onClaimed - 领取成功回调（Workbench 刷新看板，问题 5 实时联动任务中心）。
 */
export function RequirementPool(props: {
  collection: string
  collections: string[]
  onCollectionChange?: (collection: string) => void
  listRequirements: (filter: RequirementFilter) => Promise<RequirementListResult>
  getQueryOptions: (collection?: string) => Promise<RequirementQueryOptions>
  /** 问题 1：只读盘，不采集。 */
  loadQueryOptions?: (
    collection?: string,
  ) => Promise<{ ok: boolean; data: RequirementQueryOptions | null; savedAt?: string }>
  /** 问题 1：强制重采并落盘（「采集可选项」按钮）。 */
  onCollectQueryOptions?: (collection?: string) => Promise<{ ok: boolean; data?: RequirementQueryOptions; reason?: string }>
  /** 问题 2/4：UI 状态读写。 */
  loadUiState?: (collection?: string) => Promise<UiState>
  saveUiState?: (patch: Partial<UiState>, collection?: string) => Promise<{ ok: boolean; reason?: string }>
  claimRequirement: (input: {
    id?: number
    collection?: string
    requirement?: RequirementSummary
    workspace?: string
    /** 问题 6：领取弹框里填写的需求级提示词。 */
    prompt?: string
  }) => Promise<{ ok: boolean; added?: boolean; reason?: string }>
  onClaimed?: () => void
  /**
   * dsh 已添加的工作区清单（问题 6：领取弹框里用下拉选工作目录，而不是手打绝对路径）。
   * 缺省（宿主未返回）时弹框退化为手填输入框并明确提示。
   */
  workspaces?: DshWorkspaceOption[]
  /**
   * 活动档案的服务地址（不含集合）。
   *
   * 只在工作项自带 REST `url` 缺失时作为**兜底**参与 TFS 需求页拼接
   * （首选数据源是 `url`，见 `src/shared/workitem-url.ts`）。
   */
  tfsBaseUrl?: string
  /** 本地池已领取需求（用于行内"已领取"标记，US2）。 */
  claimedRequirements?: RequirementSummary[]
  /** 选为执行目标（跳执行配置页；Workbench 会先实时补全四段正文，问题 11）。 */
  onSelect?: (item: RequirementSummary) => void
  /**
   * 轮询间隔（分钟），来自宿主 `Config.pollIntervalMinutes`。
   *
   * 此前这里写死 5 分钟：注释声称"间隔由宿主下发"，但 props 里没有这个字段、
   * Workbench 也没传，于是 `pollIntervalMinutes` 这个配置项对它唯一的用途完全无效
   * —— 改成 1 或 60 都不会有任何变化。缺省（宿主未返回）时退回 5 分钟。
   */
  pollIntervalMinutes?: number
}): JSX.Element {
  const [items, setItems] = useState<RequirementSummary[]>([])
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')
  const [options, setOptions] = useState<RequirementQueryOptions | null>(null)
  const [savedAt, setSavedAt] = useState<string>('')
  const [optionsLoading, setOptionsLoading] = useState(false)
  const [keyword, setKeyword] = useState('')
  const [projects, setProjects] = useState<string[]>([])
  const [types, setTypes] = useState<string[]>([])
  const [states, setStates] = useState<string[]>([])
  const [assignees, setAssignees] = useState<string[]>([])
  const [assigneeUnlimited, setAssigneeUnlimited] = useState(false)
  const [unclaimedOnly, setUnclaimedOnly] = useState(true)
  const [poolPageSize, setPoolPageSize] = useState(DEFAULT_POOL_PAGE_SIZE)
  const [workspace, setWorkspace] = useState('')
  const [detail, setDetail] = useState<RequirementSummary | null>(null)
  const [busyId, setBusyId] = useState<number | null>(null)
  /**
   * 问题 6：领取弹框的待领取项（null = 关闭）。
   *
   * 打开时把工具栏的「默认工作目录」带进来当初始值，并清空提示词 ——
   * 提示词是"这一条需求"的，跨条目复用会造成无意的串味（比每次都重填更糟）。
   */
  const [claimTarget, setClaimTarget] = useState<RequirementSummary | null>(null)
  const [claimWorkspace, setClaimWorkspace] = useState('')
  const [claimPrompt, setClaimPrompt] = useState('')
  /** 问题 2：遮罩关闭只认"按下也在遮罩上"的 click（挡拖拽手势在遮罩上释放产生的误关）。 */
  const overlayDownTarget = useRef<EventTarget | null>(null)

  /**
   * 已完成 UI 状态水合的集合（问题 2）：水合完成前不得把初始默认值回写覆盖磁盘上的记忆。
   */
  const hydratedRef = useRef<Set<string>>(new Set())

  /**
   * 宿主每次 apply 都会新建 bridge 函数，内联进依赖会让 effect 每次渲染重跑，
   * 故用 ref 持有最新回调而依赖数组只放集合名（同 TaskCenter 的既有纪律）。
   */
  const listRef = useRef(props.listRequirements)
  listRef.current = props.listRequirements
  const getOptionsRef = useRef(props.getQueryOptions)
  getOptionsRef.current = props.getQueryOptions
  const loadOptionsDiskRef = useRef(props.loadQueryOptions)
  loadOptionsDiskRef.current = props.loadQueryOptions
  const loadUiStateRef = useRef(props.loadUiState)
  loadUiStateRef.current = props.loadUiState
  const saveUiStateRef = useRef(props.saveUiState)
  saveUiStateRef.current = props.saveUiState

  const optionsKey = props.collection || 'default'

  /**
   * 问题 1：可选项**读盘优先**。
   * 顺序：同会话模块缓存 → 宿主落盘缓存（query-options.json）→ 实时采集
   * （宿主 getQueryOptions 内部同样是读盘优先 + 未命中采集并落盘，双保险）。
   */
  useEffect(() => {
    let cancelled = false
    const mem = optionsMemory.get(optionsKey)
    if (mem) {
      setOptions(mem)
      setSavedAt(mem.collectedAt ?? '')
      return
    }
    setOptions(null)
    setSavedAt('')
    setOptionsLoading(true)
    void (async (): Promise<void> => {
      try {
        if (loadOptionsDiskRef.current) {
          const cached = await loadOptionsDiskRef.current(optionsKey === 'default' ? undefined : optionsKey)
          if (!cancelled && cached.data) {
            // ⚠️ 空结果**不写内存缓存**（2026-10-05 修复）：宿主桥在失败时返回的是
            // 「四项皆空 + reason」的合法对象。若把它当有效缓存写进 `optionsMemory`，
            // 本次页面会话内再切回该集合时第 182 行直接命中短路、**不再发任何请求**，
            // 四个下拉就一直空着，且顶部还显示"可选项来自本地缓存（时间）"——
            // 一种比"慢"更糟的**误导性成功态**。守卫函数早已存在于
            // `shared/pool.ts#shouldCacheQueryOptions`，此前只有宿主侧在用。
            if (shouldCacheQueryOptions(cached.data)) optionsMemory.set(optionsKey, cached.data)
            setOptions(cached.data)
            setSavedAt(cached.savedAt ?? cached.data.collectedAt ?? '')
            return
          }
        }
        const opts = await getOptionsRef.current(optionsKey === 'default' ? undefined : optionsKey)
        if (cancelled) return
        // 同上：只有真有内容才进内存缓存。
        if (shouldCacheQueryOptions(opts)) optionsMemory.set(optionsKey, opts)
        setOptions(opts)
        setSavedAt(opts.collectedAt ?? '')
      } catch (e) {
        if (!cancelled) setMessage(`筛选可选项不可用：${e instanceof Error ? e.message : String(e)}`)
      } finally {
        if (!cancelled) setOptionsLoading(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [optionsKey])

  /**
   * 问题 2/4：按集合水合 UI 状态（筛选记忆 + 每页条数）。
   * 无记录时回到默认（指派人默认项由随后到达的可选项补当前 PAT 用户）。
   */
  useEffect(() => {
    let cancelled = false
    const loadUi = loadUiStateRef.current
    hydratedRef.current.delete(optionsKey)
    setProjects([])
    setTypes([])
    setStates([])
    setAssignees([])
    setAssigneeUnlimited(false)
    setPoolPageSize(DEFAULT_POOL_PAGE_SIZE)
    if (!loadUi) {
      hydratedRef.current.add(optionsKey)
      return
    }
    void (async (): Promise<void> => {
      try {
        const ui = await loadUi(optionsKey === 'default' ? undefined : optionsKey)
        if (cancelled) return
        const f = ui.poolFilters
        if (f) {
          const savedProjects = f.projects ?? (f.projectId ? [f.projectId] : [])
          setProjects(savedProjects)
          setTypes(f.types ?? [])
          setStates(f.states ?? [])
          setAssignees(f.assignedTo ?? [])
          setAssigneeUnlimited(!!f.assigneeUnlimited)
        }
if (typeof ui.poolPageSize === 'number' && ui.poolPageSize > 0) setPoolPageSize(ui.poolPageSize)
    } catch {
      // 忽略：读不到已保存的筛选条件时用默认值
    } finally {
      if (!cancelled) hydratedRef.current.add(optionsKey)
    }
  })()
  return () => {
    cancelled = true
  }
}, [optionsKey])

/**
 * 剔除数据源里已不存在的筛选项（spec 003 FR-203「静默忽略失效值」）。
 *
 * 保存下来的筛选值是**采集那一刻**的项目/类型/状态/指派人。TFS 上有人改名或删了团队项目
 * 之后，缓存里的旧值仍留在 `ui-state.json` 里被原样恢复，并原样进入 WIQL —— 查询命中不到
 * 任何工作项，需求池变成空的，而界面上看不出任何原因（失效项在 `MultiSelect` 里渲染成一枚
 * "孤儿" chip，看上去就是一个普通的已选项）。恢复逻辑只认 `ui-state.json`，不与新采集到的
 * 可选项对账，所以这里补一次。
 *
 * 采集失败（`options.reason`）时**不动**筛选条件：此时的空列表是"没采到"而不是"没有"，
 * 据此清空会把用户的筛选全丢掉。
 */
useEffect(() => {
  if (!options || options.reason) return
  const keep = (values: string[], available: NamedOption[]): string[] => {
    if (values.length === 0) return values
    const known = new Set(available.map(o => o.value))
    // 默认指派人未必出现在候选列表里（它是当前 PAT 身份，不属于团队成员枚举结果），
    // 但它由宿主随 options 一起下发，认下来才不会把刚自动勾上的默认值又删掉。
    if (options.defaultAssignee) known.add(options.defaultAssignee)
    const next = values.filter(v => known.has(v))
    return next.length === values.length ? values : next
  }
  setProjects(prev => keep(prev, options.projects))
  setTypes(prev => keep(prev, options.types))
  setStates(prev => keep(prev, options.states))
  setAssignees(prev => keep(prev, options.assignees))
}, [options])

  /**
   * 可选项到达后，若水合出的筛选没有指派人且未勾选「不限」，默认勾选当前 PAT 用户
   * （"默认看自己的"；用户显式选择/记忆值不被覆盖）。
   */
  useEffect(() => {
    if (!options) return
    if (assignees.length === 0 && !assigneeUnlimited && options.defaultAssignee) {
      setAssignees([options.defaultAssignee])
    }
    // 只在可选项首次到达时补默认，不跟随 assignees 变化反复跑。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [options])

  /** 问题 2：筛选变化防抖 300ms 落盘（水合完成后才允许写，避免默认值覆盖记忆）。 */
  useEffect(() => {
    if (!saveUiStateRef.current || !hydratedRef.current.has(optionsKey)) return
    const timer = setTimeout(() => {
      void saveUiStateRef.current?.(
        {
          poolFilters: {
            projects,
            types,
            states,
            assignedTo: assignees,
            assigneeUnlimited,
          },
        },
        optionsKey === 'default' ? undefined : optionsKey,
      )
    }, 300)
    return () => clearTimeout(timer)
  }, [projects, types, states, assignees, assigneeUnlimited, optionsKey])

  // ── 客户端侧补充过滤：「仅看未入池」 ──
  //
  // ⚠️ 必须在分页**之前**算（2026-10-06 修复）：分页的 total 与切片必须用**同一个**数组。
  // 旧实现 `usePagination(items.length)` 用全量算页数，`paginate(visibleItems)` 却切过滤后的
  // 数组 —— 两个集合不相等时，`paginateSlice` 内部会再按 visibleItems 的长度把页码夹回去，
  // 于是：分页栏仍显示 25 页、仍高亮在第 16 页，「第 301–320 条 / 共 500 条」也照算，
  // 但列表里显示的其实是第 15 页的内容。**页码、计数文案与实际内容三者错位**，
  // 用户点第 20 页看到第 15 页的数据却无从察觉（默认每页 20、上限 500 条时必现）。
  const claimedKeys = useMemo(() => new Set(claimedKeysOf(props.claimedRequirements ?? [])), [props.claimedRequirements])
  const visibleItems = useMemo(
    () => (unclaimedOnly ? items.filter(it => !claimedKeys.has(`${it.id}@${it.collection}`)) : items),
    [items, unclaimedOnly, claimedKeys],
  )

  /** 问题 4：每页条数立即落盘并回到第 1 页。 */
  const pagination = usePagination(visibleItems.length, poolPageSize)
  const changePageSize = (size: number): void => {
    setPoolPageSize(size)
    pagination.resetPage()
    if (saveUiStateRef.current && hydratedRef.current.has(optionsKey)) {
      void saveUiStateRef.current({ poolPageSize: size }, optionsKey === 'default' ? undefined : optionsKey)
    }
  }

  const load = useCallback(
    async (manual: boolean): Promise<void> => {
      setLoading(true)
      // ⚠️ 自动轮询**不**清消息（2026-10-05 修复）：否则每 5 分钟抹掉页面上
      // 「可选项部分采集失败…」这类仍需用户注意的提示。
      if (manual) setMessage('')
      try {
        // 问题 4：分页在客户端（WIQL $top=500 架构不变），一次拉回上限内全量再切片。
        const filter: RequirementFilter = {
          collection: props.collection,
          projects,
          types,
          states,
          // 「不限指派人」显式传空数组；未勾选且未选任何人时不传（宿主填当前 PAT 用户）。
          assignedTo: assigneeUnlimited ? [] : assignees.length > 0 ? assignees : undefined,
          keyword: keyword.trim() || undefined,
          top: 500,
        }
        const r = await listRef.current(filter)
        if (!r.ok) {
          setMessage(r.reason ?? '查询失败')
          return
        }
        setItems(r.items)
        // ⚠️ 只有**用户主动点「拉取需求」**才回到第 1 页（2026-10-05 修复）：
        // 定时轮询走同一条 `load(false)`，旧实现无条件 `resetPage()`，
        // 于是用户翻到第 8 页查看候选需求，5 分钟后界面**静默跳回第 1 页**。
        // 同一处 `setMessage('')` 也会抹掉页面上正在显示的提示，故一并按 manual 收敛。
        if (manual) {
          pagination.resetPage()
          setMessage(`已拉取 ${r.items.length} 条候选需求`)
        }
      } catch (e) {
        setMessage(e instanceof Error ? e.message : String(e))
      } finally {
        setLoading(false)
      }
    },
    [props.collection, projects, types, states, assignees, assigneeUnlimited, keyword],
  )

  // 定时轮询（FR-024 / S-14）：间隔由宿主下发（`Config.pollIntervalMinutes`），默认 5 分钟。
  const pollMinutes = Math.max(1, Math.trunc(props.pollIntervalMinutes ?? 5))
  /**
   * 用 ref 持最新 `load`，让计时器的依赖只留 `[pollMinutes]`。
   *
   * 旧实现把 `load` 放进依赖：而 `load` 的身份随 `projects/types/states/assignees/
   * assigneeUnlimited/keyword` 变化 ⇒ 用户每改一次筛选、或每敲一个关键词字符，
   * `clearInterval` + 重建就让 5 分钟**从零重新开始** ⇒ 频繁筛选时轮询永远不触发。
   */
  const loadRef = useRef(load)
  loadRef.current = load
  useEffect(() => {
    const id = setInterval(() => {
      void loadRef.current(false)
    }, pollMinutes * 60 * 1000)
    return () => clearInterval(id)
  }, [pollMinutes])

  /** 「采集可选项」（问题 1）：强制重采并落盘覆盖，同时更新下拉。 */
  const collectOptions = async (): Promise<void> => {
    setOptionsLoading(true)
    setMessage('')
    try {
      const fn = props.onCollectQueryOptions
      const opts: { ok: boolean; data?: RequirementQueryOptions; reason?: string } = fn
        ? await fn(optionsKey === 'default' ? undefined : optionsKey)
        : await props
            .getQueryOptions(optionsKey === 'default' ? undefined : optionsKey)
            .then(data => ({ ok: true, data }) as { ok: boolean; data: RequirementQueryOptions })
      if (!opts.ok || !opts.data) {
        setMessage(opts.reason ?? '采集可选项失败')
        return
      }
      // 显式重采同理：宿主若"成功"返回了四项皆空，也不得进内存缓存
      // （否则用户点完按钮仍拿不到下拉，且下次进来直接命中空缓存）。
      if (shouldCacheQueryOptions(opts.data)) optionsMemory.set(optionsKey, opts.data)
      setOptions(opts.data)
      setSavedAt(new Date().toISOString())
      setMessage(
        shouldCacheQueryOptions(opts.data)
          ? '可选项已重新采集并保存到本地'
          : `采集未取到任何可选项${opts.reason ? `：${opts.reason}` : ''}`,
      )
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setOptionsLoading(false)
    }
  }

  const pageItems = pagination.paginate(visibleItems)

  const claim = async (item: RequirementSummary): Promise<void> => {
    setBusyId(item.id)
    setMessage('')
    try {
      const r = await props.claimRequirement({
        collection: item.collection,
        requirement: item,
        workspace: claimWorkspace.trim() || undefined,
        prompt: claimPrompt.trim() || undefined,
      })
      if (!r.ok) {
        setMessage(r.reason ?? '领取失败')
        return
      }
      setMessage(r.added ? `已领取 ${item.id}（已入池并打 dsh 标签）` : `${item.id} 已在池中（幂等）`)
      // 问题 5：领取入池后立即通知 Workbench 刷新看板 → 任务中心实时出现该需求。
      props.onClaimed?.()
      // 领取成功才关弹框：失败时保留用户已填的工作目录/提示词，便于改一下就重试。
      claimDrafts.delete(`${item.id}@${item.collection}`)
      setClaimTarget(null)
      setClaimPrompt('')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusyId(null)
    }
  }

  /** 打开领取弹框（问题 6）：带上工具栏里的默认工作目录；问题 2：优先恢复该需求的草稿。 */
  const openClaim = (item: RequirementSummary): void => {
    setMessage('')
    const draft = claimDrafts.get(`${item.id}@${item.collection}`)
    setClaimPrompt(draft?.prompt ?? '')
    setClaimWorkspace(draft?.workspace ?? workspace.trim())
    setClaimTarget(item)
  }

  const toOptions = (arr: NamedOption[]): Array<{ value: string; label: string }> =>
    arr.map(o => ({ value: o.value, label: o.label }))

  /**
   * 标题 → TFS 需求页（编辑页）。
   *
   * 拿不到完整信息时 `buildWorkItemUrl` 返回 `undefined`，此时**退回纯文本** ——
   * 一个打不开的链接比一段纯文本更糟（它把"数据缺失"伪装成"功能正常"）。
   */
  const workItemUrl = (it: RequirementSummary): string | undefined =>
    buildWorkItemUrl({
      id: it.id,
      restUrl: it.url,
      project: it.project,
      baseUrl: props.tfsBaseUrl,
      collection: it.collection,
    })

  /** 需求详情弹窗用的链接（可能为空）。 */
  const detailUrl = detail ? workItemUrl(detail) : undefined

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', color: '#111827' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>需求池</h3>
        <select
          style={inputStyle}
          value={props.collection}
          onChange={e => props.onCollectionChange?.(e.target.value)}
          disabled={!props.onCollectionChange || props.collections.length === 0}
          title="切换 TFS 集合"
        >
          {props.collections.length === 0 && <option value={props.collection}>{props.collection}</option>}
          {props.collections.map(c => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <span style={{ fontSize: 12, color: '#6b7280' }}>
          {savedAt
            ? `可选项来自本地缓存（${new Date(savedAt).toLocaleString()}）`
            : optionsLoading
              ? '可选项加载中…'
              : '可选项尚未缓存'}
        </span>
      </div>

      {/* 筛选区 */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <div style={{ minWidth: 220, flex: '1 1 220px' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>团队项目（多选，空=全部）</div>
            <MultiSelect
              options={toOptions(options?.projects ?? [])}
              value={projects}
              onChange={next => {
                setProjects(next)
                pagination.resetPage()
              }}
              placeholder={optionsLoading ? '可选项加载中…' : '全部项目'}
              searchPlaceholder="按项目名刷选…"
            />
          </div>
          <div style={{ minWidth: 180, flex: '1 1 180px' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>工作项类型（多选）</div>
            <MultiSelect
              options={toOptions(options?.types ?? [])}
              value={types}
              onChange={next => {
                setTypes(next)
                pagination.resetPage()
              }}
              placeholder="全部类型"
              searchPlaceholder="按类型刷选…"
            />
          </div>
          <div style={{ minWidth: 160, flex: '1 1 160px' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>状态（多选）</div>
            <MultiSelect
              options={toOptions(options?.states ?? [])}
              value={states}
              onChange={next => {
                setStates(next)
                pagination.resetPage()
              }}
              placeholder="全部状态"
              searchPlaceholder="按状态刷选…"
            />
          </div>
          <div style={{ minWidth: 200, flex: '1 1 200px' }}>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 4 }}>指派给（默认当前账号）</div>
            <MultiSelect
              options={toOptions(options?.assignees ?? [])}
              value={assigneeUnlimited ? [] : assignees}
              onChange={next => {
                setAssignees(next)
                setAssigneeUnlimited(false)
                pagination.resetPage()
              }}
              placeholder={assigneeUnlimited ? '不限指派人' : '默认当前账号'}
              searchPlaceholder="按账号/姓名刷选…"
            />
            <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, marginTop: 4 }}>
              <input
                type="checkbox"
                checked={assigneeUnlimited}
                onChange={e => {
                  setAssigneeUnlimited(e.target.checked)
                  if (e.target.checked) setAssignees([])
                  pagination.resetPage()
                }}
              />
              不限指派人
            </label>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            style={{ ...inputStyle, minWidth: 220 }}
            placeholder="标题关键字"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
          />
          <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 13 }}>
            <input
              type="checkbox"
              checked={unclaimedOnly}
              onChange={e => {
                setUnclaimedOnly(e.target.checked)
                // 过滤口径变了，可见集合随之变化：不清页码的话会停在"上一口径"的页号上，
                // 表现为勾选后列表突然少一截或跳到不相干的页。
                pagination.resetPage()
              }}
            />
            仅看未入池
          </label>
          <input
            style={{ ...inputStyle, minWidth: 260, flex: '1 1 260px' }}
            placeholder="默认工作目录（可选，作为领取弹框的默认值，如 D:\\code\\his）"
            value={workspace}
            onChange={e => setWorkspace(e.target.value)}
          />
          <button style={buttonStyle} onClick={() => void load(true)} disabled={loading}>
            {loading ? '拉取中…' : '拉取需求'}
          </button>
          {/* 问题 1：显式「采集可选项」——唯一会重新打 TFS 元数据接口的入口。 */}
          <button
            style={{ ...buttonStyle, background: '#fff' }}
            onClick={() => void collectOptions()}
            disabled={optionsLoading}
            title="重新从 TFS 采集团队项目/工作项类型/状态/指派人，并覆盖保存到本地配置文件"
          >
            {optionsLoading ? '采集中…' : '采集可选项'}
          </button>
        </div>
        {options?.reason && (
          <div style={{ marginTop: 8, fontSize: 12, color: '#b45309' }}>
            可选项部分采集失败：{options.reason}（可点「采集可选项」重试）
          </div>
        )}
      </div>

      {message && (
        <div
          style={{
            marginBottom: 10,
            fontSize: 13,
            color: message.startsWith('已') || message.includes('成功') || message.includes('保存') ? '#047857' : '#b91c1c',
          }}
        >
          {message}
        </div>
      )}

      {/* 候选需求表（当前页切片） */}
      <div style={sectionStyle}>
        <div style={{ fontSize: 13, color: '#6b7280', marginBottom: 6 }}>
          候选需求 {visibleItems.length} 条{unclaimedOnly ? '（已隐藏在池项）' : ''}
          {claimedKeys.size > 0 ? ` ｜ 本地池 ${claimedKeys.size} 条` : ''}
        </div>
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                <th style={cellStyle}>ID</th>
                <th style={cellStyle}>标题</th>
                <th style={cellStyle}>类型</th>
                <th style={cellStyle}>状态</th>
                <th style={cellStyle}>指派给</th>
                <th style={cellStyle}>项目</th>
                <th style={cellStyle}>更新时间</th>
                <th style={cellStyle} />
              </tr>
            </thead>
            <tbody>
              {pageItems.map(it => {
                const key = `${it.id}@${it.collection}`
                const claimed = claimedKeys.has(key)
                return (
                  <tr key={key} style={claimed ? { background: '#f0f9ff' } : undefined}>
                    <td style={cellStyle}>
                      <button
                        type="button"
                        style={{ border: 'none', background: 'transparent', color: '#2563eb', cursor: 'pointer', padding: 0, fontSize: 12 }}
                        onClick={() => setDetail(it)}
                        title="查看详情"
                      >
                        {it.id}
                      </button>
                    </td>
                    {/* 需求池标题 → TFS 需求页（新标签页）。 */}
                    <td style={{ ...cellStyle, maxWidth: 320 }} title={it.title}>
                      {(() => {
                        const href = workItemUrl(it)
                        return href ? (
                          <a
                            href={href}
                            target="_blank"
                            rel="noreferrer noopener"
                            style={{ color: '#2563eb', textDecoration: 'none' }}
                            title={`在 TFS 中打开需求 #${it.id}：${href}`}
                          >
                            {it.title}
                            <span style={{ marginLeft: 4, fontSize: 11, color: '#6b7280' }}>↗</span>
                          </a>
                        ) : (
                          <span>{it.title}</span>
                        )
                      })()}
                    </td>
                    <td style={cellStyle}>{it.type}</td>
                    <td style={cellStyle}>{it.state}</td>
                    <td style={cellStyle}>{it.assignedTo}</td>
                    <td style={cellStyle}>{it.project}</td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                      {it.changedDate ? new Date(it.changedDate).toLocaleString() : '-'}
                    </td>
                    <td style={{ ...cellStyle, whiteSpace: 'nowrap' }}>
                      {claimed ? (
                        <span style={{ fontSize: 12, color: '#0369a1' }}>已领取</span>
                      ) : (
                        <button style={buttonStyle} disabled={busyId === it.id} onClick={() => openClaim(it)}>
                          {busyId === it.id ? '领取中…' : '领取入池'}
                        </button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {pageItems.length === 0 && (
                <tr>
                  <td colSpan={8} style={{ ...cellStyle, color: '#9ca3af', textAlign: 'center', padding: 16 }}>
                    {loading ? '加载中…' : '无候选需求（设置筛选后点「拉取需求」）'}
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <PaginationBar
          label="候选需求"
          total={visibleItems.length}
          page={pagination.page}
          pageCount={pagination.pageCount}
          pageSize={poolPageSize}
          pageSizeOptions={POOL_PAGE_SIZE_OPTIONS}
          onPageChange={pagination.setPage}
          onPageSizeChange={changePageSize}
        />
      </div>

      {/* 问题 6：领取入池弹框 —— 选工作目录 + 填需求级提示词
          问题 2（2026-11-03）：遮罩点击关闭只在"按下也在遮罩上"时生效 ——
          曾有"弹框内按下（拖选文本/拖动）在遮罩上释放"被浏览器合成 click 打到遮罩上，
          弹框一移出鼠标就消失；且误关后草稿按需求键缓存（claimDrafts），重开即恢复。 */}
      {claimTarget && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 60 }}
          onMouseDown={e => {
            overlayDownTarget.current = e.target
          }}
          onClick={e => {
            if (e.target === e.currentTarget && overlayDownTarget.current === e.currentTarget) {
              setClaimTarget(null)
            }
          }}
        >
          <div
            style={{ background: '#fff', borderRadius: 10, padding: 18, maxWidth: 640, width: '92%', maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <h3 style={{ margin: '0 0 6px' }}>
              领取入池：{claimTarget.id} {claimTarget.title}
            </h3>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
              {claimTarget.collection} ｜ {claimTarget.project} ｜ {claimTarget.type} ｜ {claimTarget.state}
            </div>

            <label style={{ display: 'block', fontSize: 12, color: '#6b7280', margin: '6px 0 4px' }}>
              工作目录（写入该需求，拆解出的任务会继承；不改变子代理进程 cwd）
            </label>
            {(props.workspaces ?? []).length > 0 ? (
              <select
                style={{ ...inputStyle, width: '100%' }}
                value={claimWorkspace}
                onChange={e => {
                  setClaimWorkspace(e.target.value)
                  claimDrafts.set(`${claimTarget.id}@${claimTarget.collection}`, {
                    workspace: e.target.value,
                    prompt: claimPrompt,
                  })
                }}
              >
                <option value="">— 不指定 —</option>
                {(props.workspaces ?? []).map(w => (
                  <option key={w.id} value={w.path}>
                    {w.title}
                    {w.path ? `（${w.path}）` : ''}
                  </option>
                ))}
                {/* 允许手填：dsh 工作区清单里没有的目录（例如刚克隆、还没加进 dsh）也应能填。 */}
                {claimWorkspace && !(props.workspaces ?? []).some(w => w.path === claimWorkspace) && (
                  <option value={claimWorkspace}>{claimWorkspace}（手填）</option>
                )}
              </select>
            ) : (
              <div style={{ fontSize: 11, color: '#b45309' }}>
                宿主未返回工作区清单（能力降级）：请手填绝对路径。
              </div>
            )}
            <input
              style={{ ...inputStyle, width: '100%', marginTop: 6 }}
              placeholder="也可直接手填绝对路径，如 D:\\code\\his（留空 = 不指定）"
              value={claimWorkspace}
              onChange={e => {
                  setClaimWorkspace(e.target.value)
                  claimDrafts.set(`${claimTarget.id}@${claimTarget.collection}`, {
                    workspace: e.target.value,
                    prompt: claimPrompt,
                  })
                }}
            />

            <label style={{ display: 'block', fontSize: 12, color: '#6b7280', margin: '10px 0 4px' }}>
              增加提示词（需求级；派发该需求下任一任务时拼在任务提示词之前）
            </label>
            <textarea
              style={{ ...inputStyle, width: '100%', minHeight: 90, boxSizing: 'border-box' }}
              placeholder="例：本次只改后端，遵循 Tjgl 代码规范；数据库变更需附回滚脚本。"
              value={claimPrompt}
              onChange={e => {
                setClaimPrompt(e.target.value)
                claimDrafts.set(`${claimTarget.id}@${claimTarget.collection}`, {
                  workspace: claimWorkspace,
                  prompt: e.target.value,
                })
              }}
            />

            <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
              <button style={buttonStyle} disabled={busyId === claimTarget.id} onClick={() => void claim(claimTarget)}>
                {busyId === claimTarget.id ? '领取中…' : '确认领取入池'}
              </button>
              <button style={buttonStyle} disabled={busyId === claimTarget.id} onClick={() => setClaimTarget(null)}>
                取消
              </button>
            </div>
          </div>
        </div>
      )}

      {/* 详情弹窗：四段正文（问题 11） */}
      {detail && (
        <div
          style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.35)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 50 }}
          onClick={() => setDetail(null)}
        >
          <div
            style={{ background: '#fff', borderRadius: 10, padding: 18, maxWidth: 760, width: '90%', maxHeight: '80vh', overflow: 'auto' }}
            onClick={e => e.stopPropagation()}
          >
            <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <h3 style={{ margin: '0 0 8px', flex: 1 }}>
                {detail.id} {detail.title}
              </h3>
              <button style={{ ...buttonStyle, padding: '2px 10px' }} onClick={() => setDetail(null)}>
                关闭
              </button>
            </div>
            <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 10 }}>
              {detail.collection} ｜ {detail.project} ｜ {detail.type} ｜ {detail.state} ｜ {detail.assignedTo}
            </div>
            {([
              ['详细信息', detail.description],
              ['需求分析', detail.analysis],
              ['数据结构', detail.dataStructure],
              ['需求配置', detail.config],
            ] as Array<[string, string | undefined]>).map(([heading, text]) => (
              <div key={heading} style={{ marginBottom: 10 }}>
                <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 2 }}>{heading}</div>
                <div style={{ fontSize: 13, whiteSpace: 'pre-wrap', background: '#f8fafc', border: '1px solid #e5e7eb', borderRadius: 6, padding: 8 }}>
                  {text && text.trim() ? text : <span style={{ color: '#9ca3af' }}>（空）</span>}
                </div>
              </div>
            ))}
            <div style={{ fontSize: 12, color: '#6b7280' }}>
              区域：{detail.areaPath} ｜ 迭代：{detail.iterationPath} ｜ 优先级：{detail.priority || '-'}
            </div>
            {props.onSelect && (
              <div style={{ marginTop: 12, display: 'flex', gap: 8, justifyContent: 'flex-end', alignItems: 'center' }}>
                {/* 详情弹窗里也给一个直达 TFS 的入口（FR-504）。 */}
                {detailUrl && (
                  <a
                    href={detailUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    style={{
                      ...buttonStyle,
                      color: '#2563eb',
                      textDecoration: 'none',
                      display: 'inline-flex',
                      alignItems: 'center',
                      lineHeight: 'normal',
                    }}
                    title={detailUrl}
                  >
                    在 TFS 中打开 ↗
                  </a>
                )}
                <button style={buttonStyle} onClick={() => props.onSelect?.(detail)}>
                  选为目标
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

export default RequirementPool

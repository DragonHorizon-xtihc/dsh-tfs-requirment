/**
 * 右侧栏「TFS 执行」标签页（优化项 R1）。
 *
 * ## 为什么存在
 *
 * 中央看板是**模态**形态：打开它会顶掉会话面板，用户看不到对话、也没法边看智能体输出边改配置。
 * 而"执行配置"恰恰是最需要**与对话并排**看的内容（调完参数立刻派发、盯着执行过程）。
 * DSH 0.1.5 起官方提供了右侧栏标签页机制，正是为这种"与主区并排"的场景设计的。
 *
 * ## 与中央看板的关系：同一份数据，两个视图（不重复实现）
 *
 * 两者共用 `HttpHostBridge` 的同一批端点与同一个 `ExecutionPanel` 组件，
 * 不存在"两套逻辑各自演化"的漂移风险。区别只在承载形态：
 *
 *   | 形态 | 槽位 | 打开方式 | 典型用途 |
 *   |---|---|---|---|
 *   | 中央 `main` | `main`（keyed） | 点左侧菜单行 | 全流程：需求池 → 拆解 → 分配 → 回写 |
 *   | 右栏 `sidebar.right.pane.tab` | 同左 | 点右栏 `+` → 选「TFS 执行」 | 与对话并排调参、盯执行 |
 *
 * ## 官方扩展面（host 源码核实，非臆造）
 *
 * 右栏不是"自己往 DOM 里塞东西"，而是宿主显式开放的**两段式**协议：
 *   1. `ctx.sidebarRightTabs.register({ id, kind, title, guide })` 声明一种页类型；
 *   2. 该 id 再注册进 `sidebar.right.pane.tab` 槽（本文件下方 `registerSideTab`）。
 *
 * 依据：
 *   - 注册表服务由宿主提供：`dsh-client-ui-sidebar-right/lib/client.js` 的
 *     `ctx.reflect.provide("sidebarRightTabs", tabs)`（装配于 `dsh-web-app/cordis.patch.yml:224`）；
 *   - 定义契约：`SidebarRightTabDefinition`（`lib/types/client/tab-registry.d.ts:68-109`）——
 *     `id` 是该实现的身份，且**正是**它在 `sidebar.right.pane.tab` / `.title` 两个座席里注册用的 key；
 *   - 打开入口：`ISidebarRight.openTab(kind, options)`（`lib/types/client/service.d.ts:125`）；
 *   - 槽位契约：`sidebar.right.pane.tab` 是 `kind:'keyed'`、`scope:'session'`
 *     （宿主仓库 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:2269-2312`）。
 *
 * 协议里 `'guide'` 是本包自留的 kind（`client.js` 的 `GUIDE_KIND = "guide"`），
 * 复用它会撞上已注册的 `builtin` 而抛错，故本插件自带 kind `TFS_EXEC_KIND`。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/client/components/SidePanel
 */

import { useCallback, useEffect, useMemo, useState } from 'react'
import { ExecutionPanel } from './ExecutionPanel.js'
import { BoardStore, useBoardStore } from '../board-store.js'
import { targetRefFromKey } from '../../shared/target.js'
import type {
  BoardTaskView,
  DispatchDraft,
  ExecutionActions,
  ExecutionFormState,
  ExecutionPanelData,
  HostBridge,
  RoleDefinition,
  TargetRef,
  WriteOpDraft,
} from '../../shared/contracts.js'

/**
 * 本插件的页类型 kind。
 *
 * 必须与宿主的 `'guide'`（以及任何内建 kind）不同：注册表同一 band 内
 * 同 kind 二次注册会抛 `tab kind "x" is already registered`。
 */
export const TFS_EXEC_KIND = 'tfs-requirment-exec'

/** 页类型在注册表里的身份，同时是它在本槽注册用的 key。 */
export const TFS_EXEC_TAB_ID = '@deepseek-ai/dsh-tfs-requirment#exec'

/** 页签名（宿主在 chip 与浮动面板标题上渲染它）。 */
export const TFS_EXEC_TITLE = 'TFS 执行'

/** 面板内可切换的两块内容。 */
type SideTab = 'exec' | 'tasks'

/** 右栏面板的 props（由 slots.tsx 注入；本组件不自行取宿主服务，便于单测）。 */
export interface SidePanelProps {
  /** 宿主桥（与中央看板同一个实例，故共享 bridge 的缓存与错误口径）。 */
  bridge: HostBridge
  /**
   * 模块级共享看板 store（问题 1/6/7）：与中央 Workbench 同一份快照、同一条自适应轮询链，
   * 保证「执行配置 → 发起执行」后右栏任务列表与中央任务中心实时同步且不发重复请求。
   */
  boardStore: BoardStore
  /** 关闭 = 收起右侧栏（`ctx.sidebarRight.toggleExpanded()`）。 */
  onClose?: () => void
}

/** 与中央看板同源的兜底：连不上宿主时给空清单，而不是编造可选项。 */
function emptyPanelData(): ExecutionPanelData {
  return {
    targetWorkItem: '—',
    collection: '—',
    roles: [] as RoleDefinition[],
    models: [],
    mcpServers: [],
    skills: [],
    modelOptions: [],
    workspaces: [],
    presets: [],
    providers: [],
    skillOptions: [],
    tagSuggestions: [],
    collections: [],
    pollIntervalMinutes: 5,
  }
}

const tabButtonStyle = (active: boolean): React.CSSProperties => ({
  padding: '6px 10px',
  border: 'none',
  borderBottom: active ? '2px solid #2563eb' : '2px solid transparent',
  background: 'transparent',
  color: active ? '#2563eb' : '#6b7280',
  cursor: 'pointer',
  fontSize: 12,
  fontWeight: active ? 600 : 400,
})

const statusChipStyle: React.CSSProperties = {
  display: 'inline-block',
  padding: '1px 6px',
  borderRadius: 4,
  fontSize: 11,
  background: '#f3f4f6',
  color: '#4b5563',
}

/**
 * 右栏「TFS 执行」面板。
 *
 * 数据加载与中央看板同源（`bridge.getPanelData()` / `bridge.getBoard()`），
 * 因此两处永远看到同一份真实枚举，不会出现"中央有模型、右栏没有"的错位。
 */
export function SidePanel(props: SidePanelProps): JSX.Element {
  const { bridge, boardStore } = props
  const [tab, setTab] = useState<SideTab>('exec')
  const [data, setData] = useState<ExecutionPanelData | null>(null)
  // 问题 1/6/7：与中央看板共用共享 store（单飞 + 自适应轮询），不再各自维护一份看板快照。
  const board = useBoardStore(boardStore)
  const [target, setTarget] = useState<BoardTaskView | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [notify, setNotify] = useState<string | null>(null)
  // D7：无顶层会话 / subagents 不可达时前置阻断派发（与 ExecutionPanel / TaskCenter 同一判据）。
  const orchestrationBlocked = data?.orchestration?.available === false

  /**
   * 「重采目录」：先让宿主重采能力目录（模型 / 技能 / 预设 / 工作区 / provider / MCP），
   * 再刷新面板。这是用户在插件已打开后补配模型 / 装技能 / 加 MCP server 的**唯一自救入口**——
   * 否则右栏下拉永远停留在宿主 `apply` 期那一次采集的结果（见 `refreshPanelData` 注释）。
   */
  const reloadCatalog = useCallback((): void => {
    setBusy(true)
    bridge
      .refreshPanelData()
      .then(setData)
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
      .finally(() => setBusy(false))
  }, [bridge])

  // 挂载即拉取能力目录：右栏是按需挂载的标签页，这里的一次拉取发生在用户显式打开之后，
  // 不会造成"开机就给 TFS 压力"。挂载时**顺带重采一次目录**：用户多半是刚配完模型
  // 才来开这个标签页的，首屏就拿到最新枚举比让用户再点一次刷新更符合预期。
  // 看板首拉/轮询由共享 boardStore 的 activate 负责，这里不重复拉取（问题 1）。
  useEffect(() => {
    reloadCatalog()
  }, [reloadCatalog])

  const actions = useMemo(
    (): ExecutionActions => ({
      // 目标由 ExecutionPanel 用**它渲染的那份数据**显式回传（见 ExecutionPanel 的 targetRef）。
      confirmWrite: (ops: WriteOpDraft[], ref?: TargetRef) => bridge.confirmWrite(ops, ref),
      // spec 009 问题2 / 问题 7：执行配置页「发起执行」成功后让共享 store 立即失效重拍——
      // 宿主在该动作里新建/启动看板任务，中央任务中心与本右栏列表共用同一快照，立即同步。
      dispatch: async (req: DispatchDraft, taskId?: string, ref?: TargetRef) => {
        const res = await bridge.dispatch(req, taskId, ref)
        if (res.ok) boardStore.invalidate()
        return res
      },
      // 注：原 `parse: bridge.parse` 已移除（桥上无实现，恒 undefined）。
    }),
    [bridge, boardStore],
  )

  const openTasks = useMemo(
    () => (board && board.ok ? board.tasks : new Array<BoardTaskView>()),
    [board],
  )

  /**
   * 右栏宽度有限，故「执行配置」的目标直接沿用中央看板选中的需求无法共享——
   * 这里改为可从**任务中心**就地选一个任务作为目标，形成"右栏内自洽"的闭环。
   *
   * ⚠️ 目标键取任务的 **`requirementId`**（`1997179@WN_HIS`）而**不是** `taskId`
   * （`1997179@WN_HIS#analyze`）：后者按 `@` 切分会得到集合 `WN_HIS#analyze`，
   * 拿它去回写/下发只会得到更费解的失败（2026-09-21 复核）。
   */
  const execData = useMemo<ExecutionPanelData | null>(() => {
    const base = data ?? emptyPanelData()
    if (!target) return base
    const ref = targetRefFromKey(target.requirementId || target.taskId, base.collection)
    return { ...base, targetWorkItem: ref.targetWorkItem, collection: ref.collection }
  }, [data, target])

  /** 就地派发一个看板任务（与中央看板 TaskCenter 的派发口径一致）。 */
  const dispatchTask = async (t: BoardTaskView): Promise<void> => {
    setBusy(true)
    setNotify(null)
    try {
      const role = (data?.roles ?? []).find(r => r.name === t.roleAgent)
      const res = await bridge.dispatch(
        {
          roleName: t.roleAgent,
          prompt: `${t.title}\n\n${t.description}`,
          frozenConfig: t.frozenConfig,
          permission: role?.defaultPermission ?? 'read-only',
        },
        t.taskId,
        // 与中央看板同口径：目标 = 任务所属需求（需求键），不是 `…#stage` 形式的任务 id。
        targetRefFromKey(t.requirementId || t.taskId, data?.collection ?? ''),
      )
      setNotify(res.ok ? `已派发：${t.taskId}` : `派发失败：${res.reason ?? '未知原因'}`)
      boardStore.invalidate()
    } finally {
      setBusy(false)
    }
  }

  /** 任务中心（右栏精简版）：状态 + 角色 + 派发按钮。 */
  const tasksBody = (): JSX.Element => {
    if (!board) return <div style={{ padding: 12, color: '#6b7280', fontSize: 12 }}>加载看板中…</div>
    if (!board.ok) {
      return <div style={{ padding: 12, color: '#dc2626', fontSize: 12 }}>看板不可用：{board.reason ?? '未知原因'}</div>
    }
    if (openTasks.length === 0) {
      return <div style={{ padding: 12, color: '#6b7280', fontSize: 12 }}>暂无任务。请在中央看板「需求池」领取并拆解。</div>
    }
    return (
      <div style={{ padding: 8 }}>
        {openTasks.map(t => (
          <div
            key={t.taskId}
            style={{
              border: target?.taskId === t.taskId ? '1px solid #2563eb' : '1px solid #e5e7eb',
              borderRadius: 6,
              padding: 8,
              marginBottom: 6,
              fontSize: 12,
            }}
          >
            <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
              <span style={statusChipStyle}>{t.state}</span>
              <strong style={{ fontWeight: 600 }}>{t.title}</strong>
            </div>
            <div style={{ color: '#6b7280', marginTop: 4 }}>
              角色：{t.roleAgent || '未分配'} ｜ {t.taskId}
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
              <button
                type="button"
                style={{ ...tabButtonStyle(false), padding: '2px 8px', border: '1px solid #d1d5db', borderRadius: 4 }}
                onClick={() => {
                  setTarget(t)
                  setTab('exec')
                }}
              >
                设为目标
              </button>
              <button
                type="button"
                disabled={busy || orchestrationBlocked}
                title={
                  orchestrationBlocked
                    ? `派发已被前置阻断：${data?.orchestration?.reason ?? '编排能力不可用'}`
                    : undefined
                }
                style={{ ...tabButtonStyle(false), padding: '2px 8px', border: '1px solid #2563eb', borderRadius: 4, color: '#2563eb' }}
                onClick={() => void dispatchTask(t)}
              >
                派发
              </button>
            </div>
          </div>
        ))}
      </div>
    )
  }

  const body = (): JSX.Element => {
    if (error) return <div style={{ padding: 12, color: '#dc2626', fontSize: 12 }}>数据加载失败：{error}</div>
    if (tab === 'tasks') return tasksBody()
    if (!execData) return <div style={{ padding: 12, color: '#6b7280', fontSize: 12 }}>加载中…</div>
    return <ExecutionPanel data={execData} actions={actions} />
  }

  return (
    <div
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
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 2,
          padding: '4px 8px 0',
          borderBottom: '1px solid #e5e7eb',
        }}
      >
        <button type="button" style={tabButtonStyle(tab === 'exec')} onClick={() => setTab('exec')}>
          执行配置
        </button>
        <button type="button" style={tabButtonStyle(tab === 'tasks')} onClick={() => setTab('tasks')}>
          任务({openTasks.length})
        </button>
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#9ca3af' }} title="派发目标">
          {target ? target.taskId : '未选目标'}
        </span>
        <button
          type="button"
          title="重采 DSH 能力目录（模型 / 技能 / 预设 / 工作区 / MCP）"
          aria-label="重采 DSH 能力目录"
          disabled={busy}
          onClick={() => reloadCatalog()}
          style={{
            marginLeft: 6,
            width: 22,
            height: 22,
            borderRadius: 4,
            border: '1px solid #e5e7eb',
            background: '#fff',
            color: busy ? '#9ca3af' : '#6b7280',
            cursor: busy ? 'default' : 'pointer',
            fontSize: 12,
            lineHeight: '18px',
          }}
        >
          ⟳
        </button>
        <button
          type="button"
          title="收起右侧栏"
          aria-label="收起右侧栏"
          onClick={() => props.onClose?.()}
          style={{
            marginLeft: 6,
            width: 22,
            height: 22,
            borderRadius: 4,
            border: '1px solid #e5e7eb',
            background: '#fff',
            color: '#6b7280',
            cursor: 'pointer',
            fontSize: 13,
            lineHeight: '18px',
          }}
        >
          ×
        </button>
      </div>
      {notify && (
        <div style={{ padding: '4px 8px', fontSize: 11, background: '#f0f9ff', color: '#1e40af' }}>{notify}</div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflowY: 'auto' }}>{body()}</div>
    </div>
  )
}

/**
 * 供 slots.tsx 复用的类型：`ExecutionFormState` 只是为了让本模块的
 * `ExecutionActions` 依赖显式化（避免 TS 的 `import type` 被误判为未使用而删掉）。
 */
export type { ExecutionFormState }

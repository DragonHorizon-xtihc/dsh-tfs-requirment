// 执行任务配置面板（T047 / US4）。
//
// 设计参照用户提供的 DSH 看板「新建任务」弹窗（标题/描述/执行 Prompt/标签/冻结快照/交接包引用/
// 工作区/模式/权限/模型/在同一对话继续/定时运行/AI 解析段），并**新增**三类选择器：
//   - MCP 选择（FrozenConfig.mcp）
//   - 技能选择（FrozenConfig.skills）
//   - 角色智能体选择（RoleDefinition，决定 ctx.subagents.start 的 provider 与默认配置）
// 底部含：dry-run 预览卡片（写在门前可见的变更 diff）+「确认回写」按钮（过 WriteGuard 四门禁）+「发起执行」按钮。
//
// 组件为纯展示层：数据经 props 注入，动作经 callbacks 上抛。真实的 TFS REST 写调用与 subagent 分发
// 由宿主接线层（slots.ts）落地，组件不持有任何 host 类型，亦不跨层 import write-guard
// （客户端编译程序仅含 src/client + src/shared）。
//
// 样式采用语义化 HTML + 内联样式（不依赖 dsh-client-ui-primitives 的具体导出，避免臆造组件名）；
// 后续可整体替换为 dsh-client-ui-primitives 原语（Polish T065/a11y）。

import { useEffect, useMemo, useRef, useState } from 'react'
import { MultiSelect } from './MultiSelect.js'
import { buildTargetFill, shouldFillTarget } from '../../shared/pool.js'
import { formatLocalMinute, validateSchedule } from '../../shared/schedule.js'
import { isValidTargetWorkItem, targetRefFromKey } from '../../shared/target.js'
import {
  decodeModelValue,
  formatModelRoute,
  groupModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from '../../shared/model-route.js'
import type {
  WriteOpDraft,
  ExecutionActions,
  ExecutionPanelData,
  ExecutionFormState,
} from '../../shared/contracts.js'

// 以下契约类型（WriteOpDraft / DispatchDraft / ExecutionActions / ExecutionPanelData /
// ExecutionFormState / RoleDefinition / WriteOpType）已移至 src/shared/contracts.ts，
// 避免客户端半依赖宿主半模块（roles.ts/tfs/types.ts 会勾到 node:fs，客户端半 types:[] 不可见）。

/** 单条 dry-run diff 行（UI 本地计算，不依赖 write-guard）。 */
interface PreviewRow {
  field: string
  kind: 'added' | 'changed' | 'removed'
  before?: unknown
  after?: unknown
}

/** 问题 1：把预算输入框文本解析为非负整数；空 / 非法 / 负数一律返回 0（= 不限制）。 */
function parseBudget(raw: string): number {
  const t = raw.trim()
  if (!t) return 0
  const n = Number(t)
  if (!Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

/**
 * 表单初值。
 *
 * **刻意不写死任何"看起来合理"的默认值**（问题 4/5/6/7）：
 *   - `model` 留空 → 渲染时回落为 `data.modelOptions` 的第一项
 *     （即 dsh 真实可用模型）。写死 `deepseek-v4-flash` 会导致该模型在别的部署上不存在时，
 *     UI 显示一个下拉里根本没有的值（`<select>` 会静默显示空白，用户以为没选上）。
 *   - `workspace` 留空 → 回落为 `data.workspaces` 的第一项（dsh 已添加的工作区）。
 *   - `selectedMcp` 留空 → **不再预勾任何 MCP**。原先硬编码 `['tfs-mcp']` 有两个错：
 *     ① 固定死 MCP 名（问题 7）；② 更糟的是它把 TFS 直连能力绑给了某个 MCP 实例，
 *     让模型有绕过插件封装与写门禁的旁路（REST 化后该旁路连凭据都没有，但预勾本身仍是错的）。
 *     TFS 能力现在由插件封装工具 `tfs_req_*` 提供，不再作为"可选 MCP"出现在这里。
 *   - `preset` 留空 → 回落为 dsh 的默认预设（问题 6）。
 */
const DEFAULT_STATE: ExecutionFormState = {
  title: '',
  description: '',
  execPrompt: '',
  reqPrompt: '',
  tags: [],
  workspace: '',
  permission: 'workspace-write',
  model: '',
  preset: '',
  selectedMcp: [],
  selectedSkills: [],
  workflow: '',
  roleName: '',
  scheduleMode: 'now',
  scheduleAtLocal: '',
}

const sectionStyle: React.CSSProperties = {
  border: '1px solid #e5e7eb',
  borderRadius: 8,
  padding: 12,
  marginBottom: 12,
  background: '#fff',
}
const labelStyle: React.CSSProperties = { display: 'block', fontSize: 12, color: '#6b7280', margin: '6px 0 4px' }
const inputStyle: React.CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  padding: '6px 8px',
  border: '1px solid #d1d5db',
  borderRadius: 6,
  fontSize: 13,
}
const buttonStyle: React.CSSProperties = {
  padding: '8px 14px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#f3f4f6',
  cursor: 'pointer',
  fontSize: 13,
}
const primaryButtonStyle: React.CSSProperties = { ...buttonStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }
const dangerButtonStyle: React.CSSProperties = { ...buttonStyle, background: '#dc2626', color: '#fff', borderColor: '#dc2626' }

/**
 * 执行任务配置面板。
 */
export function ExecutionPanel(props: { data: ExecutionPanelData; actions: ExecutionActions }): JSX.Element {
  const { data, actions } = props
  const [form, setForm] = useState<ExecutionFormState>(DEFAULT_STATE)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  // 问题 1：执行预算（本地表单态；留空 = 不限制 / 沿用插件默认）。随派发草稿下发并冻结进任务。
  const [maxDepthInput, setMaxDepthInput] = useState('')
  const [maxTokensInput, setMaxTokensInput] = useState('')

  const set = <K extends keyof ExecutionFormState>(key: K, value: ExecutionFormState[K]): void => {
    setForm(prev => ({ ...prev, [key]: value }))
  }

  // ── US3：选为目标 → 自动带出需求内容（spec 008 US4：每次显式点击都重新带入） ──
  //
  // 此前面板只拿到 `123@WN_HIS` 这个字符串，`title` / `description` / `execPrompt` 恒为空，
  // 用户只能回 TFS 复制正文再粘回来（"设置为目标应该把需求的内容带出显示"）。
  //
  // 触发信号是 slots 层在**每次显式点击「选为目标」时自增的 nonce**，而不是目标键：
  //   - 同一需求第二次选为目标（典型路径：第一次填入 → 发起执行后 resetContent 清空 →
  //     再点同一目标想恢复正文）也会拿到新 nonce，必须重新填入；
  //   - 后台轮询刷新面板数据不产生新 nonce，用户手工编辑不会被顶掉。
  const fillNonce = data.targetFillNonce ?? 0
  const lastFilledNonceRef = useRef(0)
  useEffect(() => {
    if (!shouldFillTarget(fillNonce, lastFilledNonceRef.current, !!data.target)) return
    lastFilledNonceRef.current = fillNonce
    const fill = buildTargetFill(data.target)
    if (!fill) return
    // 2026-11-03 问题 3/1：工作目录与需求级提示词一并带出。
    // 无论工作目录是下拉选的还是手填的都带（手填路径下拉显示「（手填）」项，见下方 select），
    // 需求级提示词进独立字段 —— 宿主派发时自动拼在任务提示词前，绝不复制进 execPrompt。
    setForm(prev => ({
      ...prev,
      title: fill.title,
      description: fill.description,
      execPrompt: fill.execPrompt,
      ...(fill.workspace ? { workspace: fill.workspace } : {}),
      reqPrompt: fill.reqPrompt,
    }))
  }, [fillNonce, data.target])

  // ── 真实枚举（问题 4/5/6/7）：全部取自宿主下发目录，本组件不内置任何兜底清单 ──
  // 用 `?? []` 而非直接下标：宿主目录采集失败时（网络/服务降级）data 可能缺字段，
  // 直接取下标会抛 TypeError 让整个面板白屏。
  const modelOptions = data.modelOptions ?? []
  const workspaces = data.workspaces ?? []
  const presets = data.presets ?? []
  const skillOptions = data.skillOptions ?? []
  const mcpServers = data.mcpServers ?? []

  /**
   * 生效模型（spec 009）：下拉 value 是 `(provider, id)` 的**复合值**（见 shared/model-route.ts），
   * 未显式选择时取 dsh 真实模型清单的第一项并带上它的 provider。
   *
   * 为什么是"渲染时回落"而不是"useEffect 写回 state"：写回 state 会在目录异步到达后
   * 覆盖用户已做的选择（data 更新 → effect 跑 → 用户选的模型被第一项顶掉），
   * 是典型的"异步数据覆盖用户输入"。回落只在读取侧发生，用户一旦选过就以 state 为准。
   */
  const firstModel = modelOptions[0]
  const fallbackModelValue = firstModel ? modelOptionValue(firstModel.provider, firstModel.id) : ''
  const effectiveModel = form.model || fallbackModelValue
  /** 生效模型路由（复合值解码失败的历史裸值按"未绑定供应商"处理）。 */
  const effectiveRoute = decodeModelValue(effectiveModel)
  const effectiveRouteText = effectiveRoute
    ? formatModelRoute(modelOptions, effectiveRoute.id, effectiveRoute.provider)
    : '(未指定，取 dsh 默认)'
  /**
   * 生效工作目录：**只有用户显式选择过**才算数。
   *
   * 刻意**不再**回落到 `workspaces[0]`（旧行为，问题 1 的成因之一）：那会把"面板里没人选过工作区"
   * 变成"用了清单第一个工作区"，再经 `draft.workspace` 覆盖掉任务/需求上真正配置好的目录 ——
   * 用户看到的就是"我明明给任务设了 D:\…\Winning.WiNEX.Plugins，子代理却在别的工程里改代码"。
   * 未选择时留空 ⇒ 宿主按「任务级 → 需求级」回落，语义唯一且可解释。
   *
   * 注意本字段是**绝对路径**（与 `Requirement.workspace` / `TaskSnapshot.workspace` 同语义），
   * 不是 dsh 工作区的 `id`；下拉的 `value` 取 `DshWorkspaceOption.path`。
   */
  const effectiveWorkspace = form.workspace
  // 预设：未显式选择时取 dsh 的默认预设；损坏预设（`broken` 有值）不可选，故不参与回落。
  const defaultPreset = presets.find(p => p.isDefault && !p.broken)
  const effectivePreset = form.preset || defaultPreset?.id || ''

  /**
   * 模型按 provider 分组（spec 009：分组/去重/复合值编解码统一收口到 shared/model-route.ts）。
   * 跨 provider 的同名模型保留为不同分组下的独立选项——option value 带 provider，
   * 不再出现"选火山方舟、提交裸 id 后跑成英伟达"。
   */
  const groupedModels = useMemo(() => groupModelOptions(modelOptions), [modelOptions])

  /**
   * 历史裸值兼容（spec 009）：state 里若残留旧版本写入的裸 id（非复合值），在下拉中追加一项，
   * 文案显式标注"未绑定供应商，沿用会话供应商"，避免 <select> 值不在 options 里静默显示空白。
   */
  const legacyOptionFor = (value: string): { value: string; label: string } | undefined => {
    if (!value || parseModelOptionValue(value)) return undefined
    return { value, label: `${value}（未绑定供应商，沿用会话供应商）` }
  }
  const legacyModel = legacyOptionFor(form.model)

  /** 目录降级原因（问题 1/2）：为空串时整块不渲染。 */
  const catalogIssue = (data.catalogWarnings ?? []).filter(w => w.trim().length > 0)
  const catalogFreshness = data.catalogCollectedAt
    ? `目录采集于 ${new Date(data.catalogCollectedAt).toLocaleString()}`
    : '目录尚未采集'

  /**
   * 派发/回写目标：**以本组件正在渲染的这份数据为准**（2026-09-21 实机事故修复）。
   *
   * 为什么不能交给宿主桥自己取：宿主下发的 `targetWorkItem` 是占位符 `'—'`（"当前目标"
   * 是客户端会话内状态），于是用户"选为目标"后，绑数据是新的、但发出去的仍是 `'—'` ⇒
   * 「确认回写」得到 *targetWorkItem 缺少有效工作项 id：—*、「发起执行」得到 `task=—#role-coder`。
   * 现在目标随这份数据显式传给动作，并在**点击前**就能判出"到底有没有选目标"。
   */
  const targetRef = targetRefFromKey(data.targetWorkItem, data.collection)
  const targetReady = isValidTargetWorkItem(targetRef.targetWorkItem)

  /** US4 编排能力快照：宿主未接线该探测（undefined）时既不提示也不拦按钮。 */
  const orchestration = data.orchestration
  const orchestrationBlocked = orchestration?.available === false

  // 本地 dry-run 预览：以「标签新增 / 评论 / 状态」为可视 diff（与 write-guard 的字段级 diff 同源思想）。
  const preview: PreviewRow[] = useMemo(() => {
    const rows: PreviewRow[] = []
    const addedTags = form.tags
    if (addedTags.length) rows.push({ field: 'tags', kind: 'added', after: addedTags })
    if (form.execPrompt.trim()) rows.push({ field: 'execPrompt', kind: 'changed', after: form.execPrompt.slice(0, 80) + (form.execPrompt.length > 80 ? '…' : '') })
    if (form.selectedMcp.length) rows.push({ field: 'frozenConfig.mcp', kind: 'changed', after: form.selectedMcp })
    if (form.selectedSkills.length) rows.push({ field: 'frozenConfig.skills', kind: 'changed', after: form.selectedSkills })
    if (form.selectedSkills.includes(form.workflow) && form.workflow) {
      rows.push({ field: 'frozenConfig.workflow', kind: 'changed', after: form.workflow })
    }
    if (form.roleName) rows.push({ field: 'roleAgent', kind: 'changed', after: form.roleName })
    rows.push({ field: 'model', kind: 'changed', after: effectiveRouteText })
    if (effectivePreset) rows.push({ field: 'preset', kind: 'changed', after: effectivePreset })
    if (effectiveWorkspace) rows.push({ field: 'workspace', kind: 'changed', after: effectiveWorkspace })
    rows.push({ field: 'permission', kind: 'changed', after: form.permission })
    return rows
  }, [form, effectivePreset, effectiveWorkspace, effectiveRouteText])

  const addTag = (tag: string): void => {
    const t = tag.trim()
    if (t && !form.tags.includes(t)) set('tags', [...form.tags, t])
  }

  const onConfirmWrite = async (): Promise<void> => {
    setBusy(true)
    setMessage(null)
    try {
      const ops: WriteOpDraft[] = [
        { opType: 'tag', before: [], after: form.tags },
        { opType: 'comment', before: null, after: `[DSH] 执行配置：${form.title}\n模型=${effectiveRouteText} 预设=${effectivePreset || '—'} 角色=${form.roleName} MCP=${form.selectedMcp.join(',')}` },
      ]
      const res = await actions.confirmWrite(ops, targetRef)
      setMessage(res.ok ? { kind: 'ok', text: '回写已执行（过四道门禁）' } : { kind: 'err', text: res.reason ?? '回写被拒' })
    } catch (e) {
      // 与「发起执行」同一纪律：任何抛出都要在界面上留下可读反馈，不能静默。
      setMessage({ kind: 'err', text: `回写失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  /**
   * 2026-11-03 用户诉求 1：发起执行成功后**整页重置**执行配置。
   *
   * 曾有 `resetContent`（只清标题/描述/执行 Prompt/标签、保留执行环境，问题 6）——
   * 用户明示要"重置执行配置页面"，且派发已把整套配置冻结进看板任务/定时条目，
   * 留着环境只会让下一次派发带上"上一单的环境"。故整表打回 DEFAULT_STATE
   * （含角色/模型/工作目录/技能/MCP/定时等）并清空执行预算。
   */
  const resetAll = (): void => {
    setForm(DEFAULT_STATE)
    setMaxDepthInput('')
    setMaxTokensInput('')
  }

  const onDispatch = async (): Promise<void> => {
    // 问题 4：定时执行 —— 先校验时机（定时必须给未来时刻，精确到分）。
    const scheduleCheck = validateSchedule({
      mode: form.scheduleMode,
      dueAtLocal: form.scheduleAtLocal,
    })
    if (!scheduleCheck.ok) {
      setMessage({ kind: 'err', text: scheduleCheck.reason })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      const res = await actions.dispatch(
        {
          roleName: form.roleName,
          // 问题 6：标题/描述随草稿下发 —— 宿主会把这次执行落地为一条看板任务，
          // 没有它们的话任务标题只能回落为「<角色名> 手工执行」，用户在任务中心认不出是哪一次。
          title: form.title.trim() || undefined,
          description: form.description.trim() || undefined,
          prompt: form.execPrompt || form.title,
          // 问题 1/3：需求级提示词本次覆盖（「选为目标」带入后可微调；留空 = 沿用需求上存的）。
          ...(form.reqPrompt.trim() ? { requirementPrompt: form.reqPrompt.trim() } : {}),
          // 问题 4：执行时机（'now' = 立刻；'at' = 到点再派发，此刻不建看板任务）。
          schedule: scheduleCheck.plan,
          // 冻结配置用**生效值**：留空时用 dsh 真实清单的第一项，避免把空字符串冻进快照
          // （冻结快照是运行期不可改的，冻个空模型等于这次执行必然拿不到模型）。
          // spec 009：model 与 modelProvider 成对下发——只发裸 id 时子 agent 会继承父聊天
          // 会话的供应商（现场即英伟达），用户在「火山方舟」分组下的选择会被静默掉包。
          frozenConfig: {
            mcp: form.selectedMcp,
            skills: form.selectedSkills,
            model: effectiveRoute?.id ?? '',
            ...(effectiveRoute?.provider ? { modelProvider: effectiveRoute.provider } : {}),
            // 诉求 4：工作流随冻结配置落库，后续「启动 / 重试 / 发起执行」都按它逐步强制。
            ...(form.selectedSkills.includes(form.workflow) ? { workflow: form.workflow } : {}),
          },
          permission: form.permission,
          ...(effectivePreset ? { preset: effectivePreset } : {}),
          // 问题 1：**只传用户显式选择的工作目录**（留空 = 交给宿主按任务/需求回落）。
          ...(effectiveWorkspace ? { workspace: effectiveWorkspace } : {}),
          // 问题 1：执行预算（仅在填了合法正整数时下发；留空 = 沿用插件默认 / 不限制）。
          ...(parseBudget(maxDepthInput) > 0 ? { maxDepth: parseBudget(maxDepthInput) } : {}),
          ...(parseBudget(maxTokensInput) > 0 ? { maxTokens: parseBudget(maxTokensInput) } : {}),
        },
        undefined,
        targetRef,
      )
      if (!res.ok) {
        setMessage({ kind: 'err', text: res.reason ?? '分发失败' })
        return
      }
      if (res.scheduled) {
        const scheduledExtras = [
          res.workspace ? `工作目录：${res.workspace}` : '未指定工作目录（使用任务/需求上配置的目录）',
          '定时条目已落盘：插件重启后到点仍会执行',
        ].filter(Boolean)
        setMessage({
          kind: 'ok',
          text: `已登记定时执行：到 ${formatLocalMinute(res.scheduledAt)}（本地时间，精确到分）后主 agent 自动开始派发`
            + `\n${scheduledExtras.join('\n')}`,
        })
        // 2026-11-03 用户诉求 1 → 第三批问题 3：整页重置防重复登记**并切到任务中心** ——
        // 定时条目在任务中心「定时执行」区可见（到点时间/改时间/取消），留在本页看不到它。
        resetAll()
        actions.onDispatched?.()
        return
      }
      const extras = [
        res.createdTask && res.taskId ? `已创建看板任务 ${res.taskId}（到「任务中心」可查看执行过程）` : '',
        res.workspace ? `工作目录：${res.workspace}` : '未指定工作目录（使用任务/需求上配置的目录）',
      ].filter(Boolean)
      setMessage({ kind: 'ok', text: `已发起执行（并发分发中）${extras.length ? `\n${extras.join('\n')}` : ''}` })
      // 2026-11-03 用户诉求 1：成功后整页重置 + 切到任务中心（看板任务已创建，那里能看执行过程）。
      resetAll()
      actions.onDispatched?.()
    } catch (e) {
      // 2026-10-29：旧实现只有 try/finally —— 任何抛出（桥接异常 / 宿主 500）都会变成
      // unhandled rejection，界面上**一点反馈都没有**，用户只能看到"点了没反应"。
      setMessage({ kind: 'err', text: `发起执行失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', color: '#111827', maxWidth: 720 }}>
      <h3 style={{ margin: '0 0 4px' }}>执行任务配置</h3>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
        目标：<code>{data.targetWorkItem}</code> · 集合 <code>{data.collection}</code>
        {data.pluginLoadedAt && (
          <>
            {' · '}
            宿主插件加载于{' '}
            <span title="宿主半代码只在 dsh 启动时加载一次：若这个时间早于你最后一次重新构建，说明当前跑的是旧代码，需要重启 dsh">
              {new Date(data.pluginLoadedAt).toLocaleString()}
            </span>
          </>
        )}
      </div>

      {/* 基本信息（参照新建任务弹窗） */}
      <div style={sectionStyle}>
        <label style={labelStyle}>标题</label>
        <input style={inputStyle} value={form.title} onChange={e => set('title', e.target.value)} placeholder="任务标题" />
        <label style={labelStyle}>描述</label>
        <textarea style={{ ...inputStyle, minHeight: 56 }} value={form.description} onChange={e => set('description', e.target.value)} />
        <label style={labelStyle}>执行 Prompt（作为子 agent 首条消息）</label>
        <textarea style={{ ...inputStyle, minHeight: 72 }} value={form.execPrompt} onChange={e => set('execPrompt', e.target.value)} placeholder="描述该角色智能体要完成的工作" />
        {/* 问题 1/3：需求级提示词 —— 「选为目标」从任务中心带入（领取入池/编辑里填的那份）。
            派发时宿主自动拼在任务提示词**之前**，故这里不拼进执行 Prompt（拼了会发两份）。
            本字段可微调，仅影响**本次**派发（DispatchDraft.requirementPrompt 覆盖），不回写需求。 */}
        <label style={labelStyle}>需求级提示词（派发时自动拼在任务提示词前；带入自任务中心，可微调）</label>
        <textarea
          style={{ ...inputStyle, minHeight: 56 }}
          value={form.reqPrompt}
          onChange={e => set('reqPrompt', e.target.value)}
          placeholder="留空 = 沿用需求上保存的提示词"
        />
      </div>

      {/* 标签（datalist + 添加，参照弹窗 #dsh-task-board-tag-names） */}
      <div style={sectionStyle}>
        <label style={labelStyle}>标签</label>
        <input
          style={inputStyle}
          list="dsh-exec-tags"
          placeholder="输入后回车添加"
          onKeyDown={e => {
            if (e.key === 'Enter') {
              addTag((e.target as HTMLInputElement).value)
              ;(e.target as HTMLInputElement).value = ''
            }
          }}
        />
        <datalist id="dsh-exec-tags">
          {data.tagSuggestions.map(t => (
            <option key={t} value={t} />
          ))}
        </datalist>
        <div style={{ marginTop: 6 }}>
          {form.tags.map(t => (
            <span key={t} style={{ display: 'inline-block', background: '#eef2ff', color: '#3730a3', borderRadius: 12, padding: '2px 10px', margin: '2px 4px 2px 0', fontSize: 12 }}>
              {t}
              <button style={{ border: 'none', background: 'transparent', cursor: 'pointer', marginLeft: 4, color: '#3730a3' }} onClick={() => set('tags', form.tags.filter(x => x !== t))}>
                ×
              </button>
            </span>
          ))}
        </div>
      </div>

      {/* 新增：MCP / 技能 / 角色智能体选择 */}
      <div style={sectionStyle}>
        {/* 问题 1/2：能力目录是"宿主采集的快照"，用户**先打开插件、后装技能/加 MCP** 是常态，
            所以必须给一个显式重采入口，否则下拉永远停在首次采集那一刻的结果。 */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <span style={{ fontSize: 12, color: '#6b7280' }}>{catalogFreshness}</span>
          <button
            type="button"
            style={{ ...buttonStyle, marginLeft: 'auto' }}
            disabled={busy || !actions.refreshCatalog}
            title={actions.refreshCatalog ? '重新向宿主采集模型/技能/MCP/工作区/预设清单' : '宿主未接线目录重采'}
            onClick={() => {
              if (!actions.refreshCatalog) return
              setBusy(true)
              void actions
                .refreshCatalog()
                .then(() => setMessage({ kind: 'ok', text: '能力目录已重新采集' }))
                .catch(e => setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
                .finally(() => setBusy(false))
            }}
          >
            重新采集目录
          </button>
        </div>
        {catalogIssue.length > 0 && (
          <div style={{ fontSize: 11, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: 6, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
            目录降级（部分数据源不可用）：
            {'\n'}
            {catalogIssue.join('\n')}
          </div>
        )}
        {/* 2026-11-03 用户诉求：技能/MCP 分组 —— 选中即带出组内技能与 MCP（带出后可微调，
            分组只是填充器不是绑定）。分组在「技能分组」页维护。 */}
        {(data.skillGroups?.length ?? 0) > 0 && (
          <>
            <label style={labelStyle}>技能/MCP 分组（选中自动带出组内技能与 MCP，可继续微调）</label>
            <select
              style={inputStyle}
              value=""
              onChange={e => {
                const gid = e.target.value
                if (!gid) return
                const g = (data.skillGroups ?? []).find(x => x.id === gid)
                if (!g) return
                setForm(prev => ({
                  ...prev,
                  selectedSkills: [...new Set(g.skills)],
                  selectedMcp: [...new Set(g.mcp)],
                  // 工作流必须留在技能清单内：带出后若原工作流不在新技能里则清空。
                  workflow: g.skills.includes(prev.workflow) ? prev.workflow : '',
                }))
                setMessage({ kind: 'ok', text: `已带出分组「${g.name}」：技能 ${g.skills.length} 项、MCP ${g.mcp.length} 项（可继续微调）` })
              }}
            >
              <option value="">— 选择分组带出技能/MCP —</option>
              {(data.skillGroups ?? []).map(g => (
                <option key={g.id} value={g.id}>
                  {g.name}（技能 {g.skills.length} · MCP {g.mcp.length}）
                </option>
              ))}
            </select>
          </>
        )}
        {/* 问题 7：MCP 清单 = 宿主实际注册的 MCP server（由工具名前缀 `mcp__<server>__` 反推，
            非配置回显，因此"配置里写了但没起来"的实例不会出现在这里）。支持关键字刷选。 */}
        <label style={labelStyle}>MCP 选择（FrozenConfig.mcp，来自宿主真实注册实例）</label>
        <MultiSelect
          options={mcpServers.map(m => ({ value: m, label: m }))}
          value={form.selectedMcp}
          onChange={next => set('selectedMcp', next)}
          placeholder="未选择 MCP"
          searchPlaceholder="按 server 名刷选…"
        />
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
          TFS 能力由本插件直连 REST 提供（工具名 <code>tfs_req_*</code>），**不需要**在这里勾任何
          MCP。此处勾选的 MCP 会被**强制使用**：派发时把该 server 的真实工具全名写进子代理 prompt，
          落定后核对它是否真被调用；勾了但当前没起来的 server 会在 prompt 里被标注为不可用
          （不会静默当成已使用）。
        </div>

        {/* 问题 7 / 11：技能清单 = 宿主 skills.list() 的真实技能（含来源桶与可调用性），支持刷选。 */}
        <label style={{ ...labelStyle, marginTop: 8 }}>技能选择（FrozenConfig.skills，来自 dsh 已安装技能，当前 {skillOptions.length} 项）</label>
        <MultiSelect
          options={skillOptions.map(s => ({
            value: s.name,
            label: s.name,
            hint: `${s.source}${s.modelInvocable ? ' · 模型可调用' : ''}`,
          }))}
          value={form.selectedSkills}
          onChange={next => setForm(prev => ({
            ...prev,
            selectedSkills: next,
            // 诉求 4：工作流必须留在技能清单内 —— 取消勾选该技能时同步清空工作流，
            // 避免留下"指向不存在技能"的悬空配置（宿主侧也会拒，但 UI 不该制造它）。
            workflow: next.includes(prev.workflow) ? prev.workflow : '',
          }))}
          placeholder="未选择技能"
          searchPlaceholder="按技能名刷选…"
        />

        {/* 2026-10-29（诉求 4，第二轮修正）：工作流**从全部已安装技能中选择**。
            上一版只列"已勾选的技能"，用户必须先想到勾选它才能选工作流 —— 顺序反了。
            现在：下拉列全部技能；选中工作流时**自动把它加入技能清单**（宿主要求
            workflow ∈ skills，这样才能取到正文、才能整篇下发并逐步验收）。 */}
        <label style={{ ...labelStyle, marginTop: 8 }}>
          工作流（从全部已安装技能中选择，共 {skillOptions.length} 项；选中即强制按该技能的流程逐步执行）
        </label>
        <select
          style={inputStyle}
          value={form.workflow}
          onChange={e => {
            const next = e.target.value
            setForm(prev => ({
              ...prev,
              workflow: next,
              // 选中工作流 ⇒ 自动并入技能清单（不重复添加）。
              selectedSkills: next && !prev.selectedSkills.includes(next)
                ? [...prev.selectedSkills, next]
                : prev.selectedSkills,
            }))
          }}
          disabled={skillOptions.length === 0}
        >
          <option value="">— 不启用工作流（自由执行）—</option>
          {skillOptions.map(s => (
            <option key={s.name} value={s.name}>
              {s.name}
              {form.selectedSkills.includes(s.name) ? '（已在技能中）' : ''}
            </option>
          ))}
        </select>
        <div style={{ fontSize: 11, color: '#6b7280', marginTop: 4 }}>
          {skillOptions.length === 0
            ? '宿主未返回技能清单（能力降级）：请点上方「重新采集目录」。'
            : '工作流 = 技能：选中后会自动加入「技能」，插件把该技能正文整篇下发，并从正文解析步骤'
              + '（Phase / Step / 阶段 / 步骤 / 编号标题）。子代理必须逐步输出「✅ 步骤 i/N」，'
              + '跳过任何一步都会被判为不达标。'}
        </div>

        <label style={labelStyle}>角色智能体（决定 provider 与默认配置）</label>        <select style={inputStyle} value={form.roleName} onChange={e => set('roleName', e.target.value)}>
          <option value="">— 请选择 —</option>
          {data.roles.map(r => (
            <option key={r.id} value={r.name}>
              {r.name}（{r.provider}{r.preset ? ` / ${r.preset}` : ''}）
            </option>
          ))}
        </select>
      </div>

      {/* 冻结快照（<<<FREEZE…FREEZE>>>，参照弹窗；本插件对应 FrozenConfig） */}
      <div style={sectionStyle}>
        <label style={labelStyle}>冻结快照（创建时锁定 MCP/技能/模型，运行期不可改）</label>
        <div style={{ background: '#f8fafc', border: '1px dashed #cbd5e1', borderRadius: 6, padding: 8, fontSize: 12, fontFamily: 'monospace', whiteSpace: 'pre-wrap' }}>
          {`<<<FREEZE\nmcp: ${form.selectedMcp.join(', ') || '—'}\nskills: ${form.selectedSkills.join(', ') || '—'}\nworkflow: ${form.selectedSkills.includes(form.workflow) && form.workflow ? `${form.workflow}（强制逐步执行）` : '—'}\nmodel: ${effectiveRouteText}\npreset: ${effectivePreset || '—'}\nworkspace: ${effectiveWorkspace || '(跟随任务/需求)'}\nrole: ${form.roleName || '—'}\nFREEZE>>>`}
        </div>
        {/* 问题 1：执行预算——抑制子代理失控空转 / 无限委派，降低 token 消耗。 */}
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginTop: 8 }}>
          <label style={{ flex: 1, minWidth: 180, fontSize: 12, color: '#374151' }}>
            最大委派深度（0/空 = 不限，建议 1）
            <input
              type="number"
              min={0}
              step={1}
              style={{ ...inputStyle, marginTop: 2 }}
              value={maxDepthInput}
              onChange={e => setMaxDepthInput(e.target.value)}
              placeholder="如 1"
            />
          </label>
          <label style={{ flex: 1, minWidth: 220, fontSize: 12, color: '#374151' }}>
            单次最大输出 token（0/空 = 不限）
            <input
              type="number"
              min={0}
              step={1000}
              style={{ ...inputStyle, marginTop: 2 }}
              value={maxTokensInput}
              onChange={e => setMaxTokensInput(e.target.value)}
              placeholder="如 20000"
            />
          </label>
        </div>
      </div>

      {/* 交接包引用 / 工作区 / 模式 / 权限 / 模型（参照弹窗） */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          <div style={{ flex: 1, minWidth: 160 }}>
            {/* 问题 1：工作区下拉 = dsh 已添加的工作区（宿主 workspaceRegistry.list()）。
                **value 取 `path`（绝对路径）**而不是 `id`：本字段要写进任务/需求的"代码库目录"
                并最终进入派发 prompt，写成 id 的话子代理会拿到一个不是路径的字符串
                （旧实现正是取 `w.id`，与需求池领取弹框、任务编辑弹框用的 `w.path` 语义不一致）。
                留空 = 跟随任务/需求上已配置的目录（由宿主按 任务级 → 需求级 回落）。 */}
            <label style={labelStyle}>工作目录（覆盖任务/需求上的配置，留空即跟随）</label>
            <select
              style={inputStyle}
              value={workspaces.some(w => w.path === form.workspace) ? form.workspace : (form.workspace ? '__manual__' : '')}
              onChange={e => set('workspace', e.target.value === '__manual__' ? form.workspace : e.target.value)}
            >
              <option value="">— 跟随任务/需求配置 —</option>
              {workspaces.map(w => (
                <option key={w.id} value={w.path}>
                  {w.title}
                  {w.path && w.path !== w.title ? `（${w.path}）` : ''}
                </option>
              ))}
              {form.workspace && !workspaces.some(w => w.path === form.workspace) && (
                <option value="__manual__">{form.workspace}（手填）</option>
              )}
            </select>
            {/* 问题 3：手填绝对路径（与需求编辑/领取弹框同纪律）——「选为目标」带出的
                手填目录会出现在上方下拉的「（手填）」项里；这里可直接改。 */}
            <input
              style={{ ...inputStyle, marginTop: 4 }}
              placeholder="或手填绝对路径，如 D:\\code\\his"
              value={form.workspace}
              onChange={e => set('workspace', e.target.value)}
            />
            {workspaces.length === 0 && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>
                宿主未返回工作区清单（能力降级）：可留空跟随任务/需求，或手填绝对路径。
              </div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            {/* 问题 6：预设下拉 = dsh 的 agent preset（宿主 agentPresets.list()）。
                损坏预设（broken 有值）标出且禁用——选了它派发必然失败，不如提前拦住。 */}
            <label style={labelStyle}>预设（dsh agent preset）</label>
            <select style={inputStyle} value={effectivePreset} onChange={e => set('preset', e.target.value)}>
              <option value="">— 不指定 —</option>
              {presets.map(p => (
                <option key={p.id} value={p.id} disabled={!!p.broken} title={p.broken ?? p.description}>
                  {p.name}
                  {p.isDefault ? '（默认）' : ''}
                  {p.broken ? ' ⚠ 损坏' : ''}
                </option>
              ))}
            </select>
            {presets.length === 0 && (
              <div style={{ fontSize: 11, color: '#9ca3af', marginTop: 2 }}>宿主未返回预设清单（能力降级）</div>
            )}
          </div>
          <div style={{ flex: 1, minWidth: 160 }}>
            <label style={labelStyle}>权限</label>
            <select style={inputStyle} value={form.permission} onChange={e => set('permission', e.target.value as ExecutionFormState['permission'])}>
              <option value="read-only">read-only</option>
              <option value="workspace-write">workspace-write</option>
              <option value="danger-full-access">danger-full-access</option>
            </select>
          </div>
          <div style={{ flex: 1, minWidth: 200 }}>
            {/* spec 009：模型下拉按 provider 分组，option value 是 (provider,id) 复合值——
                裸 id 只在单个 provider 内唯一，跨供应商重名模型（如 deepseek-v4-flash 同时
                存在于火山方舟与 deepseek 官方）若只提交 id，供应商会在点击瞬间丢失。 */}
            <label style={labelStyle}>模型（dsh 可选模型）</label>
            <select style={inputStyle} value={effectiveModel} onChange={e => set('model', e.target.value)}>
              {groupedModels.length === 0 && !legacyModel && <option value="">— 宿主未返回模型 —</option>}
              {legacyModel && <option value={legacyModel.value}>{legacyModel.label}</option>}
              {groupedModels.map(g => (
                <optgroup key={g.provider} label={g.providerName}>
                  {g.items.map(m => {
                    const v = modelOptionValue(m.provider, m.id)
                    return (
                      <option key={v} value={v} title={m.description ?? m.name}>
                        {m.name || m.id}
                      </option>
                    )
                  })}
                </optgroup>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* Dry-run 预览卡片（写在门前可见的变更 diff） */}
      <div style={{ ...sectionStyle, background: '#f0fdf4', borderColor: '#86efac' }}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>Dry-run 预览（确认回写前可见）</div>
        {preview.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>暂无变更</div>}
        {preview.map((row, i) => (
          <div key={i} style={{ fontSize: 12, padding: '2px 0', borderTop: i === 0 ? 'none' : '1px solid #d1fae5' }}>
            <span style={{ color: '#059669', fontWeight: 600 }}>{row.kind}</span> <code>{row.field}</code>
            {row.before !== undefined && <span> · 前：{JSON.stringify(row.before)}</span>}
            {row.after !== undefined && <span> · 后：{JSON.stringify(row.after)}</span>}
          </div>
        ))}
      </div>

      {/* 问题 4：执行时机 —— 立刻（默认）/ 定时（精确到分）。
          定时条目落盘（schedules.json）：到点后主 agent 自动开始派发，插件重启也补跑。 */}
      <div style={sectionStyle}>
        <label style={labelStyle}>执行时机</label>
        <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap' }}>
          <label style={{ fontSize: 13, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={form.scheduleMode === 'now'}
              onChange={() => set('scheduleMode', 'now')}
              style={{ marginRight: 4 }}
            />
            立刻（默认）
          </label>
          <label style={{ fontSize: 13, cursor: 'pointer' }}>
            <input
              type="radio"
              checked={form.scheduleMode === 'at'}
              onChange={() => set('scheduleMode', 'at')}
              style={{ marginRight: 4 }}
            />
            定时
          </label>
          {form.scheduleMode === 'at' && (
            <input
              type="datetime-local"
              style={{ ...inputStyle, width: 'auto' }}
              value={form.scheduleAtLocal}
              onChange={e => set('scheduleAtLocal', e.target.value)}
            />
          )}
          {form.scheduleMode === 'at' && (
            <span style={{ fontSize: 11, color: '#6b7280' }}>到点后主 agent 自动开始派发（精确到分）</span>
          )}
        </div>
      </div>

      {/* 动作。
          两个按钮的禁用条件都是**点击前可见的事实**（2026-09-21 修复）：
            - 没选目标 ⇒ 回写必然被拒（TFS 要工作项 id）；发起执行也无需求上下文可绑定；
            - 宿主 subagents 服务不可达 ⇒ 派发必然失败（由 panel-data 的 orchestration 现算）。 */}
      <div style={{ display: 'flex', gap: 10, marginTop: 8 }}>
        <button
          style={primaryButtonStyle}
          disabled={busy || !targetReady}
          title={targetReady ? '' : '请先在「需求池」或「任务中心」点某个需求「选为目标」'}
          onClick={onConfirmWrite}
        >
          确认回写
        </button>
        <button
          style={dangerButtonStyle}
          /* 2026-10-29（诉求 3：点击毫无反应）：**不再因为编排能力被探针判不可用就禁用按钮**。
             禁用按钮 + 一段红色说明，在用户眼里就是"点了没有任何反应"——既没有请求、也没有反馈。
             现在按钮始终可点：编排不可用时点击立即把原因写进下方消息区（可复制、可截图），
             编排可用时照常发起真实派发（失败也会显示宿主回传的原因）。 */
          disabled={busy || !form.roleName || !targetReady}
          title={
            !form.roleName
              ? '请先选择角色智能体'
              : !targetReady
                ? '请先在「需求池」或「任务中心」点某个需求「选为目标」'
                : orchestrationBlocked
                  ? `编排能力当前不可用（点击查看原因）：${orchestration?.reason ?? '未知原因'}`
                  : ''
          }
          onClick={() => {
            if (orchestrationBlocked) {
              setMessage({
                kind: 'err',
                text: `未发起执行：${orchestration?.reason ?? '宿主编排能力不可用'}\n`
                  + '（若刚重新构建/替换过插件，请重启 dsh 后再试：宿主半代码只在启动时加载。）',
              })
              return
            }
            void onDispatch()
          }}
        >
          {form.scheduleMode === 'at' ? '定时执行' : '发起执行'}
        </button>
      </div>
      {!targetReady && (
        <div style={{ marginTop: 8, fontSize: 12, color: '#b45309' }}>
          当前没有有效目标（面板下发的值是 <code>{data.targetWorkItem || '(空)'}</code>）：
          请先到「需求池」或「任务中心」把某个需求「选为目标」，再回到本页配置执行。
        </div>
      )}
      {orchestrationBlocked && (
        <div
          style={{
            marginTop: 8,
            fontSize: 12,
            color: '#b91c1c',
            background: '#fef2f2',
            border: '1px solid #fecaca',
            borderRadius: 6,
            padding: 8,
          }}
        >
          宿主编排能力不可用（US4）：{orchestration?.reason ?? '未给出原因'}
          <br />
          排查：① 提示“未提供或尚未激活” ⇒ 在 profile 中确认已装载 <code>@deepseek-ai/dsh-subagent</code> 并重启 dsh；
          ② 提示“既没有 startActivation 也没有 start” ⇒ 宿主 <code>@deepseek-ai/dsh-subagent</code> 版本与本插件不匹配，
          请升级到 0.2.1 及以上（该版本用 <code>startActivation</code> 取代了 <code>start</code>）。
          <br />
          （此提示每次打开本页都会重新探测，不需要重启界面。）
        </div>
      )}
      {orchestration?.available && (
        <div style={{ marginTop: 8, fontSize: 11, color: '#6b7280' }}>
          派发通道：<code>{orchestration.api ?? '自动'}</code>
          {orchestration.providers.length > 0
            ? ` ｜ 可用 subagent provider：${orchestration.providers.join('、')}（角色的 provider 须取其中之一）`
            : ' ｜ 宿主未上报 provider 清单'}
          {orchestration.parentOnDemand
            ? ' ｜ 当前没有活跃会话：发起时将由宿主自动恢复/新建一个会话承载子智能体（不需要先开聊天窗口）'
            : ''}
        </div>
      )}
      {message && (
        <div
          style={{
            marginTop: 10,
            fontSize: 13,
            color: message.kind === 'ok' ? '#059669' : '#dc2626',
            // 成功提示含"已创建看板任务 xxx / 工作目录：xxx"两行，必须换行显示。
            whiteSpace: 'pre-wrap',
          }}
        >
          {message.text}
        </div>
      )}
    </div>
  )
}

export default ExecutionPanel

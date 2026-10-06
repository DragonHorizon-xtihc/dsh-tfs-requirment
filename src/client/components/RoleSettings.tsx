// 角色智能体管理面板（T055 / US5）+ 问题 9/10/11 修正。
//
// CRUD：列出角色、新建/编辑（provider、preset、autoExecute、默认模型/MCP/技能、标签策略）、删除。
// T056：引用缺失（provider/preset 不在宿主可用清单）时在列表内提示（providers/presets 由宿主注入）。
// T057：删除被引用角色时宿主返回 references 清单，UI 要求二次确认（force）。
//
// ## 2026-09-18 修正的三条
//
// - **问题 9**：provider 原是**自由文本输入框**（`<input>`）。用户问"能否下拉选择"——能：
//   宿主 `dsh-subagent` 的 `SubagentProvider.name` 是有限集合，经 `ctx.subagents.list()`
//   拿到后渲染成下拉即可，自由文本只会让人填出宿主不存在的 provider（T056 才在事后报错）。
// - **问题 10**：原实现只有「清空」按钮且文案含糊，点过「编辑」后表单一直停在编辑态，
//   看起来"再也不能新增角色"。现在显式区分三个动作：**新建角色**（重置并聚焦）/
//   **保存**（新建或更新）/ **取消编辑**。
// - **问题 11**：模型、技能、MCP 原是 `datalist` + 逗号分隔文本，既不能刷选也不是真下拉。
//   现统一换成 `MultiSelect`（可关键字刷选）：模型为单选，技能与 MCP 为多选。
//
// 组件为纯展示层：数据与动作经 props 注入，不直接 fetch。

import { useMemo, useState } from 'react'
import { MultiSelect } from './MultiSelect.js'
import {
  decodeModelValue,
  groupModelOptions,
  modelOptionValue,
  parseModelOptionValue,
} from '../../shared/model-route.js'
import type {
  DshModelOption,
  DshPresetOption,
  DshSkillOption,
  RoleDefinition,
} from '../../shared/contracts.js'

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
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#f3f4f6',
  cursor: 'pointer',
  fontSize: 13,
}
const primaryButtonStyle: React.CSSProperties = { ...buttonStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb' }

/** 空角色模板（新建用；`provider` 留空，由 UI 回落到宿主 provider 清单第一项）。 */
const EMPTY_ROLE: RoleDefinition = {
  id: '',
  name: '',
  description: '',
  provider: '',
  defaultModel: '',
  defaultMcp: [],
  defaultSkills: [],
  autoExecute: false,
  tagStrategy: 'dsh',
}

// 注：spec 009 删除了旧的 buildModelItems（跨 provider 按 id 去重）。
// 旧实现把"同一个模型 id 的不同供应商版本"合并成一项，注释还声称"供应商由 role.provider 决定"——
// 这是概念混淆：role.provider 是**子智能体驱动名**（spawn/fork），与 LLM 路由供应商无关。
// 角色默认模型的供应商现在由 RoleDefinition.defaultModelProvider 与 defaultModel 成对承载，
// 下拉分组/编解码统一走 shared/model-route.ts 的 groupModelOptions / modelOptionValue。

/**
 * 角色管理面板。
 * @param props.roles - 角色清单。
 * @param props.modelOptions - dsh 真实模型清单（问题 11）。
 * @param props.skillOptions - dsh 真实技能清单（问题 11）。
 * @param props.mcpServers - 宿主真实注册的 MCP server 名清单（问题 7/11）。
 * @param props.providers - 宿主可用 subagent provider 名（问题 9 / T056 引用校验）。
 * @param props.presets - dsh 真实 agent preset 清单（问题 11）。
 * @param props.onSave - 保存回调。
 * @param props.onDelete - 删除回调（force=true 表示已确认）。
 */
export function RoleSettings(props: {
  roles: RoleDefinition[]
  modelOptions?: DshModelOption[]
  skillOptions?: DshSkillOption[]
  mcpServers?: string[]
  providers?: string[]
  presets?: DshPresetOption[]
  availableProviders?: string[]
  onSave: (role: RoleDefinition) => Promise<{ ok: boolean; reason?: string }>
  onDelete: (id: string, force?: boolean) => Promise<{ ok: boolean; reason?: string; references?: string[] }>
  /**
   * 强制重采 DSH 能力目录（问题 1/2）。
   *
   * 角色管理页的模型/技能/MCP 三个下拉与执行配置页取自**同一份**宿主目录快照，
   * 因此这里也必须能给一个重采入口；否则用户在这个页签里永远看不到刚装的技能/MCP。
   */
  onRefreshCatalog?: () => Promise<void>
  /** 目录降级原因（问题 1/2 的可见性）。 */
  catalogWarnings?: string[]
  /** 目录采集时刻（ISO）。 */
  catalogCollectedAt?: string
}): JSX.Element {
  const [draft, setDraft] = useState<RoleDefinition>(EMPTY_ROLE)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)
  const [busy, setBusy] = useState(false)

  const providers = props.providers ?? props.availableProviders ?? []
  const modelOptions = props.modelOptions ?? []
  const skillOptions = props.skillOptions ?? []
  const mcpServers = props.mcpServers ?? []
  const presets = props.presets ?? []

  const providerMissing = (r: RoleDefinition): boolean =>
    providers.length > 0 && !providers.includes(r.provider)

  /** 生效 provider：空则回落到宿主清单第一项（渲染侧回落，避免异步目录覆盖用户输入）。 */
  const effectiveProvider = draft.provider || providers[0] || ''
  /** 生效 preset：空 = 不指定（preset 本来就可选，不做回落）。 */
  const effectivePreset = draft.preset ?? ''

  /** 模型按 LLM provider 分组（spec 009：跨 provider 同名模型保留为独立选项）。 */
  const groupedModels = useMemo(() => groupModelOptions(modelOptions), [modelOptions])

  /**
   * 默认模型下拉的当前复合值。
   * - 新数据：defaultModelProvider + defaultModel 成对 ⇒ 复合值；
   * - 历史角色（roles.json 里只有裸 id）⇒ 保留裸值，下拉追加"未绑定供应商"项。
   */
  const modelSelectValue = draft.defaultModel
    ? (draft.defaultModelProvider
        ? modelOptionValue(draft.defaultModelProvider, draft.defaultModel)
        : draft.defaultModel)
    : ''
  const legacyModel =
    modelSelectValue && !parseModelOptionValue(modelSelectValue)
      ? { value: modelSelectValue, label: `${modelSelectValue}（未绑定供应商，沿用会话供应商）` }
      : undefined

  const edit = (r: RoleDefinition): void => {
    setDraft({ ...r })
    setMessage(null)
  }

  /**
   * 问题 10：显式「新建角色」。
   *
   * 原实现只有「清空」，且清空后表单标题仍可能停在"编辑：xxx"的语境里，用户因此认为
   * "点过编辑就再也加不了新角色"。这里直接重置到 `EMPTY_ROLE` 并给明确反馈。
   */
  const newRole = (): void => {
    setDraft({ ...EMPTY_ROLE })
    setMessage({ kind: 'ok', text: '已切换到新建模式，填写后点「保存」' })
  }

  const save = async (): Promise<void> => {
    setBusy(true)
    try {
      // provider 用生效值：留空时取宿主清单第一项，绝不把空 provider 存进 roles.json
      // （那样 T056 会在派发时才报"未绑定 provider"，排查成本远高于保存时拦住）。
      // spec 009：默认模型与 LLM 供应商**成对归一**——无模型时删掉供应商键，
      // 避免 roles.json 里留下"有 provider 没 model"的悬空路由。
      const modelRoute = decodeModelValue(modelSelectValue)
      const role: RoleDefinition = {
        ...draft,
        provider: effectiveProvider,
        id: draft.id || `role-${Date.now().toString(36)}`,
        defaultModel: modelRoute?.id ?? '',
        ...(modelRoute?.provider ? { defaultModelProvider: modelRoute.provider } : {}),
        ...(effectivePreset ? { preset: effectivePreset } : {}),
      }
      if (!modelRoute?.provider) delete role.defaultModelProvider
      const res = await props.onSave(role)
      setMessage(res.ok ? { kind: 'ok', text: `已保存角色「${role.name}」` } : { kind: 'err', text: res.reason ?? '保存失败' })
      if (res.ok) setDraft({ ...EMPTY_ROLE })
    } finally {
      setBusy(false)
    }
  }

  const remove = async (r: RoleDefinition): Promise<void> => {
    setBusy(true)
    try {
      let res = await props.onDelete(r.id)
      // T057：被引用则要求二次确认，确认后带 force 重试。
      if (!res.ok && res.references && res.references.length > 0) {
        const yes = globalThis.confirm?.(`角色「${r.name}」被 ${res.references.length} 处引用，仍要删除？`) ?? false
        if (yes) res = await props.onDelete(r.id, true)
      }
      setMessage(res.ok ? { kind: 'ok', text: `已删除角色「${r.name}」` } : { kind: 'err', text: res.reason ?? '删除失败' })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', color: '#111827', maxWidth: 820 }}>
      <div style={{ display: 'flex', alignItems: 'center', marginBottom: 12 }}>
        <h3 style={{ margin: 0 }}>角色智能体管理</h3>
        {/* 问题 10：新增按钮放在标题旁，与"编辑"并列，避免只靠底部「清空」猜语义。 */}
        <button type="button" style={{ ...primaryButtonStyle, marginLeft: 'auto' }} disabled={busy} onClick={newRole}>
          ＋ 新建角色
        </button>
      </div>

      {/* 问题 1/2：模型/技能/MCP 下拉取自宿主目录快照，必须给重采入口 + 降级可见。 */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, fontSize: 12, color: '#6b7280' }}>
        <span>
          模型 {modelOptions.length} 项 ｜ 技能 {skillOptions.length} 项 ｜ MCP {mcpServers.length} 项
          {props.catalogCollectedAt ? ` ｜ 采集于 ${new Date(props.catalogCollectedAt).toLocaleString()}` : ' ｜ 目录尚未采集'}
        </span>
        <button
          type="button"
          style={{ ...buttonStyle, marginLeft: 'auto' }}
          disabled={busy || !props.onRefreshCatalog}
          title={props.onRefreshCatalog ? '重新向宿主采集模型/技能/MCP 清单' : '宿主未接线目录重采'}
          onClick={() => {
            if (!props.onRefreshCatalog) return
            setBusy(true)
            void props
              .onRefreshCatalog()
              .then(() => setMessage({ kind: 'ok', text: '能力目录已重新采集' }))
              .catch(e => setMessage({ kind: 'err', text: e instanceof Error ? e.message : String(e) }))
              .finally(() => setBusy(false))
          }}
        >
          重新采集目录
        </button>
      </div>
      {(props.catalogWarnings ?? []).filter(w => w.trim().length > 0).length > 0 && (
        <div style={{ fontSize: 11, color: '#b45309', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 6, padding: 6, marginBottom: 8, whiteSpace: 'pre-wrap' }}>
          目录降级（部分数据源不可用）：
          {'\n'}
          {(props.catalogWarnings ?? []).filter(w => w.trim().length > 0).join('\n')}
        </div>
      )}

      <div style={sectionStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>现有角色</div>
        {props.roles.length === 0 && <div style={{ fontSize: 12, color: '#6b7280' }}>暂无角色，点击右上「＋ 新建角色」。</div>}
        {props.roles.map(r => (
          <div key={r.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', borderTop: '1px solid #f1f5f9' }}>
            <div style={{ flex: 1, fontSize: 13 }}>
              <strong>{r.name}</strong>
              <span style={{ color: '#6b7280' }}> · provider={r.provider}{r.preset ? ` / preset=${r.preset}` : ''}</span>
              {providerMissing(r) && <span style={{ color: '#b45309', marginLeft: 8 }}>⚠ provider 在宿主不可用（T056）</span>}
            </div>
            <button type="button" style={buttonStyle} onClick={() => edit(r)}>编辑</button>
            <button type="button" style={buttonStyle} disabled={busy} onClick={() => remove(r)}>删除</button>
          </div>
        ))}
      </div>

      <div style={sectionStyle}>
        <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
          {draft.id ? `编辑：${draft.name || draft.id}` : '新建角色'}
        </div>
        <label style={labelStyle}>角色 ID（稳定主键，留空自动生成）</label>
        <input style={inputStyle} value={draft.id} onChange={e => setDraft({ ...draft, id: e.target.value })} />
        <label style={labelStyle}>展示名（任务引用键，须唯一）</label>
        <input style={inputStyle} value={draft.name} onChange={e => setDraft({ ...draft, name: e.target.value })} />
        <label style={labelStyle}>描述</label>
        <input style={inputStyle} value={draft.description ?? ''} onChange={e => setDraft({ ...draft, description: e.target.value })} />

        {/* 问题 9：provider 下拉 = 宿主 ctx.subagents 真实 provider 清单。
            清单为空（宿主未注入）时退回文本框并明确提示，而不是静默给个写死的 'spawn'。 */}
        <label style={labelStyle}>宿主 subagent provider（ctx.subagents.start 的 name）</label>
        {providers.length === 0 ? (
          <>
            <input
              style={inputStyle}
              value={draft.provider}
              placeholder="宿主未返回 provider 清单，请手动填写"
              onChange={e => setDraft({ ...draft, provider: e.target.value })}
            />
            <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
              宿主未返回 provider 清单（能力降级）：此处只能手填，保存后可能因 provider 不存在而不可用（T056）。
            </div>
          </>
        ) : (
          <select style={inputStyle} value={effectiveProvider} onChange={e => setDraft({ ...draft, provider: e.target.value })}>
            <option value="">— 请选择 —</option>
            {providers.map(p => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        )}

        {/* 问题 11：preset 下拉 = dsh 真实预设；损坏预设禁用。 */}
        <label style={{ ...labelStyle, marginTop: 8 }}>agent preset（可选，dsh 预设）</label>
        <select
          style={inputStyle}
          value={effectivePreset}
          onChange={e => setDraft({ ...draft, preset: e.target.value || undefined })}
        >
          <option value="">— 不指定 —</option>
          {presets.map(p => (
            <option key={p.id} value={p.id} disabled={!!p.broken} title={p.broken ?? p.description}>
              {p.name}
              {p.isDefault ? '（默认）' : ''}
              {p.broken ? ' ⚠ 损坏' : ''}
            </option>
          ))}
        </select>

        {/* spec 009：默认模型按 LLM 供应商分组，option value 为 (provider,id) 复合值。
            跨供应商同名模型（如火山方舟与 deepseek 官方都暴露 deepseek-v4-flash）必须是两个选项，
            否则角色默认模型只会冻下裸 id，派发时子 agent 继承父会话供应商，造成供应商掉包。 */}
        <label style={{ ...labelStyle, marginTop: 8 }}>默认模型（按供应商分组，来自 dsh，当前 {modelOptions.length} 项）</label>
        <select
          style={inputStyle}
          value={modelSelectValue}
          onChange={e => {
            const route = decodeModelValue(e.target.value)
            setDraft({
              ...draft,
              defaultModel: route?.id ?? '',
              ...(route?.provider ? { defaultModelProvider: route.provider } : {}),
            })
            if (!route?.provider) setDraft(d => ({ ...d, defaultModelProvider: undefined }))
          }}
        >
          <option value="">— 未指定（派发时取 dsh 默认）—</option>
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
        {groupedModels.length === 0 && (
          <div style={{ fontSize: 11, color: '#b45309', marginTop: 2 }}>
            宿主未返回模型清单（能力降级）：可留空，或到「执行配置」点「重新采集目录」。
          </div>
        )}

        <label style={{ ...labelStyle, marginTop: 8 }}>默认 MCP（可刷选，来自宿主真实注册实例，当前 {mcpServers.length} 项）</label>
        <MultiSelect
          options={mcpServers.map(m => ({ value: m, label: m }))}
          value={draft.defaultMcp ?? []}
          onChange={next => setDraft({ ...draft, defaultMcp: next })}
          placeholder="未选择 MCP"
          searchPlaceholder="按 server 名刷选…"
        />

        <label style={{ ...labelStyle, marginTop: 8 }}>默认技能（可刷选，来自 dsh 已安装技能）</label>
        <MultiSelect
          options={skillOptions.map(s => ({
            value: s.name,
            label: s.name,
            hint: `${s.source}${s.modelInvocable ? ' · 模型可调用' : ''}`,
          }))}
          value={draft.defaultSkills ?? []}
          onChange={next => setDraft({ ...draft, defaultSkills: next })}
          placeholder="未选择技能"
          searchPlaceholder="按技能名刷选…"
        />

        <label style={labelStyle}>标签策略</label>
        <input style={inputStyle} value={draft.tagStrategy ?? ''} onChange={e => setDraft({ ...draft, tagStrategy: e.target.value })} />
        <label style={{ display: 'inline-flex', alignItems: 'center', marginTop: 8, fontSize: 13 }}>
          <input type="checkbox" checked={!!draft.autoExecute} onChange={e => setDraft({ ...draft, autoExecute: e.target.checked })} />
          指派后自动发起执行（S-13）
        </label>
        <div style={{ marginTop: 10, display: 'flex', gap: 8 }}>
          <button type="button" style={primaryButtonStyle} disabled={busy || !draft.name.trim()} onClick={save}>
            保存
          </button>
          {/* 问题 10：取消编辑 = 回到新建模式（与「＋ 新建角色」同一语义，文案不再含糊）。 */}
          <button type="button" style={buttonStyle} disabled={busy} onClick={newRole}>
            取消编辑 / 重置
          </button>
        </div>
      </div>

      {message && (
        <div style={{ fontSize: 13, color: message.kind === 'ok' ? '#059669' : '#dc2626' }}>{message.text}</div>
      )}
    </div>
  )
}

export default RoleSettings

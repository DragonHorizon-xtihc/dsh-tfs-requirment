// 技能/MCP 分组管理页（2026-11-03 用户诉求）。
//
// 把一组常用技能 + MCP server 打包成可复用的"能力包"（落宿主 `skill-groups.json`）。
// 执行配置页与任务编辑弹框选中分组后自动带出组内技能/MCP（带出后可微调，分组只是填充器）。
//
// 组件为纯展示层：数据经 props 注入，动作经 callbacks 上抛（与 RoleSettings 同纪律）。
// 样式沿用语义化 HTML + 内联样式。

import { useState } from 'react'
import { MultiSelect } from './MultiSelect.js'
import type { DshSkillOption, SkillMcpGroup } from '../../shared/contracts.js'

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

/** 新建分组的空白表单。 */
function emptyDraft(): SkillMcpGroup {
  const now = new Date().toISOString()
  return { id: '', name: '', description: '', skills: [], mcp: [], createdAt: '', updatedAt: now }
}

export function SkillGroupPanel(props: {
  groups: SkillMcpGroup[]
  skillOptions: DshSkillOption[]
  mcpServers: string[]
  onSave: (group: SkillMcpGroup) => Promise<{ ok: boolean; reason?: string }>
  onDelete: (id: string) => Promise<{ ok: boolean; reason?: string }>
}): JSX.Element {
  const { groups, skillOptions, mcpServers } = props
  /** 正在编辑的分组；null = 未在编辑。id 为空串 = 新建。 */
  const [draft, setDraft] = useState<SkillMcpGroup | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null)

  const set = <K extends keyof SkillMcpGroup>(key: K, value: SkillMcpGroup[K]): void => {
    setDraft(prev => (prev ? { ...prev, [key]: value } : prev))
  }

  const onSave = async (): Promise<void> => {
    if (!draft) return
    const name = draft.name.trim()
    if (!name) {
      setMessage({ kind: 'err', text: '请填写分组名' })
      return
    }
    setBusy(true)
    setMessage(null)
    try {
      // 同名=覆盖：id 留空时按名字找已有分组的 id（"保存为新版本"语义），找不到再生成新 id。
      const existing = draft.id
        ? groups.find(g => g.id === draft.id)
        : groups.find(g => g.name.trim().toLowerCase() === name.toLowerCase())
      const id = draft.id || existing?.id || `sg-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
      const res = await props.onSave({
        ...draft,
        id,
        name,
        createdAt: existing?.createdAt ?? draft.createdAt ?? '',
      })
      if (res.ok) {
        setMessage({ kind: 'ok', text: `分组「${name}」已保存` })
        setDraft(null)
      } else {
        setMessage({ kind: 'err', text: res.reason ?? '保存失败' })
      }
    } catch (e) {
      setMessage({ kind: 'err', text: `保存失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  const onDelete = async (g: SkillMcpGroup): Promise<void> => {
    if (!window.confirm(`确认删除分组「${g.name}」？\n只删除本地分组记录，不影响已按该分组带出的技能/MCP 选择。`)) return
    setBusy(true)
    setMessage(null)
    try {
      const res = await props.onDelete(g.id)
      if (res.ok) {
        setMessage({ kind: 'ok', text: `分组「${g.name}」已删除` })
        if (draft?.id === g.id) setDraft(null)
      } else {
        setMessage({ kind: 'err', text: res.reason ?? '删除失败' })
      }
    } catch (e) {
      setMessage({ kind: 'err', text: `删除失败：${e instanceof Error ? e.message : String(e)}` })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', color: '#111827', maxWidth: 720 }}>
      <h3 style={{ margin: '0 0 4px' }}>技能/MCP 分组</h3>
      <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 12 }}>
        把常用技能 + MCP 打包成能力包：在「执行配置」或任务编辑弹框里选中分组，自动带出组内的技能与 MCP。
        分组落盘在插件数据目录 <code>skill-groups.json</code>。
      </div>

      {message && (
        <div
          style={{
            marginBottom: 10,
            fontSize: 13,
            color: message.kind === 'ok' ? '#047857' : '#b91c1c',
            whiteSpace: 'pre-wrap',
          }}
        >
          {message.text}
        </div>
      )}

      {/* 分组清单 */}
      <div style={sectionStyle}>
        <div style={{ display: 'flex', alignItems: 'center', marginBottom: 8 }}>
          <span style={{ fontSize: 13, fontWeight: 600 }}>已有分组（{groups.length}）</span>
          <button
            type="button"
            style={{ ...primaryButtonStyle, marginLeft: 'auto', padding: '5px 12px' }}
            onClick={() => {
              setDraft(emptyDraft())
              setMessage(null)
            }}
          >
            新建分组
          </button>
        </div>
        {groups.length === 0 && (
          <div style={{ fontSize: 12, color: '#6b7280' }}>
            还没有分组。点「新建分组」把一组常用技能 + MCP 存成能力包。
          </div>
        )}
        {groups.map(g => (
          <div
            key={g.id}
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 10,
              borderTop: '1px solid #f3f4f6',
              padding: '8px 0',
              fontSize: 12,
            }}
          >
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>{g.name}</div>
              {g.description && <div style={{ color: '#6b7280' }}>{g.description}</div>}
              <div style={{ color: '#4b5563', marginTop: 2 }}>
                技能（{g.skills.length}）：{g.skills.join('、') || '—'}
              </div>
              <div style={{ color: '#4b5563' }}>
                MCP（{g.mcp.length}）：{g.mcp.join('、') || '—'}
              </div>
            </div>
            <div style={{ display: 'flex', gap: 6, whiteSpace: 'nowrap' }}>
              <button
                type="button"
                style={{ ...buttonStyle, padding: '4px 10px' }}
                onClick={() => {
                  setDraft({ ...g })
                  setMessage(null)
                }}
              >
                编辑
              </button>
              <button
                type="button"
                style={{ ...dangerButtonStyle, padding: '4px 10px' }}
                disabled={busy}
                onClick={() => void onDelete(g)}
              >
                删除
              </button>
            </div>
          </div>
        ))}
      </div>

      {/* 新建/编辑表单 */}
      {draft && (
        <div style={{ ...sectionStyle, borderColor: '#93c5fd' }}>
          <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 6 }}>
            {draft.id ? `编辑分组：${draft.name || '(未命名)'}` : '新建分组'}
          </div>
          <label style={labelStyle}>分组名（必填；同名保存 = 覆盖该分组）</label>
          <input
            style={inputStyle}
            value={draft.name}
            onChange={e => set('name', e.target.value)}
            placeholder="如：前端基础包 / TFS 回写包"
          />
          <label style={labelStyle}>说明（可选）</label>
          <input
            style={inputStyle}
            value={draft.description ?? ''}
            onChange={e => set('description', e.target.value)}
            placeholder="这组能力是干什么的"
          />
          <label style={labelStyle}>技能（当前可选 {skillOptions.length} 项）</label>
          <MultiSelect
            options={skillOptions.map(s => ({
              value: s.name,
              label: s.name,
              hint: `${s.source}${s.modelInvocable ? ' · 模型可调用' : ''}`,
            }))}
            value={draft.skills}
            onChange={next => set('skills', next)}
            placeholder="未选择技能"
            searchPlaceholder="按技能名刷选…"
          />
          <label style={labelStyle}>MCP（当前可选 {mcpServers.length} 项）</label>
          <MultiSelect
            options={mcpServers.map(m => ({ value: m, label: m }))}
            value={draft.mcp}
            onChange={next => set('mcp', next)}
            placeholder="未选择 MCP"
            searchPlaceholder="按 server 名刷选…"
          />
          <div style={{ display: 'flex', gap: 10, marginTop: 12 }}>
            <button style={primaryButtonStyle} disabled={busy} onClick={() => void onSave()}>
              {busy ? '保存中…' : '保存分组'}
            </button>
            <button style={buttonStyle} disabled={busy} onClick={() => setDraft(null)}>
              取消
            </button>
          </div>
          {skillOptions.length === 0 && (
            <div style={{ fontSize: 11, color: '#b45309', marginTop: 6 }}>
              宿主未返回技能清单（能力降级）：请到「执行配置」点「重新采集目录」后再来建分组。
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default SkillGroupPanel

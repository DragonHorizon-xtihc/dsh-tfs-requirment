// 可搜索多选下拉（问题 3 / 11）。
//
// ## 为什么要自建，而不是继续用 `<input list>` / 逗号分隔文本
//
// 用户反馈 11：「角色管理中模型、技能、mcp 必须和 dsh 一致 下拉选择且需要支持刷选功能」。
// 既有的两种写法都做不到：
//   - `<input list="...">` 是**单选**、且各浏览器对 datalist 的筛选行为不一致（有的要手打前缀）；
//   - 逗号分隔文本（角色管理原实现）**根本不是下拉**，用户必须记住准确名字，
//     而 dsh 的模型/skill/mcp 名字往往有几十个且带 provider 前缀，靠记忆必然打错。
//
// 因此这里给一个零依赖的多选下拉：输入框做**子串筛选**（不区分大小写），
// 列表可勾选，已选项以 chip 形式回显，支持"筛选结果内全选/清空"。
//
// ## 交互与 a11y 约束
// - 面板外点击 / Esc 关闭（点击外部用 `pointerdown` 捕获阶段监听，避免被面板自身的点击吞掉）；
// - 打开时自动聚焦搜索框；
// - `aria-expanded` / `role="listbox"` / `aria-selected` 让读屏可用；
// - **不做**虚拟滚动：dsh 的模型/技能/MCP 规模在百级，全量渲染即可，
//   引入虚拟列表会为了不存在的规模问题增加复杂度（YAGNI）。
//
// 组件为纯展示层：不 fetch、不跨层 import 宿主模块。

import { useEffect, useMemo, useRef, useState } from 'react'

/** 一个可选项。 */
export interface MultiSelectOption {
  /** 选中的真实值（提交给宿主的值）。 */
  value: string
  /** 展示名。 */
  label: string
  /** 次要说明（如 provider 名 / 技能来源 / 描述），筛选时一并参与匹配。 */
  hint?: string
}

/**
 * 按 `value` 去重（问题 7）。
 *
 * ## 为什么必须在**组件内部**再兜一道
 *
 * 调用方（`RoleSettings` 的默认模型下拉）用 `m.id` 当 value，而模型的 `id` **只在单个
 * provider 内唯一**：同一 `id` 被 K 个 provider 暴露时，`options` 里就有 K 个同 value 项。
 * 组件此前直接拿 `options.filter(o => set.has(o.value))` 生成已选项
 * （见下方 `selected`），于是：
 *   - 已选区渲染出 K 个**同 key 同文案**的 chip（React duplicate key，点 × 命中的可能是
 *     另一份 fiber ⇒ 用户看到"点了没反应 / 删不掉"）；
 *   - 下拉面板渲染出 K 个同名行，勾一次 K 行同时变蓝（用户看到"出现六次 / 三次"）。
 *
 * 修复只需一处：**在进组件时按 value 折叠**。折叠时把重复项的 `hint` 用 `、` 合并，
 * 保证"这个 id 属于哪几个 provider"这条信息不丢（`RoleSettings` 只传一个 providerName 时
 * 也能看到并集）。
 *
 * 本函数是**纯函数并导出**，因为客户端半没有 React 测试库（项目既有纪律）——
 * 只有纯函数能被 vitest 直接覆盖，DOM 行为再由 E2E 兜。
 *
 * @param options - 原始选项（可能含重复 value）。
 * @returns 去重后的选项（保持首次出现顺序与首个 label）。
 */
export function dedupeOptions(options: readonly MultiSelectOption[]): MultiSelectOption[] {
  const seen = new Map<string, MultiSelectOption>()
  const hints = new Map<string, string[]>()
  for (const o of options) {
    if (typeof o?.value !== 'string' || o.value.length === 0) continue
    if (!seen.has(o.value)) {
      seen.set(o.value, { value: o.value, label: o.label, ...(o.hint ? { hint: o.hint } : {}) })
      hints.set(o.value, o.hint ? [o.hint] : [])
      continue
    }
    const list = hints.get(o.value)
    if (o.hint && list && !list.includes(o.hint)) list.push(o.hint)
  }
  const out: MultiSelectOption[] = []
  for (const [value, base] of seen) {
    const list = hints.get(value) ?? []
    out.push(list.length > 0 ? { ...base, hint: list.join('、') } : base)
  }
  return out
}

const boxStyle: React.CSSProperties = {
  border: '1px solid #d1d5db',
  borderRadius: 6,
  background: '#fff',
  padding: '4px 6px',
  minHeight: 32,
  display: 'flex',
  flexWrap: 'wrap',
  gap: 4,
  alignItems: 'center',
  cursor: 'pointer',
  fontSize: 13,
}
const chipStyle: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  gap: 4,
  background: '#eef2ff',
  color: '#3730a3',
  borderRadius: 12,
  padding: '2px 8px',
  fontSize: 12,
}
const panelStyle: React.CSSProperties = {
  position: 'absolute',
  zIndex: 30,
  marginTop: 4,
  minWidth: 260,
  maxWidth: '100%',
  background: '#fff',
  border: '1px solid #d1d5db',
  borderRadius: 8,
  boxShadow: '0 10px 24px rgba(15,23,42,0.14)',
  padding: 8,
}
const rowStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  padding: '4px 6px',
  borderRadius: 4,
  fontSize: 13,
  cursor: 'pointer',
}

/**
 * 可搜索多选下拉。
 *
 * @param props.options - 全部可选项（由宿主真实枚举下发，本组件不做任何硬编码兜底）。
 * @param props.value - 当前选中的值列表。
 * @param props.onChange - 变更回调（传回新的值列表，顺序保持 options 顺序，便于稳定 diff）。
 * @param props.placeholder - 未选中时的占位文案。
 * @param props.searchPlaceholder - 搜索框占位文案。
 * @param props.disabled - 禁用（数据加载中 / 宿主未接线时用）。
 * @param props.id - 关联 `<label htmlFor>` 用。
 * @param props.max - 最多可选数量；`1` 时退化为**可搜索单选**（选新值直接替换旧值）。
 *   角色管理的"默认模型"就是单选场景，但模型有几十个且带 provider 前缀，
 *   普通 `<select>` 找不到目标，因此复用本组件而不是再造一个单选框。
 */
export function MultiSelect(props: {
  options: MultiSelectOption[]
  value: string[]
  onChange: (next: string[]) => void
  placeholder?: string
  searchPlaceholder?: string
  disabled?: boolean
  id?: string
  max?: number
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const rootRef = useRef<HTMLDivElement | null>(null)
  const searchRef = useRef<HTMLInputElement | null>(null)

  /**
   * 去重后的选项（问题 7）：组件内**所有**下游计算只看这一份。
   * 只要它唯一，chip key、下拉行 key、勾选状态就不可能再重复。
   */
  const options = useMemo(() => dedupeOptions(props.options), [props.options])

  // 面板外点击关闭。用 pointerdown（早于 click）可避免"点面板内部按钮先关面板"的竞态。
  useEffect(() => {
    if (!open) return
    const onDown = (e: PointerEvent): void => {
      const el = rootRef.current
      if (el && e.target instanceof Node && !el.contains(e.target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('pointerdown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('pointerdown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  useEffect(() => {
    if (open) searchRef.current?.focus()
  }, [open])

  /** 归一化：按 options 顺序去重，保证"同一集合不同选择顺序"产出同一结果（便于 diff/幂等）。 */
  const selected = useMemo(() => {
    const set = new Set(props.value)
    // options 已去重 ⇒ 这里天然不会产出重复值（问题 7 的 chip 重复即此而来）。
    return options.filter(o => set.has(o.value)).map(o => o.value)
  }, [options, props.value])

  /** 未在 options 里的已选值仍要保留（历史数据 / 宿主枚举降级时不该被静默丢弃）。 */
  const orphan = useMemo(() => {
    const known = new Set(options.map(o => o.value))
    return [...new Set(props.value)].filter(v => !known.has(v))
  }, [options, props.value])

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase()
    if (!kw) return options
    return options.filter(o =>
      [o.value, o.label, o.hint ?? ''].some(s => s.toLowerCase().includes(kw)),
    )
  }, [options, q])

  const labelOf = (v: string): string => {
    const hit = options.find(o => o.value === v)
    return hit ? hit.label : v
  }

  const toggle = (v: string): void => {
    if (props.max === 1) {
      // 单选：再点已选项 = 取消；点新项 = 替换。
      props.onChange(selected.includes(v) ? [] : [v])
      return
    }
    const next = selected.includes(v) ? selected.filter(x => x !== v) : [...selected, v]
    props.onChange([...next, ...orphan.filter(o => !next.includes(o))])
  }

  const remove = (v: string): void => {
    props.onChange([...selected.filter(x => x !== v), ...orphan.filter(o => o !== v)])
  }

  const allFilteredSelected = filtered.length > 0 && filtered.every(o => selected.includes(o.value))
  const toggleAllFiltered = (): void => {
    if (allFilteredSelected) {
      const drop = new Set(filtered.map(o => o.value))
      props.onChange([...selected.filter(v => !drop.has(v)), ...orphan])
    } else {
      props.onChange([...new Set([...selected, ...filtered.map(o => o.value)]), ...orphan.filter(o => !selected.includes(o))])
    }
  }

  return (
    <div ref={rootRef} style={{ position: 'relative' }}>
      <div
        id={props.id}
        role="button"
        tabIndex={props.disabled ? -1 : 0}
        aria-expanded={open}
        aria-haspopup="listbox"
        style={{ ...boxStyle, opacity: props.disabled ? 0.6 : 1, cursor: props.disabled ? 'not-allowed' : 'pointer' }}
        onClick={() => !props.disabled && setOpen(o => !o)}
        onKeyDown={e => {
          if (props.disabled) return
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault()
            setOpen(o => !o)
          }
        }}
      >
        {selected.length === 0 && orphan.length === 0 && (
          <span style={{ color: '#9ca3af' }}>{props.placeholder ?? '请选择…'}</span>
        )}
        {[...selected, ...orphan].map(v => (
          <span key={v} style={chipStyle}>
            {labelOf(v)}
            <button
              type="button"
              aria-label={`移除 ${labelOf(v)}`}
              onClick={e => {
                e.stopPropagation()
                remove(v)
              }}
              style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: '#3730a3', padding: 0 }}
            >
              ×
            </button>
          </span>
        ))}
        <span style={{ marginLeft: 'auto', color: '#9ca3af', fontSize: 11 }}>{open ? '▲' : '▼'}</span>
      </div>

      {open && !props.disabled && (
        <div style={panelStyle}>
          <input
            ref={searchRef}
            type="search"
            style={{
              width: '100%',
              boxSizing: 'border-box',
              padding: '5px 8px',
              border: '1px solid #d1d5db',
              borderRadius: 6,
              fontSize: 13,
              marginBottom: 6,
            }}
            placeholder={props.searchPlaceholder ?? '输入关键字筛选…'}
            value={q}
            onChange={e => setQ(e.target.value)}
          />
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 4 }}>
            <span style={{ fontSize: 12, color: '#6b7280' }}>
              {filtered.length} / {options.length} 项
            </span>
            {/* 单选模式（max=1）没有"全选"语义，隐藏该按钮而不是禁用后让人困惑。 */}
            {props.max !== 1 && (
              <button
                type="button"
                onClick={toggleAllFiltered}
                style={{
                  border: 'none',
                  background: 'transparent',
                  color: '#2563eb',
                  cursor: 'pointer',
                  fontSize: 12,
                  padding: 0,
                }}
              >
                {allFilteredSelected ? '清空当前筛选结果' : '全选当前筛选结果'}
              </button>
            )}
          </div>
          <div role="listbox" aria-multiselectable style={{ maxHeight: 240, overflowY: 'auto' }}>
            {filtered.length === 0 && (
              <div style={{ fontSize: 12, color: '#9ca3af', padding: '6px 6px' }}>
                {options.length === 0 ? '暂无可选项（宿主未返回数据）' : '无匹配项'}
              </div>
            )}
            {filtered.map(o => (
              <label
                key={o.value}
                role="option"
                aria-selected={selected.includes(o.value)}
                style={{ ...rowStyle, background: selected.includes(o.value) ? '#eff6ff' : 'transparent' }}
              >
                <input type="checkbox" checked={selected.includes(o.value)} onChange={() => toggle(o.value)} />
                <span style={{ flex: 1, minWidth: 0 }}>
                  {o.label}
                  {o.hint && <span style={{ color: '#9ca3af', fontSize: 11, marginLeft: 6 }}>{o.hint}</span>}
                </span>
              </label>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

export default MultiSelect

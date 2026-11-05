/**
 * 通用分页栏（问题 4 / 问题 6）。
 *
 * 纯展示组件：页码、每页条数都由父组件持有（后者还要落盘到 ui-state.json），
 * 本组件只负责渲染「共 N 条 ｜ 每页 [条数] ｜ ‹ 1 2 3 ›」并把操作上抛。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/client/components/PaginationBar
 */

/** 需求池每页条数档位（默认 20）。 */
export const POOL_PAGE_SIZE_OPTIONS = [10, 20, 50, 100]
/** 任务中心「已领取需求」每页条数档位（默认 10）。 */
export const CLAIMED_PAGE_SIZE_OPTIONS = [5, 10, 20, 50]
/** 任务中心「任务列表」每页条数档位（默认 20）。 */
export const TASK_PAGE_SIZE_OPTIONS = [10, 20, 50, 100]

const buttonStyle: React.CSSProperties = {
  minWidth: 28,
  height: 26,
  padding: '0 6px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#fff',
  color: '#374151',
  cursor: 'pointer',
  fontSize: 12,
}

/**
 * 计算页码窗口（始终含首页/末页，当前页两侧各 1 页，省略号折叠）。
 */
function pageWindow(page: number, pageCount: number): Array<number | '…'> {
  if (pageCount <= 7) {
    return Array.from({ length: pageCount }, (_, i) => i + 1)
  }
  const pages = new Set<number>([1, pageCount, page - 1, page, page + 1])
  const sorted = [...pages].filter(p => p >= 1 && p <= pageCount).sort((a, b) => a - b)
  const out: Array<number | '…'> = []
  for (let i = 0; i < sorted.length; i += 1) {
    const p = (sorted as number[])[i] as number
    if (i === 0) {
      out.push(p)
      continue
    }
    const prev = (sorted as number[])[i - 1] as number
    if (p - prev === 2) out.push(prev + 1)
    else if (p - prev > 2) out.push('…')
    out.push(p)
  }
  return out
}

export function PaginationBar(props: {
  /** 总条数。 */
  total: number
  /** 当前页（1 起）。 */
  page: number
  /** 总页数。 */
  pageCount: number
  /** 当前每页条数。 */
  pageSize: number
  /** 可选每页条数档位。 */
  pageSizeOptions: number[]
  /** 跳页。 */
  onPageChange: (page: number) => void
  /** 改每页条数（父组件负责落盘并回到第 1 页）。 */
  onPageSizeChange: (size: number) => void
  /** 列表名（无障碍标签/前缀文案）。 */
  label?: string
}): JSX.Element {
  const { total, page, pageCount, pageSize, pageSizeOptions } = props
  // 0 条时不占版面（调用方通常也会显示自己的"空态"）。
  if (total === 0) return <></>
  const window = pageWindow(page, pageCount)
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        flexWrap: 'wrap',
        marginTop: 8,
        fontSize: 12,
        color: '#6b7280',
      }}
      role="navigation"
      aria-label={props.label ? `${props.label}分页` : '分页'}
    >
      <span>
        {props.label ? `${props.label}：` : ''}共 {total} 条
      </span>
      <label style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        每页
        <select
          style={{ ...buttonStyle, padding: '0 4px' }}
          value={pageSize}
          onChange={e => props.onPageSizeChange(Number(e.target.value))}
          aria-label="每页条数"
        >
          {pageSizeOptions.map(n => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        条
      </label>
      <span style={{ marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <button
          type="button"
          style={buttonStyle}
          disabled={page <= 1}
          onClick={() => props.onPageChange(page - 1)}
          aria-label="上一页"
        >
          ‹
        </button>
        {window.map((p, i) =>
          p === '…' ? (
            <span key={`ellipsis-${i}`} style={{ padding: '0 2px' }}>
              …
            </span>
          ) : (
            <button
              key={p}
              type="button"
              style={{
                ...buttonStyle,
                ...(p === page
                  ? { background: '#2563eb', borderColor: '#2563eb', color: '#fff', cursor: 'default' }
                  : {}),
              }}
              aria-current={p === page ? 'page' : undefined}
              onClick={() => props.onPageChange(p)}
            >
              {p}
            </button>
          ),
        )}
        <button
          type="button"
          style={buttonStyle}
          disabled={page >= pageCount}
          onClick={() => props.onPageChange(page + 1)}
          aria-label="下一页"
        >
          ›
        </button>
      </span>
    </div>
  )
}

export default PaginationBar

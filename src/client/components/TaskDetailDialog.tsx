// 任务执行详情弹层（spec 006 US2/US3）。
//
// 为什么自建而不复用 dsh 本地对话：客户端注入面只有 selectPanel，无法导航到某个子会话；
// ONE-SHOT 子会话不作为独立对话打开、也无 inbox；宿主续聊要求持久 continuable 父会话，
// 而本插件 parent 是 ctx 强转、不保证持久交互会话（详见 specs/006.../research.md）。
// 因此这里在 overlay 内自建详情：attempt 切换 + 冻结配置 + 失败诊断 + 执行流
// （思考 / 回复 / 技能 / MCP / 工具调用，经宿主 sessionQuery 冷读子会话事件映射）+ 二次对话追问。
//
// 视觉对齐 dsh 主 agent：头像 + 气泡 + 思考折叠 + 紧凑工具行（运行流光 / 状态点）+ 轻量 Markdown。
// 纯展示层：轨迹与追问都经 props 回调走 HostBridge → 宿主 HTTP 路由，不直接 fetch。

import { useCallback, useEffect, useRef, useState } from 'react'
import { formatModelRoute } from '../../shared/model-route.js'
import type {
  BoardTaskView,
  FollowUpTaskResult,
  TaskAttemptView,
  TaskTraceEntry,
  TaskTraceResult,
  TaskTraceStats,
  TraceToolKind,
} from '../../shared/contracts.js'

/* ───────────────────────── 注入样式（scoped，td- 前缀，避免污染宿主） ───────────────────────── */

const SCOPED_CSS = `
@keyframes td-spin { to { transform: rotate(360deg); } }
@keyframes td-pulse { 0%,100% { opacity:1; transform:scale(1);} 50% { opacity:.35; transform:scale(.8);} }
@keyframes td-fade { from { opacity:0; transform: translateY(5px);} to { opacity:1; transform:none;} }
@keyframes td-sweep { 0% { background-position: -160px 0;} 100% { background-position: 320px 0;} }
@keyframes td-barber { from { background-position: 0 0;} to { background-position: 28px 0;} }
.td-fade { animation: td-fade .28s ease both; }
.td-spin { display:inline-block; border:2px solid rgba(37,99,235,.22); border-top-color:#2563eb; border-radius:50%; animation: td-spin .7s linear infinite; flex:none; }
.td-dot { width:16px; height:16px; border-radius:50%; display:inline-flex; align-items:center; justify-content:center; font-size:10px; color:#fff; flex:none; }
.td-dot-ok { background:#10b981; } .td-dot-err { background:#ef4444; }
.td-stream { background: linear-gradient(180deg,#f8fafc 0%,#f4f6fb 100%); border:1px solid #e6e9f0; border-radius:12px; }
.td-stream-inner { scrollbar-width: thin; scrollbar-color:#c7cedb transparent; }
.td-stream-inner::-webkit-scrollbar { width:8px; height:8px; }
.td-stream-inner::-webkit-scrollbar-thumb { background:#c7cedb; border-radius:8px; }
.td-stream-inner::-webkit-scrollbar-thumb:hover { background:#aab4c6; }
.td-turn { display:flex; align-items:center; gap:8px; justify-content:center; margin:14px 0; }
.td-turn span { font-size:11px; color:#64748b; background:#eef1f6; border:1px solid #e2e7f0; border-radius:999px; padding:2px 11px; }
.td-bubble { border-radius:12px; font-size:12.5px; line-height:1.6; }
.td-bubble p { margin:0 0 6px; } .td-bubble p:last-child { margin-bottom:0; }
.td-bubble h1,.td-bubble h2,.td-bubble h3,.td-bubble h4 { margin:10px 0 5px; line-height:1.35; color:#0f172a; }
.td-bubble h1 { font-size:15px; } .td-bubble h2 { font-size:14px; } .td-bubble h3,.td-bubble h4 { font-size:13px; }
.td-bubble ul,.td-bubble ol { margin:4px 0 6px; padding-left:0; list-style:none; }
.td-bubble li { display:flex; gap:7px; margin:2px 0; }
.td-bubble li .td-li-mark { color:#6366f1; flex:none; }
.td-bubble blockquote { margin:5px 0; border-left:3px solid #c7d2fe; background:#f5f7ff; padding:4px 9px; color:#475569; border-radius:0 7px 7px 0; }
.td-bubble code { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; background:#eef2ff; color:#4338ca; border-radius:4px; padding:1px 5px; }
.td-bubble pre { background:#0f172a; color:#e2e8f0; border-radius:9px; padding:10px 12px; overflow:auto; font-size:11.5px; margin:6px 0; font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; }
.td-bubble pre code { background:transparent; color:inherit; padding:0; }
.td-think { border:1px solid #e7e0ff; background:#f6f3ff; border-radius:9px; margin-bottom:7px; overflow:hidden; }
.td-think > button { width:100%; display:flex; align-items:center; gap:7px; background:transparent; border:0; cursor:pointer; padding:6px 10px; font-size:11.5px; color:#6d28d9; font-weight:600; }
.td-think-body { padding:0 11px 8px 30px; font-size:12px; color:#574f72; font-style:italic; white-space:pre-wrap; line-height:1.6; }
.td-tool { border:1px solid #e7eaf1; border-radius:10px; background:#fff; margin:5px 0; overflow:hidden; transition:box-shadow .15s; }
.td-tool:hover { box-shadow:0 2px 10px rgba(15,23,42,.06); }
.td-tool-head { width:100%; display:flex; align-items:center; gap:8px; background:transparent; border:0; cursor:pointer; padding:7px 10px; text-align:left; }
.td-tool-name { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11.5px; color:#0f172a; font-weight:600; }
.td-tool-meta { margin-left:auto; font-size:10.5px; color:#94a3b8; display:inline-flex; align-items:center; gap:6px; flex:none; }
.td-tool-chev { color:#b3bccb; transition:transform .15s; flex:none; }
.td-tool-body { border-top:1px dashed #e5e9f1; padding:7px 10px 9px; }
.td-io { font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace; font-size:11px; white-space:pre-wrap; word-break:break-word; background:#f8fafc; border:1px solid #e8ecf3; border-radius:7px; padding:7px 9px; margin:4px 0; }
.td-io-label { font-size:10.5px; font-weight:700; color:#64748b; letter-spacing:.3px; }
.td-tool-running { background: linear-gradient(90deg, rgba(37,99,235,.10) 25%, rgba(37,99,235,.02) 37%, rgba(37,99,235,.10) 63%); background-size:300px 100%; animation: td-sweep 1.1s linear infinite; }
.td-badge { font-size:10px; font-weight:700; border-radius:5px; padding:1px 6px; flex:none; }
.td-live-dot { width:8px; height:8px; border-radius:50%; background:#22c55e; display:inline-block; animation: td-pulse 1.3s ease-in-out infinite; }
.td-chip-btn { border-radius:8px; border:1px solid #e2e7f0; background:#fff; cursor:pointer; font-size:11.5px; padding:3px 9px; display:inline-flex; align-items:center; gap:5px; transition:all .12s; }
.td-chip-btn:hover { border-color:#c3ccd6; }
.td-chip-btn[data-active="true"] { border-color:#2563eb; background:#eff4ff; color:#1d4ed8; }
`

/* ───────────────────────── 通用样式对象 ───────────────────────── */

const overlayStyle: React.CSSProperties = {
  position: 'fixed',
  inset: 0,
  background: 'rgba(15,23,42,0.42)',
  backdropFilter: 'blur(2px)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  zIndex: 70,
  padding: 20,
}
const dialogStyle: React.CSSProperties = {
  background: '#fff',
  borderRadius: 16,
  padding: 20,
  width: '100%',
  maxWidth: 960,
  maxHeight: '92vh',
  overflow: 'auto',
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 24px 70px rgba(15,23,42,0.30)',
}
const buttonStyle: React.CSSProperties = {
  padding: '5px 11px',
  borderRadius: 8,
  border: '1px solid #d8dee9',
  background: '#fff',
  cursor: 'pointer',
  fontSize: 12,
}
const monoStyle: React.CSSProperties = {
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
  fontSize: 11,
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  background: '#f8fafc',
  border: '1px solid #e8ecf3',
  borderRadius: 7,
  padding: 7,
  margin: '4px 0 0',
}

/** 工具类别徽章配色。 */
const TOOL_BADGE: Record<TraceToolKind, { text: string; color: string; bg: string }> = {
  mcp: { text: 'MCP', color: '#1d4ed8', bg: '#dbeafe' },
  skill: { text: '技能', color: '#6d28d9', bg: '#ede9fe' },
  tool: { text: '工具', color: '#374151', bg: '#f1f3f7' },
}

const ATTEMPT_DOT: Record<string, string> = {
  running: '#1d4ed8',
  success: '#047857',
  failed: '#b91c1c',
  cancelled: '#6b7280',
}

function fmtTime(ms: number | undefined): string {
  if (!ms) return ''
  try {
    return new Date(ms).toLocaleTimeString('zh-CN', { hour12: false })
  } catch {
    return ''
  }
}

/** 大数字紧凑化（token 计数）。 */
function fmtNum(n: number | undefined): string {
  if (!n || n <= 0) return '0'
  if (n < 1000) return String(n)
  return `${Math.round(n / 100) / 10}k`
}

/** 耗时（毫秒）人性化。 */
function fmtDuration(ms: number | undefined): string {
  if (!ms || ms <= 0) return '—'
  if (ms < 1000) return `${ms}ms`
  return `${Math.round(ms / 100) / 10}s`
}

/** 问题 5：取出看板任务 lastNote 中"待人工确认："后的具体原因。 */
function stripConfirmPrefix(note?: string): string {
  if (!note) return ''
  const m = note.match(/^待人工确认[：:]\s*([\s\S]*)$/)
  return m && m[1] ? m[1].trim() : note
}

/* ───────────────────────── 头像 ───────────────────────── */

function AssistantAvatar({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'linear-gradient(135deg,#6366f1,#8b5cf6)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        boxShadow: '0 2px 6px rgba(99,102,241,.35)',
      }}
    >
      <svg width={size * 0.58} height={size * 0.58} viewBox="0 0 24 24" fill="none">
        <path d="M12 2.5l1.9 5.6 5.6 1.9-5.6 1.9L12 17.5l-1.9-5.6L4.5 10l5.6-1.9L12 2.5z" fill="#fff" />
        <circle cx="18.5" cy="17" r="1.6" fill="#fff" opacity=".85" />
      </svg>
    </span>
  )
}

function UserAvatar({ size = 28 }: { size?: number }): JSX.Element {
  return (
    <span
      style={{
        width: size,
        height: size,
        borderRadius: '50%',
        background: 'linear-gradient(135deg,#2563eb,#1d4ed8)',
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        flex: 'none',
        boxShadow: '0 2px 6px rgba(37,99,235,.35)',
      }}
    >
      <svg width={size * 0.55} height={size * 0.55} viewBox="0 0 24 24" fill="#fff">
        <circle cx="12" cy="8" r="4" />
        <path d="M4 20c0-3.6 3.6-5.5 8-5.5s8 1.9 8 5.5" stroke="#fff" strokeWidth="2" fill="none" strokeLinecap="round" />
      </svg>
    </span>
  )
}

/* ───────────────────────── 轻量 Markdown（安全：全部转 React，无 HTML 注入） ───────────────────────── */

/** 行内：`code` 与 **bold**。 */
function renderInline(text: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  const re = /(\*\*[^*]+\*\*|`[^`]+`)/g
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index))
    const tok = m[0]
    if (tok.startsWith('**')) {
      nodes.push(<strong key={`b${k++}`}>{tok.slice(2, -2)}</strong>)
    } else {
      nodes.push(<code key={`c${k++}`}>{tok.slice(1, -1)}</code>)
    }
    last = re.lastIndex
  }
  if (last < text.length) nodes.push(text.slice(last))
  return nodes
}

function MarkdownText({ text }: { text: string }): JSX.Element {
  // 按围栏代码块切分：奇数段为代码。
  const segments = text.split('```')
  return (
    <div className="td-bubble">
      {segments.map((seg, si) => {
        if (si % 2 === 1) {
          const nl = seg.indexOf('\n')
          const code = nl >= 0 ? seg.slice(nl + 1) : seg
          return (
            <pre key={si}>
              <code>{code.replace(/\n$/, '')}</code>
            </pre>
          )
        }
        const lines = seg.split('\n')
        return (
          <div key={si}>
            {lines.map((raw, li) => {
              const t = raw.trim()
              if (!t) return <div key={li} style={{ height: 5 }} />
              const hm = /^(#{1,6})\s+(.*)$/.exec(t)
              if (hm) {
                const lvl = hm[1]!.length
                const Tag = (`h${Math.min(lvl, 4)}`) as keyof JSX.IntrinsicElements
                return <Tag key={li}>{renderInline(hm[2]!)}</Tag>
              }
              const ul = /^([-*+]|•)\s+(.*)$/.exec(t)
              if (ul) {
                return (
                  <ul key={li}>
                    <li>
                      <span className="td-li-mark">•</span>
                      <span>{renderInline(ul[2]!)}</span>
                    </li>
                  </ul>
                )
              }
              const ol = /^(\d+)[.)]\s+(.*)$/.exec(t)
              if (ol) {
                return (
                  <ol key={li}>
                    <li>
                      <span className="td-li-mark">{ol[1]}.</span>
                      <span>{renderInline(ol[2]!)}</span>
                    </li>
                  </ol>
                )
              }
              if (/^>\s?(.*)$/.test(t)) {
                const q = /^>\s?(.*)$/.exec(t)!
                return <blockquote key={li}>{renderInline(q[1]!)}</blockquote>
              }
              return <p key={li}>{renderInline(t)}</p>
            })}
          </div>
        )
      })}
    </div>
  )
}

/* ───────────────────────── 思考折叠块 ───────────────────────── */

function ThinkingBlock({ text }: { text: string }): JSX.Element {
  const [open, setOpen] = useState(false)
  const len = text.length
  return (
    <div className="td-think">
      <button type="button" onClick={() => setOpen(v => !v)}>
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" style={{ flex: 'none' }}>
          <path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2v.1h5v-.1c0-.8.4-1.5 1-2A6 6 0 0 0 12 3z" stroke="#6d28d9" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
        {open ? '收起思考过程' : `思考过程（${len} 字）`}
        <span style={{ marginLeft: 'auto', transform: open ? 'rotate(180deg)' : 'none', transition: 'transform .15s' }}>⌄</span>
      </button>
      {open && <div className="td-think-body">{text}</div>}
    </div>
  )
}

/* ───────────────────────── 紧凑工具行 ───────────────────────── */

function StatusLeading({ status }: { status: 'running' | 'ok' | 'error' }): JSX.Element {
  if (status === 'running') return <span className="td-spin" style={{ width: 14, height: 14 }} />
  return <span className={`td-dot ${status === 'ok' ? 'td-dot-ok' : 'td-dot-err'}`}>{status === 'ok' ? '✓' : '✕'}</span>
}

function ToolItem({ e }: { e: Extract<TaskTraceEntry, { kind: 'tool' }> }): JSX.Element {
  const [open, setOpen] = useState(false)
  const badge = TOOL_BADGE[e.toolKind] ?? TOOL_BADGE.tool
  const running = e.status === 'running'
  const expandable = Boolean(e.args || e.result || e.error)
  return (
    <div className={`td-fade td-tool ${running ? 'td-tool-running' : ''}`}>
      <button
        type="button"
        className="td-tool-head"
        onClick={() => expandable && setOpen(v => !v)}
        style={{ cursor: expandable ? 'pointer' : 'default' }}
      >
        <StatusLeading status={e.status} />
        <span className="td-badge" style={{ color: badge.color, background: badge.bg }}>{badge.text}</span>
        <span className="td-tool-name">{e.name}</span>
        {e.status === 'error' && e.error && (
          <span style={{ fontSize: 11, color: '#dc2626', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
            {e.error.slice(0, 60)}
          </span>
        )}
        <span className="td-tool-meta">
          {running ? (
            <span style={{ color: '#2563eb' }}>执行中</span>
          ) : (
            <>
              {fmtTime(e.time)}
              {e.durationMs !== undefined ? ` · ${Math.round(e.durationMs / 100) / 10}s` : ''}
            </>
          )}
          {expandable && <span className="td-tool-chev" style={{ transform: open ? 'rotate(180deg)' : 'none' }}>⌄</span>}
        </span>
      </button>
      {open && expandable && (
        <div className="td-tool-body">
          {e.args && (
            <div>
              <div className="td-io-label">入参</div>
              <pre className="td-io">{e.args}</pre>
            </div>
          )}
          {e.result && (
            <div>
              <div className="td-io-label">返回结果</div>
              <pre className="td-io">{e.result}</pre>
            </div>
          )}
          {e.error && (
            <div>
              <div className="td-io-label" style={{ color: '#dc2626' }}>错误</div>
              <pre className="td-io" style={{ color: '#b91c1c', borderColor: '#fecaca', background: '#fef2f2' }}>{e.error}</pre>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

/* ───────────────────────── 单条时间线节点 ───────────────────────── */

function TraceRow({ e }: { e: TaskTraceEntry }): JSX.Element {
  if (e.kind === 'turn') {
    const label = e.phase === 'start' ? `第 ${e.turn} 轮` : `第 ${e.turn} 轮结束${e.reason ? ` · ${e.reason}` : ''}`
    return (
      <div className="td-turn td-fade">
        <span>{e.phase === 'start' ? `● ${label}` : `■ ${label}`}</span>
      </div>
    )
  }
  if (e.kind === 'user') {
    return (
      <div className="td-fade" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, justifyContent: 'flex-end', margin: '8px 0' }}>
        <div style={{ maxWidth: '82%' }}>
          <div className="td-bubble" style={{ background: 'linear-gradient(135deg,#2563eb,#1d4ed8)', color: '#fff', padding: '8px 12px', boxShadow: '0 3px 10px rgba(37,99,235,.25)' }}>
            <div style={{ fontSize: 10, opacity: 0.75, marginBottom: 3 }}>指令 · {fmtTime(e.time)}</div>
            <div style={{ whiteSpace: 'pre-wrap' }}>{e.text || '（空消息）'}</div>
          </div>
        </div>
        <UserAvatar />
      </div>
    )
  }
  if (e.kind === 'assistant') {
    const hasBody = e.text.trim().length > 0
    return (
      <div className="td-fade" style={{ display: 'flex', alignItems: 'flex-start', gap: 8, margin: '8px 0' }}>
        <AssistantAvatar />
        <div style={{ minWidth: 0, flex: 1 }}>
          {e.thinking && <ThinkingBlock text={e.thinking} />}
          {hasBody ? (
            <div className="td-bubble" style={{ background: '#fff', border: '1px solid #e8ecf3', padding: '9px 12px', boxShadow: '0 1px 4px rgba(15,23,42,.05)' }}>
              <MarkdownText text={e.text} />
              {e.interrupted && (
                <div style={{ fontSize: 10, color: '#b45309', marginTop: 4 }}>（该输出被中断，为部分前缀）</div>
              )}
            </div>
          ) : (
            !e.thinking && (
              <div className="td-bubble" style={{ color: '#94a3b8', padding: '4px 2px' }}>（无文本，仅发起工具调用）</div>
            )
          )}
        </div>
      </div>
    )
  }
  // 工具：与助手头像列对齐（左缩进 36px，让工具读起来是"助手发起的动作"）。
  return (
    <div style={{ paddingLeft: 36 }}>
      <ToolItem e={e} />
    </div>
  )
}

/* ───────────────────────── 统计卡片（问题 2） ───────────────────────── */

const statCardStyle: React.CSSProperties = {
  border: '1px solid #e8ecf3',
  borderRadius: 10,
  padding: 11,
  marginBottom: 10,
  background: '#fff',
  fontSize: 12,
  boxShadow: '0 1px 4px rgba(15,23,42,.04)',
}
const statItemStyle: React.CSSProperties = { display: 'inline-block', marginRight: 16, marginBottom: 4 }
const statNumStyle: React.CSSProperties = { fontSize: 16, fontWeight: 700, color: '#0f172a' }
const statLabelStyle: React.CSSProperties = { color: '#64748b', fontSize: 11, marginLeft: 3 }

function TraceStatsCard({ stats }: { stats: TaskTraceStats }): JSX.Element {
  const tk = stats.tokens
  const cacheHit = tk.total > 0 ? Math.round(((tk.cacheRead + tk.cacheWrite) / tk.total) * 100) : 0
  return (
    <div style={statCardStyle}>
      <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 7, display: 'flex', alignItems: 'center', gap: 7 }}>
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
          <path d="M4 19V5m0 14h16M8 16v-5m4 5V8m4 8v-3" stroke="#2563eb" strokeWidth="2" strokeLinecap="round" />
        </svg>
        执行统计（本轮）
      </div>
      <div>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{stats.modelRequests}</span>
          <span style={statLabelStyle}>模型请求</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{stats.turns}</span>
          <span style={statLabelStyle}>轮次</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{stats.userInputs}</span>
          <span style={statLabelStyle}>用户输入</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{fmtDuration(stats.durationMs)}</span>
          <span style={statLabelStyle}>耗时</span>
        </span>
      </div>
      <div style={{ borderTop: '1px dashed #e8ecf3', paddingTop: 7, marginTop: 3 }}>
        <span style={statItemStyle} title="输入 + 缓存读 + 缓存写 + 输出（推理 token 不重复计入）">
          <span style={statNumStyle}>{fmtNum(tk.total)}</span>
          <span style={statLabelStyle}>token 合计</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{fmtNum(tk.input)}</span>
          <span style={statLabelStyle}>输入</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{fmtNum(tk.output)}</span>
          <span style={statLabelStyle}>输出</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{fmtNum(tk.cacheRead)}</span>
          <span style={statLabelStyle}>缓存读</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{fmtNum(tk.cacheWrite)}</span>
          <span style={statLabelStyle}>缓存写</span>
        </span>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{fmtNum(tk.reasoning)}</span>
          <span style={statLabelStyle}>推理</span>
        </span>
        <span style={statItemStyle}>
          <span style={{ ...statNumStyle, color: cacheHit >= 50 ? '#047857' : '#64748b' }}>{cacheHit}%</span>
          <span style={statLabelStyle}>缓存占比</span>
        </span>
      </div>
      <div style={{ borderTop: '1px dashed #e8ecf3', paddingTop: 7, marginTop: 3 }}>
        <span style={statItemStyle}>
          <span style={statNumStyle}>{stats.toolCalls}</span>
          <span style={statLabelStyle}>工具调用</span>
        </span>
        <span style={{ ...statItemStyle, color: '#047857' }}>
          <span style={statNumStyle}>{stats.toolOk}</span>
          <span style={statLabelStyle}>成功</span>
        </span>
        <span style={{ ...statItemStyle, color: stats.toolError > 0 ? '#b91c1c' : '#64748b' }}>
          <span style={statNumStyle}>{stats.toolError}</span>
          <span style={statLabelStyle}>失败</span>
        </span>
        {stats.toolRunning > 0 && (
          <span style={{ ...statItemStyle, color: '#1d4ed8' }}>
            <span style={statNumStyle}>{stats.toolRunning}</span>
            <span style={statLabelStyle}>进行中</span>
          </span>
        )}
        {stats.toolBreakdown.slice(0, 6).map(b => (
          <span key={b.name} style={statItemStyle} title={`${b.kind} · 成功 ${b.ok} / 失败 ${b.error}`}>
            <span style={{ fontSize: 12, fontWeight: 600 }}>{b.name}</span>
            <span style={statLabelStyle}>{b.count}</span>
          </span>
        ))}
      </div>
      {stats.repeatedCalls.length > 0 && (
        <div style={{ borderTop: '1px dashed #e8ecf3', paddingTop: 7, marginTop: 3, color: '#b45309' }}>
          <strong>重复调用（疑似无意义请求）：</strong>
          {stats.repeatedCalls.slice(0, 5).map(r => (
            <span key={r.name} style={{ marginRight: 12 }}>
              {r.name} ×{r.count}
            </span>
          ))}
          {stats.repeatedCalls.length > 5 ? ` 等 ${stats.repeatedCalls.length} 项` : null}
        </div>
      )}
    </div>
  )
}

/* ───────────────────────── 主弹层 ───────────────────────── */

export function TaskDetailDialog(props: {
  task: BoardTaskView
  onClose: () => void
  onGetTrace: (taskId: string, attemptIndex?: number) => Promise<TaskTraceResult>
  onFollowUp: (input: { taskId: string; message: string }) => Promise<FollowUpTaskResult>
  /** 追问成功后回调（父组件刷新看板快照）。 */
  onFollowedUp?: () => Promise<void> | void
  /**
   * 问题 5：任务停在「待人工确认」时点「确认通过」——宿主把该任务置成功，
   * 随后由收口钩子自动启动下游任务。不传则不显示放行按钮（老宿主兼容）。
   */
  onConfirm?: () => Promise<{ ok: boolean; reason?: string }>
}): JSX.Element {
  const attempts = props.task.attempts ?? []
  const lastIndex = Math.max(0, attempts.length - 1)
  const [selected, setSelected] = useState(lastIndex)
  const [trace, setTrace] = useState<TaskTraceResult | null>(null)
  const [loadingTrace, setLoadingTrace] = useState(false)
  const [message, setMessage] = useState('')
  const [sending, setSending] = useState(false)
  const [followError, setFollowError] = useState('')
  // 问题 5：人工确认放行的忙碌 / 结果状态。
  const [confirming, setConfirming] = useState(false)
  const [confirmMsg, setConfirmMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const needsConfirmation = props.task.state === 'in_progress' && props.task.execState === 'needs_confirmation'

  // 新 attempt 出现（追问起新一轮）时自动跳到最新一轮。
  useEffect(() => {
    setSelected(prev => (prev > lastIndex ? lastIndex : prev === lastIndex && attempts.length ? prev : lastIndex))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [attempts.length])

  const selectedAttempt: TaskAttemptView | undefined = attempts[selected]
  const isLive = props.task.execState === 'running' && selected === lastIndex

  const loadTrace = useCallback(async (): Promise<void> => {
    setLoadingTrace(true)
    try {
      const r = await props.onGetTrace(props.task.taskId, attempts.length ? selected : undefined)
      setTrace(r)
    } catch (e) {
      // ⚠️ 必须有 catch（2026-10-05 修复）：此函数被 `void loadTrace()` 调用且**每 2s 轮询一次**，
      // 旧实现只有 `finally`，于是 `onGetTrace` 一旦 reject：
      //   ① 用户只看到"轨迹一直在转 / 空白"，没有任何错误文案；
      //   ② 每 2 秒产生一条 unhandled rejection（运行期持续刷屏）。
      // 同文件的 `submitFollowUp` / `submitConfirm` 都有错误处理，唯独此处没有。
      setTrace({
        ok: false,
        taskId: props.task.taskId,
        attempt: attempts.length ? selected : -1,
        available: false,
        entries: [],
        reason: `轨迹不可用：${e instanceof Error ? e.message : String(e)}`,
      })
    } finally {
      setLoadingTrace(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.task.taskId, selected, attempts.length])

  // 拉取轨迹；运行中（或轨迹源为 live）每 2s 轮询，终态停止；卸载清定时器。
  useEffect(() => {
    void loadTrace()
    if (!isLive && trace?.source !== 'live') return
    timerRef.current = setInterval(() => void loadTrace(), 2000)
    return () => {
      if (timerRef.current) clearInterval(timerRef.current)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadTrace, isLive, trace?.source])

  const submitFollowUp = async (): Promise<void> => {
    const text = message.trim()
    if (!text || sending) return
    setSending(true)
    setFollowError('')
    try {
      const r = await props.onFollowUp({ taskId: props.task.taskId, message: text })
      if (!r.ok) {
        setFollowError(r.reason ?? '追问失败')
        return
      }
      setMessage('')
      setSelected(r.attempt ?? lastIndex + 1)
      await props.onFollowedUp?.()
      void loadTrace()
    } finally {
      setSending(false)
    }
  }

  const fc = props.task.frozenConfig
  const deleted = props.task.state === 'deleted'

  // 问题 5：人工核对产出后显式放行；成功后父组件刷新看板（宿主收口钩子会自动拉起下游任务）。
  const submitConfirm = async (): Promise<void> => {
    if (!props.onConfirm || confirming) return
    setConfirming(true)
    setConfirmMsg(null)
    try {
      const r = await props.onConfirm()
      setConfirmMsg(r.ok ? { ok: true, text: '已确认通过，任务置为成功，下游任务将自动执行。' } : { ok: false, text: r.reason ?? '确认失败' })
      if (r.ok) await props.onFollowedUp?.()
    } catch (e) {
      setConfirmMsg({ ok: false, text: e instanceof Error ? e.message : String(e) })
    } finally {
      setConfirming(false)
    }
  }

  return (
    <div style={overlayStyle} onClick={props.onClose}>
      <style>{SCOPED_CSS}</style>
      <div style={dialogStyle} onClick={e => e.stopPropagation()}>
        {/* 头部 */}
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1 }}>
            <h3 style={{ margin: '0 0 5px', fontSize: 17, display: 'flex', alignItems: 'center', gap: 9 }}>
              {props.task.title}
              {isLive && (
                <span style={{ display: 'inline-flex', alignItems: 'center', gap: 5, fontSize: 11, color: '#16a34a', fontWeight: 600 }}>
                  <span className="td-live-dot" /> 执行中
                </span>
              )}
            </h3>
            <div style={{ fontSize: 11, color: '#64748b', fontFamily: 'ui-monospace, monospace' }}>{props.task.taskId}</div>
          </div>
          <button type="button" style={buttonStyle} onClick={props.onClose}>
            关闭
          </button>
        </div>

        {/* 问题 5：待人工确认横幅——子代理结论需要人工核对，不会自动完成或推进下游。 */}
        {needsConfirmation && (
          <div
            style={{
              border: '1px solid #fed7aa',
              background: 'linear-gradient(135deg,#fff7ed,#ffedd5)',
              color: '#9a3412',
              borderRadius: 12,
              padding: 12,
              margin: '12px 0',
              fontSize: 12,
            }}
          >
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 5, display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                <path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0z" stroke="#c2410c" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
              待人工确认
            </div>
            <div style={{ whiteSpace: 'pre-wrap', marginBottom: 7 }}>
              {stripConfirmPrefix(props.task.lastNote) ||
                selectedAttempt?.output ||
                '子代理已产出结论并提示需要人工确认。请核对下方执行过程，确认无误后放行；如有问题可在底部追问后重新执行。'}
            </div>
            {props.onConfirm && (
              <button
                type="button"
                style={{ ...buttonStyle, background: '#c2410c', color: '#fff', borderColor: '#c2410c', fontWeight: 600 }}
                disabled={confirming}
                onClick={() => void submitConfirm()}
              >
                {confirming ? '确认中…' : '确认通过（置成功并自动执行下游）'}
              </button>
            )}
            {confirmMsg && (
              <div style={{ marginTop: 7, color: confirmMsg.ok ? '#047857' : '#b91c1c' }}>{confirmMsg.text}</div>
            )}
          </div>
        )}

        {/* 冻结配置 */}
        <details style={{ margin: '12px 0 4px' }}>
          <summary style={{ cursor: 'pointer', fontSize: 12, color: '#475569', fontWeight: 600 }}>
             冻结配置（角色 / 模型 / 工作目录 / 技能 / 工作流 / MCP / 预设 / 预算）
          </summary>
          <div style={{ fontSize: 11.5, color: '#334155', background: '#f8fafc', border: '1px solid #e8ecf3', borderRadius: 10, padding: 10, marginTop: 7, lineHeight: 1.9 }}>
            <div>
              <strong>角色</strong> {props.task.roleAgent} ｜{' '}
              <strong>模型</strong>{' '}
              {fc.model ? formatModelRoute(null, fc.model, fc.modelProvider) : '（角色默认）'} ｜{' '}
              <strong>工作目录</strong> {props.task.workspace || '未接线'}
            </div>
            <div>
              <strong>技能</strong> {fc.skills.length ? fc.skills.join('、') : '无'} ｜ <strong>工作流</strong>{' '}
              {fc.workflow ? `${fc.workflow}（强制逐步）` : '未启用'} ｜ <strong>MCP</strong>{' '}
              {fc.mcp.length ? fc.mcp.join('、') : '无'}
            </div>
            <div>
              <strong>预设</strong> {fc.preset || '（不指定）'} ｜ <strong>最大深度</strong>{' '}
              {fc.maxDepth && fc.maxDepth > 0 ? fc.maxDepth : '不限'} ｜ <strong>单次输出上限</strong>{' '}
              {fc.maxTokens && fc.maxTokens > 0 ? `${fc.maxTokens} tokens` : '不限'}
            </div>
          </div>
        </details>

        {/* attempt 切换 */}
        {attempts.length > 0 && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', margin: '10px 0' }}>
            {attempts.map((a, i) => (
              <button
                key={`${a.startedAt}-${i}`}
                type="button"
                onClick={() => setSelected(i)}
                className="td-chip-btn"
                data-active={i === selected}
                title={a.diagnostic ?? a.note ?? ''}
              >
                <span style={{ width: 8, height: 8, borderRadius: '50%', background: ATTEMPT_DOT[a.outcome] ?? '#9ca3af', display: 'inline-block' }} />
                第 {i + 1} 轮
              </button>
            ))}
          </div>
        )}

        {/* 失败诊断 */}
        {selectedAttempt?.outcome === 'failed' && (
          <div style={{ border: '1px solid #fecaca', background: 'linear-gradient(135deg,#fef2f2,#fee2e2)', color: '#991b1b', borderRadius: 12, padding: 12, marginBottom: 8 }}>
            <div style={{ fontWeight: 700, fontSize: 13, marginBottom: 5 }}>本轮执行失败</div>
            {selectedAttempt.stopReason && (
              <div style={{ fontSize: 11, marginBottom: 4 }}>
                终止原因：<code>{selectedAttempt.stopReason}</code>
              </div>
            )}
            <div style={{ fontSize: 12, whiteSpace: 'pre-wrap' }}>{selectedAttempt.diagnostic ?? selectedAttempt.note ?? '未返回失败诊断（可能是基础设施异常或子会话不可读）。'}</div>
          </div>
        )}

        {/* 执行流（时间线） */}
        <div className="td-stream" style={{ flex: 1, padding: 12, minHeight: 200, maxHeight: '52vh', display: 'flex', flexDirection: 'column' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flex: 'none' }}>
            <strong style={{ fontSize: 13, display: 'flex', alignItems: 'center', gap: 6 }}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                <circle cx="12" cy="12" r="9" stroke="#6366f1" strokeWidth="2" />
                <path d="M12 7v5l3 2" stroke="#6366f1" strokeWidth="2" strokeLinecap="round" />
              </svg>
              执行过程
            </strong>
            {trace?.truncated && <span style={{ fontSize: 11, color: '#b45309' }}>事件过多，仅保留首尾（共 {trace.total} 条）</span>}
            <button type="button" className="td-chip-btn" style={{ marginLeft: 'auto' }} disabled={loadingTrace} onClick={() => void loadTrace()}>
              {loadingTrace ? '加载中…' : '刷新'}
            </button>
          </div>

          <div className="td-stream-inner" style={{ flex: 1, overflow: 'auto', paddingRight: 4 }}>
            {/* 问题 2：统计折叠（默认终态展开）。 */}
            {trace?.available && trace.stats && (
              <details open={selectedAttempt?.outcome !== 'success'}>
                <summary style={{ cursor: 'pointer', fontSize: 12, color: '#475569', fontWeight: 600, marginBottom: 6 }}>
                  请求 / token / 工具统计
                </summary>
                <TraceStatsCard stats={trace.stats} />
              </details>
            )}

            {!trace && loadingTrace && <div style={{ fontSize: 12, color: '#64748b' }}>正在读取子会话事件…</div>}
            {trace && !trace.available && (
              <div style={{ fontSize: 12, color: '#92400e', background: '#fffbeb', border: '1px solid #fde68a', borderRadius: 10, padding: 11 }}>
                暂无执行过程：{trace.reason ?? '会话轨迹不可读'}
                <div style={{ marginTop: 5, color: '#a16207', fontSize: 11 }}>
                  任务尚未派发、子会话已不可读、或宿主未提供 sessionQuery 时会出现此提示。失败原因仍可在上方诊断框查看。
                </div>
              </div>
            )}
            {trace?.available && trace.entries.length === 0 && (
              <div style={{ fontSize: 12, color: '#64748b' }}>该轮暂无可展示事件。</div>
            )}
            {trace?.available && trace.entries.map((e, i) => <TraceRow key={i} e={e} />)}
          </div>
        </div>

        {/* 输出摘要（终态折叠，避免与执行流重复） */}
        {selectedAttempt?.output && (
          <details style={{ marginTop: 8 }}>
            <summary style={{ cursor: 'pointer', fontSize: 12, color: '#475569' }}>本轮原始输出摘要</summary>
            <pre style={monoStyle}>{selectedAttempt.output}</pre>
          </details>
        )}

        {/* 二次对话 / 追问 */}
        <div style={{ marginTop: 14, borderTop: '1px solid #e8ecf3', paddingTop: 12 }}>
          <label style={{ display: 'block', fontSize: 12, fontWeight: 600, marginBottom: 5 }}>
            二次对话 / 追问补充（同角色、同模型与工具配置起新一轮执行）
          </label>
          <textarea
            style={{ width: '100%', boxSizing: 'border-box', minHeight: 68, padding: 9, borderRadius: 10, border: '1px solid #d8dee9', fontSize: 13, fontFamily: 'inherit', resize: 'vertical' }}
            placeholder={deleted ? '任务已取消，不可追问。' : '例：失败原因是 401，请检查鉴权头后重试；或：再补充处理 xx 分支。'}
            value={message}
            disabled={sending || deleted}
            onChange={e => setMessage(e.target.value)}
          />
          {followError && <div style={{ color: '#b91c1c', fontSize: 12, marginTop: 4 }}>{followError}</div>}
          <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginTop: 7 }}>
            <button
              type="button"
              style={{ ...buttonStyle, background: '#2563eb', color: '#fff', borderColor: '#2563eb', fontWeight: 600 }}
              disabled={sending || deleted || !message.trim()}
              onClick={() => void submitFollowUp()}
            >
              {sending ? '提交中…' : '追问并重新执行'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

export default TaskDetailDialog

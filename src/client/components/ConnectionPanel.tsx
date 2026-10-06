// 连接与凭据面板（T029 自检 / T063 审计归档 / T031 连接档案 / T028b MCP 接入诊断）。
//
// ## 为什么把四件事放在一个页签
//
// 它们回答的是同一个问题：「这个插件现在**实际连到哪、能写什么、凭据放哪了**」。
// 拆成四个页签会让用户为了排一个连接问题点四处；合并后一次自检 + 一眼看全。
//
// ## 诚实标注（不粉饰的能力边界）
//
// - 宿主 `mcp-client` **没有**运行期增删 server 实例的 API（依据见 `McpInstanceInfo.runtimeAddReason`），
//   故本页**不提供**"添加 MCP 服务器"按钮，而是给出准确的声明式接入指引与环境模板；
// - 凭据（PAT）**保存后永不回显**：列表只显示 id/name/url/collection，表单留空表示"沿用原值"；
// - a11y（T065 最低要求）：所有输入有 `label` 关联、按钮有明确文本、状态区 `role="status"`、
//   环境模板用 `<pre>` 保留格式并配可聚焦的复制按钮。
//
// @module @deepseek-ai/dsh-tfs-requirment/client/components/ConnectionPanel

import { useMemo, useState } from 'react'
import type {
  ArchiveResult,
  AuditView,
  EnvFileResult,
  HealthResult,
  McpEnvTemplate,
  McpInstanceInfo,
  ProfileListResult,
  ProfileOpResult,
  ProfileSaveInput,
  TfsToolCatalogView,
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
  padding: '6px 12px',
  borderRadius: 6,
  border: '1px solid #d1d5db',
  background: '#f3f4f6',
  cursor: 'pointer',
  fontSize: 13,
}
const primaryButtonStyle: React.CSSProperties = {
  ...buttonStyle,
  background: '#2563eb',
  borderColor: '#2563eb',
  color: '#fff',
}
const h4Style: React.CSSProperties = { margin: '0 0 8px', fontSize: 14 }
const hintStyle: React.CSSProperties = { fontSize: 12, color: '#6b7280' }

/** 面板属性（全部由 slots.tsx 注入，本组件不直接 fetch）。 */
export interface ConnectionPanelProps {
  health: HealthResult | null
  onHealthCheck: () => void
  audit: AuditView | null
  onAuditRefresh: () => void
  onArchive: () => Promise<ArchiveResult>
  profiles: ProfileListResult | null
  onProfilesRefresh: () => void
  onSaveProfile: (input: ProfileSaveInput) => Promise<ProfileOpResult>
  onDeleteProfile: (id: string) => Promise<ProfileOpResult>
  onActivateProfile: (id: string) => Promise<ProfileOpResult>
  mcp: { instance: McpInstanceInfo; template: McpEnvTemplate } | null
  onMcpRefresh: () => void
  onWriteEnvFile: () => Promise<EnvFileResult>
  /**
   * 本插件直连 TFS REST 的能力目录（REST 化后重定义，2026-09-19）。
   *
   * 这一页原先在教用户"怎么把 tfs-mcp 接进 DSH"——那是把插件的内部实现细节推给用户。
   * REST 化后更进一步：插件**完全不依赖**任何 MCP 实例，自己用 `fetch` 打 `/_apis/*`。
   * 本页负责讲清楚**插件能做什么**（每个操作的读写性质 + 是否已接入 REST 端点）。
   */
  toolCatalog?: TfsToolCatalogView | null
  onToolCatalogRefresh?: () => void
}

/**
 * 连接与凭据面板。
 * @param props - 见 {@link ConnectionPanelProps}。
 */
export function ConnectionPanel(props: ConnectionPanelProps): JSX.Element {
  const [auditMsg, setAuditMsg] = useState<string | null>(null)
  const [archiving, setArchiving] = useState(false)
  const [envMsg, setEnvMsg] = useState<string | null>(null)
  const [copyMsg, setCopyMsg] = useState<string | null>(null)
  const [profileMsg, setProfileMsg] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  // 档案表单（编辑既有档案时 pat 留空 = 沿用原 PAT）。
  const [editId, setEditId] = useState<string>('')
  const [name, setName] = useState('')
  const [url, setUrl] = useState('')
  const [collection, setCollection] = useState('')
  const [pat, setPat] = useState('')
  // 问题 12：封装工具目录的筛选（分类 + 关键字）。工具近 50 个，不筛没法看。
  const [toolQuery, setToolQuery] = useState('')
  const [toolCat, setToolCat] = useState('')
  // 问题 12：MCP 实例诊断/环境模板降级为「高级·排障用」，默认折叠
  // （它讲的是插件内部实现细节，不该占据该页主视觉）。
  const [showAdvanced, setShowAdvanced] = useState(false)

  /** 封装工具按分类分组 + 关键字筛选（问题 12）。 */
  const toolGroups = useMemo(() => {
    const tools = props.toolCatalog?.tools ?? []
    const kw = toolQuery.trim().toLowerCase()
    const hit = tools.filter(t => {
      if (toolCat && t.category !== toolCat) return false
      if (!kw) return true
      return [t.plugin, t.raw, t.title, t.description].some(s => s.toLowerCase().includes(kw))
    })
    const groups = new Map<string, { label: string; items: typeof hit }>()
    for (const t of hit) {
      const g = groups.get(t.category) ?? { label: t.categoryLabel, items: [] }
      g.items.push(t)
      groups.set(t.category, g)
    }
    return [...groups.entries()]
  }, [props.toolCatalog, toolQuery, toolCat])

  const resetForm = (): void => {
    setEditId('')
    setName('')
    setUrl('')
    setCollection('')
    setPat('')
  }

  const submitProfile = async (): Promise<void> => {
    setSaving(true)
    setProfileMsg(null)
    try {
      const input: ProfileSaveInput = { name, url, collection, ...(pat ? { pat } : {}), ...(editId ? { id: editId } : {}) }
      const res = await props.onSaveProfile(input)
      setProfileMsg(res.ok ? `已保存档案 ${res.profile?.id ?? ''}` : `保存失败：${res.reason ?? '未知原因'}`)
      if (res.ok) {
        resetForm()
        props.onProfilesRefresh()
        props.onMcpRefresh()
      }
    } finally {
      setSaving(false)
    }
  }

  const archive = async (): Promise<void> => {
    setArchiving(true)
    setAuditMsg(null)
    try {
      const res = await props.onArchive()
      setAuditMsg(
        res.ok
          ? `已归档 ${res.archived ?? 0} 条${res.archivePath ? ` → ${res.archivePath}` : '（无过期条目，未创建文件）'}`
          : `归档失败：${res.reason ?? '未知原因'}`,
      )
      props.onAuditRefresh()
    } finally {
      setArchiving(false)
    }
  }

  const copyTemplate = async (): Promise<void> => {
    const text = (props.mcp?.template.posixLines ?? []).join('\n')
    try {
      await navigator.clipboard.writeText(text)
      setCopyMsg('已复制 POSIX 环境变量（含占位符，无明文 PAT）')
    } catch {
      setCopyMsg('复制失败（浏览器未授权剪贴板），请手动选中下方文本复制')
    }
  }

  const writeEnv = async (): Promise<void> => {
    setEnvMsg(null)
    const res = await props.onWriteEnvFile()
    setEnvMsg(
      res.ok
        ? `已导出 ${res.path}（${res.bytes ?? 0} 字节${res.hardened ? '，权限 0600' : '；文件系统不支持收紧权限，请自行确认访问控制'}）。` +
          '该文件含明文 PAT，仅用于凭据备份/迁移 —— 插件直连 REST，正常运行无需 source 它。'
        : `导出失败：${res.reason ?? '未知原因'}`,
    )
  }

  return (
    <div style={{ padding: 16, fontFamily: 'system-ui, sans-serif', color: '#111827', maxWidth: 860 }}>
      <h3 style={{ margin: '0 0 12px' }}>连接与凭据</h3>

      {/* ── T029 连通性自检 ── */}
      <section style={sectionStyle} aria-labelledby="sec-health">
        <h4 id="sec-health" style={h4Style}>
          连通性自检（T029）
        </h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={primaryButtonStyle} onClick={props.onHealthCheck}>
            运行自检
          </button>
          <span style={hintStyle}>
            只读调用 whoami / 当前集合 / 项目清单（直连 REST <code>/_apis/*</code>），不触发任何写操作
          </span>
        </div>
        <div role="status" aria-live="polite" style={{ marginTop: 10 }}>
          {props.health === null && <div style={hintStyle}>尚未自检。</div>}
          {props.health !== null && (
            <div
              style={{
                border: '1px solid #e5e7eb',
                borderLeft: `4px solid ${props.health.ok ? '#059669' : '#dc2626'}`,
                borderRadius: 8,
                padding: 12,
                fontSize: 13,
              }}
            >
              <div style={{ fontWeight: 600, color: props.health.ok ? '#047857' : '#b91c1c' }}>
                {props.health.ok ? '连通正常' : `连接失败（${props.health.kind ?? 'unknown'}）`}
              </div>
              {props.health.identity && <div style={{ marginTop: 4 }}>身份：{props.health.identity}</div>}
              {props.health.collection && <div>当前集合：{props.health.collection}</div>}
              {props.health.projectCount !== undefined && <div>可见项目：{props.health.projectCount}</div>}
              {props.health.reason && <div style={{ marginTop: 4, color: '#7f1d1d' }}>{props.health.reason}</div>}
              {props.health.tools && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ color: '#374151' }}>
                    已接入 REST 的操作 {props.health.tools.available.length} 个
                  </div>
                  {props.health.tools.missing.length > 0 && (
                    <div style={{ marginTop: 4, color: '#b45309' }}>
                      契约表已登记、但尚未接入端点（能力缺口）：{props.health.tools.missing.join(', ')}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      </section>

      {/* ── 本插件直连 REST 的能力目录 ──
          取代原先"教用户把 tfs-mcp 接进 DSH"的引导（REST 化后连"封装 MCP 工具"都不必讲了）：
          插件自己用 fetch 打 /_apis/*，对外只暴露 tfs_req_* 工具，这里讲清楚能做什么。 */}
      <section style={sectionStyle} aria-labelledby="sec-tools">
        <h4 id="sec-tools" style={h4Style}>
          TFS 能力目录（REST 直连 → tfs_req_*）
        </h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle} onClick={props.onToolCatalogRefresh ?? props.onMcpRefresh}>
            刷新能力目录
          </button>
          <span style={hintStyle}>
            {props.toolCatalog
              ? `契约表登记 ${props.toolCatalog.rawCount} 个操作，已接入端点 ${props.toolCatalog.wrappedCount} 个`
              : '尚未读取能力目录'}
            {props.toolCatalog && props.toolCatalog.missingCount > 0 && (
              <span style={{ color: '#b45309' }}> ｜ 另有 {props.toolCatalog.missingCount} 个尚未接入端点（能力缺口）</span>
            )}
          </span>
        </div>
        <div style={{ marginTop: 8, padding: 8, background: '#f8fafc', borderRadius: 6, fontSize: 12, color: '#374151' }}>
          <strong>本插件不依赖任何 MCP：</strong>TFS 查询与操作一律<strong>直连 REST</strong>
          （<code>/_apis/*</code>），凭据由「连接档案」按调用实时提供 —— 改 PAT 当场生效，无需重启。
          模型只会看到本插件注册的 <code>tfs_req_*</code> 工具；所有写操作走适配层单一出口，
          过 dry-run / 确认 / 幂等 / 审计四道写门禁，不存在绕过路径。
        </div>
        {props.toolCatalog && !props.toolCatalog.ok && (
          <div style={{ marginTop: 6, fontSize: 12, color: '#b45309' }}>{props.toolCatalog.reason}</div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <input
            type="search"
            aria-label="按操作名刷选"
            style={inputStyle}
            placeholder="按工具名 / 操作键 / 说明刷选…"
            value={toolQuery}
            onChange={e => setToolQuery(e.target.value)}
          />
          <select aria-label="按分类筛选" style={inputStyle} value={toolCat} onChange={e => setToolCat(e.target.value)}>
            <option value="">全部分类</option>
            {[...new Set((props.toolCatalog?.tools ?? []).map(t => t.category))].map(c => (
              <option key={c} value={c}>
                {(props.toolCatalog?.tools ?? []).find(t => t.category === c)?.categoryLabel ?? c}
              </option>
            ))}
          </select>
          <span style={hintStyle}>{toolGroups.reduce((n, [, g]) => n + g.items.length, 0)} 个</span>
        </div>
        <div style={{ marginTop: 8, maxHeight: 320, overflowY: 'auto' }}>
          {toolGroups.length === 0 && <div style={hintStyle}>无匹配工具。</div>}
          {toolGroups.map(([cat, g]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 12, fontWeight: 600, color: '#374151', marginBottom: 4 }}>
                {g.label}（{g.items.length}）
              </div>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <tbody>
                  {g.items.map(t => (
                    <tr key={t.plugin} style={{ borderTop: '1px solid #f1f5f9' }}>
                      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                        <code>{t.plugin}</code>
                      </td>
                      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap', color: '#6b7280' }}>{t.raw}</td>
                      <td style={{ padding: '4px 8px', whiteSpace: 'nowrap' }}>
                        <span
                          style={{
                            color: t.access === 'write' ? '#b45309' : '#047857',
                            border: `1px solid ${t.access === 'write' ? '#fcd34d' : '#a7f3d0'}`,
                            borderRadius: 10,
                            padding: '1px 8px',
                            fontSize: 11,
                          }}
                        >
                          {t.access === 'write' ? '写·过门禁' : '读'}
                        </span>
                        {t.unregistered && <span style={{ color: '#b45309', marginLeft: 6 }}>未登记</span>}
                        {t.unimplemented && <span style={{ color: '#b45309', marginLeft: 6 }}>端点未接入</span>}
                      </td>
                      <td style={{ padding: '4px 8px', color: '#374151' }}>{t.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </div>
      </section>

      {/* ── 连接诊断：降级为「高级·排障用」，默认折叠 ── */}
      <section style={sectionStyle} aria-labelledby="sec-mcp">
        <h4 id="sec-mcp" style={h4Style}>
          <button
            type="button"
            aria-expanded={showAdvanced}
            onClick={() => setShowAdvanced(v => !v)}
            style={{ border: 'none', background: 'transparent', cursor: 'pointer', fontSize: 14, fontWeight: 600, padding: 0, color: '#111827' }}
          >
            {showAdvanced ? '▾' : '▸'} 高级：连接诊断与凭据导出（排障用）
          </button>
        </h4>
        {showAdvanced && (
          <div style={{ fontSize: 12, color: '#6b7280', marginBottom: 8 }}>
            仅当需要排查"TFS 连不上 / 凭据从哪来"时才看这里。正常使用时无需关心 ——
            插件直连 REST，凭据从上面选中的连接档案实时读取。
          </div>
        )}
        {showAdvanced && props.mcp === null && <div style={hintStyle}>尚未读取连接诊断。</div>}
        {showAdvanced && props.mcp !== null && (
          <>
            <div style={{ fontSize: 13 }}>
              <div>
                连接状态：
                {props.mcp.instance.runtimeAddSupported && props.mcp.instance.serverNameValid ? (
                  <span style={{ color: '#047857' }}>✓ 可运行期变更（直连 REST）</span>
                ) : (
                  <span style={{ color: '#b91c1c' }}>✗ 需检查连接档案</span>
                )}
              </div>
            </div>
            <div style={{ marginTop: 8, padding: 8, background: '#ecfdf5', borderRadius: 6, fontSize: 12, color: '#065f46' }}>
              <strong>连接方式：</strong> {props.mcp.instance.runtimeAddReason}
            </div>
            <div style={{ marginTop: 6, fontSize: 12, color: '#374151' }}>{props.mcp.instance.duplicateRisk}</div>
            <div style={{ marginTop: 6, fontSize: 12, color: '#374151' }}>{props.mcp.instance.credentialPath}</div>

            <div style={{ marginTop: 10 }}>
              <div style={{ fontSize: 13, marginBottom: 4 }}>凭据导出模板（PAT 为占位符，用于备份/迁移）：</div>
              <pre
                tabIndex={0}
                aria-label="TFS 凭据导出模板"
                style={{
                  background: '#0f172a',
                  color: '#e5e7eb',
                  padding: 10,
                  borderRadius: 6,
                  fontSize: 12,
                  overflowX: 'auto',
                  margin: 0,
                }}
              >
                {props.mcp.template.posixLines.join('\n')}
              </pre>
              <div style={{ marginTop: 6, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                <button type="button" style={buttonStyle} onClick={() => void copyTemplate()}>
                  复制（POSIX）
                </button>
                <button type="button" style={primaryButtonStyle} onClick={() => void writeEnv()}>
                  导出凭据文件（含明文 PAT）
                </button>
                <span style={hintStyle}>
                  目标：<code>{props.mcp.template.envFilePath}</code>
                </span>
              </div>
              {copyMsg && <div style={{ ...hintStyle, marginTop: 4 }}>{copyMsg}</div>}
              {envMsg && (
                <div role="status" aria-live="polite" style={{ marginTop: 4, fontSize: 12, color: '#047857' }}>
                  {envMsg}
                </div>
              )}
              <div style={{ marginTop: 4, fontSize: 12, color: '#92400e' }}>{props.mcp.template.note}</div>
            </div>
          </>
        )}
      </section>

      {/* ── T031 连接档案 ── */}
      <section style={sectionStyle} aria-labelledby="sec-profile">
        <h4 id="sec-profile" style={h4Style}>
          连接档案（T031 / FR-002 / FR-031）
        </h4>
        <div style={{ fontSize: 13 }}>
          {props.profiles === null && <div style={hintStyle}>尚未加载档案。</div>}
          {props.profiles !== null && props.profiles.profiles.length === 0 && (
            <div style={hintStyle}>暂无档案。填写下方表单新增（PAT 只进本地存储，不回显）。</div>
          )}
          {props.profiles !== null && props.profiles.profiles.length > 0 && (
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
              <thead>
                <tr style={{ textAlign: 'left', color: '#6b7280' }}>
                  <th style={{ padding: '6px 8px' }}>名称</th>
                  <th style={{ padding: '6px 8px' }}>地址</th>
                  <th style={{ padding: '6px 8px' }}>集合</th>
                  <th style={{ padding: '6px 8px' }} />
                </tr>
              </thead>
              <tbody>
                {props.profiles.profiles.map(p => (
                  <tr key={p.id}>
                    <td style={{ padding: '6px 8px', borderTop: '1px solid #f1f5f9' }}>
                      {p.name}
                      {props.profiles?.activeId === p.id && (
                        <span style={{ marginLeft: 6, color: '#047857', fontSize: 11 }}>（当前使用）</span>
                      )}
                    </td>
                    <td style={{ padding: '6px 8px', borderTop: '1px solid #f1f5f9' }}>{p.url}</td>
                    <td style={{ padding: '6px 8px', borderTop: '1px solid #f1f5f9' }}>{p.collection}</td>
                    <td style={{ padding: '6px 8px', borderTop: '1px solid #f1f5f9', whiteSpace: 'nowrap' }}>
                      <button
                        type="button"
                        style={{ ...buttonStyle, marginRight: 6 }}
                        onClick={() => {
                          setEditId(p.id)
                          setName(p.name)
                          setUrl(p.url)
                          setCollection(p.collection)
                          setPat('')
                        }}
                      >
                        编辑
                      </button>
                      <button
                        type="button"
                        style={{ ...buttonStyle, marginRight: 6 }}
                        onClick={() => {
                          void props.onActivateProfile(p.id).then(r => {
                            setProfileMsg(r.ok ? `已切换为「${r.profile?.name ?? p.id}」` : `切换失败：${r.reason}`)
                            props.onProfilesRefresh()
                          })
                        }}
                      >
                        设为当前
                      </button>
                      <button
                        type="button"
                        style={buttonStyle}
                        onClick={() => {
                          void props.onDeleteProfile(p.id).then(r => {
                            setProfileMsg(r.ok ? '已删除（存储已随机字节覆写 S-12）' : `删除失败：${r.reason}`)
                            props.onProfilesRefresh()
                          })
                        }}
                      >
                        删除
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        {/*
          问题 13：档案表单原是「label 与 input 同为 flex 子元素」的一行流式布局，
          空间不够时标签会折行到输入框旁边，看起来就是"两个字段挤在一行"。
          改成**一个字段一行**（label 独占一行、input 独占一行），按钮单独一行。
        */}
        <div style={{ marginTop: 12, display: 'grid', gap: 10 }}>
          <div>
            <label htmlFor="pf-name" style={{ ...hintStyle, display: 'block', marginBottom: 4 }}>
              名称
            </label>
            <input id="pf-name" style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} value={name} onChange={e => setName(e.target.value)} />
          </div>
          <div>
            <label htmlFor="pf-url" style={{ ...hintStyle, display: 'block', marginBottom: 4 }}>
              地址
            </label>
            <input
              id="pf-url"
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
              placeholder="http://tfs2018-web.winning.com.cn:8080/tfs"
              value={url}
              onChange={e => setUrl(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="pf-col" style={{ ...hintStyle, display: 'block', marginBottom: 4 }}>
              集合
            </label>
            <input id="pf-col" style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }} value={collection} onChange={e => setCollection(e.target.value)} />
          </div>
          <div>
            <label htmlFor="pf-pat" style={{ ...hintStyle, display: 'block', marginBottom: 4 }}>
              PAT（保存后永不回显）
            </label>
            <input
              id="pf-pat"
              type="password"
              style={{ ...inputStyle, width: '100%', boxSizing: 'border-box' }}
              placeholder={editId ? '留空=沿用原 PAT' : '必填'}
              value={pat}
              autoComplete="off"
              onChange={e => setPat(e.target.value)}
            />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button type="button" style={primaryButtonStyle} disabled={saving} onClick={() => void submitProfile()}>
              {saving ? '保存中…' : editId ? '保存修改' : '新增档案'}
            </button>
            {editId && (
              <button type="button" style={buttonStyle} onClick={resetForm}>
                取消编辑
              </button>
            )}
          </div>
        </div>
        {profileMsg && (
          <div role="status" aria-live="polite" style={{ marginTop: 6, fontSize: 12, color: '#374151' }}>
            {profileMsg}
          </div>
        )}
      </section>

      {/* ── T063 审计归档 ── */}
      <section style={sectionStyle} aria-labelledby="sec-audit">
        <h4 id="sec-audit" style={h4Style}>
          审计与归档（T063 / S-03）
        </h4>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <button type="button" style={buttonStyle} onClick={props.onAuditRefresh}>
            刷新审计状态
          </button>
          <button type="button" style={primaryButtonStyle} disabled={archiving} onClick={() => void archive()}>
            {archiving ? '归档中…' : '归档过期条目'}
          </button>
          <span style={hintStyle}>
            归档只<strong>读</strong> live 日志、把过期条目写入独立文件，审计日志保持 append-only
          </span>
        </div>
        <div role="status" aria-live="polite" style={{ marginTop: 8, fontSize: 13 }}>
          {props.audit === null && <span style={hintStyle}>尚未读取审计状态。</span>}
          {props.audit !== null && (
            <>
              {!props.audit.ok && <div style={{ color: '#b91c1c' }}>读取失败：{props.audit.reason}</div>}
              <div>
                保留期 {props.audit.retentionDays} 天 ｜ 条目总数 {props.audit.total} ｜ 待归档 {props.audit.expired}
              </div>
              {props.audit.archiveFiles.length > 0 && (
                <div style={{ marginTop: 4 }}>
                  归档文件：
                  <ul style={{ margin: '4px 0 0 18px', padding: 0 }}>
                    {props.audit.archiveFiles.map(f => (
                      <li key={f.name}>
                        <code>{f.name}</code>（{f.bytes} 字节）
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </>
          )}
          {auditMsg && (
            <div style={{ marginTop: 6, color: auditMsg.startsWith('归档失败') ? '#b91c1c' : '#047857' }}>{auditMsg}</div>
          )}
        </div>
      </section>
    </div>
  )
}

export default ConnectionPanel

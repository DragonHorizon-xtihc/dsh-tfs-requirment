import { describe, expect, it } from 'vitest'
import { normalizeWorkItem, escapeWiql } from '../src/tfs/adapter.js'

/**
 * 工作项归一化单测（US2 / T013 实测形状）。
 *
 * 依据 **T013 实测**：tfs-mcp 的 `tfs_get_workitem` 返回**归一化扁平形状**
 * （id/title/type/state/assignedTo/priority/areaPath/iterationPath/tags(分号)/changedDate/url/...）。
 * 另对 `tfs_custom_query` 声明的 `{ id, fields: { 'System.Title': ... } }` 形状做兼容兜底。
 */

describe('normalizeWorkItem（实测扁平形状）', () => {
  it('映射实测字段并拆分分号标签', () => {
    const raw = {
      id: 1,
      title: 'MEMORY.md consolidation',
      type: '产品或项目计划',
      state: '已关闭',
      assignedTo: 'ysh（杨善辉） <WINNING\\ysh>',
      priority: '2',
      areaPath: 'EDIS',
      iterationPath: 'EDIS\\Sprint 1',
      tags: 'test-tag; 计划',
      changedDate: '2026-09-17T07:45:39.597Z',
      url: 'http://tfs/_apis/wit/workItems/1',
      collection: 'WN_HIS',
    }
    const r = normalizeWorkItem(raw, 'WN_HIS')
    expect(r.id).toBe(1)
    expect(r.title).toBe('MEMORY.md consolidation')
    expect(r.type).toBe('产品或项目计划')
    expect(r.state).toBe('已关闭')
    expect(r.assignedTo).toContain('杨善辉')
    expect(r.tags).toEqual(['test-tag', '计划'])
    expect(r.changedDate).toBe('2026-09-17T07:45:39.597Z')
    expect(r.collection).toBe('WN_HIS')
  })

  it('集合缺失时用兜底值', () => {
    const r = normalizeWorkItem({ id: 9, title: 'x' }, 'WN_TJ')
    expect(r.collection).toBe('WN_TJ')
  })

  it('tags 为空串 → 空数组（不留 [""]）', () => {
    expect(normalizeWorkItem({ id: 9, title: 'x', tags: '' }, 'WN_HIS').tags).toEqual([])
  })

  it('兼容 { id, fields } 包装形状（tfs_custom_query 声明）', () => {
    const raw = {
      id: 42,
      fields: {
        'System.Title': '登录失败',
        'System.State': 'Active',
        'System.WorkItemType': 'Bug',
        'System.AssignedTo': 'zhangbo3',
        'System.ChangedDate': '2026-09-01T00:00:00Z',
      },
    }
    const r = normalizeWorkItem(raw, 'WN_HIS')
    expect(r.id).toBe(42)
    expect(r.title).toBe('登录失败')
    expect(r.state).toBe('Active')
    expect(r.type).toBe('Bug')
  })

  it('缺失字段降级为空串/0，不抛', () => {
    const r = normalizeWorkItem(null, 'WN_HIS')
    expect(r.id).toBe(0)
    expect(r.title).toBe('')
    expect(r.tags).toEqual([])
  })
})

/**
 * 正文归一化（T008 / US3 / FR-009）。
 *
 * 背景：「设为目标」之前带不出需求内容，第一层原因就是**这里根本没取 `System.Description`**
 * （`RequirementSummary` 契约里连字段都没有），下游自然无从带出。此处锁死"取到 + 转纯文本"。
 */
describe('normalizeWorkItem 正文（System.Description）', () => {
  it('扁平形状的 `description` 原样带出', () => {
    const r = normalizeWorkItem({ id: 1, title: 'x', description: '急诊改造' }, 'WN_HIS')
    expect(r.description).toBe('急诊改造')
  })

  it('`{ id, fields }` 形状的 `System.Description` 同样带出（两种 TFS 形状都要覆盖）', () => {
    const r = normalizeWorkItem(
      { id: 42, fields: { 'System.Title': 'x', 'System.Description': '富文本正文' } },
      'WN_HIS',
    )
    expect(r.description).toBe('富文本正文')
  })

  it('HTML 富文本 → 纯文本（客户端半不做 HTML 解析，必须在宿主半转好）', () => {
    const r = normalizeWorkItem(
      { id: 1, title: 'x', description: '<div>第一段</div><div>第二段&nbsp;&amp;续</div>' },
      'WN_HIS',
    )
    expect(r.description).toBe('第一段\n第二段 &续')
  })

  it('正文为空 → 不带出 description 键（避免 board.json 堆空串）', () => {
    const r = normalizeWorkItem({ id: 1, title: 'x' }, 'WN_HIS')
    expect('description' in r).toBe(false)
  })
})

describe('escapeWiql', () => {
  it('单引号翻倍（防 WIQL 注入）', () => {
    expect(escapeWiql("a'b")).toBe("a''b")
    expect(escapeWiql('正常')).toBe('正常')
  })
})

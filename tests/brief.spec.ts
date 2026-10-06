import { describe, expect, it } from 'vitest'
import {
  BRIEF_HEADER,
  CONCLUSION_MAX_ENTRIES,
  SUMMARY_HEADER,
  buildBriefSection,
  buildFinalSummaryPrompt,
  buildSummarizePrompt,
  emptyBrief,
  mergeArtifacts,
  parseOrchestratorSummary,
  setDigest,
  stripProtocolMarkers,
  upsertConclusion,
} from '../src/shared/brief.js'
import { TASK_DONE_MARKER, NEEDS_HUMAN_CONFIRM_MARKER, ARTIFACTS_HEADER } from '../src/shared/exec-protocol.js'

/**
 * 需求级共享简报（US3）。
 *
 * 核心断言是 AC3.2：**一旦简报里有了需求摘要，需求正文全文就不再进后续任务的 prompt**。
 * 这条如果退化，"共享简报"就只是多贴了一遍正文，省 token 的目标是假的。
 */

const FULL_REQUIREMENT_TEXT = '需求正文全文：需要改造体检报告汇总模块，涉及 A、B、C 三个子流程……（很长）'

describe('emptyBrief / 字段默认值', () => {
  it('新简报无结论、无产物、工具为空', () => {
    const b = emptyBrief('1997179@WN_HIS', '汇总改造', {}, () => '2026-09-29T00:00:00.000Z')
    expect(b.requirementKey).toBe('1997179@WN_HIS')
    expect(b.title).toBe('汇总改造')
    expect(b.conclusions).toEqual([])
    expect(b.artifacts).toEqual([])
    expect(b.tools).toEqual({ mcp: [], skills: [] })
    expect(b.updatedAt).toBe('2026-09-29T00:00:00.000Z')
    expect(b.digest).toBeUndefined()
  })
})

describe('upsertConclusion（幂等 + 限长 + 上限）', () => {
  it('同 taskId 覆盖而非追加', () => {
    let b = emptyBrief('k', 't')
    b = upsertConclusion(b, { taskId: 'a', title: '分析', summary: '第一版' })
    b = upsertConclusion(b, { taskId: 'a', title: '分析', summary: '第二版' })
    expect(b.conclusions).toHaveLength(1)
    expect(b.conclusions[0]?.summary).toBe('第二版')
  })

  it('不同 taskId 按完成顺序追加', () => {
    let b = emptyBrief('k', 't')
    b = upsertConclusion(b, { taskId: 'a', title: 'A', summary: 'sa' })
    b = upsertConclusion(b, { taskId: 'b', title: 'B', summary: 'sb' })
    expect(b.conclusions.map(c => c.taskId)).toEqual(['a', 'b'])
  })

  it('超过上限丢弃最早的，保留最近的', () => {
    let b = emptyBrief('k', 't')
    for (let i = 0; i < CONCLUSION_MAX_ENTRIES + 5; i++) {
      b = upsertConclusion(b, { taskId: `t${i}`, title: `T${i}`, summary: `s${i}` })
    }
    expect(b.conclusions).toHaveLength(CONCLUSION_MAX_ENTRIES)
    expect(b.conclusions[0]?.taskId).toBe('t5')
    expect(b.conclusions[b.conclusions.length - 1]?.taskId).toBe(`t${CONCLUSION_MAX_ENTRIES + 4}`)
  })

  it('结论超长会被截断', () => {
    let b = emptyBrief('k', 't')
    b = upsertConclusion(b, { taskId: 'a', title: 'A', summary: 'x'.repeat(1000) })
    expect((b.conclusions[0]?.summary ?? '').length).toBeLessThan(500)
    expect(b.conclusions[0]?.summary).toContain('已截断')
  })
})

describe('mergeArtifacts（去重 / 保序 / 限条数）', () => {
  it('重复路径只保留一次，保持首次出现顺序', () => {
    let b = emptyBrief('k', 't')
    b = mergeArtifacts(b, ['/a/x.md', '/b/y.md'])
    b = mergeArtifacts(b, ['/b/y.md', '/c/z.md'])
    expect(b.artifacts).toEqual(['/a/x.md', '/b/y.md', '/c/z.md'])
  })

  it('空输入不改简报（也不刷新 updatedAt）', () => {
    const b = emptyBrief('k', 't', {}, () => 'T0')
    expect(mergeArtifacts(b, [])).toBe(b)
  })
})

describe('buildBriefSection（AC3.2：不重复下发需求正文全文）', () => {
  it('无 digest 时回退下发需求正文全文（首个任务）', () => {
    const b = emptyBrief('k', '汇总改造')
    const s = buildBriefSection(b, { requirementPrompt: FULL_REQUIREMENT_TEXT })
    expect(s).toContain(FULL_REQUIREMENT_TEXT)
  })

  it('有 digest 时**不再**下发需求正文全文，只发摘要', () => {
    const b = setDigest(emptyBrief('k', '汇总改造'), '需求理解摘要：改 A 流程')
    const s = buildBriefSection(b, { requirementPrompt: FULL_REQUIREMENT_TEXT })
    expect(s).toContain('需求理解摘要：改 A 流程')
    expect(s).not.toContain(FULL_REQUIREMENT_TEXT)
  })

  it('段头、工作目录、已绑定工具、结论、产物都会出现', () => {
    let b = emptyBrief('k', '汇总改造', {
      workspace: 'D:/repo',
      tools: { mcp: ['tfs'], skills: ['peis'] },
    })
    b = setDigest(b, '摘要')
    b = upsertConclusion(b, { taskId: 'a', title: '分析', summary: '结论 A', artifacts: ['/a.md'] })
    b = mergeArtifacts(b, ['/a.md'])
    const s = buildBriefSection(b)
    expect(s.startsWith(BRIEF_HEADER)).toBe(true)
    expect(s).toContain('D:/repo')
    expect(s).toContain('已启用 MCP：tfs')
    expect(s).toContain('已启用技能：peis')
    expect(s).toContain('优先使用')
    expect(s).toContain('分析：结论 A')
    expect(s).toContain('/a.md')
  })

  it('空简报且无兜底正文时不产出噪声', () => {
    expect(buildBriefSection(emptyBrief('k', 't'))).toBe('')
  })
})

describe('buildSummarizePrompt / buildFinalSummaryPrompt', () => {
  it('归纳请求要求 SUMMARY 段并限长', () => {
    const s = buildSummarizePrompt({
      requirementKey: 'k',
      taskId: 'a',
      title: '分析',
      output: '原始输出',
      artifacts: ['/a.md'],
      hasNext: true,
    })
    expect(s).toContain(SUMMARY_HEADER)
    expect(s).toContain('原始输出')
    expect(s).toContain('/a.md')
    expect(s).toContain('等待系统放行')
  })

  it('最终总结请求带上各任务结论', () => {
    const s = buildFinalSummaryPrompt({
      requirementKey: 'k',
      title: '汇总改造',
      tasks: [{ title: '分析', summary: '结论 A' }, { title: '开发' }],
    })
    expect(s).toContain('结论 A')
    expect(s).toContain('汇总改造')
  })
})

describe('parseOrchestratorSummary', () => {
  it('优先取显式 SUMMARY 段', () => {
    const out = `前面一堆过程说明\n${SUMMARY_HEADER}\n改了 A，注意 B\n\n后面还有别的`
    expect(parseOrchestratorSummary(out)).toBe('改了 A，注意 B')
  })

  it('遇到下一个全大写段头即结束', () => {
    const out = `${SUMMARY_HEADER}\n结论本体\nNOTES:\n不该被吃进来`
    expect(parseOrchestratorSummary(out)).toBe('结论本体')
  })

  it('无 SUMMARY 段时兜底取去标记后的正文', () => {
    const out = `改了 A 模块\n${TASK_DONE_MARKER}`
    expect(parseOrchestratorSummary(out)).toBe('改了 A 模块')
  })

  it('空输出返回空串（调用方据此判"无摘要"）', () => {
    expect(parseOrchestratorSummary('')).toBe('')
    expect(parseOrchestratorSummary(undefined)).toBe('')
  })
})

describe('stripProtocolMarkers', () => {
  it('去掉 TASK_DONE / NEEDS_HUMAN_CONFIRM / ARTIFACTS 段', () => {
    const out = [
      '正文一',
      `${ARTIFACTS_HEADER}`,
      '- /a.md',
      '',
      '正文二',
      TASK_DONE_MARKER,
      `${NEEDS_HUMAN_CONFIRM_MARKER}: 别管我`,
    ].join('\n')
    const cleaned = stripProtocolMarkers(out)
    expect(cleaned).toContain('正文一')
    expect(cleaned).toContain('正文二')
    expect(cleaned).not.toContain('/a.md')
    expect(cleaned).not.toContain(TASK_DONE_MARKER)
    expect(cleaned).not.toContain(NEEDS_HUMAN_CONFIRM_MARKER)
  })
})

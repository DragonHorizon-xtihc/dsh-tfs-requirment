/**
 * `shared/capability-plan.ts` 单测（2026-10-29 诉求 3 / 4）。
 *
 * 锁三件事：
 *  1. **工作流步骤解析**：只认"像步骤"的标题（Phase/Step/阶段/步骤/编号），
 *     不能把 `## 关键规则`、`## 参考文件` 也算成待执行步骤（那会让验收整片误判）。
 *  2. **下发文案**：技能正文整篇、MCP 真实工具名、逐步勾选纪律必须都在 prompt 里。
 *  3. **验收口径**：技能未加载 / MCP 未调用 / 步骤未逐条报告必须被抓出来；
 *     事件不可读时**不误杀**（降级为通过）。
 */

import { describe, expect, it } from 'vitest'
import {
  buildCapabilityPlanSection,
  extractWorkflowSteps,
  parseReportedSteps,
  stripFrontmatter,
  verifyCapabilityUsage,
} from '../src/shared/capability-plan.js'

const SKILL_WITH_PHASES = `---
name: demo-flow
description: 演示用工作流
---
# 演示工作流

## 流程总览

先读输入，再改代码，最后自检。

## 阶段 1：读取上下文

- 读 openspec

## 阶段 2：编码

- 按 tasks 逐条实现

### Step 2.1：单元测试

- 跑 vitest

## 关键规则

不要跳过任何步骤。

## 参考文件

- docs/x.md
`

describe('stripFrontmatter', () => {
  it('去掉 YAML frontmatter，保留正文', () => {
    expect(stripFrontmatter(SKILL_WITH_PHASES).startsWith('# 演示工作流')).toBe(true)
  })

  it('没有 frontmatter 时原样返回；不完整的 frontmatter 不吞正文', () => {
    expect(stripFrontmatter('# 标题')).toBe('# 标题')
    expect(stripFrontmatter('---\nname: x\n# 标题')).toContain('# 标题')
  })
})

describe('extractWorkflowSteps', () => {
  it('识别 阶段 / Step 标题，跳过"流程总览 / 关键规则 / 参考文件"', () => {
    expect(extractWorkflowSteps(SKILL_WITH_PHASES)).toEqual([
      '阶段 1：读取上下文',
      '阶段 2：编码',
      'Step 2.1：单元测试',
    ])
  })

  it('识别英文 Phase / Stage / 编号标题', () => {
    const md = ['## Phase 0: 初始化', '## Stage 1: 设计', '### 2. 实现', '## 附录'].join('\n')
    expect(extractWorkflowSteps(md)).toEqual(['Phase 0: 初始化', 'Stage 1: 设计', '2. 实现'])
  })

  it('代码块里的标题不算步骤（防止示例代码污染流程）', () => {
    const md = ['## Phase 1: A', '```md', '## Phase 9: 示例', '```', '## Phase 2: B'].join('\n')
    expect(extractWorkflowSteps(md)).toEqual(['Phase 1: A', 'Phase 2: B'])
  })

  it('少于 2 步时返回空数组（交由调用方按"整篇即流程"处理）', () => {
    expect(extractWorkflowSteps('## Phase 1: 只有一步')).toEqual([])
    expect(extractWorkflowSteps('# 纯叙述\n\n没有标题。')).toEqual([])
  })

  it('去重同名步骤', () => {
    const md = ['## Phase 1: A', '## Phase 1: A', '## Phase 2: B'].join('\n')
    expect(extractWorkflowSteps(md)).toEqual(['Phase 1: A', 'Phase 2: B'])
  })
})

describe('parseReportedSteps', () => {
  it('只认「步骤 i/N」可机验标记', () => {
    const out = ['▶ 步骤 1/3：读取', '✅ 步骤 1/3：读完', '✅ 步骤 2/3：编码', '我觉得都做完了'].join('\n')
    expect(parseReportedSteps(out, 3)).toEqual([1, 2])
  })

  it('越界序号被忽略', () => {
    expect(parseReportedSteps('✅ 步骤 9/3：乱写', 3)).toEqual([])
  })

  it('「已完成 N/N 步」整体汇报计入全部步骤（2026-11-03 问题 4）', () => {
    const out = '工作流：peis-auto-dev-winmatrix（已完成 2/2 步；编码与验证均在前序会话执行）'
    expect(parseReportedSteps(out, 2)).toEqual([1, 2])
  })

  it('整体汇报的 N 与总步数不符时不算（防"11/13"这类进度串误判）', () => {
    // 无「步」后缀的 11/13 是任务进度，不是工作流步骤。
    expect(parseReportedSteps('编码任务完成 11/13，继续', 2)).toEqual([])
    // 有「步」但数量对不上总步数（2/2 ≠ 5 步）也不算。
    expect(parseReportedSteps('已完成 2/2 步', 5)).toEqual([])
  })

  it('部分汇报「已完成 1/2 步」语义含糊，不计入（只认 N/N 全完成）', () => {
    expect(parseReportedSteps('已完成 1/2 步', 2)).toEqual([])
  })
})

describe('buildCapabilityPlanSection', () => {
  const section = buildCapabilityPlanSection({
    skills: [{ name: 'demo-flow', content: SKILL_WITH_PHASES }],
    mcp: [{ server: 'tfs', tools: ['mcp__tfs__get_workitem'] }],
    workflow: 'demo-flow',
    workflowSteps: ['阶段 1：读取上下文', '阶段 2：编码'],
  })

  it('包含技能调用指令与整篇正文（正文里的 frontmatter 已剔除）', () => {
    expect(section).toContain('必须加载并遵循的技能')
    expect(section).toContain('`skill`')
    expect(section).toContain('──── 技能 demo-flow 开始 ────')
    expect(section).toContain('## 阶段 1：读取上下文')
    expect(section).not.toContain('name: demo-flow')
  })

  it('包含 MCP 真实工具名，而不是只写 server 名', () => {
    expect(section).toContain('mcp__tfs__get_workitem')
    expect(section).toContain('每个 server 至少实际调用一次')
  })

  it('工作流逐步清单 + 禁止跳步纪律 + 可机验的勾选格式', () => {
    expect(section).toContain('【强制工作流：demo-flow】')
    expect(section).toContain('1. 阶段 1：读取上下文')
    expect(section).toContain('2. 阶段 2：编码')
    expect(section).toContain('禁止跳过、合并、乱序执行任何步骤')
    expect(section).toContain('✅ 步骤 i/2')
    expect(section).toContain('⏭ 步骤 i/2')
  })

  it('无任何要求时返回空串（不改变旧行为）', () => {
    expect(buildCapabilityPlanSection({ skills: [], mcp: [] })).toBe('')
  })

  it('技能正文缺失（读不到）时仍下发名字与调用纪律', () => {
    const s = buildCapabilityPlanSection({ skills: [{ name: 'x', content: '' }], mcp: [] })
    expect(s).toContain('`x`')
    expect(s).toContain('必须加载并遵循的技能')
  })

  it('工作流解析不到步骤时给出"整篇即流程"的纪律（仍禁止跳步）', () => {
    const s = buildCapabilityPlanSection({
      skills: [{ name: 'w', content: '做 A 再做 B' }],
      mcp: [],
      workflow: 'w',
      workflowSteps: [],
    })
    expect(s).toContain('严格按技能 `w` 正文描述的流程执行')
    expect(s).toContain('禁止跳步')
  })
})

describe('verifyCapabilityUsage', () => {
  const base = { skills: ['demo-flow'], mcp: ['tfs'], workflowSteps: ['A', 'B'] }

  it('技能加载（入参命中）+ MCP 调用 + 步骤逐条报告 ⇒ 通过', () => {
    const v = verifyCapabilityUsage({
      ...base,
      toolCalls: [
        { name: 'skill', args: JSON.stringify({ name: 'demo-flow' }) },
        { name: 'mcp__tfs__get_workitem', args: '{}' },
      ],
      output: '✅ 步骤 1/2：A\n✅ 步骤 2/2：B',
    })
    expect(v.ok).toBe(true)
    expect(v.note).toBeUndefined()
  })

  it('技能工具确实存在（工具表里有）却一次没加载 ⇒ 不通过，note 点名技能', () => {
    const v = verifyCapabilityUsage({
      ...base,
      toolCalls: [{ name: 'mcp__tfs__get_workitem', args: '{}' }],
      toolSurface: ['skill', 'mcp__tfs__get_workitem'],
      output: '✅ 步骤 1/2：A\n✅ 步骤 2/2：B',
    })
    expect(v.ok).toBe(false)
    expect(v.missingSkills).toEqual(['demo-flow'])
    expect(v.note).toContain('未加载所选技能：demo-flow')
  })

  it('技能工具不在工具表里 ⇒ 正文随 prompt 交付，不判未加载（2026-11-03 问题 4）', () => {
    const v = verifyCapabilityUsage({
      ...base,
      toolCalls: [{ name: 'mcp__tfs__get_workitem', args: '{}' }],
      toolSurface: ['bash', 'read', 'mcp__tfs__get_workitem'],
      output: '✅ 步骤 1/2：A\n✅ 步骤 2/2：B',
    })
    expect(v.missingSkills).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('工具表不可读且从未出现技能调用 ⇒ 无法证明工具存在，不判未加载', () => {
    const v = verifyCapabilityUsage({
      ...base,
      toolCalls: [{ name: 'mcp__tfs__get_workitem', args: '{}' }],
      output: '✅ 步骤 1/2：A\n✅ 步骤 2/2：B',
    })
    expect(v.missingSkills).toEqual([])
    expect(v.ok).toBe(true)
  })

  it('工具表不可读但出现过技能调用（证明工具存在）⇒ 未命中名字仍判未加载', () => {
    const v = verifyCapabilityUsage({
      ...base,
      toolCalls: [
        { name: 'skill', args: JSON.stringify({ name: 'other-skill' }) },
        { name: 'mcp__tfs__get_workitem', args: '{}' },
      ],
      output: '✅ 步骤 1/2：A\n✅ 步骤 2/2：B',
    })
    expect(v.missingSkills).toEqual(['demo-flow'])
    expect(v.ok).toBe(false)
  })

  it('所选 MCP 一次没调用 ⇒ 不通过（其它 MCP 调了也不算）', () => {
    const v = verifyCapabilityUsage({
      ...base,
      toolCalls: [
        { name: 'skill', args: JSON.stringify({ name: 'demo-flow' }) },
        { name: 'mcp__other__x', args: '{}' },
      ],
      output: '✅ 步骤 1/2：A\n✅ 步骤 2/2：B',
    })
    expect(v.ok).toBe(false)
    expect(v.missingMcp).toEqual(['tfs'])
  })

  it('步骤漏报 ⇒ 不通过并列出缺失步骤', () => {
    const v = verifyCapabilityUsage({
      ...base,
      toolCalls: [
        { name: 'skill', args: JSON.stringify({ name: 'demo-flow' }) },
        { name: 'mcp__tfs__get_workitem', args: '{}' },
      ],
      output: '✅ 步骤 1/2：A',
    })
    expect(v.ok).toBe(false)
    expect(v.missingSteps).toEqual([2])
    expect(v.note).toContain('工作流未逐步执行')
  })

  it('技能工具入参解析不出名字时按"调用过即算"（避免误杀）', () => {
    const v = verifyCapabilityUsage({
      skills: ['demo-flow'],
      mcp: [],
      toolCalls: [{ name: 'skill', args: 'not-json' }],
      output: '',
    })
    expect(v.ok).toBe(true)
  })

  it('事件不可读（toolCalls=undefined）⇒ 跳过技能/MCP 校验，但步骤仍校验', () => {
    const v = verifyCapabilityUsage({ ...base, output: '' })
    expect(v.missingSkills).toEqual([])
    expect(v.missingMcp).toEqual([])
    expect(v.missingSteps).toEqual([1, 2])
    expect(v.ok).toBe(false)
  })

  it('没有任何要求 ⇒ 恒通过（旧行为不变）', () => {
    expect(verifyCapabilityUsage({ skills: [], mcp: [], output: '' }).ok).toBe(true)
  })

  it('输出自述「MCP 工具未注入」⇒ 归因为环境缺失（不是"拒绝调用"）', () => {
    const v = verifyCapabilityUsage({
      skills: [],
      mcp: ['tfs-mcp'],
      toolCalls: [],
      output: 'MCP 工具（tfs-mcp）未注入本会话的工具列表，无法直接以工具调用。',
    })
    expect(v.ok).toBe(false)
    expect(v.mcpNotInjected).toBe(true)
    expect(v.note).toContain('环境缺失')
  })

  it('输出含 <read> 形态的伪工具调用 ⇒ 标记 pseudoToolCalls 并写进诊断', () => {
    const v = verifyCapabilityUsage({
      skills: [],
      mcp: [],
      workflowSteps: ['A'],
      toolCalls: [],
      output: '<read>\n<file_path>D:\\x.cs</file_path>\n</read>',
    })
    expect(v.pseudoToolCalls).toBe(true)
    expect(v.note).toContain('并未真正调用工具')
    expect(v.missingSteps).toEqual([1])
  })

  it('声称未注入但工具表里确有 ⇒ mcpClaimedMissing（谎报），不算环境缺失', () => {
    const v = verifyCapabilityUsage({
      skills: [],
      mcp: ['tfs-mcp'],
      toolCalls: [],
      toolSurface: ['bash', 'read', 'mcp__tfs-mcp__tfs_add_tags'],
      output: 'MCP 工具（tfs-mcp）未注入本会话的工具列表，无法直接以工具调用。',
    })
    expect(v.ok).toBe(false)
    expect(v.mcpClaimedMissing).toBe(true)
    expect(v.mcpNotInjected).toBeUndefined()
    expect(v.note).toContain('谎称')
  })

  it('声称未注入且工具表确实没有 ⇒ mcpNotInjected（环境缺失）', () => {
    const v = verifyCapabilityUsage({
      skills: [],
      mcp: ['tfs-mcp'],
      toolCalls: [],
      toolSurface: ['bash', 'read', 'skill'],
      output: 'MCP 工具（tfs-mcp）未注入本会话的工具列表。',
    })
    expect(v.mcpNotInjected).toBe(true)
    expect(v.mcpClaimedMissing).toBeUndefined()
    expect(v.note).toContain('环境缺失')
  })

  it('工具表不可读（toolSurface=undefined）⇒ 只能按自述归因', () => {
    const v = verifyCapabilityUsage({
      skills: [],
      mcp: ['tfs-mcp'],
      toolCalls: [],
      output: 'MCP 工具未注入本会话。',
    })
    expect(v.mcpNotInjected).toBe(true)
    expect(v.mcpClaimedMissing).toBeUndefined()
  })
  it('正常 markdown 里的尖括号不会误判为伪工具调用', () => {
    const v = verifyCapabilityUsage({
      skills: [],
      mcp: [],
      workflowSteps: [],
      toolCalls: [],
      output: '比较 a < b 与泛型 List<T> 的写法即可。',
    })
    expect(v.pseudoToolCalls).toBeFalsy()
  })
})

/**
 * role-match 纯逻辑单测（spec 008 / US1~US3，五段式扩展）。
 *
 * 不 import node:* / persistence，直接断言关键词匹配、通用兜底与内置角色/模板一致性。
 */
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_ROLES,
  DECOMPOSE_STAGES,
  GENERAL_ROLE_NAME,
  ROLE_ANALYST,
  ROLE_ARCHITECT,
  ROLE_CODER,
  ROLE_GENERAL,
  ROLE_QA,
  ROLE_REVIEWER,
  STAGE_KEYWORDS,
  STAGE_ROLE_TEMPLATES,
  matchGeneralistRole,
  matchRoleForStage,
} from '../src/orchestration/role-match.js'
import type { RoleDefinition } from '../src/shared/contracts.js'

function role(name: string, extra: Partial<RoleDefinition> = {}): RoleDefinition {
  return { id: `r-${name}`, name, provider: 'spawn', ...extra }
}

/** 乱序内置角色，验证匹配不依赖调用方传入顺序（但平分时靠前优先）。 */
function shuffledBuiltins(): RoleDefinition[] {
  return [ROLE_QA, ROLE_REVIEWER, ROLE_GENERAL, ROLE_CODER, ROLE_ANALYST, ROLE_ARCHITECT]
}

describe('内置角色与五段式单一事实源', () => {
  it('内置角色顺序为：需求分析师/架构师/开发/代码审核/测试/通用兜底', () => {
    expect(BUILTIN_ROLES.map(r => r.name)).toEqual([
      '需求分析师',
      '架构师',
      '开发工程师',
      '代码审核工程师',
      '测试工程师',
      GENERAL_ROLE_NAME,
    ])
    expect(BUILTIN_ROLES.every(r => r.id.startsWith('role-'))).toBe(true)
    // id 唯一。
    expect(new Set(BUILTIN_ROLES.map(r => r.id)).size).toBe(BUILTIN_ROLES.length)
  })

  it('五个阶段顺序固定（分析→架构师拆解→开发→代码审核→测试），模板逐阶段对齐', () => {
    expect([...DECOMPOSE_STAGES]).toEqual(['analyze', 'plan', 'impl', 'review', 'verify'])
    expect(STAGE_ROLE_TEMPLATES.analyze).toBe(ROLE_ANALYST)
    expect(STAGE_ROLE_TEMPLATES.plan).toBe(ROLE_ARCHITECT)
    expect(STAGE_ROLE_TEMPLATES.impl).toBe(ROLE_CODER)
    expect(STAGE_ROLE_TEMPLATES.review).toBe(ROLE_REVIEWER)
    expect(STAGE_ROLE_TEMPLATES.verify).toBe(ROLE_QA)
    // 每个阶段都有关键词，且 impl 不收裸「工程师」（防串台纪律）。
    for (const stage of DECOMPOSE_STAGES) expect(STAGE_KEYWORDS[stage].length).toBeGreaterThan(0)
    expect(STAGE_KEYWORDS.impl).not.toContain('工程师')
  })
})

describe('matchRoleForStage（阶段专门匹配）', () => {
  it('内置角色按五段式语义匹配（与传入顺序无关）', () => {
    const roles = shuffledBuiltins()
    expect(matchRoleForStage('analyze', roles)).toBe(ROLE_ANALYST)
    expect(matchRoleForStage('plan', roles)).toBe(ROLE_ARCHITECT)
    expect(matchRoleForStage('impl', roles)).toBe(ROLE_CODER)
    expect(matchRoleForStage('review', roles)).toBe(ROLE_REVIEWER)
    expect(matchRoleForStage('verify', roles)).toBe(ROLE_QA)
  })

  it('用户自建同义角色按名称关键词命中对应阶段', () => {
    const roles = [
      role('需求分析师'),
      role('技术架构师'),
      role('前端开发工程师'),
      role('代码评审工程师'),
      role('自动化测试工程师'),
    ]
    expect(matchRoleForStage('analyze', roles)?.name).toBe('需求分析师')
    expect(matchRoleForStage('plan', roles)?.name).toBe('技术架构师')
    expect(matchRoleForStage('impl', roles)?.name).toBe('前端开发工程师')
    expect(matchRoleForStage('review', roles)?.name).toBe('代码评审工程师')
    expect(matchRoleForStage('verify', roles)?.name).toBe('自动化测试工程师')
  })

  it('英文名称大小写不敏感', () => {
    const roles = [
      role('Business Analyst'),
      role('Solution Architect'),
      role('Backend Developer'),
      role('Code Reviewer'),
      role('QA Engineer'),
    ]
    expect(matchRoleForStage('analyze', roles)?.name).toBe('Business Analyst')
    expect(matchRoleForStage('plan', roles)?.name).toBe('Solution Architect')
    expect(matchRoleForStage('impl', roles)?.name).toBe('Backend Developer')
    expect(matchRoleForStage('review', roles)?.name).toBe('Code Reviewer')
    expect(matchRoleForStage('verify', roles)?.name).toBe('QA Engineer')
  })

  it('无同义角色时返回 undefined（交由通用兜底/自动创建，不硬塞）', () => {
    const roles = [role('DBA'), role('产品经理'), role('运维工程师')]
    for (const stage of DECOMPOSE_STAGES) {
      expect(matchRoleForStage(stage, roles)).toBeUndefined()
    }
  })

  it('防串台：测试/审核角色不被 impl 抢走，架构师不被 analyze 抢走，分析师不被 plan 抢走', () => {
    const roles = [role('测试工程师'), role('代码审核工程师'), role('架构师'), role('需求分析师')]
    // impl 关键词不含裸「工程师」⇒ 测试工程师 / 代码审核工程师都不命中 impl。
    expect(matchRoleForStage('impl', roles)).toBeUndefined()
    // 审核与测试关键词互不交叠。
    expect(matchRoleForStage('review', [role('测试工程师')])).toBeUndefined()
    expect(matchRoleForStage('verify', [role('代码审核工程师')])).toBeUndefined()
    // analyze 与 plan 拆分：架构师归 plan、不归 analyze；需求分析师归 analyze、不归 plan。
    expect(matchRoleForStage('analyze', [role('架构师')])).toBeUndefined()
    expect(matchRoleForStage('plan', [role('需求分析师')])).toBeUndefined()
  })

  it('平分时取列表靠前角色（稳定、可解释）', () => {
    const a = role('研发一组开发')
    const b = role('研发二组开发')
    expect(matchRoleForStage('impl', [a, b])).toBe(a)
    expect(matchRoleForStage('impl', [b, a])).toBe(b)
  })
})

describe('matchGeneralistRole（通用兜底，US2）', () => {
  it('通用/全栈/generalist 等名称命中，大小写不敏感', () => {
    const roles = [role('张三'), role('全栈工程师'), role('李四')]
    expect(matchGeneralistRole(roles)?.name).toBe('全栈工程师')
    expect(matchGeneralistRole([role('Generalist Engineer')])?.name).toBe('Generalist Engineer')
  })

  it('内置「通用工程师」自身命中', () => {
    expect(matchGeneralistRole([ROLE_QA, ROLE_GENERAL])).toBe(ROLE_GENERAL)
  })

  it('无通用型角色时返回 undefined', () => {
    expect(matchGeneralistRole([role('张三'), role('李四')])).toBeUndefined()
  })

  it('通用角色不参与阶段专门匹配（不会被误当成某阶段专家）', () => {
    for (const stage of DECOMPOSE_STAGES) {
      expect(matchRoleForStage(stage, [ROLE_GENERAL])).toBeUndefined()
    }
  })
})

describe('描述不参与匹配（防误派，US1）', () => {
  it('仅描述里出现阶段关键词不算命中——以名称为准', () => {
    const tricky = role('DBA', { description: '负责测试环境数据库，并做代码评审与架构设计' })
    for (const stage of DECOMPOSE_STAGES) {
      expect(matchRoleForStage(stage, [tricky])).toBeUndefined()
    }
    // 描述里的"全栈"同样不触发通用兜底。
    expect(matchGeneralistRole([tricky])).toBeUndefined()
  })
})

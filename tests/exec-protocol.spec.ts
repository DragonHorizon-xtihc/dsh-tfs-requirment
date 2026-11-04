import { describe, expect, it } from 'vitest'
import {
  TASK_DONE_MARKER,
  NEEDS_HUMAN_CONFIRM_MARKER,
  ARTIFACTS_HEADER,
  detectOutcome,
  assessOutcome,
  hasDeliveredArtifacts,
  hasExplicitConfirmMarker,
  findConfirmPhrase,
  extractHumanConfirmReason,
  parseArtifactPaths,
  buildExecBudgetSection,
} from '../src/shared/exec-protocol.js'

/**
 * 任务执行协议纯逻辑单测（问题 1 / 问题 4 / 问题 5）。
 *
 * 这是"子 agent 正常结束却被当成功、直接进入下一任务"事故的回归锁：
 * 收口必须同时看 stopReason 与输出文本（detectOutcome 三态），并能解析
 * 人工确认原因与关键产物路径。全程纯函数，无宿主依赖。
 */
describe('detectOutcome（问题 5：收口三态）', () => {
  it('stopReason 非 completed（含 undefined）→ failed', () => {
    expect(detectOutcome('error', '')).toBe('failed')
    expect(detectOutcome('max_tokens', '做了一半')).toBe('failed')
    expect(detectOutcome(undefined, '')).toBe('failed')
  })

  it('completed + TASK_DONE 且无人工确认语义 → success', () => {
    expect(detectOutcome('completed', `全部完成\n${TASK_DONE_MARKER}`)).toBe('success')
  })

  it('completed 但无任何输出 → success（不因空文本误判待确认）', () => {
    expect(detectOutcome('completed', '')).toBe('success')
    expect(detectOutcome('completed', undefined)).toBe('success')
  })

  it('completed + 显式 NEEDS_HUMAN_CONFIRM 标记 → needs_confirmation（核心修复）', () => {
    const out = `方案已给出，但有两处口径需要拍板：\n${NEEDS_HUMAN_CONFIRM_MARKER}: 是否允许下线旧接口？`
    expect(detectOutcome('completed', out)).toBe('needs_confirmation')
    // 中文冒号也要识别。
    expect(detectOutcome('completed', `${NEEDS_HUMAN_CONFIRM_MARKER}：请确认报价`)).toBe('needs_confirmation')
  })

  it('completed + 兜底"请人工确认"短语（模型没按标记协议）→ needs_confirmation', () => {
    expect(detectOutcome('completed', '改动已就绪，请人工确认后再继续。')).toBe('needs_confirmation')
    expect(detectOutcome('completed', '该方案需要人工验收。')).toBe('needs_confirmation')
    expect(detectOutcome('completed', '等待人工审核结果')).toBe('needs_confirmation')
  })

  it('否定语境（无需/不需要/不用/不必 人工确认）→ 不误判为待确认', () => {
    expect(detectOutcome('completed', '该步骤无需人工确认，已自动处理完成。' + TASK_DONE_MARKER)).toBe('success')
    expect(detectOutcome('completed', '不需要人工确认，流程已闭环。')).toBe('success')
    expect(detectOutcome('completed', '此变更不用人工审核。')).toBe('success')
    expect(detectOutcome('completed', '无须人工介入。')).toBe('success')
    expect(detectOutcome('completed', '不必人工验收。')).toBe('success')
  })

  it('正文远处举例"请人工确认"但结论窗口已 TASK_DONE → 仍以显式标记为准（显式标记优先）', () => {
    // 显式标记出现在文中任意位置都判待确认（最高可信度）。
    const out = '前面讨论了"什么情况下需要人工确认"的判断标准。\n' + `${NEEDS_HUMAN_CONFIRM_MARKER}: 口径待拍板`
    expect(hasExplicitConfirmMarker(out)).toBe(true)
    expect(detectOutcome('completed', out)).toBe('needs_confirmation')
  })
})

describe('findConfirmPhrase / hasExplicitConfirmMarker', () => {
  it('显式标记识别', () => {
    expect(hasExplicitConfirmMarker(`${NEEDS_HUMAN_CONFIRM_MARKER}: x`)).toBe(true)
    expect(hasExplicitConfirmMarker('plain')).toBe(false)
    expect(hasExplicitConfirmMarker('')).toBe(false)
  })

  it('兜底短语命中且排除否定语境', () => {
    expect(findConfirmPhrase('请人工确认')?.text).toContain('人工')
    // 否定语境：命中位置前 8 字内有"无需"。
    expect(findConfirmPhrase('无需人工确认')).toBeUndefined()
  })
})

describe('extractHumanConfirmReason（待确认原因，用于 UI/备注）', () => {
  it('优先取显式标记冒号后原因', () => {
    expect(extractHumanConfirmReason(`前文\n${NEEDS_HUMAN_CONFIRM_MARKER}: 是否删除历史数据？`)).toBe('是否删除历史数据？')
  })

  it('显式标记冒号后换行 → 跨空白取首个原因行', () => {
    const out = `${NEEDS_HUMAN_CONFIRM_MARKER}:\n  - 口径 A\n其他`
    const r = extractHumanConfirmReason(out)
    expect(r).toContain('口径 A')
  })

  it('无显式标记 → 取兜底短语所在整行', () => {
    expect(extractHumanConfirmReason('一些过程说明\n最终：请人工确认报价口径。')).toBe('最终：请人工确认报价口径。')
  })

  it('完全没有可抽取内容 → 给默认文案', () => {
    expect(extractHumanConfirmReason('')).toMatch(/未给出具体原因/)
    expect(extractHumanConfirmReason(undefined)).toMatch(/未给出具体原因/)
  })

  it('原因超长 → 截断并加省略号', () => {
    const long = '确'.repeat(500)
    const r = extractHumanConfirmReason(`${NEEDS_HUMAN_CONFIRM_MARKER}: ${long}`, 300)
    expect(r.length).toBeLessThanOrEqual(303)
    expect(r.endsWith('…')).toBe(true)
  })
})

describe('parseArtifactPaths（问题 4：关键产物绝对路径）', () => {
  it('解析 Windows / POSIX 绝对路径，去列表符与反引号', () => {
    const out = ['结论如下。', `${ARTIFACTS_HEADER}`, '- D:\\\\reports\\\\方案.md', '* `/abs/path/patch.diff`', ''].join('\n')
    const paths = parseArtifactPaths(out)
    expect(paths).toContain('D:\\\\reports\\\\方案.md')
    expect(paths).toContain('/abs/path/patch.diff')
  })

  it('忽略相对路径与裸文件名', () => {
    const out = [`${ARTIFACTS_HEADER}`, '- reports/方案.md', '- 方案.md', '- ./rel/x.txt'].join('\n')
    expect(parseArtifactPaths(out)).toEqual([])
  })

  it('去重保序', () => {
    const out = [`${ARTIFACTS_HEADER}`, '- /a/x.md', '- /a/x.md', '- /b/y.md'].join('\n')
    expect(parseArtifactPaths(out)).toEqual(['/a/x.md', '/b/y.md'])
  })

  it('遇到下一个全大写段头（如 TASK_DONE）结束解析', () => {
    const out = [`${ARTIFACTS_HEADER}`, '- /a/x.md', TASK_DONE_MARKER, '- /b/y.md'].join('\n')
    const paths = parseArtifactPaths(out)
    expect(paths).toEqual(['/a/x.md'])
  })

  it('空行结束段落', () => {
    const out = [`${ARTIFACTS_HEADER}`, '- /a/x.md', '', '- /b/y.md'].join('\n')
    expect(parseArtifactPaths(out)).toEqual(['/a/x.md'])
  })

  it('无 ARTIFACTS 段 → 空数组（不猜测文件）', () => {
    expect(parseArtifactPaths('普通输出，无产物。')).toEqual([])
    expect(parseArtifactPaths('')).toEqual([])
  })

  it('剥掉路径尾部标点', () => {
    const out = [`${ARTIFACTS_HEADER}`, '- /a/x.md。'].join('\n')
    expect(parseArtifactPaths(out)).toEqual(['/a/x.md'])
  })
})

describe('buildExecBudgetSection（问题 1：执行预算与终止纪律）', () => {
  it('始终包含完成 / 人工确认 / 产物协议标记', () => {
    const s = buildExecBudgetSection()
    expect(s).toContain(TASK_DONE_MARKER)
    expect(s).toContain(NEEDS_HUMAN_CONFIRM_MARKER)
    expect(s).toContain(ARTIFACTS_HEADER)
    expect(s).toContain('禁止重复请求')
  })

  it('maxDepth≥1 → 明确告知最多委派层数', () => {
    expect(buildExecBudgetSection({ maxDepth: 2 })).toContain('最多只能向下委派 2 层')
  })

  it('maxDepth=0/undefined → 弱化为"委派克制"，不出现具体层数', () => {
    const s = buildExecBudgetSection()
    expect(s).toContain('委派克制')
    expect(s).not.toContain('最多只能向下委派')
    expect(buildExecBudgetSection({ maxDepth: 0 })).toContain('委派克制')
  })
})

/**
 * 2026-11-04 回归：真机上「所有子 Agent 完成后都被标记失败」的根因。
 *
 * 子 agent 交付完整报告 + ARTIFACTS 后，仍按协议第 6 条输出 NEEDS_HUMAN_CONFIRM
 * 描述**非阻塞遗留项**（真机桌面端补测 / TFS 写门禁），旧判据见标记就判
 * needs_confirmation → 自动扫尾反复续跑 → 主 agent 兜底无产出时收口成 failed。
 * 修复：有交付证据时按 success 收口，遗留项写进 deferredNote。
 */
describe('2026-11-04：已交付 + 遗留项 ≠ 待确认', () => {
  const delivered = [
    '## ① 做了什么',
    '改造完成，验证报告已生成。',
    ARTIFACTS_HEADER,
    '- D:\\\\reports\\\\verification.md',
    '',
    `${NEEDS_HUMAN_CONFIRM_MARKER}: 请在真实 WiNEX 桌面端补测开关对照。`,
  ].join('\n')

  it('ARTIFACTS 绝对路径 + 显式确认标记 ⇒ success + deferredNote（核心修复）', () => {
    const a = assessOutcome('completed', delivered)
    expect(a.outcome).toBe('success')
    expect(a.deferredNote).toContain('遗留项')
    expect(a.deferredNote).toContain('WiNEX')
    expect(detectOutcome('completed', delivered)).toBe('success')
  })

  it('TASK_DONE 独占一行 + 确认标记 ⇒ 仍按 success（完成标记是更强信号）', () => {
    const out = `报告已完成。\n${NEEDS_HUMAN_CONFIRM_MARKER}: 请补测\n${TASK_DONE_MARKER}`
    expect(detectOutcome('completed', out)).toBe('success')
  })

  it('只请求确认、没有任何交付证据 ⇒ 仍是 needs_confirmation（保留协议本意）', () => {
    const out = `方案未定。\n${NEEDS_HUMAN_CONFIRM_MARKER}: 请选择接口口径`
    const a = assessOutcome('completed', out)
    expect(a.outcome).toBe('needs_confirmation')
    expect(a.deferredNote).toBeUndefined()
  })

  it('兜底短语 + ARTIFACTS ⇒ success（模型没按标记协议也一样）', () => {
    const out = `改动已就绪，请人工确认。\n${ARTIFACTS_HEADER}\n- /abs/out.patch`
    expect(detectOutcome('completed', out)).toBe('success')
  })

  it('stopReason 非 completed ⇒ failed，交付证据也不救', () => {
    expect(assessOutcome('error', delivered).outcome).toBe('failed')
    expect(assessOutcome(undefined, delivered).outcome).toBe('failed')
  })

  it('hasDeliveredArtifacts：正文提到 TASK_DONE / 相对路径都不算', () => {
    expect(hasDeliveredArtifacts('正文提到 TASK_DONE 这个标记')).toBe(false)
    expect(hasDeliveredArtifacts(`${ARTIFACTS_HEADER}\n- reports/方案.md`)).toBe(false)
    expect(hasDeliveredArtifacts(`${ARTIFACTS_HEADER}\n- D:/out.md`)).toBe(true)
    expect(hasDeliveredArtifacts(`完结\n${TASK_DONE_MARKER}`)).toBe(true)
    expect(hasDeliveredArtifacts(undefined)).toBe(false)
  })
})

describe('2026-11-04：执行纪律区分非阻塞遗留项与真正卡住', () => {
  it('协议明确"遗留事项仍按已完成收口"', () => {
    const s = buildExecBudgetSection()
    expect(s).toContain('遗留事项')
    expect(s).toContain('仍按已完成收口')
    expect(s).toContain(TASK_DONE_MARKER)
    expect(s).toContain(NEEDS_HUMAN_CONFIRM_MARKER)
  })
})

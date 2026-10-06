import { describe, expect, it } from 'vitest'
import {
  buildTargetFill,
  claimedKeysOf,
  requirementKey,
  shouldCacheQueryOptions,
  shouldFillTarget,
  summaryKey,
  EMPTY_DESCRIPTION_HINT,
  TARGET_TEXT_LIMIT,
} from '../src/shared/pool.js'
import type { RequirementQueryOptions, RequirementSummary } from '../src/shared/contracts.js'

/**
 * 需求池共享纯逻辑单测（T010 / T012a / T018）。
 *
 * ## 为什么这些断言必须存在
 *
 * 客户端半**没有 React 测试库**（`tests/` 下其余用例全为 `.ts`），写在 `RequirementPool.tsx` /
 * `ExecutionPanel.tsx` 里的判定等于不可测。三条修复的可测部分各自落在：
 *   - `shouldCacheQueryOptions` → US1「什么时候的结果值得缓存」；
 *   - `requirementKey` / `claimedKeysOf` → US2「已入池」判定的数据正确性；
 *   - `buildTargetFill` → US3「选为目标带出内容」的填充规则。
 */

/** 造一个最小可用的需求摘要（其余字段与被测逻辑无关）。 */
function sum(id: number, collection = 'WN_HIS', extra: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id,
    collection,
    project: 'EDIS',
    title: `需求 ${id}`,
    type: '任务',
    state: '活动',
    assignedTo: '',
    priority: '2',
    areaPath: 'EDIS',
    iterationPath: 'EDIS',
    changedDate: '2026-09-19T00:00:00Z',
    url: '',
    tags: [],
    ...extra,
  }
}

function opts(p: Partial<RequirementQueryOptions>): RequirementQueryOptions {
  return {
    projects: [],
    types: [],
    states: [],
    assignees: [],
    ...p,
  }
}

// ───────────────────────── T010 / US1：缓存判据 ─────────────────────────

describe('shouldCacheQueryOptions（US1 / FR-005）', () => {
  it('项目清单非空 → 可缓存', () => {
    expect(shouldCacheQueryOptions(opts({ projects: [{ value: 'EAHis', label: 'EAHis' }] }))).toBe(true)
  })

  it('类型清单非空 → 可缓存（项目采集失败也不阻止复用已成功的类型）', () => {
    expect(shouldCacheQueryOptions(opts({ types: [{ value: '任务', label: '任务' }] }))).toBe(true)
  })

  it('四项全空 → **不**缓存（一次抖动不该把空下拉锁死到服务重启）', () => {
    expect(shouldCacheQueryOptions(opts({}))).toBe(false)
  })

  it('只有状态/指派人非空 → 不缓存（下拉主体是项目与类型）', () => {
    expect(
      shouldCacheQueryOptions(
        opts({ states: [{ value: '活动', label: '活动' }], assignees: [{ value: 'xbp', label: 'xbp' }] }),
      ),
    ).toBe(false)
  })

  it('null / undefined → 不缓存（不把"没采到"当成有效结果）', () => {
    expect(shouldCacheQueryOptions(null)).toBe(false)
    expect(shouldCacheQueryOptions(undefined)).toBe(false)
  })
})

// ───────────────────────── T012a / US2：去重键 ─────────────────────────

describe('requirementKey / summaryKey（US2）', () => {
  it('键格式 `id@collection`', () => {
    expect(requirementKey(12, 'WN_HIS')).toBe('12@WN_HIS')
  })

  it('数字 id 与字符串 id 产出同键（列表里 id 可能来自 URL 参数）', () => {
    expect(requirementKey('12', 'WN_HIS')).toBe(requirementKey(12, 'WN_HIS'))
  })

  it('summaryKey 与 requirementKey 一致（两处必须同构，否则已入池判定对不上）', () => {
    const r = sum(7, 'OTHER')
    expect(summaryKey(r)).toBe(requirementKey(r.id, r.collection))
  })

  it('集合不同则键不同（同名 id 在不同集合是两个需求）', () => {
    expect(requirementKey(1, 'A')).not.toBe(requirementKey(1, 'B'))
  })
})

describe('claimedKeysOf（US2）', () => {
  it('空输入 / undefined → 空数组（不抛错）', () => {
    expect(claimedKeysOf([])).toEqual([])
    expect(claimedKeysOf(undefined as unknown as RequirementSummary[])).toEqual([])
  })

  it('逐项取键，顺序稳定 = 输入顺序', () => {
    expect(claimedKeysOf([sum(3), sum(1), sum(2)])).toEqual(['3@WN_HIS', '1@WN_HIS', '2@WN_HIS'])
  })

  it('同键去重（幂等：重复领取不该产生重复标记）', () => {
    expect(claimedKeysOf([sum(3), sum(3), sum(3)])).toEqual(['3@WN_HIS'])
  })

  it('幂等：对自身结果再跑一次不变', () => {
    const once = claimedKeysOf([sum(3), sum(1), sum(3)])
    const twice = claimedKeysOf(once.map(k => ({ id: Number(k.split('@')[0]), collection: 'WN_HIS' })))
    expect(twice).toEqual(['3@WN_HIS', '1@WN_HIS'])
  })
})

// ───────────────────────── T018 / US3：目标填充 ─────────────────────────

describe('buildTargetFill（US3 / FR-009）', () => {
  it('未选目标 → undefined（表单保持空白，不报错、不乱填）', () => {
    expect(buildTargetFill(undefined)).toBeUndefined()
    expect(buildTargetFill(null)).toBeUndefined()
  })

  it('标题 + 正文 → 三个字段都带上（零复制粘贴；问题 11：正文带【详细信息】段头）', () => {
    const fill = buildTargetFill(sum(5, 'WN_HIS', { title: '急诊分诊改造', description: '正文内容' }))
    expect(fill!.title).toBe('急诊分诊改造')
    expect(fill!.description).toBe('【详细信息】\n正文内容')
    expect(fill!.execPrompt).toContain('急诊分诊改造')
    expect(fill!.execPrompt).toContain('【详细信息】')
    expect(fill!.execPrompt).toContain('正文内容')
  })

  it('问题 11：四段正文（详细信息/需求分析/数据结构/需求配置）按固定顺序全部带入', () => {
    const fill = buildTargetFill(
      sum(5, 'WN_HIS', {
        title: '四段齐全',
        description: '描述段',
        analysis: '分析段',
        dataStructure: '结构段',
        config: '配置段',
      }),
    )
    expect(fill!.description).toBe(
      '【详细信息】\n描述段\n\n【需求分析】\n分析段\n\n【数据结构】\n结构段\n\n【需求配置】\n配置段',
    )
    // 顺序锁死：详细信息 → 需求分析 → 数据结构 → 需求配置。
    const d = fill!.description
    expect(d.indexOf('【详细信息】')).toBeLessThan(d.indexOf('【需求分析】'))
    expect(d.indexOf('【需求分析】')).toBeLessThan(d.indexOf('【数据结构】'))
    expect(d.indexOf('【数据结构】')).toBeLessThan(d.indexOf('【需求配置】'))
  })

  it('问题 11：空白段跳过，只输出非空段（不为缺失段留空标题）', () => {
    const fill = buildTargetFill(
      sum(5, 'WN_HIS', { description: '  ', analysis: '只有分析', dataStructure: '', config: undefined }),
    )
    expect(fill!.description).toBe('【需求分析】\n只有分析')
    expect(fill!.description).not.toContain('【详细信息】')
    expect(fill!.description).not.toContain('【数据结构】')
  })

  it('标题两端空白被 trim（TFS 标题带尾空格很常见）', () => {
    const fill = buildTargetFill(sum(5, 'WN_HIS', { title: '  标题  ', description: '正文' }))
    expect(fill!.title).toBe('标题')
  })

  it('正文缺失 → 描述给明确占位说明（空框会让用户以为功能坏了）', () => {
    const fill = buildTargetFill(sum(5))
    expect(fill!.description).toBe(EMPTY_DESCRIPTION_HINT)
    // Prompt 里不放占位说明：它会被原样送给模型，掺进"无正文"这种元信息是噪声。
    expect(fill!.execPrompt).not.toContain(EMPTY_DESCRIPTION_HINT)
    expect(fill!.execPrompt).toContain('需求 5')
  })

  it('正文为空串 → 同"缺失"处理', () => {
    expect(buildTargetFill(sum(5, 'WN_HIS', { description: '' }))!.description).toBe(EMPTY_DESCRIPTION_HINT)
  })

  it('超长正文截断到 TARGET_TEXT_LIMIT 并带标记（不把 MB 级内容塞进表单）', () => {
    const long = '嘀'.repeat(TARGET_TEXT_LIMIT + 5000)
    const fill = buildTargetFill(sum(5, 'WN_HIS', { description: long }))
    expect(fill!.description.length).toBeLessThan(TARGET_TEXT_LIMIT + 40)
    expect(fill!.description).toContain('已截断')
    expect(fill!.execPrompt.length).toBeLessThan(TARGET_TEXT_LIMIT + 40)
  })

  it('未超长时不加截断标记（标记只在真的丢了内容时出现）', () => {
    const fill = buildTargetFill(sum(5, 'WN_HIS', { description: '短正文' }))
    expect(fill!.description).toBe('【详细信息】\n短正文')
    expect(fill!.description).not.toContain('已截断')
  })
})

// ───────────────────────── spec 008 US4：选为目标重复填充 ─────────────────────────

describe('shouldFillTarget（spec 008 US4）', () => {
  it('首次选择（nonce 1、上次 0、有目标）→ 填充', () => {
    expect(shouldFillTarget(1, 0, true)).toBe(true)
  })

  it('同一 nonce 的重复 effect（后台轮询刷新触发）→ 不填充，保护手工编辑', () => {
    expect(shouldFillTarget(1, 1, true)).toBe(false)
  })

  it('同一需求第二次选为目标（nonce 2 vs 已处理 1）→ 必须重新填充', () => {
    // 典型路径：第一次填入 → 发起执行后表单清空 → 再点同一目标恢复正文。
    expect(shouldFillTarget(2, 1, true)).toBe(true)
    expect(shouldFillTarget(3, 2, true)).toBe(true)
  })

  it('nonce=0（面板初始挂载、尚无显式选择）→ 不填充', () => {
    expect(shouldFillTarget(0, 0, true)).toBe(false)
    expect(shouldFillTarget(0, -1, true)).toBe(false)
  })

  it('无目标 → 不填充', () => {
    expect(shouldFillTarget(1, 0, false)).toBe(false)
  })
})

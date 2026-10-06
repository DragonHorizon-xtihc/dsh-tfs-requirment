import { describe, expect, it } from 'vitest'
import {
  decodeModelValue,
  findModelOption,
  formatModelRoute,
  groupModelOptions,
  modelOptionValue,
  modelValueExists,
  parseModelOptionValue,
  providerLabel,
} from '../src/shared/model-route.js'
import type { DshModelOption } from '../src/shared/contracts.js'

/**
 * spec 009：模型下拉复合值（provider,id）编解码与分组去重单测。
 *
 * 这些纯函数是"选火山方舟却跑英伟达"缺陷的修复核心：旧 UI 的 <option> key 带 provider、
 * value 只有裸 id，供应商在点击瞬间丢失。复合值让供应商随选择一路带到 frozenConfig。
 */

function opt(provider: string, id: string, extra: Partial<DshModelOption> = {}): DshModelOption {
  return { provider, providerName: extra.providerName ?? provider, id, name: extra.name ?? id, ...extra }
}

describe('modelOptionValue / parseModelOptionValue', () => {
  it('复合值可往返解析，provider 与 id 原样保留', () => {
    const v = modelOptionValue('arkcode', 'deepseek-v4-flash')
    expect(parseModelOptionValue(v)).toEqual({ provider: 'arkcode', id: 'deepseek-v4-flash' })
  })

  it('值中不含明文分隔符（必须是 JSON，避免历史上用 / 拼接与模型 id 冲突）', () => {
    const v = modelOptionValue('p', 'a/b/c')
    expect(v.startsWith('{')).toBe(true)
    expect(parseModelOptionValue(v)?.id).toBe('a/b/c')
  })

  it('非法 JSON 返回 undefined（严格解析，供 modelValueExists 判定）', () => {
    expect(parseModelOptionValue('deepseek-v4-flash')).toBeUndefined()
    expect(parseModelOptionValue('')).toBeUndefined()
    expect(parseModelOptionValue(undefined)).toBeUndefined()
    expect(parseModelOptionValue('{bad json')).toBeUndefined()
  })

  it('字段缺失或 id 为空白返回 undefined（p/i 必须都是字符串）', () => {
    expect(parseModelOptionValue(JSON.stringify({ p: 'arkcode' }))).toBeUndefined()
    expect(parseModelOptionValue(JSON.stringify({ p: 'arkcode', i: '   ' }))).toBeUndefined()
    expect(parseModelOptionValue(JSON.stringify({ i: 'm1' }))).toBeUndefined()
  })

  it('解析结果做 trim 归一', () => {
    const v = JSON.stringify({ p: '  arkcode  ', i: '  deepseek-v4-flash  ' })
    expect(parseModelOptionValue(v)).toEqual({ provider: 'arkcode', id: 'deepseek-v4-flash' })
  })
})

describe('decodeModelValue（宽容解码，兼容历史裸值）', () => {
  it('复合值正常解析', () => {
    expect(decodeModelValue(modelOptionValue('arkcode', 'm1'))).toEqual({ provider: 'arkcode', id: 'm1' })
  })

  it('历史裸 id 回落为未绑定供应商（provider 空串 = 沿用父会话供应商的旧语义）', () => {
    expect(decodeModelValue('deepseek-v4-flash')).toEqual({ provider: '', id: 'deepseek-v4-flash' })
    expect(decodeModelValue('  glm-5-3-flash ')).toEqual({ provider: '', id: 'glm-5-3-flash' })
  })

  it('空值返回 undefined', () => {
    expect(decodeModelValue('')).toBeUndefined()
    expect(decodeModelValue('   ')).toBeUndefined()
    expect(decodeModelValue(undefined)).toBeUndefined()
    expect(decodeModelValue(null)).toBeUndefined()
  })
})

describe('groupModelOptions', () => {
  it('按 provider 分组，保留首次出现顺序', () => {
    const groups = groupModelOptions([
      opt('arkcode', 'm1'),
      opt('nvida', 'm2'),
      opt('arkcode', 'm3'),
    ])
    expect(groups.map(g => g.provider)).toEqual(['arkcode', 'nvida'])
    expect(groups[0]!.items.map(m => m.id)).toEqual(['m1', 'm3'])
    expect(groups[1]!.items.map(m => m.id)).toEqual(['m2'])
  })

  it('同一 provider 内同 id 去重（目录条目可能重复）', () => {
    const groups = groupModelOptions([opt('arkcode', 'm1'), opt('arkcode', 'm1', { name: '别名' })])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items).toHaveLength(1)
  })

  it('跨 provider 的同名模型必须保留为两个选项（缺陷根因场景）', () => {
    const groups = groupModelOptions([
      opt('arkcode', 'deepseek-v4-flash', { providerName: '火山方舟' }),
      opt('nvida', 'deepseek-v4-flash', { providerName: '英伟达' }),
    ])
    expect(groups).toHaveLength(2)
    const values = groups.flatMap(g => g.items.map(m => modelOptionValue(m.provider, m.id)))
    expect(new Set(values).size).toBe(2)
    // 两个复合值解码后 id 相同、provider 不同
    const decoded = values.map(v => parseModelOptionValue(v)!)
    expect(decoded.every(r => r.id === 'deepseek-v4-flash')).toBe(true)
    expect(decoded.map(r => r.provider).sort()).toEqual(['arkcode', 'nvida'])
  })

  it('providerName 缺失时回落到 provider 路由键', () => {
    const groups = groupModelOptions([{ provider: 'arkcode', providerName: '', id: 'm1', name: 'M1' }])
    expect(groups[0]!.providerName).toBe('arkcode')
  })

  it('空数组返回空分组', () => {
    expect(groupModelOptions([])).toEqual([])
  })
})

describe('findModelOption / modelValueExists', () => {
  const options = [opt('arkcode', 'm1'), opt('nvida', 'z-ai/m2')]

  it('findModelOption 按 provider + id 精确定位', () => {
    expect(findModelOption(options, 'arkcode', 'm1')?.provider).toBe('arkcode')
    expect(findModelOption(options, 'nvida', 'z-ai/m2')?.id).toBe('z-ai/m2')
    expect(findModelOption(options, 'arkcode', 'z-ai/m2')).toBeUndefined()
  })

  it('modelValueExists 只认复合值；裸值不算存在（交调用方做旧值兼容）', () => {
    expect(modelValueExists(options, modelOptionValue('arkcode', 'm1'))).toBe(true)
    expect(modelValueExists(options, modelOptionValue('nvida', 'm1'))).toBe(false)
    expect(modelValueExists(options, 'm1')).toBe(false)
    expect(modelValueExists(options, '')).toBe(false)
  })
})

describe('providerLabel / formatModelRoute', () => {
  const options = [
    opt('arkcode', 'deepseek-v4-flash', { providerName: '火山方舟', name: 'DeepSeek V4 Flash' }),
    opt('nvida', 'deepseek-ai/deepseek-v4-flash-0731', { providerName: '英伟达' }),
  ]

  it('providerLabel 优先展示名，缺目录时回落路由键', () => {
    expect(providerLabel(options, 'arkcode')).toBe('火山方舟')
    expect(providerLabel(options, 'siliconflow')).toBe('siliconflow')
    expect(providerLabel(options, '')).toBe('')
    expect(providerLabel(null, 'arkcode')).toBe('arkcode')
  })

  it('formatModelRoute 展示「供应商 / 模型 id」（展示统一用 id，不用 name，避免 name 歧义）', () => {
    expect(formatModelRoute(options, 'deepseek-v4-flash', 'arkcode')).toBe('火山方舟 / deepseek-v4-flash')
  })

  it('未绑定供应商时显式标注沿用会话供应商（旧数据语义可见化）', () => {
    const text = formatModelRoute(options, 'deepseek-v4-flash')
    expect(text).toContain('deepseek-v4-flash')
    expect(text).toContain('未绑定供应商')
  })

  it('供应商在目录中不存在时回落路由键，不伪造展示名', () => {
    const text = formatModelRoute(options, 'm-x', 'ghost-provider')
    expect(text).toContain('ghost-provider')
    expect(text).toContain('m-x')
  })

  it('无模型 id 返回默认占位文案', () => {
    expect(formatModelRoute(options, '')).toBe('（默认模型）')
    expect(formatModelRoute(options, '   ')).toBe('（默认模型）')
  })
})

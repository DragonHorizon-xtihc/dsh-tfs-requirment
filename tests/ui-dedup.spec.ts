import { describe, expect, it } from 'vitest'
import { dedupeOptions } from '../src/client/components/MultiSelect.js'
import { groupModelOptions, modelOptionValue } from '../src/shared/model-route.js'
import type { DshModelOption } from '../src/shared/contracts.js'

/**
 * 问题 7：角色管理「默认模型」勾选一个后同一项出现多次、且第一个删不掉。
 *
 * ## 根因（代码事实）
 *
 * - `RoleSettings` 用 `m.id` 当选项 value（`buildModelItems` 之前是内联 `.map`），
 *   而 `DshModelOption.id` **只在单个 provider 内唯一**：同一 id 被 K 个 provider 暴露时，
 *   目录里就有 K 条同 id 记录。
 * - `MultiSelect.selected = options.filter(o => set.has(o.value)).map(o => o.value)`
 *   未去重 ⇒ K 个同值 ⇒ K 个同 key 的 chip（React duplicate key）+ K 个同名下拉行，
 *   表现为"同一个模型出现六次 / 三次"，点 × 因节点错配而"删不掉"。
 *
 * ## 本文件锁死的契约
 *
 * 1. `dedupeOptions` 按 value 折叠，且**合并 hint**（provider 信息不丢）；
 * 2. spec 009 起角色默认模型改为按 provider 分组的原生 select，跨 provider 同名模型
 *    **必须保留为两个选项**（旧 `buildModelItems` 跨 provider 按 id 去重正是"供应商丢失"
 *    缺陷的第二实例，已删除）；组内去重与分组由 `groupModelOptions` 承担；
 * 3. 折叠后"每个 value 恰好一个 chip / 一行"是可推导的（唯一性断言）。
 *
 * 本机实测数据形态：`deepseek-v4-flash` 同时被火山方舟（arkcode）、deepseek-official 暴露，
 * `glm-5.3-flash` 同时出现在 `deepseek-official` 与 `wincode` 两个 provider 下。
 */

const opt = (value: string, label: string, hint?: string): { value: string; label: string; hint?: string } =>
  hint === undefined ? { value, label } : { value, label, hint }

describe('dedupeOptions（MultiSelect 的入口去重）', () => {
  it('同一 value 出现 6 次 → 折叠为 1 项（问题 7 的"出现六次"）', () => {
    const six = Array.from({ length: 6 }, () => opt('m1', '模型一', 'providerA'))
    const out = dedupeOptions(six)
    expect(out).toHaveLength(1)
    expect(out[0]).toEqual({ value: 'm1', label: '模型一', hint: 'providerA' })
  })

  it('折叠时合并不同 hint（provider 并集，信息不丢）', () => {
    const out = dedupeOptions([
      opt('m1', '模型一', 'deepseek-official'),
      opt('m1', '模型一', 'wincode'),
      opt('m1', '模型一', 'deepseek-official'),
    ])
    expect(out).toHaveLength(1)
    expect(out[0]!.hint).toBe('deepseek-official、wincode')
  })

  it('不同 value 各保留一个，顺序为首次出现顺序', () => {
    const out = dedupeOptions([opt('b', 'B'), opt('a', 'A'), opt('b', 'B'), opt('c', 'C')])
    expect(out.map(o => o.value)).toEqual(['b', 'a', 'c'])
  })

  it('label 取首次出现的（后出现的同名不同 label 不覆盖）', () => {
    const out = dedupeOptions([opt('m1', '先到的名字'), opt('m1', '后到的名字')])
    expect(out[0]!.label).toBe('先到的名字')
  })

  it('丢弃非法项（空 value / 非字符串），不产生空 key 的 chip', () => {
    const out = dedupeOptions([
      { value: '', label: '空值' },
      { value: 42 as unknown as string, label: '非字符串' },
      opt('ok', '正常'),
    ])
    expect(out.map(o => o.value)).toEqual(['ok'])
  })

  it('空输入返回空数组（不抛错）', () => {
    expect(dedupeOptions([])).toEqual([])
  })
})

describe('groupModelOptions（spec 009：按 provider 分组的模型目录）', () => {
  const model = (provider: string, providerName: string, id: string): DshModelOption => ({
    provider,
    providerName,
    id,
    name: id,
  })

  /** 把分组目录拍平成复合 option value 列表，便于断言唯一性。 */
  const flatValues = (groups: ReturnType<typeof groupModelOptions>): string[] =>
    groups.flatMap(g => g.items.map(m => modelOptionValue(m.provider, m.id)))

  it('跨 provider 同 id 必须保留为两个分组下的独立选项（spec 009 核心契约）', () => {
    const groups = groupModelOptions([
      model('arkcode', '火山方舟', 'deepseek-v4-flash'),
      model('nvida', '英伟达', 'deepseek-v4-flash'),
    ])
    expect(groups).toHaveLength(2)
    expect(groups[0]!.items).toHaveLength(1)
    expect(groups[1]!.items).toHaveLength(1)
    const values = flatValues(groups)
    expect(new Set(values).size).toBe(2)
    expect(values).toContain(modelOptionValue('arkcode', 'deepseek-v4-flash'))
    expect(values).toContain(modelOptionValue('nvida', 'deepseek-v4-flash'))
  })

  it('6 个提供方暴露同一 id → 6 个分组各保留一项，复合 value 互不相同', () => {
    const providers = ['p1', 'p2', 'p3', 'p4', 'p5', 'p6']
    const groups = groupModelOptions(providers.map(p => model(p, p, 'shared-model')))
    expect(groups).toHaveLength(6)
    const values = flatValues(groups)
    expect(new Set(values).size).toBe(6)
  })

  it('复合 value 全局唯一：混合目录下不产出任何重复 value（下拉行 / React key 均唯一）', () => {
    const groups = groupModelOptions([
      model('a', 'A', 'm1'),
      model('b', 'B', 'm1'),
      model('a', 'A', 'm2'),
      model('c', 'C', 'm2'),
      model('a', 'A', 'm3'),
    ])
    const values = flatValues(groups)
    expect(values).toEqual([...new Set(values)])
    expect(values).toHaveLength(5)
  })

  it('同一 provider 内重复 id 折叠（目录条目本身可能重复）', () => {
    const groups = groupModelOptions([
      model('a', 'A', 'm1'),
      model('a', 'A', 'm1'),
      model('a', 'A', 'm1'),
    ])
    expect(groups).toHaveLength(1)
    expect(groups[0]!.items).toHaveLength(1)
    expect(groups[0]!.providerName).toBe('A')
  })

  it('丢弃空 id；providerName 为空时分组标题回落 provider 路由键', () => {
    const groups = groupModelOptions([
      { provider: '', providerName: '', id: '', name: '空' },
      { provider: 'p', providerName: '', id: 'x', name: '' },
      { provider: '', providerName: '', id: 'y', name: 'Y' },
    ])
    // provider 为空串的条目也成组（空 id 的那条被丢弃）；providerName 回落为路由键。
    // 目录顺序：先遇到 p 组的 x，再遇到空 provider 组的 y。
    expect(groups.map(g => g.provider)).toEqual(['p', ''])
    const pGroup = groups.find(g => g.provider === 'p')!
    expect(pGroup.providerName).toBe('p')
    expect(pGroup.items.map(m => m.id)).toEqual(['x'])
    const emptyGroup = groups.find(g => g.provider === '')!
    expect(emptyGroup.items.map(m => m.id)).toEqual(['y'])
  })

  it('空输入返回空数组', () => {
    expect(groupModelOptions([])).toEqual([])
  })
})

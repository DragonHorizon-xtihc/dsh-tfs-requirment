import { describe, expect, it } from 'vitest'
import { htmlToPlainText, truncateText, MAX_DESCRIPTION_CHARS } from '../src/shared/text.js'

/**
 * HTML → 纯文本转换单测（T007）。
 *
 * ## 为什么必须有这个测试
 *
 * TFS 的 `System.Description` 是富文本编辑器产出的 **HTML**。US3「选为目标要带出需求内容」
 * 的第一道障碍就是它：直接塞进 `<textarea>`，用户看到的是 `<div>&nbsp;…</div>` 原始标记，
 * 等于没带出内容。转换逻辑是纯字符串处理，但**没有任何视觉回归手段**（项目无浏览器测试），
 * 只能靠单测锁死行为。
 *
 * ## 刻意不覆盖的部分
 *
 * 本转换器**不是**通用 HTML 解析器（无新依赖，见 `src/shared/text.ts` 模块注释），
 * 只覆盖 TFS 富文本编辑器的有限标记集。畸形嵌套、`<table>` 单元格布局等不在契约内——
 * 那些场景的产物是"可读性下降"，不是"崩溃"，且真实 TFS 正文不产出它们。
 */

describe('htmlToPlainText', () => {
  it('非字符串输入 → 空串（不抛错，适配层字段缺失时是 undefined）', () => {
    expect(htmlToPlainText('' as string)).toBe('')
    expect(htmlToPlainText(undefined as unknown as string)).toBe('')
    expect(htmlToPlainText(null as unknown as string)).toBe('')
    expect(htmlToPlainText(123 as unknown as string)).toBe('')
  })

  it('纯文本（无标记）原样返回', () => {
    expect(htmlToPlainText('急诊产品基础框架搭建')).toBe('急诊产品基础框架搭建')
  })

  it('删除标签但保留文字（TFS 最常见的 <div> 包裹）', () => {
    expect(htmlToPlainText('<div>需求正文</div>')).toBe('需求正文')
  })

  it('<br> 与块级闭合 → 换行（换行信息必须在"删全部标签"之前处理）', () => {
    expect(htmlToPlainText('第一行<br/>第二行')).toBe('第一行\n第二行')
    expect(htmlToPlainText('<p>一段</p><p>二段</p>')).toBe('一段\n二段')
    expect(htmlToPlainText('<div>a</div><div>b</div>')).toBe('a\nb')
  })

  it('<li> → 列表短横线', () => {
    expect(htmlToPlainText('<ul><li>甲</li><li>乙</li></ul>')).toBe('- 甲\n- 乙')
  })

  it('script / style 整段丢弃（其内容不是"正文"）', () => {
    expect(htmlToPlainText('<style>.x{color:red}</style><div>正文</div>')).toBe('正文')
    expect(htmlToPlainText('<script>alert(1)</script>正文')).toBe('正文')
  })

  it('命名实体解码', () => {
    expect(htmlToPlainText('a&nbsp;b')).toBe('a b')
    expect(htmlToPlainText('&amp;&lt;&gt;&quot;&apos;')).toBe('&<>"\'')
  })

  it('数字实体（十进制 / 十六进制）解码', () => {
    expect(htmlToPlainText('&#20320;&#22909;')).toBe('你好')
    expect(htmlToPlainText('&#x4F60;&#x597D;')).toBe('你好')
  })

  it('解不开的实体**原样保留**，不做"看起来合理"的编造（宪法 Principle I）', () => {
    expect(htmlToPlainText('&notarealentity;')).toBe('&notarealentity;')
  })

  it('越界 / 控制字符实体返回空串，不产出乱码', () => {
    expect(htmlToPlainText('&#0;&#x110000;&#99999999;')).toBe('')
  })

  it('行首尾空白清理 + 连续空行压成两个', () => {
    expect(htmlToPlainText('   <div>  a  </div>   <div>  b  </div>  ')).toBe('a\nb')
    expect(htmlToPlainText('a<br/><br/><br/><br/>b')).toBe('a\n\nb')
  })

  it('整体 trim（富文本编辑器产出的首尾空段落不该留成空行）', () => {
    expect(htmlToPlainText('<div><br/></div><div>正文</div><div><br/></div>')).toBe('正文')
  })

  it('真实 TFS 形态：混合标记 + 实体 → 可读多行文本', () => {
    const html =
      '<div><b>【需求背景】</b>&nbsp;急诊预检分诊需要改造。<br/></div>' +
      '<div><br/></div>' +
      '<div><b>【期望】</b></div>' +
      '<ul><li>支持分诊分级</li><li>支持&#25151;间叫号</li></ul>'
    // 段落之间、段落与列表之间各留一个空行（`<li>` 自带换行 + 前一个块级闭合的换行）。
    expect(htmlToPlainText(html)).toBe(
      '【需求背景】 急诊预检分诊需要改造。\n\n【期望】\n\n- 支持分诊分级\n- 支持房间叫号',
    )
  })
})

describe('truncateText', () => {
  it('非字符串 → 空串', () => {
    expect(truncateText(undefined as unknown as string, 10)).toBe('')
  })

  it('max <= 0 或非有限数 → 不截断', () => {
    expect(truncateText('abcdef', 0)).toBe('abcdef')
    expect(truncateText('abcdef', -1)).toBe('abcdef')
    expect(truncateText('abcdef', Number.NaN)).toBe('abcdef')
  })

  it('未超限原样返回', () => {
    expect(truncateText('abc', 3)).toBe('abc')
  })

  it('超限截断并带截断标记（标记里给出原长度，不静默丢信息）', () => {
    expect(truncateText('abcdefghij', 5)).toBe('abcde…（已截断，共 10 字）')
  })

  it('上限常量是正整数，且明显大于面板填充上限（两级截断标记不叠加）', () => {
    expect(Number.isInteger(MAX_DESCRIPTION_CHARS)).toBe(true)
    expect(MAX_DESCRIPTION_CHARS).toBeGreaterThan(4000)
  })
})

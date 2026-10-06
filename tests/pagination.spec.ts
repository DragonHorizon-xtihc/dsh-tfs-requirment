import { describe, expect, it } from 'vitest'
import {
  DEFAULT_PAGE_SIZE,
  clampPage,
  normalizePageSize,
  pageCountFor,
  pageRange,
  paginateSlice,
} from '../src/client/hooks/usePagination.js'

/**
 * 问题 4 / 问题 6：需求池、已领取需求、任务列表三处客户端分页。
 *
 * hook 本身依赖 React 状态，这里把分页数学抽成纯函数测：
 *  - 每页条数可配置且非法值有兜底；
 *  - 删除/筛选导致 total 缩小时页码自动夹回，不停在空白页；
 *  - 切片与「第 a–b 条 / 共 n 条」序号正确。
 */
describe('分页纯函数（usePagination）', () => {
  it('normalizePageSize：正整数向下取整；0/负数/NaN/Infinity → 默认 20', () => {
    expect(normalizePageSize(50)).toBe(50)
    expect(normalizePageSize(10.9)).toBe(10)
    expect(normalizePageSize(0)).toBe(DEFAULT_PAGE_SIZE)
    expect(normalizePageSize(-3)).toBe(DEFAULT_PAGE_SIZE)
    expect(normalizePageSize(Number.NaN)).toBe(DEFAULT_PAGE_SIZE)
    expect(normalizePageSize(Number.POSITIVE_INFINITY)).toBe(DEFAULT_PAGE_SIZE)
  })

  it('pageCountFor：向上取整，空列表也是 1 页', () => {
    expect(pageCountFor(0, 20)).toBe(1)
    expect(pageCountFor(1, 20)).toBe(1)
    expect(pageCountFor(20, 20)).toBe(1)
    expect(pageCountFor(21, 20)).toBe(2)
    expect(pageCountFor(95, 10)).toBe(10)
  })

  it('clampPage：页码夹到 [1, pageCount]', () => {
    expect(clampPage(0, 5)).toBe(1)
    expect(clampPage(-9, 5)).toBe(1)
    expect(clampPage(3, 5)).toBe(3)
    expect(clampPage(99, 5)).toBe(5)
  })

  it('paginateSlice：各页切片正确，末页不足一页', () => {
    const items = Array.from({ length: 25 }, (_, i) => i + 1)
    expect(paginateSlice(items, 1, 10)).toEqual(Array.from({ length: 10 }, (_, i) => i + 1))
    expect(paginateSlice(items, 2, 10)).toEqual(Array.from({ length: 10 }, (_, i) => i + 11))
    expect(paginateSlice(items, 3, 10)).toEqual([21, 22, 23, 24, 25])
  })

  it('paginateSlice：页码越界（删除后 total 缩小）自动夹回，不返回空页', () => {
    const items = Array.from({ length: 12 }, (_, i) => i + 1)
    // 原来在第 5 页（pageSize 10），筛选后只剩 12 条 → 夹到第 2 页。
    expect(paginateSlice(items, 5, 10)).toEqual([11, 12])
    // 清空后停在第 1 页空切片，而不是 undefined 页。
    expect(paginateSlice([], 9, 10)).toEqual([])
  })

  it('pageRange：序号区间；total=0 时 start=0', () => {
    expect(pageRange(0, 1, 20)).toEqual({ start: 0, end: 0 })
    expect(pageRange(25, 1, 10)).toEqual({ start: 1, end: 10 })
    expect(pageRange(25, 3, 10)).toEqual({ start: 21, end: 25 })
    // 越界页夹回末页后的区间。
    expect(pageRange(12, 5, 10)).toEqual({ start: 11, end: 12 })
  })

  /**
   * 2026-10-06 修复（需求池「仅看未入池」）：**分页 total 与切片数组必须同源**。
   *
   * 旧实现 `usePagination(items.length)` 用全量算页数、`paginate(visibleItems)` 切过滤后的
   * 数组。两者不相等时 `paginateSlice` 会按 visibleItems 再夹一次页码，于是分页栏仍高亮
   * 第 16 页、「第 301–320 条 / 共 500 条」也照算，列表里显示的却是第 15 页的内容 ——
   * 页码、计数文案与实际内容三者错位，用户点第 20 页看到第 15 页的数据却无从察觉。
   */
  describe('total 与切片同源（口径不一致会错位）', () => {
    const all = Array.from({ length: 500 }, (_, i) => i + 1)
    const visible = all.filter(n => n <= 300) // 「仅看未入池」过滤掉 200 条

    it('错误用法：用全量 total 算页码去切过滤数组 ⇒ 页码与内容错位（第16页显示第15页）', () => {
      const pageSize = 20
      const wrongPageCount = pageCountFor(all.length, pageSize) // 25
      const wrongPage = clampPage(16, wrongPageCount) // 16（分页栏高亮这里）
      const shown = paginateSlice(visible, wrongPage, pageSize)
      // 内部被夹到第 15 页 ⇒ 显示的是第 281–300 条，而分页栏说"第 16 页"。
      expect(shown[0]).toBe(281)
      expect(pageRange(all.length, wrongPage, pageSize)).toEqual({ start: 301, end: 320 })
      expect(shown[0]).not.toBe(301) // ← 文案说 301，实际第一条是 281：错位成立
    })

    it('正确用法：total 取切片数组自身长度 ⇒ 页码、区间、内容三者一致', () => {
      const pageSize = 20
      const pageCount = pageCountFor(visible.length, pageSize) // 15
      expect(pageCount).toBe(15)
      const page = clampPage(16, pageCount) // 越界被夹到 15
      expect(page).toBe(15)
      const shown = paginateSlice(visible, page, pageSize)
      expect(shown[0]).toBe(281)
      expect(pageRange(visible.length, page, pageSize)).toEqual({ start: 281, end: 300 })
      // 区间起点与切片首条对应的序号一致 ⇒ 无错位
      expect(pageRange(visible.length, page, pageSize).start).toBe(281)
    })
  })
})

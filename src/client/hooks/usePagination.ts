/**
 * 客户端列表分页 hook（问题 4 / 问题 6）。
 *
 * 需求池、任务中心「已领取需求」「任务列表」三处都是**客户端分页**：
 * 宿主 WIQL 一次拉回上限内的全量条目（`$top=500` 架构不变），切片在客户端完成，
 * 切页不产生任何 TFS 请求。
 *
 * 设计：
 *   - 页码越界自动夹回（删除/筛选导致 total 缩小时不会停在空白页）；
 *   - `resetPage` 供筛选条件变化 / 手动刷新时回到第 1 页；
 *   - `paginate(items)` 返回当前页切片，`rangeStart/rangeEnd` 给分页栏做「第 a–b 条 / 共 n 条」。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/client/hooks/usePagination
 */
import { useState } from 'react'

/** 每页条数非法时的兜底值（与需求池默认档位一致）。 */
export const DEFAULT_PAGE_SIZE = 20

/** 把每页条数规整为正整数（非法 → {@link DEFAULT_PAGE_SIZE}）。 */
export function normalizePageSize(pageSize: number): number {
  return Number.isFinite(pageSize) && pageSize > 0 ? Math.floor(pageSize) : DEFAULT_PAGE_SIZE
}

/** 总页数：total<=0 或无条目时也是 1（分页栏始终停在合法页）。 */
export function pageCountFor(total: number, pageSize: number): number {
  return Math.max(1, Math.ceil(Math.max(0, total) / normalizePageSize(pageSize)))
}

/** 把页码夹到 [1, pageCount]。 */
export function clampPage(page: number, pageCount: number): number {
  return Math.min(Math.max(1, page), Math.max(1, pageCount))
}

/** 当前页切片（纯函数，切页不产生请求）。 */
export function paginateSlice<T>(items: readonly T[], page: number, pageSize: number): T[] {
  const size = normalizePageSize(pageSize)
  const current = clampPage(page, pageCountFor(items.length, size))
  const start = (current - 1) * size
  return items.slice(start, start + size)
}

/** 「第 a–b 条 / 共 n 条」用的序号区间（total=0 时 start=0）。 */
export function pageRange(total: number, page: number, pageSize: number): { start: number; end: number } {
  const size = normalizePageSize(pageSize)
  const current = clampPage(page, pageCountFor(total, size))
  return {
    start: total <= 0 ? 0 : (current - 1) * size + 1,
    end: Math.min(total, current * size),
  }
}

export interface Pagination {
  /** 当前页码（1 起，已夹到合法范围）。 */
  page: number
  /** 总页数（至少为 1）。 */
  pageCount: number
  /** 跳页（自动夹到 [1, pageCount]）。 */
  setPage: (page: number) => void
  /** 回到第 1 页（筛选/刷新时调用）。 */
  resetPage: () => void
  /** 取当前页切片。 */
  paginate: <T>(items: readonly T[]) => T[]
  /** 当前页首条序号（total=0 时为 0）。 */
  rangeStart: number
  /** 当前页末条序号。 */
  rangeEnd: number
}

/**
 * @param total - 条目总数。
 * @param pageSize - 每页条数（受控；调用方从 UI 状态读出并持久化）。
 */
export function usePagination(total: number, pageSize: number): Pagination {
  const [page, setPageState] = useState(1)
  const safeSize = normalizePageSize(pageSize)
  const pageCount = pageCountFor(total, safeSize)
  const current = clampPage(page, pageCount)

  const setPage = (next: number): void => setPageState(clampPage(next, pageCount))
  const resetPage = (): void => setPageState(1)

  const paginate = <T,>(items: readonly T[]): T[] => paginateSlice(items, current, safeSize)

  const range = pageRange(total, current, safeSize)

  return { page: current, pageCount, setPage, resetPage, paginate, rangeStart: range.start, rangeEnd: range.end }
}

/**
 * Markdown 看板渲染（Principle VI：JSON 权威 → 渲染只读视图）。
 *
 * 输出 `.ai-board/计划看板.md`，顶部标注「自动生成请勿手改」。
 *
 * @module dsh-tfs-requirment/persistence/markdown
 */

import type { BoardState } from '../core/board/board.js'
import type { TaskSnapshot } from '../core/board/task.js'

/** 顶部警示（防止人工手改）。 */
const AUTO_HEADER = '> ⚠️ 本文件由 dsh-tfs-requirment 自动生成，请勿手改。改动将在下次渲染被覆盖。\n'

/**
 * 转义 Markdown 表格单元格内容。
 *
 * **为什么必须转义**：Windows 路径不含 `|`，但标题/路径可能来自用户输入或 TFS 字段；
 * 未转义的 `|` 会把一行表格撑成多列，导致整个表格错位。换行同理（会截断表格行）。
 *
 * @param v - 原始值。
 * @returns 可安全放入单元格的文本。
 */
function cell(v: string | undefined): string {
  return (v ?? '')
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
}

/**
 * 渲染看板为 Markdown。
 * @param board - 看板快照。
 * @returns Markdown 文本。
 */
export function renderBoardMarkdown(board: BoardState): string {
  const lines: string[] = []
  lines.push('# TFS 需求看板')
  lines.push('')
  lines.push(AUTO_HEADER)
  lines.push(`更新时间：${board.updatedAt} ｜ 快照版本：${board.version}`)
  lines.push('')

  const requirements = Object.values(board.requirements)
  lines.push(`## 需求池（${requirements.length}）`)
  lines.push('')
  if (requirements.length === 0) {
    lines.push('_（空）_')
  } else {
    lines.push('| 去重键 | 标题 | 状态 | 指派 | 迭代 | 工作目录 |')
    lines.push('| --- | --- | --- | --- | --- | --- |')
    for (const r of requirements) {
      lines.push(
        `| ${cell(`${r.workItemId}@${r.collection}`)} | ${cell(r.title)} | ${cell(r.state)} | ${cell(r.assignedTo)} | ${cell(r.iteration)} | ${cell(r.workspace) || '-'} |`,
      )
    }
  }
  lines.push('')

  const tasks = Object.values(board.tasks)
  lines.push(`## 任务（${tasks.length}）`)
  lines.push('')
  if (tasks.length === 0) {
    lines.push('_（空）_')
  } else {
    lines.push('| 任务 | 需求 | 状态 | 执行 | 角色 | 工作目录 | 依赖 |')
    lines.push('| --- | --- | --- | --- | --- | --- | --- |')
    for (const t of tasks) {
      lines.push(
        `| ${cell(t.title)} | ${cell(t.requirementId)} | ${cell(t.state)} | ${cell(t.execState)} | ${cell(t.roleAgent)} | ${cell(t.workspace) || '-'} | ${cell(t.blockedBy.join(', ')) || '-'} |`,
      )
    }
  }
  lines.push('')
  return lines.join('\n')
}

/** 便捷：判断某快照是否含任务（供调用方在不引入类型时复用）。 */
export function hasTasks(board: BoardState): boolean {
  return Object.keys(board.tasks).length > 0
}

/** 便捷类型再导出。 */
export type { TaskSnapshot }

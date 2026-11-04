/**
 * 变更前/后 diff 预览（S-05 / T047 渲染源）。
 *
 * 纯函数：对 `WriteOp.before/after` 做字段级 diff，产出 `DryRunPreview` 供 ExecutionPanel
 * 渲染「确认回写」卡片。支持标量变更、数组集合差（标签/链接增删）、对象键级 diff。
 *
 * @module dsh-tfs-requirment/write-guard/dryrun
 */

import type { WriteOpType } from '../tfs/types.js'

/** 单字段 diff。 */
export interface FieldDiff {
  /** 字段名（opType 或具体字段）。 */
  field: string
  /** 变更类型。 */
  kind: 'changed' | 'added' | 'removed'
  /** 变更前（changed/removed 有值）。 */
  before?: unknown
  /** 变更后（changed/added 有值）。 */
  after?: unknown
}

/** dry-run 预览（确认回写卡片数据源）。 */
export interface DryRunPreview {
  targetWorkItem: string
  collection?: string
  opType: WriteOpType
  idempotencyKey: string
  diffs: FieldDiff[]
  generatedAt: string
}

/** 数组集合差。 */
function arrayDiff(field: string, before: unknown[], after: unknown[]): FieldDiff[] {
  const added = after.filter(x => !before.includes(x))
  const removed = before.filter(x => !after.includes(x))
  const out: FieldDiff[] = []
  if (added.length) out.push({ field, kind: 'added', after: added })
  if (removed.length) out.push({ field, kind: 'removed', before: removed })
  return out
}

/** 对象键级 diff。 */
function objectDiff(before: Record<string, unknown>, after: Record<string, unknown>): FieldDiff[] {
  const keys = new Set([...Object.keys(before), ...Object.keys(after)])
  const out: FieldDiff[] = []
  for (const k of keys) {
    const b = before[k]
    const a = after[k]
    if (b === undefined && a !== undefined) out.push({ field: k, kind: 'added', after: a })
    else if (a === undefined && b !== undefined) out.push({ field: k, kind: 'removed', before: b })
    else if (JSON.stringify(b) !== JSON.stringify(a)) out.push({ field: k, kind: 'changed', before: b, after: a })
  }
  return out
}

/** 计算 before/after 的字段级 diff（按 before/after 形态自动选择策略）。 */
export function diffValues(field: string, before: unknown, after: unknown): FieldDiff[] {
  if (Array.isArray(before) && Array.isArray(after)) {
    return arrayDiff(field, before, after)
  }
  if (
    before !== null &&
    after !== null &&
    typeof before === 'object' &&
    typeof after === 'object' &&
    !Array.isArray(before) &&
    !Array.isArray(after)
  ) {
    return objectDiff(before as Record<string, unknown>, after as Record<string, unknown>)
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) {
    return [{ field, kind: 'changed', before, after }]
  }
  return []
}

/** 预览生成输入（结构性，避免与 WriteOp 紧耦合）。 */
export interface DryRunInput {
  targetWorkItem: string
  collection?: string
  opType: WriteOpType
  idempotencyKey: string
  before: unknown
  after: unknown
}

/**
 * 生成 dry-run 预览（S-05）。
 * @param input - 含 before/after 的回写意图。
 */
export function buildDryRunPreview(input: DryRunInput): DryRunPreview {
  const field = input.opType === 'tag' ? 'tags' : input.opType === 'link' ? 'links' : input.opType
  return {
    targetWorkItem: input.targetWorkItem,
    collection: input.collection,
    opType: input.opType,
    idempotencyKey: input.idempotencyKey,
    diffs: diffValues(field, input.before, input.after),
    generatedAt: new Date().toISOString(),
  }
}

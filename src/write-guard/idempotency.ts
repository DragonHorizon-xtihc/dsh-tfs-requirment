/**
 * 幂等键生成与查重（S-08 / FR-014）。
 *
 * - 标签幂等键：`<workItemId>@<collection>:<normLabel>`，跨进程稳定（同一意图恒得同键）；
 * - 回写幂等键：`<targetWorkItem>#<opType>#<hash(before,after)>`，对同一意图变更稳定。
 *
 * 纯函数，不依赖宿主；哈希用确定性规范序列化 + FNV-1a，保证跨进程一致。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/write-guard/idempotency
 */

import type { WriteOpType } from '../tfs/types.js'

/** 标签归一化：去首尾空白、折叠内部空白、转小写（用于幂等比较）。 */
export function normalizeLabel(label: string): string {
  return label.trim().replace(/\s+/g, ' ').toLowerCase()
}

/** 标签幂等键（S-08）。 */
export function labelIdempotencyKey(
  workItemId: string | number,
  collection: string,
  label: string,
): string {
  return `${workItemId}@${collection}:${normalizeLabel(label)}`
}

/** 深层规范序列化：对象键排序，保证跨进程哈希一致。 */
function canonicalStringify(value: unknown): string {
  const sortDeep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sortDeep)
    if (v !== null && typeof v === 'object') {
      const o = v as Record<string, unknown>
      return Object.keys(o)
        .sort()
        .reduce<Record<string, unknown>>((acc, k) => {
          acc[k] = sortDeep(o[k])
          return acc
        }, {})
    }
    return v
  }
  return JSON.stringify(sortDeep(value))
}

/** FNV-1a 32 位哈希（确定性，跨进程一致）。 */
function fnv1a(str: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, '0')
}

/** 对任意值生成稳定哈希（跨进程一致）。 */
export function stableHash(value: unknown): string {
  return fnv1a(canonicalStringify(value))
}

/** 回写幂等键输入。 */
export interface WriteIdempotencyInput {
  targetWorkItem: string
  opType: WriteOpType
  before: unknown
  after: unknown
}

/** 回写幂等键：同一意图变更恒得同键。 */
export function writeIdempotencyKey(input: WriteIdempotencyInput): string {
  return `${input.targetWorkItem}#${input.opType}#${stableHash({ b: input.before, a: input.after })}`
}

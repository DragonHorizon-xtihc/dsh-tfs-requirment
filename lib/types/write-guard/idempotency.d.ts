/**
 * 幂等键生成与查重（S-08 / FR-014）。
 *
 * - 标签幂等键：`<workItemId>@<collection>:<normLabel>`，跨进程稳定（同一意图恒得同键）；
 * - 回写幂等键：`<targetWorkItem>#<opType>#<hash(before,after)>`，对同一意图变更稳定。
 *
 * 纯函数，不依赖宿主；哈希用确定性规范序列化 + FNV-1a，保证跨进程一致。
 *
 * @module dsh-tfs-requirment/write-guard/idempotency
 */
import type { WriteOpType } from '../tfs/types.js';
/** 标签归一化：去首尾空白、折叠内部空白、转小写（用于幂等比较）。 */
export declare function normalizeLabel(label: string): string;
/** 标签幂等键（S-08）。 */
export declare function labelIdempotencyKey(workItemId: string | number, collection: string, label: string): string;
/** 对任意值生成稳定哈希（跨进程一致）。 */
export declare function stableHash(value: unknown): string;
/** 回写幂等键输入。 */
export interface WriteIdempotencyInput {
    targetWorkItem: string;
    opType: WriteOpType;
    before: unknown;
    after: unknown;
}
/** 回写幂等键：同一意图变更恒得同键。 */
export declare function writeIdempotencyKey(input: WriteIdempotencyInput): string;
//# sourceMappingURL=idempotency.d.ts.map
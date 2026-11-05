/**
 * 变更前/后 diff 预览（S-05 / T047 渲染源）。
 *
 * 纯函数：对 `WriteOp.before/after` 做字段级 diff，产出 `DryRunPreview` 供 ExecutionPanel
 * 渲染「确认回写」卡片。支持标量变更、数组集合差（标签/链接增删）、对象键级 diff。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/write-guard/dryrun
 */
import type { WriteOpType } from '../tfs/types.js';
/** 单字段 diff。 */
export interface FieldDiff {
    /** 字段名（opType 或具体字段）。 */
    field: string;
    /** 变更类型。 */
    kind: 'changed' | 'added' | 'removed';
    /** 变更前（changed/removed 有值）。 */
    before?: unknown;
    /** 变更后（changed/added 有值）。 */
    after?: unknown;
}
/** dry-run 预览（确认回写卡片数据源）。 */
export interface DryRunPreview {
    targetWorkItem: string;
    collection?: string;
    opType: WriteOpType;
    idempotencyKey: string;
    diffs: FieldDiff[];
    generatedAt: string;
}
/** 计算 before/after 的字段级 diff（按 before/after 形态自动选择策略）。 */
export declare function diffValues(field: string, before: unknown, after: unknown): FieldDiff[];
/** 预览生成输入（结构性，避免与 WriteOp 紧耦合）。 */
export interface DryRunInput {
    targetWorkItem: string;
    collection?: string;
    opType: WriteOpType;
    idempotencyKey: string;
    before: unknown;
    after: unknown;
}
/**
 * 生成 dry-run 预览（S-05）。
 * @param input - 含 before/after 的回写意图。
 */
export declare function buildDryRunPreview(input: DryRunInput): DryRunPreview;
//# sourceMappingURL=dryrun.d.ts.map
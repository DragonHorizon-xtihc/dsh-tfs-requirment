/**
 * TFS 领域类型（Principle IV 单一出口的入参/出参契约）。
 *
 * 这些类型由 `tfs/adapter.ts` 在归一化 TFS REST 响应前后使用；业务层不直接依赖 TFS REST 形态。
 * 字段名以 `sampling.ts`（T013）在目标项目实测为准，本文件先给最小可用骨架。
 *
 * @module dsh-tfs-requirment/tfs/types
 */
/**
 * 需求去重键 = `workItemId@collection`（S-01，领取幂等）。
 * @param r - 至少含 workItemId 与 collection 的对象。
 * @returns 去重键。
 */
export function requirementDedupKey(r) {
    return `${r.workItemId}@${r.collection}`;
}
//# sourceMappingURL=types.js.map
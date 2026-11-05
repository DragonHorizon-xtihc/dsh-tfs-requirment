/**
 * 需求完成自动回写的「系统写端口」（问题 4）。
 *
 * ## 为什么单独成文件
 * `tfs/adapter.ts` 体量大（2700+ 行），本文件把"需求完成后自动回写"所需的**确定性读写**收口为
 * 一个最小端口 {@link RequirementWriteBackPort}，由 `requirement-finalizer.ts` 依赖：
 * - 单测可用内存桩驱动 finalizer，完全不触真实 TFS；
 * - 生产实现 {@link createSystemWriteBack} 复用 `TfsAdapter` 的**公开方法**，不新开第二条写链路。
 *
 * ## 与"模型写"门禁的关系
 * `TfsAdapter.addComment / wrappedWrite` 内部仍过 WriteGuard 四道门禁。自动回写是**用户在配置中
 * 开启的、触发条件与目标字段都由代码固定**的系统动作，故以 `confirmed=true` 调用（语义等同
 * "已获授权的系统动作"，与领取需求自动打 `dsh` 标签走 `addTags(..., true)` 同一先例）；
 * 幂等性由 finalizer 的报告账本 + 门禁3 双重保证。门禁3 判重拒绝时本端口归一为 `skipped`
 * （而非错误），其余门禁 / REST 失败抛错，由 finalizer 记为逐项 `error`，不阻断其它项。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/tfs/system-writeback
 */
import { type TfsAdapter } from './adapter.js';
/** 需求完成回写器对 TFS 的最小读写面（finalizer 依赖此接口）。 */
export interface RequirementWriteBackPort {
    /** 读工作项当前字段（字段引用名 → 字符串值），用于回写前幂等判断。 */
    getFields(id: number | string, collection?: string): Promise<Record<string, string>>;
    /** PATCH 若干字段（评审/自测/任务状态+FinishDate 都走它）。 */
    updateFields(id: number | string, collection: string | undefined, fields: Record<string, string>): Promise<{
        status: 'ok' | 'skipped';
        reason?: string;
    }>;
    /** 追加一条历史评论。 */
    addComment(id: number | string, collection: string | undefined, comment: string): Promise<{
        status: 'ok' | 'skipped';
        reason?: string;
    }>;
    /** 上传本地文件为工作项附件，成功带回附件名。 */
    uploadAttachment(id: number | string, collection: string | undefined, filePath: string, fileName?: string): Promise<{
        status: 'ok' | 'skipped';
        name?: string;
        reason?: string;
    }>;
    /** 找需求关联的人员任务（relations 子级/相关 + WIQL Parent 合并去重）。 */
    findLinkedTasks(id: number | string, collection?: string): Promise<Array<{
        id: number;
        title: string;
        state: string;
        via: string;
    }>>;
    /** 把一条关联任务置为"已解决"并设 FinishDate（一次 PATCH 两字段）。 */
    resolveTask(id: number | string, collection: string | undefined, resolvedState: string, finishDateISO: string): Promise<{
        status: 'ok' | 'skipped';
        reason?: string;
    }>;
}
/** 生产实现：把端口方法映射到 TfsAdapter 的公开读写方法。 */
export declare function createSystemWriteBack(adapter: TfsAdapter): RequirementWriteBackPort;
//# sourceMappingURL=system-writeback.d.ts.map
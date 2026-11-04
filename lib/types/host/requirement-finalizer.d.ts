import type { Board } from '../core/board/board.js';
import { type FsLike } from '../persistence/fs-like.js';
import type { RequirementWriteBackReport } from '../shared/contracts.js';
import type { RequirementWriteBackPort } from '../tfs/system-writeback.js';
import type { RequirementFinalizerPort } from './api.js';
/** finalizer 依赖（全部可注入，单测用内存桩）。 */
export interface RequirementFinalizerDeps {
    /** 看板引擎（读需求 / 任务 / 产物 / 历史报告）。 */
    board: Board;
    /** TFS 系统写端口。 */
    port: RequirementWriteBackPort;
    /** 落存报告（生产接 BoardService.setRequirementWriteBack）。 */
    saveReport: (key: string, report: RequirementWriteBackReport) => void;
    /** 关联任务"已解决"目标状态（默认"已解决"；不同过程模板可在装配时覆盖，如 Closed）。 */
    resolvedState?: string;
    /** 文件系统（默认真实 fs）。 */
    fs?: FsLike;
    /** 时钟（测试可注入）。 */
    now?: () => Date;
    /** 附件大小上限（字节）。 */
    maxAttachmentBytes?: number;
}
export declare class RequirementFinalizer implements RequirementFinalizerPort {
    private readonly deps;
    private readonly fs;
    private readonly resolvedState;
    private readonly getNow;
    private readonly maxAttachmentBytes;
    /** 正在回写的需求键（防重入）。 */
    private readonly inFlight;
    constructor(deps: RequirementFinalizerDeps);
    /** 前置条件：至少一个任务且全部 completed。 */
    private isReady;
    /**
     * @param options.finalSummary - spec 010：编排主 agent 产出的最终总结。
     *   提供时它作为结论评论的**主文案**；不提供（或主 agent 超时/失败）则用既有模板，
     *   并在评论里标注 `总结来源：模板兜底`，不假装是 AI 写的。
     */
    maybeFinalize(requirementKey: string, options?: {
        finalSummary?: string;
    }): Promise<RequirementWriteBackReport | undefined>;
    runWriteBack(requirementKey: string, force?: boolean, options?: {
        finalSummary?: string;
    }, 
    /**
     * 调用方是否已持有 `inFlight`（`maybeFinalize` 持锁后再调本方法）。
     * 为 true 时跳过下面的防重入检查，否则自动触发路径会把自己当成并发调用而失败。
     */
    guardHeldByCaller?: boolean): Promise<RequirementWriteBackReport>;
    /**
     * {@link runWriteBack} 的真实主体（调用方已处理 `inFlight` 的检查与登记）。
     *
     * @param requirementKey - 需求去重键。
     * @param force - 是否允许对已回写需求重跑。
     * @param options - 可选的 AI 最终总结。
     * @returns 回写报告。
     */
    private runWriteBackLocked;
    /** ①② 评审 / 自测字段：读当前值，仅把未达标字段合并成一次 PATCH。 */
    private writeReviewAndTestFields;
    /** ④ 收集并校验产物，逐个上传；返回本次成功上传的附件名。 */
    private uploadArtifacts;
    /** ⑤ 找关联人员任务，非终态的置"已解决"并设 FinishDate=明天。 */
    private resolveLinkedTasks;
    /** 取任务最后一次有内容的执行输出（人工确认通过的补记无 output，向前找真实产出）。 */
    private lastTaskOutput;
    /** 组装 System.History 汇总评论。 */
    private buildSummaryComment;
}
//# sourceMappingURL=requirement-finalizer.d.ts.map
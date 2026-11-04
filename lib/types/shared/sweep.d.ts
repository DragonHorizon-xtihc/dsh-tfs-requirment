/**
 * 主 agent 扫尾（2026-11-03 问题 7）：**纯逻辑**层。
 *
 * 用户诉求：主 agent 的工作不只是编排与总结，还要扫尾——
 *   1. 子 agent 需要用户操作时 ⇒ 主 agent 选**推荐选项**，编排该子 agent 继续完成剩余任务；
 *   2. 子 agent 任务完成即停（输出早退）⇒ 主 agent 再次编排**同一**子 agent 续做；
 *   3. 子 agent 无法继续（拒绝 / 重试耗尽）⇒ 主 agent **亲自完成**任务；
 *   4. 完成后继续编排下一个子 agent，直到全部结束（链式放行沿用既有 `handleTaskSettled`）。
 *
 * 本模块只回答「这次收口该采取哪种扫尾动作」——不发消息、不起会话、不碰看板；
 * 真正执行在宿主 `api.ts` 的收口链（`followUpTask` 续跑 / orchestrator 决策与亲做）。
 */
/** 扫尾动作。 */
export type SweepAction = 
/** 成功收口：无需扫尾。 */
{
    kind: 'none';
}
/**
 * 待人工确认：主 agent 选推荐选项后让**同一子 agent** 继续。
 * `recommendation` 为从输出里解析出的推荐项（空串 = 交给主 agent 自行决断）。
 */
 | {
    kind: 'continue_with_recommendation';
    recommendation: string;
}
/** 非拒绝类失败：让同一子 agent 继续/重试（`round` = 第几轮扫尾）。 */
 | {
    kind: 'retry_continue';
    round: number;
}
/** 重试耗尽或明确拒绝：主 agent 亲自完成该任务。 */
 | {
    kind: 'main_agent_completes';
    reason: string;
};
/** 扫尾决策输入。 */
export interface SweepInput {
    /** 本次收口判定（与 `detectOutcome` 同口径）。 */
    outcome: 'success' | 'failed' | 'needs_confirmation';
    /** 子 run 落定原因（`stopReason`）。 */
    stopReason?: string;
    /** 子 agent 最终输出（用于解析推荐选项）。 */
    output?: string;
    /** 该任务已进行的扫尾轮数（0 = 本轮之前没扫过）。 */
    sweepRound: number;
    /** 单任务扫尾轮数上限（超过即转主 agent 亲做；建议 1~3）。 */
    maxSweepRounds: number;
}
/** 推荐选项解析的最大长度（防整篇输出被当成"推荐项"）。 */
export declare const RECOMMENDATION_LIMIT = 300;
/**
 * 从子 agent 输出里解析「推荐选项」。
 *
 * 保守口径：只认显式标记行；解析不出返回空串（由主 agent 对着输出自行决断，
 * 而不是瞎猜一句用户没写过的话）。
 *
 * @param output - 子 agent 最终输出文本。
 * @returns 推荐项文本（已 trim、限长）；无标记返回 ''。
 */
export declare function extractRecommendedOption(output: string | undefined): string;
/**
 * 扫尾决策（问题 7 核心）。
 *
 * 口径：
 *   - `success` ⇒ none（走既有链式放行）；
 *   - `needs_confirmation` ⇒ continue_with_recommendation（推荐项解析不出时为空串，
 *     由主 agent 自行决断）；**同样烧轮数**，反复确认到轮数耗尽 ⇒ 转主 agent 亲做（防死循环）；
 *   - `failed`：
 *       · stopReason=refusal ⇒ main_agent_completes（子 agent 明确不干）；
 *       · sweepRound < maxSweepRounds ⇒ retry_continue（round+1）；
 *       · 否则 ⇒ main_agent_completes（重试耗尽）。
 *
 * @param input - 见 {@link SweepInput}。
 * @returns 扫尾动作（判别联合，无字符串标签歧义）。
 */
export declare function decideSweep(input: SweepInput): SweepAction;
/**
 * 组装「续跑」发给子 agent 的补充指令（扫尾 1/2 两种续跑共用）。
 *
 * @param input.recommendation - 主 agent 选定的推荐项（空 = 不给选项，只让继续）。
 * @param input.outputTail - 子 agent 上一轮输出的尾部提示（可选，帮它回想起停在哪）。
 */
export declare function buildContinuePrompt(input: {
    recommendation: string;
    outputTail?: string;
}): string;
/**
 * 组装「主 agent 亲做」的决策/执行 prompt（扫尾 3）。
 *
 * @param input.taskId - 任务 id。 @param input.title - 任务标题。
 * @param input.taskPrompt - 任务自身提示词（角色级）。 @param input.reason - 为什么转亲做。
 */
export declare function buildMainAgentCompletePrompt(input: {
    taskId: string;
    title: string;
    taskPrompt?: string;
    reason: string;
}): string;
//# sourceMappingURL=sweep.d.ts.map
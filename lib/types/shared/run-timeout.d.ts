/**
 * 看门狗超时证据与**如实**诊断文案（2026-11-04）。
 *
 * ## 为什么单独抽成纯函数
 *
 * 旧文案是写死的一句：「任务运行总时长超过看门狗上限，已被自动终止（可能存在死循环或失控空转）」。
 * 真机证据显示它在正常长任务上是**假指控**（见 `.workbuddy/memory/2026-11-04.md`：30 分钟整被终止的
 * 那次，子 agent 刚刚产出完整报告）。文案是用户唯一能看到的结论，必须由证据决定：
 *
 *   - 到点时**仍有活动** ⇒ 这是长任务，不是空转，提示调大上限；
 *   - 到点时**长时间无任何新事件** ⇒ 才叫失控空转，提示排查循环；
 *   - 没有证据（探针不可用） ⇒ 只陈述"超过上限"，不做任何归因。
 *
 * 纯逻辑放 `shared/`（无 I/O、无宿主依赖）⇒ 可单测，且宿主半与（未来）UI 可共用同一套口径。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/run-timeout
 */
/** 看门狗终止证据（由 `RequirementDispatcher` 产出，宿主半消费）。 */
export interface RunTimeoutEvidence {
    /** `inactivity` = 到点时已长时间无新事件（疑似失控空转）；`cap` = 到点仍活跃（长任务，按总时长终止）。 */
    kind: 'inactivity' | 'cap';
    /** 从 run 启动到被终止的实际时长（毫秒）。 */
    ranMs: number;
    /** 最后一次会话事件距今多久（毫秒）；不可观测时缺省。 */
    lastActivityAgoMs?: number;
    /** 是否已用过活性宽限（用过说明看门狗曾判定它"仍在推进"）。 */
    extended: boolean;
}
/** 毫秒 → 人类可读时长（分钟粒度，向下取整；≥90 分钟落到"小时+分钟"）。 */
export declare function formatDuration(ms: number): string;
/**
 * 生成"超时终止"的失败诊断。
 *
 * @param evidence - 看门狗证据；`undefined`（旧宿主/证据已丢）时给中性描述，不做归因。
 * @returns 面向用户的一段中文说明（**不含**猜测性结论）。
 */
export declare function describeRunTimeout(evidence?: RunTimeoutEvidence): string;
//# sourceMappingURL=run-timeout.d.ts.map
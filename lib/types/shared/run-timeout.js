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
 * @module dsh-tfs-requirment/shared/run-timeout
 */
/** 毫秒 → 人类可读时长（分钟粒度，向下取整；≥90 分钟落到"小时+分钟"）。 */
export function formatDuration(ms) {
    // 向下取整而不是四舍五入：诊断里"跑了 59 分 50 秒"说成"1 小时"会让用户误判上限，
    // 而"不到 1 分钟"必须留给真正不足 1 分钟的那些。
    const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
    if (totalMinutes < 1)
        return '不到 1 分钟';
    if (totalMinutes < 90)
        return `${String(totalMinutes)} 分钟`;
    const hours = Math.floor(totalMinutes / 60);
    const minutes = totalMinutes % 60;
    return minutes > 0 ? `${String(hours)} 小时 ${String(minutes)} 分钟` : `${String(hours)} 小时`;
}
/**
 * 生成"超时终止"的失败诊断。
 *
 * @param evidence - 看门狗证据；`undefined`（旧宿主/证据已丢）时给中性描述，不做归因。
 * @returns 面向用户的一段中文说明（**不含**猜测性结论）。
 */
export function describeRunTimeout(evidence) {
    const kept = '子会话轨迹与已产出内容均已保留，可在「执行过程」查看，不必重跑即可先看结论。';
    if (!evidence) {
        return `任务运行超过看门狗上限，已被自动终止（无活性证据可判定是长任务还是空转）。${kept}`;
    }
    const ran = formatDuration(evidence.ranMs);
    if (evidence.kind === 'inactivity') {
        const idle = evidence.lastActivityAgoMs === undefined ? '' : `，最近 ${formatDuration(evidence.lastActivityAgoMs)}`;
        return `任务运行 ${ran}${idle}子会话没有任何新事件（无模型调用、无工具调用），判定为失控空转并已终止。`
            + `这通常意味着子 agent 在等待一个永远不会来的结果（交互确认、被阻塞的命令、或循环空转）——`
            + `请检查轨迹末尾最后一条工具调用/输出。${kept}`;
    }
    // kind === 'cap'：到点仍在活动 ⇒ 长任务被判了死刑，如实说明并给出可操作建议。
    const idleHint = evidence.lastActivityAgoMs === undefined
        ? ''
        : `终止前 ${formatDuration(evidence.lastActivityAgoMs)}内仍有活动，`;
    return `任务运行 ${ran}，达到看门狗上限被终止。${idleHint}`
        + '说明它不是空转，而是**任务本身比上限更久**：'
        + '请调大插件配置 runTimeoutMinutes（必要时同时调 runTimeoutGraceMinutes）后重新派发，'
        + '或把该任务拆小。'
        + kept;
}
//# sourceMappingURL=run-timeout.js.map
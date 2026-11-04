/**
 * 定时执行（2026-11-03 问题 4/5）：**纯逻辑**层。
 *
 * 两条入口共用同一套语义：
 *   - 执行配置页「发起执行」可选 立刻(默认) / 定时（精确到分）；
 *   - 任务中心「拆解任务」弹框同样可选 立刻(默认) / 定时 —— 到点后主 agent
 *     开始按依赖关系编排子 Agent（上个任务完成才编排下个）。
 *
 * 本模块只放「时间怎么解析/校验/比较/展示」；真正到点触发在宿主
 * `host/scheduler.ts`（落盘 + 定时器 + 重启补跑），不混进纯逻辑。
 */
/** 执行时机：'now' = 立刻；'at' = 定时（dueAt 为 ISO 串）。 */
export type ScheduleMode = 'now' | 'at';
/** 一次执行的时机安排。 */
export interface SchedulePlan {
    mode: ScheduleMode;
    /** ISO 8601 时间串（仅 mode='at' 时有）；精确到分。 */
    dueAt?: string;
}
/** 定时计划的校验结果。 */
export type ScheduleValidation = {
    ok: true;
    plan: SchedulePlan;
} | {
    ok: false;
    reason: string;
};
/**
 * `<input type="datetime-local">` 的值 ↔ ISO 串。
 *
 * HTML 控件给的是 `YYYY-MM-DDTHH:mm`（本地时间、无秒、无时区后缀）。
 * 存储与比较一律用 ISO 串（`Date.prototype.toISOString()`，UTC）——
 * 落盘后跨时区/跨重启仍然单调可比，这是定时器补跑的正确性前提。
 */
export declare function parseDateTimeLocal(raw: string, now?: Date): ScheduleValidation;
/**
 * 校验一条完整的执行时机安排（弹框/表单提交时用）。
 *
 * @param input.mode - 'now' | 'at'。
 * @param input.dueAtLocal - datetime-local 控件的值（仅 mode='at' 需要）。
 * @param input.now - 当前时刻（可注入，便于测试）。
 */
export declare function validateSchedule(input: {
    mode: string;
    dueAtLocal: string;
    now?: Date;
}): ScheduleValidation;
/** 定时项是否已到点（供调度器每个心跳判断；不含"刚刚好"的边界魔数）。 */
export declare function isDue(plan: SchedulePlan, now?: Date): boolean;
/** 距到点还有多少毫秒（已到点/无 dueAt 返回 0；供 setTimeout 取值）。 */
export declare function msUntilDue(plan: SchedulePlan, now?: Date): number;
/**
 * 把 ISO 串格式化回 `YYYY-MM-DD HH:mm`（本地时区，精确到分）。
 * 非法输入返回空串（不让 UI 显示 "Invalid Date"）。
 */
export declare function formatLocalMinute(iso: string | undefined): string;
//# sourceMappingURL=schedule.d.ts.map
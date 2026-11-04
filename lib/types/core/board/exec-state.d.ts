/**
 * 执行链路态（区别于看板四态，执行内部使用）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/core/board/exec-state
 */
/**
 * 执行链路态：排队 → 运行 → 成功/失败/取消/待人工确认。
 *
 * `needs_confirmation`（问题 5）：子智能体在输出中明确要求"人工确认/人工确定"时落定为此态。
 * 它**不是**成功：看板态保持 `in_progress`（不迁入已完成），其下游依赖不就绪（不自动链式执行），
 * 需求也不触发完成回写；必须由人工点「确认通过」（→ success/completed）或「追问/补充」后重跑。
 */
export type ExecState = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'needs_confirmation';
//# sourceMappingURL=exec-state.d.ts.map
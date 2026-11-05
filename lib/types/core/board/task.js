/**
 * 看板任务快照与状态机（借鉴 agent-team TeamTaskBoard 四态模型，自实现落 JSON）。
 *
 * 四态 `pending/in_progress/completed/deleted` + `blockedBy[]` DAG + `revision` 乐观锁。
 * 状态机转换集中在此文件，供 board 引擎统一校验（US3 T045）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/core/board/task
 */
/**
 * 允许的状态转换（闭环，无隐式跳转）。
 * deleted 为终态；completed 仅可转 deleted（撤销）。
 */
export const TASK_TRANSITIONS = {
    pending: ['in_progress', 'deleted'],
    in_progress: ['completed', 'deleted'],
    completed: ['deleted'],
    deleted: [],
};
/**
 * 校验状态转换是否合法。
 * @param from - 当前态。
 * @param to - 目标态。
 * @returns 合法返回 true。
 */
export function canTransition(from, to) {
    if (from === to)
        return true;
    return TASK_TRANSITIONS[from].includes(to);
}
/**
 * 计算下一 revision（乐观锁 +1）。
 * @param current - 当前 revision。
 * @returns current + 1。
 */
export function bumpRevision(current) {
    return current + 1;
}
//# sourceMappingURL=task.js.map
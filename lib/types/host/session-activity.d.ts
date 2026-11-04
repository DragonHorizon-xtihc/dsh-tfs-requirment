/**
 * 子会话"活性"探针（2026-11-04）。
 *
 * ## 为什么需要它
 *
 * 旧的总时长看门狗是纯墙钟：到点就 abort + dispose，并给一句"可能存在死循环或失控空转"。
 * 真机证据（`.workbuddy/memory/2026-11-04.md`）显示这个判据是**错的**：
 * `2059017@WN_HIS#manual-通用工程师-20261103162007` 的第 2 次尝试在 30 分钟整被终止时，
 * 子 agent 的轨迹里**刚刚产出完整报告**（`turn end phase=end reason=aborted`，报告正文已在
 * 事件里）——它是"正常长任务"，不是死循环；而第 1 次尝试光「PM 分析」一步就跑了 28m51s。
 *
 * 因此判据要换成**证据**：到点时先问一句"这个子会话最近还在写事件吗"。
 * 有近期活动 ⇒ 正常长任务；长时间无新事件 ⇒ 才叫失控空转。
 *
 * ## 为什么用 `observeSession` 而不是读 jsonl
 *
 * 与 `host/task-trace.ts` 同一理由：它对 live（运行中）/ prepared（冷读持久化）给统一快照，
 * 并处理 fork 继承、游标与租约释放。这里只用 `events[].time`（事件信封 `{type,seq,time,data}`
 * 的 `time`，epoch ms）取最大值。
 *
 * ## 降级纪律
 *
 * 任何异常/不可读/无时间戳 ⇒ 返回 `undefined`（= 不可观测）。调用方**必须**把"不知道"当成
 * "不能据此判空转"（fail-open，退回按总时长终止），绝不能因为探不到就更早杀掉子 agent。
 *
 * @module dsh-tfs-requirment/host/session-activity
 */
/**
 * 读取某子会话**最后一次会话事件的时刻**。
 *
 * @param sessionQuery - 宿主 `sessionQuery` 服务（形状未知，内部做能力探测）。
 * @param sessionId - 子会话 id（本次 run 的 runId）。
 * @returns 最后一次事件的 `time`（epoch ms）；服务缺失 / 会话不可读 / 事件无时间戳时为 `undefined`。
 */
export declare function probeSessionActivity(sessionQuery: unknown, sessionId: string): Promise<number | undefined>;
//# sourceMappingURL=session-activity.d.ts.map
/**
 * 任务执行轨迹读取服务（spec 006 US2）。
 *
 * 输入 taskId（+可选尝试序号），从看板 attempt 上取 runId（子会话 id），经宿主
 * `sessionQuery.observeSession(runId, { projectionMode: 'none' })` 拿到该子会话的**不可变事件快照**，
 * 再用 {@link mapTraceEvents} 映射成时间线。
 *
 * ## 降级纪律（与 dsh-catalog 一致）
 * sessionQuery 缺失、会话已被清理、runId 缺失（旧记录）等情况**都不抛 500**：返回
 * `available:false` + 可读 `reason`，详情页据此显示"无轨迹"而不是白屏。异常只可能来自真正的
 * 程序错误。
 *
 * 为什么用 observeSession 而不是自己读 jsonl：它对 live（运行中）/ prepared（冷读持久化）两种
 * 来源给统一快照（`packages/session-query/session-query/src/.../observation.ts`），并处理了
 * fork 继承、游标、租约释放；我们只需在用完后 dispose。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/task-trace
 */
import type { Board } from '../core/board/board.js';
import type { TaskTraceResult } from '../shared/contracts.js';
import type { ChildToolCall } from '../shared/capability-plan.js';
export interface TaskTraceServiceDeps {
    /** 看板引擎（读 task.attempts.runId）。 */
    board: Board;
    /** 惰性取宿主 sessionQuery 服务（缺失时返回 undefined/null）。 */
    getSessionQuery?: () => unknown;
}
export declare class TaskTraceService {
    private readonly deps;
    constructor(deps: TaskTraceServiceDeps);
    /**
     * 读取某次任务尝试的执行轨迹。
     * @param taskId - 看板任务 id。
     * @param attemptIndex - 尝试序号（从 0 开始）；缺省取最后一次。
     */
    getTrace(taskId: string, attemptIndex?: number): Promise<TaskTraceResult>;
}
/**
 * 读取某子会话的 `tool/call` 事件切片（2026-10-29 诉求 3/4 的**验收**数据源）。
 *
 * ## 为什么需要单独一个入口
 *
 * 任务落定后要回答"所选技能 / MCP 到底用了没有"，唯一可信的证据是子会话日志里的
 * `tool/call`（`packages/session/src/...` 的会话事件类型；本插件 `trace-mapper.ts:211`
 * 已按同名字段解析工具名与入参）。`TaskTraceService` 面向 UI 时间线（会被截断、按 turn 过滤），
 * 不适合做机验；这里只做**最朴素的**事件扫描。
 *
 * ## 降级口径（与轨迹服务一致）
 *
 * `sessionQuery` 缺失、会话已被清理、观察抛错 ⇒ 返回 `undefined`（= 不可观测）。
 * 返回 `[]` 表示"读到了会话，确实一次工具都没调" —— 两者语义不同，调用方据此决定是否判不达标。
 *
 * @param sessionQuery - 宿主 `sessionQuery` 服务（未知形状，内部做能力探测）。
 * @param sessionId - 子会话 id。
 * @returns 工具调用切片；不可观测时 `undefined`。
 */
export declare function readChildToolCallsFrom(sessionQuery: unknown, sessionId: string): Promise<ChildToolCall[] | undefined>;
/**
 * 读取某子会话**模型真实收到的工具表**（`request/header` 事件里的 `tools[].name`）。
 *
 * ## 为什么需要它（2026-10-30 现场纠正）
 *
 * 现场子代理声称"MCP 工具未注入本会话的工具列表"，据此绕开 MCP 自建 REST 脚本。
 * 但解包该子会话的 `request/header` 后发现：**模型收到的工具表有 455 个工具，
 * `mcp__tfs-mcp__*`（含 tfs_add_tags / tfs_update_workitem）与
 * `mcp__winex_peis_knowledge__*` 全都在里面**——"未注入"是模型的错误自述，不是装配事实。
 *
 * 因此验收不能只信输出文本：要把**请求工具表**作为事实源，用于识别
 * "工具实际存在却谎称不存在"（`mcpClaimedMissing`）。这与 {@link readChildToolCallsFrom}
 * 的分工是：那个回答"它调了什么"，本函数回答"它能看到什么"。
 *
 * 降级口径同轨迹服务：sessionQuery 缺失/会话不可读 ⇒ `undefined`（无法核实，不据此判罚）。
 *
 * @param sessionQuery - 宿主 `sessionQuery` 服务。
 * @param sessionId - 子会话 id。
 * @returns 工具全名清单（多次请求取并集）；不可观测时 `undefined`。
 */
export declare function readChildToolSurfaceFrom(sessionQuery: unknown, sessionId: string): Promise<string[] | undefined>;
//# sourceMappingURL=task-trace.d.ts.map
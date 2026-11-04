/**
 * 定时执行调度器（2026-11-03 问题 4/5，宿主半）。
 *
 * 两条入口共用：
 *   - 执行配置页「发起执行」选**定时** ⇒ 这里存一条 `dispatch` 条目，到点调 `api.dispatch`；
 *   - 任务中心「拆解任务」弹框选**定时** ⇒ 存一条 `chain` 条目，到点开始按依赖编排子 Agent。
 *
 * ## 持久化与补跑
 *
 * 条目落 `schedules.json`（与 `board.json` 同目录、同一 `JsonStore` 纪律）：
 * 插件重启/宿主重载后 `start()` 重新装载 —— **已过期条目立即补跑**，未到期重新武装。
 * 不持久化的话"定时 30 分钟后执行"会随一次页面刷新/宿主重启静默丢失。
 *
 * ## 触发语义：at-most-once
 *
 * 到点后**先移除条目并落盘，再执行**。中途崩溃 = 该条不补跑。取舍：宁可漏跑（用户在
 * 看板上看得见任务没动，可手动补），也不重复派发出两条看板任务/两套子 agent（重复执行
 * 的污染更难收拾，且看板任务 id 不幂等）。
 *
 * ## 计时方式
 *
 * 近期条目用 `setTimeout` 精确到点（秒级足够：入参精确到分）；另有 30s 心跳兜底 ——
 * Windows 休眠/系统时钟跳变会让 setTimeout 延后或提前，心跳按 `isDue` 重扫是唯一可靠兜底。
 *
 * @module host/scheduler
 */
import { type FsLike } from '../persistence/fs-like.js';
import { type SchedulePlan } from '../shared/schedule.js';
/** 调度条目（落盘形状；`payload` 语义由 `kind` 决定）。 */
export interface ScheduledEntry {
    /** 条目 id（调用方给；同一 id 重复 schedule 会覆盖旧条目）。 */
    id: string;
    /** 到点时刻（ISO 8601，精确到分）。 */
    dueAt: string;
    /** 'dispatch' = 到点发起一次执行；'chain' = 到点开始编排某需求的子 Agent 链。 */
    kind: 'dispatch' | 'chain';
    /** dispatch: 完整 DispatchInput 的可序列化形态；chain: { requirementKey }。 */
    payload: unknown;
    /** 创建时刻（ISO）。 */
    createdAt: string;
    /** 人类可读备注（UI 列表用）。 */
    note?: string;
}
/** `schedules.json` 的根对象。 */
export interface ScheduleStore {
    entries: ScheduledEntry[];
}
/** 执行结果（与调度器解耦：调度器只关心成败文案，不理解派发语义）。 */
export interface ScheduleExecuteResult {
    ok: boolean;
    reason?: string;
}
export interface ScheduleServiceOptions {
    /** 插件数据目录（`schedules.json` 落此）。 */
    baseDir: string;
    /** 可注入文件系统（测试用内存实现）。 */
    fs?: FsLike;
    /**
     * 到点执行器（由 `index.ts` 接到 `api.dispatch` / 链式启动）。
     * 抛错会被捕获并当作 `{ ok:false }`，绝不让未处理异常打断心跳。
     */
    execute: (entry: ScheduledEntry) => Promise<ScheduleExecuteResult>;
    /** 心跳间隔（毫秒，缺省 30s）。 */
    heartbeatMs?: number;
    /** 注入时钟（测试用）。 */
    now?: () => Date;
    /** 触发日志回调（可选；接宿主 log）。 */
    onFire?: (entry: ScheduledEntry, result: ScheduleExecuteResult) => void;
}
export declare class ScheduleService {
    private readonly opts;
    private readonly store;
    private readonly timers;
    private heartbeat;
    private started;
    constructor(opts: ScheduleServiceOptions);
    /** 装载落盘条目：过期补跑、未到期武装。幂等（重复 start 不重复武装）。 */
    start(): void;
    /** 停止计时并清心跳（插件卸载/测试收尾）。 */
    dispose(): void;
    /** 当前待执行条目（按到点时刻升序）。 */
    list(): ScheduledEntry[];
    /**
     * 登记一条调度（同 id 覆盖）。登记即落盘，`start()` 未调用时也会在下次启动时生效。
     *
     * @param input - 条目（不含 createdAt）。
     * @returns 成功与否；`dueAt` 非法或已过期直接拒收（fail loud，不"悄悄立即跑"）。
     */
    schedule(input: Omit<ScheduledEntry, 'createdAt'> & {
        plan?: SchedulePlan;
    }): ScheduleExecuteResult;
    /** 取消一条调度。返回是否真的取消了。 */
    cancel(id: string): boolean;
    /** 立即重扫一遍到点条目（测试与心跳共用）。 */
    sweepDue(): void;
    /** 武装一个条目：到点即 fire；超长延时先挂到上限，由心跳接力。 */
    private arm;
    /**
     * 触发一个条目（at-most-once：先摘除落盘，再执行）。
     * 并发调用同一 id 只会执行一次（摘除侧幂等）。
     */
    private fire;
    /** 读落盘条目（文件损坏按空处理并留痕到 console —— 调度不是看板权威数据，不 fail-loud）。 */
    private readAll;
    private writeAll;
}
//# sourceMappingURL=scheduler.d.ts.map
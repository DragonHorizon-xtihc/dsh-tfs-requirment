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
import { JsonStore } from '../persistence/json-store.js';
import { realFs } from '../persistence/fs-like.js';
import { isDue, msUntilDue } from '../shared/schedule.js';
/** setTimeout 可稳定表达的最大延时（~24.8 天），超过的条目交给心跳逐轮消化。 */
const MAX_TIMEOUT_MS = 2_000_000_000;
export class ScheduleService {
    opts;
    store;
    timers = new Map();
    heartbeat;
    started = false;
    constructor(opts) {
        this.opts = opts;
        this.store = new JsonStore({
            baseDir: opts.baseDir,
            fileName: 'schedules.json',
            fs: opts.fs ?? realFs,
        });
    }
    /** 装载落盘条目：过期补跑、未到期武装。幂等（重复 start 不重复武装）。 */
    start() {
        if (this.started)
            return;
        this.started = true;
        for (const entry of this.readAll())
            this.arm(entry);
        this.heartbeat = setInterval(() => this.sweepDue(), Math.max(5_000, this.opts.heartbeatMs ?? 30_000));
        this.heartbeat.unref?.();
    }
    /** 停止计时并清心跳（插件卸载/测试收尾）。 */
    dispose() {
        for (const t of this.timers.values())
            clearTimeout(t);
        this.timers.clear();
        if (this.heartbeat)
            clearInterval(this.heartbeat);
        this.heartbeat = undefined;
        this.started = false;
    }
    /** 当前待执行条目（按到点时刻升序）。 */
    list() {
        return this.readAll().sort((a, b) => Date.parse(a.dueAt) - Date.parse(b.dueAt));
    }
    /**
     * 登记一条调度（同 id 覆盖）。登记即落盘，`start()` 未调用时也会在下次启动时生效。
     *
     * @param input - 条目（不含 createdAt）。
     * @returns 成功与否；`dueAt` 非法或已过期直接拒收（fail loud，不"悄悄立即跑"）。
     */
    schedule(input) {
        const dueAt = input.dueAt;
        const t = Date.parse(dueAt);
        if (Number.isNaN(t))
            return { ok: false, reason: '定时时间无效（不是合法 ISO 时间）' };
        const now = (this.opts.now ?? (() => new Date()))();
        if (t <= now.getTime()) {
            return { ok: false, reason: '定时时间必须晚于当前时间' };
        }
        const entry = {
            id: input.id,
            dueAt,
            kind: input.kind,
            payload: input.payload,
            createdAt: now.toISOString(),
            ...(input.note ? { note: input.note } : {}),
        };
        const entries = this.readAll().filter(e => e.id !== entry.id);
        entries.push(entry);
        this.writeAll(entries);
        if (this.started)
            this.arm(entry);
        return { ok: true };
    }
    /** 取消一条调度。返回是否真的取消了。 */
    cancel(id) {
        const entries = this.readAll();
        const next = entries.filter(e => e.id !== id);
        if (next.length === entries.length)
            return false;
        this.writeAll(next);
        const timer = this.timers.get(id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(id);
        }
        return true;
    }
    /** 立即重扫一遍到点条目（测试与心跳共用）。 */
    sweepDue() {
        const now = (this.opts.now ?? (() => new Date()))();
        for (const entry of this.readAll()) {
            if (isDue({ mode: 'at', dueAt: entry.dueAt }, now))
                void this.fire(entry);
        }
    }
    /** 武装一个条目：到点即 fire；超长延时先挂到上限，由心跳接力。 */
    arm(entry) {
        const existing = this.timers.get(entry.id);
        if (existing)
            clearTimeout(existing);
        const wait = Math.min(MAX_TIMEOUT_MS, msUntilDue({ mode: 'at', dueAt: entry.dueAt }, (this.opts.now ?? (() => new Date()))()));
        const timer = setTimeout(() => {
            this.timers.delete(entry.id);
            void this.fire(entry);
        }, wait);
        timer.unref?.();
        this.timers.set(entry.id, timer);
    }
    /**
     * 触发一个条目（at-most-once：先摘除落盘，再执行）。
     * 并发调用同一 id 只会执行一次（摘除侧幂等）。
     */
    async fire(entry) {
        const entries = this.readAll();
        if (!entries.some(e => e.id === entry.id))
            return; // 已被取消/已触发
        this.writeAll(entries.filter(e => e.id !== entry.id));
        const timer = this.timers.get(entry.id);
        if (timer) {
            clearTimeout(timer);
            this.timers.delete(entry.id);
        }
        let result = { ok: false, reason: '执行器未返回结果' };
        try {
            result = (await this.opts.execute(entry)) ?? result;
        }
        catch (e) {
            result = { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
        this.opts.onFire?.(entry, result);
    }
    /** 读落盘条目（文件损坏按空处理并留痕到 console —— 调度不是看板权威数据，不 fail-loud）。 */
    readAll() {
        try {
            return this.store.read()?.entries ?? [];
        }
        catch {
            // eslint-disable-next-line no-console
            console.warn('[tfs-requirment] schedules.json 解析失败，本次启动按无调度条目处理');
            return [];
        }
    }
    writeAll(entries) {
        this.store.write({ entries });
    }
}
//# sourceMappingURL=scheduler.js.map
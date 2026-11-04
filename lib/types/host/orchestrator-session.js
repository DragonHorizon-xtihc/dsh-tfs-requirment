/**
 * 需求级「编排主 agent」会话管理（spec 010 US1/US2）。
 *
 * ## 它解决什么
 *
 * 010 之前，任务之间是**没有记忆**的：每个任务都是 ONE-SHOT 子 agent，跑完即弃，
 * 前序任务理解过的需求、探索过的代码、踩过的坑，下一个任务全部从零再来（"重复造轮"）。
 * 本模块为**每条需求**起一个 **continuable 持久子会话**当"编排主 agent"：
 *
 *   - 任务 success 收口后，把「任务标题 + 最终输出 + 产物」发给它，让它**归纳**；
 *     结论写回需求级共享简报（见 `shared/brief.ts`）；
 *   - 全部任务完成后，让它出**最终总结**，文案交给既有 `RequirementFinalizer` 写进 TFS 评论；
 *   - 用户在任务中心右侧直接看到这个会话，并能在主/子会话之间切换（UI 在客户端半）。
 *
 * ## 两条硬纪律
 *
 * 1. **宿主服务一律调用时解析**（2026-09-21 实机事故的教训，见 `subagent-access.ts` 模块注释）：
 *    `ctx.get('subagents')` 在 apply 期必然为 `undefined`，闭包捕获会永久钉死"服务不可用"。
 * 2. **continuable 没有 per-message result**
 *    （`packages/subagent/subagent/src/run-settlement.ts:1-7`：`no per-message result`）。
 *    因此"主 agent 回复了没有"必须**另行观测**：本模块用
 *    `ctx.on('subagent/end')`（权威，带 `lastAssistantMessage`）+ `agent/status` 空转 +
 *    `sessionQuery.observeSession` 轮询三级兜底，全都拿不到就**超时降级**，绝不无限等待。
 *
 * ## 降级是设计的一部分，不是失败
 *
 * provider 不支持 continuable / 事件收不到 / 主 agent 卡住 —— 任一情况都只是
 * "这条需求没有 AI 归纳"，任务链路**照常跑完**（归纳退化为无摘要、总结退化为既有模板）。
 * 状态与原因落 `board.json` 的 `requirement.orchestration`，面板如实展示，不静默。
 *
 * @module dsh-tfs-requirment/host/orchestrator-session
 */
import { sendMessageOn, startContinuableOn, resolveSubagents, interruptChildOn, drainChildrenOn, } from './subagent-access.js';
import { mapTraceEvents, blocksToText } from './trace-mapper.js';
import { buildFinalSummaryPrompt, buildSummarizePrompt, emptyBrief, mergeArtifacts, parseOrchestratorSummary, setDigest, stripProtocolMarkers, upsertConclusion, } from '../shared/brief.js';
import { truncateText } from '../shared/text.js';
/**
 * 释放观察租约。
 *
 * 宿主同时提供 `dispose()` 与 `[Symbol.dispose]()` 两种 Disposable 形态，
 * 只调其中一个会在另一种形态的部署上**每轮轮询泄漏一次租约**
 * （本文件 :213 的轮询兜底此前只调 `dispose?.()`）。
 *
 * @param obs - `observeSession` 的返回值；`undefined` 时直接返回。
 */
function releaseObservation(obs) {
    if (!obs)
        return;
    try {
        const dispose = obs.dispose;
        const symbolDispose = obs[Symbol.dispose];
        if (typeof dispose === 'function')
            dispose.call(obs);
        else if (typeof symbolDispose === 'function')
            symbolDispose.call(obs);
    }
    catch {
        // 释放失败不影响读取结果；租约由宿主回收。
    }
}
/**
 * 子会话"这一轮干完没有"的观测器。
 *
 * 三级信号（任一命中即落定）：
 *   1. `subagent/end` 且 `info.id === childId` —— 权威，直接带 `lastAssistantMessage`；
 *   2. `agent/status` 由 running → idle（**必须**先看到本轮 running，否则会把"还没开工"误判为做完）；
 *   3. `sessionQuery.observeSession` 轮询发现会话不再 live —— 冷读收尾。
 *
 * 三级都没有 ⇒ 超时返回 `undefined`，由调用方按降级处理。
 */
export class ChildSettleWatcher {
    deps;
    /** childId → 等待者集合。 */
    waiters = new Map();
    /** childId → 本轮是否已观测到 running（避免把"尚未开工"当成已收口）。 */
    sawRunning = new Set();
    /**
     * childId → 最近一次观测到的事件数（2026-10-31：停滞超时判活跃度）。
     *
     * 复用会话的 turn 可能跑 88 分钟真活（2030877 现场：204 步、310 次工具调用），
     * 绝对 30 分钟超时会把长任务误判为失败。改为**停滞超时**：只要事件数还在增长
     * （本轮仍在产出），就不算停滞；连续 `timeoutMs` 无新事件才算卡死。
     */
    eventCounts = new Map();
    /**
     * childId → **无人等待时**收到的落定结果。
     *
     * 新建 continuable 子会话时，`startContinuableOn` 一返回就已经把 prompt 投出去、
     * 这一轮也可能已经跑完，而调用方要到拿到 childId 之后才挂等待者。晚挂会永久漏掉
     * `subagent/end`（continuable 子会话长期是 live，轮询兜底也救不回来），任务只能
     * 空等到超时。落定先存这里，由晚挂方声明「本轮可能已经落定」后取走。
     *
     * 生命周期：新一轮 `running` 时删除（陈旧轮次的结果不得被下一轮误取），被取走时删除。
     */
    lateSettles = new Map();
    constructor(ctx, deps = {}) {
        this.deps = deps;
        // 两个事件都是 scope-filtered 派发；root 级监听器能收到各 agent 的生命周期边
        // （先例见 `parent-resolver.ts:60-71`）。注册失败只影响观测能力，不阻断插件加载。
        try {
            ctx.on('subagent/end', ((info) => {
                const childId = String(info?.id ?? '');
                if (!childId)
                    return;
                this.settle(childId, {
                    stopReason: (info.stopReason ?? 'completed'),
                    output: info.lastAssistantMessage ? [...info.lastAssistantMessage] : [],
                });
            }));
        }
        catch {
            /* 宿主无该事件名：退化为轮询 */
        }
        try {
            ctx.on('agent/status', ((info) => {
                const childId = String(info?.agent?.session?.id ?? info?.agent?.id ?? '');
                if (!childId)
                    return;
                if (info.status === 'running') {
                    this.sawRunning.add(childId);
                    // 新一轮开工：上一轮晚到的落定结果作废，防止被下一轮误取。
                    this.lateSettles.delete(childId);
                }
                else if (info.status === 'idle' && this.sawRunning.has(childId)) {
                    this.sawRunning.delete(childId);
                    void this.settleFromSessionLog(childId);
                }
            }));
        }
        catch {
            /* 宿主无该事件名：退化为轮询 */
        }
    }
    /**
     * 等待某个子会话本轮落定。
     *
     * ⚠️ 必须在**投递消息之前**调用：事件可能同步到达，晚挂会永久漏掉。
     *
     * **超时语义（2026-10-31 修正）**：`timeoutMs` 是**停滞超时**（stall timeout），
     * 不是绝对上限——只要会话事件数还在增长（本轮仍在产出），计时器就重置。
     * 真正卡死（连续 `timeoutMs` 无新事件）才返回 undefined。绝对安全上限 = 8 倍。
     *
     * @param childId - 子会话 id。
     * @param timeoutMs - 停滞超时（毫秒）；连续这么久无新事件才判卡死。
     * @param signal - 可选取消信号。
     * @param opts - `mayHaveSettled`：调用方是在**本轮已经开始之后**才挂上来的（新建
     *   continuable 子会话的路径），挂上来先取走同轮晚到的落定结果。
     * @returns 落定结果；停滞/取消返回 undefined。
     */
    waitForChildSettle(childId, timeoutMs, signal, opts) {
        if (!childId)
            return Promise.resolve(undefined);
        return new Promise(resolve => {
            let done = false;
            /** 绝对安全上限：无论如何不允许无限等（8 倍停滞超时）。 */
            const absoluteDeadline = Date.now() + Math.max(timeoutMs * 8, 60 * 60_000);
            const finish = (r) => {
                if (done)
                    return;
                done = true;
                clearTimeout(timer);
                if (timer2)
                    clearInterval(timer2);
                signal?.removeEventListener('abort', onAbort);
                this.eventCounts.delete(childId);
                const set = this.waiters.get(childId);
                if (set) {
                    set.delete(finish);
                    if (set.size === 0)
                        this.waiters.delete(childId);
                }
                resolve(r);
            };
            const onAbort = () => finish(undefined);
            const set = this.waiters.get(childId) ?? new Set();
            set.add(finish);
            this.waiters.set(childId, set);
            /**
             * 停滞超时定时器（可被活动重置）。
             * 初始计一次；每次轮询发现新事件时重置。
             */
            let timer = setTimeout(() => finish(undefined), Math.max(1, timeoutMs));
            const resetStallTimer = () => {
                clearTimeout(timer);
                timer = setTimeout(() => finish(undefined), Math.max(1, timeoutMs));
            };
            // 兜底轮询：检测收口 + 活跃度（每 tick 重置停滞计时器）。
            const timer2 = this.deps.getSessionQuery && timeoutMs >= 1000
                ? setInterval(() => {
                    if (done)
                        return;
                    // 绝对安全上限。
                    if (Date.now() > absoluteDeadline) {
                        finish(undefined);
                        return;
                    }
                    void this.settleFromSessionLog(childId).then(active => {
                        if (done)
                            return;
                        if (active)
                            resetStallTimer();
                    });
                }, Math.max(2000, this.deps.pollIntervalMs ?? 15_000))
                : undefined;
            signal?.addEventListener('abort', onAbort, { once: true });
            if (opts?.mayHaveSettled) {
                const late = this.lateSettles.get(childId);
                if (late) {
                    this.lateSettles.delete(childId);
                    finish(late);
                }
            }
        });
    }
    /** 落定某 childId：有人等就交给等待者，没人等就存进 `lateSettles` 等晚挂方来取。 */
    settle(childId, result) {
        const set = this.waiters.get(childId);
        if (!set || set.size === 0) {
            this.lateSettles.set(childId, result);
            return;
        }
        this.lateSettles.delete(childId);
        for (const fn of [...set])
            fn(result);
    }
    /**
     * 由外部（用户取消）注入一个落定结果：childId 有等待者则立即交付，否则按晚到落定存放。
     *
     * D5 配套：复用任务取消时，让**本轮等待**以明确的 `aborted` 结果收口（并触发槽/turn 释放），
     * 而不是 `AbortController.abort()` 后 waitForChildSettle 得到 undefined、再被 toResult 误判成
     * "超时未收口"错误。
     */
    injectSettle(childId, result) {
        this.settle(childId, result);
    }
    /**
     * 从会话日志判定落定（2026-10-31 根因修复）。
     *
     * ## 旧实现的缺陷
     *
     * 只看 `source !== 'live'` —— 但**复用 continuable 会话为保持可续投而长期 live**，
     * `live` 的语义是"连接活着"，不是"本轮还在输出"。于是 turn 2 干完 88 分钟真活、
     * 日志里 `turn/end {turn:2, reason:completed}` 明明已出现，观测器却因 `source==='live'`
     * 永远不认账，只能等 30 分钟超时误判失败（2030877 现场）。
     *
     * ## 现在的判定
     *
     * 以**本轮 turn 是否已结束**为准：扫描原始事件里的 `turn/start` / `turn/end`，
     * 若最后一条 `turn/end` 的 turn 序号 >= 最后一条 `turn/start` 的 turn 序号，
     * 说明本轮已收口（无论会话是否仍 live）。会话不再 live 时同样收尾（ONE-SHOT 冷读）。
     *
     * @returns 本轮是否有新事件产出（供上层停滞超时判断活跃度）。
     */
    async settleFromSessionLog(childId) {
        const sq = this.deps.getSessionQuery?.();
        if (!sq || typeof sq.observeSession !== 'function')
            return false;
        if (!this.waiters.has(childId))
            return false;
        try {
            const obs = await sq.observeSession(childId, { projectionMode: 'none' });
            try {
                const events = obs.events ?? [];
                // ── 活动检测：事件数增长 = 本轮仍在产出（供停滞超时用）。
                const prevCount = this.eventCounts.get(childId) ?? 0;
                const active = events.length > prevCount;
                if (active)
                    this.eventCounts.set(childId, events.length);
                // ── turn/end 判定：本轮 turn 是否已收口。
                let lastStartTurn = -1;
                let lastEndTurn = -1;
                for (const raw of events) {
                    const e = raw;
                    const d = (e?.data ?? {});
                    const turn = typeof d?.turn === 'number' ? d.turn : -1;
                    if (e?.type === 'turn/start' && turn >= 0)
                        lastStartTurn = turn;
                    if (e?.type === 'turn/end' && turn >= 0)
                        lastEndTurn = turn;
                }
                const turnEnded = lastStartTurn >= 0 && lastEndTurn >= lastStartTurn;
                // 落定条件：本轮 turn 已结束，或会话已停止产出（冷读收尾）。
                if (!turnEnded && obs.source === 'live')
                    return active;
                const mapped = mapTraceEvents(events);
                let text = '';
                for (let i = mapped.entries.length - 1; i >= 0; i--) {
                    const e = mapped.entries[i];
                    if (e && e.kind === 'assistant' && typeof e.text === 'string' && e.text.trim()) {
                        text = e.text;
                        break;
                    }
                }
                this.settle(childId, {
                    stopReason: 'completed',
                    output: text ? [{ type: 'text', text }] : [],
                });
                return active;
            }
            finally {
                releaseObservation(obs);
            }
        }
        catch {
            // 会话不可读（已清理 / 服务缺失）：继续等，直至停滞超时降级。
            return false;
        }
    }
}
/**
 * 编排主 agent 会话管理器。
 */
export class OrchestratorSessionManager {
    deps;
    /** 子会话完成观测器（构造时注册宿主事件监听）。 */
    watcher;
    /**
     * 复用键 → 当前持有者完成信号（AC3.3 / E6）。
     *
     * **为什么必须串行**：同一个持久子会话只有一条消息队列。若两条任务同时投递，
     * 观测器拿到的 `subagent/end` 无法区分是哪一条任务的收口 ⇒ 结论会串台、任务收口会错配。
     * 串行化后"一次只有一条在跑"，与 AC3.3 的"以 inbox 消息续跑"语义一致。
     */
    reuseTurns = new Map();
    /**
     * 复用任务取消注册表（D5）：看板任务 id → 本轮投递的现场。
     *
     * 复用路径的 `AbortController` 是 launchReusedTask 的局部变量，外部取消原本够不到；
     * 这里登记后，`cancelReusedTask` 能中断投递/等待并请求宿主中断子会话当前轮。
     * FIFO 串行保证同一复用键同一时刻只有一条 active，落定即注销。
     */
    activeReuse = new Map();
    constructor(deps) {
        this.deps = deps;
        this.watcher = new ChildSettleWatcher(deps.ctx, {
            ...(deps.getSessionQuery ? { getSessionQuery: deps.getSessionQuery } : {}),
            ...(deps.pollIntervalMs ? { pollIntervalMs: deps.pollIntervalMs } : {}),
        });
    }
    /**
     * 取父 Agent：先走同步链，失败时**现场准备**一个（恢复上次会话 / 新建）。
     *
     * 编排动作（建会话 / 归纳 / 总结 / 追问 / 释放）都发生在**异步、且可能晚于用户关闭会话**
     * 的时刻（定时链、扫尾续跑、重启补跑）。只用同步 `getParent` 会在这些时刻必然失败，
     * 而失败又被当成"编排能力不可用"记进 board，用户完全无法区分原因。
     *
     * @param workspace - 需求/任务的工作目录（新建会话时作为 cwd）。
     * @throws 所有降级路径都失败时抛原错误（调用方按各自语义降级）。
     */
    async resolveParent(workspace) {
        const ensure = this.deps.ensureParent;
        return ensure ? ensure(workspace) : this.deps.getParent();
    }
    /**
     * 探测持久子会话是否仍然可读（用于识别 `board.json` 里的**陈旧会话 id**）。
     *
     * 宿主重启、会话 GC 或 provider 重连后，`orchestration.orchestratorSessionId`
     * 可能仍留在 `board.json` 但会话已不存在。`ensure` 复用这种 id 时，
     * 后续每一次 `summarize` 都会抛错、`finalize` 永远返回 `undefined`，
     * 而 `mode` 仍是 `'continuable'`——需求被永久钉死在模板兜底总结上。
     *
     * 判据：**读不到就当不存在**。宿主没提供 `sessionQuery`（或探测抛错）时返回
     * `true`，即"无法判定 ⇒ 维持复用"，避免因缺少可选依赖而反复重建会话。
     *
     * @param childId - 待探测的子会话 id。
     * @returns 会话仍可读返回 `true`；明确读不到返回 `false`。
     */
    async sessionAlive(childId) {
        const sq = this.deps.getSessionQuery?.();
        if (!sq || typeof sq.observeSession !== 'function')
            return true;
        let obs;
        try {
            obs = await sq.observeSession(childId, { projectionMode: 'none' });
            return obs.source === 'live' || obs.source === 'prepared' || Array.isArray(obs.events);
        }
        catch {
            return false;
        }
        finally {
            releaseObservation(obs);
        }
    }
    /**
     * 确保该需求有编排主 agent 会话（幂等）。
     *
     * 幂等口径：`mode === 'continuable'`、`orchestratorSessionId` 非空、且该子会话**仍可读**
     * ⇒ 直接返回既有上下文，**不重复创建**（重复创建会留下多个"工头"，用户不知道该看哪个）。
     * 用户点面板「创建编排会话」（`force`）或旧会话已失效时重建。
     *
     * @param requirementKey - 需求去重键。
     * @param input - 初值。
     * @returns 编排上下文（`mode='off'` 时 `reason` 给出**可读**降级原因）。
     */
    async ensure(requirementKey, input = {}) {
        /**
         * 并发去重（2026-10-05 修复）：`ensure` 自称幂等，但此前是**裸 check-then-act** ——
         * 第 473/484 行的检查与后面真正的副作用 `startContinuable` 之间隔着 `await`
         * （`sessionAlive` 与 `getParent`），期间另一个 `ensure` 会读到"还没有编排上下文"，
         * 于是两个调用**各自**建一个 continuable 子会话。
         *
         * 触发路径真实存在：`api.ts#dispatch` 会对每条派发 best-effort 调一次 `ensure`，
         * 用户快速点两条任务的「派发执行」、或「拆解」与「派发」并发，两个请求并行进来即命中。
         * 后果：先写的 `setOrchestration` 被后写覆盖，前一个会话成为**孤儿**（永久占用宿主
         * 会话资源，且用户看到的"编排会话"与仍在跑的那个不是同一个）。
         *
         * 这里复用既有的 FIFO turn 原语（与 `launchReusedTask` 同一把锁的机制），
         * 不另造第二套并发设施。
         */
        const releaseEnsureTurn = await this.acquireReuseTurn(`ensure|${requirementKey}`);
        try {
            return await this.ensureOnce(requirementKey, input);
        }
        finally {
            releaseEnsureTurn();
        }
    }
    /** {@link ensure} 的真实主体（调用方已持有该需求的 ensure turn）。 */
    async ensureOnce(requirementKey, input = {}) {
        const board = this.deps.board;
        const existing = board?.getOrchestration(requirementKey);
        /**
         * 已判定不可用（provider 不支持 continuable 等）⇒ **不再反复重试**（除非 `force`）。
         *
         * 为什么必须记住失败：`ensure` 会在每次派发时被 best-effort 调用一次。
         * 若每次都重跑 `startContinuable`，而宿主的失败是**确定性**的，
         * 就等于给每条派发都加一次注定失败的调用（慢，且日志里全是同样一条错误）。
         * 失败结论落 `mode:'off'`，用户可在面板点「创建编排会话」（force）显式重试。
         */
        if (existing?.mode === 'off' && input.force !== true)
            return existing;
        /**
         * 已有 continuable 上下文 ⇒ 复用它（重复创建会留下多个"工头"，用户不知道该看哪个）。
         *
         * 两种情况必须重新创建：
         * - `force`：用户在面板点「创建编排会话」，显式要求重试（旧会话 id 作废）；
         * - 旧会话 id 已失效：宿主重启或会话 GC 后 `orchestratorSessionId` 成为**陈旧引用**，
         *   此时复用会让每一次 `summarize` 都抛错、`finalize` 永远返回 undefined，
         *   而 `ensure` 仍报 `mode='continuable'`，需求被永久钉在模板兜底总结上。
         *   探活读不到会话 ⇒ 判定为陈旧。
         */
        if (existing?.mode === 'continuable' && existing.orchestratorSessionId) {
            if (input.force !== true && (await this.sessionAlive(existing.orchestratorSessionId)))
                return existing;
        }
        const base = existing?.brief ?? emptyBrief(requirementKey, input.title ?? requirementKey, {
            ...(input.workspace ? { workspace: input.workspace } : {}),
            tools: input.tools ?? {},
        });
        // 首个任务前先用需求自带正文把摘要填起来（见 buildDigestSeed 的注释）。
        const brief = input.digestSeed ? setDigest(base, input.digestSeed) : base;
        const fallback = (reason) => {
            const next = { mode: 'off', reason, ...(existing?.brief ? { brief: existing.brief } : { brief }) };
            board?.setOrchestration(requirementKey, next);
            return next;
        };
        if (!this.deps.enabled) {
            return fallback('编排主 agent 已在插件配置中关闭（orchestratorMode=off）：任务照常执行，但不会有 AI 归纳与最终总结');
        }
        if (!board)
            return fallback('看板服务不可用，无法登记编排会话');
        let parent;
        try {
            parent = await this.resolveParent(input.workspace);
        }
        catch (e) {
            return fallback(`无法解析宿主 Agent 会话：${e.message}`);
        }
        const parentSessionId = String(parent.session?.id ?? '');
        if (!parentSessionId)
            return fallback('宿主 Agent 未携带会话 id，无法建立可切换的编排会话');
        const provider = this.pickProvider();
        if (!provider)
            return fallback(`${this.providerGapReason()}，无法创建编排会话`);
        const ac = new AbortController();
        try {
            const { childId } = await startContinuableOn(this.deps.ctx, {
                provider,
                label: `编排 ${requirementKey}`,
                request: {
                    prompt: [{ type: 'text', text: this.bootstrapPrompt(requirementKey, input) }],
                    parent,
                    agentOptions: {
                        ...(this.deps.maxTokens && this.deps.maxTokens > 0 ? { maxTokens: this.deps.maxTokens } : {}),
                    },
                    ...(this.deps.maxDepth && this.deps.maxDepth > 0 ? { maxDepth: this.deps.maxDepth } : {}),
                },
                signal: ac.signal,
            });
            // ⚠️ 写回前必须**重读** `taskSessions`（2026-10-06 修复）。
            //
            // `setOrchestration` 是整对象替换。而 512（`sessionAlive` 的探活读）与 547
            // （`startContinuableOn` 建会话，秒级）之间隔着**两个 await**：这段时间里另一条任务的
            // 派发完全可能走 `putTaskSession` 登记了新的复用键。拿 491 行那份**陈旧快照**去展开
            // `taskSessions`，就会把刚登记的 `reuseKey → sessionId` 覆盖掉 ⇒ 下次该复用键判为
            // 未命中、又去 `startContinuableOn` 新建会话，旧子会话永久泄漏，AC3.3 的复用静默失效。
            // 这与同文件 `mergeIntoBrief` 已修的坑是同一个（那里也特地注明了"此刻重读再整对象回写"）。
            const fresh = board?.getOrchestration(requirementKey);
            const taskSessions = fresh?.taskSessions ?? existing?.taskSessions;
            const next = {
                mode: 'continuable',
                orchestratorSessionId: String(childId),
                parentSessionId,
                brief,
                ...(taskSessions ? { taskSessions } : {}),
            };
            board.setOrchestration(requirementKey, next);
            return next;
        }
        catch (e) {
            ac.abort();
            return fallback(`创建 continuable 编排会话失败（provider=${provider}）：${e.message}`);
        }
    }
    /**
     * 让编排主 agent 归纳一个已完成的任务，并把结论写回共享简报（US2 / AC2.2）。
     *
     * 失败与超时都**不抛错**：记 `summaryState` 后返回，调用方继续放行下一个任务（AC2.2 末句）。
     *
     * @param requirementKey - 需求去重键。
     * @param taskId - 已收口的任务 id。
     * @returns 归纳出的摘要（空串 = 未拿到）。
     */
    async summarize(requirementKey, taskId) {
        // 归纳必须按需求串行（spec 010 US3）：编排主会话只有一个，而 `waitForChildSettle`
        // 按 childId 记等待者，同一轮 `subagent/end` 会一次性唤醒该 childId 上的全部等待者。
        // 同一需求两个任务同刻收口时并发归纳，会让任务 A 拿到任务 B 的 `SUMMARY:` 并双双写进
        // 共享简报。复用任务同款 FIFO gate，键加 `orchestrator|` 前缀避免与复用键相撞。
        const releaseTurn = await this.acquireReuseTurn(`orchestrator|${requirementKey}`);
        try {
            return await this.summarizeOnce(requirementKey, taskId);
        }
        finally {
            releaseTurn();
        }
    }
    /** `summarize` 的串行化实体：一次只发一条归纳请求，落定或抛错都会归还发言权。 */
    async summarizeOnce(requirementKey, taskId) {
        const board = this.deps.board;
        if (!board)
            return '';
        const orch = board.getOrchestration(requirementKey);
        const childId = orch?.orchestratorSessionId;
        if (!orch || orch.mode !== 'continuable' || !childId) {
            board.setTaskOrchestration(taskId, { summaryState: 'skipped' });
            return '';
        }
        // 用引擎快照（`TaskSnapshot`）而不是视图：这里要读 attempts/artifactPaths 原始字段。
        const task = board.board?.snapshot?.tasks[taskId];
        if (!task)
            return '';
        board.setTaskOrchestration(taskId, { sessionId: childId, summaryState: 'pending' });
        const prompt = buildSummarizePrompt({
            requirementKey,
            taskId,
            title: task.title,
            output: lastOutputText(task),
            ...(task.artifactPaths.length > 0 ? { artifacts: task.artifactPaths } : {}),
            hasNext: true,
        });
        let result;
        // 同 `finalizeOnce`：`finally { ac.abort() }` 保证异常退出时等待的定时器/轮询也被清掉。
        const ac = new AbortController();
        try {
            // ⚠️ 先挂等待再投递：事件可能同步到达。**父会话解析也必须排在挂等待之后** ——
            // `ensure`/`getParent` 都可能 await，如果在挂等待之前解析，子会话在这段空窗里落定的
            // 事件就收不到了（测试里 `emit` 紧跟 `summarize` 调用即命中此窗口）。
            const settled = this.watcher.waitForChildSettle(childId, this.deps.summarizeTimeoutMs, ac.signal);
            // 归纳发生在任务落定之后（可能跨很多分钟）：父会话可能已被回收，走 ensure 链。
            const parent = await this.resolveParent(task.workspace ?? board.board?.snapshot?.requirements?.[requirementKey]?.workspace);
            await sendMessageOn(this.deps.ctx, parent, childId, [{ type: 'text', text: prompt }], ac.signal);
            result = await settled;
            if (!result) {
                board.setTaskOrchestration(taskId, { summaryState: 'timeout' });
                return '';
            }
        }
        catch (e) {
            void e;
            board.setTaskOrchestration(taskId, { summaryState: 'failed' });
            return '';
        }
        finally {
            ac.abort();
        }
        const summary = parseOrchestratorSummary(blocksToText(result.output));
        if (!summary) {
            board.setTaskOrchestration(taskId, { summaryState: 'failed' });
            return '';
        }
        board.setTaskOrchestration(taskId, { summaryState: 'done', summary });
        this.mergeIntoBrief(requirementKey, {
            taskId,
            title: task.title,
            summary,
            ...(task.artifactPaths.length > 0 ? { artifacts: task.artifactPaths } : {}),
        });
        return summary;
    }
    /**
     * 让编排主 agent 出最终总结（US2 / AC2.4）。
     *
     * @param requirementKey - 需求去重键。
     * @returns 总结文案；拿不到返回 undefined（调用方回退到既有模板总结并标注）。
     */
    async finalize(requirementKey) {
        const board = this.deps.board;
        if (!board)
            return undefined;
        const orch = board.getOrchestration(requirementKey);
        const childId = orch?.orchestratorSessionId;
        if (!orch || orch.mode !== 'continuable' || !childId)
            return undefined;
        // ⚠️ 与 `summarize` 共用同一把串行锁（2026-10-06 修复）。
        //
        // 两者打的是**同一个** `orchestratorSessionId`，而 `ChildSettleWatcher.settle()`
        // 是**按 childId 广播**的：一次落定会同时唤醒挂在该 childId 上的**全部**等待者。
        // `api.ts` 的真实时序是「归纳宽限（默认 20s）到点即刻放行」——`summarize` 可能仍在
        // 后台等待落定，此时若需求已全部完成，`finalize()` 会立刻跟上并挂到同一个 childId。
        // 缺了这把锁，两者会同时收到**同一份**结果：`finalize` 把单任务归纳文本当成最终总结
        // 写进 TFS 结论评论，`summarize` 拿到的最终总结解析不出 `SUMMARY:` 而记 `summaryState:'failed'`。
        // 锁键与 `summarize` 完全一致（`orchestrator|<需求键>`），故两者天然互斥排队。
        const releaseTurn = await this.acquireReuseTurn(`orchestrator|${requirementKey}`);
        try {
            return await this.finalizeOnce(requirementKey, childId);
        }
        finally {
            releaseTurn();
        }
    }
    /** `finalize` 的串行化实体（gate 由 {@link OrchestratorSessionManager.finalize} 持有）。 */
    async finalizeOnce(requirementKey, childId) {
        const board = this.deps.board;
        if (!board)
            return undefined;
        const req = board.board?.snapshot?.requirements[requirementKey];
        const own = Object.values(board.board?.snapshot?.tasks ?? {}).filter(t => t.requirementId === requirementKey);
        const prompt = buildFinalSummaryPrompt({
            requirementKey,
            title: req?.title ?? requirementKey,
            tasks: own.map(t => ({
                title: t.title,
                ...(t.orchestration?.summary ? { summary: t.orchestration.summary } : {}),
            })),
        });
        // ⚠️ `finally { ac.abort() }`（2026-10-06 修复）：此前成功/失败路径都不 abort，
        // 于是异常退出时 `waitForChildSettle` 挂的超时定时器与兜底轮询 interval **无人清理**
        // （它们只在等待自然落定时才清），一直烧到 `finalizeTimeoutMs` 到期。
        // 期间那个 interval 每轮都要冷读一遍整段会话日志。abort 会立即触发 `finish(undefined)`，
        // 顺带把等待者从 watcher 上摘掉，避免它继续收到后续落定广播。
        const ac = new AbortController();
        try {
            // 先挂等待（见 summarizeOnce 的同一注释：父会话解析可能要 await，不能抢在挂等待之前）。
            const settled = this.watcher.waitForChildSettle(childId, this.deps.finalizeTimeoutMs, ac.signal);
            // 总结发生在全部任务落定之后（可能晚至几十分钟 / 跨一次 dsh 重启）：
            // 父会话大概率已不在，走 ensure 链现场恢复或新建，否则总结永远返回 undefined。
            const parent = await this.resolveParent(req?.workspace);
            await sendMessageOn(this.deps.ctx, parent, childId, [{ type: 'text', text: prompt }], ac.signal);
            const result = await settled;
            if (!result)
                return undefined;
            const text = stripProtocolMarkers(blocksToText(result.output));
            return text ? truncateText(text, 4000) : undefined;
        }
        catch {
            return undefined;
        }
        finally {
            ac.abort();
        }
    }
    /**
     * 向编排主 agent 发一条**决策/问答**消息并取回它的完整回复（2026-11-03 问题 7 扫尾）。
     *
     * 与 `summarize`/`finalize` 同一把串行锁（`orchestrator|<需求键>`）——三者打的都是
     * 同一个 `orchestratorSessionId`，`ChildSettleWatcher` 按 childId 并发广播，不排队会让
     * 一次落定同时唤醒多个等待者、互相拿错回复。
     *
     * 失败与超时**不抛错**：返回空串，由扫尾链路自行降级（如改走主 agent 亲做），
     * 与本模块"降级是设计的一部分"的口径一致。
     *
     * @param requirementKey - 需求去重键。 @param prompt - 要发送的决策提示词。
     * @param opts.timeoutMs - 等待回复的超时（缺省沿用 summarizeTimeoutMs）。
     * @returns 主 agent 的回复正文（协议标记已剥离）；拿不到返回 ''。
     */
    async decide(requirementKey, prompt, opts) {
        const releaseTurn = await this.acquireReuseTurn(`orchestrator|${requirementKey}`);
        try {
            return await this.decideOnce(requirementKey, prompt, opts?.timeoutMs);
        }
        finally {
            releaseTurn();
        }
    }
    /** `decide` 的串行化实体（gate 由 {@link OrchestratorSessionManager.decide} 持有）。 */
    async decideOnce(requirementKey, prompt, timeoutMs) {
        const board = this.deps.board;
        if (!board)
            return '';
        const orch = board.getOrchestration(requirementKey);
        const childId = orch?.orchestratorSessionId;
        if (!orch || orch.mode !== 'continuable' || !childId)
            return '';
        const ac = new AbortController();
        try {
            // ⚠️ 先挂等待再投递：事件可能同步到达（同 summarizeOnce）。
            const settled = this.watcher.waitForChildSettle(childId, timeoutMs && timeoutMs > 0 ? timeoutMs : this.deps.summarizeTimeoutMs, ac.signal);
            // 扫尾决策同样晚于用户会话（可能到点/重启后才触发）：走 ensure 链。
            const parent = await this.resolveParent(board.board?.snapshot?.requirements?.[requirementKey]?.workspace);
            await sendMessageOn(this.deps.ctx, parent, childId, [{ type: 'text', text: prompt }], ac.signal);
            const result = await settled;
            if (!result)
                return '';
            const text = stripProtocolMarkers(blocksToText(result.output));
            return text ? truncateText(text, 4000) : '';
        }
        catch {
            return '';
        }
        finally {
            ac.abort();
        }
    }
    /**
     * 复用会话方式派发一个任务（spec 010 AC3.3/AC3.4）。
     *
     * ## 流程
     *
     *   1. 借并发槽（与 ONE-SHOT 共用信号量）；
     *   2. 复用键 `需求键|provider|preset` 查已有持久子会话：
     *      有 ⇒ `sendMessage` 续投本轮任务；无 ⇒ `startContinuable` 建立并登记；
     *   3. **先挂观测再投递**（事件可能同步到达），返回合成的 `{ id, result }`；
     *   4. `result` 落定时归还并发槽。
     *
     * ## 为什么返回"合成 run"而不是直接收口
     *
     * `host/api.ts#launchRun` 的全部收口逻辑（绑 runId / 判定 stopReason / 落 attempt /
     * 触发自动链式与回写）都挂在 `run.result` 上。合成一个只读子集形状的句柄，
     * 让复用路径**复用它**，而不是再写一遍收口 —— 两套收口必然漂移。
     *
     * ## 超时（AC3.4）
     *
     * 观测不到收口 ⇒ 合成 `stopReason:'error'` + 可读诊断，任务按失败收口，
     * **绝不**留在 running 上。
     *
     * @param input - 派发入参。
     * @returns 句柄；不可复用时抛可读错误（由调用方回退到 ONE-SHOT）。
     */
    async launchReusedTask(input) {
        const reuseKey = `${input.requirementId}|${input.role.provider}|${input.role.preset ?? ''}`;
        // E6：同一复用键串行。**先排队再借并发槽** —— 否则排队的任务会白白占着一个槽位，
        // 把其它需求的可运行任务饿死（并发槽是全局稀缺资源）。
        const releaseTurn = await this.acquireReuseTurn(reuseKey);
        const existing = this.deps.board?.getTaskSession(input.requirementId, reuseKey);
        let slotTaken = false;
        let released = false;
        const release = () => {
            if (released)
                return;
            released = true;
            // D5：无论成功/失败/取消，落定即注销本轮取消现场，避免注册表无界增长与陈旧引用。
            this.activeReuse.delete(input.taskId);
            if (slotTaken)
                this.deps.slot?.release();
            releaseTurn();
        };
        try {
            // 借槽必须在 try 内：排队超时会抛 DispatchError，抛在 try 外会漏掉 releaseTurn，
            // 那会让该复用键的 gate 永远留在 reuseTurns 里，后续任务在 acquireReuseTurn 里死等。
            await this.deps.slot?.acquire();
            slotTaken = true;
            const ac = new AbortController();
            if (existing) {
                // D6：本轮 turn = 子会话当前 turn 数 + 1（投递前读，best-effort；读不到按 1 处理）。
                const turn = (await this.currentTurn(existing)) + 1;
                // D5：登记本轮取消现场（外部 cancelReusedTask 据此中断投递/等待并请求宿主中断当前轮）。
                this.activeReuse.set(input.taskId, { childId: existing, reuseKey, controller: ac });
                // ⚠️ 先挂观测再投递：continuable 没有 per-message result，只能靠事件/轮询观测。
                const settled = this.watcher.waitForChildSettle(existing, this.deps.taskSettleTimeoutMs, ac.signal);
                await sendMessageOn(this.deps.ctx, input.parent, existing, input.prompt, ac.signal);
                return { id: existing, reused: true, turn, result: this.toResult(settled, release, input.taskId) };
            }
            const provider = this.pickProvider();
            if (!provider)
                throw new Error(`${this.providerGapReason()}，无法复用/建立任务子会话`);
            const { childId } = await startContinuableOn(this.deps.ctx, {
                provider,
                label: `任务 ${input.taskId}`,
                request: {
                    prompt: input.prompt,
                    parent: input.parent,
                    agentOptions: {
                        ...(input.frozenConfig.model ? { model: input.frozenConfig.model } : {}),
                        ...(input.frozenConfig.model && input.frozenConfig.modelProvider
                            ? { provider: input.frozenConfig.modelProvider }
                            : {}),
                        ...(input.frozenConfig.maxTokens && input.frozenConfig.maxTokens > 0
                            ? { maxTokens: Math.floor(input.frozenConfig.maxTokens) }
                            : {}),
                    },
                    ...(input.frozenConfig.maxDepth && input.frozenConfig.maxDepth > 0
                        ? { maxDepth: Math.floor(input.frozenConfig.maxDepth) }
                        : {}),
                },
                signal: ac.signal,
            });
            const sessionId = String(childId);
            this.deps.board?.putTaskSession(input.requirementId, reuseKey, sessionId);
            // D5：回填真实 childId（注册时新会话 id 尚未产生）。
            this.activeReuse.set(input.taskId, { childId: sessionId, reuseKey, controller: ac });
            const settled = this.watcher.waitForChildSettle(sessionId, this.deps.taskSettleTimeoutMs, ac.signal, {
                mayHaveSettled: true,
            });
            // D6：新建子会话首轮 turn = 1。
            return { id: sessionId, reused: false, turn: 1, result: this.toResult(settled, release, input.taskId) };
        }
        catch (e) {
            release();
            throw e;
        }
    }
    /**
     * 读取某 continuable 子会话当前的最大 turn 序号（D6，best-effort）。
     * @param childId - 子会话 id。
     * @returns 最大 turn；读不到（无 sessionQuery / 会话不可读 / 无事件）返回 0。
     */
    async currentTurn(childId) {
        const sq = this.deps.getSessionQuery?.();
        if (!sq || typeof sq.observeSession !== 'function')
            return 0;
        let obs;
        try {
            obs = await sq.observeSession(childId, { projectionMode: 'none' });
            let max = 0;
            for (const ev of obs.events ?? []) {
                const t = ev?.data?.turn;
                if (typeof t === 'number' && Number.isFinite(t) && t > max)
                    max = t;
            }
            return max;
        }
        catch {
            return 0;
        }
        finally {
            releaseObservation(obs);
        }
    }
    /**
     * 取消一条复用中的任务（D5）。
     *
     * 顺序：① 以 aborted 结果注入观测，让本轮等待立即收口（触发 turn/槽释放、看板按取消收口）；
     * ② abort 本轮 controller，终止尚未被 inbox 接受的投递；③ best-effort 请求宿主中断子会话当前轮。
     * @param taskId - 看板任务 id。
     * @returns 是否命中复用任务（false = 非复用路径，调用方回退 ONE-SHOT 取消）。
     */
    cancelReusedTask(taskId) {
        const live = this.activeReuse.get(taskId);
        if (!live)
            return false;
        const { childId, controller } = live;
        this.watcher.injectSettle(childId, {
            stopReason: 'aborted',
            output: [],
            diagnostic: '任务已被用户取消',
        });
        controller.abort();
        // 中断子会话当前轮（best-effort；宿主不支持/授权失败时静默 —— 至少本轮等待已收口、槽已释放）。
        try {
            interruptChildOn(this.deps.ctx, childId, this.deps.getParent());
        }
        catch {
            /* 见方法注释：降级为仅本地收口 */
        }
        return true;
    }
    /**
     * 释放某需求名下全部 continuable 任务子会话（D4，restoreRequirement 调用）。
     * @param sessionIds - 待释放的子会话 id 列表。
     * @returns best-effort；宿主不支持/部分失败时返回可读原因，不阻断还原；全部成功返回 undefined。
     */
    async drainRequirementSessions(sessionIds) {
        const ids = [...new Set(sessionIds)].filter(Boolean);
        if (ids.length === 0)
            return undefined;
        let parent;
        try {
            // 还原需求是典型的"事后"操作（任务早跑完 / dsh 重启过）：走 ensure 链。
            parent = await this.resolveParent();
        }
        catch (e) {
            return `无法解析父会话以释放子会话：${e.message}`;
        }
        const failures = [];
        for (const id of ids) {
            try {
                await drainChildrenOn(this.deps.ctx, parent, [id]);
            }
            catch (e) {
                failures.push(`${id}: ${e.message}`);
            }
        }
        return failures.length ? `部分子会话释放失败：${failures.join('；')}` : undefined;
    }
    /**
     * 取得某复用键的"发言权"（FIFO 串行）。
     *
     * 实现为一条 Promise 链：新来者 await 前一个持有者的完成信号。持有者必须在
     * **本轮任务落定或抛错**时调用返回的释放函数，否则后续任务会永久排队。
     * 观测超时（AC3.4）保证落定**一定**会发生，故不会死锁。
     *
     * @param reuseKey - 复用键。
     * @returns 释放函数（幂等）。
     */
    async acquireReuseTurn(reuseKey) {
        // 等前一个持有者。`catch` 吞掉它的异常（那属于它自己的任务收口，不传染给下一个）。
        for (;;) {
            const prev = this.reuseTurns.get(reuseKey);
            if (!prev)
                break;
            await prev.catch(() => undefined);
            // 只有仍是同一个 gate 时才清理，避免误删别人刚放进来的新 gate。
            if (this.reuseTurns.get(reuseKey) === prev)
                this.reuseTurns.delete(reuseKey);
        }
        let release;
        const gate = new Promise(resolve => {
            release = resolve;
        });
        this.reuseTurns.set(reuseKey, gate);
        let done = false;
        return () => {
            if (done)
                return;
            done = true;
            if (this.reuseTurns.get(reuseKey) === gate)
                this.reuseTurns.delete(reuseKey);
            release();
        };
    }
    /**
     * 把"等待落定"包成 `Promise<SubagentResult>`，并在落定时归还并发槽（AC3.4 的停滞超时降级）。
     */
    toResult(settled, release, taskId) {
        return settled
            .then(r => r ?? {
            stopReason: 'error',
            output: [],
            diagnostic: `复用会话任务连续 ${Math.round(this.deps.taskSettleTimeoutMs / 60_000)} 分钟无新事件（停滞超时，task=${taskId}）。`
                + '可能是子会话卡住（模型死循环 / 工具挂起）或宿主未提供可观测的收口信号。已按失败收口，可重试。',
        })
            .finally(release);
    }
    /**
     * 把一条任务结论合进需求级共享简报（纯写入，落盘由 BoardService 负责）。
     *
     * 只改 `brief` 一个字段：必须**此刻**重读编排上下文再整对象回写，因为
     * `setOrchestration` 是整对象替换，而 `taskSessions` 是本次归纳 await 期间由
     * `putTaskSession` 写进去的。拿 await 之前缓存的快照展开，会把刚登记的子会话 id
     * 一并覆盖掉，下一次复用于是新建会话、旧会话永久泄漏（AC3.3 失效）。
     * 本方法内没有 await，读-写落在同一同步段，不会与 `putTaskSession` 交错。
     */
    mergeIntoBrief(requirementKey, entry) {
        const board = this.deps.board;
        if (!board)
            return;
        const current = board.getOrchestration(requirementKey);
        const base = current?.brief ?? emptyBrief(requirementKey, requirementKey);
        let brief = upsertConclusion(base, entry);
        if (entry.artifacts && entry.artifacts.length > 0)
            brief = mergeArtifacts(brief, entry.artifacts);
        board.setOrchestration(requirementKey, { ...(current ?? { mode: 'off' }), brief });
    }
    /** 编排会话的开工提示词（告诉它职责与边界）。 */
    bootstrapPrompt(requirementKey, input) {
        const titles = input.taskTitles ?? [];
        return [
            `你是需求 ${requirementKey}${input.title ? `（${input.title}）` : ''} 的编排负责人。`,
            '你的职责**只有三件事**：',
            '1. 每个任务完成后，你会收到一条【编排通知】，请按其中的要求给出**简短结论**（SUMMARY: 段）；',
            '2. 在全部任务完成时，你会收到最终总结请求，请给出面向需求评审人的总结；',
            '3. 结论必须基于通知里给出的实际输出，**不要臆造、不要补写你没看到的改动**。',
            '',
            '边界（务必遵守）：',
            '- **不要**自己去改代码、不要派发任务、不要调用任何工具去"帮忙"—— 执行由专职任务智能体完成，你只做归纳；',
            '- 不要用寒暄、复述任务过程或粘贴原始输出来填充结论；',
            '- 结论写给你之后的智能体看，要能直接指导它接着干活（改了什么、注意什么）。',
            ...(titles.length > 0 ? ['', `本需求的任务清单（供你对齐上下文）：${titles.join('、')}`] : []),
        ].join('\n');
    }
    /** 选择编排会话使用的 provider：配置优先，否则取宿主第一个已注册 provider。 */
    pickProvider() {
        const configured = (this.deps.provider ?? '').trim();
        const svc = resolveSubagents(this.deps.ctx);
        const list = typeof svc?.list === 'function' ? svc.list() : undefined;
        const providers = Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
        if (configured) {
            if (providers.includes(configured))
                return configured;
            /**
             * 配置指定的 provider 未注册 ⇒ 返回空串让调用方走 `mode:'off'` + 可读原因，
             * **不**退回 `providers[0]`。原来静默换人：配置写错了却照样在另一个模型上编排，
             * 没有事件、没有原因串、没有降级标记，等于把「误配置」变成「静默的另一种行为」。
             */
            return '';
        }
        return providers[0] ?? '';
    }
    /** provider 不可用时的原因串（`pickProvider` 返回空串时用于说明到底差在哪）。 */
    providerGapReason() {
        const configured = (this.deps.provider ?? '').trim();
        if (configured)
            return `配置的 provider「${configured}」未在宿主注册`;
        return '宿主未注册任何 subagent provider';
    }
}
/** 取任务最后一次尝试的输出文本（供归纳与总结请求使用）。 */
export function lastOutputText(task) {
    for (let i = task.attempts.length - 1; i >= 0; i--) {
        const out = task.attempts[i]?.output;
        if (out && out.trim())
            return out;
    }
    return '';
}
//# sourceMappingURL=orchestrator-session.js.map
/**
 * 「主对话框」的纯逻辑层（可单测，不碰 DOM / 宿主服务）。
 *
 * 三块内容：
 *   1. {@link computeChatPhase} —— 会话体相位，**逐字对齐宿主官方实现**；
 *   2. {@link resolveChatFocusKey} —— 对话框焦点需求键推导（需求行点击切换用）；
 *   3. {@link SessionRefCache} —— 会话引用缓存（grace 释放），修「第二次进入对话框无内容」。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/chat-panel
 */
/** 相位计算所需的会话快照子集（宿主 `SessionSnapshot` 的结构面）。 */
export interface ChatPhaseSession {
    /** 是否空白会话（宿主 `Session.blankBit`）。 */
    blank?: boolean;
    /** 首条 prompt 已发、首个 turn 尚未开始。 */
    awaitingFirstTurn?: boolean;
    /** 是否运行中。 */
    running?: boolean;
    /** 是否尝试过发送（含本地 echo）。 */
    promptAttempted?: boolean;
    /** 历史窗口打开状态（cold / loading / open / error）。 */
    openState?: string;
    /** 子会话地址与父可用性（非子会话为 null）。 */
    subagent?: {
        address?: {
            mode?: string;
        };
        parentAvailable?: boolean;
    } | null;
}
/** 相位计算输入。 */
export interface ChatPhaseInput {
    /** 会话已激活目标数（`conversation.activeTargets.size`）。 */
    activeTargetsSize: number;
    /** 会话快照（见 {@link ChatPhaseSession}）。 */
    session: ChatPhaseSession;
    /**
     * 会话**列表行**的 blank 标志（宿主 `useSessions(state => state.byId[sessionId]?.blank)`）。
     * undefined = 列表行还没到位（“还不知道”）。
     */
    summaryBlank: boolean | undefined;
}
/** 相位计算结果。 */
export interface ChatPhaseResult {
    /** 传给 `conversation.content` 的 phase（settling / hero / active）。 */
    phase: 'settling' | 'hero' | 'active';
    /** 传给 `conversation.content` 的 hero 布尔（与 phase 同源）。 */
    hero: boolean;
    /** 官方口径的壳相位（active / engaging / blank）。 */
    shellPhase: 'active' | 'engaging' | 'blank';
    /** 是否处于 settling（历史回放中 / 父可用性未定）。 */
    settling: boolean;
    /** continuable 子会话的父可用性是否尚未解析。 */
    parentAvailabilityPending: boolean;
}
/**
 * 计算会话体相位。
 *
 * ## 口径来源（已核实，不得漂移）
 *
 * 宿主官方侧边对话 `packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:132-147`
 * 的 `ConversationSlotPanel`：
 *
 * ```ts
 * const active = conversation.activeTargets.size > 0
 *   || (!session.blank && !session.awaitingFirstTurn)
 *   || session.running
 * const shellPhase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
 * const parentAvailabilityPending = session.subagent?.address.mode === 'continuable'
 *   && session.subagent.parentAvailable === undefined
 * const settling = (shellPhase === 'blank' && session.openState === 'loading' && summaryBlank !== true)
 *   || parentAvailabilityPending
 * const hero = shellPhase === 'blank' && (session.openState === 'open' || summaryBlank === true)
 * const phase = settling ? 'settling' : hero ? 'hero' : 'active'
 * ```
 *
 * 本函数**逐字同式**。此前插件自拟的口径缺 `settling` 分支：会话重挂后历史窗口
 * 还在 loading 时会被画成 `active`（输入框浮到顶端、转录区空白，2026-11-03 用户截图），
 * 而官方此时是 `settling`（composer 隐藏、无错误布局）。
 *
 * @param input - 相位输入。
 * @returns 相位结果（phase/hero 与壳相位明细）。
 */
export declare function computeChatPhase(input: ChatPhaseInput): ChatPhaseResult;
/** 焦点需求键推导输入。 */
export interface ChatFocusInput {
    /** 用户在「已领取需求」行上显式点选的需求键（'' = 未显式选）。 */
    explicitKey: string;
    /** 任务表的需求筛选下拉当前值（'' = 全部需求）。 */
    requirementFilter: string;
    /** 进行中需求的去重键列表（列表序）。 */
    activeRequirementKeys: readonly string[];
}
/**
 * 推导主对话框的焦点需求键。
 *
 * 优先级：**显式行点选** > 需求筛选下拉 > 首条进行中需求；
 * 前两档**都必须仍在进行中才生效**（不在进行中即回落下一档）。
 *
 * 为什么前两档都要校验"仍在进行中"：焦点键指向的是正在跑编排的需求，
 * 已完成需求的任务表本来就被剔除（`TaskCenter` 的 `activeTasks`），
 * 若允许焦点停在失效键上，会出现"焦点行标记无处可落 / 对话框与任务表各指一处"
 * 的分裂状态（2026-11-03 问题 1 口径收口）。
 *
 * 为什么要有"显式行点选"：此前只有「筛选下拉 > 首条」两档（`TaskCenter` 旧口径），
 * 多个需求同时执行时对话框永远停在第一条，用户根本不知道下拉还能切对话框
 * （2026-11-03 问题 1）。行点选是唯一与「已领取需求列表」直接绑定的切换入口。
 *
 * @param input - 推导输入。
 * @returns 焦点需求键（无可选需求时为 ''）。
 */
export declare function resolveChatFocusKey(input: ChatFocusInput): string;
/** 本缓存持有的引用最小结构面（宿主 `SessionReference` 满足它）。 */
export interface ReleasableReference {
    release(): void;
}
/**
 * 会话引用缓存：跨组件卸载/重挂**复用同一个会话引用**，grace 期内不重复 retain。
 *
 * ## 为什么需要（2026-11-03 问题 2 根因链，已核实）
 *
 * 插件原实现每次 effect 卸载都 `reference.release()` ⇒ 宿主
 * `ClientSessions.retireScope`（`session-controller/src/client/sessions/service.ts:586-595`）
 * 直接 `manager.drop` + `session.dispose()`（`manager.ts:191-198` / `session.ts:599-611`），
 * **整个 Session 实例与已加载的事件窗口（转录）一起被销毁**。面板卸载/重挂（切走主面板
 * 再回来）后只能重新 retain ⇒ 新建 Session ⇒ `doOpen` 重新拉整段历史（`session.ts:616-643`）。
 * 会话越大这段重拉越慢；一旦 `doOpen`/follow 失败，`openState='error'`、`openError` 置位
 * （`session.ts:634-639`、`876-886`），转录**永久为空**且原布局把输入框顶到转录区顶部
 * ——即用户看到的「第二次进入后看不见对话内容、对话框到顶端」。
 *
 * 本缓存让「切走再回来」直接复用还活着的引用（同一 Session 实例、同一份已加载转录），
 * 不触发重拉；真正无用后延迟 {@link REF_RELEASE_GRACE_MS} 再释放，避免长期占用宿主会话。
 *
 * ## 安全约束
 *
 * - `markStale` **不立刻 release**：点击“重新打开”时旧引用仍被 SessionProvider 渲染着，
 *   立即 release 会让下一次渲染在 `SessionReference.binding` 上抛
 *   “is released”（`service.ts:196-199`）进而摘除面板条目。真正的释放发生在
 *   下一次 {@link acquire} 换新时（effect 体内、setState 之前，React 不会在其间插入渲染）。
 * - 同一键可被多个持有者共享（用户数计数）；只有最后一个持有者离开才进入 grace 倒计时。
 */
export declare class SessionRefCache<Ref extends ReleasableReference> {
    private readonly entries;
    /**
     * 取一个引用：命中且非陈旧则复用（取消待释放），否则经 factory 新建。
     *
     * @param key - 会话键（子会话 id）。
     * @param factory - 未命中时的持有动作（retain）。抛错向上冒泡，由调用方如实展示。
     * @returns 可用引用。
     */
    acquire(key: string, factory: () => Ref): Ref;
    /**
     * 归还一次持有。最后一个持有者离开后延迟释放（grace 期内可被 {@link acquire} 救回）。
     *
     * @param key - 会话键。
     */
    release(key: string): void;
    /**
     * 标记陈旧（「重新打开会话」用）：不立刻释放，下一次 {@link acquire} 换新时释放。
     *
     * @param key - 会话键。
     */
    markStale(key: string): void;
    /** 当前缓存项数（测试/诊断用）。 */
    get size(): number;
    /** 某键是否在缓存中（测试/诊断用）。 */
    has(key: string): boolean;
    private drop;
}
/**
 * 最后一个持有者离开后，引用再保留多久才真正 release（毫秒）。
 *
 * 覆盖「切到别的主面板再回来」「在任务 Tab 间来回切」这类秒级~分钟级往返：
 * grace 内回来零成本复用转录；超时后照常释放，不长期占用宿主会话。
 */
export declare const REF_RELEASE_GRACE_MS: number;
/**
 * 「重新打开会话」的刷新刻度。
 *
 * 会话体（子槽组件）能读到 `openState='error'`，但**换引用的动作在对话框 effect 里**
 * （只有它持有 retain 生命周期）。两边隔着槽位边界，经此极小 store 传一个递增刻度：
 * 会话体 `markStale` + `bump()` ⇒ 对话框 effect 依赖变化 ⇒ 重新 acquire（换新引用）。
 */
export declare class RefreshTickStore {
    private tick;
    private readonly listeners;
    /** 当前刻度。 */
    getSnapshot(): number;
    /** 刻度 +1 并通知订阅者。 */
    bump(): void;
    /** 订阅刻度变化。 */
    subscribe(fn: () => void): () => void;
}
//# sourceMappingURL=chat-panel.d.ts.map
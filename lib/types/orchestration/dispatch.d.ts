/**
 * 需求编排分发（T024 / FR-011 / S-06 / S-09）。
 *
 * 负责把"一个需求下的一组任务"交给宿主 subagent 并发执行：
 * - 并发信号量：同时运行的 run 数不超过 `maxConcurrentRequirements`（S-06）；超额进入 FIFO 排队，
 *   排队中状态对 UI 可见（US3 T044）；
 * - 每需求追踪：每次 dispatch 记录 `requirementId → runId`（S-09，每需求独立 session 的可追溯性）；
 * - 请求构造严格使用已核实的 `SubagentStartRequest` 真实字段（来自 dsh-subagent 的 types.d.ts）：
 *   `prompt: ContentBlock[]`、`parent: Agent`（必填）、`signal: AbortSignal`（必填）、
 *   `agentOptions`（承载 model/provider）、`agentPreset`、`maxDepth`。
 *
 * **关于 per-requirement session（S-09）**：当前实现为每个任务发起 ONE-SHOT run（各自一个 session，
 * run.id 即子会话 id），并在分发器内按 requirementId 归组追踪。会话复用（continuable）由
 * `host/orchestrator-session.ts` 承担，本文件预留 `runsForRequirement` 供上层聚合。
 *
 * **关于 parent（必填）**：`SubagentStartRequest.parent` 必须是真实的宿主 Agent（spawning agent）。
 * 插件运行在宿主 Agent 会话内，由宿主接线层（slots.ts / 工具层）在调用 `dispatch` 时注入当前 Agent，
 * 本模块不臆造 parent。
 *
 * **关于"所选技能 / MCP"**（2026-10-29 修正）：宿主 `SubagentStartRequest` **没有**
 * `toolFilter` / `persona` 字段（tsc 会报 `TS2353`），`ctx.tools.restrict()` 又只接受
 * **scoped** 上下文（`packages/core/tools/src/index.ts:1108`），插件无法从宿主半限制子会话可见工具。
 * 因此技能/MCP 的"强制"落在 prompt 下发 + 落定后验收两条路径上，
 * 见 `shared/capability-plan.ts` 与 `host/api.ts#prepareCapabilitySection`。
 *
 * 本模块仅依赖已核实的宿主类型（@deepseek-ai/dsh-subagent / dsh-llm / dsh-agent），
 * 不直接 import cordis，便于在宿主接线层注入 `ctx.subagents`。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/orchestration/dispatch
 */
import type { SubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { RoleDefinition } from './roles.js';
import type { FrozenConfig } from '../core/board/task.js';
import type { RunTimeoutEvidence } from '../shared/run-timeout.js';
/** 宿主 subagent 服务（ctx.subagents 的结构化子集）。 */
export interface SubagentClient {
    /** 按 provider 名发起一个 ONE-SHOT 子 agent。 */
    start(name: string, request: SubagentStartRequest): SubagentRun | Promise<SubagentRun>;
}
/** 单次分发请求（调用方按任务提供）。 */
export interface DispatchRequest {
    /** 需求 dedupKey（S-09 归组用）。 */
    requirementId: string;
    /** 任务 id。 */
    taskId: string;
    /** 指派角色（绑定 provider / preset / 默认配置）。 */
    role: RoleDefinition;
    /** 创建时冻结的配置（MCP / 技能 / 模型）。 */
    frozenConfig: FrozenConfig;
    /** 执行 Prompt（作为子 agent 的首条 user 消息）。 */
    prompt: ContentBlock[];
    /** 可选短标签（持久化到子会话）。 */
    label?: string;
    /** 可选 agent preset id（宿主 `SubagentStartRequest.agentPreset`）。 */
    agentPreset?: string;
    /** 可选委派深度上限（问题 1：限制孙 agent 无限派生；缺省由分发器构造默认值兜底）。 */
    maxDepth?: number;
    /**
     * 可选单次模型响应输出 token 上限（问题 1：0/缺省 = 不设置，沿用模型默认）。
     * 透传到 `AgentOptions.maxTokens`，与 prompt 里的执行纪律一起限制单次回复膨胀。
     */
    maxTokens?: number;
}
/** 运行时分发上下文（宿主接线层注入）。 */
export interface DispatchContext {
    /** 宿主当前 Agent（SubagentStartRequest.parent 必填）。 */
    parent: Agent;
    /** 取消信号（可选；缺省用内部 AbortController）。 */
    signal?: AbortSignal;
}
/** 分发结果。 */
export interface DispatchResult {
    taskId: string;
    requirementId: string;
    /** 子 run id（即子会话 id）。 */
    runId: string;
    /** 所用 provider 名。 */
    provider: string;
}
/** 分发错误（信号量/启动失败）。 */
export declare class DispatchError extends Error {
    constructor(message: string);
}
/**
 * 解析一次派发实际生效的 LLM 路由（model + provider），spec 009 US1/US2 的唯一回落口径。
 *
 * ## 为什么必须成对解析
 *
 * 宿主 `resolveChildAgentOptions`
 * （`packages/subagent/subagent/src/child-agent.ts:109-116`）对未显式指定 provider/model
 * 的子 agent **继承父聊天会话的当前路由**；宿主自带的子智能体工具也强制
 * "child LLM provider and model must be supplied together"
 * （`packages/subagent/tool-subagent/src/model-selection.ts:112-114`）。
 * 旧实现只传裸 model id，provider 被父会话（用户现场为英伟达 nvida）继承，
 * 于是"选火山方舟 deepseek-v4-flash 实际跑在英伟达"。
 *
 * 回落层级（每层 provider 与 model 同层取，禁止跨层错配）：
 *   1. 任务冻结配置 `frozenConfig.model/modelProvider`（执行面板/任务编辑显式选择）；
 *   2. 角色默认 `role.defaultModel/defaultModelProvider`；
 *   3. 都为空 → `{ model: '' }`，dispatcher 不下发 model/provider，完全继承父会话（旧语义）。
 *
 * provider trim 后为空串一律不返回该键（落盘时也不写键，保持旧 JSON 形状稳定）。
 *
 * @returns 非空 model 时可能带 modelProvider；model 为空时两者都无。
 */
export declare function resolveFrozenModelRoute(input: {
    frozen?: Pick<FrozenConfig, 'model' | 'modelProvider'>;
    role?: Pick<RoleDefinition, 'defaultModel' | 'defaultModelProvider'>;
}): {
    model: string;
    modelProvider?: string;
};
/** 分发器运行选项（毫秒；缺省值面向真实 dsh web，测试可压到毫秒级）。 */
export interface DispatcherTimeouts {
    /**
     * `client.start` 必须在该时间内返回 run 句柄，否则判启动失败。
     * 默认 60s：覆盖宿主冷启动/排队，同时保证"永远 pending"不会造成假执行与槽位泄漏。
     */
    startTimeoutMs?: number;
    /**
     * 排队等待并发槽的最长时间，超时抛 DispatchError（默认 5 分钟）。
     * 等待者尚未占用槽位，超时不涉及 release。
     */
    queueTimeoutMs?: number;
    /**
     * 单次 run 的**总运行时长看门狗**（问题 1：防死循环 / 防失控空转烧 token）。
     * 从 run 成功启动开始计时；超过该时长仍未落定，则 abort 信号并 dispose 终止子 agent，
     * 任务随之按失败（超时）收口。0/缺省 = 不启用总时长限制（仍保留启动/排队超时）。
     */
    runTimeoutMs?: number;
    /**
     * 到点后的**活性宽限**（毫秒，2026-11-04）。
     *
     * 到点先探一次子会话活动（{@link DispatcherTimeouts.probeActivity}）：最近仍有新事件 ⇒
     * 判为正常长任务，再宽限这么久才终止（**只宽限一次**，总时长上界 = runTimeoutMs + grace）；
     * 最近没有活动 ⇒ 直接按"失控空转"终止。0/缺省 = 不探测、到点即终止（旧行为）。
     */
    runTimeoutGraceMs?: number;
    /**
     * 子会话活性巡检间隔（毫秒，2026-11-04）。
     *
     * 只在配了 `runTimeoutGraceMs` 时生效：每隔这么久探一次"最近还有事件吗"，
     * 空闲超过 grace 就**立刻**按空转终止（不必等总时长到点）—— 真死循环不再白占并发槽两小时。
     * 缺省按 grace/4 推导（下限 1s，仅测试用得上这么小）。
     */
    stallCheckMs?: number;
    /**
     * 子会话活性探针（2026-11-04）：入参 runId，返回**最后一次会话事件的时刻**（epoch ms）。
     *
     * 不可观测时返回 undefined（服务缺失/会话已被清理）—— 调用方必须把"不知道"当成
     * "不能据此判空转"，退回按总时长终止，绝不能因为探不到就更早杀掉。
     */
    probeActivity?: (runId: string) => Promise<number | undefined>;
    /**
     * 委派深度的默认上限（问题 1）。当 {@link DispatchRequest.maxDepth} 缺省/为 0 时用它兜底，
     * 防止上层漏传导致孙 agent 无限派生；通常取插件配置 `defaultMaxDepth`（默认 1）。0 = 不限制。
     */
    defaultMaxDepth?: number;
    /**
     * 单次模型响应输出 token 的默认上限（问题 1）。当 {@link DispatchRequest.maxTokens} 缺省/为 0
     * 时用它兜底，限制单次回复膨胀；通常取插件配置 `defaultMaxTokens`（默认 0 = 不限制）。
     */
    defaultMaxTokens?: number;
}
/**
 * 看门狗终止原因（2026-11-04）。
 *
 * 旧实现只有一句"超过上限，可能存在死循环" —— 而真机上被掐死的那个 run 其实**刚刚产出完整报告**
 * （见 `.workbuddy/memory/2026-11-04.md`），把正常长任务说成死循环会误导用户去做无谓排查。
 * 现在按证据分两档；证据结构定义在 `shared/run-timeout.ts`（纯逻辑，可单测），这里只做别名。
 */
export type RunTimeoutDetail = RunTimeoutEvidence;
/**
 * 需求并发分发器：信号量 + 每需求 run 追踪。
 */
export declare class RequirementDispatcher {
    private readonly client;
    private readonly maxConcurrent;
    private active;
    private readonly waiters;
    /** taskId → runId（S-09 追踪）。 */
    private readonly runs;
    /** taskId → run 句柄（上层订阅 result 用）。 */
    private readonly runHandles;
    /** requirementId → taskId[]（S-09 归组）。 */
    private readonly byRequirement;
    /** 被总时长看门狗终止的任务（问题 1）；上层收口时 consume 一次以落"超时失败"诊断。 */
    private readonly timedOut;
    /**
     * taskId → 终止证据（2026-11-04）：实际跑了多久、最后一次活动距今多久、是否用过宽限。
     * 上层收口时取一次即删（与 {@link timedOut} 同生命周期）。
     */
    private readonly timeoutDetails;
    /**
     * taskId → 在跑的 run 上下文。
     *
     * 取消、看门狗终止与并发槽归还都只认这一份记录：槽位必须由**所有**退出路径归还
     * （run 落定 / 看门狗终止 / 显式取消），挂在 `run.result.then` 上单点释放会在
     * 「看门狗 abort+dispose 没能让 result 落定」时永久漏掉一个槽。
     */
    private readonly activeRuns;
    constructor(client: SubagentClient, maxConcurrent: number, timeouts?: DispatcherTimeouts);
    /** 子 run 启动超时（毫秒）。 */
    private readonly startTimeoutMs;
    /** 排队等待并发槽超时（毫秒）。 */
    private readonly queueTimeoutMs;
    /** 单次 run 总运行时长看门狗（毫秒；0 = 不启用）。 */
    private readonly runTimeoutMs;
    /** 到点活性宽限（毫秒；0 = 不探测、到点即终止）。 */
    private readonly runTimeoutGraceMs;
    /** 活性巡检间隔（毫秒；0 = 不巡检，只在总时长到点时判一次）。 */
    private readonly stallCheckMs;
    /** 子会话活性探针（缺省 = 无活性判据，只按总时长终止）。 */
    private readonly probeActivity?;
    /** 委派深度默认上限（0 = 不限制）。 */
    private readonly defaultMaxDepth;
    /** 单次输出 token 默认上限（0 = 不限制）。 */
    private readonly defaultMaxTokens;
    /**
     * 取出并清除某任务的"看门狗超时"标记（问题 1）。
     * 上层在 `run.result` 收口时调用：返回 true 表示该 run 是被总时长看门狗终止的，
     * 应据此收口为失败并给出"运行超时"诊断，而不是沿用 run 自报的落定原因。
     */
    consumeTimeout(taskId: string): boolean;
    /**
     * 取出并清除某任务的**超时证据**（2026-11-04）。
     *
     * 与 {@link consumeTimeout} 配对：先 consume 判定"是否被看门狗终止"，再取证据生成诊断文案。
     * 取不到（旧调用方/证据已被取走）时返回 undefined，调用方应退回中性文案。
     */
    takeTimeoutDetail(taskId: string): RunTimeoutDetail | undefined;
    /**
     * 丢弃某任务的追踪记录（收口后调用）。
     *
     * 由上层在**已经消费完** {@link consumeTimeout} 之后调用：`timedOut` 早于消费者
     * 注册的 `run.result.then` 就删除，会让「运行超时」诊断退化成普通失败，因此本方法
     * 不在这里清 `timedOut`，只清 runId / run 句柄 / 需求归组，避免长驻进程按累计任务数
     * 单调增长（每个 handle 都持有整棵会话图引用）。
     *
     * @param taskId - 任务 id。
     */
    forget(taskId: string): void;
    /** 当前并发运行数。 */
    get activeCount(): number;
    /** 当前排队等待数。 */
    get queuedCount(): number;
    /**
     * 取某任务当前的 run 句柄（US3：把 run 的最终结果回绑到看板任务状态）。
     *
     * **为何需要**：`dispatch()` 在子 agent **启动后**立即返回（不等它跑完），若不暴露句柄，
     * 上层就无法知道 run 何时结束/失败，看板任务会永远停在 `running`。上层可据此订阅
     * `run.result` 并把结果落成看板状态（见 `host/api.ts#dispatch`）。
     *
     * @param taskId - 任务 ID。
     * @returns run 句柄；未分发或已 cancel 时返回 undefined。
     */
    getRun(taskId: string): SubagentRun | undefined;
    /** 某需求下的全部 runId（S-09）。 */
    runsForRequirement(requirementId: string): string[];
    /**
     * 获取一个并发槽（FIFO；达上限则排队等待）。
     *
     * 排队带超时（queueTimeoutMs）：当已有槽位被悬挂 run 长期占用时，后来的任务不会无限等
     * 死，而是抛 DispatchError 让上层把任务收口为失败（避免"排队中"也变成假执行）。
     */
    private acquire;
    /**
     * 释放一个并发槽：若有排队者则转移槽位（active 不降），否则 active 减一（S-06）。
     */
    private release;
    /**
     * 借用一个并发槽（spec 010）。
     *
     * `dispatchContinuable` 在宿主侧（`host/orchestrator-session.ts`），因为它要观测
     * continuable 的收口；但并发上限必须与 ONE-SHOT **共用同一个信号量**，
     * 否则"复用了会话就顺手绕开 maxConcurrentRequirements"，并发会静默放大。
     *
     * @returns 拿到槽位后 resolve；排队超时以 DispatchError reject。
     */
    acquireSlot(): Promise<void>;
    /** 归还一个并发槽（与 {@link acquireSlot} 成对；重复归还不会把 active 降到负数）。 */
    releaseSlot(): void;
    /**
     * 分发单个任务给角色智能体执行。
     * @param req - 分发请求。
     * @param ctx - 运行时上下文（parent / signal）。
     * @returns 分发结果（含 runId）。
     */
    dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult>;
    /**
     * 装上单次 run 的总时长看门狗（问题 1；2026-11-04 增加活性判定与终止证据）。
     *
     * 到点不再无条件终止，而是分两步：
     *   1. 有活性探针且配了宽限 ⇒ 先探"最后一次会话事件是什么时候"；
     *      - 最近仍有活动（`now - lastEvent < grace`）⇒ 判正常长任务，**宽限一次**（再等 grace，
     *        之后无条件终止，保证总时长有硬上界）；
     *      - 最近长时间无活动 ⇒ 判疑似失控空转，立即终止；
     *      - 探不到（服务缺失/会话被清理）⇒ **不据此提前杀**，按总时长终止（fail-open）。
     *   2. 无探针/未配宽限 ⇒ 到点即终止（旧行为）。
     *
     * 无论哪条路终止，都写一份 {@link RunTimeoutDetail}，让上层如实说明"跑了多久、最后一次活动
     * 距今多久"，而不是笼统断言"可能存在死循环"。
     */
    private armRunWatchdog;
    /**
     * 取消一个任务对应的 run。
     *
     * 取消必须**真正停掉子 agent**：abort 内部信号 + dispose run 句柄 + 归还并发槽，
     * 三件都做。只删追踪键会让失控 run 继续烧 token 并占着一个并发槽，
     * 三个失控 run 就把 `maxConcurrentRequirements` 全部占满，后续派发只能排队超时。
     *
     * @param taskId - 任务 id。
     */
    cancel(taskId: string): Promise<void>;
}
//# sourceMappingURL=dispatch.d.ts.map
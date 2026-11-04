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
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { ContentBlock } from '@deepseek-ai/dsh-llm';
import type { SubagentResult } from '@deepseek-ai/dsh-subagent';
import type { RequirementOrchestration } from '../tfs/types.js';
import type { TaskSnapshot } from '../core/board/task.js';
import type { BoardService } from './board-service.js';
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
export declare class ChildSettleWatcher {
    private readonly deps;
    /** childId → 等待者集合。 */
    private readonly waiters;
    /** childId → 本轮是否已观测到 running（避免把"尚未开工"当成已收口）。 */
    private readonly sawRunning;
    /**
     * childId → 最近一次观测到的事件数（2026-10-31：停滞超时判活跃度）。
     *
     * 复用会话的 turn 可能跑 88 分钟真活（2030877 现场：204 步、310 次工具调用），
     * 绝对 30 分钟超时会把长任务误判为失败。改为**停滞超时**：只要事件数还在增长
     * （本轮仍在产出），就不算停滞；连续 `timeoutMs` 无新事件才算卡死。
     */
    private readonly eventCounts;
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
    private readonly lateSettles;
    constructor(ctx: Context, deps?: {
        getSessionQuery?: () => unknown;
        pollIntervalMs?: number;
    });
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
    waitForChildSettle(childId: string, timeoutMs: number, signal?: AbortSignal, opts?: {
        mayHaveSettled?: boolean;
    }): Promise<SubagentResult | undefined>;
    /** 落定某 childId：有人等就交给等待者，没人等就存进 `lateSettles` 等晚挂方来取。 */
    private settle;
    /**
     * 由外部（用户取消）注入一个落定结果：childId 有等待者则立即交付，否则按晚到落定存放。
     *
     * D5 配套：复用任务取消时，让**本轮等待**以明确的 `aborted` 结果收口（并触发槽/turn 释放），
     * 而不是 `AbortController.abort()` 后 waitForChildSettle 得到 undefined、再被 toResult 误判成
     * "超时未收口"错误。
     */
    injectSettle(childId: string, result: SubagentResult): void;
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
    private settleFromSessionLog;
}
/** 编排会话管理依赖（全部**函数式**注入，便于桩测）。 */
export interface OrchestratorSessionDeps {
    /** 宿主上下文（取 subagent 服务、注册生命周期监听）。 */
    ctx: Context;
    /** 看板服务（读写 `requirement.orchestration` / 任务级编排字段）。 */
    board?: BoardService;
    /** 取当前父 Agent（`SubagentStartRequest.parent` 必填，不可伪造）。 */
    getParent: () => Agent;
    /**
     * 可选：同步链拿不到父会话时**现场准备**一个（2026-11-03，同 `HostApiDeps.ensureParent`）。
     *
     * 编排的每个动作（建会话 / 归纳 / 总结 / 追问）都要一个 live 父 Agent；用户关掉会话、
     * dsh 重启后再触发这些动作，只有同步链就必然失败。缺省时退回 `getParent`。
     */
    ensureParent?: (workspace?: string) => Promise<Agent>;
    /** 惰性取 sessionQuery（兜底观测）。 */
    getSessionQuery?: () => unknown;
    /** 编排主 agent 使用的 provider 名；为空时取宿主第一个可用 provider。 */
    provider: string;
    /** 是否启用编排主 agent（配置）。 */
    enabled: boolean;
    /** 等待主 agent 归纳的超时（毫秒）。 */
    summarizeTimeoutMs: number;
    /** 等待最终总结的超时（毫秒）。 */
    finalizeTimeoutMs: number;
    /** 编排会话的委派深度上限（沿用任务纪律，防孙 agent 派生）。 */
    maxDepth?: number;
    /** 编排会话的单次输出 token 上限（0 = 不限制）。 */
    maxTokens?: number;
    /**
     * 是否复用任务子会话（AC3.3）。缺省 false。
     *
     * 复用只在编排能力已证明可用（`mode === 'continuable'`）时生效 —— 复用与编排依赖**同一个**
     * continuable 能力，没有理由一边证明不可用、一边还去试。
     */
    reuseTaskSessions?: boolean;
    /** 复用会话任务的收口观测超时（毫秒，AC3.4）。 */
    taskSettleTimeoutMs: number;
    /** 收口观测轮询间隔（毫秒；缺省 15s，测试可调小）。 */
    pollIntervalMs?: number;
    /** 并发槽借用/归还（与 ONE-SHOT 共用信号量，防止复用路径绕开并发上限）。 */
    slot?: {
        acquire: () => Promise<void>;
        release: () => void;
    };
}
/** spec 010：复用会话任务的派发入参（结构面，与 `host/api.ts` 的契约同形）。 */
export interface ReusedTaskLaunchInput {
    /** 需求去重键（复用键左半）。 */
    requirementId: string;
    /** 看板任务 id。 */
    taskId: string;
    /** 发起派发的父 Agent。 */
    parent: Agent;
    /** 消息正文（已含共享简报与执行纪律）。 */
    prompt: ContentBlock[];
    /** 角色（provider / preset）。 */
    role: {
        provider: string;
        preset?: string;
    };
    /** 冻结配置（模型 / MCP / 技能 / 预算）。 */
    frozenConfig: {
        model?: string;
        modelProvider?: string;
        maxDepth?: number;
        maxTokens?: number;
    };
}
/** spec 010：复用会话任务的派发结果（形状对齐 `SubagentRun` 的只读子集）。 */
export interface ReusedTaskLaunchResult {
    /** 子会话 id（复用时 = 既有 childId；新建时 = 新建 continuable childId）。 */
    id: string;
    /** 是否复用了既有会话。 */
    reused: boolean;
    /**
     * 本轮在复用子会话中的 turn 序号（D6）：一次投递对应一个 turn，轨迹据此隔离。
     * 新建子会话恒为 1；复用既有会话为「当前 turn 数 + 1」；读不到会话时可能缺省。
     */
    turn?: number;
    /** 本轮落定结果（由观测器合成，continuable 无 per-message result）。 */
    result: Promise<SubagentResult>;
}
/** 创建编排会话时的初值。 */
export interface OrchestratorBootstrapInput {
    /** 需求标题。 */
    title?: string;
    /** 工作目录（写进简报）。 */
    workspace?: string;
    /** 已绑定工具（写进简报，AC5.2）。 */
    tools?: {
        mcp?: string[];
        skills?: string[];
    };
    /** 任务标题清单（让主 agent 知道全貌）。 */
    taskTitles?: string[];
    /**
     * 强制重试：即使该需求已被判定为"编排不可用"（`mode:'off'`）也再试一次。
     * 供面板「创建编排会话」按钮使用（用户换了 provider / 重启后希望重试）。
     */
    force?: boolean;
    /**
     * 摘要种子（需求自带正文段落压缩而来）。
     *
     * 首个任务还没有 AI 归纳，先用它把简报填起来，避免"第 1 个任务仍下发需求正文全文"。
     * 见 `shared/brief.ts#buildDigestSeed`。
     */
    digestSeed?: string;
}
/**
 * 编排主 agent 会话管理器。
 */
export declare class OrchestratorSessionManager {
    private readonly deps;
    /** 子会话完成观测器（构造时注册宿主事件监听）。 */
    readonly watcher: ChildSettleWatcher;
    /**
     * 复用键 → 当前持有者完成信号（AC3.3 / E6）。
     *
     * **为什么必须串行**：同一个持久子会话只有一条消息队列。若两条任务同时投递，
     * 观测器拿到的 `subagent/end` 无法区分是哪一条任务的收口 ⇒ 结论会串台、任务收口会错配。
     * 串行化后"一次只有一条在跑"，与 AC3.3 的"以 inbox 消息续跑"语义一致。
     */
    private readonly reuseTurns;
    /**
     * 复用任务取消注册表（D5）：看板任务 id → 本轮投递的现场。
     *
     * 复用路径的 `AbortController` 是 launchReusedTask 的局部变量，外部取消原本够不到；
     * 这里登记后，`cancelReusedTask` 能中断投递/等待并请求宿主中断子会话当前轮。
     * FIFO 串行保证同一复用键同一时刻只有一条 active，落定即注销。
     */
    private readonly activeReuse;
    constructor(deps: OrchestratorSessionDeps);
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
    private resolveParent;
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
    private sessionAlive;
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
    ensure(requirementKey: string, input?: OrchestratorBootstrapInput): Promise<RequirementOrchestration>;
    /** {@link ensure} 的真实主体（调用方已持有该需求的 ensure turn）。 */
    private ensureOnce;
    /**
     * 让编排主 agent 归纳一个已完成的任务，并把结论写回共享简报（US2 / AC2.2）。
     *
     * 失败与超时都**不抛错**：记 `summaryState` 后返回，调用方继续放行下一个任务（AC2.2 末句）。
     *
     * @param requirementKey - 需求去重键。
     * @param taskId - 已收口的任务 id。
     * @returns 归纳出的摘要（空串 = 未拿到）。
     */
    summarize(requirementKey: string, taskId: string): Promise<string>;
    /** `summarize` 的串行化实体：一次只发一条归纳请求，落定或抛错都会归还发言权。 */
    private summarizeOnce;
    /**
     * 让编排主 agent 出最终总结（US2 / AC2.4）。
     *
     * @param requirementKey - 需求去重键。
     * @returns 总结文案；拿不到返回 undefined（调用方回退到既有模板总结并标注）。
     */
    finalize(requirementKey: string): Promise<string | undefined>;
    /** `finalize` 的串行化实体（gate 由 {@link OrchestratorSessionManager.finalize} 持有）。 */
    private finalizeOnce;
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
    decide(requirementKey: string, prompt: string, opts?: {
        timeoutMs?: number;
    }): Promise<string>;
    /** `decide` 的串行化实体（gate 由 {@link OrchestratorSessionManager.decide} 持有）。 */
    private decideOnce;
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
    launchReusedTask(input: ReusedTaskLaunchInput): Promise<ReusedTaskLaunchResult>;
    /**
     * 读取某 continuable 子会话当前的最大 turn 序号（D6，best-effort）。
     * @param childId - 子会话 id。
     * @returns 最大 turn；读不到（无 sessionQuery / 会话不可读 / 无事件）返回 0。
     */
    private currentTurn;
    /**
     * 取消一条复用中的任务（D5）。
     *
     * 顺序：① 以 aborted 结果注入观测，让本轮等待立即收口（触发 turn/槽释放、看板按取消收口）；
     * ② abort 本轮 controller，终止尚未被 inbox 接受的投递；③ best-effort 请求宿主中断子会话当前轮。
     * @param taskId - 看板任务 id。
     * @returns 是否命中复用任务（false = 非复用路径，调用方回退 ONE-SHOT 取消）。
     */
    cancelReusedTask(taskId: string): boolean;
    /**
     * 释放某需求名下全部 continuable 任务子会话（D4，restoreRequirement 调用）。
     * @param sessionIds - 待释放的子会话 id 列表。
     * @returns best-effort；宿主不支持/部分失败时返回可读原因，不阻断还原；全部成功返回 undefined。
     */
    drainRequirementSessions(sessionIds: string[]): Promise<string | undefined>;
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
    private acquireReuseTurn;
    /**
     * 把"等待落定"包成 `Promise<SubagentResult>`，并在落定时归还并发槽（AC3.4 的停滞超时降级）。
     */
    private toResult;
    /**
     * 把一条任务结论合进需求级共享简报（纯写入，落盘由 BoardService 负责）。
     *
     * 只改 `brief` 一个字段：必须**此刻**重读编排上下文再整对象回写，因为
     * `setOrchestration` 是整对象替换，而 `taskSessions` 是本次归纳 await 期间由
     * `putTaskSession` 写进去的。拿 await 之前缓存的快照展开，会把刚登记的子会话 id
     * 一并覆盖掉，下一次复用于是新建会话、旧会话永久泄漏（AC3.3 失效）。
     * 本方法内没有 await，读-写落在同一同步段，不会与 `putTaskSession` 交错。
     */
    private mergeIntoBrief;
    /** 编排会话的开工提示词（告诉它职责与边界）。 */
    private bootstrapPrompt;
    /** 选择编排会话使用的 provider：配置优先，否则取宿主第一个已注册 provider。 */
    private pickProvider;
    /** provider 不可用时的原因串（`pickProvider` 返回空串时用于说明到底差在哪）。 */
    private providerGapReason;
}
/** 取任务最后一次尝试的输出文本（供归纳与总结请求使用）。 */
export declare function lastOutputText(task: Pick<TaskSnapshot, 'attempts'>): string;
//# sourceMappingURL=orchestrator-session.d.ts.map
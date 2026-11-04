/**
 * 派发用 parent Agent 的解析（US4 的硬前提）。
 *
 * ## 为什么必须解析真实 Agent，而不是拿 `ctx` 顶替（2026-09-21 假执行事故）
 *
 * `SubagentStartRequest.parent` 会被宿主 in-process subagent 驱动**当真实 Agent 用**：
 *   - `resolveChildDepth`        → `agent.options.subagentDepth`
 *     （`packages/subagent/subagent/src/depth.ts:28-36`）
 *   - `resolveChildAgentOptions` → `agent.session.requestHeader()`
 *     （`packages/subagent/subagent/src/child-agent.ts:69-71`）
 *   - `childSessionMeta`         → `agent.session.header` / `agent.ctx.get('agentPresets')`
 *     （同文件 `:139-145`）
 *   - `captureDelegatedPolicyOverrides` → `agent.ctx.get('permissionPresets').current(agent.session)`
 *     （同文件 `:246-253`）
 *   - `startInProcessRun`        → `agent.ctx.agents.create({ parentAgent: agent, … })`
 *     （`packages/subagent/subagent-in-process-driver/src/index.ts:134-143`）
 *
 * 而 cordis `Context` **没有** `options` / `session` / `inbox` / `status` 中的任何一个
 * （`Agent` 接口见 `@deepseek-ai/dsh-agent` 的 `runtime-types`，这些字段皆为必填）。
 * 旧实现 `getParent: () => ctx as unknown as Agent` 因此在第一个 `agent.options` 取值处
 * 就抛 TypeError：看板任务已被置为 running，子 agent **从未创建**，全程零 token，
 * 失败原因也不落任何 attempt —— 即用户看到的"假执行"。
 *
 * ## 解析顺序（逐级降级，永不伪造）
 *
 * 同步链（`resolve()`，无副作用，任何时候都能调用）：
 *   1. `agents.currentInitiator()` —— 当前调用处在 agent 异步驱动链内时的**精确**答案；
 *   2. 插件自 `agent/created` / `agent/status(running)` 捕获的"最近活跃 Agent"
 *      （取用时用 `agents.get()` 复核存活，并确认它确实是顶层会话）；
 *   3. `agents.roots()` 的最后一个顶层 Agent（多会话并存时的兜底；
 *      语义明确为"最近注册的顶层会话"，不会把 subagent 当 parent）；
 *   4. 都没有 → **抛可读错误**。宁可不派发，也不用假对象制造"执行中"的假象。
 *
 * 异步链（`ensure(workspace?)`，2026-11-03 新增）在同步链失败后**现场准备**一个父会话：
 *   ① `sessionController.resolveAgent(上次见过的会话 id)` —— 把已被回收的会话重新激活
 *      （宿主 `dsh-schedule` 驱动定时任务用的就是这条路径：
 *      `packages/api/session-controller/src/index.ts` → `resolveAgent`）；
 *   ② 注册表里任意存活 Agent（顶层都在同步链用光了，这里只剩"子会话也总比派不出去好"）；
 *   ③ `sessionController.create({ cwd })` —— 新建一个普通会话（宿主给"新对话"建 agent
 *      走的是同一条命令通道）。
 *
 * ### 为什么必须有异步链（2026-11-03 定时执行报错）
 *
 * 旧实现只有同步链，于是"**当前没有活跃会话**"就等于"派发不了"：
 *   - 用户从「工作台」直接发起（还没打开过任何聊天会话）⇒ 必然被拦；
 *   - **定时执行到点的那一刻**，用户早把会话关了 / dsh 重启过 ⇒ 到点必失败。
 *     而调度器是 at-most-once（先摘除落盘再执行），失败即**任务丢失**。
 * 这两类都不是"能力缺失"，而是"会话需要现造"。`ensure` 让派发**不再依赖用户先开会话**。
 *
 * @module dsh-tfs-requirment/host/parent-resolver
 */
import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
/** 宿主 Agent 注册表（`ctx.agents`）的最小结构面，避免 import 宿主包造成装配耦合。 */
export interface AgentRegistryLike {
    /** 读取继承的异步驱动链上的发起 Agent（仅在 agent 上下文内调用时有效）。 */
    currentInitiator?: () => Agent | undefined;
    /** 按会话 id 查存活 Agent。 */
    get?: (id: string) => Agent | undefined;
    /** 全部存活**顶层** Agent（注册顺序）。 */
    roots?: () => Agent[];
    /** 全部存活 Agent（含子会话；注册顺序）。老版本宿主可能没有。 */
    list?: () => Agent[];
}
/**
 * 宿主 "API 会话控制器"（`ctx.sessionController` 的结构切片）。
 *
 * 只声明本模块真正会调的两个方法，避免 import 宿主包：
 *   - `resolveAgent(sessionId)`：把持久化会话**重新激活**成 live Agent
 *     （`dsh-api-session-controller/lib/index.js:3037`；`dsh-schedule` 定时提醒用它）；
 *   - `create({ cwd })`：新建一个普通会话（命令通道，返回 `{ sessionId }`，
 *     之后用 `agents.get(sessionId)` 取 live Agent）。
 */
export interface SessionControllerLike {
    /** 解析/恢复一个普通会话的 live Agent；失败时返回 `{ error }` 而不是抛错。 */
    resolveAgent?: (sessionId: string) => Promise<unknown>;
    /** 新建一个普通会话（`cwd` 省略时宿主用默认工作目录）。 */
    create?: (request: {
        cwd?: string;
    }) => Promise<unknown>;
}
/** 解析器：同步调用 + 异步 `ensure`（现场准备父会话）。 */
export interface ParentResolver {
    /** 同步解析；无可用 Agent 时抛可读错误。 */
    (): Agent;
    /**
     * 同步解析失败时**现场准备**一个父会话（恢复上次会话 / 新建），再返回。
     *
     * @param workspace - 期望的会话工作目录（子会话继承父会话目录，故派发时传任务工作目录）；
     *   不合法或不存在时退回宿主默认目录。
     * @throws 所有降级路径都失败时抛**原始**可读错误（不吞原因）。
     */
    ensure(workspace?: string): Promise<Agent>;
}
/**
 * 当前能否在需要时**准备**出父会话（同步判定，无副作用）。
 *
 * 面板探测用它决定"要不要因为当前没有活跃会话就禁用派发"：
 * 只要 `sessionController.create` 在，就一定能造出一个会话 ⇒ 不该拦。
 */
export declare function canPrepareParent(ctx: Context): boolean;
/**
 * 构造"派发用 parent Agent"的解析器。
 *
 * @param ctx - 宿主上下文（`ctx.get('agents')` 为 Agent 注册表）。
 * @returns 同步解析函数；无可用 Agent 时抛可读错误。附带 `ensure()` 用于现场准备会话。
 */
export declare function createParentResolver(ctx: Context): ParentResolver;
//# sourceMappingURL=parent-resolver.d.ts.map
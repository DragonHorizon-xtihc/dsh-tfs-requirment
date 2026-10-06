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
 * 1. `agents.currentInitiator()` —— 当前调用处在 agent 异步驱动链内时的**精确**答案；
 * 2. 插件自 `agent/created` / `agent/status(running)` 捕获的"最近活跃 Agent"
 *    （取用时用 `agents.get()` 复核存活，并确认它确实是顶层会话）；
 * 3. `agents.roots()` 的最后一个顶层 Agent（多会话并存时的兜底；
 *    语义明确为"最近注册的顶层会话"，不会把 subagent 当 parent）；
 * 4. 都没有 → **抛可读错误**。宁可不派发，也不用假对象制造"执行中"的假象。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/parent-resolver
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 宿主 Agent 注册表（`ctx.agents`）的最小结构面，避免 import 宿主包造成装配耦合。 */
export interface AgentRegistryLike {
  /** 读取继承的异步驱动链上的发起 Agent（仅在 agent 上下文内调用时有效）。 */
  currentInitiator?: () => Agent | undefined
  /** 按会话 id 查存活 Agent。 */
  get?: (id: string) => Agent | undefined
  /** 全部存活**顶层** Agent（注册顺序）。 */
  roots?: () => Agent[]
}

/**
 * 构造"派发用 parent Agent"的解析器。
 *
 * @param ctx - 宿主上下文（`ctx.get('agents')` 为其 Agent 注册表）。
 * @returns 解析函数；无可用 Agent 时抛可读错误。
 */
export function createParentResolver(ctx: Context): () => Agent {
  const registry = (): AgentRegistryLike | undefined => ctx.get('agents') as AgentRegistryLike | undefined
  /** 最近一次"被创建或开始运行"的 Agent id（取用时需复核存活与顶层身份）。 */
  let recentAgentId: string | undefined

  // 两个事件都是 scope-filtered 派发：root 级监听器能收到每个 agent 的生命周期边。
  // 捕获失败（宿主未装 agent 服务 / 事件形状变化）不影响插件加载，仅在派发时降级。
  try {
    ctx.on('agent/created' as never, ((payload: { agent?: Agent }) => {
      if (payload?.agent?.id) recentAgentId = payload.agent.id
    }) as never)
    ctx.on('agent/status' as never, ((payload: { agent?: Agent; status?: string }) => {
      if (payload?.status === 'running' && payload.agent?.id) recentAgentId = payload.agent.id
    }) as never)
  } catch {
    // 事件名在该宿主版本不存在时忽略：解析器退化为 currentInitiator / roots()。
  }

  return () => {
    const reg = registry()
    if (!reg) {
      throw new Error('宿主 agent 注册表不可用（ctx.agents 缺失），无法派发子智能体')
    }
    // 1) 精确通道：调用方就在某个 agent 的驱动链内。
    const initiator = reg.currentInitiator?.()
    if (initiator) return initiator

    // 2) 最近活跃的真实 Agent（必须是存活的**顶层** Agent，避免把 subagent 当 parent）。
    const roots = reg.roots?.() ?? []
    if (recentAgentId) {
      const live = reg.get?.(recentAgentId)
      if (live && roots.some(a => a.id === live.id)) return live
    }

    // 3) 兜底：最近注册的顶层会话。
    const fallback = roots[roots.length - 1]
    if (fallback) return fallback

    throw new Error(
      '无法获取可用的宿主 Agent 会话（既不在 agent 调用链上，注册表里也没有存活的顶层会话）。'
      + '请先在 DSH 中打开一个会话，再从「工作台」派发任务',
    )
  }
}

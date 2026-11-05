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
 * @module @deepseek-ai/dsh-tfs-requirment/host/parent-resolver
 */

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
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
  /** 全部存活 Agent（含子会话；注册顺序）。老版本宿主可能没有。 */
  list?: () => Agent[]
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
  resolveAgent?: (sessionId: string) => Promise<unknown>
  /** 新建一个普通会话（`cwd` 省略时宿主用默认工作目录）。 */
  create?: (request: { cwd?: string }) => Promise<unknown>
}

/** 解析器：同步调用 + 异步 `ensure`（现场准备父会话）。 */
export interface ParentResolver {
  /** 同步解析；无可用 Agent 时抛可读错误。 */
  (): Agent
  /**
   * 同步解析失败时**现场准备**一个父会话（恢复上次会话 / 新建），再返回。
   *
   * @param workspace - 期望的会话工作目录（子会话继承父会话目录，故派发时传任务工作目录）；
   *   不合法或不存在时退回宿主默认目录。
   * @throws 所有降级路径都失败时抛**原始**可读错误（不吞原因）。
   */
  ensure(workspace?: string): Promise<Agent>
}

/** 取 `ctx.sessionController`（非严格：提供方 fiber 未激活时不抛错，返回 undefined）。 */
function sessionControllerOf(ctx: Context): SessionControllerLike | undefined {
  return (ctx.get as (n: string, strict?: boolean) => unknown)('sessionController', false) as
    | SessionControllerLike
    | undefined
}

/**
 * 当前能否在需要时**准备**出父会话（同步判定，无副作用）。
 *
 * 面板探测用它决定"要不要因为当前没有活跃会话就禁用派发"：
 * 只要 `sessionController.create` 在，就一定能造出一个会话 ⇒ 不该拦。
 */
export function canPrepareParent(ctx: Context): boolean {
  const sc = sessionControllerOf(ctx)
  return typeof sc?.create === 'function'
}

/** `resolveAgent` 的返回值形状：`{ agent }` 或 `{ error }`（宿主约定，不抛错）。 */
function pickAgent(result: unknown): Agent | undefined {
  if (!result || typeof result !== 'object') return undefined
  const agent = (result as { agent?: unknown }).agent
  if (!agent || typeof agent !== 'object') return undefined
  const id = (agent as { id?: unknown }).id
  return typeof id === 'string' && id.length > 0 ? (agent as Agent) : undefined
}

/** 只接受**绝对且真实存在**的目录（宿主 create 会把它写进会话 header）。 */
function usableCwd(workspace: string | undefined): string | undefined {
  const value = (workspace ?? '').trim()
  if (!value || !isAbsolute(value)) return undefined
  try {
    return statSync(value).isDirectory() ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * 构造"派发用 parent Agent"的解析器。
 *
 * @param ctx - 宿主上下文（`ctx.get('agents')` 为 Agent 注册表）。
 * @returns 同步解析函数；无可用 Agent 时抛可读错误。附带 `ensure()` 用于现场准备会话。
 */
export function createParentResolver(ctx: Context): ParentResolver {
  const registry = (): AgentRegistryLike | undefined =>
    (ctx.get as (n: string, strict?: boolean) => unknown)('agents', false) as AgentRegistryLike | undefined
  /** 最近一次"被创建或开始运行"的 Agent id（取用时需复核存活与顶层身份）。 */
  let recentAgentId: string | undefined
  /**
   * **曾经**见过的会话 id（不随会话销毁而清除）。
   *
   * 与 {@link recentAgentId} 的区别：后者只用于"还活着就直接用"，这里用于"已经死了就
   * `resolveAgent` 把它拉起来"。会话被回收（面板卸载 / 客户端断开）后，durable 会话仍在
   * 持久层，`resolveAgent` 能原样恢复 —— 比新建一个会话更贴近用户的意图。
   */
  let lastSeenSessionId: string | undefined

  // 两个事件都是 scope-filtered 派发：root 级监听器能收到每个 agent 的生命周期边。
  // 捕获失败（宿主未装 agent 服务 / 事件形状变化）不影响插件加载，仅在派发时降级。
  try {
    ctx.on('agent/created' as never, ((payload: { agent?: Agent }) => {
      if (payload?.agent?.id) {
        recentAgentId = payload.agent.id
        lastSeenSessionId = payload.agent.id
      }
    }) as never)
    ctx.on('agent/status' as never, ((payload: { agent?: Agent; status?: string }) => {
      if (payload?.status === 'running' && payload.agent?.id) {
        recentAgentId = payload.agent.id
        lastSeenSessionId = payload.agent.id
      }
    }) as never)
  } catch {
    // 事件名在该宿主版本不存在时忽略：解析器退化为 currentInitiator / roots()。
  }

  /** 同步链：initiator → 最近活跃顶层 → roots 末尾。 */
  function resolveSync(): Agent {
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

  /** 单飞：并发派发（批量分波）时只准备一次会话，避免一次点击造出 N 个空会话。 */
  let preparing: Promise<Agent> | undefined

  async function prepare(workspace: string | undefined): Promise<Agent> {
    let syncError: unknown
    try {
      return resolveSync()
    } catch (e) {
      syncError = e
    }
    const reg = registry()
    const sc = sessionControllerOf(ctx)

    // ① 把"上次见过的会话"重新激活（宿主定时任务同款路径）。
    if (lastSeenSessionId && typeof sc?.resolveAgent === 'function') {
      try {
        const revived = pickAgent(await sc.resolveAgent(lastSeenSessionId))
        if (revived) {
          recentAgentId = revived.id
          return revived
        }
      } catch {
        // 会话已被删除 / 被 subagent 路由占用（ApiSessionSubagentOwnership）⇒ 继续降级。
      }
    }

    // ② 注册表里还有别的存活 Agent（顶层都在同步链用光了，这里只剩子会话）。
    //    用子会话当 parent 只是"深度 +1"，比"派不出去且任务丢失"好得多。
    const live = reg?.list?.() ?? []
    const anyLive = live[live.length - 1]
    if (anyLive) {
      recentAgentId = anyLive.id
      return anyLive
    }

    // ③ 新建一个会话（宿主 web 的「新对话」走的就是这条命令通道）。
    if (typeof sc?.create === 'function') {
      const cwd = usableCwd(workspace)
      let failure: unknown
      for (const request of cwd ? [{ cwd }, {}] : [{}]) {
        try {
          const created = await sc.create(request)
          const sessionId = (created as { sessionId?: unknown } | undefined)?.sessionId
          if (typeof sessionId === 'string' && sessionId.length > 0) {
            // `create` 在 agent 发布之后才 resolve ⇒ `get` 通常直接命中；
            // 老宿主 / 竞态下再用 `list()` 兜一层（两者都是纯内存读）。
            const agent = reg?.get?.(sessionId) ?? (reg?.list?.() ?? []).find(a => a.id === sessionId)
            if (agent) {
              recentAgentId = agent.id
              lastSeenSessionId = agent.id
              return agent
            }
          }
          failure = new Error(`新建会话后未能取到 live Agent（sessionId=${String(sessionId)}）`)
          // create 已成功：不再用默认目录重试（那只会多造一个空会话）。
          break
        } catch (e) {
          // 目录不被宿主接受时（不存在 / 不是目录 / 与已有会话冲突）退回默认目录再试一次。
          failure = e
        }
      }
      if (failure) {
        // 保留原始同步错误作主体，把"准备会话也失败"的原因附在后面（都是可操作信息）。
        const reason = failure instanceof Error ? failure.message : String(failure)
        throw new Error(`${(syncError as Error).message}；另外自动准备会话也失败：${reason}`)
      }
    }

    throw syncError
  }

  const resolver = (() => resolveSync()) as ParentResolver

  resolver.ensure = (workspace?: string): Promise<Agent> => {
    // 同步命中（绝大多数情况）不进入单飞队列，也不产生任何副作用。
    try {
      return Promise.resolve(resolveSync())
    } catch {
      /* 落到准备流程 */
    }
    preparing ??= prepare(workspace).finally(() => {
      preparing = undefined
    })
    return preparing
  }

  return resolver
}

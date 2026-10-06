/**
 * 需求编排分发（T024 / FR-011 / S-06 / S-09）。
 *
 * 负责把"一个需求下的一组任务"交给宿主 subagent 并发执行：
 * - 并发信号量：同时运行的 run 数不超过 `maxConcurrentRequirements`（S-06）；超额进入 FIFO 排队，
 *   排队中状态对 UI 可见（US3 T044）；
 * - 每需求追踪：每次 dispatch 记录 `requirementId → runId`（S-09，每需求独立 session 的可追溯性）；
 * - 请求构造严格使用已核实的 `SubagentStartRequest` 真实字段（来自 dsh-subagent 的 types.d.ts）：
 *   `prompt: ContentBlock[]`、`parent: Agent`（必填）、`signal: AbortSignal`（必填）、
 *   `agentOptions`（承载 model/provider）、`toolFilter`（承载 MCP/技能工具范围）、`persona`、`maxDepth`。
 *
 * **关于 per-requirement session（S-09）**：当前实现为每个任务发起 ONE-SHOT run（各自一个 session，
 * run.id 即子会话 id），并在分发器内按 requirementId 归组追踪。若宿主支持 `startContinuable`
 * （dsh-subagent 已导出），后续可改为"每需求一个持久 continuable 子会话、任务在其 inbox 内续跑"，
 * 实现真正的单 session 多任务复用；本文件预留 `runsForRequirement` 供上层聚合。
 *
 * **关于 parent（必填）**：`SubagentStartRequest.parent` 必须是真实的宿主 Agent（spawning agent）。
 * 插件运行在宿主 Agent 会话内，由宿主接线层（slots.ts / 工具层）在调用 `dispatch` 时注入当前 Agent，
 * 本模块不臆造 parent。
 *
 * `toolFilter`（MCP/技能选择 → 子 agent 可见工具范围）的真实形状为 dsh-tools 的 `ToolRestriction`，
 * 由宿主接线层依据用户在 ExecutionPanel 勾选的 MCP/技能构建后透传，本模块只做转发（不臆造结构）。
 *
 * 本模块仅依赖已核实的宿主类型（@deepseek-ai/dsh-subagent / dsh-llm / dsh-agent / dsh-tools），
 * 不直接 import cordis，便于在宿主接线层注入 `ctx.subagents`。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/orchestration/dispatch
 */

import type { SubagentStartRequest, SubagentRun } from '@deepseek-ai/dsh-subagent'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { AgentOptions } from '@deepseek-ai/dsh-agent'
import type { ToolRestriction } from '@deepseek-ai/dsh-tools'
import type { RoleDefinition } from './roles.js'
import type { FrozenConfig } from '../core/board/task.js'

/** 宿主 subagent 服务（ctx.subagents 的结构化子集）。 */
export interface SubagentClient {
  /** 按 provider 名发起一个 ONE-SHOT 子 agent。 */
  start(name: string, request: SubagentStartRequest): SubagentRun | Promise<SubagentRun>
}

/** 单次分发请求（调用方按任务提供）。 */
export interface DispatchRequest {
  /** 需求 dedupKey（S-09 归组用）。 */
  requirementId: string
  /** 任务 id。 */
  taskId: string
  /** 指派角色（绑定 provider / preset / 默认配置）。 */
  role: RoleDefinition
  /** 创建时冻结的配置（MCP / 技能 / 模型）。 */
  frozenConfig: FrozenConfig
  /** 执行 Prompt（作为子 agent 的首条 user 消息）。 */
  prompt: ContentBlock[]
  /** 可选短标签（持久化到子会话）。 */
  label?: string
  /** 子 agent 工具范围（由宿主按所选 MCP/技能构建的 ToolRestriction）。 */
  toolFilter?: ToolRestriction
  /** 可选 person 覆盖。 */
  persona?: string
  /** 可选委派深度上限（问题 1：限制孙 agent 无限派生；缺省由分发器构造默认值兜底）。 */
  maxDepth?: number
  /**
   * 可选单次模型响应输出 token 上限（问题 1：0/缺省 = 不设置，沿用模型默认）。
   * 透传到 `AgentOptions.maxTokens`，与 prompt 里的执行纪律一起限制单次回复膨胀。
   */
  maxTokens?: number
}

/** 运行时分发上下文（宿主接线层注入）。 */
export interface DispatchContext {
  /** 宿主当前 Agent（SubagentStartRequest.parent 必填）。 */
  parent: Agent
  /** 取消信号（可选；缺省用内部 AbortController）。 */
  signal?: AbortSignal
}

/** 分发结果。 */
export interface DispatchResult {
  taskId: string
  requirementId: string
  /** 子 run id（即子会话 id）。 */
  runId: string
  /** 所用 provider 名。 */
  provider: string
}

/** 分发错误（信号量/启动失败）。 */
export class DispatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'DispatchError'
  }
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
export function resolveFrozenModelRoute(input: {
  frozen?: Pick<FrozenConfig, 'model' | 'modelProvider'>
  role?: Pick<RoleDefinition, 'defaultModel' | 'defaultModelProvider'>
}): { model: string; modelProvider?: string } {
  const frozenModel = input.frozen?.model?.trim()
  if (frozenModel) {
    const frozenProvider = input.frozen?.modelProvider?.trim()
    return frozenProvider ? { model: frozenModel, modelProvider: frozenProvider } : { model: frozenModel }
  }
  const roleModel = input.role?.defaultModel?.trim()
  if (roleModel) {
    const roleProvider = input.role?.defaultModelProvider?.trim()
    return roleProvider ? { model: roleModel, modelProvider: roleProvider } : { model: roleModel }
  }
  return { model: '' }
}

/** 分发器运行选项（毫秒；缺省值面向真实 dsh web，测试可压到毫秒级）。 */
export interface DispatcherTimeouts {
  /**
   * `client.start` 必须在该时间内返回 run 句柄，否则判启动失败。
   * 默认 60s：覆盖宿主冷启动/排队，同时保证"永远 pending"不会造成假执行与槽位泄漏。
   */
  startTimeoutMs?: number
  /**
   * 排队等待并发槽的最长时间，超时抛 DispatchError（默认 5 分钟）。
   * 等待者尚未占用槽位，超时不涉及 release。
   */
  queueTimeoutMs?: number
  /**
   * 单次 run 的**总运行时长看门狗**（问题 1：防死循环 / 防失控空转烧 token）。
   * 从 run 成功启动开始计时；超过该时长仍未落定，则 abort 信号并 dispose 终止子 agent，
   * 任务随之按失败（超时）收口。0/缺省 = 不启用总时长限制（仍保留启动/排队超时）。
   */
  runTimeoutMs?: number
  /**
   * 委派深度的默认上限（问题 1）。当 {@link DispatchRequest.maxDepth} 缺省/为 0 时用它兜底，
   * 防止上层漏传导致孙 agent 无限派生；通常取插件配置 `defaultMaxDepth`（默认 1）。0 = 不限制。
   */
  defaultMaxDepth?: number
  /**
   * 单次模型响应输出 token 的默认上限（问题 1）。当 {@link DispatchRequest.maxTokens} 缺省/为 0
   * 时用它兜底，限制单次回复膨胀；通常取插件配置 `defaultMaxTokens`（默认 0 = 不限制）。
   */
  defaultMaxTokens?: number
}

/** 带超时的 Promise 竞争：超时后以 makeError() reject，并清理定时器。 */
function withTimeout<T>(p: Promise<T>, timeoutMs: number, makeError: () => Error): Promise<T> {
  if (!(timeoutMs >= 1)) return p
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(makeError()), timeoutMs)
  })
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  }) as Promise<T>
}

/**
 * 终止一个子 run（尽力，不抛）。
 *
 * `dispose` 是可选方法：`run.dispose?.()` 在方法缺失时整体求值为 `undefined`，
 * 紧接着的 `.catch(...)` 就会在 undefined 上调用并抛 `TypeError`——而这正是
 * 「启动超时后迟到 resolve」与「看门狗超时终止」两条**错误清理**路径。
 * 改为主动判型：方法缺失直接跳过，返回值经 `Promise.resolve` 归一（同步返回 void 也不炸）。
 */
function disposeRun(run: SubagentRun | undefined): void {
  if (!run) return
  try {
    const dispose = run.dispose
    if (typeof dispose !== 'function') return
    Promise.resolve(dispose.call(run)).catch(() => {
      // 终止失败不影响收口：run 仍会自行落定，或已被看门狗标记为超时。
    })
  } catch {
    // 同上：终止本身抛错不影响调用方继续收口。
  }
}

/** 在跑的 run 上下文（供取消、看门狗终止与并发槽归还共用同一份状态）。 */
interface ActiveRun {
  /** 宿主 run 句柄。 */
  run: SubagentRun
  /** 分发时建的内部信号（外部取消与看门狗都指向它）。 */
  controller: AbortController
  /** 幂等归还并发槽：run 落定、看门狗终止、显式取消三条路径都会调它。 */
  releaseSlot: () => void
  /** 总时长看门狗定时器（未启用时缺省）。 */
  watchdog?: ReturnType<typeof setTimeout>
}

/**
 * 需求并发分发器：信号量 + 每需求 run 追踪。
 */
export class RequirementDispatcher {
  private active = 0
  private readonly waiters: Array<() => void> = []
  /** taskId → runId（S-09 追踪）。 */
  private readonly runs = new Map<string, string>()
  /** taskId → run 句柄（上层订阅 result 用）。 */
  private readonly runHandles = new Map<string, SubagentRun>()
  /** requirementId → taskId[]（S-09 归组）。 */
  private readonly byRequirement = new Map<string, Set<string>>()
  /** 被总时长看门狗终止的任务（问题 1）；上层收口时 consume 一次以落"超时失败"诊断。 */
  private readonly timedOut = new Set<string>()
  /**
   * taskId → 在跑的 run 上下文。
   *
   * 取消、看门狗终止与并发槽归还都只认这一份记录：槽位必须由**所有**退出路径归还
   * （run 落定 / 看门狗终止 / 显式取消），挂在 `run.result.then` 上单点释放会在
   * 「看门狗 abort+dispose 没能让 result 落定」时永久漏掉一个槽。
   */
  private readonly activeRuns = new Map<string, ActiveRun>()

  constructor(
    private readonly client: SubagentClient,
    private readonly maxConcurrent: number,
    timeouts: DispatcherTimeouts = {},
  ) {
    if (!(maxConcurrent >= 1)) {
      throw new DispatchError('maxConcurrent 必须 ≥ 1（FR-029）')
    }
    this.startTimeoutMs = timeouts.startTimeoutMs ?? 60_000
    this.queueTimeoutMs = timeouts.queueTimeoutMs ?? 300_000
    this.runTimeoutMs = timeouts.runTimeoutMs ?? 0
    this.defaultMaxDepth = timeouts.defaultMaxDepth ?? 0
    this.defaultMaxTokens = timeouts.defaultMaxTokens ?? 0
  }

  /** 子 run 启动超时（毫秒）。 */
  private readonly startTimeoutMs: number
  /** 排队等待并发槽超时（毫秒）。 */
  private readonly queueTimeoutMs: number
  /** 单次 run 总运行时长看门狗（毫秒；0 = 不启用）。 */
  private readonly runTimeoutMs: number
  /** 委派深度默认上限（0 = 不限制）。 */
  private readonly defaultMaxDepth: number
  /** 单次输出 token 默认上限（0 = 不限制）。 */
  private readonly defaultMaxTokens: number

  /**
   * 取出并清除某任务的"看门狗超时"标记（问题 1）。
   * 上层在 `run.result` 收口时调用：返回 true 表示该 run 是被总时长看门狗终止的，
   * 应据此收口为失败并给出"运行超时"诊断，而不是沿用 run 自报的落定原因。
   */
  consumeTimeout(taskId: string): boolean {
    const hit = this.timedOut.has(taskId)
    if (hit) this.timedOut.delete(taskId)
    return hit
  }

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
  forget(taskId: string): void {
    const active = this.activeRuns.get(taskId)
    if (active?.watchdog) clearTimeout(active.watchdog)
    this.activeRuns.delete(taskId)
    this.runs.delete(taskId)
    this.runHandles.delete(taskId)
    for (const [requirementId, set] of this.byRequirement) {
      if (!set.delete(taskId)) continue
      if (set.size === 0) this.byRequirement.delete(requirementId)
    }
  }

  /** 当前并发运行数。 */
  get activeCount(): number {
    return this.active
  }

  /** 当前排队等待数。 */
  get queuedCount(): number {
    return this.waiters.length
  }

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
  getRun(taskId: string): SubagentRun | undefined {
    return this.runHandles.get(taskId)
  }

  /** 某需求下的全部 runId（S-09）。 */
  runsForRequirement(requirementId: string): string[] {
    const ids = this.byRequirement.get(requirementId)
    if (!ids) return []
    return [...ids].map(id => this.runs.get(id)).filter((x): x is string => Boolean(x))
  }

  /**
   * 获取一个并发槽（FIFO；达上限则排队等待）。
   *
   * 排队带超时（queueTimeoutMs）：当已有槽位被悬挂 run 长期占用时，后来的任务不会无限等
   * 死，而是抛 DispatchError 让上层把任务收口为失败（避免"排队中"也变成假执行）。
   */
  private acquire(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) return Promise.reject(new DispatchError('派发在取得并发槽前已被取消（未占用槽位）'))
    if (this.active < this.maxConcurrent) {
      this.active += 1
      return Promise.resolve()
    }
    return new Promise<void>((resolve, reject) => {
      let timer: ReturnType<typeof setTimeout> | undefined
      let settled = false
      let onAbort: (() => void) | undefined
      const detach = (): void => {
        if (timer) clearTimeout(timer)
        if (onAbort) signal?.removeEventListener('abort', onAbort)
      }
      /** 只结算一次（槽位到手 / 超时 / 被取消三者先到者胜）。 */
      const settleWith = (fn: () => void): void => {
        if (settled) return
        settled = true
        detach()
        fn()
      }
      const done = (): void => settleWith(resolve)
      const fail = (message: string): void => {
        settleWith(() => {
          // 尚未占用槽位，退出前把自己从等待队列摘掉（否则 queuedCount 长期虚高）。
          const i = this.waiters.indexOf(done)
          if (i >= 0) this.waiters.splice(i, 1)
          reject(new DispatchError(message))
        })
      }
      onAbort = () => fail('派发在排队等待并发槽时被取消（未占用槽位）')
      timer = setTimeout(
        () => fail(`排队等待并发槽超过 ${this.queueTimeoutMs}ms（并发槽可能被悬挂任务占满）`),
        this.queueTimeoutMs,
      )
      this.waiters.push(done)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /**
   * 释放一个并发槽：若有排队者则转移槽位（active 不降），否则 active 减一（S-06）。
   */
  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.active = Math.max(0, this.active - 1)
    }
  }

  /**
   * 借用一个并发槽（spec 010）。
   *
   * `dispatchContinuable` 在宿主侧（`host/orchestrator-session.ts`），因为它要观测
   * continuable 的收口；但并发上限必须与 ONE-SHOT **共用同一个信号量**，
   * 否则"复用了会话就顺手绕开 maxConcurrentRequirements"，并发会静默放大。
   *
   * @returns 拿到槽位后 resolve；排队超时以 DispatchError reject。
   */
  async acquireSlot(): Promise<void> {
    await this.acquire()
  }

  /** 归还一个并发槽（与 {@link acquireSlot} 成对；重复归还不会把 active 降到负数）。 */
  releaseSlot(): void {
    this.release()
  }

  /**
   * 分发单个任务给角色智能体执行。
   * @param req - 分发请求。
   * @param ctx - 运行时上下文（parent / signal）。
   * @returns 分发结果（含 runId）。
   */
  async dispatch(req: DispatchRequest, ctx: DispatchContext): Promise<DispatchResult> {
    // 把取消信号带进排队：拿到槽位前被取消就不再排队，也不再占用槽位。
    await this.acquire(ctx.signal)
    /**
     * 始终使用内部 AbortController（问题 1 看门狗需要能主动终止 run）：
     * 外部 ctx.signal（宿主取消）abort 时转发给内部信号；总时长看门狗超时也 abort 同一信号。
     */
    const ac = new AbortController()
    if (ctx.signal) {
      if (ctx.signal.aborted) ac.abort()
      else ctx.signal.addEventListener('abort', () => ac.abort(), { once: true })
    }
    const signal = ac.signal
    /** 幂等归还并发槽：run 落定、看门狗终止、启动失败、显式取消共用同一个归还动作。 */
    let slotReleased = false
    const releaseSlot = (): void => {
      if (slotReleased) return
      slotReleased = true
      this.release()
    }
    if (ctx.signal?.aborted) {
      // 排队期间刚好被取消：槽位已在手但不该起子 agent，否则会白烧一次模型调用。
      releaseSlot()
      throw new DispatchError(`派发已取消（task=${req.taskId}）：未启动子 agent`)
    }
    try {
      /**
       * 模型路由：**空串视为"未指定"**，此时不传 `model`/`provider` 字段，让宿主沿用父会话的
       * 默认路由。
       *
       * 为什么不能直接传 `model: ''`（2026-09-21 假执行事故的伴生问题）：看板拆解时冻结的
       * `frozenConfig.model` 常常是空串（角色没配默认模型），而宿主
       * `resolveChildAgentOptions` 是 `...requested` 覆盖式合并——空串会**覆盖**掉父会话
       * 解析出的模型，得到一个不可解析的模型名，子 agent 起不来或行为未定义。
       *
       * spec 009：provider 必须与 model **成对**下发。旧实现只传裸 model id，provider 被
       * 父聊天会话继承（用户现场父会话在英伟达 nvida 上），导致"选火山方舟同名模型却跑在
       * 英伟达"。这里仅在 model 非空、且冻结配置显式带了 modelProvider 时才写 provider，
       * 旧数据（裸 model）维持继承语义。
       */
      const route = resolveFrozenModelRoute({ frozen: req.frozenConfig })
      // 问题 1：单次输出 token 上限（任务级 maxTokens 优先，否则分发器默认兜底；0 = 不设置）。
      const maxTokens =
        req.maxTokens && req.maxTokens > 0
          ? Math.floor(req.maxTokens)
          : this.defaultMaxTokens && this.defaultMaxTokens > 0
            ? Math.floor(this.defaultMaxTokens)
            : 0
      const agentOptions: AgentOptions = {
        ...(route.model ? { model: route.model } : {}),
        ...(route.model && route.modelProvider ? { provider: route.modelProvider } : {}),
        ...(maxTokens > 0 ? { maxTokens } : {}),
      } as AgentOptions
      // 问题 1：委派深度 = 任务级 maxDepth 优先，否则分发器默认（config.defaultMaxDepth）；0 = 不限制不传。
      const maxDepth =
        req.maxDepth && req.maxDepth > 0 ? Math.floor(req.maxDepth) : Math.floor(this.defaultMaxDepth)
      const startRequest: SubagentStartRequest = {
        label: req.label ?? `${req.requirementId}:${req.taskId}`,
        prompt: req.prompt,
        parent: ctx.parent,
        signal,
        agentOptions,
        toolFilter: req.toolFilter,
        persona: req.persona,
        ...(maxDepth > 0 ? { maxDepth } : {}),
      }
      const startPromise = Promise.resolve(this.client.start(req.role.provider, startRequest))
      let run: SubagentRun
      try {
        run = await withTimeout(
          startPromise,
          this.startTimeoutMs,
          () =>
            new DispatchError(
              `子 agent 启动超过 ${this.startTimeoutMs}ms 未返回 run 句柄（task=${req.taskId}，provider=${req.role.provider}），判为启动悬挂并释放并发槽`,
            ),
        )
      } catch (e) {
        // 超时后若 start 最终还是返回了 run（迟到 resolve），尽力销毁，避免孤儿 run 继续消耗。
        startPromise.then(
          late => {
            disposeRun(late)
          },
          () => {},
        )
        throw e
      }
      this.runs.set(req.taskId, run.id)
      this.runHandles.set(req.taskId, run)
      const set = this.byRequirement.get(req.requirementId) ?? new Set<string>()
      set.add(req.taskId)
      this.byRequirement.set(req.requirementId, set)
      // 登记活跃 run：看门狗与显式取消都要经它归还并发槽（落定路径同样复用 releaseSlot）。
      this.activeRuns.set(req.taskId, { run, controller: ac, releaseSlot })
      // 问题 1：装上单次 run 总时长看门狗（防死循环/失控空转）。
      const watchdog = this.armRunWatchdog(req.taskId, run, ac, releaseSlot)
      const active = this.activeRuns.get(req.taskId)
      if (active && watchdog) active.watchdog = watchdog
      // 槽位在 run 落定时释放（S-06 并发上限按运行时长计）。
      run.result.then(releaseSlot, releaseSlot)
      return {
        taskId: req.taskId,
        requirementId: req.requirementId,
        runId: run.id,
        provider: req.role.provider,
      }
    } catch (e) {
      releaseSlot()
      // 用户取消不是执行失败：单独成词，不让上层把取消记成 failed/dispatch-failed。
      if (ctx.signal?.aborted) {
        throw new DispatchError(`派发已取消（task=${req.taskId}）：${(e as Error).message}`)
      }
      // DispatchError 已是可读原因（如启动悬挂），不再套一层「分发失败」。
      const reason = e instanceof DispatchError ? e.message : (e as Error).message
      throw new DispatchError(`分发失败（task=${req.taskId}）：${reason}`)
    }
  }

  /**
   * 装上单次 run 的总时长看门狗（问题 1）。
   *
   * run 启动后开始计时；超过 `runTimeoutMs` 仍未落定，则登记超时标记、abort 信号并 dispose
   * 终止子 agent，使 `run.result` 尽快落定。run 正常落定（成功/失败）时清除定时器。
   * 不启用（runTimeoutMs<1）时直接返回。
   */
  private armRunWatchdog(
    taskId: string,
    run: SubagentRun,
    ac: AbortController,
    releaseSlot: () => void,
  ): ReturnType<typeof setTimeout> | undefined {
    if (!(this.runTimeoutMs >= 1)) return undefined
    const timer = setTimeout(() => {
      if (this.timedOut.has(taskId)) return
      this.timedOut.add(taskId)
      try {
        ac.abort()
      } catch {
        // 信号可能已 abort，忽略。
      }
      disposeRun(run)
      // abort + dispose 不保证 run.result 一定落定（continuable / 跨进程 provider 可能无视信号），
      // 只把归还挂在 run.result.then 上会永久泄漏一个并发槽，因此看门狗自己归还。
      releaseSlot()
    }, this.runTimeoutMs)
    // 无论结果成败，落定即取消看门狗。
    run.result.then(
      () => clearTimeout(timer),
      () => clearTimeout(timer),
    )
    return timer
  }

  /**
   * 取消一个任务对应的 run。
   *
   * 取消必须**真正停掉子 agent**：abort 内部信号 + dispose run 句柄 + 归还并发槽，
   * 三件都做。只删追踪键会让失控 run 继续烧 token 并占着一个并发槽，
   * 三个失控 run 就把 `maxConcurrentRequirements` 全部占满，后续派发只能排队超时。
   *
   * @param taskId - 任务 id。
   */
  async cancel(taskId: string): Promise<void> {
    const active = this.activeRuns.get(taskId)
    if (!active) {
      // 未派发或已收口：只清残留追踪键。
      this.forget(taskId)
      return
    }
    if (active.watchdog) clearTimeout(active.watchdog)
    try {
      active.controller.abort()
    } catch {
      // 信号可能已 abort，忽略。
    }
    disposeRun(active.run)
    active.releaseSlot()
    this.forget(taskId)
  }
}

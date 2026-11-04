/**
 * 宿主 `subagents` 服务的**调用期**解析与可达性探测（US4 编排能力的唯一取用口径）。
 *
 * ## 为什么单独抽一个模块（2026-09-21 实机事故）
 *
 * 旧实现在 `apply()` 期就把服务抓进闭包：`const sub = ctx.get('subagents')`。而
 * cordis 的 `ctx.get(name)` 默认 `strict = true`，**当提供该服务的 fiber 尚未激活
 * （`state !== 2`）时返回 `undefined`**（`vendor/cordis/lib/index.js:762-771`——
 * `if (strict && impl.fiber.state !== 2) return;`）。
 *
 * 本插件 `inject = []`（REST 化后不再静态依赖任何服务），插件模块又极小，
 * 其 `apply` 往往**早于** `@deepseek-ai/dsh-subagent` 的模块动态 `import()` 完成 ⇒
 * apply 期必然拿到 `undefined` ⇒ 旧实现把"永远抛错的桩"钉死在分发器里。
 *
 * 因此本模块把所有取用收敛到**调用时**解析；顺带提供 `probeSubagents`，
 * 让"编排能力到底通不通"在面板上**先于点击**可见，而不是点完才炸。
 *
 * ## 宿主 API 换代（2026-10-29 实机：0.2.1-rc.2 起没有 `start`）
 *
 * 面板报 *「subagents 服务缺少 start 方法（宿主版本不匹配？）」* 的**真实根因**不是没装包，
 * 而是宿主把一次性派发入口换成了 **`startActivation(spec)`**：
 *
 * | 能力 | 旧宿主（≤0.2.0） | 现行宿主（0.2.1+，`packages/subagent/subagent/src/index.ts:194-290`） |
 * |---|---|---|
 * | 一次性派发 | `start(name, request)` | `startActivation({provider,label,request,signal,delivery})` |
 * | continuable 派发 | `startContinuable(spec)` | 由 `startActivation` 统一承担（provider 有 `prepareContinuable` 即本地激活） |
 * | 句柄形状 | `{ id, result, dispose }` | `{ childId, messageId?, result, dispose }` |
 *
 * 因此本模块**按能力探测**：`startActivation` 优先，`start` 作为旧宿主兼容，
 * 两者都没有才判不可用 —— 这样"面板能派发"与"运行期真能派发"永远同源，不会漂移。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/subagent-access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type { SubagentResult, SubagentRun, SubagentStartRequest } from '@deepseek-ai/dsh-subagent'
import type { SubagentClient } from '../orchestration/dispatch.js'

/**
 * 现行宿主的 `SubagentActivation`（`packages/subagent/subagent/src/types.ts:38-53`）。
 *
 * 与 {@link SubagentRun} 的差别只有身份字段名：`childId`（而非 `id`），并多一个
 * 首条消息的 `messageId`。`result`/`dispose` 语义完全一致。
 */
export interface SubagentActivationLike {
  /** 子会话 id（durable）。 */
  readonly childId: string
  /** 首条消息的 inbox id（本地激活必有）。 */
  readonly messageId?: string
  /** 子会话落定结果；模型/传输失败是 **resolve**（stopReason≠completed），只有基础设施故障才 reject。 */
  readonly result: Promise<SubagentResult>
  /** 终止并释放本次激活（幂等）。 */
  dispose?: () => Promise<void>
}

/**
 * 现行宿主的 `SubagentActivationSpec`（同文件 `:19-35`）。
 *
 * `request` 是 `Omit<SubagentStartRequest, 'label' | 'signal'>`：label/signal 已上提到 spec 层
 * —— 少传 `signal` 会被宿主直接判为非法入参，故适配层必须显式补齐。
 */
export interface SubagentActivationSpecLike {
  /** 已注册的 provider 名（`spawn` / `fork` / CLI 适配器等）。 */
  provider: string
  /** 展示用短标签（落进子会话目录）。 */
  label: string
  /** 预留子会话 id（本地 provider 才支持；用于会话复用）。 */
  childId?: string
  /** 任务与可选能力。 */
  request: Omit<SubagentStartRequest, 'label' | 'signal'>
  /** 启动期取消通道（**必填**）。 */
  signal: AbortSignal
  /**
   * 完成投递策略：
   *   - `parent`：向父会话模型投递一条结算消息；
   *   - `caller`：只把结果交给调用方（看板任务用这个，避免批量派发刷满用户聊天）。
   */
  delivery: 'parent' | 'caller'
}

/**
 * `subagents` 服务的结构切片（结构类型，不 import 具体包以免装配耦合）。
 *
 * `start(name, request)` / `startActivation(spec)` 的第一参都是 **provider 名**
 * （`spawn` / `fork` / CLI 适配器等），不是角色名；provider 不存在时宿主会抛可读错误。
 */
export interface SubagentServiceLike {
  /**
   * **现行宿主**的一次性/continuable 统一派发入口（0.2.1+）。
   *
   * 存在性即派发能力：provider 带 `prepareContinuable` ⇒ 本地（可续消息）激活，
   * 否则走外部执行。两种形态都返回同一个 `SubagentActivation` 形状。
   */
  startActivation?: (
    spec: SubagentActivationSpecLike,
  ) => SubagentActivationLike | Promise<SubagentActivationLike>
  /** **旧宿主**（≤0.2.0）的一次性派发入口。 */
  start?: (name: string, request: SubagentStartRequest) => SubagentRun | Promise<SubagentRun>
  /**
   * **旧宿主**的 continuable 建会话入口（0.2.1 已移除）。
   * 仅作兼容：现行宿主由 {@link startActivation} 承担同等语义。
   */
  startContinuable?: (spec: {
    provider: string
    label: string
    childId?: string
    request: Omit<SubagentStartRequest, 'label' | 'signal'>
    signal: AbortSignal
  }) => { childId: string } | Promise<{ childId: string }>
  /** 已注册 provider 名清单（纯内存读，无副作用）。 */
  list?: () => unknown
  /** 按名取 provider 描述（`capabilities` 决定 `agentPreset` 等 start 期能力是否可用）。 */
  getProvider?: (name: string) => unknown
  /**
   * 向一个直接 continuable 子会话投递后续消息（任务续跑 / 让编排主 agent 归纳）。
   *
   * 与 `start` 不同：**没有 per-message result**
   * （`packages/subagent/subagent/src/run-settlement.ts:1-7`），完成必须另行观测。
   */
  sendMessage?: (
    sender: Agent,
    targetId: string,
    content: ContentBlock[],
    options: { signal: AbortSignal },
  ) => MessageId | Promise<MessageId>
  /**
   * 中断一个直接 continuable 子会话**当前这一轮**（spec 修复 D5）。
   *
   * 同步授权、异步生效：内部对目标执行 `Agent.cancel(cause,{keepInbox:true})`，不销毁会话本身，
   * 已在 inbox 但未认领的工作保留。目标不存在/已是 no-op 时正常返回（不抛错）。
   */
  interrupt?: (
    targetSessionId: string,
    authority:
      | { readonly kind: 'ancestor'; readonly agent: Agent }
      | { readonly kind: 'user'; readonly parentSessionId: string },
  ) => void
  /**
   * 释放某个存活父 Agent 名下选定的 resident 直接 continuable 子会话（spec 修复 D4）。
   *
   * 递归释放其拥有的后代；不影响该父会话的其它 continuable 子会话。
   * 父不是目标的直接父会话时抛 UNAUTHORIZED。调用方应 best-effort 处理。
   */
  drainChildren?: (parent: Agent, childIds: readonly string[]) => Promise<void>
}

/**
 * 该 provider 是否支持**独立选择子 agent preset**（`request.agentPreset`）。
 *
 * 宿主判定条件（`packages/subagent/subagent/src/index.ts:631-637`）：
 * `provider.capabilities.agentPreset === true` **且** `inheritsParentContext === false`
 * （fork 会继承父会话历史，宿主明确拒绝给它换 preset）。这里用同一判据前置拦截，
 * 报出可操作的原因，而不是让宿主抛一句英文 `UNSUPPORTED_CAPABILITY` 后任务莫名失败。
 *
 * 缺 `getProvider` / 缺 `capabilities` 时返回 `undefined`（= 无法判定，交给宿主判断）。
 */
function supportsAgentPreset(svc: SubagentServiceLike, name: string): boolean | undefined {
  if (typeof svc.getProvider !== 'function') return undefined
  let provider: unknown
  try {
    provider = svc.getProvider(name)
  } catch {
    return undefined
  }
  const p = provider as { capabilities?: { agentPreset?: unknown }; inheritsParentContext?: unknown } | undefined
  if (!p || typeof p.capabilities !== 'object' || p.capabilities === null) return undefined
  return p.capabilities.agentPreset === true && p.inheritsParentContext !== true
}

/** 从 `SubagentActivationSpecLike.request` 里剥掉已上提的 `label` / `signal`。 */
function toActivationRequest(
  request: SubagentStartRequest,
): Omit<SubagentStartRequest, 'label' | 'signal'> {
  const { label: _label, signal: _signal, ...rest } = request
  return rest as Omit<SubagentStartRequest, 'label' | 'signal'>
}

/**
 * 现行宿主的激活句柄 → 分发器认识的 {@link SubagentRun} 形状。
 *
 * 为什么要归一：`orchestration/dispatch.ts` 的看门狗/收口/并发槽归还全部按
 * `{ id, result, dispose }` 编写（那是旧宿主的形状）。在这里做一次性适配，
 * 比在上层散布两套形状判断可靠得多。
 */
function activationToRun(activation: SubagentActivationLike, fallbackId: string): SubagentRun {
  const childId = String(activation?.childId ?? fallbackId)
  return {
    id: childId,
    result: activation.result,
    dispose: async () => {
      if (typeof activation.dispose === 'function') await activation.dispose()
    },
  } as SubagentRun
}

/**
 * **调用时**解析宿主 `subagents` 服务。
 *
 * 用**非严格**模式（`strict = false`，2026-10-05 修复）：严格模式在提供方 fiber
 * 尚未激活（`state !== 2`）时返回 `undefined` —— 实测见 `vendor/cordis/lib/index.js:766-770`
 * 的 `_getImpl`：`if (strict && impl.fiber.state !== 2) return`。
 *
 * 非严格**不会**掩盖"插件没装"：真没 provide 时两种模式都返回 `undefined`，
 * `probeSubagents` 照样如实报 `available:false`。它只区分"没装"与"还没激活"。
 *
 * @param ctx - 宿主上下文。
 * @returns 服务实例；未提供/未激活时为 undefined。
 */
export function resolveSubagents(ctx: Context): SubagentServiceLike | undefined {
  return (ctx.get as (n: string, strict?: boolean) => unknown)('subagents', false) as
    | SubagentServiceLike
    | undefined
}

/**
 * 构造分发器用的 SubagentClient —— **每次 start 都重新解析服务**。
 *
 * 三个必须点：
 *   1. 不在 `apply` 期捕获服务引用（那时它必然还不可用，见模块注释）；
 *   2. 调用时**必须保留接收者**（`svc.startActivation(...)` / `svc.start(...)`）。两者都是类方法，
 *      内部要用 `this.providers` / `this.expectProvider`；`const f = svc.startActivation` 后裸调
 *      会丢 `this` ⇒ `TypeError`（与"服务不可用"是完全不同的故障，排查时别混淆）；
 *   3. **API 换代兼容**：现行宿主只有 `startActivation`，旧宿主只有 `start`。
 *
 * `delivery` 固定 `'caller'`：本插件的父会话是用户正在用的聊天窗口，批量派发若逐条
 * 投递结算消息会把对话刷满；任务结果由看板 attempt 收口（`launchRun` 订阅 `run.result`）。
 *
 * @param ctx - 宿主上下文。
 * @returns SubagentClient（缺失时 start 抛可读错误，由 RequirementDispatcher 转成 DispatchError）。
 */
export function createSubagentClient(ctx: Context): SubagentClient {
  return {
    start(name, request) {
      const svc = resolveSubagents(ctx)
      if (!svc) {
        throw new Error(
          '宿主 subagents 服务不可用（US4 编排能力禁用）：调用时未能解析到服务 "subagents"。'
          + '请确认当前 profile 装载了 @deepseek-ai/dsh-subagent（未装载时无法派发子智能体）',
        )
      }
      const signal = request.signal ?? new AbortController().signal
      /**
       * preset 前置校验（2026-10-29）：`request.agentPreset` 要求 provider 支持独立 preset
       * （spawn ✓ / fork ✗，见 {@link supportsAgentPreset}）。用户显式选了预设却拿到一句
       * 英文 UNSUPPORTED_CAPABILITY，等于配置静默失效 —— 这里给出可操作的中文原因。
       */
      if (request.agentPreset !== undefined && request.agentPreset !== '') {
        if (supportsAgentPreset(svc, name) === false) {
          throw new Error(
            `subagent provider「${name}」不支持为子 agent 单独指定预设（agentPreset）：`
            + '该 provider 会继承父会话的组合（如 fork）。请改用 spawn 类 provider，或清空任务上的「预设」后重试',
          )
        }
      }
      // ① 现行宿主：统一激活入口（0.2.1+）。
      if (typeof svc.startActivation === 'function') {
        const started = svc.startActivation({
          provider: name,
          label: typeof request.label === 'string' && request.label.length > 0 ? request.label : name,
          request: toActivationRequest(request),
          signal,
          delivery: 'caller',
        })
        return Promise.resolve(started).then(a => activationToRun(a, name))
      }
      // ② 旧宿主：一次性 start（≤0.2.0）。
      if (typeof svc.start === 'function') {
        return svc.start(name, request)
      }
      throw new Error(
        '宿主 subagents 服务结构异常：既没有 startActivation(spec)（0.2.1+），'
        + '也没有 start(name, request)（≤0.2.0），无法派发子智能体',
      )
    },
  }
}

/** continuable 建会话规格（本插件结构类型；两代宿主入参一致）。 */
export interface ContinuableStartSpecLike {
  /** provider 名。 */
  provider: string
  /** 短标签。 */
  label: string
  /** 预留子会话 id（可选）。 */
  childId?: string
  /** 任务（prompt / parent / agentOptions / maxDepth）。 */
  request: Omit<SubagentStartRequest, 'label' | 'signal'>
  /** 取消信号。 */
  signal: AbortSignal
}

/**
 * **调用时**建立一个 continuable 持久子会话（spec 010）。
 *
 * 宿主 0.2.1 移除了 `startContinuable`，但**语义并未消失**：`startActivation` 对带
 * `prepareContinuable` 的 provider（`spawn`/`fork` 都有，见
 * `packages/subagent/subagent-*-in-process/src/index.ts`）会走 `manager.startLocal`，
 * 建出的正是一个可续投消息的持久子会话。故这里按能力两级回退：
 *
 *   1. `startContinuable`（≤0.2.0 宿主）；
 *   2. `startActivation`（现行宿主）—— 建会话并投递首条消息，返回同一个 `childId`。
 *
 * 两条路径都**已经**把首条消息投进 inbox，调用方不要再 `sendMessage` 一次。
 *
 * @param ctx - 宿主上下文。
 * @param spec - continuable 启动规格（provider / label / request / signal）。
 * @returns 持久子会话 id（其首条消息已投递）。
 * @throws 服务不可用、两代 API 都没有、或 provider 拒绝创建时抛可读错误。
 */
export async function startContinuableOn(
  ctx: Context,
  spec: ContinuableStartSpecLike,
): Promise<{ childId: string }> {
  const svc = resolveSubagents(ctx)
  if (!svc) {
    throw new Error(
      '宿主 subagents 服务不可用：调用时未能解析到服务 "subagents"，无法创建 continuable 子会话',
    )
  }
  if (typeof svc.startContinuable === 'function') {
    const started = await svc.startContinuable(spec)
    return { childId: String(started.childId) }
  }
  if (typeof svc.startActivation === 'function') {
    const activation = await svc.startActivation({
      provider: spec.provider,
      label: spec.label,
      ...(spec.childId ? { childId: spec.childId } : {}),
      request: spec.request,
      signal: spec.signal,
      delivery: 'caller',
    })
    return { childId: String(activation.childId) }
  }
  throw new Error(
    '宿主 subagents 服务不支持 continuable 子会话（既无 startContinuable，也无 startActivation）：'
    + '编排主 agent 与任务会话复用不可用，已回退到 ONE-SHOT 派发',
  )
}

/**
 * **调用时**向一个直接 continuable 子会话投递消息（spec 010：任务续跑 / 让主 agent 归纳）。
 *
 * @param ctx - 宿主上下文。
 * @param sender - 真实宿主 Agent（`sendMessage` 用它做发送者归属与邻接校验）。
 * @param targetId - 直接子会话 id。
 * @param content - 消息内容。
 * @param signal - 取消信号（仅覆盖"投递被 inbox 接受之前"）。
 * @returns 被接受消息的 inbox id。
 * @throws 服务不可用/不支持、或邻接校验失败时抛可读错误。
 */
export async function sendMessageOn(
  ctx: Context,
  sender: Agent,
  targetId: string,
  content: ContentBlock[],
  signal: AbortSignal,
): Promise<MessageId> {
  const svc = resolveSubagents(ctx)
  if (!svc) {
    throw new Error('宿主 subagents 服务不可用：调用时未能解析到服务 "subagents"，无法向子会话投递消息')
  }
  if (typeof svc.sendMessage !== 'function') {
    throw new Error('宿主 subagents 服务不支持 sendMessage（宿主版本较旧）：无法向已有子会话续投任务')
  }
  return svc.sendMessage(sender, targetId, content, { signal })
}

/**
 * 中断一个直接 continuable 子会话的当前轮（D5）。
 *
 * 与 {@link sendMessageOn} 同一纪律：调用时解析服务、保留接收者。
 * @param ctx - 宿主上下文。
 * @param targetId - 待中断的子会话 id。
 * @param authority - 存活祖先 Agent（通常是本轮派发解析出的 parent）。
 * @returns 是否成功调用（false = 宿主版本不支持中断，调用方降级为仅本地收口）。
 */
export function interruptChildOn(
  ctx: Context,
  targetId: string,
  authority: Agent,
): boolean {
  const svc = resolveSubagents(ctx)
  if (!svc || typeof svc.interrupt !== 'function') return false
  svc.interrupt(targetId, { kind: 'ancestor', agent: authority })
  return true
}

/**
 * 释放某个存活父会话名下选定的 continuable 子会话（D4）。
 *
 * @param ctx - 宿主上下文。
 * @param parent - 这些子会话的直接父 Agent（必须存活）。
 * @param childIds - 待释放的子会话 id。
 * @throws 服务不支持（旧宿主）时抛错，调用方按 best-effort 降级。
 */
export async function drainChildrenOn(
  ctx: Context,
  parent: Agent,
  childIds: readonly string[],
): Promise<void> {
  const svc = resolveSubagents(ctx)
  if (!svc || typeof svc.drainChildren !== 'function') {
    throw new Error('宿主 subagents 服务不支持 drainChildren（宿主版本较旧）：无法释放 continuable 子会话')
  }
  await svc.drainChildren(parent, childIds)
}

/** 编排能力探测结果（面板展示用；`providers` 为宿主真实注册的 provider 名）。 */
export interface SubagentProbeResult {
  /** 派发入口可用 ⇒ 本插件能派发子智能体。 */
  available: boolean
  /** 宿主已注册的 provider 名（角色 `provider` 下拉的真实取值域）。 */
  providers: string[]
  /** 不可用/降级原因（available=true 时一般无 reason）。 */
  reason?: string
  /** 实际生效的派发 API（诊断用：`startActivation` / `start`）。 */
  api?: 'startActivation' | 'start'
  /**
   * true = 当前**没有**存活顶层会话，但派发时会由 `sessionController.create` 现场准备一个
   * （2026-11-03）。面板据此提示"无活跃会话，派发时自动准备"，而不是把能力判成不可用。
   */
  parentOnDemand?: boolean
}

/**
 * 探测宿主 `subagents` 服务的真实可达性（**调用时**执行，可反复调用）。
 *
 * 与 {@link createSubagentClient} 共用同一访问器与同一套能力判定，因此探测结论与派发路径
 * **不会漂移**：面板显示 `available: true` ⇒ 派发不会再撞上"服务不可用"。
 *
 * @param ctx - 宿主上下文。
 * @returns 探测结果（永不抛错）。
 */
export function probeSubagents(ctx: Context): SubagentProbeResult {
  const svc = resolveSubagents(ctx)
  if (!svc) {
    return { available: false, providers: [], reason: '宿主未提供或尚未激活 subagents 服务（无法派发子智能体）' }
  }
  const api: 'startActivation' | 'start' | undefined =
    typeof svc.startActivation === 'function'
      ? 'startActivation'
      : typeof svc.start === 'function'
        ? 'start'
        : undefined
  if (!api) {
    return {
      available: false,
      providers: [],
      reason: 'subagents 服务既没有 startActivation（0.2.1+）也没有 start（≤0.2.0）（宿主版本不匹配？）',
    }
  }
  if (typeof svc.list !== 'function') {
    // 老版本服务没有 list：不因此判不可用（派发入口才是所需能力）。
    return { available: true, providers: [], api }
  }
  try {
    // `list()` 只读内存里的 provider 表；顺带验证"以服务为接收者调用方法"是通的
    // （丢 `this` 的实现会在这里暴露成 available:false + 可读原因）。
    const rows = svc.list()
    const providers = Array.isArray(rows) ? rows.filter((x): x is string => typeof x === 'string') : []
    return { available: true, providers, api }
  } catch (error) {
    return { available: false, providers: [], reason: `subagents 服务可达但调用失败：${(error as Error).message}` }
  }
}

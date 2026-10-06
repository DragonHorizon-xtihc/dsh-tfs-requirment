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
 * apply 期必然拿到 `undefined` ⇒ 旧实现把"永远抛错的桩"钉死在分发器里，
 * 表现为用户看到的：*点「发起执行」/「派发执行」→ 分发失败（task=…）：宿主 subagents
 * 服务不可用（US4 编排能力禁用）*，且**看板 attempt 在 9–17ms 内就判失败**
 * （真派发不可能这么快）。
 *
 * 因此本模块把所有取用收敛到**调用时**解析；顺带提供 `probeSubagents`，
 * 让"编排能力到底通不通"在面板上**先于点击**可见，而不是点完才炸。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/subagent-access
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ContentBlock, MessageId } from '@deepseek-ai/dsh-llm'
import type {
  ContinuableStart,
  ContinuableStartSpec,
  SubagentRun,
  SubagentStartRequest,
} from '@deepseek-ai/dsh-subagent'
import type { SubagentClient } from '../orchestration/dispatch.js'

/**
 * `subagents` 服务的结构切片（结构类型，不 import 具体包以免装配耦合）。
 *
 * `start(name, request)` 的第一参是 **provider 名**（`spawn` / `fork` / CLI 适配器等），
 * 不是角色名；provider 不存在时宿主会抛可读错误。
 */
export interface SubagentServiceLike {
  /** 按 provider 名发起一个 ONE-SHOT 子 agent。 */
  start?: (name: string, request: SubagentStartRequest) => SubagentRun | Promise<SubagentRun>
  /** 已注册 provider 名清单（纯内存读，无副作用）。 */
  list?: () => unknown
  /**
   * 建立一个**持久 continuable 子会话**并投递首条消息（spec 010 编排主 agent / 任务会话复用）。
   *
   * 方法存在与否即 provider 能力：宿主 `prepareContinuable` 对不支持的 provider 直接拒绝
   * （`packages/subagent/subagent/src/index.ts:594-600`），故调用方必须 catch 并降级。
   */
  startContinuable?: (spec: ContinuableStartSpec) => ContinuableStart | Promise<ContinuableStart>
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
   * authority 用 `{kind:'ancestor', agent}` 时，agent 必须是目标记录在案的存活祖先。
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
 * **调用时**解析宿主 `subagents` 服务。
 *
 * 用**非严格**模式（`strict = false`，2026-10-05 修复）：严格模式在提供方 fiber
 * 尚未激活（`state !== 2`）时返回 `undefined` —— 实测见 `vendor/cordis/lib/index.js:766-770`
 * 的 `_getImpl`：`if (strict && impl.fiber.state !== 2) return`。
 *
 * 旧注释假定"调用发生在用户点击派发时，此服务的 fiber 早已激活"，但这个假定**不成立**：
 * `probeSubagents` 会在**面板首次请求**时就被调用（`api.ts#getPanelData` → `orchestration` 字段），
 * 而插件装载顺序不保证 `dsh-subagent` 的 fiber 此刻已激活 ⇒ 面板会误报
 * "编排能力不可用"，而运行期该服务其实是好的。`index.ts` 建立 `catalogHost` 时也是因为
 * 同一个坑才改用非严格查阅（其注释记录了"五项全空"的真实事故）。
 *
 * 非严格**不会**掩盖"插件没装"：真没 provide 时两种模式都返回 `undefined`，
 * `probeSubagents` 照样如实报 `available:false`。它只区分"没装"与"还没激活"，
 * 而后者不该被当成前者。
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
 * 两个必须点（都是实机事故的直接教训）：
 *   1. 不在 `apply` 期捕获服务引用（那时它必然还不可用，见模块注释）；
 *   2. 调用时**必须保留接收者**（`svc.start(name, request)`）。`start` 是类方法，
 *      内部要用 `this.providers` / `this.expectProvider`；`const start = svc.start` 后裸调
 *      会丢 `this` ⇒ `TypeError`（与"服务不可用"是完全不同的故障，排查时别混淆）。
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
      if (typeof svc.start !== 'function') {
        throw new Error('宿主 subagents 服务结构异常：缺少 start(name, request) 方法，无法派发子智能体')
      }
      return svc.start(name, request)
    },
  }
}

/**
 * **调用时**建立一个 continuable 持久子会话（spec 010）。
 *
 * 与 {@link createSubagentClient} 同一纪律：服务**每次调用**重新解析（apply 期必然为 undefined），
 * 且**保留接收者**（`svc.startContinuable(spec)`）——`const f = svc.startContinuable` 裸调会丢 `this`。
 *
 * @param ctx - 宿主上下文。
 * @param spec - continuable 启动规格（provider / label / request / signal）。
 * @returns 持久子会话 id 与首条消息的 inbox id。
 * @throws 服务不可用、服务无该方法（宿主版本不支持）、或 provider 拒绝创建时抛可读错误。
 */
export async function startContinuableOn(
  ctx: Context,
  spec: ContinuableStartSpec,
): Promise<ContinuableStart> {
  const svc = resolveSubagents(ctx)
  if (!svc) {
    throw new Error(
      '宿主 subagents 服务不可用：调用时未能解析到服务 "subagents"，无法创建 continuable 编排会话',
    )
  }
  if (typeof svc.startContinuable !== 'function') {
    throw new Error(
      '宿主 subagents 服务不支持 startContinuable（宿主版本较旧或未装载 continuable 能力）：'
      + '编排主 agent 与任务会话复用不可用，已回退到 ONE-SHOT 派发',
    )
  }
  return svc.startContinuable(spec)
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
  return svc.sendMessage(sender, targetId as never, content, { signal })
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
  svc.interrupt(targetId as never, { kind: 'ancestor', agent: authority })
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
  await svc.drainChildren(parent, childIds as never)
}

/** 编排能力探测结果（面板展示用；`providers` 为宿主真实注册的 provider 名）。 */
export interface SubagentProbeResult {
  /** `start` 可用 ⇒ 本插件能派发子智能体。 */
  available: boolean
  /** 宿主已注册的 provider 名（角色 `provider` 下拉的真实取值域）。 */
  providers: string[]
  /** 不可用/降级原因（available=true 时一般无 reason）。 */
  reason?: string
}

/**
 * 探测宿主 `subagents` 服务的真实可达性（**调用时**执行，可反复调用）。
 *
 * 与 {@link resolveSubagents} 共用同一访问器，因此探测结论与派发路径**不会漂移**：
 * 面板显示 `available: true` ⇒ 派发不会再撞上"服务不可用"。
 *
 * @param ctx - 宿主上下文。
 * @returns 探测结果（永不抛错）。
 */
export function probeSubagents(ctx: Context): SubagentProbeResult {
  const svc = resolveSubagents(ctx)
  if (!svc) {
    return { available: false, providers: [], reason: '宿主未提供或尚未激活 subagents 服务（无法派发子智能体）' }
  }
  if (typeof svc.start !== 'function') {
    return { available: false, providers: [], reason: 'subagents 服务缺少 start 方法（宿主版本不匹配？）' }
  }
  if (typeof svc.list !== 'function') {
    // 老版本服务没有 list：不因此判不可用（start 才是派发所需的能力）。
    return { available: true, providers: [] }
  }
  try {
    // `list()` 只读内存里的 provider 表；顺带验证"以服务为接收者调用方法"是通的
    // （丢 `this` 的实现会在这里暴露成 available:false + 可读原因）。
    const rows = svc.list()
    const providers = Array.isArray(rows) ? rows.filter((x): x is string => typeof x === 'string') : []
    return { available: true, providers }
  } catch (error) {
    return { available: false, providers: [], reason: `subagents 服务可达但调用失败：${(error as Error).message}` }
  }
}

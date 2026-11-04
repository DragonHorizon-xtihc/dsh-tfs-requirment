/**
 * 主 agent 扫尾（2026-11-03 问题 7）：**纯逻辑**层。
 *
 * 用户诉求：主 agent 的工作不只是编排与总结，还要扫尾——
 *   1. 子 agent 需要用户操作时 ⇒ 主 agent 选**推荐选项**，编排该子 agent 继续完成剩余任务；
 *   2. 子 agent 任务完成即停（输出早退）⇒ 主 agent 再次编排**同一**子 agent 续做；
 *   3. 子 agent 无法继续（拒绝 / 重试耗尽）⇒ 主 agent **亲自完成**任务；
 *   4. 完成后继续编排下一个子 agent，直到全部结束（链式放行沿用既有 `handleTaskSettled`）。
 *
 * 本模块只回答「这次收口该采取哪种扫尾动作」——不发消息、不起会话、不碰看板；
 * 真正执行在宿主 `api.ts` 的收口链（`followUpTask` 续跑 / orchestrator 决策与亲做）。
 */

/** 扫尾动作。 */
export type SweepAction =
  /** 成功收口：无需扫尾。 */
  | { kind: 'none' }
  /**
   * 待人工确认：主 agent 选推荐选项后让**同一子 agent** 继续。
   * `recommendation` 为从输出里解析出的推荐项（空串 = 交给主 agent 自行决断）。
   */
  | { kind: 'continue_with_recommendation'; recommendation: string }
  /** 非拒绝类失败：让同一子 agent 继续/重试（`round` = 第几轮扫尾）。 */
  | { kind: 'retry_continue'; round: number }
  /** 重试耗尽或明确拒绝：主 agent 亲自完成该任务。 */
  | { kind: 'main_agent_completes'; reason: string }

/** 扫尾决策输入。 */
export interface SweepInput {
  /** 本次收口判定（与 `detectOutcome` 同口径）。 */
  outcome: 'success' | 'failed' | 'needs_confirmation'
  /** 子 run 落定原因（`stopReason`）。 */
  stopReason?: string
  /** 子 agent 最终输出（用于解析推荐选项）。 */
  output?: string
  /** 该任务已进行的扫尾轮数（0 = 本轮之前没扫过）。 */
  sweepRound: number
  /** 单任务扫尾轮数上限（超过即转主 agent 亲做；建议 1~3）。 */
  maxSweepRounds: number
}

/**
 * 显式推荐标记：`RECOMMEND: xxx` / `推荐选项：xxx` / `推荐：xxx` / `RECOMMENDED: xxx`。
 * 只认行首（可有列表符号/加粗），避免正文里"我推荐……"闲聊被当协议。
 */
const RECOMMEND_PATTERNS: RegExp[] = [
  /^[\s>*-]*(?:\*\*)?(?:RECOMMEND(?:ED)?|推荐(?:选项|方案)?)\s*[:：]\s*(.+)$/im,
]

/** 推荐选项解析的最大长度（防整篇输出被当成"推荐项"）。 */
export const RECOMMENDATION_LIMIT = 300

/**
 * 从子 agent 输出里解析「推荐选项」。
 *
 * 保守口径：只认显式标记行；解析不出返回空串（由主 agent 对着输出自行决断，
 * 而不是瞎猜一句用户没写过的话）。
 *
 * @param output - 子 agent 最终输出文本。
 * @returns 推荐项文本（已 trim、限长）；无标记返回 ''。
 */
export function extractRecommendedOption(output: string | undefined): string {
  const text = output ?? ''
  if (!text) return ''
  for (const re of RECOMMEND_PATTERNS) {
    const m = text.match(re)
    if (m && typeof m[1] === 'string') {
      const v = m[1].trim()
      if (v) return v.length > RECOMMENDATION_LIMIT ? `${v.slice(0, RECOMMENDATION_LIMIT)}…` : v
    }
  }
  return ''
}

/** 明确拒绝类落定原因：转主 agent 亲做（再怎么续跑它也不会动）。 */
const REFUSAL_STOP_REASONS = new Set(['refusal'])

/**
 * 扫尾决策（问题 7 核心）。
 *
 * 口径：
 *   - `success` ⇒ none（走既有链式放行）；
 *   - `needs_confirmation` ⇒ continue_with_recommendation（推荐项解析不出时为空串，
 *     由主 agent 自行决断）；**同样烧轮数**，反复确认到轮数耗尽 ⇒ 转主 agent 亲做（防死循环）；
 *   - `failed`：
 *       · stopReason=refusal ⇒ main_agent_completes（子 agent 明确不干）；
 *       · sweepRound < maxSweepRounds ⇒ retry_continue（round+1）；
 *       · 否则 ⇒ main_agent_completes（重试耗尽）。
 *
 * @param input - 见 {@link SweepInput}。
 * @returns 扫尾动作（判别联合，无字符串标签歧义）。
 */
export function decideSweep(input: SweepInput): SweepAction {
  const { outcome, stopReason, output, sweepRound, maxSweepRounds } = input
  if (outcome === 'success') return { kind: 'none' }

  const maxRounds = Math.max(0, maxSweepRounds)

  if (outcome === 'needs_confirmation') {
    // ⚠️ 待确认同样烧轮数（2026-11-03 自查）：不设止损的话子 agent 每轮都"请人工确认"，
    // 扫尾会无限 续跑→再确认→再续跑。轮数耗尽转主 agent 亲做（它能直接拍板）。
    if (sweepRound >= maxRounds) {
      return {
        kind: 'main_agent_completes',
        reason: `子 agent 反复请求人工确认且扫尾轮数已耗尽（${sweepRound}/${maxRounds} 轮）`,
      }
    }
    return {
      kind: 'continue_with_recommendation',
      recommendation: extractRecommendedOption(output),
    }
  }

  // outcome === 'failed'
  if (stopReason && REFUSAL_STOP_REASONS.has(stopReason)) {
    return { kind: 'main_agent_completes', reason: `子 agent 拒绝执行（stopReason=${stopReason}）` }
  }
  if (sweepRound < maxRounds) {
    return { kind: 'retry_continue', round: sweepRound + 1 }
  }
  return {
    kind: 'main_agent_completes',
    reason: `子 agent 连续失败且扫尾重试已耗尽（${sweepRound}/${maxRounds} 轮）`,
  }
}

/**
 * 组装「续跑」发给子 agent 的补充指令（扫尾 1/2 两种续跑共用）。
 *
 * @param input.recommendation - 主 agent 选定的推荐项（空 = 不给选项，只让继续）。
 * @param input.outputTail - 子 agent 上一轮输出的尾部提示（可选，帮它回想起停在哪）。
 */
export function buildContinuePrompt(input: { recommendation: string; outputTail?: string }): string {
  const head = '【主 agent 扫尾】请继续完成本任务的剩余部分，不要重复已完成的步骤。'
  const rec = input.recommendation
    ? `\n主 agent 已替用户确认，按推荐选项继续：${input.recommendation}`
    : '\n没有可解析的推荐选项：请自行选择最合理的默认选项继续推进。'
  const tail = input.outputTail
    ? `\n你上一轮的收尾输出如下（供定位进度）：\n${input.outputTail}`
    : ''
  return `${head}${rec}${tail}\n完成全部剩余工作后，按执行纪律输出 TASK_DONE 与产物段。`
}

/**
 * 组装「主 agent 亲做」的决策/执行 prompt（扫尾 3）。
 *
 * @param input.taskId - 任务 id。 @param input.title - 任务标题。
 * @param input.taskPrompt - 任务自身提示词（角色级）。 @param input.reason - 为什么转亲做。
 */
export function buildMainAgentCompletePrompt(input: {
  taskId: string
  title: string
  taskPrompt?: string
  reason: string
}): string {
  return [
    `【主 agent 扫尾】子 agent 无法继续，由你（编排主 agent）亲自完成任务 ${input.taskId}。`,
    `原因：${input.reason}`,
    `任务标题：${input.title}`,
    input.taskPrompt ? `任务要求：\n${input.taskPrompt}` : '任务要求：（无额外提示词，请按共享简报与需求上下文完成）',
    '请直接完成剩余工作；完成后输出一行 TASK_DONE，并列出关键产物路径（ARTIFACTS: 段）。',
  ].join('\n')
}

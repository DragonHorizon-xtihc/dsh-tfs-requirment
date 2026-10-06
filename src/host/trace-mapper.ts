/**
 * 会话事件 → 执行时间线条目的纯映射（spec 006 US2）。
 *
 * 为什么是纯函数：`sessionQuery.observeSession` 返回的 `SessionEvent[]` 形态来自宿主
 * `@deepseek-ai/dsh-session`（见 research.md 的词表），把"事件 → UI 时间线"的转换抽成**不依赖
 * 宿主/ node** 的纯函数，既能在单测里用合成事件穷举配对/截断/异常形态，也让客户端半与宿主半
 * 对同一份契约（`TaskTraceEntry`）理解一致。本文件只 import 共享类型。
 *
 * 防御式取数：宿主事件是 merge-extensible 的判别联合，且冷读日志可能缺头少尾，故这里全部按
 * `unknown` 读取、逐字段判型，任何非预期形态都**跳过而不抛错**（绝不能因为一条怪事件让整个
 * 任务详情白屏）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/trace-mapper
 */
import type { TaskTraceEntry, TaskTraceStats, TraceToolKind } from '../shared/contracts.js'
import { sliceTextByCodePoint } from '../shared/text.js'

/** 单段文本（user/assistant/工具结果）的最大字符数，超出截断（避免超大工具输出灌爆 HTTP/UI）。 */
export const MAX_TEXT_CHARS = 2000
/** 工具入参原始 JSON 的最大字符数。 */
export const MAX_ARGS_CHARS = 1500
/** 时间线条目上限；超出后保留开头（含首轮指令）+ 最近的尾部。 */
export const MAX_ENTRIES = 400
/** 超上限时保留的开头条目数。 */
export const KEEP_HEAD = 20

/**
 * 截断并加省略号。
 *
 * 切点按码点对齐：`String.prototype.slice` 按 UTF-16 码元计数，正好切在高代理项上会把一个
 * 字符劈成两半，页面上显示为替换符（U+FFFD），emoji 与增补平面汉字都会中招。
 *
 * @param text - 待截断的原文。
 * @param max - 保留的最大字符数；不超过时原样返回。
 * @returns 最长 `max` 个字符的前缀加上省略说明（总长取原文的 `text.length`）。
 */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${sliceTextByCodePoint(text, max)}…（已截断，共 ${text.length} 字）`
}

/** 按工具全名判定类别：MCP（mcp__server__tool）/ 技能 / 普通工具。 */
export function classifyTool(name: string): TraceToolKind {
  if (name.startsWith('mcp__')) return 'mcp'
  // dsh-tool-skill 注册的技能调用工具名为 Skill（不同部署可能为 skill/run-skill 等），宽松匹配。
  if (/(^|[_\s-])skill([_\s-]|$)/i.test(name) || name.toLowerCase() === 'skill') return 'skill'
  return 'tool'
}

/**
 * 从消息 content 块里防御式抽取可读文本。
 * 处理：字符串、TextBlock（type:'text'）、以及 ToolResultBlock 内嵌的 content（递归一层）。
 * 忽略 reasoning/image/file/tool-call 等非文本块（它们各自有专门事件或不适合文本时间线）。
 */
export function blocksToText(content: unknown): string {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown; content?: unknown }
    if (b.type === 'text' && typeof b.text === 'string' && b.text.trim().length > 0) {
      parts.push(b.text)
    } else if (b.type === 'tool-result') {
      const inner = blocksToText(b.content)
      if (inner) parts.push(inner)
    }
  }
  return parts.join('\n').trim()
}

/**
 * 从消息 content 块里防御式抽取**思考 / reasoning**文本（type:'reasoning' 块）。
 *
 * 与 {@link blocksToText} 刻意分开：可见文本与内部思考是两条通道，混在一起会让"模型在想什么"
 * 灌进正文。子 agent 执行中常只产出 reasoning + tool-call（无可见文本），正是旧时间线"只剩工具"
 * 的根因——这里把思考单独取出，交给 UI 折叠展示。
 */
export function blocksToReasoning(content: unknown): string {
  if (!Array.isArray(content)) return ''
  const parts: string[] = []
  for (const block of content) {
    if (block === null || typeof block !== 'object') continue
    const b = block as { type?: unknown; text?: unknown }
    if (b.type === 'reasoning' && typeof b.text === 'string' && b.text.trim().length > 0) parts.push(b.text)
  }
  return parts.join('\n').trim()
}

/** 把 turn/end 的结构化原因（TurnEndReason）转成可读字符串。 */
function describeTurnEndReason(reason: unknown): string | undefined {
  if (reason === undefined || reason === null) return undefined
  if (typeof reason === 'string') return reason
  if (typeof reason === 'object') {
    const r = reason as { kind?: unknown; error?: { message?: unknown } }
    const kind = typeof r.kind === 'string' ? r.kind : 'unknown'
    const msg = r.error && typeof r.error.message === 'string' ? r.error.message : ''
    return msg ? `${kind}: ${msg}` : kind
  }
  return String(reason)
}

/** 从工具结果事件里取 callId / 是否错误 / 结果文本。 */
function readToolResult(data: unknown): {
  callId?: string
  isError: boolean
  text: string
  errorReason?: string
} {
  const d = (data ?? {}) as {
    message?: { content?: unknown; source?: { callId?: unknown } }
    error?: { name?: unknown; code?: unknown; reason?: unknown }
  }
  // ToolResultMessage.content 是 [ToolResultBlock]；块上带 toolCallId/isError/content。
  let block: { toolCallId?: unknown; isError?: unknown; content?: unknown } | undefined
  if (Array.isArray(d.message?.content)) {
    const first = d.message.content[0]
    if (first && typeof first === 'object') {
      block = first as { toolCallId?: unknown; isError?: unknown; content?: unknown }
    }
  }
  const callId =
    (typeof block?.toolCallId === 'string' ? block.toolCallId : undefined) ??
    (typeof d.message?.source?.callId === 'string' ? (d.message.source.callId as string) : undefined)
  const isError = block?.isError === true || Boolean(d.error)
  const text = block ? blocksToText(block.content) : ''
  const errorReason =
    (typeof d.error?.reason === 'string' && d.error.reason ? d.error.reason : undefined) ??
    (isError && text ? text : undefined)
  return { callId, isError, text, errorReason }
}

export interface MapTraceResult {
  entries: TaskTraceEntry[]
  /** 是否因超过上限而丢弃过中间条目。 */
  truncated: boolean
  /** 截断前映射出的条目总数（UI 据此提示"共 N 条"）。 */
  total: number
  /** 最后事件 seq（游标）。 */
  cursor?: number
}

/**
 * 把会话事件数组映射为时间线条目（按 seq 升序）。
 * @param rawEvents - `SessionObservation.events`（元素为 SessionEvent 信封 `{type,seq,time,data}`）。
 */
export function mapTraceEvents(rawEvents: readonly unknown[]): MapTraceResult {
  const events = [...rawEvents].sort((a, b) => {
    const sa = (a as { seq?: number })?.seq ?? 0
    const sb = (b as { seq?: number })?.seq ?? 0
    return sa - sb
  })

  const sink = createEntrySink()
  /** callId → 已建 tool 条目本身（用于结果配对；按下标索引在丢弃中段后会指向错位）。 */
  const callEntries = new Map<string, TaskTraceEntry>()
  let cursor: number | undefined

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const e = ev as { type?: unknown; seq?: number; time?: number; data?: unknown }
    if (typeof e.seq === 'number') cursor = e.seq
    const time = typeof e.time === 'number' ? e.time : undefined
    const data = e.data
    switch (e.type) {
      case 'turn/start': {
        const turn = (data as { turn?: number })?.turn
        if (typeof turn === 'number') sink.push({ kind: 'turn', phase: 'start', turn, ...(time ? { time } : {}) })
        break
      }
      case 'turn/end': {
        const d = data as { turn?: number; reason?: unknown }
        if (typeof d?.turn === 'number') {
          const reason = describeTurnEndReason(d.reason)
          sink.push({
            kind: 'turn',
            phase: 'end',
            turn: d.turn,
            ...(reason ? { reason } : {}),
            ...(time ? { time } : {}),
          })
        }
        break
      }
      case 'user/message': {
        // 注意：SessionEventMap['user/message'] 的 data 就是 UserMessage 本身（content 在 data.content），
        // 与 assistant/tool 事件包一层 .message 不同，两种形态都兼容。
        const d = data as { content?: unknown; message?: { content?: unknown } }
        const content = d?.content ?? d?.message?.content
        const text = truncate(blocksToText(content), MAX_TEXT_CHARS)
        if (text) sink.push({ kind: 'user', text, ...(time ? { time } : {}) })
        break
      }
      case 'assistant/message': {
        const d = data as { message?: { content?: unknown }; interrupted?: boolean }
        const content = d?.message?.content
        const text = truncate(blocksToText(content), MAX_TEXT_CHARS)
        const thinking = truncate(blocksToReasoning(content), MAX_TEXT_CHARS)
        // 即使没有可见文本（仅思考 / 仅发起工具调用），也保留一条助手节点，避免时间线"只剩工具"。
        if (text || thinking) {
          sink.push({
            kind: 'assistant',
            text,
            ...(thinking ? { thinking } : {}),
            ...(d?.interrupted === true ? { interrupted: true } : {}),
            ...(time ? { time } : {}),
          })
        }
        break
      }
      case 'tool/call': {
        const d = data as { turn?: number; step?: number; callId?: unknown; name?: unknown; arguments?: unknown }
        const callId = typeof d?.callId === 'string' ? d.callId : ''
        const name = typeof d?.name === 'string' ? d.name : '(unknown)'
        const args = typeof d?.arguments === 'string' ? d.arguments : d?.arguments === undefined ? '' : safeStringify(d.arguments)
        const entry: TaskTraceEntry = {
          kind: 'tool',
          callId,
          name,
          toolKind: classifyTool(name),
          args: truncate(args, MAX_ARGS_CHARS),
          status: 'running',
          ...(typeof d?.turn === 'number' ? { turn: d.turn } : {}),
          ...(typeof d?.step === 'number' ? { step: d.step } : {}),
          ...(time ? { time } : {}),
        }
        if (callId) callEntries.set(callId, entry)
        sink.push(entry)
        break
      }
      case 'tool/result': {
        const d = data as { turn?: number; step?: number }
        const r = readToolResult(data)
        const tool = r.callId ? callEntries.get(r.callId) : undefined
        if (tool !== undefined) {
          if (tool.kind === 'tool') {
            tool.status = r.isError ? 'error' : 'ok'
            if (typeof tool.time === 'number' && typeof time === 'number' && time >= tool.time) {
              tool.durationMs = time - tool.time
            }
            const text = truncate(r.text, MAX_TEXT_CHARS)
            if (r.isError) {
              if (r.errorReason) tool.error = truncate(r.errorReason, MAX_TEXT_CHARS)
            } else if (text) {
              tool.result = text
            } else if (r.errorReason) {
              tool.error = truncate(r.errorReason, MAX_TEXT_CHARS)
            }
          }
        } else if (r.callId) {
          // 冷读截断等情况下有结果无调用：补一条，避免失败结果丢失。
          sink.push({
            kind: 'tool',
            callId: r.callId,
            name: '(result)',
            toolKind: 'tool',
            args: '',
            status: r.isError ? 'error' : 'ok',
            ...(r.isError && r.errorReason ? { error: truncate(r.errorReason, MAX_TEXT_CHARS) } : {}),
            ...(!r.isError && r.text ? { result: truncate(r.text, MAX_TEXT_CHARS) } : {}),
            ...(typeof d?.turn === 'number' ? { turn: d.turn } : {}),
            ...(typeof d?.step === 'number' ? { step: d.step } : {}),
            ...(time ? { time } : {}),
          })
        }
        break
      }
      default:
        // 未识别事件（step/*、system/*、assistant/attempt 等）不进时间线，安全跳过。
        break
    }
  }

  const { entries: out, truncated, total } = sink.finish()
  return { entries: out, truncated, total, ...(cursor !== undefined ? { cursor } : {}) }
}

/**
 * 定长轨迹收集器：保留头 {@link KEEP_HEAD} 条 + 滚动尾条，其余边收边丢但计数。
 *
 * 原实现先把全部条目攒进数组、**最后**才截断到 {@link MAX_ENTRIES}：一次 5 万条事件的
 * 会话会在截断之前把每条最多 2000 字正文 + 1500 字入参全部物化（峰值可达数百 MB），
 * 而这次映射跑在 GET 请求的同步路径上。改为收集时即丢弃后，峰值内存与事件总数无关，
 * 且保留的仍是"最早 KEEP_HEAD 条 + 最新若干条"，与旧的 slice 头尾截断等价。
 */
function createEntrySink(): {
  push(entry: TaskTraceEntry): void
  finish(): { entries: TaskTraceEntry[]; truncated: boolean; total: number }
} {
  const head: TaskTraceEntry[] = []
  const tail: TaskTraceEntry[] = []
  const tailLimit = Math.max(0, MAX_ENTRIES - KEEP_HEAD)
  let total = 0
  return {
    push(entry: TaskTraceEntry): void {
      total += 1
      if (head.length < KEEP_HEAD) {
        head.push(entry)
        return
      }
      if (tailLimit === 0) return
      tail.push(entry)
      // 超过尾部容量时挤掉最老的一条：tail 始终是"最新 tailLimit 条"。
      if (tail.length > tailLimit) tail.shift()
    },
    finish() {
      return { entries: [...head, ...tail], truncated: total > MAX_ENTRIES, total }
    },
  }
}

/** 入参不是字符串时的兜底序列化（模型理论上总给 JSON 字符串，这里只防异常形态）。 */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

/** 重复请求告警最多保留条数。 */
const MAX_REPEATED = 10
/** 重复请求入参归一化时保留的字符数（仅用于"是否相同"的判等，不展示全文）。 */
const REPEAT_ARGS_KEY_CHARS = 300

/** 把工具入参归一化为可判等的字符串：序列化 + 去空白 + 截断。 */
function normalizeArgs(args: unknown): string {
  const raw = typeof args === 'string' ? args : args === undefined ? '' : safeStringify(args)
  return raw.replace(/\s+/g, ' ').trim().slice(0, REPEAT_ARGS_KEY_CHARS)
}

/** 防御式读取 TokenUsage（字段缺失按 0 计）。 */
function readUsage(data: unknown): {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
  reasoning: number
} {
  const usage = (data as { message?: { usage?: unknown } })?.message?.usage
  if (!usage || typeof usage !== 'object') {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }
  }
  const u = usage as Record<string, unknown>
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
  return {
    input: num(u.inputTokens),
    output: num(u.outputTokens),
    cacheRead: num(u.cacheReadTokens),
    cacheWrite: num(u.cacheWriteTokens),
    reasoning: num(u.reasoningTokens),
  }
}

/**
 * 从**完整会话事件**聚合一次任务执行的统计（问题 2，对标 dsh-context 的上下文统计）。
 *
 * 与 {@link mapTraceEvents} 独立：时间线可能为防灌爆而截断，但统计必须全量，故这里直接遍历
 * 原始事件，不复用截断后的 entries。所有取数防御式判型，怪事件跳过不抛。
 *
 * 计数口径：
 *   - 模型请求 = `step/start` 数（一次模型思考 + 其工具执行）；日志无该事件时降级为助手消息数；
 *   - 工具调用 = `tool/call` 数，按 MCP / 技能 / 普通工具分类，并以"同名 + 同入参"识别重复请求；
 *   - token = 各步 `assistant/message.message.usage` 之和；total 按供应商计费口径
 *         = 未缓存 input + 缓存读 + 缓存写 + output（reasoning 已含在 output 内，不重复加）。
 *
 * @param rawEvents - `SessionObservation.events`（元素为 SessionEvent 信封）。
 */
export function summarizeTrace(rawEvents: readonly unknown[]): TaskTraceStats {
  const events = [...rawEvents].sort((a, b) => {
    const sa = (a as { seq?: number })?.seq ?? 0
    const sb = (b as { seq?: number })?.seq ?? 0
    return sa - sb
  })

  let modelRequests = 0
  let turns = 0
  let userInputs = 0
  let assistantMessages = 0
  let toolCalls = 0
  let toolOk = 0
  let toolError = 0
  let toolDurationMs = 0
  const tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 }
  const toolByKind: Record<TraceToolKind, number> = { mcp: 0, skill: 0, tool: 0 }

  /** callId → 工具开始时间（用于算耗时）。 */
  const callStart = new Map<string, number>()
  /**
   * callId → 工具名（用于把工具结果成败归到具体工具）。
   *
   * 原来每收到一条 `tool/result` 就把**整条事件序列**扫一遍找工具名
   * （`toolNameByCallId`），复杂度 O(事件数 × 结果数)。长会话里这条 GET 是在
   * 同步路径上跑这个二次复杂度，事件一多就明显卡顿。改为在 `tool/call` 分支
   * 顺手登记一次查表，复杂度回到 O(事件数)。
   */
  const callName = new Map<string, string>()
  /** 每个工具的聚合：分类 / 次数 / 成败。 */
  const perTool = new Map<string, { kind: TraceToolKind; count: number; ok: number; error: number }>()
  /** `${name} ${argsKey}` → 次数（重复请求检测）。 */
  const signatureCount = new Map<string, number>()
  /** `${name} ${argsKey}` → 展示用入参（截断）。 */
  const signatureArgs = new Map<string, string>()

  let startedAt: number | undefined
  let endedAt: number | undefined

  const bumpTime = (time: number | undefined): void => {
    if (typeof time !== 'number') return
    if (startedAt === undefined || time < startedAt) startedAt = time
    if (endedAt === undefined || time > endedAt) endedAt = time
  }

  for (const ev of events) {
    if (!ev || typeof ev !== 'object') continue
    const e = ev as { type?: unknown; time?: number; data?: unknown }
    bumpTime(e.time)
    const time = typeof e.time === 'number' ? e.time : undefined
    const data = e.data
    switch (e.type) {
      case 'step/start': {
        modelRequests += 1
        break
      }
      case 'turn/start': {
        turns += 1
        break
      }
      case 'user/message': {
        const d = data as { content?: unknown; message?: { content?: unknown } }
        const text = blocksToText(d?.content ?? d?.message?.content)
        if (text) userInputs += 1
        break
      }
      case 'assistant/message': {
        assistantMessages += 1
        const u = readUsage(data)
        tokens.input += u.input
        tokens.output += u.output
        tokens.cacheRead += u.cacheRead
        tokens.cacheWrite += u.cacheWrite
        tokens.reasoning += u.reasoning
        break
      }
      case 'tool/call': {
        const d = data as { callId?: unknown; name?: unknown; arguments?: unknown }
        const name = typeof d?.name === 'string' ? d.name : '(unknown)'
        const kind = classifyTool(name)
        toolCalls += 1
        toolByKind[kind] += 1
        const agg = perTool.get(name) ?? { kind, count: 0, ok: 0, error: 0 }
        agg.count += 1
        agg.kind = kind
        perTool.set(name, agg)
        if (typeof d?.callId === 'string' && typeof time === 'number') callStart.set(d.callId, time)
        if (typeof d?.callId === 'string') callName.set(d.callId, name)
        const argsKey = normalizeArgs(d?.arguments)
        const sig = `${name} ${argsKey}`
        signatureCount.set(sig, (signatureCount.get(sig) ?? 0) + 1)
        signatureArgs.set(sig, argsKey.slice(0, MAX_ARGS_CHARS))
        break
      }
      case 'tool/result': {
        const r = readToolResult(data)
        if (r.callId) {
          const start = callStart.get(r.callId)
          if (typeof start === 'number' && typeof time === 'number' && time >= start) {
            toolDurationMs += time - start
          }
          // 用 callId 反查工具名（tool/call 里登记过），成败计入对应工具。
          const name = callName.get(r.callId)
          if (name) {
            const agg = perTool.get(name)
            if (agg) {
              if (r.isError) {
                agg.error += 1
                toolError += 1
              } else {
                agg.ok += 1
                toolOk += 1
              }
            }
          } else if (r.isError) {
            toolError += 1
          } else {
            toolOk += 1
          }
        } else if (r.isError) {
          toolError += 1
        } else {
          toolOk += 1
        }
        break
      }
      default:
        break
    }
  }

  // 已发起但未配对结果的调用 = 仍在运行。
  const toolRunning = Math.max(0, toolCalls - toolOk - toolError)

  const toolBreakdown = [...perTool.entries()]
    .map(([name, v]) => {
      // 该工具下任一入参组合的最大重复次数。
      let duplicate = 1
      for (const [sig, count] of signatureCount) {
        if (sig.startsWith(`${name} `) && count > duplicate) duplicate = count
      }
      return { name, kind: v.kind, count: v.count, ok: v.ok, error: v.error, duplicate }
    })
    .sort((a, b) => b.count - a.count)

  const repeatedCalls = [...signatureCount.entries()]
    .filter(([, count]) => count >= 2)
    .map(([sig, count]) => {
      const idx = sig.indexOf(' ')
      const name = idx === -1 ? sig : sig.slice(0, idx)
      return { name, args: signatureArgs.get(sig) ?? '', count }
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_REPEATED)

  tokens.total = tokens.input + tokens.cacheRead + tokens.cacheWrite + tokens.output
  // 旧版日志可能没有 step/* 事件：用助手消息数兜底模型请求计数。
  const resolvedRequests = modelRequests > 0 ? modelRequests : assistantMessages

  return {
    modelRequests: resolvedRequests,
    turns,
    userInputs,
    assistantMessages,
    toolCalls,
    toolByKind,
    toolOk,
    toolError,
    toolRunning,
    toolDurationMs,
    toolBreakdown,
    repeatedCalls,
    tokens,
    ...(startedAt !== undefined ? { startedAt } : {}),
    ...(endedAt !== undefined ? { endedAt } : {}),
    ...(startedAt !== undefined && endedAt !== undefined && endedAt >= startedAt
      ? { durationMs: endedAt - startedAt }
      : {}),
  }
}

/** 事件信封的 seq（缺省 -1）。 */
function eventSeq(e: unknown): number {
  const seq = (e as { seq?: number } | undefined)?.seq
  return typeof seq === 'number' ? seq : -1
}
/** 事件 data.turn（turn/start、turn/end、tool/call、tool/result 携带；其余缺省）。 */
function eventTurn(e: unknown): number | undefined {
  const t = (e as { data?: { turn?: unknown } } | undefined)?.data?.turn
  return typeof t === 'number' && Number.isFinite(t) ? t : undefined
}

/**
 * 从复用 continuable 子会话的全部事件中，切出**某一轮（turn）**的事件（D6）。
 *
 * 复用子会话被多个任务顺序复用，整段会话含多轮；本函数以 `turn/start`、`turn/end` 的 seq
 * 为边界切片，使一次任务的轨迹与统计只反映本轮，不混入其它任务。
 *
 * 降级（冷读日志截断 / 事件形态缺失）：
 * - 找不到本 turn 的 `turn/start` 时，退而保留所有 `data.turn===turn` 的事件；
 * - 若连这也没有（无法判定），原样返回全部事件（旧行为），避免轨迹空白。
 *
 * @param rawEvents - observeSession 返回的完整事件。
 * @param turn - 本轮 turn 序号。
 */
export function filterEventsForTurn(
  rawEvents: readonly unknown[],
  turn: number,
): readonly unknown[] {
  const events = [...rawEvents].sort((a, b) => eventSeq(a) - eventSeq(b))

  let startSeq: number | undefined
  let endSeq: number | undefined
  let prevEndSeq: number | undefined
  for (const e of events) {
    const x = e as { type?: unknown; seq?: number; data?: { turn?: unknown } }
    if (x.type === 'turn/start' && eventTurn(x) === turn) startSeq = eventSeq(x)
    else if (x.type === 'turn/end' && eventTurn(x) === turn) endSeq = eventSeq(x)
    else if (x.type === 'turn/end' && eventTurn(x) === turn - 1) prevEndSeq = eventSeq(x)
  }

  if (startSeq !== undefined) {
    // 下界优先用上一轮 end（兼容 user/message 落在 turn/start 前一个 seq 的形态），否则取本轮 start 前。
    const lo = prevEndSeq ?? startSeq - 1
    return events.filter(e => {
      const s = eventSeq(e as { seq?: number })
      if (s <= lo) return false
      if (endSeq !== undefined && s > endSeq) return false
      return true
    })
  }

  const byTurn = events.filter(e => eventTurn(e as { data?: { turn?: unknown } }) === turn)
  if (byTurn.length > 0) return byTurn
  return events
}

/**
 * 定时执行（2026-11-03 问题 4/5）：**纯逻辑**层。
 *
 * 两条入口共用同一套语义：
 *   - 执行配置页「发起执行」可选 立刻(默认) / 定时（精确到分）；
 *   - 任务中心「拆解任务」弹框同样可选 立刻(默认) / 定时 —— 到点后主 agent
 *     开始按依赖关系编排子 Agent（上个任务完成才编排下个）。
 *
 * 本模块只放「时间怎么解析/校验/比较/展示」；真正到点触发在宿主
 * `host/scheduler.ts`（落盘 + 定时器 + 重启补跑），不混进纯逻辑。
 */

/** 执行时机：'now' = 立刻；'at' = 定时（dueAt 为 ISO 串）。 */
export type ScheduleMode = 'now' | 'at'

/** 一次执行的时机安排。 */
export interface SchedulePlan {
  mode: ScheduleMode
  /** ISO 8601 时间串（仅 mode='at' 时有）；精确到分。 */
  dueAt?: string
}

/** 定时计划的校验结果。 */
export type ScheduleValidation =
  | { ok: true; plan: SchedulePlan }
  | { ok: false; reason: string }

/**
 * `<input type="datetime-local">` 的值 ↔ ISO 串。
 *
 * HTML 控件给的是 `YYYY-MM-DDTHH:mm`（本地时间、无秒、无时区后缀）。
 * 存储与比较一律用 ISO 串（`Date.prototype.toISOString()`，UTC）——
 * 落盘后跨时区/跨重启仍然单调可比，这是定时器补跑的正确性前提。
 */
export function parseDateTimeLocal(raw: string, now: Date = new Date()): ScheduleValidation {
  const t = raw.trim()
  if (!t) return { ok: false, reason: '请选择执行时间（精确到分）' }
  // 只认 `YYYY-MM-DDTHH:mm`（可带秒）；Date.parse 对垃圾输入也可能给出 NaN 之外的结果，
  // 故先做形状校验再转日期，宁可拒绝也不猜。
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2}))?$/.exec(t)
  if (!m) return { ok: false, reason: '时间格式应为 YYYY-MM-DD HH:mm（精确到分）' }
  const [, y, mo, d, h, mi, s] = m
  const date = new Date(
    Number(y),
    Number(mo) - 1,
    Number(d),
    Number(h),
    Number(mi),
    Number(s ?? '0'),
    0,
  )
  if (
    date.getFullYear() !== Number(y)
    || date.getMonth() !== Number(mo) - 1
    || date.getDate() !== Number(d)
    || date.getHours() !== Number(h)
    || date.getMinutes() !== Number(mi)
  ) {
    return { ok: false, reason: '时间不存在（请检查日期与小时/分钟）' }
  }
  if (date.getTime() <= now.getTime()) {
    return { ok: false, reason: '定时时间必须晚于当前时间' }
  }
  return { ok: true, plan: { mode: 'at', dueAt: date.toISOString() } }
}

/**
 * 校验一条完整的执行时机安排（弹框/表单提交时用）。
 *
 * @param input.mode - 'now' | 'at'。
 * @param input.dueAtLocal - datetime-local 控件的值（仅 mode='at' 需要）。
 * @param input.now - 当前时刻（可注入，便于测试）。
 */
export function validateSchedule(input: {
  mode: string
  dueAtLocal: string
  now?: Date
}): ScheduleValidation {
  const mode = input.mode === 'at' ? 'at' : 'now'
  if (mode === 'now') return { ok: true, plan: { mode: 'now' } }
  return parseDateTimeLocal(input.dueAtLocal, input.now ?? new Date())
}

/** 定时项是否已到点（供调度器每个心跳判断；不含"刚刚好"的边界魔数）。 */
export function isDue(plan: SchedulePlan, now: Date = new Date()): boolean {
  if (plan.mode === 'now') return true
  if (!plan.dueAt) return false
  const t = Date.parse(plan.dueAt)
  if (Number.isNaN(t)) return false
  return t <= now.getTime()
}

/** 距到点还有多少毫秒（已到点/无 dueAt 返回 0；供 setTimeout 取值）。 */
export function msUntilDue(plan: SchedulePlan, now: Date = new Date()): number {
  if (plan.mode === 'now' || !plan.dueAt) return 0
  const t = Date.parse(plan.dueAt)
  if (Number.isNaN(t)) return 0
  return Math.max(0, t - now.getTime())
}

/**
 * 把 ISO 串格式化回 `YYYY-MM-DD HH:mm`（本地时区，精确到分）。
 * 非法输入返回空串（不让 UI 显示 "Invalid Date"）。
 */
export function formatLocalMinute(iso: string | undefined): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`
}

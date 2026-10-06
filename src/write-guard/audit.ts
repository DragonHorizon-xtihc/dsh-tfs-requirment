/**
 * 审计日志（S-03 / SC-008，Principle II/III：凭据不落审计）。
 *
 * - append-only：绝不修改/删除已提交条目（插件不可删改）；
 * - 写入前**递归剔除凭据字段**（PAT / token / password / secret ...）；
 * - 每条审计条目自带 `idempotencyKey`，与写调用一一对齐（SC-008）；
 * - 90 天滚动：提供 `rollOver()` 返回过期条目供归档，**不修改 live 日志**
 *   （live 保持 append-only；归档由调用方另行落盘 S-03）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/write-guard/audit
 */

import type { WriteOpType } from '../tfs/types.js'
import { EventLog } from '../persistence/events.js'
import { realFs, type FsLike } from '../persistence/fs-like.js'

/** 凭据类字段名（匹配即剔除，不区分大小写）。 */
const CREDENTIAL_PATTERN =
  /^(pat|pat_?token|token|password|passwd|pwd|secret|client_?secret|access_?key|access_?token|authorization|auth|api_?key|api_?keys|credential|private_?key|connection_?string)$/i

/** 审计事件类型。 */
export type AuditKind = 'write' | 'tag' | 'link' | 'state' | 'comment' | 'system'

/** 单条审计事件（detail 已被剔除凭据）。 */
export interface AuditEvent {
  ts: string
  kind: AuditKind
  workItemId?: string | number
  collection?: string
  opType?: WriteOpType
  /** 与写调用对齐的幂等键（SC-008）。 */
  idempotencyKey?: string
  /**
   * 本条事件**作废**的幂等键（append-only 的补偿事件）。
   *
   * 标签类幂等键（`<id>@<coll>:<label>`）记录的是"这个工作项现在带这个标签"这一**状态**。
   * 「还原到需求池」把标签摘掉之后，如果账本里还留着那条 apply，同一需求就再也领不回来
   * ——门禁 3 会把重领判成重复。日志是 append-only 的，不能去删那条历史记录，因此改为
   * 追加一条带 `releases` 的补偿事件；按写入顺序重放时它把该键从已应用集合里移除，
   * 其后再发生同标签的 apply 仍会把它加回来，顺序语义正确。
   */
  releases?: string
  /** 事件详情（凭据已剔除）。 */
  detail: Record<string, unknown>
  /** 是否为 dry-run 预览（未实际写 TFS）。 */
  dryRun?: boolean
  /** 是否经用户确认。 */
  confirmed?: boolean
}

/** 是否凭据类字段名。 */
export function isCredentialKey(key: string): boolean {
  return CREDENTIAL_PATTERN.test(key)
}

/** 递归剔除凭据字段（返回新对象，不修改入参）。 */
export function stripCredentials(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(stripCredentials)
  }
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (isCredentialKey(k)) continue
      out[k] = stripCredentials(v)
    }
    return out
  }
  return value
}

/**
 * 审计日志。包装 `EventLog`（append-only）。
 */
export class AuditLog {
  private readonly log: EventLog

  constructor(baseDir: string, fs: FsLike = realFs) {
    this.log = new EventLog(baseDir, 'audit.jsonl', fs)
  }

  /**
   * 追加一条审计事件（凭据字段在落盘前剔除）。
   * @param event - 不含 ts 的事件（ts 由日志自动打）。
   */
  append(event: Omit<AuditEvent, 'ts'>): void {
    const record: AuditEvent = {
      ...event,
      ts: new Date().toISOString(),
      detail: stripCredentials(event.detail) as Record<string, unknown>,
    }
    this.log.append(record as unknown as Record<string, unknown>)
  }

  /** 重放全部审计事件（按写入顺序）。坏行抛错，供诊断方转成 `ok:false + 原因`。 */
  replay(): AuditEvent[] {
    return this.log.replay() as unknown as AuditEvent[]
  }

  /**
   * **门禁 3 专用**的重放：跳过无法解析的行。
   *
   * 判重账本是可读的输入，不是诊断对象。append-only 日志里出现半行（并发进程交错、
   * 崩溃、外部截断）时，严格重放会让 `SyntaxError` 冒出 `WriteGuard.gate`，于是
   * **此后每一次 TFS 写操作**都带着未处理异常失败，且面板上没有任何提示。跳过坏行
   * 换来的是：最多丢失那几行的幂等键（重复写风险仅限这几笔），而不是写入能力整体丧失。
   */
  replayForDedupe(): AuditEvent[] {
    return this.log.replay({ skipCorrupt: true }) as unknown as AuditEvent[]
  }

  /**
   * 返回早于 `retentionDays` 天的事件（供归档），**不修改 live 日志**。
   * @param retentionDays - 保留天数（默认 90，S-03）。
   * @param now - 当前时间（可注入，便于测试）。
   */
  rollOver(retentionDays = 90, now: Date = new Date()): AuditEvent[] {
    const cutoff = now.getTime() - retentionDays * 86_400_000
    return this.replay().filter(e => Date.parse(e.ts) < cutoff)
  }
}

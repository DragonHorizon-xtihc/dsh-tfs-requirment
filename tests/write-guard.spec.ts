import { beforeEach, describe, expect, it } from 'vitest'
import {
  labelIdempotencyKey,
  normalizeLabel,
  stableHash,
  writeIdempotencyKey,
} from '../src/write-guard/idempotency.js'
import { AuditLog, isCredentialKey, stripCredentials } from '../src/write-guard/audit.js'
import { buildDryRunPreview, diffValues } from '../src/write-guard/dryrun.js'
import { WriteGuard } from '../src/write-guard/index.js'
import type { WriteOp } from '../src/tfs/types.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

let memFs: MemFs
beforeEach(() => {
  memFs = createMemFs()
})

describe('idempotency', () => {
  it('normalizeLabel 去空白并转小写', () => {
    expect(normalizeLabel('  DSH  ')).toBe('dsh')
    expect(normalizeLabel('DSH')).toBe('dsh')
  })

  it('标签幂等键跨进程稳定且同意图同键', () => {
    const a = labelIdempotencyKey(123, 'WN_HIS', 'dsh')
    const b = labelIdempotencyKey(123, 'WN_HIS', ' DSH ')
    const c = labelIdempotencyKey(123, 'WN_HIS', 'done')
    expect(a).toBe(b) // 归一化后同键
    expect(a).not.toBe(c)
    expect(a).toBe('123@WN_HIS:dsh')
  })

  it('stableHash 对同值跨进程一致、异值不同', () => {
    const x = stableHash({ a: 1, b: [1, 2] })
    const y = stableHash({ b: [1, 2], a: 1 }) // 键序不同
    const z = stableHash({ a: 2 })
    expect(x).toBe(y)
    expect(x).not.toBe(z)
  })

  it('回写幂等键对同一意图变更稳定', () => {
    const input = { targetWorkItem: '1@WN_HIS', opType: 'state' as const, before: 'Active', after: 'Done' }
    expect(writeIdempotencyKey(input)).toBe(writeIdempotencyKey({ ...input }))
  })
})

describe('audit', () => {
  it('isCredentialKey 识别凭据字段', () => {
    expect(isCredentialKey('pat')).toBe(true)
    expect(isCredentialKey('token')).toBe(true)
    expect(isCredentialKey('password')).toBe(true)
    expect(isCredentialKey('state')).toBe(false)
  })

  it('stripCredentials 递归剔除凭据、保留其余', () => {
    const cleaned = stripCredentials({
      state: 'Done',
      pat: 'secret-pat',
      nested: { token: 'x', title: 'ok' },
    }) as Record<string, unknown>
    expect(cleaned.pat).toBeUndefined()
    expect((cleaned.nested as Record<string, unknown>).token).toBeUndefined()
    expect(cleaned.state).toBe('Done')
    expect((cleaned.nested as Record<string, unknown>).title).toBe('ok')
  })

  it('append-only：重放顺序与写入一致，且剔除凭据', () => {
    const log = new AuditLog('/mem/audit', memFs)
    log.append({ kind: 'write', opType: 'tag', idempotencyKey: 'k1', detail: { pat: 'SECRET', label: 'dsh' } })
    log.append({ kind: 'write', opType: 'state', idempotencyKey: 'k2', detail: { state: 'Done' } })
    const all = log.replay()
    expect(all).toHaveLength(2)
    expect(all[0]!.idempotencyKey).toBe('k1')
    // 凭据不落审计
    for (const e of all) {
      expect(JSON.stringify(e.detail)).not.toContain('SECRET')
      expect(JSON.stringify(e.detail)).not.toMatch(/"pat"/)
    }
    expect(all[1]!.detail.state).toBe('Done')
  })

  it('rollOver 按保留期分区（不修改 live 日志）', () => {
    const log = new AuditLog('/mem/audit', memFs)
    log.append({ kind: 'write', idempotencyKey: 'k1', detail: {} })
    // 将来 100 天：全部过期
    const future = new Date(Date.now() + 100 * 86_400_000)
    const expired = log.rollOver(90, future)
    expect(expired).toHaveLength(1)
    // live 日志未被修改
    expect(log.replay()).toHaveLength(1)
    // 现在：无过期
    expect(log.rollOver(90, new Date())).toHaveLength(0)
  })
})

describe('dryrun', () => {
  it('diffValues 对数组求集合差（标签增删）', () => {
    const diffs = diffValues('tags', ['dsh'], ['dsh', 'done'])
    expect(diffs).toContainEqual({ field: 'tags', kind: 'added', after: ['done'] })
    const removed = diffValues('tags', ['dsh', 'old'], ['dsh'])
    expect(removed).toContainEqual({ field: 'tags', kind: 'removed', before: ['old'] })
  })

  it('diffValues 对标量求 changed', () => {
    const diffs = diffValues('state', 'Active', 'Done')
    expect(diffs).toEqual([{ field: 'state', kind: 'changed', before: 'Active', after: 'Done' }])
  })

  it('buildDryRunPreview 透传幂等键并产出 diffs', () => {
    const p = buildDryRunPreview({
      targetWorkItem: '1@WN_HIS',
      opType: 'tag',
      idempotencyKey: 'k1',
      before: [],
      after: ['dsh'],
    })
    expect(p.idempotencyKey).toBe('k1')
    expect(p.diffs).toContainEqual({ field: 'tags', kind: 'added', after: ['dsh'] })
  })
})

describe('WriteGuard 四道门禁（T026 协同）', () => {
  function makeOp(over: Partial<WriteOp> = {}): WriteOp {
    return {
      targetWorkItem: '1@WN_HIS',
      opType: 'tag',
      before: [],
      after: ['dsh'],
      idempotencyKey: 'k1',
      ...over,
    }
  }

  it('门禁2：未确认即拒', () => {
    const guard = new WriteGuard(new AuditLog('/mem/audit', memFs))
    const r = guard.gate(makeOp(), { confirmed: false })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('确认')
    expect(r.preview).toBeDefined()
  })

  it('门禁1-3 通过后由 record 落一条审计且带幂等键', () => {
    const audit = new AuditLog('/mem/audit', memFs)
    const guard = new WriteGuard(audit)
    const op = makeOp()
    const r = guard.gate(op, { confirmed: true })
    expect(r.ok).toBe(true)
    // 门禁通过时**不**记账：写调用尚未发生，幂等键还不能代表"已应用"（A3）。
    expect(audit.replay()).toHaveLength(0)
    guard.record(op)
    const all = audit.replay()
    expect(all).toHaveLength(1)
    expect(all[0]!.idempotencyKey).toBe('k1')
  })

  it('写调用失败时不记账：同一幂等键仍可重试', () => {
    const audit = new AuditLog('/mem/audit', memFs)
    const guard = new WriteGuard(audit)
    // 第一轮：过门禁但不调 record（模拟 REST 调用失败）。
    expect(guard.gate(makeOp(), { confirmed: true }).ok).toBe(true)
    // 重试必须仍能过门禁 3，否则一次超时 / 412 之后写入就永久被当成"已应用"。
    expect(guard.gate(makeOp(), { confirmed: true }).ok).toBe(true)
  })

  it('门禁3：同幂等键重复回写被拒（幂等）', () => {
    const audit = new AuditLog('/mem/audit', memFs)
    const guard = new WriteGuard(audit)
    const op = makeOp()
    expect(guard.gate(op, { confirmed: true }).ok).toBe(true)
    guard.record(op)
    const second = guard.gate(op, { confirmed: true })
    expect(second.ok).toBe(false)
    expect(second.reason).toContain('幂等')
    // 审计条目仍为 1 条（未重复落盘）
    expect(audit.replay()).toHaveLength(1)
  })

  it('审计剔除凭据：经 record 的回写不落 PAT', () => {
    const audit = new AuditLog('/mem/audit', memFs)
    const guard = new WriteGuard(audit)
    const op = makeOp({ after: { pat: 'SECRET', label: 'dsh' } as unknown })
    guard.gate(op, { confirmed: true })
    guard.record(op)
    const detail = JSON.stringify(audit.replay()[0]!.detail)
    expect(detail).not.toContain('SECRET')
    expect(detail).not.toMatch(/"pat"/)
  })
})

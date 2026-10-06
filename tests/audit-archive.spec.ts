import { describe, expect, it } from 'vitest'
import { AuditArchive, ARCHIVE_PREFIX } from '../src/host/audit-archive.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'

/**
 * 审计滚动归档单测（T063 / S-03）。
 *
 * 覆盖的核心不变式（都是"用户可见的后果"）：
 * 1. live `audit.jsonl` **绝不被修改**（append-only 不可破）——归档前后逐字节比对；
 * 2. 重复归档幂等（第二次不重复写入同一批条目）；
 * 3. 无过期条目时**不创建空文件**（否则目录里会出现"假装归档过"的痕迹）；
 * 4. 归档内容 == live 中对应条目（含"凭据已被 append 阶段剔除"这一事实）；
 * 5. 审计文件损坏时给出可读失败原因，而不是抛异常炸掉诊断页。
 */

const DAY = 86_400_000

function setup(retentionDays = 90): {
  fs: ReturnType<typeof createMemFs>
  audit: AuditLog
  archive: AuditArchive
  baseDir: string
} {
  const baseDir = '/data'
  const fs = createMemFs()
  const audit = new AuditLog(baseDir, fs)
  const archive = new AuditArchive({ baseDir, audit, retentionDays, fs })
  return { fs, audit, archive, baseDir }
}

describe('AuditArchive.inspect', () => {
  it('归档文件名按 UTC 日期（audit-archive-YYYYMMDD.jsonl）', () => {
    const { archive } = setup()
    expect(archive.archiveFileName(new Date('2026-09-10T00:00:00Z'))).toBe(`${ARCHIVE_PREFIX}20260910.jsonl`)
  })

  it('空日志：total=0 / expired=0 / 无归档文件', () => {
    const { archive } = setup()
    const view = archive.inspect()
    expect(view.ok).toBe(true)
    expect(view.total).toBe(0)
    expect(view.expired).toBe(0)
    expect(view.retentionDays).toBe(90)
    expect(view.archiveFiles).toEqual([])
  })

  it('保留期内的条目不进入 expired', () => {
    const { audit, archive } = setup(90)
    audit.append({ kind: 'write', detail: { a: 1 } })
    const view = archive.inspect()
    expect(view.total).toBe(1)
    expect(view.expired).toBe(0)
  })

  it('审计文件损坏：ok=false + 可读原因，不抛异常', () => {
    const { fs, archive, baseDir } = setup()
    fs.writeFileSync(`${baseDir}/audit.jsonl`, '{ 这不是 JSON', 'utf8')
    const view = archive.inspect()
    expect(view.ok).toBe(false)
    expect(view.reason).toBeTruthy()
  })
})

describe('AuditArchive.archive', () => {
  it('无过期条目：archived=0 且不创建归档文件', () => {
    const { fs, audit, archive } = setup(90)
    audit.append({ kind: 'write', detail: {} })
    const res = archive.archive()
    expect(res.ok).toBe(true)
    expect(res.archived).toBe(0)
    expect(res.archivePath).toBeUndefined()
    const names = Object.keys(fs.dump()).map(p => p.split('/').pop() ?? '')
    expect(names.some(n => n.startsWith(ARCHIVE_PREFIX))).toBe(false)
  })

  it('有过期条目：写入独立归档文件，且 live 审计日志逐字节不变', () => {
    const { fs, audit, archive, baseDir } = setup(1)
    audit.append({ kind: 'write', workItemId: 1, detail: { step: 'a' } })
    audit.append({ kind: 'tag', workItemId: 2, detail: { step: 'b' } })
    const liveBefore = fs.readFileSync(`${baseDir}/audit.jsonl`, 'utf8')

    // now 推到 10 天后 → 两条都超出 1 天保留期。
    const later = new Date(Date.now() + 10 * DAY)
    const res = archive.archive(later)
    expect(res.ok).toBe(true)
    expect(res.archived).toBe(2)
    expect(res.archivePath).toContain(ARCHIVE_PREFIX)

    // 关键不变式：live 未被改动。
    expect(fs.readFileSync(`${baseDir}/audit.jsonl`, 'utf8')).toBe(liveBefore)
    // 归档文件确实存在且含两条。
    const archived = archive.readArchive(archive.archiveFileName(later))
    expect(archived).toHaveLength(2)
    expect(archived.map(e => e.kind)).toEqual(['write', 'tag'])
  })

  it('归档内容与 live 条目一致（含 append 阶段已剔除凭据这一事实）', () => {
    const { audit, archive } = setup(1)
    // detail 里塞凭据类字段：AuditLog.append 应在落盘前剔除（审计凭据不落盘的唯一防线）。
    audit.append({
      kind: 'write',
      workItemId: 7,
      detail: { pat: 'super-secret', nested: { password: 'p@ss', ok: true } },
    })
    const later = new Date(Date.now() + 5 * DAY)
    archive.archive(later)
    const [record] = archive.readArchive(archive.archiveFileName(later))
    expect(record).toBeDefined()
    const detail = record?.detail as Record<string, unknown>
    expect(detail['pat']).toBeUndefined()
    expect(JSON.stringify(record)).not.toContain('super-secret')
    expect(JSON.stringify(record)).not.toContain('p@ss')
    expect((detail['nested'] as Record<string, unknown>)['ok']).toBe(true)
  })

  it('重复归档幂等：第二次 archived=0，文件内容不重复', () => {
    const { audit, archive } = setup(1)
    audit.append({ kind: 'write', detail: { n: 1 } })
    const later = new Date(Date.now() + 5 * DAY)

    const first = archive.archive(later)
    expect(first.archived).toBe(1)
    const second = archive.archive(later)
    expect(second.ok).toBe(true)
    expect(second.archived).toBe(0)

    expect(archive.readArchive(archive.archiveFileName(later))).toHaveLength(1)
  })

  it('不同日期归档到不同文件；已归档过的条目不重复归档（跨文件去重）', () => {
    const { audit, archive } = setup(1)
    audit.append({ kind: 'write', detail: { n: 1 } })
    const day1 = new Date(Date.now() + 5 * DAY)
    const day2 = new Date(Date.now() + 6 * DAY)
    expect(archive.archiveFileName(day1)).not.toBe(archive.archiveFileName(day2))

    expect(archive.archive(day1).archived).toBe(1)
    // live 从不截断 → 同一条目在 day2 仍属"过期"，但已被归档，故不得重复写入。
    expect(archive.archive(day2).archived).toBe(0)

    // 新产生的过期条目会落到 day2 的文件里。
    audit.append({ kind: 'tag', detail: { n: 2 } })
    expect(archive.archive(day2).archived).toBe(1)

    const view = archive.inspect()
    expect(view.archiveFiles.map(f => f.name).sort()).toEqual(
      [archive.archiveFileName(day1), archive.archiveFileName(day2)].sort(),
    )
    expect(view.archiveFiles.every(f => f.bytes > 0)).toBe(true)
    expect(view.archiveFiles.reduce((n, f) => n + archive.readArchive(f.name).length, 0)).toBe(2)
  })

  it('审计文件损坏：archive 返回 ok=false + 原因（不静默成功）', () => {
    const { fs, archive, baseDir } = setup(1)
    fs.writeFileSync(`${baseDir}/audit.jsonl`, 'not json at all', 'utf8')
    const res = archive.archive(new Date(Date.now() + 5 * DAY))
    expect(res.ok).toBe(false)
    expect(res.reason).toBeTruthy()
  })

  it('归档后 live 仍可继续追加（append-only 未被破坏）', () => {
    const { fs, audit, archive, baseDir } = setup(1)
    audit.append({ kind: 'write', detail: {} })
    archive.archive(new Date(Date.now() + 5 * DAY))
    audit.append({ kind: 'comment', detail: { after: true } })
    const live = fs.readFileSync(`${baseDir}/audit.jsonl`, 'utf8').split('\n').filter(l => l.trim())
    expect(live).toHaveLength(2)
    expect(audit.replay()).toHaveLength(2)
  })
})

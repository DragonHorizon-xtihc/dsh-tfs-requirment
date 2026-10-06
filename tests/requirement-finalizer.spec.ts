import { describe, expect, it, vi } from 'vitest'
import { RequirementFinalizer } from '../src/host/requirement-finalizer.js'
import type { RequirementWriteBackPort } from '../src/tfs/system-writeback.js'
import type { Requirement } from '../src/tfs/types.js'
import type { RequirementWriteBackReport, WriteBackItemResult } from '../src/shared/contracts.js'

/**
 * 需求完成自动回写编排器单测（问题 4）。全程内存桩 port / fs / board，不触真实 TFS。
 * 覆盖：
 *  - happy path：评审/自测两字段一次 PATCH、结论评论、产物附件、关联任务置已解决 + FinishDate=明天；
 *  - 前置门禁：任务未全部完成不回写、不落账；
 *  - 幂等：已成功回写不重复请求；
 *  - partial 重跑：只补上次失败项，已成功项跳过（减少无意义请求）；
 *  - 附件安全校验：非绝对路径 / 非法扩展名 / 越出工作区 / 空文件一律跳过；
 *  - 终态关联任务不再置已解决。
 */

const REVIEW_FIELD = 'Microsoft.VSTS.Common.RequirementReview'
const TEST_FIELD = 'Microsoft.VSTS.Common.RequirementTest'

interface CallLog {
  updateFields: Array<{ id: unknown; fields: Record<string, string> }>
  addComment: Array<{ id: unknown; comment: string }>
  upload: Array<{ path: string; name?: string }>
  resolve: Array<{ id: number; state: string; date: string }>
  getFields: number
  findLinked: number
}

interface TaskStub {
  taskId: string
  requirementId: string
  state: string
  title: string
  roleAgent: string
  workspace?: string
  artifactPaths?: string[]
  attempts: Array<{ outcome: string; output?: string }>
}

function makeHarness(opts?: {
  taskStates?: string[]
  artifacts?: string[]
  linked?: Array<{ id: number; title: string; state: string; via: string }>
  currentFields?: Record<string, string>
  fileSizes?: Record<string, number>
}) {
  const states = opts?.taskStates ?? ['completed', 'completed']
  const artifacts = opts?.artifacts ?? ['D:\\repo\\方案.md']
  const linked = opts?.linked ?? [
    { id: 601, title: '开发任务', state: '活动', via: 'wiql' },
    { id: 602, title: '已关闭任务', state: '已关闭', via: 'relation' },
  ]
  const tasks: TaskStub[] = [
    {
      taskId: '500@WN_HIS#analyze', requirementId: '500@WN_HIS', state: states[0]!, title: '分析', roleAgent: '架构师',
      workspace: 'D:\\repo', artifactPaths: states[0] === 'completed' ? artifacts : [],
      attempts: [{ outcome: 'success', output: '分析结论：分三步落地' }],
    },
    {
      taskId: '500@WN_HIS#impl', requirementId: '500@WN_HIS', state: states[1]!, title: '实现', roleAgent: '开发',
      workspace: 'D:\\repo', attempts: [{ outcome: 'success', output: '实现完成，已自测通过' }],
    },
  ]
  const req = {
    workItemId: 500,
    id: 500,
    collection: 'WN_HIS',
    title: '需求500',
    workspace: 'D:\\repo',
  } as unknown as Requirement
  const board = { snapshot: { requirements: { '500@WN_HIS': req }, tasks } } as never

  const log: CallLog = { updateFields: [], addComment: [], upload: [], resolve: [], getFields: 0, findLinked: 0 }
  let failFields = false
  const port: RequirementWriteBackPort = {
    async getFields() {
      log.getFields += 1
      return opts?.currentFields ?? {}
    },
    async updateFields(id, _c, fields) {
      if (failFields) throw new Error('PATCH 500')
      log.updateFields.push({ id, fields })
      return { status: 'ok' }
    },
    async addComment(id, _c, comment) {
      log.addComment.push({ id, comment })
      return { status: 'ok' }
    },
    async uploadAttachment(_id, _c, filePath, fileName) {
      log.upload.push({ path: filePath, name: fileName })
      return { status: 'ok', name: fileName }
    },
    async findLinkedTasks() {
      log.findLinked += 1
      return linked
    },
    async resolveTask(id, _c, state, date) {
      log.resolve.push({ id: Number(id), state, date })
      return { status: 'ok' }
    },
  }

  const sizes = opts?.fileSizes ?? {}
  const fs = {
    statSync: (p: string) => ({ isFile: () => true, size: p in sizes ? sizes[p]! : 100 }),
  } as never

  // saveReport 同时回写到 req.writeBack，模拟 BoardService 落账（供幂等 / partial 读取）。
  const saveReport = vi.fn((_key: string, report: RequirementWriteBackReport) => {
    req.writeBack = report
  })

  const now = new Date(2026, 8, 22, 10, 0, 0) // 本地 2026-09-22
  const finalizer = new RequirementFinalizer({ board, port, saveReport, fs, now: () => now })
  return { finalizer, log, saveReport, req, setFailFields: (b: boolean) => {
    failFields = b
  } }
}

describe('问题 4：需求完成自动回写 happy path', () => {
  it('评审/自测字段一次合并 PATCH，评论/附件/关联任务收口，FinishDate=明天', async () => {
    const h = makeHarness()
    const report = await h.finalizer.runWriteBack('500@WN_HIS')
    expect(report.status).toBe('ok')

    // ①② 两字段合并为一次 PATCH（减少请求数）。
    expect(h.log.updateFields).toHaveLength(1)
    expect(h.log.updateFields[0]!.fields).toEqual({
      [REVIEW_FIELD]: '评审通过',
      [TEST_FIELD]: '自测通过',
    })

    // ③ 结论评论汇总任务产出 + 附件清单 + 明天日期。
    expect(h.log.addComment).toHaveLength(1)
    const comment = h.log.addComment[0]!.comment
    expect(comment).toContain('DSH 自动回写')
    expect(comment).toContain('分析结论：分三步落地')
    expect(comment).toContain('实现完成，已自测通过')
    expect(comment).toContain('方案.md')
    expect(comment).toContain('2026-09-23') // @today + 1（本地时区）

    // ④ 产物上传为附件。
    expect(h.log.upload.map(u => u.name)).toContain('方案.md')

    // ⑤ 仅非终态关联任务被置「已解决」，FinishDate=明天；已关闭任务跳过。
    expect(h.log.resolve).toHaveLength(1)
    expect(h.log.resolve[0]).toMatchObject({ id: 601, state: '已解决', date: '2026-09-23' })
    const linkedItems = report.items.filter(i => i.kind === 'linked-task')
    expect(linkedItems.find(i => i.target.includes('602'))?.status).toBe('skipped')
  })

  it('字段在 TFS 上已达标 → 读值后跳过，不发 PATCH', async () => {
    const h = makeHarness({
      currentFields: { [REVIEW_FIELD]: '评审通过', [TEST_FIELD]: '自测通过' },
    })
    const report = await h.finalizer.runWriteBack('500@WN_HIS')
    expect(h.log.updateFields).toHaveLength(0)
    expect(report.items.filter(i => i.kind === 'field').every(i => i.status === 'skipped')).toBe(true)
  })
})

describe('问题 4：前置门禁', () => {
  it('尚有任务未完成 → 返回 error 报告、不触达 TFS、不落账', async () => {
    const h = makeHarness({ taskStates: ['completed', 'pending'] })
    const report = await h.finalizer.runWriteBack('500@WN_HIS')
    expect(report.status).toBe('error')
    expect(report.summary).toContain('未完成')
    expect(h.log.updateFields).toHaveLength(0)
    expect(h.log.addComment).toHaveLength(0)
    // 前置失败直接返回，不写 running/终态报告。
    expect(h.saveReport).not.toHaveBeenCalled()
  })

  it('maybeFinalize 在未就绪时静默返回 undefined', async () => {
    const h = makeHarness({ taskStates: ['completed', 'in_progress'] })
    const r = await h.finalizer.maybeFinalize('500@WN_HIS')
    expect(r).toBeUndefined()
    expect(h.log.updateFields).toHaveLength(0)
  })

  it('需求不在本地池 → runWriteBack 抛错', async () => {
    const h = makeHarness()
    await expect(h.finalizer.runWriteBack('999@WN_HIS')).rejects.toThrow(/不在本地池/)
  })
})

describe('问题 4：幂等与 partial 重跑（避免重复请求）', () => {
  it('已成功回写后再次 maybeFinalize：直接复用报告、零额外请求', async () => {
    const h = makeHarness()
    const first = await h.finalizer.maybeFinalize('500@WN_HIS')
    expect(first?.status).toBe('ok')
    const writesAfterFirst = h.log.updateFields.length + h.log.addComment.length
    const again = await h.finalizer.maybeFinalize('500@WN_HIS')
    expect(again).toBe(first)
    expect(h.log.updateFields.length + h.log.addComment.length).toBe(writesAfterFirst)
  })

  it('首跑字段 PATCH 失败（partial），恢复后重跑只补字段、评论/附件/已处理任务不再请求', async () => {
    const h = makeHarness()
    h.setFailFields(true)
    const first = await h.finalizer.runWriteBack('500@WN_HIS')
    expect(first.status).toBe('partial')
    // 首跑：评论/附件/关联任务成功，仅两字段失败。
    expect(h.log.addComment).toHaveLength(1)
    expect(h.log.upload).toHaveLength(1)
    expect(h.log.resolve).toHaveLength(1)
    expect(first.items.filter(i => i.kind === 'field' && i.status === 'error')).toHaveLength(2)

    // 记录首跑后各副作用计数，恢复端口后在同一 finalizer / 同一账本上重跑。
    const commentsAfterFirst = h.log.addComment.length
    const uploadsAfterFirst = h.log.upload.length
    const resolvesAfterFirst = h.log.resolve.length
    h.setFailFields(false)
    const second = await h.finalizer.runWriteBack('500@WN_HIS')
    expect(second.status).toBe('ok')

    // 字段本次补上：两字段合并为 1 次 PATCH（首跑失败未计入）。
    expect(h.log.updateFields).toHaveLength(1)
    expect(h.log.updateFields[0]!.fields[REVIEW_FIELD]).toBe('评审通过')
    // 已成功项不重复请求：评论 / 附件 / 关联任务调用数零增长。
    expect(h.log.addComment.length).toBe(commentsAfterFirst)
    expect(h.log.upload.length).toBe(uploadsAfterFirst)
    expect(h.log.resolve.length).toBe(resolvesAfterFirst)
  })
})

describe('问题 4：附件安全校验', () => {
  it('非绝对路径 / 非法扩展名 / 越出工作区 / 空文件 一律跳过，仅上传工作区内合法文件', async () => {
    const h = makeHarness({
      artifacts: [
        'D:\\repo\\方案.md', // 合法
        'rel\\相对.md', // 非绝对路径
        'D:\\repo\\病毒.exe', // 非法扩展名
        'D:\\outside\\越区.md', // 越出工作区
        'D:\\repo\\空文件.md', // 空文件
      ],
      fileSizes: { 'D:\\repo\\空文件.md': 0 },
    })
    const report = await h.finalizer.runWriteBack('500@WN_HIS')
    expect(report.status).toBe('ok')
    expect(h.log.upload.map(u => u.path)).toEqual(['D:\\repo\\方案.md'])
    const skippedAttachments = report.items.filter(
      (i: WriteBackItemResult) => i.kind === 'attachment' && i.status === 'skipped',
    )
    expect(skippedAttachments.length).toBe(4)
  })
})

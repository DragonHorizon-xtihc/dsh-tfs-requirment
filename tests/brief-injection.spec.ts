import { describe, expect, it } from 'vitest'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { Board } from '../src/core/board/board.js'
import { BoardService } from '../src/host/board-service.js'
import { createHostApi } from '../src/host/api.js'
import type { DispatchRequest } from '../src/orchestration/dispatch.js'
import { emptyBrief, setDigest, upsertConclusion } from '../src/shared/brief.js'
import type { Requirement } from '../src/tfs/types.js'
import { createMemFs } from './helpers/memfs.js'

/**
 * 共享简报注入（spec 010 AC3.2 / AC5.2）。
 *
 * 核心断言：**一旦需求级简报有摘要，派发 prompt 就不再包含需求提示词全文**。
 * 这条如果退化，"共享简报"只是把同一段正文换个标题又贴了一遍，省 token 是假的。
 */

const KEY = '1997179@WN_HIS'
const TASK = `${KEY}#analyze`

const REQ_PROMPT = '需求提示词全文：必须改造体检报告汇总模块，禁止改动公共库，注意向后兼容……'

function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
    .map(b => b.text)
    .join('\n')
}

function harness(withBrief: boolean): {
  api: ReturnType<typeof createHostApi>
  svc: BoardService
  captured: () => DispatchRequest | undefined
} {
  const svc = new BoardService({
    baseDir: '/mem/board',
    fs: createMemFs(),
    board: new Board(),
    adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as never,
    roles: { list: () => [], getByName: () => undefined } as never,
    defaultLabel: 'dsh',
  })
  const req: Requirement = {
    workItemId: 1997179,
    collection: 'WN_HIS',
    project: 'P',
    title: '汇总改造',
    state: '已建议',
    assignedTo: '',
    priority: '',
    iteration: '',
    tags: [],
    createdAt: '2026-09-29T00:00:00.000Z',
    updatedAt: '2026-09-29T00:00:00.000Z',
    revision: 1,
    description: '需求正文',
    prompt: REQ_PROMPT,
  }
  svc.board.claimRequirement(req)
  svc.board.addTask({
    taskId: TASK,
    requirementId: KEY,
    idempotencyKey: 'k',
    title: '分析',
    description: 'd',
    roleAgent: '架构师',
    frozenConfig: { mcp: ['tfs-mcp'], skills: ['peis'], model: '' },
  })

  if (withBrief) {
    let brief = emptyBrief(KEY, '汇总改造', {
      workspace: 'D:\\repo',
      tools: { mcp: ['tfs-mcp'], skills: ['peis'] },
    })
    brief = setDigest(brief, '需求摘要：改造 A、B、C 三个子流程，不改公共库。')
    brief = upsertConclusion(brief, { taskId: `${KEY}#plan`, title: '拆解', summary: '已定方案：先改 A' })
    svc.board.setOrchestration(KEY, { mode: 'continuable', brief })
  }

  const role = {
    id: 'r1',
    name: '架构师',
    provider: 'spawn',
    permission: 'read-only' as const,
  }
  let last: DispatchRequest | undefined
  const api = createHostApi({
    roles: { list: () => [role], getByName: () => role, save: () => {}, delete: () => {} } as never,
    adapter: { listRequirements: async () => ({ ok: false, items: [], reason: 'stub' }) } as never,
    dispatcher: {
      dispatch: async (r: DispatchRequest) => {
        last = r
        return { taskId: r.taskId, requirementId: r.requirementId, runId: 'run-1', provider: r.role.provider }
      },
      // 派发成功但仍在跑：run 句柄存在、结果未定。本用例只断言下发的 prompt，
      // 不关心收口，所以永不 resolve。返回 undefined 会被宿主判为「拿不到句柄 → 假执行」。
      getRun: () => ({ id: 'run-1', result: new Promise(() => {}) }) as never,
    } as never,
    board: svc,
    getParent: () => ({ session: { id: 'parent-1' } }) as unknown as Agent,
    models: [],
    mcpServers: [],
    skills: [],
    tagSuggestions: [],
    collection: 'WN_HIS',
  })
  return { api, svc, captured: () => last }
}

const draft = {
  roleName: '架构师',
  prompt: '任务级：开始分析',
  frozenConfig: { mcp: ['tfs-mcp'], skills: ['peis'], model: '' },
  permission: 'read-only' as const,
  }

describe('无简报（旧看板）⇒ 行为与 010 之前逐字一致', () => {
  it('仍下发【需求提示词】全文', async () => {
    const { api, captured } = harness(false)
    const r = await api.dispatch({ draft: draft as never, targetWorkItem: KEY, collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    const prompt = textOf(captured()!.prompt)
    expect(prompt).toContain('【需求提示词】')
    expect(prompt).toContain(REQ_PROMPT)
    expect(prompt).not.toContain('【共享简报')
  })
})

describe('有简报（AC3.2）⇒ 只发摘要 + 结论 + 已绑定工具', () => {
  it('prompt 不含需求提示词全文，但含摘要、前序结论与 MCP 清单', async () => {
    const { api, captured } = harness(true)
    const r = await api.dispatch({ draft: draft as never, targetWorkItem: KEY, collection: 'WN_HIS', taskId: TASK })
    expect(r.ok).toBe(true)
    const prompt = textOf(captured()!.prompt)

    expect(prompt).toContain('【共享简报')
    expect(prompt).toContain('需求摘要：改造 A、B、C 三个子流程，不改公共库。')
    expect(prompt).toContain('拆解：已定方案：先改 A')
    expect(prompt).toContain('已启用 MCP：tfs-mcp')
    expect(prompt).toContain('已启用技能：peis')
    expect(prompt).toContain('优先使用')

    // 关键：需求提示词全文**不再出现**；执行纪律段仍在。
    expect(prompt).not.toContain(REQ_PROMPT)
    expect(prompt).not.toContain('【需求提示词】')
    expect(prompt).toContain('【执行纪律')
    // 工作目录硬约束仍在（简报段不替代它）。
    expect(prompt).toContain('【工作目录')
  })

  it('任务级正文仍照发（简报不吞任务增量）', async () => {
    const { api, captured } = harness(true)
    await api.dispatch({ draft: draft as never, targetWorkItem: KEY, collection: 'WN_HIS', taskId: TASK })
    expect(textOf(captured()!.prompt)).toContain('任务级：开始分析')
  })
})

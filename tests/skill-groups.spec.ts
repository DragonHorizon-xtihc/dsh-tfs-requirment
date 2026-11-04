/**
 * 技能/MCP 分组专项（2026-11-03 用户诉求）。
 *
 * 覆盖两层：
 *   1. `SkillGroupStore`（skill-groups.json，memfs）：保存/同名覆盖/重名拒绝/删除/损坏降级；
 *   2. `createHostApi` 的分组方法与 `getPanelData().skillGroups` 透出（未接线=能力降级）。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { SkillGroupStore } from '../src/host/skill-group-store.js'
import { createHostApi } from '../src/host/api.js'
import { BoardService } from '../src/host/board-service.js'
import { Board } from '../src/core/board/board.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'
import { makeFakeRest } from './helpers/fake-rest.js'
import type { SkillMcpGroup } from '../src/shared/contracts.js'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { RequirementDispatcher } from '../src/orchestration/dispatch.js'

function group(partial: Partial<SkillMcpGroup> = {}): SkillMcpGroup {
  return {
    id: 'sg-1',
    name: '前端基础包',
    description: '',
    skills: ['s1', 's2'],
    mcp: ['mcp-a'],
    createdAt: '',
    updatedAt: '',
    ...partial,
  }
}

describe('SkillGroupStore', () => {
  let fs: MemFs
  let store: SkillGroupStore

  beforeEach(() => {
    fs = createMemFs()
    store = new SkillGroupStore({ baseDir: '/mem/data', fs })
  })

  it('保存后可列出（skills/mcp 去重、name 去空白）', () => {
    store.save(group({ skills: ['s1', 's1', 's2'], name: ' 前端基础包 ' }))
    const all = store.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.name).toBe('前端基础包')
    expect(all[0]!.skills).toEqual(['s1', 's2'])
    expect(all[0]!.createdAt).toBeTruthy()
    expect(all[0]!.updatedAt).toBeTruthy()
  })

  it('同 id 再保存 = 覆盖（不产生第二条，updatedAt 前移）', () => {
    store.save(group())
    const first = store.list()[0]!
    store.save(group({ skills: ['s3'], name: '前端基础包' }))
    const all = store.list()
    expect(all).toHaveLength(1)
    expect(all[0]!.skills).toEqual(['s3'])
    expect(all[0]!.createdAt).toBe(first.createdAt)
  })

  it('不同 id 同名保存被拒（展示名必须唯一）', () => {
    store.save(group())
    expect(() => store.save(group({ id: 'sg-2', name: '前端基础包' }))).toThrow(/同名/)
  })

  it('分组名必填', () => {
    expect(() => store.save(group({ name: '   ' }))).toThrow(/必填/)
  })

  it('删除：存在返回 true 且列表收缩；不存在返回 false', () => {
    store.save(group())
    expect(store.delete('sg-1')).toBe(true)
    expect(store.list()).toHaveLength(0)
    expect(store.delete('sg-1')).toBe(false)
  })

  it('skill-groups.json 损坏时读=空清单+降级原因，保存/删除被拒（不覆盖原文件）', () => {
    fs.writeFileSync('/mem/data/skill-groups.json', '{ 不是合法 JSON', 'utf8')
    expect(store.list()).toEqual([])
    expect(store.degradedReason).not.toBe('')
    expect(() => store.save(group())).toThrow(/读不到/)
    expect(() => store.delete('sg-1')).toThrow(/读不到/)
    // 原文件保留（未被覆盖成空清单）。
    expect(fs.readFileSync('/mem/data/skill-groups.json', 'utf8')).toContain('不是合法 JSON')
  })
})

describe('createHostApi 技能分组面', () => {
  function makeApi(opts: { skillGroups?: SkillGroupStore; fs?: MemFs } = {}) {
    const fs = opts.fs ?? createMemFs()
    const audit = new AuditLog('/mem/audit', fs)
    const guard = new WriteGuard(audit)
    const rest = makeFakeRest({ '_apis/projects': { value: [] } })
    const adapter = new TfsAdapter({
      rest: rest.config,
      writeGuard: guard,
      collection: 'WN_HIS',
      profileLabel: 'tfs-mcp',
    })
    const board = new BoardService({
      baseDir: '/mem/board',
      fs,
      board: new Board(),
      adapter,
      roles: { list: () => [], getByName: () => undefined },
      defaultLabel: 'dsh',
    })
    const dispatcher: Pick<RequirementDispatcher, 'dispatch'> = {
      dispatch: async req => ({ taskId: req.taskId, requirementId: req.requirementId, runId: 'run-x', provider: req.role.provider }),
    }
    const api = createHostApi({
      roles: { list: () => [], getByName: () => undefined, save: () => {}, delete: () => true },
      adapter,
      dispatcher,
      board,
      getParent: () => ({}) as Agent,
      models: [],
      mcpServers: ['mcp-a'],
      skills: [],
      tagSuggestions: [],
      collection: 'WN_HIS',
      ...(opts.skillGroups ? { skillGroups: opts.skillGroups } : {}),
    })
    return api
  }

  it('未接线 SkillGroupStore：面板不下发 skillGroups，保存/删除返回能力降级', () => {
    const api = makeApi()
    expect(api.getPanelData().skillGroups).toBeUndefined()
    expect(api.listSkillGroups()).toEqual([])
    expect(api.saveSkillGroup(group())).toEqual({ ok: false, reason: expect.stringContaining('不可用') })
    expect(api.deleteSkillGroup('sg-1')).toEqual({ ok: false, reason: expect.stringContaining('不可用') })
  })

  it('已接线：save → 面板 skillGroups 透出 → delete 后消失', () => {
    const fs = createMemFs()
    const store = new SkillGroupStore({ baseDir: '/mem/data', fs })
    const api = makeApi({ skillGroups: store, fs })
    expect(api.saveSkillGroup(group())).toEqual({ ok: true })
    const data = api.getPanelData()
    expect(data.skillGroups).toHaveLength(1)
    expect(data.skillGroups![0]!.name).toBe('前端基础包')
    expect(api.deleteSkillGroup('sg-1')).toEqual({ ok: true })
    expect(api.getPanelData().skillGroups).toHaveLength(0)
    expect(api.deleteSkillGroup('sg-1')).toEqual({ ok: false, reason: expect.stringContaining('不存在') })
  })

  it('store 抛错（重名/损坏）时 api 捕获为 ok:false + reason', () => {
    const fs = createMemFs()
    const store = new SkillGroupStore({ baseDir: '/mem/data', fs })
    const api = makeApi({ skillGroups: store, fs })
    api.saveSkillGroup(group())
    const r = api.saveSkillGroup(group({ id: 'sg-2' }))
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('同名')
  })
})

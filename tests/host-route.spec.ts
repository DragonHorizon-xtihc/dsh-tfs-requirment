import { describe, expect, it } from 'vitest'
import {
  createCatalogRefreshHandler,
  createPanelDataHandler,
  createConfirmWriteHandler,
  createDispatchHandler,
  createRequirementsHandler,
  createQueryOptionsHandler,
  createQueryOptionsRefreshHandler,
  createRolesListHandler,
  createRoleSaveHandler,
  createRoleDeleteHandler,
  createBoardHandler,
  createHealthHandler,
  createClaimHandler,
  createDecomposeHandler,
  createTaskAssignHandler,
  createTaskStateHandler,
  createTaskTraceHandler,
  createTaskFollowUpHandler,
  createAuditHandler,
  createAuditArchiveHandler,
  createCollectionHandler,
  createProfilesHandler,
  createProfileSaveHandler,
  createProfileDeleteHandler,
  createProfileActivateHandler,
  createMcpInstanceHandler,
  createMcpEnvFileHandler,
  createTfsToolsHandler,
  createQueryOptionsLoadHandler,
  createQueryOptionsCollectHandler,
  createUiStateHandler,
  createRequirementRestoreHandler,
  createRequirementEnrichHandler,
  createTaskDeleteHandler,
  createRequirementUpdateHandler,
  createRequirementExecStateHandler,
  createTaskUpdateHandler,
  createRequirementWriteBackHandler,
} from '../src/host/route.js'
import type { HostApi } from '../src/host/api.js'

/**
 * 宿主半 HTTP 路由处理器单测（Phase 3）。
 *
 * 用假 IncomingMessage/ServerResponse 驱动三个 handler，断言：
 *  - 方法校验（非 POST → 405）；
 *  - body 解析与字段校验（非法 → 400）；
 *  - 正确解析后转发到 api 对应方法并返回 JSON。
 */

function makeReq(method: string, body?: unknown): { req: Record<string, unknown>; emit: () => void } {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))]
  const listeners: Record<string, Array<(...a: unknown[]) => void>> = {}
  const req: Record<string, unknown> = {
    method,
    on(ev: string, cb: (...a: unknown[]) => void) {
      ;(listeners[ev] ??= []).push(cb)
      return req
    },
    destroy() {},
    emit() {
      for (const cb of listeners['data'] ?? []) cb(Buffer.concat(chunks))
      for (const cb of listeners['end'] ?? []) cb()
    },
  }
  return { req, emit: () => (req.emit as () => void)() }
}

function makeRes(): { statusCode: number; ended: string | null; writableEnded: boolean } & Record<string, unknown> {
  const res: Record<string, unknown> = {
    statusCode: 0,
    ended: null,
    writableEnded: false,
    headers: {} as Record<string, unknown>,
    setHeader(name: string, value: unknown) {
      ;(res.headers as Record<string, unknown>)[name] = value
      return res
    },
    writeHead(s: number) {
      res.statusCode = s
    },
    end(b: string) {
      res.ended = b
      res.writableEnded = true
    },
  }
  return res as never
}

function fakeApi(calls: string[], captured: Record<string, unknown> = {}): HostApi {
  return {
    getPanelData: () => {
      calls.push('panel')
      return {
        targetWorkItem: '—',
        collection: 'WN_HIS',
        roles: [],
        models: [],
        mcpServers: [],
        skills: [],
        modelOptions: [],
        workspaces: [],
        presets: [],
        providers: [],
        skillOptions: [],
        tagSuggestions: [],
        collections: ['WN_HIS'],
        pollIntervalMinutes: 5,
      }
    },
    // 能力目录强制重采（问题 4/5/6/7/9/11「事后配置」场景）：与 panel 同形，但走独立路由。
    refreshPanelData: async () => {
      calls.push('catalogRefresh')
      return {
        targetWorkItem: '—',
        collection: 'WN_HIS',
        roles: [],
        models: [],
        mcpServers: [],
        skills: [],
        modelOptions: [],
        workspaces: [],
        presets: [],
        providers: [],
        skillOptions: [],
        tagSuggestions: [],
        collections: ['WN_HIS'],
        pollIntervalMinutes: 5,
      }
    },
    confirmWrite: async () => {
      calls.push('confirm')
      return { ok: true, results: [] }
    },
    dispatch: async () => {
      calls.push('dispatch')
      return { ok: true }
    },
    listRequirements: async () => {
      calls.push('requirements')
      return { ok: true, items: [] }
    },
    // 问题 3：需求筛选可选项（项目/类型/状态/指派人）。
    getQueryOptions: async () => {
      calls.push('queryOptions')
      return { projects: [], types: [], states: [], assignees: [] }
    },
    // US1：手动「重新采集」通道（绕过进程内缓存）。
    refreshQueryOptions: async () => {
      calls.push('queryOptionsRefresh')
      return { projects: [], types: [], states: [], assignees: [] }
    },
    listRoles: () => {
      calls.push('roles')
      return []
    },
    saveRole: () => {
      calls.push('roleSave')
      return { ok: true }
    },
    deleteRole: () => {
      calls.push('roleDelete')
      return { ok: true }
    },
    listSkillGroups: () => {
      calls.push('skillGroups')
      return []
    },
    saveSkillGroup: () => {
      calls.push('skillGroupSave')
      return { ok: true }
    },
    deleteSkillGroup: () => {
      calls.push('skillGroupDelete')
      return { ok: true }
    },
    getBoard: () => {
      calls.push('board')
      return {
        ok: true,
        version: 0,
        updatedAt: '',
        requirements: [],
        tasks: [],
        counts: { pending: 0, inProgress: 0, completed: 0, running: 0, queued: 0 },
      }
    },
    claimRequirement: async input => {
      calls.push('claim')
      captured['claim'] = input
      return { ok: true, added: true }
    },
    decomposeRequirement: async () => {
      calls.push('decompose')
      return { ok: true, taskIds: [], created: 0, skipped: 0 }
    },
    // 2026-11-03 问题 4/5：开始编排 + 调度清单/取消。
    orchestrationStart: async input => {
      calls.push('orchestrationStart')
      captured['orchestrationStart'] = input
      return { ok: true }
    },
    listSchedules: () => {
      calls.push('listSchedules')
      return []
    },
    cancelSchedule: id => {
      calls.push('cancelSchedule')
      captured['cancelScheduleId'] = id
      return false
    },
    updateSchedule: (id, dueAt) => {
      calls.push('updateSchedule')
      captured['updateSchedule'] = { id, dueAt }
      return { ok: true, scheduledAt: dueAt }
    },
    // 问题 7/8/11 + 问题 1/2/4/6 的新 HostApi 面。
    restoreRequirement: async key => {
      calls.push('requirementRestore')
      captured['restoreKey'] = key
      return { ok: true, removedTasks: [] }
    },
    enrichRequirement: async key => {
      calls.push('requirementEnrich')
      captured['enrichKey'] = key
      return { ok: false, reason: 'fake 无需求' }
    },
    deleteTasks: async taskIds => {
      calls.push('taskDelete')
      captured['taskIds'] = taskIds
      return { ok: true, deleted: taskIds, count: taskIds.length }
    },
    // 问题 3/4：需求本地字段编辑 / 任务字段编辑。
    updateRequirement: async input => {
      calls.push('requirementUpdate')
      captured['requirementUpdate'] = input
      return { ok: true }
    },
    // 问题 5：需求级执行状态（确认完成 / 取消完成）。
    setRequirementExecState: async input => {
      calls.push('requirementExecState')
      captured['requirementExecState'] = input
      return { ok: true }
    },
    updateTask: async input => {
      calls.push('taskUpdate')
      captured['taskUpdate'] = input
      return { ok: true }
    },
    loadQueryOptions: async () => {
      calls.push('queryOptionsLoad')
      return { ok: true, data: null }
    },
    collectQueryOptions: async () => {
      calls.push('queryOptionsCollect')
      return { ok: true, data: { projects: [], types: [], states: [], assignees: [] } }
    },
    loadUiState: async () => {
      calls.push('uiStateLoad')
      return {}
    },
    saveUiState: async patch => {
      calls.push('uiStateSave')
      captured['uiStatePatch'] = patch
      return { ok: true }
    },
    assignTask: () => {
      calls.push('taskAssign')
      return { ok: true }
    },
    setTaskState: () => {
      calls.push('taskState')
      return { ok: true }
    },
    getTaskTrace: async (taskId: string, attempt?: number) => {
      calls.push('taskTrace')
      captured['taskTrace'] = { taskId, attempt }
      return { ok: true, taskId, attempt: attempt ?? 0, available: false, entries: [] }
    },
    followUpTask: async input => {
      calls.push('taskFollowUp')
      captured['taskFollowUp'] = input
      return { ok: true, runId: 'run-x', attempt: 1 }
    },
    healthCheck: async () => {
      calls.push('health')
      return { ok: true }
    },
    getAudit: () => {
      calls.push('audit')
      return { ok: true, total: 0, expired: 0, retentionDays: 90, archiveFiles: [] }
    },
    archiveAudit: () => {
      calls.push('auditArchive')
      return { ok: true, archived: 3, archivePath: '/data/audit-archive-20260917.jsonl' }
    },
    setCollection: (collection: string) => {
      calls.push(`collection:${collection}`)
      return { ok: true, collection }
    },
    listProfiles: () => {
      calls.push('profiles')
      return { ok: true, profiles: [], activeId: undefined }
    },
    saveProfile: () => {
      calls.push('profileSave')
      return { ok: true }
    },
    deleteProfile: () => {
      calls.push('profileDelete')
      return { ok: true }
    },
    activateProfile: () => {
      calls.push('profileActivate')
      return { ok: true }
    },
    getMcpEnvTemplate: () => {
      calls.push('mcpTemplate')
      return {
        ok: true,
        serverName: 'tfs-mcp',
        serverNameValid: true,
        envFilePath: '/data/tfs-mcp.env',
        posixLines: [],
        powershellLines: [],
        note: '',
      }
    },
    writeMcpEnvFile: () => {
      calls.push('mcpEnvFile')
      return { ok: true, path: '/data/tfs-mcp.env', bytes: 10, hardened: true }
    },
    getMcpInstance: () => {
      calls.push('mcpInstance')
      return {
        serverName: 'tfs-mcp',
        serverNameValid: true,
        toolPrefix: 'mcp__tfs-mcp__',
        runtimeAddSupported: false,
        runtimeAddReason: 'test',
        serverNameConstraint: '^[A-Za-z0-9_-]{1,32}$',
        duplicateRisk: 'test',
        credentialPath: 'test',
      }
    },
    // 问题 8 / 12：封装工具目录。
    getTfsToolCatalog: () => {
      calls.push('tfsTools')
      return {
        ok: true,
        rawCount: 2,
        wrappedCount: 2,
        missingCount: 47,
        tools: [
          { raw: 'tfs_whoami', plugin: 'tfs_req_whoami', title: '当前身份', category: 'collection', categoryLabel: '集合与身份', access: 'read', description: 'x' },
          { raw: 'tfs_create_workitem', plugin: 'tfs_req_create_workitem', title: '新建工作项', category: 'work-item', categoryLabel: '工作项', access: 'write', description: 'y' },
        ],
      }
    },
    // 问题 4：需求完成后 TFS 自动回写（评审/自测字段、结论评论、产物附件、关联任务置已解决）。
    writeBackRequirement: async input => {
      calls.push('requirementWriteBack')
      captured['requirementWriteBack'] = input
      return { ok: true, requirementKey: input.requirementKey, report: { status: 'ok', at: '2026-09-22T00:00:00.000Z', items: [] } }
    },
    // spec 010：确保需求有编排主 agent 会话（幂等）。
    orchestratorEnsure: async input => {
      calls.push('orchestratorEnsure')
      captured['orchestratorEnsure'] = input
      return { ok: true, orchestration: { mode: 'continuable', orchestratorSessionId: 'child-1', parentSessionId: 'parent-1' } }
    },
  }
}

describe('createPanelDataHandler', () => {
  it('GET 返回 200 + 面板数据', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('GET')
    const res = makeRes()
    const p = createPanelDataHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('panel')
    expect(JSON.parse(res.ended as string).collection).toBe('WN_HIS')
  })
})

/**
 * 能力目录强制重采（问题 4/5/6/7/9/11「事后配置」场景）。
 *
 * 这条路由的核心价值是**走到 refreshPanelData 而不是 getPanelData**：若实现里误接成
 * `getPanelData`，用户补配模型后刷新仍然拿旧快照 —— 断言 `catalogRefresh` 入 calls 即可锁死该行为。
 */
describe('createCatalogRefreshHandler', () => {
  it('POST → 200 且转发 refreshPanelData（而非只读快照的 getPanelData）', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', {})
    const res = makeRes()
    const p = createCatalogRefreshHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('catalogRefresh')
    expect(calls).not.toContain('panel')
    expect(JSON.parse(res.ended as string).collection).toBe('WN_HIS')
  })
})

describe('createConfirmWriteHandler', () => {
  it('POST 合法 body → 200 并转发 confirmWrite', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { ops: [{ opType: 'tag', before: [], after: ['dsh'] }], targetWorkItem: '9@WN_HIS', collection: 'WN_HIS' })
    const res = makeRes()
    const p = createConfirmWriteHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('confirm')
  })

  it('非 POST → 405', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('GET')
    const res = makeRes()
    const p = createConfirmWriteHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(405)
    expect(calls).not.toContain('confirm')
  })

  it('缺少 ops → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { targetWorkItem: '9@WN_HIS' })
    const res = makeRes()
    const p = createConfirmWriteHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
  })
})

describe('createDispatchHandler', () => {
  it('POST 合法 body → 200 并转发 dispatch', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { draft: { roleName: '架构师', prompt: 'x', frozenConfig: { mcp: [], skills: [], model: '' }, permission: 'read-only' }, targetWorkItem: '9@WN_HIS', collection: 'WN_HIS' })
    const res = makeRes()
    const p = createDispatchHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('dispatch')
  })

  it('缺少 targetWorkItem → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { draft: { roleName: '架构师', prompt: 'x', frozenConfig: { mcp: [], skills: [], model: '' }, permission: 'read-only' } })
    const res = makeRes()
    const p = createDispatchHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
  })

  it('缺少 draft → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { targetWorkItem: '9@WN_HIS' })
    const res = makeRes()
    const p = createDispatchHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
  })
})

describe('createRequirementsHandler', () => {
  it('POST 合法 body → 200 并转发 listRequirements', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { keyword: '登录', top: 10 })
    const res = makeRes()
    const p = createRequirementsHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('requirements')
  })

  it('非 POST → 405', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('GET')
    const res = makeRes()
    const p = createRequirementsHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(405)
  })
})

/**
 * 需求筛选可选项的两条路由（US1 / T011）。
 *
 * 关键差别只有一个：`GET query-options` 允许命中进程内缓存，`POST query-options-refresh`
 * 必须走强制重采。若实现里把 refresh 误接成 `getQueryOptions`，用户点「重新采集」会拿到
 * 同一份缓存快照、下拉永远不更新——断言 `queryOptionsRefresh` 入 calls 即可锁死该行为。
 */
describe('createQueryOptionsHandler（GET，可命中缓存）', () => {
  it('GET → 200 且转发 getQueryOptions', async () => {
    const calls: string[] = []
    const res = makeRes()
    createQueryOptionsHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    // GET 处理器不返回 promise（同步发起异步采集），等一拍让 then 落地。
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(calls).toEqual(['queryOptions'])
  })
})

describe('createQueryOptionsRefreshHandler（POST，强制重采）', () => {
  it('POST → 200 且转发 refreshQueryOptions（而非可能命中缓存的 getQueryOptions）', async () => {
    const calls: string[] = []
    const res = makeRes()
    createQueryOptionsRefreshHandler(fakeApi(calls))(makeReq('POST', {}).req as never, res as never)
    await Promise.resolve()
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('queryOptionsRefresh')
    expect(calls).not.toContain('queryOptions')
  })

  it('回包体是可选项四项结构', async () => {
    const calls: string[] = []
    const res = makeRes()
    createQueryOptionsRefreshHandler(fakeApi(calls))(makeReq('POST', {}).req as never, res as never)
    await Promise.resolve()
    const body = JSON.parse(res.ended as string)
    expect(Object.keys(body)).toEqual(expect.arrayContaining(['projects', 'types', 'states', 'assignees']))
  })
})

describe('角色路由', () => {
  it('GET 角色清单 → 200 + roles', async () => {
    const calls: string[] = []
    const res = makeRes()
    createRolesListHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('roles')
  })

  it('保存角色缺 id/name → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { provider: 'spawn' })
    const res = makeRes()
    const p = createRoleSaveHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
  })

  it('保存合法角色 → 200 并转发 saveRole', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { id: 'r9', name: '新角色' })
    const res = makeRes()
    const p = createRoleSaveHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('roleSave')
  })

  it('删除角色缺 id → 400；合法 → 200 并转发 deleteRole', async () => {
    const calls: string[] = []
    const bad = makeReq('POST', {})
    const res1 = makeRes()
    const p1 = createRoleDeleteHandler(fakeApi(calls))(bad.req as never, res1 as never)
    bad.emit()
    await p1
    expect(res1.statusCode).toBe(400)

    const good = makeReq('POST', { id: 'r9', force: true })
    const res2 = makeRes()
    const p2 = createRoleDeleteHandler(fakeApi(calls))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(calls).toContain('roleDelete')
  })
})

describe('看板 / 自检路由（US3 / US6 / T029）', () => {
  it('GET 看板 → 200 并转发 getBoard', () => {
    const calls: string[] = []
    const res = makeRes()
    createBoardHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('board')
  })

  it('GET 自检 → 200 并转发 healthCheck', async () => {
    const calls: string[] = []
    const res = makeRes()
    const p = createHealthHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('health')
  })

  it('领取：缺 requirement 且缺 id → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { tag: false })
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
    expect(calls).not.toContain('claim')
  })

  it('领取：id 非正整数 → 400（防 id:NaN 发到 TFS）', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { id: '123' })
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
  })

  it('领取：合法 id → 200 并转发 claimRequirement', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { id: 123, collection: 'WN_HIS' })
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('claim')
  })

  it('领取：非 POST → 405', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('GET')
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(405)
  })

  it('领取：workspace 字符串透传给 claimRequirement（本地代码库路径）', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { id: 1997179, collection: 'WN_HIS', workspace: 'D:\\体检管理\\repo' })
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect((captured['claim'] as { workspace?: string }).workspace).toBe('D:\\体检管理\\repo')
  })

  it('领取：workspace 非字符串 → 不下传该字段（不污染 input）', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { id: 1, workspace: null })
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect('workspace' in (captured['claim'] as object)).toBe(false)
  })

  it('领取：prompt 字符串透传给 claimRequirement（2026-11-03 问题 1 回归：路由曾丢弃提示词）', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', {
      id: 1997179,
      collection: 'WN_HIS',
      workspace: 'D:\\体检管理\\repo',
      prompt: '按院感规范改造分诊流程',
    })
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    const input = captured['claim'] as { workspace?: string; prompt?: string }
    expect(input.workspace).toBe('D:\\体检管理\\repo')
    expect(input.prompt).toBe('按院感规范改造分诊流程')
  })

  it('领取：prompt 非字符串 → 不下传该字段', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { id: 1, prompt: 42 })
    const res = makeRes()
    const p = createClaimHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect('prompt' in (captured['claim'] as object)).toBe(false)
  })

  it('拆解：缺 requirementId → 400；合法 → 200', async () => {
    const calls: string[] = []
    const bad = makeReq('POST', {})
    const res1 = makeRes()
    const p1 = createDecomposeHandler(fakeApi(calls))(bad.req as never, res1 as never)
    bad.emit()
    await p1
    expect(res1.statusCode).toBe(400)

    const good = makeReq('POST', { requirementId: '123@WN_HIS' })
    const res2 = makeRes()
    const p2 = createDecomposeHandler(fakeApi(calls))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(calls).toContain('decompose')
  })

  it('指派：缺 roleName → 400；合法 → 200', async () => {
    const calls: string[] = []
    const bad = makeReq('POST', { taskId: 't1' })
    const res1 = makeRes()
    const p1 = createTaskAssignHandler(fakeApi(calls))(bad.req as never, res1 as never)
    bad.emit()
    await p1
    expect(res1.statusCode).toBe(400)

    const good = makeReq('POST', { taskId: 't1', roleName: '架构师' })
    const res2 = makeRes()
    const p2 = createTaskAssignHandler(fakeApi(calls))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(calls).toContain('taskAssign')
  })

  it('状态操作：非法 action → 400；合法 action → 200', async () => {
    const calls: string[] = []
    const bad = makeReq('POST', { taskId: 't1', action: 'explode' })
    const res1 = makeRes()
    const p1 = createTaskStateHandler(fakeApi(calls))(bad.req as never, res1 as never)
    bad.emit()
    await p1
    expect(res1.statusCode).toBe(400)
    expect(calls).not.toContain('taskState')

    for (const action of ['start', 'complete', 'fail', 'retry', 'cancel', 'confirm']) {
      const good = makeReq('POST', { taskId: 't1', action, expectedRevision: 2 })
      const res = makeRes()
      const p = createTaskStateHandler(fakeApi(calls))(good.req as never, res as never)
      good.emit()
      await p
      expect(res.statusCode).toBe(200)
    }
    expect(calls.filter(c => c === 'taskState')).toHaveLength(6)
  })

  it('状态操作：expectedRevision 为负 → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { taskId: 't1', action: 'start', expectedRevision: -1 })
    const res = makeRes()
    const p = createTaskStateHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
  })
})

describe('审计归档路由（T063）', () => {
  it('GET 审计状态 → 200 并转发 getAudit', () => {
    const calls: string[] = []
    const res = makeRes()
    createAuditHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('audit')
    expect(JSON.parse(res.ended as string).retentionDays).toBe(90)
  })

  it('POST 归档 → 200 并转发 archiveAudit；非 POST → 405', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', {})
    const res = makeRes()
    const p = createAuditArchiveHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('auditArchive')
    expect(JSON.parse(res.ended as string).archived).toBe(3)

    const calls2: string[] = []
    const get = makeReq('GET')
    const res2 = makeRes()
    const p2 = createAuditArchiveHandler(fakeApi(calls2))(get.req as never, res2 as never)
    get.emit()
    await p2
    expect(res2.statusCode).toBe(405)
    expect(calls2).not.toContain('auditArchive')
  })
})

describe('集合切换路由（T030）', () => {
  it('POST 合法 collection → 200 并转发 setCollection', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { collection: 'WN_TECH' })
    const res = makeRes()
    const p = createCollectionHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('collection:WN_TECH')
  })

  it('collection 缺失 / 非字符串 / 空串 → 400（防"切到空集合"）', async () => {
    for (const body of [{}, { collection: 123 }, { collection: '   ' }]) {
      const calls: string[] = []
      const { req, emit } = makeReq('POST', body)
      const res = makeRes()
      const p = createCollectionHandler(fakeApi(calls))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(400)
      expect(calls.some(c => c.startsWith('collection:'))).toBe(false)
    }
  })
})

describe('连接档案路由（T031）', () => {
  it('GET 档案清单 → 200 并转发 listProfiles', () => {
    const calls: string[] = []
    const res = makeRes()
    createProfilesHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('profiles')
    // 路由层不得输出任何 pat 字段（类型层已排除，这里做回归断言）。
    expect(res.ended).not.toContain('pat')
  })

  it('保存档案：缺 name/url/collection → 400', async () => {
    for (const body of [{ url: 'http://x', collection: 'WN_HIS' }, { name: 'a', collection: 'WN_HIS' }, { name: 'a', url: 'http://x' }]) {
      const calls: string[] = []
      const { req, emit } = makeReq('POST', body)
      const res = makeRes()
      const p = createProfileSaveHandler(fakeApi(calls))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(400)
      expect(calls).not.toContain('profileSave')
    }
  })

  it('保存档案：pat 非字符串 → 400；合法 → 200 并转发', async () => {
    const calls: string[] = []
    const bad = makeReq('POST', { name: 'a', url: 'http://x', collection: 'WN_HIS', pat: 42 })
    const res1 = makeRes()
    const p1 = createProfileSaveHandler(fakeApi(calls))(bad.req as never, res1 as never)
    bad.emit()
    await p1
    expect(res1.statusCode).toBe(400)

    const good = makeReq('POST', { name: 'a', url: 'http://x', collection: 'WN_HIS', pat: 'secret' })
    const res2 = makeRes()
    const p2 = createProfileSaveHandler(fakeApi(calls))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(calls).toContain('profileSave')
  })

  it('删除/设为当前：缺 id → 400；合法 → 200', async () => {
    for (const factory of [createProfileDeleteHandler, createProfileActivateHandler]) {
      const calls: string[] = []
      const bad = makeReq('POST', {})
      const res1 = makeRes()
      const p1 = factory(fakeApi(calls))(bad.req as never, res1 as never)
      bad.emit()
      await p1
      expect(res1.statusCode).toBe(400)

      const good = makeReq('POST', { id: 'p1' })
      const res2 = makeRes()
      const p2 = factory(fakeApi(calls))(good.req as never, res2 as never)
      good.emit()
      await p2
      expect(res2.statusCode).toBe(200)
    }
  })
})

describe('MCP 接入路由（T028b）', () => {
  it('GET 实例诊断 → 200，同时返回 instance 与 template', () => {
    const calls: string[] = []
    const res = makeRes()
    createMcpInstanceHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    expect(res.statusCode).toBe(200)
    const body = JSON.parse(res.ended as string) as { instance: { runtimeAddSupported: boolean } }
    expect(body.instance.runtimeAddSupported).toBe(false)
    expect(calls).toContain('mcpInstance')
    expect(calls).toContain('mcpTemplate')
  })

  it('POST 写环境文件：profileId 非字符串 → 400；缺省 → 200', async () => {
    const calls: string[] = []
    const bad = makeReq('POST', { profileId: 7 })
    const res1 = makeRes()
    const p1 = createMcpEnvFileHandler(fakeApi(calls))(bad.req as never, res1 as never)
    bad.emit()
    await p1
    expect(res1.statusCode).toBe(400)

    const good = makeReq('POST', {})
    const res2 = makeRes()
    const p2 = createMcpEnvFileHandler(fakeApi(calls))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(calls).toContain('mcpEnvFile')
  })
})

/**
 * 封装工具目录路由（问题 8 / 12）。
 *
 * 为什么单独测：连接与凭据页不再引导用户手工接 tfs-mcp，改为展示插件已封装的工具，
 * 这条链路的出口就是本路由。它 200 + 内容正确，页面上才不会退化成"0 个工具"。
 */
describe('createTfsToolsHandler', () => {
  it('GET 返回 200 + 封装目录（含 plugin/raw 对应与读写性质）', () => {
    const calls: string[] = []
    const res = makeRes()
    createTfsToolsHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('tfsTools')
    const body = JSON.parse(res.ended as string) as {
      wrappedCount: number
      tools: Array<{ raw: string; plugin: string; access: string }>
    }
    expect(body.wrappedCount).toBe(2)
    expect(body.tools.map(t => t.plugin)).toEqual(['tfs_req_whoami', 'tfs_req_create_workitem'])
    expect(body.tools.find(t => t.raw === 'tfs_create_workitem')?.access).toBe('write')
  })
})

// ───────── specs/003 新增六条路由（问题 1/2/4/6/7/8/11） ─────────

describe('可选项落盘路由（问题 1：GET 读盘 / POST 采集落盘）', () => {
  it('GET query-options-load → 200 且只走 loadQueryOptions（不触发采集）', async () => {
    const calls: string[] = []
    const res = makeRes()
    const p = createQueryOptionsLoadHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('queryOptionsLoad')
    expect(calls).not.toContain('queryOptions')
    expect(calls).not.toContain('queryOptionsCollect')
  })

  it('POST query-options-collect：body.collection 透传，走 collectQueryOptions', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { collection: 'WN_TJ' })
    const res = makeRes()
    const p = createQueryOptionsCollectHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('queryOptionsCollect')
  })

  it('非 POST → 405', async () => {
    const calls: string[] = []
    const res = makeRes()
    const p = createQueryOptionsCollectHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    await p
    expect(res.statusCode).toBe(405)
  })
})

describe('UI 状态路由（问题 2/4/6：筛选记忆与每页条数）', () => {
  it('GET → 200 且转发 loadUiState', async () => {
    const calls: string[] = []
    const res = makeRes()
    const p = createUiStateHandler(fakeApi(calls))(makeReq('GET').req as never, res as never)
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('uiStateLoad')
  })

  it('POST 白名单：只透传 poolFilters 与三个数字 pageSize，未知键丢弃', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const body = {
      poolFilters: { projects: ['EAHis'], evilNested: 1 },
      poolPageSize: 50,
      claimedPageSize: 10,
      taskPageSize: 20,
      injected: 'no',
    }
    const { req, emit } = makeReq('POST', body)
    const res = makeRes()
    const p = createUiStateHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    const patch = captured['uiStatePatch'] as Record<string, unknown>
    expect(patch.poolFilters).toEqual({ projects: ['EAHis'], evilNested: 1 })
    expect(patch.poolPageSize).toBe(50)
    expect(patch.claimedPageSize).toBe(10)
    expect(patch.taskPageSize).toBe(20)
    expect('injected' in patch).toBe(false)
  })

  it('POST 非数字 pageSize 被忽略；非法 JSON → 200 + ok:false（不 500）', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { poolPageSize: 'many' })
    const res = makeRes()
    const p = createUiStateHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect((captured['uiStatePatch'] as Record<string, unknown>).poolPageSize).toBeUndefined()

    // 非法 JSON 体 → 200 + ok:false（不 500）。
    const endListeners: Array<() => void> = []
    const dataListeners: Array<(c: Buffer) => void> = []
    const rawReq = {
      method: 'POST',
      on: (ev: string, cb: (c?: Buffer) => void) => {
        if (ev === 'end') endListeners.push(cb as () => void)
        if (ev === 'data') dataListeners.push(cb as (c: Buffer) => void)
        return rawReq
      },
    }
    const res2 = makeRes()
    const p2 = createUiStateHandler(fakeApi(calls))(rawReq as never, res2 as never)
    for (const cb of dataListeners) cb(Buffer.from('{不是合法json'))
    for (const cb of endListeners) cb()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(JSON.parse(res2.ended as string).ok).toBe(false)
  })
})

describe('还原需求 / 补全四段 / 删除任务路由（问题 7/8/11）', () => {
  it('requirement-restore：requirementKey 缺失/非字符串 → 400；合法 → 200 并转发', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    for (const bad of [{}, { requirementKey: 7 }]) {
      const { req, emit } = makeReq('POST', bad)
      const res = makeRes()
      const p = createRequirementRestoreHandler(fakeApi(calls))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(400)
    }
    const good = makeReq('POST', { requirementKey: '1997179@WN_HIS' })
    const res2 = makeRes()
    const p2 = createRequirementRestoreHandler(fakeApi(calls, captured))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(captured['restoreKey']).toBe('1997179@WN_HIS')
  })

  it('requirement-enrich：requirementKey 缺失 → 400；合法 → 200', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const bad = makeReq('POST', {})
    const res1 = makeRes()
    const p1 = createRequirementEnrichHandler(fakeApi(calls))(bad.req as never, res1 as never)
    bad.emit()
    await p1
    expect(res1.statusCode).toBe(400)

    const good = makeReq('POST', { requirementKey: '1997179@WN_HIS' })
    const res2 = makeRes()
    const p2 = createRequirementEnrichHandler(fakeApi(calls, captured))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(captured['enrichKey']).toBe('1997179@WN_HIS')
  })

  it('task-delete：taskIds 非字符串数组 → 400；合法 → 200 且原样转发（整批门禁在服务层）', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    for (const bad of [{}, { taskIds: 'x' }, { taskIds: [1, 2] }]) {
      const { req, emit } = makeReq('POST', bad)
      const res = makeRes()
      const p = createTaskDeleteHandler(fakeApi(calls))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(400)
    }
    const ids = ['1997179@WN_HIS#analyze', '1997179@WN_HIS#impl']
    const good = makeReq('POST', { taskIds: ids })
    const res2 = makeRes()
    const p2 = createTaskDeleteHandler(fakeApi(calls, captured))(good.req as never, res2 as never)
    good.emit()
    await p2
    expect(res2.statusCode).toBe(200)
    expect(captured['taskIds']).toEqual(ids)
  })
})

/**
 * 问题 3/4 的两条编辑路由。
 *
 * 关键契约（不是"能跑就行"）：
 *   - `null` 必须**原样保留**到 api 入参（`null` = 清空，与"不传 = 不动"是两种语义）；
 *     若实现里用 `typeof v === 'string'` 过滤，用户就永远删不掉已填的提示词；
 *   - 非法类型（数字、对象、非字符串数组）→ 400，且**不**触达 api（不做部分写入）；
 *   - 缺必填键 → 400；只有必填键没其他字段 → 400（防"空写"）。
 */
describe('POST /requirement-update · POST /task-update（问题 3/4）', () => {
  it('requirement-update：缺 requirementKey → 400 且不触达 api', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { prompt: 'x' })
    const res = makeRes()
    const p = createRequirementUpdateHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
    expect(calls).not.toContain('requirementUpdate')
  })

  it('requirement-update：只有 requirementKey（无任何可改字段）→ 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { requirementKey: '1@WN_HIS' })
    const res = makeRes()
    const p = createRequirementUpdateHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
    expect(calls).not.toContain('requirementUpdate')
  })

  it('requirement-update：prompt 传数字 → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { requirementKey: '1@WN_HIS', prompt: 5 })
    const res = makeRes()
    const p = createRequirementUpdateHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
    expect(calls).not.toContain('requirementUpdate')
  })

  it('requirement-update：null 原样透传（清空语义），非 null 字符串也透传', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { requirementKey: '1@WN_HIS', prompt: '背景', workspace: null })
    const res = makeRes()
    const p = createRequirementUpdateHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('requirementUpdate')
    expect(captured['requirementUpdate']).toEqual({ requirementKey: '1@WN_HIS', prompt: '背景', workspace: null })
  })

  it('task-update：缺 taskId → 400；skills 非字符串数组 → 400', async () => {
    const calls: string[] = []
    const bad1 = makeReq('POST', { prompt: 'x' })
    const res1 = makeRes()
    const p1 = createTaskUpdateHandler(fakeApi(calls))(bad1.req as never, res1 as never)
    bad1.emit()
    await p1
    expect(res1.statusCode).toBe(400)

    const bad2 = makeReq('POST', { taskId: 't', skills: 'not-array' })
    const res2 = makeRes()
    const p2 = createTaskUpdateHandler(fakeApi(calls))(bad2.req as never, res2 as never)
    bad2.emit()
    await p2
    expect(res2.statusCode).toBe(400)
    expect(calls).not.toContain('taskUpdate')
  })

  it('task-update：expectedRevision 非整数 → 400', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { taskId: 't', prompt: 'x', expectedRevision: 1.5 })
    const res = makeRes()
    const p = createTaskUpdateHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
    expect(calls).not.toContain('taskUpdate')
  })

  it('task-update：正常入参透传（含 expectedRevision 与三件套）', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', {
      taskId: '1@WN_HIS#impl',
      prompt: '按分析实现',
      workspace: 'D:\\repo',
      model: 'm1',
      skills: ['s1'],
      mcp: ['mcp-a'],
      expectedRevision: 3,
    })
    const res = makeRes()
    const p = createTaskUpdateHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(captured['taskUpdate']).toEqual({
      taskId: '1@WN_HIS#impl',
      prompt: '按分析实现',
      workspace: 'D:\\repo',
      model: 'm1',
      skills: ['s1'],
      mcp: ['mcp-a'],
      expectedRevision: 3,
    })
  })

  it('两条路由都只接受 POST（GET → 405）', async () => {
    const calls: string[] = []
    for (const make of [createRequirementUpdateHandler, createTaskUpdateHandler]) {
      const { req } = makeReq('GET')
      const res = makeRes()
      await make(fakeApi(calls))(req as never, res as never)
      expect(res.statusCode).toBe(405)
    }
  })
})

// ───────── specs/006 新增两条路由（任务执行轨迹 / 追问） ─────────

describe('createTaskTraceHandler（GET 任务执行过程）', () => {
  it('带 taskId → 200 并转发 getTaskTrace', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const req = { method: 'GET', url: '/tfs-requirment/task-trace?taskId=t1', on() {}, destroy() {} }
    const res = makeRes()
    await createTaskTraceHandler(fakeApi(calls, captured))(req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('taskTrace')
    expect((captured['taskTrace'] as { taskId: string }).taskId).toBe('t1')
    expect(JSON.parse(res.ended as string).available).toBe(false)
  })

  it('带 attempt 数字 → 透传；非法 attempt → 400', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const req = { method: 'GET', url: '/x?taskId=t1&attempt=2', on() {}, destroy() {} }
    const res = makeRes()
    await createTaskTraceHandler(fakeApi(calls, captured))(req as never, res as never)
    expect((captured['taskTrace'] as { attempt?: number }).attempt).toBe(2)

    const bad = { method: 'GET', url: '/x?taskId=t1&attempt=nope', on() {}, destroy() {} }
    const res2 = makeRes()
    await createTaskTraceHandler(fakeApi([]))(bad as never, res2 as never)
    expect(res2.statusCode).toBe(400)
  })

  it('缺 taskId → 400 且不触达 api', async () => {
    const calls: string[] = []
    const req = { method: 'GET', url: '/x', on() {}, destroy() {} }
    const res = makeRes()
    await createTaskTraceHandler(fakeApi(calls))(req as never, res as never)
    expect(res.statusCode).toBe(400)
    expect(calls).not.toContain('taskTrace')
  })

  it('非 GET → 405', async () => {
    const calls: string[] = []
    const req = { method: 'POST', url: '/x?taskId=t1', on() {}, destroy() {} }
    const res = makeRes()
    await createTaskTraceHandler(fakeApi(calls))(req as never, res as never)
    expect(res.statusCode).toBe(405)
  })
})

describe('createTaskFollowUpHandler（POST 任务追问）', () => {
  it('合法 body → 200 并转发 followUpTask', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { taskId: 't1', message: '再试一次' })
    const res = makeRes()
    const p = createTaskFollowUpHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('taskFollowUp')
    expect(captured['taskFollowUp']).toEqual({ taskId: 't1', message: '再试一次' })
  })

  it('缺 taskId / 空 message → 400 且不触达 api', async () => {
    for (const body of [{ message: 'x' }, { taskId: 't1' }, { taskId: 't1', message: '   ' }]) {
      const calls: string[] = []
      const { req, emit } = makeReq('POST', body)
      const res = makeRes()
      const p = createTaskFollowUpHandler(fakeApi(calls))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(400)
      expect(calls).not.toContain('taskFollowUp')
    }
  })

  it('非 POST → 405', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('GET')
    const res = makeRes()
    const p = createTaskFollowUpHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(405)
  })
})

// ───────── 问题 5：需求级执行状态（确认完成 / 取消完成） ─────────

describe('createRequirementExecStateHandler（需求级执行状态）', () => {
  it('state=active/completed → 200 并原样转发（取消完成 / 确认完成）', async () => {
    for (const state of ['active', 'completed'] as const) {
      const calls: string[] = []
      const captured: Record<string, unknown> = {}
      const { req, emit } = makeReq('POST', { requirementKey: '1997179@WN_HIS', state })
      const res = makeRes()
      const p = createRequirementExecStateHandler(fakeApi(calls, captured))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(200)
      expect(calls).toContain('requirementExecState')
      expect(captured['requirementExecState']).toEqual({ requirementKey: '1997179@WN_HIS', state })
    }
  })

  it('缺 requirementKey → 400 且不触达 api', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('POST', { state: 'active' })
    const res = makeRes()
    const p = createRequirementExecStateHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(400)
    expect(calls).not.toContain('requirementExecState')
  })

  it('state 非法（任意字符串）→ 400：状态是分页依据，不能放进"两页都不显示"的值', async () => {
    for (const state of [undefined, '', 'done', 1, null]) {
      const calls: string[] = []
      const { req, emit } = makeReq('POST', { requirementKey: '1@WN_HIS', state })
      const res = makeRes()
      const p = createRequirementExecStateHandler(fakeApi(calls))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(400)
      expect(calls).not.toContain('requirementExecState')
    }
  })

  it('非 POST → 405', async () => {
    const calls: string[] = []
    const { req } = makeReq('GET')
    const res = makeRes()
    await createRequirementExecStateHandler(fakeApi(calls))(req as never, res as never)
    expect(res.statusCode).toBe(405)
  })
})

// ───────── 问题 4：需求完成后 TFS 自动回写路由 ─────────

describe('createRequirementWriteBackHandler（GET 读报告 / POST 触发回写）', () => {
  it('POST 合法 requirementKey → 200 并转发 writeBackRequirement（force 透传）', async () => {
    const calls: string[] = []
    const captured: Record<string, unknown> = {}
    const { req, emit } = makeReq('POST', { requirementKey: '1997179@WN_HIS', force: true })
    const res = makeRes()
    const p = createRequirementWriteBackHandler(fakeApi(calls, captured))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('requirementWriteBack')
    expect(captured['requirementWriteBack']).toEqual({ requirementKey: '1997179@WN_HIS', force: true })
  })

  it('POST 缺 requirementKey / 非字符串 → 400 且不触达 api', async () => {
    for (const body of [{}, { requirementKey: 7 }]) {
      const calls: string[] = []
      const { req, emit } = makeReq('POST', body)
      const res = makeRes()
      const p = createRequirementWriteBackHandler(fakeApi(calls))(req as never, res as never)
      emit()
      await p
      expect(res.statusCode).toBe(400)
      expect(calls).not.toContain('requirementWriteBack')
    }
  })

  it('GET 带 requirementKey → 200，只读看板报告、不触发回写', async () => {
    const calls: string[] = []
    const req = { method: 'GET', url: '/x?requirementKey=1997179%40WN_HIS', on() {}, destroy() {} }
    const res = makeRes()
    await createRequirementWriteBackHandler(fakeApi(calls))(req as never, res as never)
    expect(res.statusCode).toBe(200)
    expect(calls).toContain('board')
    expect(calls).not.toContain('requirementWriteBack')
  })

  it('GET 缺 requirementKey → 400', async () => {
    const calls: string[] = []
    const req = { method: 'GET', url: '/x', on() {}, destroy() {} }
    const res = makeRes()
    await createRequirementWriteBackHandler(fakeApi(calls))(req as never, res as never)
    expect(res.statusCode).toBe(400)
  })

  it('PUT 等其他方法 → 405', async () => {
    const calls: string[] = []
    const { req, emit } = makeReq('PUT', { requirementKey: '1@WN_HIS' })
    const res = makeRes()
    const p = createRequirementWriteBackHandler(fakeApi(calls))(req as never, res as never)
    emit()
    await p
    expect(res.statusCode).toBe(405)
    expect(calls).not.toContain('requirementWriteBack')
  })
})

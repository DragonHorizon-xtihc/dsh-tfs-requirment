import { beforeEach, describe, expect, it } from 'vitest'
import { createHostApi } from '../src/host/api.js'
import { BoardService } from '../src/host/board-service.js'
import { Board } from '../src/core/board/board.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'
import { makeFakeRest, type FakeRest } from './helpers/fake-rest.js'
import { validateRole } from '../src/orchestration/roles.js'
import { buildExecBudgetSection } from '../src/shared/exec-protocol.js'
import type { RoleDefinition, WriteOpDraft } from '../src/shared/contracts.js'
import type { RequirementDispatcher } from '../src/orchestration/dispatch.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * 宿主半编排单测（Phase 3：真实 HostBridge 的宿主侧逻辑）—— **REST 版**。
 *
 * REST 化后写路径 = PATCH json-patch（原 mcp 工具调用），断言改为验证：
 *  - tag 草稿 → PATCH /fields/System.Tags（分号拼接）；
 *  - comment 草稿 → PATCH /fields/System.History；
 *  - state 草稿 → PATCH /fields/System.State；
 *  - link 草稿仍被明确拒绝（S-04）。
 */

let rest: FakeRest

const rolesData: RoleDefinition[] = [
  { id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm-deep', defaultMcp: ['tfs-mcp'] },
]

// 每个用例前重置角色数据，避免 CRUD 用例污染后续用例（模块级数组会被就地修改）。
beforeEach(() => {
  rolesData.length = 0
  rolesData.push({ id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm-deep', defaultMcp: ['tfs-mcp'] })
})

const fakeRoles = {
  list: () => rolesData,
  getByName: (n: string) => rolesData.find(r => r.name === n),
  // 镜像 RoleStore.save：先校验（id/name/provider 必填），违规即抛（供 api.saveRole 捕获为 reason）。
  save: (role: RoleDefinition) => {
    const errors = validateRole(role)
    if (errors.length) throw new Error(`角色校验失败：${errors.map(e => `${e.field}:${e.message}`).join('; ')}`)
    const i = rolesData.findIndex(r => r.id === role.id)
    if (i >= 0) rolesData[i] = role
    else rolesData.push(role)
  },
  delete: (id: string) => {
    const i = rolesData.findIndex(r => r.id === id)
    if (i < 0) return false
    rolesData.splice(i, 1)
    return true
  },
}

function makeApi(opts: {
  getRoleReferences?: (name: string) => string[]
  /** 看板服务覆写；显式传 null = 不装配看板（测能力降级路径）；缺省 = 内存 fs 真看板。 */
  board?: BoardService | null
  /** 覆写 `GET /_apis/projects` 的返回（US1 缓存用例要用空清单模拟"采集失败/抖动"）。 */
  projects?: unknown
  /** 运行期集合 getter（US1 缓存按集合键分区；缺省回退 `deps.collection`）。 */
  currentCollection?: () => string
} = {}): {
  api: ReturnType<typeof createHostApi>
  getDispatched: () => unknown
} {
  const fs = createMemFs()
  const audit = new AuditLog('/mem/audit', fs)
  const guard = new WriteGuard(audit)
  rest = makeFakeRest({
    '_apis/wit/wiql': { workItems: [] },
    '_apis/wit/workitems?ids=': { value: [] },
    '_apis/projects': opts.projects ?? { value: [{ id: 'p1', name: 'EAHis' }] },
    // 通配写回路由：PATCH /workitems/{id} 全部成功（本文件只关心"调用发生+参数形状"，
    // rev 冲突等失败语义在 adapter.spec.ts 专项覆盖）。
    '_apis/wit/workitems/': { id: 0, rev: 2 },
  })
  const adapter = new TfsAdapter({
    rest: rest.config,
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 'tfs-mcp',
  })
  // 问题 1：默认装配真 BoardService（内存 fs），让可选项走「采集 → 落盘 → 读盘优先」真实链路。
  // 个别用例（工作目录 prompt）需要桩时通过 opts.board 覆盖。
  const board =
    opts.board ??
    new BoardService({
      baseDir: '/mem/board',
      fs,
      board: new Board(),
      adapter,
      roles: { list: fakeRoles.list, getByName: fakeRoles.getByName },
      defaultLabel: 'dsh',
    })
  let dispatched: unknown = null
  const dispatcher: Pick<RequirementDispatcher, 'dispatch'> = {
    dispatch: async req => {
      dispatched = req
      return { taskId: req.taskId, requirementId: req.requirementId, runId: 'run-x', provider: req.role.provider }
    },
  }
  const api = createHostApi({
    roles: fakeRoles,
    adapter,
    dispatcher,
    // undefined → 上面构造的真看板；显式 null → 不装配（降级用例）；对象 → 桩覆盖。
    ...(opts.board === null ? {} : { board: opts.board ?? board }),
    getParent: () => ({}) as Agent,
    models: ['m-deep'],
    mcpServers: ['tfs-mcp'],
    skills: [],
    tagSuggestions: ['dsh'],
    collection: 'WN_HIS',
    ...(opts.getRoleReferences ? { getRoleReferences: opts.getRoleReferences } : {}),
    ...(opts.currentCollection ? { currentCollection: opts.currentCollection } : {}),
  })
  return { api, getDispatched: () => dispatched }
}

/** 找最近一次对指定工作项的 PATCH。 */
function patchOf(id: number): { body: Array<{ op: string; path: string; value?: unknown }> } {
  const call = [...rest.calls]
    .reverse()
    .find(c => c.method === 'PATCH' && c.url.includes(`/_apis/wit/workitems/${id}`))
  expect(call, `应存在对 ${id} 的 PATCH`).toBeDefined()
  return call as never
}

describe('getPanelData', () => {
  it('聚合角色与静态数据', () => {
    const { api } = makeApi()
    const data = api.getPanelData()
    expect(data.roles).toHaveLength(1)
    expect(data.roles[0]!.name).toBe('架构师')
    expect(data.collection).toBe('WN_HIS')
    expect(data.models).toEqual(['m-deep'])
    expect(data.mcpServers).toEqual(['tfs-mcp'])
  })
})

describe('confirmWrite 映射（过四道门禁后 PATCH json-patch）', () => {
  it('tag 草稿 → PATCH /fields/System.Tags（id:number, tags 分号拼接）', async () => {
    const { api } = makeApi()
    const ops: WriteOpDraft[] = [{ opType: 'tag', before: [], after: ['dsh', 'urgent'] }]
    const r = await api.confirmWrite({ ops, targetWorkItem: '123@WN_HIS', collection: 'WN_HIS' })
    expect(r.ok).toBe(true)
    expect(patchOf(123).body[0]).toEqual({
      op: 'replace', path: '/fields/System.Tags', value: 'dsh;urgent',
    })
  })

  it('comment 草稿 → PATCH /fields/System.History', async () => {
    const { api } = makeApi()
    const ops: WriteOpDraft[] = [{ opType: 'comment', before: null, after: '已完成拆解' }]
    const r = await api.confirmWrite({ ops, targetWorkItem: '123@WN_HIS', collection: 'WN_HIS' })
    expect(r.ok).toBe(true)
    expect(patchOf(123).body[0]).toEqual({
      op: 'add', path: '/fields/System.History', value: '已完成拆解',
    })
  })

  it('state 草稿 → PATCH /fields/System.State', async () => {
    const { api } = makeApi()
    const ops: WriteOpDraft[] = [{ opType: 'state', before: 'Active', after: 'Resolved' }]
    const r = await api.confirmWrite({ ops, targetWorkItem: '123@WN_HIS', collection: 'WN_HIS' })
    expect(r.ok).toBe(true)
    expect(patchOf(123).body[0]).toEqual({
      op: 'replace', path: '/fields/System.State', value: 'Resolved',
    })
  })

  it('link 草稿被明确拒绝（S-04 关联经评论实现）', async () => {
    const { api } = makeApi()
    const ops: WriteOpDraft[] = [{ opType: 'link', before: null, after: 'changeset:123' }]
    const r = await api.confirmWrite({ ops, targetWorkItem: '123@WN_HIS', collection: 'WN_HIS' })
    expect(r.ok).toBe(false)
    expect(r.results[0]!.opType).toBe('link')
    expect(r.results[0]!.ok).toBe(false)
  })

  it('目标 id 缺失即拒', async () => {
    const { api } = makeApi()
    const r = await api.confirmWrite({ ops: [], targetWorkItem: '—', collection: '' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('targetWorkItem')
  })
})

describe('dispatch 角色解析', () => {
  it('按角色名解析并构建 DispatchRequest（需求已领取 → 自动登记手工任务）', async () => {
    const { api, getDispatched } = makeApi()
    // 问题 6：无 taskId 的派发会落地为看板任务，所以需求必须先领取（未领取的拒绝路径见下一条）。
    await api.claimRequirement({
      requirement: {
        id: 123,
        collection: 'WN_HIS',
        project: 'EAHis',
        title: '演示需求',
        type: '需求',
        state: '已建议',
        assignedTo: 'zhangbo3',
        priority: '2',
        areaPath: 'EAHis',
        iterationPath: 'EAHis',
        tags: ['dsh'],
        changedDate: new Date().toISOString(),
        url: '',
      },
    })
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '拆解需求',
        frozenConfig: { mcp: ['tfs-mcp'], skills: [], model: 'm-deep' },
        permission: 'workspace-write',
        },
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(true)
    expect(r.runId).toBe('run-x')
    const req = getDispatched() as { requirementId: string; taskId: string; role: RoleDefinition; frozenConfig: { model: string } }
    expect(req.requirementId).toBe('123@WN_HIS')
    // 派发用的 taskId 就是新建的手工任务 id（与回带值一致 ⇒ run 能回绑到看板）。
    expect(req.taskId).toBe(r.taskId)
    expect(req.taskId).toMatch(/^123@WN_HIS#manual-/)
    expect(req.role.name).toBe('架构师')
    expect(req.frozenConfig.model).toBe('m-deep')
  })

  it('未知角色返回可读错误', async () => {
    const { api } = makeApi()
    const r = await api.dispatch({
      draft: { roleName: '不存在', prompt: 'x', frozenConfig: { mcp: [], skills: [], model: '' }, permission: 'read-only' },
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不存在')
  })
})

// spec 009：模型供应商必须随 model 成对冻结并透传给分发器——
// 旧链路 UI 只提交裸 model id，子 agent 的 provider 继承父聊天会话（现场为英伟达 nvida），
// 造成"选火山方舟 deepseek-v4-flash、实际跑在英伟达"。
describe('dispatch · 模型供应商路由（spec 009）', () => {
  async function claimedApi(): Promise<ReturnType<typeof makeApi>> {
    const built = makeApi()
    await built.api.claimRequirement({
      requirement: {
        id: 321,
        collection: 'WN_HIS',
        project: 'EAHis',
        title: '供应商路由需求',
        type: '需求',
        state: '已建议',
        assignedTo: 'u',
        priority: '2',
        areaPath: 'EAHis',
        iterationPath: 'EAHis',
        tags: ['dsh'],
        changedDate: new Date().toISOString(),
        url: '',
      },
    })
    return built
  }

  it('frozenConfig 显式带 modelProvider 时成对透传给分发器（火山方舟不掉包）', async () => {
    const { api, getDispatched } = await claimedApi()
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '执行',
        frozenConfig: { mcp: [], skills: [], model: 'deepseek-v4-flash', modelProvider: 'arkcode' },
        permission: 'read-only',
        },
      targetWorkItem: '321@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(true)
    const req = getDispatched() as { frozenConfig: { model: string; modelProvider?: string; mcp: string[] } }
    // mcp 空数组按既有语义回落角色默认（角色夹具 defaultMcp=['tfs-mcp']）；本用例只锁模型路由成对。
    expect(req.frozenConfig.model).toBe('deepseek-v4-flash')
    expect(req.frozenConfig.modelProvider).toBe('arkcode')
    expect(req.frozenConfig.mcp).toEqual(['tfs-mcp'])
  })

  it('历史裸 model（无 modelProvider）透传时不伪造供应商键，维持继承父会话的旧语义', async () => {
    const { api, getDispatched } = await claimedApi()
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '执行',
        frozenConfig: { mcp: [], skills: [], model: 'm-deep' },
        permission: 'read-only',
        },
      targetWorkItem: '321@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(true)
    const req = getDispatched() as { frozenConfig: { model: string; modelProvider?: string } }
    expect(req.frozenConfig.model).toBe('m-deep')
    expect(req.frozenConfig).not.toHaveProperty('modelProvider')
  })

  it('冻结 model 为空时回落到角色默认模型，且角色 defaultModelProvider 成对带出', async () => {
    const { api, getDispatched } = await claimedApi()
    // 角色夹具默认模型为 m-deep（见文件顶部 rolesData），补绑供应商模拟新格式 roles.json。
    rolesData[0]!.defaultModelProvider = 'arkcode'
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '执行',
        frozenConfig: { mcp: [], skills: [], model: '' },
        permission: 'read-only',
        },
      targetWorkItem: '321@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(true)
    const req = getDispatched() as { frozenConfig: { model: string; modelProvider?: string } }
    expect(req.frozenConfig.model).toBe('m-deep')
    expect(req.frozenConfig.modelProvider).toBe('arkcode')
  })

  it('updateTask 校验 modelProvider 必须是字符串', async () => {
    const { api } = await claimedApi()
    const created = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '执行',
        frozenConfig: { mcp: [], skills: [], model: 'm-deep' },
        permission: 'read-only',
        },
      targetWorkItem: '321@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(created.ok).toBe(true)
    const bad = await api.updateTask({
      taskId: created.taskId!,
      modelProvider: 123 as unknown as string,
    })
    expect(bad.ok).toBe(false)
    expect(bad.reason).toContain('modelProvider')
  })
})

describe('dispatch · 工作目录接线（workspace → 派发 prompt 的任务上下文）', () => {
  /**
   * 最小看板桩：`dispatch` 只用到 `snapshot().tasks` 查 workspace 与 `setTaskState(..., 'start')`。
   *
   * 之所以用桩而非真 BoardService：本文件测的是**宿主编排**对看板数据的消费方式（是否把
   * workspace 读出来注入 prompt），看板自身的读写语义由 board-service.spec.ts 覆盖。
   */
  function boardStub(
    tasks: Array<{ taskId: string; title: string; workspace?: string; requirementId?: string }>,
    /** 看板需求表（键 = `id@collection`）：用于测"任务没设 workspace 时回落到需求级"（问题 1）。 */
    requirements: Record<string, { workspace?: string; prompt?: string; execState?: 'active' | 'completed' }> = {},
  ): BoardService {
    return {
      snapshot: () => ({ tasks }),
      setTaskState: () => ({ ok: true }),
      // spec 006：launchRun 落定链路用到的新方法（本文件不测看板落定语义，给 no-op 桩）。
      bindRun: () => ({ ok: true }),
      settleTask: () => ({ ok: true }),
      openFollowUp: () => ({ ok: true }),
      /**
       * 问题 6：无 taskId 的派发（执行配置「发起执行」）会先登记一条手工看板任务。
       * 桩返回确定性 id，便于断言"派发确实落在一条任务上"。
       */
      createManualTask: (input: { requirementKey: string; roleAgent: string }) => ({
        ok: true,
        taskId: `${input.requirementKey}#manual-${input.roleAgent}`,
      }),
      board: { snapshot: { requirements } },
    } as unknown as BoardService
  }

  const TASK_ID = '1997179@WN_HIS#analyze'
  const draft: {
    roleName: string
    prompt: string
    frozenConfig: { mcp: string[]; skills: string[]; model: string }
    permission: 'workspace-write'
  } = {
    roleName: '架构师',
    prompt: '拆解需求为可执行任务',
    frozenConfig: { mcp: ['tfs-mcp'], skills: [], model: 'm-deep' },
    permission: 'workspace-write',
    }

  function promptTextOf(getDispatched: () => unknown): string {
    const req = getDispatched() as { prompt: Array<{ type: string; text: string }> }
    return req.prompt.map(b => b.text).join('\n')
  }

  it('看板任务带 workspace → prompt 前置硬约束工作目录段（问题 1）', async () => {
    const { api, getDispatched } = makeApi({
      board: boardStub([{ taskId: TASK_ID, title: '分析需求', workspace: 'D:\\体检管理\\repo' }]),
    })
    const r = await api.dispatch({ draft, targetWorkItem: '1997179@WN_HIS', collection: 'WN_HIS', taskId: TASK_ID })
    expect(r.ok).toBe(true)
    const text = promptTextOf(getDispatched)
    expect(text).toContain('【工作目录')
    expect(text).toContain('D:\\体检管理\\repo')
    expect(text).toContain('工作项 #1997179')
    // 可执行动作（问题 1）：只给路径不够，必须给"绝对路径 + 先 cd"的操作约定。
    expect(text).toContain('绝对路径')
    expect(text).toContain('cd /d "D:\\体检管理\\repo"')
    // 原 draft.prompt 必须保留在 workspace 段之后（不能吞掉用户指令）。
    expect(text).toContain('拆解需求为可执行任务')
    expect(text.indexOf('【工作目录')).toBeLessThan(text.indexOf('拆解需求为可执行任务'))
  })

  it('看板任务未接线 workspace 且需求未设 → prompt 不含工作目录段（零噪声）', async () => {
    const { api, getDispatched } = makeApi({
      board: boardStub([{ taskId: TASK_ID, title: '分析需求' }]),
    })
    await api.dispatch({ draft, targetWorkItem: '1997179@WN_HIS', collection: 'WN_HIS', taskId: TASK_ID })
    const text = promptTextOf(getDispatched)
    expect(text).not.toContain('【工作目录')
    // 问题 1/5：无工作目录段时，正文后仍固定追加「执行纪律 + 完成/人工确认 + 产物协议」段。
    expect(text).toBe('拆解需求为可执行任务\n\n' + buildExecBudgetSection())
  })

  it('任务未设 workspace → 回落到需求级 workspace（问题 1：两处配置任一都要生效）', async () => {
    const { api, getDispatched } = makeApi({
      board: boardStub([{ taskId: TASK_ID, title: '分析需求' }], {
        '1997179@WN_HIS': { workspace: 'D:\\需求级目录' },
      }),
    })
    const r = await api.dispatch({ draft, targetWorkItem: '1997179@WN_HIS', collection: 'WN_HIS', taskId: TASK_ID })
    expect(r.ok).toBe(true)
    const text = promptTextOf(getDispatched)
    expect(text).toContain('D:\\需求级目录')
  })

  it('面板显式选择的工作目录优先于任务上的（问题 1 取值链：显式 > 任务 > 需求）', async () => {
    const { api, getDispatched } = makeApi({
      board: boardStub([{ taskId: TASK_ID, title: '分析需求', workspace: 'D:\\任务级目录' }], {
        '1997179@WN_HIS': { workspace: 'D:\\需求级目录' },
      }),
    })
    const r = await api.dispatch({
      draft: { ...draft, workspace: 'D:\\面板选的目录' },
      targetWorkItem: '1997179@WN_HIS',
      collection: 'WN_HIS',
      taskId: TASK_ID,
    })
    expect(r.ok).toBe(true)
    expect(r.workspace).toBe('D:\\面板选的目录')
    const text = promptTextOf(getDispatched)
    expect(text).toContain('D:\\面板选的目录')
    expect(text).not.toContain('D:\\任务级目录')
  })

  it('未传 taskId（执行配置「发起执行」）→ 登记为看板任务并注入工作目录（问题 1/6）', async () => {
    const { api, getDispatched } = makeApi({
      board: boardStub([{ taskId: TASK_ID, title: '分析需求', workspace: 'D:\\repo' }]),
    })
    const r = await api.dispatch({ draft, targetWorkItem: '1997179@WN_HIS', collection: 'WN_HIS' })
    expect(r.ok).toBe(true)
    // 问题 6：这条派发**落地为一条看板任务**（用户在任务中心能看到 attempt/轨迹/收口）。
    expect(r.createdTask).toBe(true)
    expect(r.taskId).toBe('1997179@WN_HIS#manual-架构师')
    const req = getDispatched() as { taskId: string }
    expect(req.taskId).toBe(r.taskId)
    // 问题 1：旧实现这条路径完全没有工作目录段（因为只取 boardTask.workspace，此处无 boardTask）；
    // 现在它按 需求级 → （桩中任务级不可达）回落，或至少不阻断派发。
    expect(promptTextOf(getDispatched)).toContain('拆解需求为可执行任务')
  })

  it('无 board 且无 taskId → 拒绝派发（问题 6：不产生"看不见执行内容"的派发）', async () => {
    const { api, getDispatched } = makeApi({ board: null })
    const r = await api.dispatch({ draft, targetWorkItem: '1997179@WN_HIS', collection: 'WN_HIS' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('看板服务不可用')
    expect(getDispatched()).toBeNull()
  })

  it('无 board 但带 taskId → 派发仍成功（看板能力降级不阻断，工作目录段为空）', async () => {
    const { api, getDispatched } = makeApi({ board: null })
    const r = await api.dispatch({ draft, targetWorkItem: '1997179@WN_HIS', collection: 'WN_HIS', taskId: TASK_ID })
    expect(r.ok).toBe(true)
    expect(promptTextOf(getDispatched)).not.toContain('【工作目录')
  })
})

describe('角色 CRUD（US5 / T057）', () => {
  it('saveRole 新增并出现在 listRoles', () => {
    const { api } = makeApi()
    const r = api.saveRole({ id: 'r2', name: '测试工程师', provider: 'spawn' })
    expect(r.ok).toBe(true)
    expect(api.listRoles().map(x => x.id)).toContain('r2')
  })

  it('saveRole 校验失败返回可读原因（缺 provider）', () => {
    const { api } = makeApi()
    const r = api.saveRole({ id: 'r3', name: '无 provider', provider: '' })
    expect(r.ok).toBe(false)
    expect(r.reason).toBeTruthy()
  })

  it('deleteRole 无引用时直接删除', () => {
    const { api } = makeApi()
    expect(api.deleteRole('r1').ok).toBe(true)
    expect(api.listRoles().find(x => x.id === 'r1')).toBeUndefined()
  })

  it('deleteRole 被引用时拒绝并给出 references；force 才删', () => {
    const { api } = makeApi({ getRoleReferences: name => (name === '架构师' ? ['task-1', 'task-2'] : []) })
    const blocked = api.deleteRole('r1')
    expect(blocked.ok).toBe(false)
    expect(blocked.references).toEqual(['task-1', 'task-2'])
    expect(api.listRoles().find(x => x.id === 'r1')).toBeDefined()
    expect(api.deleteRole('r1', true).ok).toBe(true)
    expect(api.listRoles().find(x => x.id === 'r1')).toBeUndefined()
  })
})

describe('listRequirements（US2）', () => {
  /**
   * REST 化后出口 = WIQL 两段式（POST wiql → GET workitems?ids=），
   * 原 `tfs_custom_query` 恒失败的历史结论已随 mcp 通道一起退场。
   */
  it('经 adapter 走 REST WIQL 两段式并返回结果', async () => {
    const { api } = makeApi()
    // state 收窄条件用于通过 D2「禁止无条件全集合扫描」护栏（仅 top 分页会被前置拒绝）。
    const r = await api.listRequirements({ top: 5, state: '已关闭' })
    expect(r.ok).toBe(true)
    expect(Array.isArray(r.items)).toBe(true)
    expect(rest.calls.some(c => c.url.includes('/_apis/wit/wiql'))).toBe(true)
  })
})

// ───────────────── 问题 1：可选项落盘缓存（query-options.json） ─────────────────────────
//
// 用户诉求原文：「第一次获取到数据源后，保存到本地配置文件中，每次优先读取配置文件的数据源；
// 点击采集可选项按钮重新获取并保存，同时更新下拉数据源」。
// 采集成本的实测来源：`TfsAdapter.getQueryOptions` 会跑 whoami + `GET /_apis/projects` +
// **逐项目**取类型 + **逐项目前 12 个类型**取状态，62 个项目 ≈ 数百次 REST。
// 故这里的"采集次数"用 `GET /_apis/projects` 的命中次数作为代理计数：一轮真实采集必打它一次。
//
// 与旧「进程内缓存」语义的差别：权威缓存是磁盘上的 query-options.json，读盘返回的是**新解析的
// 对象**（引用不同、内容相同），故身份断言改为 toStrictEqual；只有并发首采共享同一个 Promise。

describe('getQueryOptions 落盘缓存（问题 1：首次采集落盘，之后读盘优先）', () => {
  /** 项目清单端点的命中次数 = 已发生的真实采集轮数。 */
  function collectionRounds(): number {
    return rest.calls.filter(c => c.url.includes('/_apis/projects')).length
  }
  /** 忽略采集时间戳，只比四项下拉内容（两轮采集的 collectedAt 必然不同）。 */
  function optionsBody(o: { projects: unknown; types: unknown; states: unknown; assignees: unknown }) {
    return { projects: o.projects, types: o.types, states: o.states, assignees: o.assignees }
  }

  it('首次调用采集并落盘；连续第二次调用读盘，不再采集（内容一致）', async () => {
    const { api } = makeApi()
    const first = await api.getQueryOptions()
    const afterFirst = collectionRounds()
    expect(afterFirst).toBe(1)
    const second = await api.getQueryOptions()
    // 读盘得到新解析对象（引用不同），但四项内容与落盘快照完全一致。
    expect(second).not.toBe(first)
    expect(second).toStrictEqual(first)
    expect(collectionRounds()).toBe(afterFirst)
    // 落盘缓存可经独立通道读回（HostBridge 直通面）。
    const disk = await api.loadQueryOptions()
    expect(disk.ok).toBe(true)
    expect(disk.data).toStrictEqual(first)
    expect(typeof disk.savedAt).toBe('string')
  })

  it('换集合后必须重采（缓存按集合分区，不能拿 A 集合的下拉给 B 集合用）', async () => {
    let col = 'WN_HIS'
    const { api } = makeApi({ currentCollection: () => col })
    const first = await api.getQueryOptions()
    const rounds = collectionRounds()
    col = 'OTHER_COLL'
    const other = await api.getQueryOptions()
    expect(collectionRounds()).toBe(rounds + 1)
    expect(optionsBody(other)).toStrictEqual(optionsBody(first)) // 桩数据同形，但来自新一轮采集且落在另一分区
    // 切回原集合命中该集合的**落盘**缓存（换集合只是新增分区，不覆盖旧的）。
    col = 'WN_HIS'
    const back = await api.getQueryOptions()
    expect(optionsBody(back)).toStrictEqual(optionsBody(first))
    expect(collectionRounds()).toBe(rounds + 1)
    // 两个集合各有独立落盘分区。
    const a = await api.loadQueryOptions('WN_HIS')
    const b = await api.loadQueryOptions('OTHER_COLL')
    expect(a.data).not.toBeNull()
    expect(b.data).not.toBeNull()
  })

  it('全空结果**不**落盘（一次抖动不该把空下拉锁死到本地文件）', async () => {
    const { api } = makeApi({ projects: { value: [] } })
    const first = await api.getQueryOptions()
    expect(first.projects).toEqual([])
    expect(first.types).toEqual([])
    const rounds = collectionRounds()
    await api.getQueryOptions()
    // 仍然重采：全空结果没有写进落盘缓存。
    expect(collectionRounds()).toBe(rounds + 1)
    const disk = await api.loadQueryOptions()
    expect(disk.data).toBeNull()
  })

  it('并发首采共享一次采集（N 个请求进入 ≠ N 轮全量采集；同一 Promise）', async () => {
    const { api } = makeApi()
    const [a, b, c] = await Promise.all([
      api.getQueryOptions(),
      api.getQueryOptions(),
      api.getQueryOptions(),
    ])
    expect(a).toBe(b)
    expect(b).toBe(c)
    expect(collectionRounds()).toBe(1)
  })

  it('refreshQueryOptions（采集可选项）强制重采一次并覆盖落盘，之后普通调用读盘不再采集', async () => {
    const { api } = makeApi()
    const before = await api.getQueryOptions()
    const rounds = collectionRounds()
    const refreshed = await api.collectQueryOptions()
    expect(collectionRounds()).toBe(rounds + 1)
    expect(refreshed.ok).toBe(true)
    // 新结果已覆盖落盘，后续普通调用不再打 TFS（读盘内容与重采结果一致）。
    const after = await api.getQueryOptions()
    expect(after).toStrictEqual(refreshed.data)
    expect(collectionRounds()).toBe(rounds + 1)
    // 两轮采集的桩数据四项内容同形（collectedAt 时间戳不同，已在 optionsBody 中剔除比较）。
    expect(optionsBody(refreshed.data!)).toStrictEqual(optionsBody(before))
  })

  it('重采进行中的并发普通调用共享这次重采，不额外打 TFS', async () => {
    const { api } = makeApi()
    // 刻意**不**先取一次：`refresh` 自己登记 inflight，随后进入的普通调用应挂在同一轮上。
    const [refreshed, plain] = await Promise.all([api.refreshQueryOptions(), api.getQueryOptions()])
    expect(plain).toBe(refreshed)
    expect(collectionRounds()).toBe(1)
  })

  it('refreshQueryOptions 重采后落盘的是新快照（旧引用不再被返回）', async () => {
    const { api } = makeApi()
    const first = await api.getQueryOptions()
    const second = await api.refreshQueryOptions()
    const third = await api.getQueryOptions()
    // 第三次读到的是重采后落盘的内容（新对象引用，内容与第二轮一致）。
    expect(second).not.toBe(first)
    expect(third).not.toBe(second)
    expect(third).toStrictEqual(second)
  })
})

/**
 * 目标口径回归（2026-09-21 实机事故）。
 *
 * 事故形态：客户端把面板里的占位符 `—` 当目标发下来 ⇒ 确认回写报
 * *targetWorkItem 缺少有效工作项 id：—*、派发得到 `task=—#role-coder`。
 * 修复要求：① 目标键容忍看板任务 id 形态（`…#stage`）而不污染集合；
 * ② 没有可用目标时**拒绝并给出可执行提示**，不再造出 `—#role-coder`；
 * ③ 只要任务自己知道所属需求，需求键就以任务为准（占位符也不影响 prompt/归组）。
 */
describe('目标口径（targetWorkItem）', () => {
  it('目标键是看板任务 id（含 #stage）时，集合不得被污染', async () => {
    const { api } = makeApi()
    const r = await api.confirmWrite({
      ops: [{ opType: 'tag', before: [], after: ['dsh'] }],
      targetWorkItem: '123@WN_HIS#analyze',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(true)
    // patchOf 断言"确实 PATCH 了工作项 123"；若集合被切成 `WN_HIS#analyze`，写路径会打偏。
    const call = patchOf(123)
    expect(call.body.some(op => op.path === '/fields/System.Tags')).toBe(true)
  })

  it('无 taskId 且目标无效（占位符）→ 拒绝派发并提示去哪儿选目标', async () => {
    const { api, getDispatched } = makeApi()
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: 'x',
        frozenConfig: { mcp: [], skills: [], model: '' },
        permission: 'read-only',
        },
      targetWorkItem: '—',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('缺少有效的派发目标')
    expect(r.reason).toContain('选为目标')
    expect(getDispatched()).toBeNull() // 一个子 agent 都没起
  })

  it('无 taskId 且需求未领取 → 拒绝并提示先领取（问题 6）', async () => {
    const { api, getDispatched } = makeApi()
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: 'x',
        frozenConfig: { mcp: [], skills: [], model: '' },
        permission: 'read-only',
        },
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    // 问题 6：无 taskId 的派发必须落地为看板任务，而任务只能挂在已领取的需求下 ⇒ 未领取即拒。
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('未领取')
    expect(getDispatched()).toBeNull()
  })

  it('无 taskId 且需求已领取 → 创建手工看板任务并派发（问题 6：执行内容可见）', async () => {
    const { api, getDispatched } = makeApi()
    const claimed = await api.claimRequirement({
      requirement: {
        id: 123,
        collection: 'WN_HIS',
        project: 'EAHis',
        title: '演示需求',
        type: '需求',
        state: '已建议',
        assignedTo: 'zhangbo3',
        priority: '2',
        areaPath: 'EAHis',
        iterationPath: 'EAHis',
        tags: ['dsh'],
        changedDate: new Date().toISOString(),
        url: '',
      },
    })
    expect(claimed.ok).toBe(true)
    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: 'x',
        frozenConfig: { mcp: [], skills: [], model: '' },
        permission: 'read-only',
        },
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(true)
    expect(r.createdTask).toBe(true)
    expect(r.taskId).toMatch(/^123@WN_HIS#manual-/)
    // 手工任务确实进了看板（用户能在任务中心看到它、点开看执行过程）。
    expect(api.getBoard().tasks.some(t => t.taskId === r.taskId)).toBe(true)
    const req = getDispatched() as { taskId: string; requirementId: string }
    expect(req.taskId).toBe(r.taskId)
    expect(req.requirementId).toBe('123@WN_HIS')
  })

  it('目标为占位符但有 taskId → 需求键/工作项号取自看板任务的 requirementId', async () => {
    const task = {
      taskId: '700@WN_HIS#analyze',
      requirementId: '700@WN_HIS',
      title: '分析需求',
      description: '',
      prompt: '',
      workspace: 'D://体检管理',
      frozenConfig: { mcp: [], skills: [], model: '' },
      state: 'pending',
      execState: 'queued',
      blockedBy: [],
      revision: 1,
      attempts: [],
      artifactPaths: [],
      roleAgent: '架构师',
    }
    const boardStub = {
      snapshot: () => ({ tasks: [task] }),
      // 注意：`Board.snapshot` 是 **getter（属性）**，不是方法（`core/board/board.ts:111`）。
      board: { snapshot: { requirements: { '700@WN_HIS': { prompt: '需求级提示词' } } } },
      setTaskState: () => ({ ok: true }),
      bindRun: () => ({ ok: true }),
      settleTask: () => ({ ok: true }),
    } as unknown as BoardService
    const { api, getDispatched } = makeApi({ board: boardStub })

    const r = await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: '任务级正文',
        frozenConfig: { mcp: [], skills: [], model: '' },
        permission: 'read-only',
        },
      targetWorkItem: '—', // 客户端事故里的占位符
      collection: '',
      taskId: '700@WN_HIS#analyze',
    })
    expect(r.ok).toBe(true)
    const req = getDispatched() as {
      taskId: string
      requirementId: string
      prompt: Array<{ type: string; text: string }>
    }
    expect(req.requirementId).toBe('700@WN_HIS')
    const text = req.prompt[0]!.text
    expect(text).toContain('工作项 #700') // 占位符不再让工作项号丢失
    expect(text).toContain('集合 WN_HIS') // 集合取自任务的 requirementId，而非占位符
    expect(text).toContain('需求级提示词') // requirementKey 正确 → 需求级提示词能找到
    expect(text).toContain('任务级正文')
  })
})

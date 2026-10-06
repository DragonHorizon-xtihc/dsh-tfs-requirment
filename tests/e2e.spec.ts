import { describe, expect, it } from 'vitest'
import { AuditLog } from '../src/write-guard/audit.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { RoleStore, DEFAULT_ROLES } from '../src/orchestration/roles.js'
import { RequirementDispatcher, type SubagentClient } from '../src/orchestration/dispatch.js'
import { Board } from '../src/core/board/board.js'
import { BoardService } from '../src/host/board-service.js'
import { createHostApi, type HostApi } from '../src/host/api.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'
import { makeFakeRest, restWorkItem, type FakeRest } from './helpers/fake-rest.js'
import type { SubagentStartRequest, SubagentRun, SubagentResult } from '@deepseek-ai/dsh-subagent'
import type { SessionId } from '@deepseek-ai/dsh-session'
import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * 端到端集成测试（T067）：配置 → 拉取/领取 → 拆解 → 指派 → 执行 → 打标签 → 回写 → 恢复。
 *
 * 与其它 spec 的区别：本文件**串起真实装配**——真 `TfsAdapter`（经 REST 桩走完整字段映射与四道门禁）、
 * 真 `WriteGuard` + `AuditLog`（内存 fs）、真 `RoleStore`、真 `RequirementDispatcher`、真 `BoardService`、
 * 真 `createHostApi` 编排层。只有两处是桩：
 *   1. `fetch`（REST 数据通道，见 `helpers/fake-rest.ts`）——记录请求 URL/method/body，可注入失败；
 *   2. `ctx.subagents`（宿主子 agent 服务）——记录 start 调用。
 * 因此这条链路一旦断裂（字段名错、门禁漏、状态机错、落盘丢），本文件必然失败。
 *
 * ## REST 化后的断言语义变化
 *
 * 旧版断言 `h.tools.calls.find(c => c.name === 'tfs_add_tags').args`（mcp 工具参数）；
 * REST 化后断言 `rest.calls` 的 **HTTP 请求**（URL + json-patch body），比参数断言更强：
 * 它同时锁定了端点路径、`api-version`、`Content-Type` 与 json-patch 的 `path`/`value` 结构。
 */

/** 假 SubagentRun（与 dispatch.spec 同一形态）。 */
class FakeRun implements SubagentRun {
  readonly id: SessionId
  readonly localAgent: undefined = undefined
  readonly result: Promise<SubagentResult>
  private resolveFn!: (value: SubagentResult) => void
  constructor(id: string) {
    this.id = id as unknown as SessionId
    this.result = new Promise<SubagentResult>(res => {
      this.resolveFn = res
    })
  }
  resolve(result?: SubagentResult): void {
    // spec 006：模型失败也 resolve（带非 completed stopReason），仅基础设施故障 reject。
    // 默认按"正常完成"落定；需要模拟失败时显式传入 stopReason:'error' + diagnostic。
    this.resolveFn(result ?? { output: [], stopReason: 'completed' })
  }
  async dispose(): Promise<void> {}
}

/** 假 SubagentClient：记录 start 调用。 */
class FakeSubagents implements SubagentClient {
  readonly starts: Array<{ name: string; label: string; model?: string }> = []
  readonly runs: FakeRun[] = []
  private next = 0
  async start(name: string, request: SubagentStartRequest): Promise<SubagentRun> {
    const run = new FakeRun(`run-${++this.next}`)
    this.starts.push({
      name,
      label: request.label ?? '',
      ...(request.agentOptions?.model ? { model: String(request.agentOptions.model) } : {}),
    })
    this.runs.push(run)
    return run
  }
}

/**
 * REST 桩：默认路由覆盖本文件全部读写路径。
 *
 * ## 键的设计
 *
 * `fake-rest` 按 URL 子串匹配、多条命中取最长键。这里读/写共用同一 URL
 * （`GET`/`PATCH /_apis/wit/workitems/{id}`），故写路由用 **`"PATCH "` 前缀**限定方法，
 * 让同一 URL 上的读、写各得其所（否则读路由会截胡写请求，导致"写成功但其实返回的是读结果"）。
 */
function makeRest(opts: { failOn?: string; failMessage?: string } = {}): FakeRest {
  const routes: Record<string, unknown> = {
    '_apis/connectionData': {
      authorizedUser: { providerDisplayName: 'zhangbo3(张波)', properties: { Account: { $value: 'zhangbo3' } } },
    },
    '_apis/projects': { value: [{ id: 'p1', name: 'PEIS' }, { id: 'p2', name: 'EDIS' }] },
    '_apis/wit/wiql': { workItems: [] },
  }
  const rest = makeFakeRest(routes)

  /** 逐 id 注册读路由。字段用 REST 原生命名（`System.*`），normalizeWorkItem 从中取值。 */
  const mk = (id: number, state = 'Active') =>
    restWorkItem(
      id,
      {
        'System.Id': id,
        'System.Title': `需求 ${id}`,
        'System.WorkItemType': '产品需求',
        'System.State': state,
        'System.AssignedTo': 'zhangbo3',
        'System.AreaPath': 'PEIS',
        'System.IterationPath': 'Sprint 1',
        'System.TeamProject': 'PEIS',
        'System.Tags': '',
        'System.ChangedDate': '2026-09-17T00:00:00Z',
      },
      1,
    )
  for (const id of [1, 123, 200, 300, 400, 500]) {
    rest.setRoute(`GET /_apis/wit/workitems/${id}`, mk(id))
  }
  // 写路径（PATCH）：返回工作项形状（adapter 只读 `rev` 用于冲突提示）。
  for (const id of [1, 123, 200, 300, 400, 500]) {
    rest.setRoute(`PATCH /_apis/wit/workitems/${id}`, { id, rev: 2, fields: {} })
  }

  if (opts.failOn) {
    // 定点失败：把该原始工具名对应的 **REST 端点 + 方法** 设为失败。
    // 映射关系 = adapter 的 call() 分发表（见 src/tfs/adapter.ts）；
    // 路径中的 id 是本文件各用例实际作用的工作项。
    const fail = { status: 500, body: opts.failMessage ?? 'boom' }
    const endpointByTool: Record<string, string> = {
      tfs_add_comment: 'PATCH /_apis/wit/workitems/200',
      tfs_add_tags: 'PATCH /_apis/wit/workitems/300',
      tfs_change_state: 'PATCH /_apis/wit/workitems/123',
    }
    const key = endpointByTool[opts.failOn]
    if (key) rest.setRoute(key, fail)
  }
  return rest
}

interface Harness {
  api: HostApi
  svc: BoardService
  fs: MemFs
  rest: FakeRest
  subagents: FakeSubagents
  audit: AuditLog
}

/** 装配一套真实链路（仅 REST 数据通道与 subagents 为桩）。 */
function makeHarness(opts: { fs?: MemFs; failOn?: string; failMessage?: string } = {}): Harness {
  const fs = opts.fs ?? createMemFs()
  const dir = 'C:/data'
  const rest = makeRest({
    ...(opts.failOn ? { failOn: opts.failOn } : {}),
    ...(opts.failMessage ? { failMessage: opts.failMessage } : {}),
  })
  const audit = new AuditLog(dir, fs)
  const guard = new WriteGuard(audit)
  const roleStore = new RoleStore(dir, fs)
  for (const role of DEFAULT_ROLES) roleStore.save(role)
  const adapter = new TfsAdapter({
    rest: rest.config,
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 'tfs-mcp',
  })
  const subagents = new FakeSubagents()
  const dispatcher = new RequirementDispatcher(subagents, 3)
  const svc = new BoardService({
    baseDir: dir,
    fs,
    board: new Board(),
    adapter,
    roles: roleStore,
    defaultLabel: 'dsh',
    getRuntimeCounts: () => ({ running: dispatcher.activeCount, queued: dispatcher.queuedCount }),
  })
  svc.load()
  const api = createHostApi({
    roles: roleStore,
    adapter,
    dispatcher,
    board: svc,
    health: { port: adapter, availableTools: () => [] },
    getParent: () => ({}) as unknown as Agent,
    models: ['m1'],
    mcpServers: ['tfs-mcp'],
    skills: [],
    tagSuggestions: ['dsh'],
    collection: 'WN_HIS',
  })
  return { api, svc, fs, rest, subagents, audit }
}

describe('端到端：配置 → 领取 → 拆解 → 指派 → 执行 → 打标签 → 回写 → 恢复（T067）', () => {
  it('完整链路一次跑通（字段映射、门禁、状态机、落盘全在路径上）', async () => {
    const h = makeHarness()

    // ① 配置自检（T029）：只读探测，不写
    const health = await h.api.healthCheck()
    expect(health.ok).toBe(true)
    expect(health.identity).toContain('张波')
    expect(health.collection).toBe('WN_HIS')
    expect(health.projectCount).toBe(2)
    // 只读探测**不得**发出任何写请求（PATCH/POST）。
    expect(h.rest.calls.every(c => c.method === 'GET')).toBe(true)

    // ② 领取（T036 去重 + T048 打 dsh 标签）：读 GET workitems/123 → 写 PATCH System.Tags
    const claim = await h.api.claimRequirement({ id: 123 })
    expect(claim.ok).toBe(true)
    expect(claim.added).toBe(true)
    expect(claim.tag?.ok).toBe(true)
    expect(claim.requirement?.title).toBe('需求 123')

    // 读路径：GET /_apis/wit/workitems/123（带 fields 白名单）
    const getCall = h.rest.calls.find(c => c.url.includes('/_apis/wit/workitems/123') && c.method === 'GET')!
    expect(getCall.url).toContain('WN_HIS')
    expect(getCall.url).toContain('api-version=4.1')

    // 写路径：PATCH /_apis/wit/workitems/123，body 为 json-patch 的 System.Tags
    const tagCall = h.rest.calls.find(c => c.method === 'PATCH' && c.url.includes('/_apis/wit/workitems/123'))!
    expect(tagCall.headers['Content-Type']).toContain('json-patch+json')
    expect(tagCall.body).toMatchObject([{ op: 'replace', path: '/fields/System.Tags', value: 'dsh' }])

    // 幂等（S-01）：重复领取不再入池、也不再打标签
    const again = await h.api.claimRequirement({ id: 123 })
    expect(again.added).toBe(false)
    expect(h.rest.calls.filter(c => c.method === 'PATCH' && c.url.includes('/_apis/wit/workitems/123'))).toHaveLength(1)

    // ③ 拆解（T041）：五段式 DAG（分析→架构师拆解→开发→代码审核→测试）
    const dec = await h.api.decomposeRequirement('123@WN_HIS')
    expect(dec.ok).toBe(true)
    expect(dec.taskIds).toHaveLength(5)
    expect(dec.created).toBe(5)
    expect(dec.skipped).toBe(0)
    let snap = h.api.getBoard()
    expect(snap.counts).toMatchObject({ pending: 5, inProgress: 0, completed: 0 })
    expect(snap.requirements).toHaveLength(1)
    expect(snap.requirements[0]!.tags).toContain('dsh')

    // ④ 指派（T042）：改派到第二个默认角色
    const role2 = DEFAULT_ROLES[1]!
    const assigned = h.api.assignTask('123@WN_HIS#analyze', role2.name)
    expect(assigned.ok).toBe(true)
    expect(assigned.task?.roleAgent).toBe(role2.name)

    // ⑤ 执行（US4）：派发**看板任务**给角色智能体。
    //    注意 taskId 必须带看板 ID（`…#analyze`）——否则 run 结果回绑不到看板（E2E 曾抓到该缺陷）。
    const dispatched = await h.api.dispatch({
      draft: {
        roleName: role2.name,
        prompt: '分析需求 123',
        frozenConfig: { mcp: ['tfs-mcp'], skills: [], model: 'm1' },
        permission: 'read-only',
        },
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
      taskId: '123@WN_HIS#analyze',
    })
    expect(dispatched.ok).toBe(true)
    expect(dispatched.runId).toBe('run-1')
    expect(h.subagents.starts).toHaveLength(1)
    expect(h.subagents.starts[0]!.name).toBe(role2.provider)
    expect(h.subagents.starts[0]!.model).toBe('m1')
    // 派发用的 taskId 与看板任务 ID 一致 → label 也是看板 ID
    expect(h.subagents.starts[0]!.label).toBe('123@WN_HIS:123@WN_HIS#analyze')

    // 派发同时把看板任务置为进行中（不是"派发了但看板没动"）
    snap = h.api.getBoard()
    expect(snap.tasks.find(t => t.taskId === '123@WN_HIS#analyze')!.execState).toBe('running')
    expect(snap.tasks.find(t => t.taskId === '123@WN_HIS#analyze')!.attemptCount).toBe(1)

    // run 落定 → 自动回绑看板（任务完成），依赖随之解除
    h.subagents.runs[0]!.resolve()
    await new Promise(r => setTimeout(r, 0))
    snap = h.api.getBoard()
    expect(snap.tasks.find(t => t.taskId === '123@WN_HIS#analyze')!.state).toBe('completed')
    expect(snap.tasks.find(t => t.taskId === '123@WN_HIS#analyze')!.execState).toBe('success')
    // 五段 DAG：analyze 收口后宿主自动链式派发 plan（autoChainTasks）。
    // 已在跑的任务不得重复启动——那会再开一条尝试并二次派发，两个子代理改同一个代码库。
    expect(h.api.setTaskState('123@WN_HIS#plan', 'start').ok).toBe(false)
    expect(h.subagents.runs[1]).toBeDefined()
    h.subagents.runs[1]!.resolve()
    await new Promise(r => setTimeout(r, 0))
    snap = h.api.getBoard()
    expect(snap.tasks.find(t => t.taskId === '123@WN_HIS#plan')!.state).toBe('completed')
    expect(snap.tasks.find(t => t.taskId === '123@WN_HIS#impl')!.execState).toBe('running')

    // ⑥ 回写（US4）：评论 + 状态，过四道门禁
    const write = await h.api.confirmWrite({
      ops: [
        { opType: 'comment', before: null, after: '已完成分析，进入实现阶段' },
        { opType: 'state', before: 'Active', after: 'Resolved' },
      ],
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(write.ok).toBe(true)
    expect(write.results).toHaveLength(2)
    // 评论 → PATCH System.History（`add` 语义，追加不覆盖）
    const commentCall = h.rest.calls.find(
      c => c.method === 'PATCH' && JSON.stringify(c.body).includes('/fields/System.History'),
    )!
    expect(commentCall.body).toMatchObject([
      { op: 'add', path: '/fields/System.History', value: '已完成分析，进入实现阶段' },
    ])
    // 状态 → PATCH System.State（`replace` 语义）
    const stateCall = h.rest.calls.find(
      c => c.method === 'PATCH' && JSON.stringify(c.body).includes('/fields/System.State'),
    )!
    expect(stateCall.body).toMatchObject([
      { op: 'replace', path: '/fields/System.State', value: 'Resolved' },
    ])

    // 幂等门禁（S-08）：同一意图重复回写被拒，且不再发第二次写调用
    const writesBefore = h.rest.calls.filter(c => c.method === 'PATCH').length
    const dup = await h.api.confirmWrite({
      ops: [{ opType: 'comment', before: null, after: '已完成分析，进入实现阶段' }],
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(dup.ok).toBe(false)
    expect(dup.reason).toContain('幂等键已应用')
    expect(h.rest.calls.filter(c => c.method === 'PATCH').length).toBe(writesBefore)

    // ⑦ 恢复（US6/T059）：同 fs 重新装配 → 看板完整恢复，Markdown 视图已落盘
    const h2 = makeHarness({ fs: h.fs })
    expect(h2.svc.load().recovered).toBe(true)
    const snap2 = h2.api.getBoard()
    expect(snap2.requirements).toHaveLength(1)
    expect(snap2.tasks).toHaveLength(5)
    expect(snap2.tasks.find(t => t.taskId === '123@WN_HIS#analyze')!.state).toBe('completed')
    expect(snap2.tasks.find(t => t.taskId === '123@WN_HIS#plan')!.state).toBe('completed')
    expect(snap2.tasks.find(t => t.taskId === '123@WN_HIS#impl')!.state).toBe('in_progress')
    const md = h2.svc.readMarkdown()
    expect(md).toContain('请勿手改')
    expect(md).toContain('需求 123')

    // 悬空对账（T060/S-10）：impl 重启前处于 running → 标失败待人工核对
    const rec = h2.svc.reconcile()
    expect(rec.dangling).toEqual(['123@WN_HIS#impl'])
    expect(h2.api.getBoard().tasks.find(t => t.taskId === '123@WN_HIS#impl')!.execState).toBe('failed')

    // 清场：释放 dispatcher 持有的并发槽，避免悬挂 promise
    h.subagents.runs.forEach(r => r.resolve())
  })

  it('派发到不存在/不可启动的看板任务 → 拒绝且不启动子 agent', async () => {
    const h = makeHarness()
    await h.api.claimRequirement({ id: 500 })
    await h.api.decomposeRequirement('500@WN_HIS')
    // impl 的上游（analyze/plan）未完成 → 不可启动
    const blocked = await h.api.dispatch({
      draft: {
        roleName: DEFAULT_ROLES[0]!.name,
        prompt: 'x',
        frozenConfig: { mcp: [], skills: [], model: '' },
        permission: 'read-only',
        },
      targetWorkItem: '500@WN_HIS',
      collection: 'WN_HIS',
      taskId: '500@WN_HIS#impl',
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.reason).toContain('依赖未就绪')

    // 完全不存在的看板任务
    const missing = await h.api.dispatch({
      draft: {
        roleName: DEFAULT_ROLES[0]!.name,
        prompt: 'x',
        frozenConfig: { mcp: [], skills: [], model: '' },
        permission: 'read-only',
        },
      targetWorkItem: '500@WN_HIS',
      collection: 'WN_HIS',
      taskId: '500@WN_HIS#nope',
    })
    expect(missing.ok).toBe(false)
    expect(missing.reason).toContain('看板任务不可启动')

    // 两次都被拒 → 一个子 agent 都没起
    expect(h.subagents.starts).toHaveLength(0)
  })

  it('写失败原因经凭据擦除（T033：报错回显的 token 不外泄）', async () => {
    const h = makeHarness({
      failOn: 'tfs_add_comment',
      failMessage: 'Failed request: http://tfs/tfs/WN_HIS/_apis/wit/workItems/200?token=SECRET-PAT-0123456789',
    })
    await h.api.claimRequirement({ id: 200 })
    const r = await h.api.confirmWrite({
      ops: [{ opType: 'comment', before: null, after: 'hello' }],
      targetWorkItem: '200@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(false)
    const reason = r.reason ?? ''
    expect(reason).toContain('profile=tfs-mcp')
    expect(reason).not.toContain('SECRET-PAT-0123456789')
    expect(reason).toContain('[REDACTED]')
  })

  it('标签写失败不阻断领取（FR-014），且失败原因可见', async () => {
    const h = makeHarness({ failOn: 'tfs_add_tags', failMessage: 'Failed request: (414)' })
    const r = await h.api.claimRequirement({ id: 300 })
    expect(r.ok).toBe(true)
    expect(r.added).toBe(true)
    expect(r.tag?.ok).toBe(false)
    expect(r.tag?.reason).toContain('414')
    // 条目仍在池中，且带 dsh 标签的本地副本**未**被误写（写入失败不同步）
    const snap = h.api.getBoard()
    expect(snap.requirements).toHaveLength(1)
    expect(snap.requirements[0]!.tags).not.toContain('dsh')
  })

  it('非法目标不发写调用（防 id:NaN 打到 TFS）', async () => {
    const h = makeHarness()
    const r = await h.api.confirmWrite({
      ops: [{ opType: 'tag', before: [], after: ['dsh'] }],
      targetWorkItem: '—',
      collection: 'WN_HIS',
    })
    expect(r.ok).toBe(false)
    // 门禁在 adapter 之前拦住 ⇒ 一个请求都不该发（含只读探测）。
    expect(h.rest.calls.filter(c => c.method !== 'GET')).toHaveLength(0)
  })

  it('审计与写调用一一对齐且不含凭据（SC-008）', async () => {
    const h = makeHarness()
    await h.api.claimRequirement({ id: 400 })
    await h.api.confirmWrite({
      ops: [{ opType: 'tag', before: [], after: ['dsh', '紧急'] }],
      targetWorkItem: '400@WN_HIS',
      collection: 'WN_HIS',
    })
    const entries = h.audit.replay()
    expect(entries.length).toBeGreaterThanOrEqual(2)
    const serialized = JSON.stringify(entries)
    expect(serialized).not.toMatch(/token=|authorization|pat=/i)
    // 每条写审计都带幂等键，与写调用对齐
    for (const e of entries.filter(x => x.kind === 'write')) {
      expect(typeof e.idempotencyKey).toBe('string')
      expect(e.confirmed).toBe(true)
    }
    // 写请求数与审计写条目数一一对齐（审计不丢、不多记）。
    const patchCalls = h.rest.calls.filter(c => c.method === 'PATCH')
    expect(patchCalls.length).toBe(entries.filter(x => x.kind === 'write').length)
  })
})

import { describe, expect, it } from 'vitest'
import { Board } from '../src/core/board/board.js'
import { BoardService, summaryToRequirement, requirementToSummary } from '../src/host/board-service.js'
import { renderBoardMarkdown } from '../src/persistence/markdown.js'
import type { BoardState } from '../src/core/board/board.js'
import type { BoardTfsPort } from '../src/host/board-service.js'
import type { RequirementSummary, RoleDefinition } from '../src/shared/contracts.js'
import { DECOMPOSE_STAGES } from '../src/orchestration/role-match.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

/**
 * 看板服务单测（T036/T038/T041/T043/T045/T046/T048/T059/T060/T061/T062）。
 *
 * 覆盖本轮新接线的整条链路：领取（去重 S-01 + 打标签 T048 幂等 S-08）、拆解（DAG）、
 * 指派、状态机（四态 + 乐观锁 S-11）、崩溃对账（S-10）、JSON 权威落盘与 Markdown 渲染（T061）、
 * 解析失败保留原文件（FR-020/T062）。
 *
 * 全程使用内存 fs 与桩 adapter，不触碰真实磁盘与 TFS。
 */

/**
 * 角色桩初始集（spec 008 前的历史形状：只有架构师/开发，没有测试工程师与通用工程师）。
 * 每个 service 实例拿的是**独立深拷贝**（见 makeRolesRepo），自动创建角色不会在用例间串。
 */
const SEED_ROLES: RoleDefinition[] = [
  { id: 'r1', name: '架构师', provider: 'spawn', defaultModel: 'm1', defaultMcp: ['tfs-mcp'], defaultSkills: [] },
  { id: 'r2', name: '开发', provider: 'spawn', defaultModel: 'm2' },
]

/** 内存角色仓桩：默认带 save（模拟生产 RoleStore），可关闭/置错以测降级回落。 */
type RolesRepo = ReturnType<typeof makeRolesRepo>

function makeRolesRepo(opts: { initial?: RoleDefinition[]; withSave?: boolean } = {}) {
  const roles = [...(opts.initial ?? SEED_ROLES).map(r => ({ ...r }))]
  const created: RoleDefinition[] = []
  let saveThrows = false
  const repo = {
    list: (): RoleDefinition[] => roles,
    getByName: (n: string): RoleDefinition | undefined => roles.find(r => r.name === n),
    setSaveThrows: (v: boolean): void => {
      saveThrows = v
    },
    created: (): RoleDefinition[] => created,
    save: undefined as ((role: RoleDefinition) => void) | undefined,
  }
  if (opts.withSave !== false) {
    repo.save = (role: RoleDefinition): void => {
      if (saveThrows) throw new Error('roles.json 只读')
      const idx = roles.findIndex(r => r.id === role.id)
      if (idx >= 0) roles[idx] = role
      else {
        roles.push(role)
        created.push(role)
      }
    }
  }
  return repo
}

/** 记录写调用的桩 adapter。 */
function makeAdapter(cfg: {
  getRequirement?: (id: number, collection?: string) => Promise<RequirementSummary>
  tagResult?: { ok: boolean; reason?: string }
} = {}): BoardTfsPort & { tagCalls: Array<{ id: number; tags: string; collection?: string; confirmed: boolean }> } {
  const tagCalls: Array<{ id: number; tags: string; collection?: string; confirmed: boolean }> = []
  return {
    tagCalls,
    async getRequirement(id, collection) {
      if (cfg.getRequirement) return cfg.getRequirement(id, collection)
      return summary(id, collection ?? 'WN_HIS')
    },
    async addTags(workItemId, collection, tags, _before, confirmed) {
      tagCalls.push({ id: Number(workItemId), tags: tags.join(';'), collection, confirmed })
      return cfg.tagResult ?? { ok: true }
    },
  }
}

function summary(id: number, collection = 'WN_HIS', over: Partial<RequirementSummary> = {}): RequirementSummary {
  return {
    id,
    collection,
    project: 'PEIS',
    title: `需求 ${id}`,
    type: '产品需求',
    state: 'Active',
    assignedTo: 'zhangbo3',
    priority: '2',
    areaPath: 'PEIS',
    iterationPath: 'Sprint 1',
    tags: [],
    changedDate: '2026-09-17T00:00:00Z',
    url: `http://tfs/wit/workItems/${id}`,
    ...over,
  }
}

function makeService(opts: {
  fs?: MemFs
  adapter?: BoardTfsPort & { tagCalls: Array<{ id: number; tags: string; collection?: string; confirmed: boolean }> }
  board?: Board
  baseDir?: string
  defaultLabel?: string
  runtime?: () => { running: number; queued: number }
  /** spec 008：自定义角色初始集（默认历史两角色）。 */
  roles?: RoleDefinition[]
  /** spec 008：角色端口是否提供 save（默认 true，模拟生产 RoleStore）。 */
  rolesWithSave?: boolean
  /** spec 008：注入已构造的角色仓（需要在构造后操控 save 抛错时用）。 */
  rolesRepo?: RolesRepo
} = {}): {
  svc: BoardService
  fs: MemFs
  adapter: ReturnType<typeof makeAdapter>
  rolesRepo: RolesRepo
} {
  const fs = opts.fs ?? createMemFs()
  const adapter = opts.adapter ?? makeAdapter()
  const rolesRepo =
    opts.rolesRepo ?? makeRolesRepo({ initial: opts.roles, ...(opts.rolesWithSave === undefined ? {} : { withSave: opts.rolesWithSave }) })
  const svc = new BoardService({
    baseDir: opts.baseDir ?? 'C:/data',
    fs,
    board: opts.board ?? new Board(),
    adapter,
    roles: rolesRepo,
    defaultLabel: opts.defaultLabel ?? 'dsh',
    ...(opts.runtime ? { getRuntimeCounts: opts.runtime } : {}),
  })
  return { svc, fs, adapter, rolesRepo }
}

/**
 * 给 MemFs 补一个可控 `statSync`。
 *
 * **为什么需要**：纯 `createMemFs()` 没有 `statSync`，`claimRequirement` 会**跳过**存在性校验
 * （见 `src/host/board-service.ts` 的 `typeof this.fs.statSync === 'function'` 守卫）。
 * 要覆盖"路径不存在 / 不是目录"两条分支，必须注入一个能返回可控结果的 `statSync`。
 *
 * @param map - 规范化路径（`/` 分隔）→ 类型。
 */
function fsWithStat(map: Record<string, 'dir' | 'file' | 'missing'>): MemFs {
  const fs = createMemFs()
  ;(fs as MemFs & { statSync: (p: string) => { isDirectory(): boolean } | undefined }).statSync = (p: string) => {
    const kind = map[String(p).replace(/\\/g, '/')]
    if (kind === undefined || kind === 'missing') return undefined
    return { isDirectory: () => kind === 'dir' }
  }
  return fs
}

/** 直接读权威 JSON 文件内容（用于断言落盘形态）。 */
function readBoardJson(fs: MemFs): { version: number; tasks: Record<string, unknown>; requirements: Record<string, unknown> } {
  const key = Object.keys(fs.dump()).find(k => k.endsWith('board.json'))
  expect(key, 'board.json 应已落盘').toBeTruthy()
  return JSON.parse(fs.dump()[key!]!)
}

describe('类型转换（领域 ⇄ 客户端）', () => {
  it('summaryToRequirement 保留实测归一化字段', () => {
    const r = summaryToRequirement(summary(7))
    expect(r.workItemId).toBe(7)
    expect(r.collection).toBe('WN_HIS')
    expect(r.iteration).toBe('Sprint 1')
    expect(r.type).toBe('产品需求')
    expect(r.updatedAt).toBe('2026-09-17T00:00:00Z')
  })

  it('requirementToSummary 往返保持关键字段（iterationPath ⇄ iteration）', () => {
    const s = requirementToSummary(summaryToRequirement(summary(9, 'WN_TJ')))
    expect(s.id).toBe(9)
    expect(s.collection).toBe('WN_TJ')
    expect(s.iterationPath).toBe('Sprint 1')
    expect(s.url).toContain('workItems/9')
  })

  // US3 / FR-009：正文必须能穿过 board.json 往返，否则服务重启后"选为目标"又带不出内容。
  it('正文经 summary → requirement → summary 往返不丢', () => {
    const s = requirementToSummary(summaryToRequirement(summary(11, 'WN_HIS', { description: '急诊改造正文' })))
    expect(s.description).toBe('急诊改造正文')
  })

  it('无正文时不写 description 键（保持与历史 board.json 相同的反序列化形状）', () => {
    const r = summaryToRequirement(summary(12))
    expect('description' in r).toBe(false)
    expect('description' in requirementToSummary(r)).toBe(false)
  })
})

describe('load / FR-020 解析失败不静默重建', () => {
  it('首次启动（无文件）→ ok 且 recovered=false', () => {
    const { svc } = makeService()
    expect(svc.load()).toEqual({ ok: true, recovered: false })
  })

  it('存在合法 board.json → 恢复成功', () => {
    const fs = createMemFs()
    const { svc: seed } = makeService({ fs })
    seed.board.claimRequirement(summaryToRequirement(summary(1)))
    seed.renderMarkdown() // 触发落盘
    const { svc } = makeService({ fs })
    const r = svc.load()
    expect(r.ok).toBe(true)
    expect(r.recovered).toBe(true)
    expect(Object.keys(svc.board.snapshot.requirements)).toHaveLength(1)
  })

  it('board.json 损坏 → ok:false 且**原文件未被改动**（FR-020/T062）', () => {
    const fs = createMemFs()
    fs.writeFileSync('C:/data/board.json', '{ 这不是 JSON')
    const { svc } = makeService({ fs })
    const r = svc.load()
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('解析失败')
    // 关键断言：原文件原样保留，没有被"重建"覆盖
    const key = Object.keys(fs.dump()).find(k => k.endsWith('board.json'))!
    expect(fs.dump()[key]).toBe('{ 这不是 JSON')
  })
})

describe('claimRequirement（T036 去重 S-01 + T048 打标签 S-08）', () => {
  it('首次领取 → added=true，并打 dsh 标签（分号拼接字符串、id 为 number）', async () => {
    const { svc, adapter } = makeService()
    const r = await svc.claimRequirement({ requirement: summary(101) })
    expect(r.ok).toBe(true)
    expect(r.added).toBe(true)
    expect(r.tag?.ok).toBe(true)
    expect(adapter.tagCalls).toHaveLength(1)
    expect(adapter.tagCalls[0]!.id).toBe(101)
    expect(adapter.tagCalls[0]!.tags).toBe('dsh')
    expect(adapter.tagCalls[0]!.confirmed).toBe(true)
  })

  it('重复领取同一需求 → added=false（幂等，S-01）', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(101) })
    const again = await svc.claimRequirement({ requirement: summary(101) })
    expect(again.ok).toBe(true)
    expect(again.added).toBe(false)
    expect(Object.keys(svc.board.snapshot.requirements)).toHaveLength(1)
  })

  it('不同集合的同一 id 视为不同需求（去重键含集合 S-01）', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(101, 'WN_HIS') })
    const other = await svc.claimRequirement({ requirement: summary(101, 'WN_TJ') })
    expect(other.added).toBe(true)
    expect(Object.keys(svc.board.snapshot.requirements).sort()).toEqual(['101@WN_HIS', '101@WN_TJ'])
  })

  it('已带 dsh 标签 → 跳过写调用（不重复打标签 S-08）', async () => {
    const { svc, adapter } = makeService()
    const r = await svc.claimRequirement({ requirement: summary(102, 'WN_HIS', { tags: ['dsh', '前端'] }) })
    expect(r.tag?.ok).toBe(true)
    expect(adapter.tagCalls).toHaveLength(0)
  })

  it('标签大小写/空白归一后视为已存在（normalizeLabel）', async () => {
    const { svc, adapter } = makeService()
    await svc.claimRequirement({ requirement: summary(103, 'WN_HIS', { tags: ['  DSH '] }) })
    expect(adapter.tagCalls).toHaveLength(0)
  })

  it('打标签失败 → 领取仍成功（FR-014 保留条目），并回传失败原因', async () => {
    const adapter = makeAdapter({ tagResult: { ok: false, reason: 'tfs-mcp 调用失败' } })
    const { svc } = makeService({ adapter })
    const r = await svc.claimRequirement({ requirement: summary(104) })
    expect(r.ok).toBe(true)
    expect(r.added).toBe(true)
    expect(r.tag).toEqual({ ok: false, reason: 'tfs-mcp 调用失败' })
    expect(Object.keys(svc.board.snapshot.requirements)).toContain('104@WN_HIS')
  })

  it('按 id 领取：宿主经 tfs_get_workitem 补全', async () => {
    const { svc, adapter } = makeService()
    const r = await svc.claimRequirement({ id: 105, collection: 'WN_HIS' })
    expect(r.ok).toBe(true)
    expect(r.requirement?.title).toBe('需求 105')
    expect(adapter.tagCalls).toHaveLength(1)
  })

  it('按 id 领取：非法 id → ok:false（不发任何写调用）', async () => {
    const { svc, adapter } = makeService()
    for (const bad of [0, -1, 1.5]) {
      const r = await svc.claimRequirement({ id: bad })
      expect(r.ok).toBe(false)
    }
    expect(adapter.tagCalls).toHaveLength(0)
  })

  it('按 id 领取：读路径报错 → ok:false 且原因可读', async () => {
    const adapter = makeAdapter({
      getRequirement: async () => {
        throw new Error('Failed request: (414)')
      },
    })
    const { svc } = makeService({ adapter })
    const r = await svc.claimRequirement({ id: 106 })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('414')
  })

  it('tag:false 时跳过打标签', async () => {
    const { svc, adapter } = makeService()
    const r = await svc.claimRequirement({ requirement: summary(107), tag: false })
    expect(r.ok).toBe(true)
    expect(r.tag).toBeUndefined()
    expect(adapter.tagCalls).toHaveLength(0)
  })

  it('打标签成功 → 本地副本的 tags 同步（与 TFS 一致）', async () => {
    const { svc } = makeService()
    const r = await svc.claimRequirement({ requirement: summary(108) })
    expect(r.requirement?.tags).toContain('dsh')
    expect(svc.board.snapshot.requirements['108@WN_HIS']!.tags).toContain('dsh')
  })
})

describe('本地代码库路径 workspace（第七轮接线：领取校验 + 入池 + 拆解继承 + 落盘）', () => {
  it('携带合法绝对路径 → 入池，且返回的 requirement 带规范化 workspace', async () => {
    const fs = fsWithStat({ 'D:/体检管理/repo': 'dir' })
    const { svc } = makeService({ fs })
    const r = await svc.claimRequirement({
      requirement: summary(401),
      workspace: '  D:\\体检管理\\repo\\  ',
    })
    expect(r.ok).toBe(true)
    expect(r.added).toBe(true)
    expect(r.requirement?.workspace).toBe('D:\\体检管理\\repo')
    expect(svc.board.snapshot.requirements['401@WN_HIS']!.workspace).toBe('D:\\体检管理\\repo')
  })

  it('相对路径 → 拒收（fail loud），且**未入池**、未发生任何写调用', async () => {
    const { svc, adapter } = makeService({ fs: fsWithStat({}) })
    const r = await svc.claimRequirement({ requirement: summary(402), workspace: 'plugins/repo' })
    expect(r.ok).toBe(false)
    expect(r.added).toBe(false)
    expect(r.reason).toContain('绝对路径')
    expect(Object.keys(svc.board.snapshot.requirements)).toHaveLength(0)
    // 领取失败发生在打标签之前 → 不应触发任何 TFS 写调用。
    expect(adapter.tagCalls).toHaveLength(0)
  })

  it('空串路径 → 拒收（不可为空）', async () => {
    const { svc } = makeService({ fs: fsWithStat({}) })
    const r = await svc.claimRequirement({ requirement: summary(403), workspace: '   ' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不可为空')
  })

  it('statSync 报路径不存在 → 拒收并回显路径', async () => {
    const { svc } = makeService({ fs: fsWithStat({}) }) // 空 map ⇒ 一律 missing
    const r = await svc.claimRequirement({ requirement: summary(404), workspace: 'D:\\不存在\\repo' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不存在')
    expect(r.reason).toContain('D:\\不存在\\repo')
    expect(Object.keys(svc.board.snapshot.requirements)).toHaveLength(0)
  })

  it('statSync 报是文件而非目录 → 拒收（不是目录）', async () => {
    const fs = fsWithStat({ 'D:/repo/file.txt': 'file' })
    const { svc } = makeService({ fs })
    const r = await svc.claimRequirement({ requirement: summary(405), workspace: 'D:\\repo\\file.txt' })
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不是目录')
  })

  it('无 statSync（受限/内存 fs）→ 跳过存在性校验，不误判为失败', async () => {
    const { svc } = makeService() // 纯 createMemFs，无 statSync
    const r = await svc.claimRequirement({ requirement: summary(406), workspace: 'D:\\anywhere\\repo' })
    expect(r.ok).toBe(true)
    expect(r.added).toBe(true)
    expect(r.requirement?.workspace).toBe('D:\\anywhere\\repo')
  })

  it('input.workspace 优先于摘要携带的 workspace（UI 输入覆盖）', async () => {
    const fs = fsWithStat({ 'D:/new': 'dir', 'D:/old': 'dir' })
    const { svc } = makeService({ fs })
    const r = await svc.claimRequirement({
      requirement: summary(407, 'WN_HIS', { workspace: 'D:\\old' }),
      workspace: 'D:\\new',
    })
    expect(r.requirement?.workspace).toBe('D:\\new')
  })

  it('摘要自带 workspace 且未传 input.workspace → 沿用摘要值', async () => {
    const fs = fsWithStat({ 'D:/from-summary': 'dir' })
    const { svc } = makeService({ fs })
    const r = await svc.claimRequirement({ requirement: summary(408, 'WN_HIS', { workspace: 'D:\\from-summary' }) })
    expect(r.ok).toBe(true)
    expect(r.requirement?.workspace).toBe('D:\\from-summary')
  })

  it('拆解出的五段式任务**全部继承**需求 workspace', async () => {
    const fs = fsWithStat({ 'D:/repo': 'dir' })
    const { svc } = makeService({ fs })
    await svc.claimRequirement({ requirement: summary(409), workspace: 'D:\\repo' })
    const r = svc.decompose('409@WN_HIS')
    expect(r.ok).toBe(true)
    for (const id of r.taskIds!) {
      expect(svc.board.snapshot.tasks[id]!.workspace).toBe('D:\\repo')
    }
  })

  it('未接线需求拆解出的任务**不带** workspace 键（不留 `undefined` 形态）', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(410) })
    svc.decompose('410@WN_HIS')
    for (const t of Object.values(svc.board.snapshot.tasks)) {
      expect('workspace' in t).toBe(false)
    }
  })

  it('workspace 随需求落盘到 board.json（不丢字段）', async () => {
    const fs = fsWithStat({ 'D:/repo': 'dir' })
    const { svc } = makeService({ fs })
    await svc.claimRequirement({ requirement: summary(411), workspace: 'D:\\repo' })
    svc.renderMarkdown() // 触发落盘
    const json = readBoardJson(fs)
    expect(json.requirements['411@WN_HIS']).toMatchObject({ workspace: 'D:\\repo' })
  })

  it('看板任务视图（toTaskView）透传 workspace 供 UI 展示', async () => {
    const fs = fsWithStat({ 'D:/repo': 'dir' })
    const { svc } = makeService({ fs })
    await svc.claimRequirement({ requirement: summary(412), workspace: 'D:\\repo' })
    svc.decompose('412@WN_HIS')
    const view = svc.listTasks({ requirementId: '412@WN_HIS' })
    expect(view).toHaveLength(5)
    for (const t of view) expect(t.workspace).toBe('D:\\repo')
  })
})

describe('decompose（T041 拆解 + DAG）', () => {
  it('未领取需求 → ok:false', () => {
    const { svc } = makeService()
    const r = svc.decompose('999@WN_HIS')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('未领取')
  })

  it('已领取 → 五段式任务 + blockedBy 链（analyze → plan → impl → review → verify）', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(201) })
    const r = svc.decompose('201@WN_HIS')
    expect(r.ok).toBe(true)
    expect(r.taskIds).toHaveLength(5)
    const tasks = svc.board.snapshot.tasks
    expect(tasks['201@WN_HIS#analyze']!.blockedBy).toEqual([])
    expect(tasks['201@WN_HIS#plan']!.blockedBy).toEqual(['201@WN_HIS#analyze'])
    expect(tasks['201@WN_HIS#impl']!.blockedBy).toEqual(['201@WN_HIS#plan'])
    expect(tasks['201@WN_HIS#review']!.blockedBy).toEqual(['201@WN_HIS#impl'])
    expect(tasks['201@WN_HIS#verify']!.blockedBy).toEqual(['201@WN_HIS#review'])
    // spec 008 US1：五段任务按名称各归其主。历史角色集只有架构师/开发：
    // plan→架构师、impl→开发；analyze/review/verify 无专门角色 → 经 save 自动创建
    // 内置「需求分析师 / 代码审核工程师 / 测试工程师」（按阶段顺序）。
    expect(tasks['201@WN_HIS#analyze']!.roleAgent).toBe('需求分析师')
    expect(tasks['201@WN_HIS#plan']!.roleAgent).toBe('架构师')
    expect(tasks['201@WN_HIS#plan']!.frozenConfig.mcp).toEqual(['tfs-mcp'])
    expect(tasks['201@WN_HIS#impl']!.roleAgent).toBe('开发')
    expect(tasks['201@WN_HIS#review']!.roleAgent).toBe('代码审核工程师')
    expect(tasks['201@WN_HIS#verify']!.roleAgent).toBe('测试工程师')
    expect(r.createdRoles).toEqual(['需求分析师', '代码审核工程师', '测试工程师'])
    expect(r.reason).toContain('自动创建角色：需求分析师、代码审核工程师、测试工程师')
  })

  it('重复拆解 → 跳过已存在任务（幂等，不报错、不重置）', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(202) })
    svc.decompose('202@WN_HIS')
    // 先推进一个任务，验证重复拆解不会把它重置回 pending
    svc.setTaskState('202@WN_HIS#analyze', 'start')
    svc.setTaskState('202@WN_HIS#analyze', 'complete')
    const again = svc.decompose('202@WN_HIS')
    expect(again.ok).toBe(true)
    expect(again.taskIds).toHaveLength(5)
    expect(svc.board.snapshot.tasks['202@WN_HIS#analyze']!.state).toBe('completed')
    expect(Object.keys(svc.board.snapshot.tasks)).toHaveLength(5)
  })
})

describe('assignTask（T042 + S-13）', () => {
  it('未知角色 → ok:false', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(301) })
    svc.decompose('301@WN_HIS')
    const r = svc.assignTask('301@WN_HIS#impl', '不存在的角色')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不存在')
  })

  it('未知任务 → ok:false', () => {
    const { svc } = makeService()
    expect(svc.assignTask('nope', '架构师').ok).toBe(false)
  })

  it('合法改派 → roleAgent 更新且 revision 递增', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(302) })
    svc.decompose('302@WN_HIS')
    // 注意：Board.snapshot 返回的是**活引用**（见 board.ts 的注释），持引用跨变更会读到新值，
    // 故这里先把 revision 取成数字快照再变更。
    const before = svc.board.snapshot.tasks['302@WN_HIS#impl']!.revision
    const r = svc.assignTask('302@WN_HIS#impl', '开发')
    expect(r.ok).toBe(true)
    expect(r.task?.roleAgent).toBe('开发')
    expect(r.task!.revision).toBe(before + 1)
  })
})

describe('setTaskState（T043 状态机 + S-11 乐观锁 + S-07 断点重试）', () => {
  async function seeded(): Promise<ReturnType<typeof makeService>> {
    const ctx = makeService()
    await ctx.svc.claimRequirement({ requirement: summary(401) })
    ctx.svc.decompose('401@WN_HIS')
    return ctx
  }

  it('start：pending → in_progress/running，并追加一次尝试', async () => {
    const { svc } = await seeded()
    const r = svc.setTaskState('401@WN_HIS#analyze', 'start')
    expect(r.ok).toBe(true)
    expect(r.task?.state).toBe('in_progress')
    expect(r.task?.execState).toBe('running')
    expect(r.task?.attemptCount).toBe(1)
  })

  it('依赖未就绪的任务不可启动（DAG 约束）', async () => {
    const { svc } = await seeded()
    const r = svc.setTaskState('401@WN_HIS#impl', 'start')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('依赖未就绪')
  })

  it('complete：in_progress → completed/success；依赖沿 DAG 逐段解锁（analyze→plan→impl）', async () => {
    const { svc } = await seeded()
    svc.setTaskState('401@WN_HIS#analyze', 'start')
    const done = svc.setTaskState('401@WN_HIS#analyze', 'complete')
    expect(done.task?.state).toBe('completed')
    expect(done.task?.execState).toBe('success')
    // analyze 完成后只解锁 plan；impl 仍被 plan 阻塞。
    expect(svc.setTaskState('401@WN_HIS#impl', 'start').ok).toBe(false)
    svc.setTaskState('401@WN_HIS#plan', 'start')
    svc.setTaskState('401@WN_HIS#plan', 'complete')
    // plan 完成后 impl 才可启动。
    const impl = svc.setTaskState('401@WN_HIS#impl', 'start')
    expect(impl.ok).toBe(true)
  })

  it('fail：保留 in_progress（可重试 S-07），execState=failed', async () => {
    const { svc } = await seeded()
    svc.setTaskState('401@WN_HIS#analyze', 'start')
    const r = svc.setTaskState('401@WN_HIS#analyze', 'fail')
    expect(r.task?.state).toBe('in_progress')
    expect(r.task?.execState).toBe('failed')
  })

  it('retry：失败后重跑 → running 且尝试次数累加（断点重试 S-07）', async () => {
    const { svc } = await seeded()
    svc.setTaskState('401@WN_HIS#analyze', 'start')
    svc.setTaskState('401@WN_HIS#analyze', 'fail')
    const r = svc.setTaskState('401@WN_HIS#analyze', 'retry')
    expect(r.ok).toBe(true)
    expect(r.task?.execState).toBe('running')
    expect(r.task?.attemptCount).toBe(2)
  })

  it('cancel：→ deleted/cancelled（FR-014 保留条目，不物理删除）', async () => {
    const { svc } = await seeded()
    const r = svc.setTaskState('401@WN_HIS#analyze', 'cancel')
    expect(r.task?.state).toBe('deleted')
    expect(r.task?.execState).toBe('cancelled')
    expect(Object.keys(svc.board.snapshot.tasks)).toHaveLength(5)
  })

  it('已完成任务不可再启动（终态保护）', async () => {
    const { svc } = await seeded()
    svc.setTaskState('401@WN_HIS#analyze', 'start')
    svc.setTaskState('401@WN_HIS#analyze', 'complete')
    const r = svc.setTaskState('401@WN_HIS#analyze', 'start')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('已完成')
  })

  it('revision 冲突 → ok:false 且提示禁自动覆盖（S-11/FR-017）', async () => {
    const { svc } = await seeded()
    const cur = svc.board.snapshot.tasks['401@WN_HIS#analyze']!.revision
    const r = svc.setTaskState('401@WN_HIS#analyze', 'start', cur + 5)
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('revision 冲突')
    expect(r.reason).toContain('禁自动覆盖')
  })

  it('未知动作 → ok:false', async () => {
    const { svc } = await seeded()
    // 运行时防御：路由层已挡非法 action，服务层再兜一次
    const r = svc.setTaskState('401@WN_HIS#analyze', 'explode' as never)
    expect(r.ok).toBe(false)
  })

  it('未知任务 → ok:false', () => {
    const { svc } = makeService()
    expect(svc.setTaskState('nope', 'start').ok).toBe(false)
  })
})

describe('reconcile（T060/S-10 崩溃对账）', () => {
  it('重启后悬空 running 任务标失败并返回 ID，不自动重跑', async () => {
    const fs = createMemFs()
    const seed = makeService({ fs })
    await seed.svc.claimRequirement({ requirement: summary(501) })
    seed.svc.decompose('501@WN_HIS')
    seed.svc.setTaskState('501@WN_HIS#analyze', 'start')
    // 模拟进程重启：同 fs 重新构造服务并 load
    const next = makeService({ fs })
    expect(next.svc.load().recovered).toBe(true)
    const rec = next.svc.reconcile()
    expect(rec.ok).toBe(true)
    expect(rec.dangling).toEqual(['501@WN_HIS#analyze'])
    const t = next.svc.board.snapshot.tasks['501@WN_HIS#analyze']!
    expect(t.execState).toBe('failed')
    expect(t.state).toBe('in_progress') // 保留可重试，不自动重跑
    expect(t.attempts.at(-1)?.note).toContain('待人工核对')
  })

  it('无悬空任务时为空列表', () => {
    const { svc } = makeService()
    expect(svc.reconcile().dangling).toEqual([])
  })
})

describe('listTasks（T044 筛选）', () => {
  async function seeded(): Promise<ReturnType<typeof makeService>> {
    const ctx = makeService()
    await ctx.svc.claimRequirement({ requirement: summary(601, 'WN_HIS', { title: '登录改造' }) })
    await ctx.svc.claimRequirement({ requirement: summary(602, 'WN_TJ', { title: '报表导出' }) })
    ctx.svc.decompose('601@WN_HIS')
    ctx.svc.decompose('602@WN_TJ')
    return ctx
  }

  it('按需求 / 角色 / 关键字 / 状态筛选', async () => {
    const { svc } = await seeded()
    expect(svc.listTasks()).toHaveLength(10)
    expect(svc.listTasks({ requirementId: '601@WN_HIS' })).toHaveLength(5)
    // spec 008：两个需求各 5 段，角色分布为 需求分析师 2（analyze）/ 架构师 2（plan）/
    // 开发 2（impl）/ 代码审核工程师 2（review）/ 测试工程师 2（verify）；后三类专家角色
    // 在首次拆解自动创建，第二次直接复用，不重复创建。
    expect(svc.listTasks({ roleAgent: '需求分析师' })).toHaveLength(2)
    expect(svc.listTasks({ roleAgent: '架构师' })).toHaveLength(2)
    expect(svc.listTasks({ roleAgent: '开发' })).toHaveLength(2)
    expect(svc.listTasks({ roleAgent: '代码审核工程师' })).toHaveLength(2)
    expect(svc.listTasks({ roleAgent: '测试工程师' })).toHaveLength(2)
    expect(svc.listTasks({ roleAgent: '不存在' })).toHaveLength(0)
    expect(svc.listTasks({ state: 'pending' })).toHaveLength(10)
    expect(svc.listTasks({ keyword: '登录' })).toHaveLength(5)
    expect(svc.listTasks({ keyword: '602' })).toHaveLength(5)
  })
})

describe('持久化与渲染（T061 + 事件 append-only）', () => {
  it('每次变更落盘 board.json 且 version 递增', async () => {
    const { svc, fs } = makeService()
    await svc.claimRequirement({ requirement: summary(701) })
    const v1 = readBoardJson(fs).version
    svc.decompose('701@WN_HIS')
    const v2 = readBoardJson(fs).version
    expect(v2).toBeGreaterThan(v1)
    expect(Object.keys(readBoardJson(fs).tasks)).toHaveLength(5)
  })

  it('Markdown 渲染含「请勿手改」警示且与 JSON 内容一致', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(702) })
    svc.decompose('702@WN_HIS')
    const r = svc.renderMarkdown()
    expect(r.ok).toBe(true)
    const md = svc.readMarkdown()
    expect(md).toBeTruthy()
    expect(md).toContain('请勿手改')
    expect(md).toContain('需求池（1）')
    expect(md).toContain('任务（5）')
    expect(md).toContain('需求 702')
    // 渲染视图与权威 JSON 一致（T061 json→md 一致性）
    expect(svc.board.snapshot.markdownViewPath).toBe(r.path)
  })

  it('事件日志 append-only：只追加、不改写历史行', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(703) })
    const first = svc.replayEvents()
    expect(first.length).toBeGreaterThan(0)
    expect(first[0]).toHaveProperty('ts')
    expect(first.some(e => e['action'] === 'claim')).toBe(true)
    svc.decompose('703@WN_HIS')
    const second = svc.replayEvents()
    expect(second.length).toBeGreaterThan(first.length)
    // 历史前缀未被改写
    expect(second.slice(0, first.length)).toEqual(first)
  })

  it('snapshot 暴露并发器读数（S-06 排队可见）与计数', async () => {
    const { svc } = makeService({ runtime: () => ({ running: 2, queued: 1 }) })
    await svc.claimRequirement({ requirement: summary(704) })
    svc.decompose('704@WN_HIS')
    svc.setTaskState('704@WN_HIS#analyze', 'start')
    svc.setTaskState('704@WN_HIS#analyze', 'complete')
    const snap = svc.snapshot()
    expect(snap.counts).toEqual({ pending: 4, inProgress: 0, completed: 1, running: 2, queued: 1 })
    expect(snap.requirements).toHaveLength(1)
    expect(snap.tasks).toHaveLength(5)
    expect(snap.ok).toBe(true)
  })
})

describe('Markdown 渲染（工作目录列 + 表格转义）', () => {
  async function rendered(opts: { workspace?: string; title?: string } = {}): Promise<string> {
    const fs = fsWithStat({ 'D:/repo': 'dir' })
    const { svc } = makeService({ fs })
    await svc.claimRequirement({
      requirement: summary(801, 'WN_HIS', opts.title ? { title: opts.title } : {}),
      ...(opts.workspace ? { workspace: opts.workspace } : {}),
    })
    svc.decompose('801@WN_HIS')
    return renderBoardMarkdown(svc.board.snapshot as BoardState)
  }

  it('已接线 → 需求池与任务两张表都出现工作目录列与路径', async () => {
    const md = await rendered({ workspace: 'D:\\repo' })
    expect(md).toContain('| 去重键 | 标题 | 状态 | 指派 | 迭代 | 工作目录 |')
    expect(md).toContain('| 任务 | 需求 | 状态 | 执行 | 角色 | 工作目录 | 依赖 |')
    // 需求行 + 五条任务行各含一次路径 ⇒ 至少 6 次
    expect(md.split('D:\\repo').length - 1).toBeGreaterThanOrEqual(6)
  })

  it('未接线 → 工作目录列显示 `-` 占位（不出现 undefined）', async () => {
    const md = await rendered()
    expect(md).not.toContain('undefined')
    expect(md).toContain('| - |')
  })

  it('标题含 `|` / 换行 → 转义，不撑破表格（列数恒定）', async () => {
    const md = await rendered({ workspace: 'D:\\repo', title: '含|竖线 且\n换行' })
    // 转义后的竖线不应作为列分隔符参与计数。
    const reqRow = md.split('\n').find(l => l.startsWith('| 801@WN_HIS'))
    expect(reqRow).toBeTruthy()
    expect(reqRow).toContain('\\|')
    expect(reqRow).not.toContain('\n')
    // 需求行：6 列 ⇒ 7 个未转义竖线（含首尾）。
    expect(reqRow!.match(/(?<!\\)\|/g)).toHaveLength(7)
  })
})

/**
 * 需求级执行状态与手工任务（问题 3/4/5/6）—— **服务层触发时机**。
 *
 * 引擎口径（全完成才迁移、取消完成删字段）在 board.spec.ts 覆盖；
 * 这里锁的是"谁在什么时候调用它"：任务收口/删除后自动判定、拆解时退回进行中、
 * 还原门禁的对外原因、以及"执行配置发起执行"登记看板任务。
 */
describe('需求级执行状态与手工任务（问题 3/4/5/6）', () => {
  /** 领取 + 拆解 + 按 DAG 依赖顺序全部跑完（analyze → plan → impl → review → verify）。 */
  async function completeAll(svc: BoardService, id = 101): Promise<string> {
    const key = `${id}@WN_HIS`
    const claimed = await svc.claimRequirement({ requirement: summary(id) })
    expect(claimed.ok).toBe(true)
    svc.decompose(key)
    const all = new Set(
      svc
        .snapshot()
        .tasks.filter(t => t.requirementId === key)
        .map(t => t.taskId),
    )
    // 必须按五段 DAG 顺序推进（字典序会让 #impl 跑到 #plan 前面而被"依赖未就绪"挡住）；
    // 阶段任务之外若还有手工任务，排在最后。
    const ordered = [
      ...DECOMPOSE_STAGES.map(s => `${key}#${s}`),
      ...[...all].filter(taskId => !DECOMPOSE_STAGES.some(s => taskId === `${key}#${s}`)),
    ].filter(taskId => all.has(taskId))
    for (const taskId of ordered) {
      const t = svc.board.snapshot.tasks[taskId]!
      svc.setTaskState(taskId, 'start', t.revision)
      svc.settleTask(taskId, 'success', { stopReason: 'completed' })
    }
    return key
  }

  it('全部任务收口后需求自动迁入已完成（问题 3）', async () => {
    const { svc } = makeService()
    const key = await completeAll(svc)
    const req = svc.snapshot().requirements.find(r => `${r.id}@${r.collection}` === key)
    expect(req?.execState).toBe('completed')
    expect(req?.completedAt).toBeTruthy()
    // 需求行执行状态也随之变为"已完成"（UI 两页分桶依赖它）。
    expect(svc.board.requirementExecState(key)).toBe('completed')
  })

  it('仍有任务未完成时保持进行中', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(102) })
    svc.decompose('102@WN_HIS')
    const first = svc.snapshot().tasks.filter(t => t.requirementId === '102@WN_HIS').map(t => t.taskId).sort()[0]!
    const t = svc.board.snapshot.tasks[first]!
    svc.setTaskState(first, 'start', t.revision)
    svc.settleTask(first, 'success', { stopReason: 'completed' })
    expect(svc.board.requirementExecState('102@WN_HIS')).toBe('active')
  })

  it('删除已取消任务后可能触发自动完成（问题 3：删除路径也要判定）', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(103) })
    svc.decompose('103@WN_HIS')
    const ids = svc.snapshot().tasks.filter(t => t.requirementId === '103@WN_HIS').map(t => t.taskId).sort()
    // 第一个（analyze）成功，其余四个取消 ⇒ 已满足"全部收口且至少一个完成"
    const [a, ...rest] = ids as [string, ...string[]]
    const t0 = svc.board.snapshot.tasks[a]!
    svc.setTaskState(a, 'start', t0.revision)
    svc.settleTask(a, 'success', { stopReason: 'completed' })
    for (const id of rest) {
      // 被 DAG 阻塞的待办也可直接取消（cancel 不要求依赖就绪）。
      svc.setTaskState(id, 'cancel', svc.board.snapshot.tasks[id]!.revision)
    }
    expect(svc.board.requirementExecState('103@WN_HIS')).toBe('completed')
    // 删掉四条已取消任务后仍是已完成（幂等，不来回跳页）
    const del = svc.deleteTasks(rest)
    expect(del.ok).toBe(true)
    expect(del.count).toBe(4)
    expect(svc.board.requirementExecState('103@WN_HIS')).toBe('completed')
  })

  it('取消完成把需求退回进行中（问题 5）', async () => {
    const { svc } = makeService()
    const key = await completeAll(svc, 104)
    const r = svc.setRequirementExecState(key, 'active')
    expect(r.ok).toBe(true)
    expect(r.requirement?.execState).toBe('active')
    expect(svc.board.requirementExecState(key)).toBe('active')
  })

  it('已完成需求还原被拒，原因指明先取消完成（问题 5）', async () => {
    const { svc } = makeService()
    const key = await completeAll(svc, 105)
    const res = await svc.restoreRequirement(key)
    expect(res.ok).toBe(false)
    expect(res.reason).toContain('取消完成')
    // 取消完成后仍然拒绝（任务都还在），但原因换成"先取消任务" —— 门禁各司其职、原因可执行。
    svc.setRequirementExecState(key, 'active')
    const res2 = await svc.restoreRequirement(key)
    expect(res2.ok).toBe(false)
    expect(res2.reason).toContain('取消')
  })

  it('对未领取需求设置执行状态返回可读原因', () => {
    const { svc } = makeService()
    const r = svc.setRequirementExecState('999@WN_HIS', 'completed')
    expect(r.ok).toBe(false)
    expect(r.reason).toContain('不在本地池')
  })

  it('重新拆解会把已完成需求退回进行中（问题 3 的逆向路径）', async () => {
    const { svc } = makeService()
    const key = await completeAll(svc, 106)
    // 先取消全部任务，再重新拆解 ⇒ 原地重建为全新 pending（问题 9 语义），需求回到进行中。
    for (const t of svc.snapshot().tasks.filter(x => x.requirementId === key)) {
      svc.setTaskState(t.taskId, 'cancel', svc.board.snapshot.tasks[t.taskId]!.revision)
    }
    const d = svc.decompose(key)
    expect(d.ok).toBe(true)
    expect(d.created).toBe(5)
    expect(svc.board.requirementExecState(key)).toBe('active')
  })

  it('enrich 不覆盖本地执行状态（问题 3）', async () => {
    const { svc } = makeService()
    await svc.claimRequirement({ requirement: summary(107) })
    svc.setRequirementExecState('107@WN_HIS', 'completed')
    const r = await svc.enrichRequirement('107@WN_HIS')
    expect(r.ok).toBe(true)
    expect(r.requirement?.execState).toBe('completed')
  })

  it('createManualTask：未领取 → 可读原因；已领取 → 落到看板（问题 6）', async () => {
    const { svc } = makeService()
    const miss = svc.createManualTask({
      requirementKey: '999@WN_HIS',
      title: '手工执行',
      roleAgent: '架构师',
      frozenConfig: { mcp: [], skills: [], model: 'm1' },
    })
    expect(miss.ok).toBe(false)
    expect(miss.reason).toContain('未领取')

    await svc.claimRequirement({ requirement: summary(108) })
    const created = svc.createManualTask({
      requirementKey: '108@WN_HIS',
      title: '手工执行 A',
      description: '来自执行配置页',
      prompt: '执行提示词',
      roleAgent: '架构师',
      frozenConfig: { mcp: ['mcp-x'], skills: ['sk'], model: 'deepseek-v4-flash', modelProvider: 'arkcode' },
      workspace: 'D:\\repo',
    })
    expect(created.ok).toBe(true)
    expect(created.taskId).toMatch(/^108@WN_HIS#manual-/)
    const task = svc.snapshot().tasks.find(t => t.taskId === created.taskId)
    expect(task?.title).toBe('手工执行 A')
    expect(task?.workspace).toBe('D:\\repo')
    expect(task?.prompt).toBe('执行提示词')
    // spec 009：手工任务（执行配置页派发）的模型供应商随冻结配置原样落盘。
    expect(task?.frozenConfig.model).toBe('deepseek-v4-flash')
    expect(task?.frozenConfig.modelProvider).toBe('arkcode')
    // 同一秒内两次手工派发不应撞 id（时间戳精确到秒，测试里用不同需求键区分）。
    const second = svc.createManualTask({
      requirementKey: '108@WN_HIS',
      title: '手工执行 B',
      roleAgent: '架构师',
      frozenConfig: { mcp: [], skills: [], model: 'm1' },
      now: new Date(Date.now() + 1000),
    })
    expect(second.ok).toBe(true)
    expect(second.taskId).not.toBe(created.taskId)
  })

  /**
   * 问题 3 的实机补修（2026-09-21）：升级前就已把任务全部做完的需求，`execState` 缺键，
   * 从未有任何触发点去判定它 ⇒ 一直留在「任务中心」不进「已完成」页（实机：1997179）。
   * 这里锁住"加载 + 对账"链路：历史数据在**插件启动时**被一次性补齐并落盘。
   */
  it('加载历史 board.json：reconcile 补齐已完成需求并落盘（1997179 实机场景）', () => {
    const fs = createMemFs()
    const key = '1997179@WN_HIS'
    const legacyTask = (stage: string): Record<string, unknown> => ({
      taskId: `${key}#${stage}`,
      requirementId: key,
      idempotencyKey: `${key}#${stage}:dsh`,
      title: stage,
      description: '',
      roleAgent: 'general',
      frozenConfig: { mcp: [], skills: [], model: '' },
      state: 'completed',
      execState: 'success',
      blockedBy: [],
      revision: 1,
      attempts: [],
      artifactPaths: [],
    })
    const legacy = {
      version: 7,
      updatedAt: '2026-09-21T04:05:00.000Z',
      requirements: {
        [key]: {
          workItemId: 1997179,
          collection: 'WN_HIS',
          project: 'PEIS',
          title: '历史已完成需求',
          state: 'Active',
          assignedTo: 'zhangbo3',
          priority: '2',
          iteration: 'Sprint1',
          tags: [],
          createdAt: '2026-09-19T00:00:00Z',
          updatedAt: '2026-09-21T04:05:00Z',
          revision: 1,
          // 注意：没有 execState / completedAt —— 这正是"升级前数据"的形状。
        },
      },
      tasks: Object.fromEntries(
        ['analyze', 'impl', 'verify'].map(s => [`${key}#${s}`, legacyTask(s)]),
      ),
    }
    fs.writeFileSync('C:/data/board.json', JSON.stringify(legacy), 'utf8')

    const { svc, fs: memFs } = makeService({ fs })
    expect(svc.load().ok).toBe(true)
    // 需求此前从未被判定 ⇒ 读作 active，且 reconcile 把它补齐。
    expect(svc.board.requirementExecState(key)).toBe('active')
    const rec = svc.reconcile()
    expect(rec.migratedRequirements).toEqual([key])
    // 补齐结果已**落盘**（写回 board.json）⇒ UI 下一次轮询即可见，重启也不会丢。
    const written = JSON.parse(memFs.readFileSync('C:/data/board.json', 'utf8')) as {
      requirements: Record<string, { execState?: string; completedAt?: string }>
    }
    expect(written.requirements[key]?.execState).toBe('completed')
    expect(written.requirements[key]?.completedAt).toBeTruthy()
    // 再跑一次对账：幂等（无变更），不再重复迁移。
    expect(svc.reconcile().migratedRequirements).toEqual([])
  })

  it('用户显式取消完成过的需求（execState=active）在重启对账时不被标回已完成', () => {
    const fs = createMemFs()
    const key = '1997179@WN_HIS'
    const legacyTask = (stage: string): Record<string, unknown> => ({
      taskId: `${key}#${stage}`,
      requirementId: key,
      idempotencyKey: `${key}#${stage}:dsh`,
      title: stage,
      description: '',
      roleAgent: 'general',
      frozenConfig: { mcp: [], skills: [], model: '' },
      state: 'completed',
      execState: 'success',
      blockedBy: [],
      revision: 1,
      attempts: [],
      artifactPaths: [],
    })
    const legacy = {
      version: 8,
      updatedAt: '2026-09-21T05:00:00.000Z',
      requirements: {
        [key]: {
          workItemId: 1997179,
          collection: 'WN_HIS',
          project: 'PEIS',
          title: '被显式取消完成的需求',
          state: 'Active',
          assignedTo: 'zhangbo3',
          priority: '2',
          iteration: 'Sprint1',
          tags: [],
          createdAt: '2026-09-19T00:00:00Z',
          updatedAt: '2026-09-21T05:00:00Z',
          revision: 1,
          // 人点过「取消完成」：显式 active（不是缺键）。
          execState: 'active',
        },
      },
      tasks: Object.fromEntries(
        ['analyze', 'impl', 'verify'].map(s => [`${key}#${s}`, legacyTask(s)]),
      ),
    }
    fs.writeFileSync('C:/data/board.json', JSON.stringify(legacy), 'utf8')
    const { svc } = makeService({ fs })
    expect(svc.load().ok).toBe(true)
    // 显式 active 是"人声明还没完"：对账不得改写（否则取消完成形同虚设）。
    expect(svc.reconcile().migratedRequirements).toEqual([])
    expect(svc.board.requirementExecState(key)).toBe('active')
  })
})

// ───────────────────────── spec 008 US1~US3：拆解角色匹配 / 通用兜底 / 自动创建 ─────────────────────────

describe('spec 008：拆解阶段角色解析（五级回落链）', () => {
  function customRole(id: string, name: string, extra: Partial<RoleDefinition> = {}): RoleDefinition {
    return { id, name, provider: 'spawn', defaultModel: 'm', defaultSkills: [], ...extra }
  }

  it('US1：analyze/plan/impl/review/verify 按角色名各归其主（不再全部挂第一个角色）', async () => {
    const roles = [
      customRole('q', '测试工程师'),
      customRole('a', '架构师'),
      customRole('c', '开发工程师'),
      customRole('an', '需求分析师'),
      customRole('rv', '代码审核工程师'),
    ]
    const { svc } = makeService({ roles })
    await svc.claimRequirement({ requirement: summary(901) })
    const r = svc.decompose('901@WN_HIS')
    expect(r.ok).toBe(true)
    expect(r.createdRoles).toBeUndefined() // 五角色齐备，无需创建
    const t = svc.board.snapshot.tasks
    expect(t['901@WN_HIS#analyze']!.roleAgent).toBe('需求分析师')
    expect(t['901@WN_HIS#plan']!.roleAgent).toBe('架构师')
    expect(t['901@WN_HIS#impl']!.roleAgent).toBe('开发工程师')
    expect(t['901@WN_HIS#review']!.roleAgent).toBe('代码审核工程师')
    expect(t['901@WN_HIS#verify']!.roleAgent).toBe('测试工程师')
  })

  it('US2/US3-兜底：存在通用工程师时，缺专门角色的阶段落通用工程师，且不凭空造角色', async () => {
    // 只有架构师/开发 + 用户自建的通用工程师：analyze/review/verify 无专门角色 → 通用兜底。
    const roles = [customRole('a', '架构师'), customRole('c', '开发'), customRole('g', '通用工程师')]
    const { svc, rolesRepo } = makeService({ roles })
    await svc.claimRequirement({ requirement: summary(902) })
    const r = svc.decompose('902@WN_HIS')
    expect(r.ok).toBe(true)
    expect(r.createdRoles).toBeUndefined()
    expect(rolesRepo.created()).toHaveLength(0)
    const t = svc.board.snapshot.tasks
    expect(t['902@WN_HIS#analyze']!.roleAgent).toBe('通用工程师')
    expect(t['902@WN_HIS#plan']!.roleAgent).toBe('架构师')
    expect(t['902@WN_HIS#impl']!.roleAgent).toBe('开发')
    expect(t['902@WN_HIS#review']!.roleAgent).toBe('通用工程师')
    expect(t['902@WN_HIS#verify']!.roleAgent).toBe('通用工程师')
    // 全栈工程师同属通用兜底（换名再验一次词表）。
    const roles2 = [customRole('a', '架构师'), customRole('c', '开发'), customRole('fs', '全栈工程师')]
    const ctx2 = makeService({ roles: roles2 })
    await ctx2.svc.claimRequirement({ requirement: summary(912) })
    const r2 = ctx2.svc.decompose('912@WN_HIS')
    expect(r2.ok).toBe(true)
    expect(ctx2.svc.board.snapshot.tasks['912@WN_HIS#review']!.roleAgent).toBe('全栈工程师')
    expect(ctx2.svc.board.snapshot.tasks['912@WN_HIS#verify']!.roleAgent).toBe('全栈工程师')
  })

  it('US3：无专门、无通用角色时按阶段顺序自动创建内置角色并落盘，二次拆解不再创建', async () => {
    // 只有一个完全不相关的 DBA：五个阶段都要自动创建。
    const { svc, rolesRepo } = makeService({ roles: [customRole('dba', 'DBA')] })
    await svc.claimRequirement({ requirement: summary(903) })
    const r = svc.decompose('903@WN_HIS')
    expect(r.ok).toBe(true)
    const expectCreated = ['需求分析师', '架构师', '开发工程师', '代码审核工程师', '测试工程师']
    expect(r.createdRoles).toEqual(expectCreated)
    expect(rolesRepo.created().map(x => x.name)).toEqual(expectCreated)
    const t = svc.board.snapshot.tasks
    expect(t['903@WN_HIS#analyze']!.roleAgent).toBe('需求分析师')
    expect(t['903@WN_HIS#plan']!.roleAgent).toBe('架构师')
    expect(t['903@WN_HIS#impl']!.roleAgent).toBe('开发工程师')
    expect(t['903@WN_HIS#review']!.roleAgent).toBe('代码审核工程师')
    expect(t['903@WN_HIS#verify']!.roleAgent).toBe('测试工程师')
    // 角色已在仓中：再拆一个需求不重复创建（双检 id/名称生效）。
    await svc.claimRequirement({ requirement: summary(904) })
    const again = svc.decompose('904@WN_HIS')
    expect(again.createdRoles).toBeUndefined()
    expect(rolesRepo.created()).toHaveLength(5)
  })

  it('US3-降级：角色端口无 save 且无匹配角色 → 回落列表第一个角色，拆解不失败', async () => {
    const { svc } = makeService({ roles: [customRole('dba', 'DBA')], rolesWithSave: false })
    await svc.claimRequirement({ requirement: summary(905) })
    const r = svc.decompose('905@WN_HIS')
    expect(r.ok).toBe(true)
    expect(r.createdRoles).toBeUndefined()
    for (const stage of ['analyze', 'plan', 'impl', 'review', 'verify'] as const) {
      expect(svc.board.snapshot.tasks[`905@WN_HIS#${stage}`]!.roleAgent).toBe('DBA')
    }
  })

  it('US3-降级：一个角色都没有且无 save → 五段任务以「通用工程师」名称占位', async () => {
    const { svc } = makeService({ roles: [], rolesWithSave: false })
    await svc.claimRequirement({ requirement: summary(906) })
    const r = svc.decompose('906@WN_HIS')
    expect(r.ok).toBe(true)
    for (const stage of ['analyze', 'plan', 'impl', 'review', 'verify'] as const) {
      expect(svc.board.snapshot.tasks[`906@WN_HIS#${stage}`]!.roleAgent).toBe('通用工程师')
    }
  })

  it('US3-容错：save 抛错时记 role-auto-create-failed 事件、回落首个角色，拆解仍成功', async () => {
    const rolesRepo = makeRolesRepo()
    rolesRepo.setSaveThrows(true)
    const { svc } = makeService({ rolesRepo })
    await svc.claimRequirement({ requirement: summary(907) })
    const r = svc.decompose('907@WN_HIS')
    expect(r.ok).toBe(true)
    // plan→架构师、impl→开发 有专门匹配；analyze/review/verify 触发创建失败 → 回落列表首个 = 架构师。
    expect(svc.board.snapshot.tasks['907@WN_HIS#analyze']!.roleAgent).toBe('架构师')
    expect(svc.board.snapshot.tasks['907@WN_HIS#review']!.roleAgent).toBe('架构师')
    expect(svc.board.snapshot.tasks['907@WN_HIS#verify']!.roleAgent).toBe('架构师')
    expect(svc.board.snapshot.tasks['907@WN_HIS#plan']!.roleAgent).toBe('架构师')
    expect(svc.board.snapshot.tasks['907@WN_HIS#impl']!.roleAgent).toBe('开发')
    const events = svc.replayEvents()
    expect(events.some(e => e['action'] === 'role-auto-create-failed')).toBe(true)
  })
})

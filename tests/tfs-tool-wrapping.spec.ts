/**
 * TFS 能力目录契约测试（REST 化后重定义，2026-09-19）。
 *
 * 断言的不是"实现细节"，而是三条**对外承诺**：
 *
 * 1. **一一对应**：契约表登记的每个操作（`raw`）都必须有且只有一个对应的 `tfs_req_*`
 *    工具名（`plugin`），且前缀正确。契约表是 `adapter.call(raw, args)` 的分派键来源，
 *    名字对不上就意味着"UI 展示的能力"与"代码实现的能力"分家。
 * 2. **读写性质正确**：查询是读、建工作项/加评论是写。写操作必须过四道门禁，
 *    所以"漏判写"是不可接受的（见 `fallbackSpec` 的"认读不认写"）。
 * 3. **降级可读**：目录服务不可用时返回 `ok:false` + 非空原因，而不是空数组
 *    （空数组会被 UI 显示成"0 个操作"，既像插件坏了、又看不出为什么）。
 *
 * REST 化后不再有"按实例收敛"的概念：能力面由适配层 `IMPLEMENTED_OPERATIONS` 静态决定，
 * 未实现的操作在视图里标 `unimplemented` 并计入 `missingCount`。
 */

import { describe, expect, it } from 'vitest'
import { createHostApi } from '../src/host/api.js'
import { TfsAdapter, IMPLEMENTED_OPERATIONS } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'
import { makeFakeRest } from './helpers/fake-rest.js'
import { catalogView, pluginToolName, fallbackSpec, TFS_TOOL_SPECS } from '../src/tfs/tool-catalog.js'
import type { BoardService } from '../src/host/board-service.js'
import type { RoleDefinition } from '../src/shared/contracts.js'
import type { Agent } from '@deepseek-ai/dsh-agent'

/** 契约表全部操作键（49 条）。 */
const ALL_OPERATIONS: readonly string[] = TFS_TOOL_SPECS.map(s => s.raw)

function makeApi(opts: { tfsToolCatalog?: () => ReturnType<typeof catalogView>; preset?: string } = {}): {
  api: ReturnType<typeof createHostApi>
  getDispatched: () => { role: RoleDefinition } | null
} {
  const fs = createMemFs()
  const audit = new AuditLog('/mem/audit', fs)
  const guard = new WriteGuard(audit)
  // 本文件只在**装配层**验证"能力目录与派发"，不做真实 TFS 读写 ⇒ REST 桩留空即可
  // （未命中路由返回 404 纯文本；本文件不会走到任何调用）。
  const rest = makeFakeRest()
  const adapter = new TfsAdapter({
    rest: rest.config,
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 'WN_HIS',
  })
  let dispatched: { role: RoleDefinition } | null = null
  const api = createHostApi({
    roles: {
      list: () => [{ id: 'r1', name: '架构师', provider: 'spawn', preset: 'role-preset' } as RoleDefinition],
      getByName: (n: string) =>
        n === '架构师' ? ({ id: 'r1', name: '架构师', provider: 'spawn', preset: 'role-preset' } as RoleDefinition) : undefined,
      save: () => undefined,
      delete: () => false,
    },
    adapter,
    dispatcher: {
      dispatch: async req => {
        dispatched = req as unknown as { role: RoleDefinition }
        return { taskId: req.taskId, requirementId: req.requirementId, runId: 'run-x', provider: req.role.provider }
      },
    },
    getParent: () => ({}) as Agent,
    /**
     * 问题 6：无 taskId 的派发（执行配置「发起执行」）会先登记一条手工看板任务，
     * 没有看板服务时会被明确拒绝。本文件不测看板语义，给最小桩让"预设覆盖"这条链路可跑通。
     */
    board: {
      snapshot: () => ({ tasks: [] }),
      setTaskState: () => ({ ok: true }),
      bindRun: () => ({ ok: true }),
      settleTask: () => ({ ok: true }),
      openFollowUp: () => ({ ok: true }),
      createManualTask: () => ({ ok: true, taskId: '123@WN_HIS#manual-架构师' }),
      board: { snapshot: { requirements: { '123@WN_HIS': {} } } },
    } as unknown as BoardService,
    models: [],
    mcpServers: [],
    skills: [],
    tagSuggestions: [],
    collection: 'WN_HIS',
    ...(opts.tfsToolCatalog ? { tfsToolCatalog: opts.tfsToolCatalog } : {}),
  })
  return { api, getDispatched: () => dispatched }
}

describe('catalogView（能力目录：操作键 ⇄ tfs_req_* 工具名）', () => {
  it('契约表每个操作都有且只有一个 tfs_req_* 工具名', () => {
    const view = catalogView()
    expect(view.rawCount).toBe(ALL_OPERATIONS.length)
    expect(view.tools).toHaveLength(ALL_OPERATIONS.length)
    // 一一对应：工具名不重复，且每个都能由操作键推导。
    const plugins = view.tools.map(t => t.plugin)
    expect(new Set(plugins).size).toBe(plugins.length)
    for (const t of view.tools) {
      expect(t.plugin).toBe(pluginToolName(t.raw))
      expect(t.plugin.startsWith('tfs_req_')).toBe(true)
    }
  })

  it('读写性质与契约表一致：查询是读、建工作项是写', () => {
    const view = catalogView()
    expect(view.tools.find(t => t.raw === 'tfs_query_wiql')?.access).toBe('read')
    expect(view.tools.find(t => t.raw === 'tfs_create_workitem')?.access).toBe('write')
    expect(view.tools.find(t => t.raw === 'tfs_add_comment')?.access).toBe('write')
  })

  it('未登记操作走兜底契约并按前缀保守判读写（名字带 write 判写，不漏判）', () => {
    // 兜底判读写偏保守：名字带 write 判为写（多过一道门禁，不能反过来漏判）。
    expect(fallbackSpec('tfs_brand_new_write_tool').access).toBe('write')
    // 明确的读动词才判读。
    expect(fallbackSpec('tfs_get_something').access).toBe('read')
    expect(fallbackSpec('tfs_list_something').access).toBe('read')
  })

  it('传 implemented 时未实现的操被标 unimplemented 并计入 missingCount（缺口可见）', () => {
    // 只声明实现了一个读操作 ⇒ 其余全部是缺口。
    const partial = new Set(['tfs_whoami'])
    const view = catalogView(partial)
    expect(view.missingCount).toBe(ALL_OPERATIONS.length - 1)
    expect(view.wrappedCount).toBe(1)
    expect(view.tools.find(t => t.raw === 'tfs_whoami')?.unimplemented).toBeUndefined()
    expect(view.tools.find(t => t.raw === 'tfs_create_workitem')?.unimplemented).toBe(true)
  })

  it('传全部实现时 missingCount=0 且 ok=true（无缺口）', () => {
    const view = catalogView(new Set(ALL_OPERATIONS))
    expect(view.ok).toBe(true)
    expect(view.missingCount).toBe(0)
    expect(view.wrappedCount).toBe(ALL_OPERATIONS.length)
  })

  it('真实 IMPLEMENTED_OPERATIONS 是契约表的子集，且缺口数与视图自洽', () => {
    // 这条锁住"适配层分支表"与"契约表"的一致性：实现集不得含契约表外的操作键
    // （含了就说明 UI 看不到这个能力，但代码能调 — 面板与实现对不上）。
    for (const op of IMPLEMENTED_OPERATIONS) {
      expect(ALL_OPERATIONS).toContain(op)
    }
    const view = catalogView(IMPLEMENTED_OPERATIONS)
    expect(view.wrappedCount).toBe(IMPLEMENTED_OPERATIONS.size)
    expect(view.missingCount).toBe(ALL_OPERATIONS.length - IMPLEMENTED_OPERATIONS.size)
  })
})

describe('HostApi.getTfsToolCatalog（降级口径）', () => {
  it('未注入目录服务时返回 ok=false + 可读原因，而不是空数组', () => {
    const { api } = makeApi()
    const view = api.getTfsToolCatalog()
    expect(view.ok).toBe(false)
    expect(view.tools).toEqual([])
    expect(view.reason).toBeTruthy()
  })

  it('注入后原样透传（含计数）', () => {
    const { api } = makeApi({ tfsToolCatalog: () => catalogView(IMPLEMENTED_OPERATIONS) })
    const view = api.getTfsToolCatalog()
    expect(view.ok).toBe(true)
    expect(view.wrappedCount).toBe(IMPLEMENTED_OPERATIONS.size)
  })

  it('采集函数抛错时收敛为可读原因，不让路由 500', () => {
    const { api } = makeApi({
      tfsToolCatalog: () => {
        throw new Error('能力目录采集不可用')
      },
    })
    const view = api.getTfsToolCatalog()
    expect(view.ok).toBe(false)
    expect(view.reason).toContain('能力目录采集不可用')
  })
})

describe('dispatch 预设覆盖（问题 6）', () => {
  it('执行配置选的预设覆盖角色自带 preset，且不改角色档案', async () => {
    const { api, getDispatched } = makeApi()
    await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: 'do it',
        frozenConfig: { mcp: [], skills: [], model: 'm' },
        permission: 'read-only',
        preset: 'panel-preset',
      },
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    const req = getDispatched()
    expect(req?.role.preset).toBe('panel-preset')
    // 角色档案里的 preset 不能被一次性执行选择改写。
    expect(
      (api.listRoles().find(r => r.name === '架构师') as RoleDefinition | undefined)?.preset,
    ).toBe('role-preset')
  })

  it('未指定预设时沿用角色自带 preset', async () => {
    const { api, getDispatched } = makeApi()
    await api.dispatch({
      draft: {
        roleName: '架构师',
        prompt: 'do it',
        frozenConfig: { mcp: [], skills: [], model: 'm' },
        permission: 'read-only',
        },
      targetWorkItem: '123@WN_HIS',
      collection: 'WN_HIS',
    })
    expect(getDispatched()?.role.preset).toBe('role-preset')
  })
})

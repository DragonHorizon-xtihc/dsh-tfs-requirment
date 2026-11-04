/**
 * 宿主半 HTTP 路由（Phase 3：真实 client→host 通道）。
 *
 * 客户端半 `fetch(TFS_ROUTES.*)` 调到这里；三个端点分别由 `host/api.ts` 的编排落地：
 *  - `GET  /tfs-requirment/panel-data`    → getPanelData
 *  - `POST /tfs-requirment/confirm-write` → confirmWrite（过四道门禁后直连 TFS REST 写入）
 *  - `POST /tfs-requirment/dispatch`      → dispatch（按角色派发 subagent）
 *
 * 设计对齐 dsh-optimized-prompt/routes.ts：
 *  - 业务失败返回 **200** + `ok:false`（把"模型没写好"与"请求非法/被拒"区分开）；
 *  - 用 `guardedWebServer` 给每条路由套鉴权栅栏（未鉴权 401/403，门禁不可用 503）；
 *  - 用 `ctx.inject(['webServer'], ...)` 惰性注册，宿主无 web 服务时插件仍可加载（仅无按钮端点）。
 *
 * @module dsh-tfs-requirment/host/route
 */

import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import type { ConfirmWriteInput, ConfirmWriteResult, DispatchInput, DispatchResult, HostApi } from './api.js'
import { TFS_ROUTES } from '../shared/contracts.js'
import { guardedWebServer, sendRouteError, type BrowserRequestGate, type RawRouteHost } from './web-guard.js'
import { readJsonBody, sendError, sendJson } from './http-util.js'

/**
 * 把入参里的多值字段归一化为字符串数组（需求筛选条件的边界校验）。
 *
 * 面板与适配层都按 `string[]` 使用 `projects`/`types`/`states`/`assignedTo`；若请求体把其中一项
 * 发成字符串，适配层早晚会把它当可迭代对象逐字符展开（`"进行中"` → `'进'/'行'/'中'`），
 * 拼出语义错误但语法合法的 WIQL，得到一个静默为空的需求池。这里在边界处收口。
 *
 * @param value - 原始字段值。
 * @returns 归一化后的字符串数组（缺省或空串返回空数组）。
 */
function stringList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((v): v is string => typeof v === 'string' && v.length > 0)
  return typeof value === 'string' && value.length > 0 ? [value] : []
}

/**
 * 归一化分页参数：非有限数、负数一律回落到缺省值。
 *
 * `NaN` 传给 `slice` 会得到空页且不报错，因此必须在边界处拒绝。
 *
 * @param value - 原始字段值。
 * @param fallback - 缺省值。
 * @param min - 允许的最小值。
 * @returns 可安全用于 `slice` 的整数。
 */
function paging(value: unknown, fallback: number, min: number): number {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.max(min, Math.trunc(n))
}

/**
 * 从请求 URL 的查询串里取 `collection`（客户端按集合隔离 UI 状态与可选项缓存）。
 *
 * 客户端确实带了 `?collection=`，但处理器此前一律忽略 `req.url`、回落到宿主当前集合，
 * 于是「每个集合各记一份状态」在读侧并不成立。
 *
 * @param req - 原始请求。
 * @returns 非空 collection，缺失时为 undefined。
 */
function collectionFromUrl(req: IncomingMessage): string | undefined {
  const raw = req.url ?? ''
  const at = raw.indexOf('?')
  if (at < 0) return undefined
  const found = new URLSearchParams(raw.slice(at + 1)).get('collection')
  return found && found.length > 0 ? found : undefined
}

/** 取面板数据处理器。 */
export function createPanelDataHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, api.getPanelData())
  }
}

/**
 * 能力目录强制重采处理器（POST）。
 *
 * 与 `panel-data` 的差别：本处理器 `await api.refreshPanelData()`，即**先重采再返回**。
 * `refresh()` 内部用 inflight 去重 + 逐项 try/catch 降级，从不抛错，故这里不需要额外超时或
 * 错误分支；用户连点刷新也只会共享同一次采集。
 */
export function createCatalogRefreshHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    void api
      .refreshPanelData()
      .then(data => sendJson(res, 200, data))
      .catch(error => sendError(res, 500, `目录重采失败：${error instanceof Error ? error.message : String(error)}`))
  }
}

/** 需求池列表处理器（POST，body = RequirementFilter）。 */
export function createRequirementsHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const raw = (typeof body.value === 'object' && body.value !== null ? body.value : {}) as Record<string, unknown>
    // 多值字段统一收口为 string[]，分页收口为有限整数：否则字符串会被逐字符展开成错误 WIQL，
    // 非数字 top 会让 `slice` 返回空页，两种情况都不会报错，只会表现为"需求池空了"。
    const filter: Record<string, unknown> = { ...raw }
    for (const key of ['projects', 'types', 'states', 'assignedTo'] as const) {
      if (raw[key] !== undefined) filter[key] = stringList(raw[key])
    }
    if (raw['top'] !== undefined) filter['top'] = paging(raw['top'], 20, 1)
    if (raw['skip'] !== undefined) filter['skip'] = paging(raw['skip'], 0, 0)
    const result = await api.listRequirements(filter)
    sendJson(res, 200, result)
  }
}

/** 需求筛选可选项处理器（GET，问题 3：项目/类型/状态/指派人，由宿主从真实 TFS 采集）。 */
export function createQueryOptionsHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    // 采集可能耗时（WIQL 采样），但仍是 GET；失败返回 200 + ok:false（与自检同约定）。
    void Promise.resolve(api.getQueryOptions()).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  }
}

/**
 * 需求筛选可选项**强制重采**处理器（POST）。
 *
 * 与 `query-options`（GET）的差别：本处理器绕过宿主进程内缓存，直接重采一轮 TFS 元数据。
 * 存在的理由：缓存在进程内，TFS 上新建项目/工作项类型后它会滞后到服务重启，
 * 用户需要一个明确入口自救（FR-003）。用 POST 是因为它有副作用（丢弃缓存 + 触发采集）。
 */
export function createQueryOptionsRefreshHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    void Promise.resolve(api.refreshQueryOptions()).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  }
}

/**
 * 可选项**读盘**处理器（GET，问题 1）：直接返回 query-options.json 里的缓存，
 * 不触发任何 TFS 元数据采集；无缓存时 data=null（客户端据此决定是否首次采集）。
 */
export function createQueryOptionsLoadHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    void Promise.resolve(api.loadQueryOptions(collectionFromUrl(req))).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  }
}

/** 可选项**强制重采并落盘**处理器（POST，问题 1「采集可选项」按钮，body 可带 collection）。 */
export function createQueryOptionsCollectHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const collection = typeof body['collection'] === 'string' ? body['collection'] : undefined
    return Promise.resolve(api.collectQueryOptions(collection)).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  })
}

/**
 * UI 状态处理器（问题 2/4/6）：
 *  - GET：返回当前集合的 UiState（无记录返回 `{}`，客户端回退默认值）；
 *  - POST：body 为 UiState 补丁（可带 collection 覆盖集合命名空间），浅合并落盘。
 */
export function createUiStateHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method === 'GET') {
      sendJson(res, 200, await api.loadUiState(collectionFromUrl(req)))
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'GET, POST')
      sendError(res, 405, '仅支持 GET / POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendJson(res, 200, { ok: false, reason: '请求体不是合法 JSON 或过大' })
      return
    }
    const value = (typeof body.value === 'object' && body.value !== null ? body.value : {}) as Record<string, unknown>
    const collection = typeof value['collection'] === 'string' ? (value['collection'] as string) : undefined
    // patch 只取 UiState 已知键，杜绝把任意 body 键写进 ui-state.json。
    const patch = (() => {
      const p: Record<string, unknown> = {}
      if (value['poolFilters'] !== undefined) p['poolFilters'] = value['poolFilters']
      for (const k of ['poolPageSize', 'claimedPageSize', 'taskPageSize', 'donePageSize'] as const) {
        if (typeof value[k] === 'number') p[k] = value[k]
      }
      return p
    })()
    sendJson(res, 200, await api.saveUiState(patch, collection))
  }
}

/** 还原已领取需求回需求池处理器（POST，问题 7，body = { requirementKey }）。 */
export function createRequirementRestoreHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const requirementKey = body['requirementKey']
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      sendError(res, 400, 'requirementKey 必填')
      return
    }
    return Promise.resolve(api.restoreRequirement(requirementKey)).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  })
}

/** 实时重取需求四段正文处理器（POST，问题 11，body = { requirementKey }）。 */
export function createRequirementEnrichHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const requirementKey = body['requirementKey']
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      sendError(res, 400, 'requirementKey 必填')
      return
    }
    return Promise.resolve(api.enrichRequirement(requirementKey)).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  })
}

/** 删除已取消任务处理器（POST，问题 8，body = { taskIds: string[] }，整批门禁）。 */
export function createTaskDeleteHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const taskIds = body['taskIds']
    if (!Array.isArray(taskIds) || taskIds.some(t => typeof t !== 'string')) {
      sendError(res, 400, 'taskIds 必须是字符串数组')
      return
    }
    return Promise.resolve(api.deleteTasks(taskIds as string[])).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  })
}

/**
 * 编辑已领取需求本地字段处理器（POST，问题 3，body = UpdateRequirementInput）。
 *
 * 只接受 `requirementKey` + `prompt` / `workspace` 三个键：TFS 侧字段（标题/状态/标签）
 * 必须走 `confirm-write` 的四道门禁，这条路由**不是**它们的旁路。
 * `null` 需要显式保留（= 清空），故不能用 `typeof x === 'string'` 过滤后直接丢弃。
 */
export function createRequirementUpdateHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const requirementKey = body['requirementKey']
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      sendError(res, 400, 'requirementKey 必填')
      return
    }
    const input: {
      requirementKey: string
      workspace?: string | null
      prompt?: string | null
    } = { requirementKey }
    for (const field of ['workspace', 'prompt'] as const) {
      if (!(field in body)) continue
      const v = body[field]
      if (v !== null && typeof v !== 'string') {
        sendError(res, 400, `${field} 必须是字符串或 null`)
        return
      }
      input[field] = v as string | null
    }
    if (input.workspace === undefined && input.prompt === undefined) {
      sendError(res, 400, '需提供 workspace 或 prompt 至少一项')
      return
    }
    void Promise.resolve(api.updateRequirement(input)).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  })
}

/**
 * 需求级执行状态处理器（POST，问题 5，body = { requirementKey, state }）。
 *
 * `state='active'` = 取消完成（需求退回「任务中心」）；`'completed'` = 确认完成（迁入「已完成」）。
 * 只接受这两个字面量：状态是 UI 分页的依据，放开成任意字符串会让需求掉进"两页都不显示"的缝隙。
 */
export function createRequirementExecStateHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const requirementKey = body['requirementKey']
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      sendError(res, 400, 'requirementKey 必填')
      return
    }
    const state = body['state']
    if (state !== 'active' && state !== 'completed') {
      sendError(res, 400, "state 必须是 'active'（取消完成）或 'completed'（确认完成）")
      return
    }
    // ⚠️ 必须有 rejection 分支（2026-10-06 修复）：本文件其余 fire-and-forget handler 一律
    // 两参 `.then(ok, err)`，只有这里曾是单参 —— 而 handler 已经返回，`web-guard` 的
    // try/catch 看不到这个 Promise 的 rejection。一旦 `setRequirementExecState` 抛错
    // （`persist` IO 异常 / 需求不在本地池抛 BoardError），客户端请求**永久挂起**（无状态码、
    // 无响应体），宿主日志里只剩一条 unhandled rejection，用户侧表现为"点了没反应"。
    return Promise.resolve(api.setRequirementExecState({ requirementKey, state })).then(
      result => sendJson(res, 200, result),
      error => sendRouteError(res, error),
    )
  })
}

/** 编辑任务字段处理器（POST，问题 4，body = UpdateTaskInput）。 */
export function createTaskUpdateHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const taskId = body['taskId']
    if (typeof taskId !== 'string' || taskId.length === 0) {
      sendError(res, 400, 'taskId 必填')
      return
    }
    const input: {
      taskId: string
      prompt?: string | null
      workspace?: string | null
      model?: string
      modelProvider?: string
      skills?: string[]
      mcp?: string[]
      preset?: string
      /** 2026-10-29（诉求 4）：工作流技能名（必须在 skills 内）。 */
      workflow?: string
      maxDepth?: number
      maxTokens?: number
      expectedRevision?: number
    } = { taskId }
    for (const field of ['prompt', 'workspace'] as const) {
      if (!(field in body)) continue
      const v = body[field]
      if (v !== null && typeof v !== 'string') {
        sendError(res, 400, `${field} 必须是字符串或 null`)
        return
      }
      input[field] = v as string | null
    }
    for (const field of ['model', 'modelProvider', 'preset', 'workflow'] as const) {
      if (body[field] === undefined) continue
      if (typeof body[field] !== 'string') {
        sendError(res, 400, `${field} 必须是字符串`)
        return
      }
      input[field] = body[field] as string
    }
    for (const field of ['skills', 'mcp'] as const) {
      const v = body[field]
      if (v === undefined) continue
      if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
        sendError(res, 400, `${field} 必须是字符串数组`)
        return
      }
      input[field] = v as string[]
    }
    // 问题 1：执行预算（非负有限数；0 = 沿用默认/不限制）。
    for (const field of ['maxDepth', 'maxTokens'] as const) {
      if (body[field] === undefined) continue
      const n = body[field]
      if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) {
        sendError(res, 400, `${field} 必须是非负有限数`)
        return
      }
      input[field] = n
    }
    if (body['expectedRevision'] !== undefined) {
      const rev = body['expectedRevision']
      if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0) {
        sendError(res, 400, 'expectedRevision 必须是非负整数')
        return
      }
      input.expectedRevision = rev
    }
    void Promise.resolve(api.updateTask(input)).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  })
}

/** 角色清单处理器（GET）。 */
export function createRolesListHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, { ok: true, roles: api.listRoles() })
  }
}

/** 保存角色处理器（POST，body = RoleDefinition）。 */
export function createRoleSaveHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
const role = body.value as Record<string, unknown> | null
    if (typeof role !== 'object' || role === null || typeof role.id !== 'string' || typeof role.name !== 'string') {
      sendError(res, 400, '角色须含字符串 id 与 name')
      return
    }
    // 数组字段必须真的是字符串数组：字符串会在客户端渲染 mcp.map 时抛错、在看板侧被逐字符展开。
    const notList = (['defaultMcp', 'defaultSkills'] as const).find(
      key => role[key] !== undefined && (!Array.isArray(role[key]) || role[key].some((v: unknown) => typeof v !== 'string')),
    )
    if (notList !== undefined) {
      sendError(res, 400, `角色字段 ${notList} 必须是字符串数组`)
      return
    }
    sendJson(res, 200, api.saveRole(role as never))
  }
}

/** 删除角色处理器（POST，body = { id, force? }）。 */
export function createRoleDeleteHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const value = body.value as { id?: unknown; force?: unknown } | null
    if (typeof value !== 'object' || value === null || typeof value.id !== 'string' || value.id.length === 0) {
      sendError(res, 400, 'id 必填且为字符串')
      return
    }
    sendJson(res, 200, api.deleteRole(value.id, value.force === true))
  }
}

/** 技能/MCP 分组清单处理器（GET，2026-11-03 用户诉求）。 */
export function createSkillGroupsListHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, { ok: true, groups: api.listSkillGroups() })
  }
}

/** 保存技能/MCP 分组处理器（POST，body = SkillMcpGroup）。 */
export function createSkillGroupSaveHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const group = body.value as Record<string, unknown> | null
    if (typeof group !== 'object' || group === null || typeof group.id !== 'string' || group.id.length === 0) {
      sendError(res, 400, '分组须含非空字符串 id')
      return
    }
    if (typeof group.name !== 'string' || group.name.trim().length === 0) {
      sendError(res, 400, '分组名必填')
      return
    }
    // skills/mcp 必须真的是字符串数组（与角色保存同纪律：字符串会在客户端 .map 时抛错）。
    const notList = (['skills', 'mcp'] as const).find(
      key => group[key] !== undefined && (!Array.isArray(group[key]) || group[key].some((v: unknown) => typeof v !== 'string')),
    )
    if (notList !== undefined) {
      sendError(res, 400, `分组字段 ${notList} 必须是字符串数组`)
      return
    }
    sendJson(res, 200, api.saveSkillGroup({
      id: group.id,
      name: group.name as string,
      description: typeof group.description === 'string' ? group.description : undefined,
      skills: (group.skills as string[] | undefined) ?? [],
      mcp: (group.mcp as string[] | undefined) ?? [],
      createdAt: typeof group.createdAt === 'string' ? group.createdAt : '',
      updatedAt: typeof group.updatedAt === 'string' ? group.updatedAt : '',
    }))
  }
}

/** 删除技能/MCP 分组处理器（POST，body = { id }）。 */
export function createSkillGroupDeleteHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const value = body.value as { id?: unknown } | null
    if (typeof value !== 'object' || value === null || typeof value.id !== 'string' || value.id.length === 0) {
      sendError(res, 400, 'id 必填且为字符串')
      return
    }
    sendJson(res, 200, api.deleteSkillGroup(value.id))
  }
}

/** 看板快照处理器（GET，US3 任务中心 / US6 恢复）。 */
export function createBoardHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, api.getBoard())
  }
}

/** 连通性自检处理器（GET，US1/T029）。 */
export function createHealthHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (_req, res) => {
    // 自检失败也返回 200 + ok:false：这是"探测结果"，不是"请求非法"（与业务失败同一约定）。
    sendJson(res, 200, await api.healthCheck())
  }
}

/** 审计状态处理器（GET，T063）。 */
export function createAuditHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, api.getAudit())
  }
}

/**
 * 审计归档处理器（POST，T063）。
 *
 * 用 POST 而非 GET：它有**副作用**（写归档文件）。虽然 live 日志不被改动，
 * 但把有副作用的动作放在 GET 上会让任何预取/重试链路意外触发归档。
 */
export function createAuditArchiveHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((_body, res) => {
    sendJson(res, 200, api.archiveAudit())
  })
}

/** 切换集合处理器（POST，body = { collection }，T030）。 */
export function createCollectionHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const collection = body['collection']
    if (typeof collection !== 'string' || collection.trim().length === 0) {
      sendError(res, 400, 'collection 必填且为非空字符串')
      return
    }
    sendJson(res, 200, api.setCollection(collection))
  })
}

/** 连接档案清单处理器（GET，T031；响应中永不含 PAT）。 */
export function createProfilesHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, api.listProfiles())
  }
}

/** 保存档案处理器（POST，body = ProfileSaveInput，T031）。 */
export function createProfileSaveHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const name = body['name']
    const url = body['url']
    const collection = body['collection']
    const pat = body['pat']
    const id = body['id']
    if (typeof name !== 'string' || name.trim().length === 0) {
      sendError(res, 400, 'name 必填')
      return
    }
    if (typeof url !== 'string' || url.trim().length === 0) {
      sendError(res, 400, 'url 必填')
      return
    }
    if (typeof collection !== 'string' || collection.trim().length === 0) {
      sendError(res, 400, 'collection 必填')
      return
    }
    if (pat !== undefined && typeof pat !== 'string') {
      sendError(res, 400, 'pat 必须是字符串')
      return
    }
    if (id !== undefined && typeof id !== 'string') {
      sendError(res, 400, 'id 必须是字符串')
      return
    }
    sendJson(res, 200, api.saveProfile({
      name,
      url,
      collection,
      ...(typeof id === 'string' ? { id } : {}),
      ...(typeof pat === 'string' ? { pat } : {}),
    }))
  })
}

/** 删除档案处理器（POST，body = { id }，T031）。 */
export function createProfileDeleteHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const id = body['id']
    if (typeof id !== 'string' || id.trim().length === 0) {
      sendError(res, 400, 'id 必填')
      return
    }
    sendJson(res, 200, api.deleteProfile(id))
  })
}

/** 设为活动档案处理器（POST，body = { id }，T031）。 */
export function createProfileActivateHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const id = body['id']
    if (typeof id !== 'string' || id.trim().length === 0) {
      sendError(res, 400, 'id 必填')
      return
    }
    sendJson(res, 200, api.activateProfile(id))
  })
}

/** MCP 接入诊断处理器（GET，T028b）：实例信息 + 环境模板一并返回，UI 一次请求即可渲染。 */
export function createMcpInstanceHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, { ok: true, instance: api.getMcpInstance(), template: api.getMcpEnvTemplate() })
  }
}

/**
 * 能力目录处理器（GET，问题 8 / 12）。
 *
 * 返回 `tfs_req_*` ⇄ 适配层操作键的一一对应，供「连接与凭据」页展示
 * 「插件直连 REST 能做什么」（REST 化后不再讲"把哪个 MCP 工具封装成了什么"）。
 */
export function createTfsToolsHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void {
  return (_req, res) => {
    sendJson(res, 200, api.getTfsToolCatalog())
  }
}

/** 写出 MCP 启动环境文件处理器（POST，body = { profileId? }，T028b；响应永不含 PAT）。 */
export function createMcpEnvFileHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const profileId = body['profileId']
    if (profileId !== undefined && typeof profileId !== 'string') {
      sendError(res, 400, 'profileId 必须是字符串')
      return
    }
    sendJson(res, 200, api.writeMcpEnvFile(typeof profileId === 'string' ? profileId : undefined))
  })
}

/**
 * 统一的 POST-JSON 处理器骨架：方法校验 → 体积/语法校验 → 业务调用。
 *
 * 抽出来是因为后面 4 条路由（claim/decompose/task-assign/task-state）的前半段完全一致，
 * 各写一遍必然漂移（例如某条忘了 405 分支），这类漂移在运行期表现为"按钮点了没反应"。
 *
 * @param run - 拿到已解析 body 后的业务逻辑。
 */
function postJsonHandler(
  run: (body: Record<string, unknown>, res: ServerResponse) => void | Promise<void>,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const value = (typeof body.value === 'object' && body.value !== null ? body.value : {}) as Record<string, unknown>
    await run(value, res)
  }
}

/** 领取需求处理器（POST，body = ClaimRequirementInput）。 */
export function createClaimHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler(async (body, res) => {
    const requirement = typeof body['requirement'] === 'object' && body['requirement'] !== null
      ? (body['requirement'] as Record<string, unknown>)
      : undefined
    const idRaw = body['id']
    if (!requirement && idRaw === undefined) {
      sendError(res, 400, '需提供 requirement 对象或数字 id')
      return
    }
    if (idRaw !== undefined && (typeof idRaw !== 'number' || !Number.isInteger(idRaw) || idRaw <= 0)) {
      sendError(res, 400, 'id 必须是正整数')
      return
    }
    sendJson(
      res,
      200,
      await api.claimRequirement({
        ...(requirement ? { requirement: requirement as never } : {}),
        ...(typeof idRaw === 'number' ? { id: idRaw } : {}),
        ...(typeof body['collection'] === 'string' ? { collection: body['collection'] } : {}),
        ...(typeof body['tag'] === 'boolean' ? { tag: body['tag'] } : {}),
        // 本地代码库路径（本地补充字段，非 TFS 字段）：透传给 BoardService 做 fail-loud 校验。
        ...(typeof body['workspace'] === 'string' ? { workspace: body['workspace'] } : {}),
        // 需求级提示词（本地补充字段）：领取弹框里填的「增加提示词」。
        // ⚠️ 2026-11-03 修复：此前这里只透传 workspace 而**丢掉 prompt** ——
        // 客户端（RequirementPool）发了、BoardService 也会存，但路由层没转发 ⇒
        // 领取入池填的提示词从未落库，任务中心「编辑」自然看不到（问题 1）。
        ...(typeof body['prompt'] === 'string' ? { prompt: body['prompt'] } : {}),
      }),
    )
  })
}

/** 拆解需求处理器（POST，body = { requirementId }；问题 10：await 完成后再响应，UI 即可实时刷新）。 */
export function createDecomposeHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler(async (body, res) => {
    const requirementId = body['requirementId']
    if (typeof requirementId !== 'string' || requirementId.length === 0) {
      sendError(res, 400, 'requirementId 必填')
      return
    }
    sendJson(res, 200, await api.decomposeRequirement(requirementId))
  })
}

/** 指派任务角色处理器（POST，body = { taskId, roleName }）。 */
export function createTaskAssignHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const taskId = body['taskId']
    const roleName = body['roleName']
    if (typeof taskId !== 'string' || taskId.length === 0) {
      sendError(res, 400, 'taskId 必填')
      return
    }
    if (typeof roleName !== 'string' || roleName.length === 0) {
      sendError(res, 400, 'roleName 必填')
      return
    }
    sendJson(res, 200, api.assignTask(taskId, roleName))
  })
}

/** 任务状态操作处理器（POST，body = { taskId, action, expectedRevision? }）。 */
export function createTaskStateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  const ACTIONS = ['start', 'complete', 'fail', 'retry', 'cancel', 'confirm'] as const
  return postJsonHandler((body, res) => {
    const taskId = body['taskId']
    const action = body['action']
    if (typeof taskId !== 'string' || taskId.length === 0) {
      sendError(res, 400, 'taskId 必填')
      return
    }
    if (typeof action !== 'string' || !(ACTIONS as readonly string[]).includes(action)) {
      sendError(res, 400, `action 必须是 ${ACTIONS.join(' / ')} 之一`)
      return
    }
    const rev = body['expectedRevision']
    if (rev !== undefined && (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 0)) {
      sendError(res, 400, 'expectedRevision 必须是非负整数')
      return
    }
    sendJson(res, 200, api.setTaskState(taskId, action as (typeof ACTIONS)[number], rev as number | undefined))
  })
}

/**
 * 任务执行轨迹处理器（GET `?taskId=&attempt=`，spec 006 US2）。
 *
 * 会话不可读 / 无 runId / 服务缺失都由 api 层收敛为 **200 + available:false**（探测结果，
 * 不是请求非法）；只有缺 taskId / attempt 形状不对才回 400。
 */
export function createTaskTraceHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      sendError(res, 405, '仅支持 GET')
      return
    }
    const url = new URL(req.url ?? '', 'http://localhost')
    const taskId = url.searchParams.get('taskId') ?? ''
    if (!taskId) {
      sendError(res, 400, 'taskId 必填')
      return
    }
    const attemptRaw = url.searchParams.get('attempt')
    let attempt: number | undefined
    if (attemptRaw !== null) {
      const n = Number(attemptRaw)
      if (!Number.isInteger(n) || n < 0) {
        sendError(res, 400, 'attempt 必须是非负整数')
        return
      }
      attempt = n
    }
    sendJson(res, 200, await api.getTaskTrace(taskId, attempt))
  }
}

/** 任务追问 / 补充指令处理器（POST body = { taskId, message }，spec 006 US3）。 */
export function createTaskFollowUpHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const taskId = body['taskId']
    const message = body['message']
    if (typeof taskId !== 'string' || taskId.length === 0) {
      sendError(res, 400, 'taskId 必填')
      return
    }
    if (typeof message !== 'string' || message.trim().length === 0) {
      sendError(res, 400, 'message 必填且为非空字符串')
      return
    }
    return Promise.resolve(api.followUpTask({ taskId, message })).then(result => sendJson(res, 200, result), error => sendRouteError(res, error))
  })
}

/**
 * 需求完成自动回写处理器（问题 4）。
 *
 * - GET  `?requirementKey=`：读本地落盘的最近一次回写报告（无则 `report=null`），不触发 TFS 写；
 * - POST body `{ requirementKey, force? }`：触发（或 force 重跑）回写，返回逐项报告。
 */
export function createRequirementWriteBackHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method === 'GET') {
      const url = new URL(req.url ?? '', 'http://localhost')
      const requirementKey = url.searchParams.get('requirementKey') ?? ''
      if (!requirementKey) {
        sendError(res, 400, 'requirementKey 必填')
        return
      }
      const board = api.getBoard()
      const requirement = board.requirements.find(r => `${r.id}@${r.collection}` === requirementKey)
      sendJson(res, 200, { ok: true, requirementKey, report: requirement?.writeBack ?? null })
      return
    }
    if (req.method !== 'POST') {
      res.setHeader('allow', 'GET, POST')
      sendError(res, 405, '仅支持 GET / POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const value = (typeof body.value === 'object' && body.value !== null ? body.value : {}) as Record<string, unknown>
    const requirementKey = value['requirementKey']
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      sendError(res, 400, 'requirementKey 必填')
      return
    }
    const result = await api.writeBackRequirement({
      requirementKey,
      ...(value['force'] === true ? { force: true } : {}),
    })
    sendJson(res, 200, result)
  }
}

/**
 * 确保需求有编排主 agent 会话的处理器（spec 010 US1）。
 *
 * POST body `{ requirementKey, force? }` ⇒ `{ ok, orchestration?, reason? }`。
 * 幂等（已存在 continuable 会话则原样返回）；游 downgrade 时返回 `mode:'off'` + 可读原因，
 * 由 UI 如实展示 —— 这里**不**把降级伪装成成功。
 */
export function createOrchestratorEnsureHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const value = (typeof body.value === 'object' && body.value !== null ? body.value : {}) as Record<string, unknown>
    const requirementKey = value['requirementKey']
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      sendError(res, 400, 'requirementKey 必填')
      return
    }
    const result = await api.orchestratorEnsure({
      requirementKey,
      ...(value['force'] === true ? { force: true } : {}),
    })
    sendJson(res, 200, result)
  }
}

/**
 * 开始编排处理器（2026-11-03 问题 4/5）。
 *
 * POST body `{ requirementKey, mode: 'now'|'at', dueAt?, sequential? }`：
 * 'now' = 立刻按依赖顺序启动子 Agent 链；'at' = 登记定时（精确到分，持久化 + 重启补跑）。
 */
export function createOrchestrationStartHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler(async (body, res) => {
    const requirementKey = body['requirementKey']
    if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
      sendError(res, 400, 'requirementKey 必填')
      return
    }
    const mode = body['mode'] === 'at' ? 'at' : 'now'
    sendJson(
      res,
      200,
      await api.orchestrationStart({
        requirementKey,
        mode,
        ...(typeof body['dueAt'] === 'string' ? { dueAt: body['dueAt'] } : {}),
        ...(body['sequential'] === true ? { sequential: true } : {}),
      }),
    )
  })
}

/** 定时执行清单处理器（GET）。 */
export function createSchedulesHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'GET') {
      res.setHeader('allow', 'GET')
      sendError(res, 405, '仅支持 GET')
      return
    }
    sendJson(res, 200, { ok: true, entries: api.listSchedules() })
  }
}

/** 取消定时执行处理器（POST body `{ id }`）。 */
export function createScheduleCancelHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const id = body['id']
    if (typeof id !== 'string' || id.length === 0) {
      sendError(res, 400, 'id 必填')
      return
    }
    const cancelled = api.cancelSchedule(id)
    sendJson(res, 200, { ok: cancelled, ...(cancelled ? {} : { reason: '无此调度条目（可能已触发或已取消）' }) })
  })
}

/**
 * 修改定时执行到点时刻处理器（POST body `{ id, dueAt }`；2026-11-03 问题 3）。
 * 同 id 重登记语义：覆盖旧条目并重新武装定时器。
 */
export function createScheduleUpdateHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return postJsonHandler((body, res) => {
    const id = body['id']
    const dueAt = body['dueAt']
    if (typeof id !== 'string' || id.length === 0) {
      sendError(res, 400, 'id 必填')
      return
    }
    if (typeof dueAt !== 'string' || dueAt.length === 0) {
      sendError(res, 400, 'dueAt 必填（ISO 8601，精确到分）')
      return
    }
    sendJson(res, 200, api.updateSchedule(id, dueAt))
  })
}

/** 确认回写处理器。 */
export function createConfirmWriteHandler(
  api: HostApi,
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const value = body.value as Partial<ConfirmWriteInput> | null
    if (typeof value !== 'object' || value === null) {
      sendError(res, 400, '请求体必须是 JSON 对象')
      return
    }
    if (!Array.isArray(value.ops)) {
      sendError(res, 400, 'ops 必须是数组')
      return
    }
    const result: ConfirmWriteResult = await api.confirmWrite({
      ops: value.ops,
      targetWorkItem: typeof value.targetWorkItem === 'string' ? value.targetWorkItem : '—',
      collection: typeof value.collection === 'string' ? value.collection : '',
    })
    sendJson(res, 200, result)
  }
}

/** 发起执行处理器。 */
export function createDispatchHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    if (req.method !== 'POST') {
      res.setHeader('allow', 'POST')
      sendError(res, 405, '仅支持 POST')
      return
    }
    const body = await readJsonBody(req)
    if (!body.ok) {
      sendError(res, body.error === 'too_large' ? 413 : 400, '请求体不是合法 JSON 或过大')
      return
    }
    const value = body.value as Partial<DispatchInput> | null
    if (typeof value !== 'object' || value === null) {
      sendError(res, 400, '请求体必须是 JSON 对象')
      return
    }
    if (typeof value.targetWorkItem !== 'string' || value.targetWorkItem.length === 0) {
      sendError(res, 400, 'targetWorkItem 必填')
      return
    }
    if (value.draft === undefined || typeof value.draft !== 'object') {
      sendError(res, 400, 'draft 必填')
      return
    }
    const result: DispatchResult = await api.dispatch({
      draft: value.draft,
      targetWorkItem: value.targetWorkItem,
      collection: typeof value.collection === 'string' ? value.collection : '',
      ...(typeof (value as { taskId?: unknown }).taskId === 'string'
        ? { taskId: (value as { taskId: string }).taskId }
        : {}),
    })
    sendJson(res, 200, result)
  }
}

/** 宿主 webServer 服务的最小面（结构类型，不 import 具体包）。 */
interface WebServerContext {
  webServer: RawRouteHost
  get(name: string): unknown
}

/**
 * 注册本插件全部 HTTP 路由。
 *
 * 用 `ctx.inject(['webServer'], ...)` 而非静态 `inject`：宿主没有 web 服务（headless / TUI）
 * 时插件照常加载，只是没有按钮端点，工具的读取链路仍可用（沿用 dsh-optimized-prompt 装配纪律）。
 *
 * @param ctx - 宿主上下文。
 * @param api - 宿主半编排实例。
 */
export function registerTfsRoutes(ctx: Context, api: HostApi): void {
  ctx.inject(['webServer'], (webCtx) => {
    const host = webCtx as unknown as WebServerContext
    const web = guardedWebServer(host.webServer, () => host.get('connection') as BrowserRequestGate | undefined)
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.panelData, handler: createPanelDataHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.panelData}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.catalogRefresh, handler: createCatalogRefreshHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.catalogRefresh}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.confirmWrite, handler: createConfirmWriteHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.confirmWrite}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.dispatch, handler: createDispatchHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.dispatch}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.requirements, handler: createRequirementsHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.requirements}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.queryOptions, handler: createQueryOptionsHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.queryOptions}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.queryOptionsRefresh, handler: createQueryOptionsRefreshHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.queryOptionsRefresh}`,
    )
    // 问题 1：可选项落盘（GET 读盘 / POST 重采落盘）。
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.queryOptionsLoad, handler: createQueryOptionsLoadHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.queryOptionsLoad}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.queryOptionsCollect, handler: createQueryOptionsCollectHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.queryOptionsCollect}`,
    )
    // 问题 2/4/6：UI 状态（筛选记忆/每页条数）。
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.uiState, handler: createUiStateHandler(api) }),
      `tfs-requirment: GET/POST ${TFS_ROUTES.uiState}`,
    )
    // 问题 7/8/11：还原需求 / 补全四段 / 删除已取消任务。
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.requirementRestore, handler: createRequirementRestoreHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.requirementRestore}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.requirementEnrich, handler: createRequirementEnrichHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.requirementEnrich}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.taskDelete, handler: createTaskDeleteHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.taskDelete}`,
    )
    // 问题 3/4：需求本地字段编辑 / 任务字段编辑。
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.requirementUpdate, handler: createRequirementUpdateHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.requirementUpdate}`,
    )
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: TFS_ROUTES.requirementExecState,
          handler: createRequirementExecStateHandler(api),
        }),
      `tfs-requirment: POST ${TFS_ROUTES.requirementExecState}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.taskUpdate, handler: createTaskUpdateHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.taskUpdate}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.roles, handler: createRolesListHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.roles}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.roleSave, handler: createRoleSaveHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.roleSave}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.roleDelete, handler: createRoleDeleteHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.roleDelete}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.skillGroups, handler: createSkillGroupsListHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.skillGroups}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.skillGroupSave, handler: createSkillGroupSaveHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.skillGroupSave}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.skillGroupDelete, handler: createSkillGroupDeleteHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.skillGroupDelete}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.board, handler: createBoardHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.board}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.claim, handler: createClaimHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.claim}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.decompose, handler: createDecomposeHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.decompose}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.taskAssign, handler: createTaskAssignHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.taskAssign}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.taskState, handler: createTaskStateHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.taskState}`,
    )
    // spec 006 US2/US3：任务执行过程轨迹（GET）+ 任务追问（POST）。
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.taskTrace, handler: createTaskTraceHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.taskTrace}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.taskFollowUp, handler: createTaskFollowUpHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.taskFollowUp}`,
    )
    // 问题 4：需求完成自动回写（GET 读报告 / POST 触发或强制重跑）。
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: TFS_ROUTES.requirementWriteBack,
          handler: createRequirementWriteBackHandler(api),
        }),
      `tfs-requirment: GET/POST ${TFS_ROUTES.requirementWriteBack}`,
    )
    // spec 010：确保需求有编排主 agent 会话（幂等）。
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: TFS_ROUTES.orchestratorEnsure,
          handler: createOrchestratorEnsureHandler(api),
        }),
      `tfs-requirment: POST ${TFS_ROUTES.orchestratorEnsure}`,
    )
    // 2026-11-03 问题 4/5：开始编排（立刻/定时）+ 调度清单与取消。
    ctx.effect(
      () =>
        web.register({
          kind: 'exact',
          path: TFS_ROUTES.orchestrationStart,
          handler: createOrchestrationStartHandler(api),
        }),
      `tfs-requirment: POST ${TFS_ROUTES.orchestrationStart}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.schedules, handler: createSchedulesHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.schedules}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.scheduleCancel, handler: createScheduleCancelHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.scheduleCancel}`,
    )
    // 2026-11-03 问题 3：修改定时执行的到点时刻。
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.scheduleUpdate, handler: createScheduleUpdateHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.scheduleUpdate}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.health, handler: createHealthHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.health}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.audit, handler: createAuditHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.audit}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.auditArchive, handler: createAuditArchiveHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.auditArchive}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.collection, handler: createCollectionHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.collection}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.profiles, handler: createProfilesHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.profiles}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.profileSave, handler: createProfileSaveHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.profileSave}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.profileDelete, handler: createProfileDeleteHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.profileDelete}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.profileActivate, handler: createProfileActivateHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.profileActivate}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.mcpInstance, handler: createMcpInstanceHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.mcpInstance}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.mcpEnvFile, handler: createMcpEnvFileHandler(api) }),
      `tfs-requirment: POST ${TFS_ROUTES.mcpEnvFile}`,
    )
    ctx.effect(
      () => web.register({ kind: 'exact', path: TFS_ROUTES.tfsTools, handler: createTfsToolsHandler(api) }),
      `tfs-requirment: GET ${TFS_ROUTES.tfsTools}`,
    )
  })
}

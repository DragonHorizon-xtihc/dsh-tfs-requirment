/**
 * TFS 连通性自检（US1 / T029）+ MCP 工具可用性盘点（T028b）。
 *
 * **为什么单独成文件**：这段逻辑有两个必须被单测锁定的安全契约——
 *   1. **错误不得含凭据片段**（T033 / CHK002）：TFS 的报错可能回显请求 URL（含 `?token=`）
 *      或 `Authorization` 头，本模块在返回前统一擦除，绝不把凭据透出到面板/日志；
 *   2. **失败必须归类**（T029）：把底层错误映射为 认证 / 地址 / 权限 / 未知 四类，
 *      让用户知道该改 PAT、还是改 URL、还是找管理员，而不是看一坨堆栈。
 *
 * 只读：仅调用 `tfs_whoami` / `tfs_get_current_collection` / `tfs_get_projects`，
 * 不触发任何写操作。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/health
 */

import type { HealthResult } from '../shared/contracts.js'
import { scrubCredentials } from '../shared/redact.js'

// 擦除实现位于 shared/redact.ts（tfs/adapter 的写失败路径也要用同一份规则，见该文件注释）。
export { scrubCredentials }

/** 连通性探测所需的最小 adapter 面。 */
export interface HealthProbePort {
  whoami(): Promise<unknown>
  getCurrentCollection(): Promise<unknown>
  getProjects(args?: unknown): Promise<unknown>
  /**
   * 传输层告警（可选）。
   *
   * 真实实现为 `TfsAdapter.transportNotice`：基址是 `http:` 时 PAT 仅以 base64
   * （可逆）过网。自检结论不受影响（连通性由 whoami 定），但告警要透给面板，
   * 否则用户无从得知自己在用明文信道送凭据。
   */
  transportNotice?(): string | undefined
}

/**
 * 本插件运行期依赖的**操作键**清单（用于 T028b「缺失操作」可见）。
 *
 * REST 化（2026-09-19）后这些键不再是"某个 MCP 实例注册的工具名"，而是
 * `adapter.call(raw, args)` 的分派键；运行期传入的 `availableTools` 实为
 * `IMPLEMENTED_OPERATIONS`（适配层已实现 REST 分支的操作集）。
 * 取值保留 `tfs_*` 形态是为了与契约表 `TFS_TOOL_SPECS` 的 `raw` 一一对齐。
 */
export const EXPECTED_TFS_TOOLS: readonly string[] = [
  'tfs_whoami',
  'tfs_get_current_collection',
  'tfs_get_projects',
  'tfs_get_workitem',
  'tfs_get_work_items',
  // 列表主出口（2026-09-17 实测：custom_query / get_work_items 恒报 expand+fields 冲突，已弃用）。
  'tfs_query_wiql',
  'tfs_search_work_items',
  'tfs_get_my_tasks',
  // TFVC / 变更集关联（T051，本轮工具目录已出现）。
  'tfs_list_tfvc_changesets',
  'tfs_get_tfvc_changeset',
  'tfs_get_work_item_commits',
  'tfs_add_tags',
  'tfs_change_state',
  'tfs_add_comment',
  'tfs_assign',
  'tfs_create_workitem',
] as const

/**
 * 归类 TFS 连通性错误（T029）。
 * @param message - 原始错误消息。
 * @returns 类别 + 可读原因（已擦除凭据）。
 */
export function classifyTfsError(message: string): { kind: HealthResult['kind']; reason: string } {
  const safe = scrubCredentials(message)
  const m = message.toLowerCase()
  if (/\b401\b|unauthor|not\s*authenticated|invalid\s*token|tf400813|身份验证|未授权/.test(m)) {
    return { kind: 'auth', reason: `认证失败：PAT 无效、过期或权限不足。请检查凭据配置。（${safe}）` }
  }
  if (/\b403\b|forbidden|denied|tf401019|权限/.test(m)) {
    return { kind: 'permission', reason: `权限不足：当前身份无权访问该集合/项目。请联系管理员授权。（${safe}）` }
  }
  if (
    /enotfound|econnrefused|econnreset|etimedout|eai_again|getaddrinfo|socket hang up|\b404\b|\b414\b|failed request/.test(
      m,
    )
  ) {
    return { kind: 'address', reason: `无法访问 TFS 地址：请检查服务器地址与网络连通性。（${safe}）` }
  }
  return { kind: 'unknown', reason: safe }
}

/** 从 `tfs_whoami` 返回值里提取身份摘要（形状未强约束，尽力取值）。 */
function identityOf(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  const pick = ['displayName', 'name', 'uniqueName', 'identity', 'user']
  for (const k of pick) {
    const v = o[k]
    if (typeof v === 'string' && v.length > 0) {
      const unique = typeof o['uniqueName'] === 'string' ? ` <${o['uniqueName']}>` : ''
      return `${v}${unique}`
    }
  }
  return undefined
}

/** 从 `tfs_get_current_collection` 返回值里提取集合名。 */
function collectionNameOf(raw: unknown): string | undefined {
  if (typeof raw === 'string') return raw
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  for (const k of ['name', 'collection', 'displayName']) {
    if (typeof o[k] === 'string' && (o[k] as string).length > 0) return o[k] as string
  }
  return undefined
}

/** 从 `tfs_get_projects` 返回值里统计项目数。 */
function projectCountOf(raw: unknown): number | undefined {
  if (Array.isArray(raw)) return raw.length
  if (raw === null || typeof raw !== 'object') return undefined
  const o = raw as Record<string, unknown>
  if (Array.isArray(o['projects'])) return o['projects'].length
  if (Array.isArray(o['value'])) return o['value'].length
  return undefined
}

/**
 * 执行连通性自检（T029）+ 工具可用性盘点（T028b）。
 *
 * @param port - 探测面（真实为 TfsAdapter，测试可打桩）。
 * @param availableTools - 适配层已实现 REST 分支的操作键（不含 `mcp__<server>__` 前缀）。
 * @returns 自检结果（失败也返回 200 语义的对象，UI 据此渲染红/绿）。
 */
export async function runHealthCheck(
  port: HealthProbePort,
  availableTools?: readonly string[],
): Promise<HealthResult> {
  const tools = availableTools
    ? {
        available: [...availableTools].sort(),
        missing: EXPECTED_TFS_TOOLS.filter(t => !availableTools.includes(t)),
      }
    : undefined

  let identity: string | undefined
  let collection: string | undefined
  let projectCount: number | undefined
  /** 传输层告警与连通性无关（http 明文信道），两条出口都要带上。 */
  let notice: string | undefined
  try {
    notice = port.transportNotice?.()
  } catch (e) {
    // 读取告警失败不得让自检失败：它只是提示，不是结论。
    notice = `读取传输层告警失败：${scrubCredentials((e as Error).message)}`
  }

  try {
    identity = identityOf(await port.whoami())
  } catch (e) {
    const { kind, reason } = classifyTfsError((e as Error).message ?? String(e))
    return {
      ok: false,
      kind,
      reason,
      ...(notice ? { notice } : {}),
      ...(tools ? { tools } : {}),
    }
  }

  // 集合与项目是"附加信息"：失败不改变连通性结论（whoami 已通过即算连通）。
  try {
    collection = collectionNameOf(await port.getCurrentCollection())
  } catch {
    collection = undefined
  }
  try {
    projectCount = projectCountOf(await port.getProjects({}))
  } catch {
    projectCount = undefined
  }

  return {
    ok: true,
    ...(notice ? { notice } : {}),
    ...(identity ? { identity } : {}),
    ...(collection ? { collection } : {}),
    ...(projectCount !== undefined ? { projectCount } : {}),
    ...(tools ? { tools } : {}),
  }
}

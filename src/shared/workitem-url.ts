/**
 * TFS 工作项**网页地址**的构造（需求池/任务中心标题直达 TFS）。
 *
 * ## 目标形态
 *
 * ```
 * {地址}/{集合}/{团队项目}/_workitems?id={需求号}&_a=edit
 * ```
 * 例：`http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/体检管理/_workitems?id=1997179&_a=edit`
 *
 * ## 为什么放在这里（而不是组件里或宿主半）
 *
 * 1. **客户端半没有 React 测试库**（项目既有纪律），只有纯函数能被 vitest 覆盖；
 * 2. 拼接规则本身有若干分支（REST url 解析 / 档案兜底 / 缺字段 / scheme 校验），
 *    塞在 JSX 里既测不到也改不动；
 * 3. 本模块**不碰 DOM**，`src/shared` 被宿主半编译时（无 DOM lib）也不会踩 `TS2584`。
 *
 * ## 数据来源（2026-09-20 实测，真实 TFS 2018）
 *
 * `RequirementSummary` 已经带着构造所需的全部信息：
 *   - `url`      = `http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/1997179`
 *                  （`src/tfs/adapter.ts:2546` 原样取 TFS 响应字段）
 *   - `project`  = `体检管理`（`System.TeamProject`，`src/tfs/adapter.ts:2534`）
 *   - `collection` = `WN_HIS`
 *
 * 关键点：`url` 里 `/_apis/` **之前**的部分正好是「地址 + 集合」，因此**不需要**
 * 新增任何宿主路由或 TFS 调用即可算出网页地址。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/workitem-url
 */

/** 构造工作项网页地址的入参。 */
export interface WorkItemLinkInput {
  /** 工作项号（正整数）。 */
  id: number
  /**
   * 需求摘要里 TFS 给的 REST url（含 `/_apis/`）。
   * **首选数据源**：它同时携带"地址"与"集合"，最不容易与当前档案脱节。
   */
  restUrl?: string
  /** 团队项目名（可能含中文，会被 `encodeURIComponent`）。 */
  project?: string
  /** 兜底：服务地址（**不含集合**，来自活动档案的 `ProfileView.url`）。 */
  baseUrl?: string
  /** 兜底用的集合名（`baseUrl` 同时给出时才有效）。 */
  collection?: string
}

/** 是否为 `http` / `https`（其它 scheme 一律不接受）。 */
export function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value.trim())
}

/** 去掉结尾多余斜杠。 */
function trimTrailingSlash(value: string): string {
  return value.trim().replace(/\/+$/, '')
}

/**
 * 由 REST url 解析出「地址 + 集合」前缀（`/_apis/` 之前的部分）。
 *
 * @param restUrl - TFS 工作项的 REST url。
 * @returns 前缀；不含 `/_apis/` 或非法 scheme 时返回 `undefined`。
 */
export function baseFromRestUrl(restUrl: string | undefined): string | undefined {
  const raw = (restUrl ?? '').trim()
  if (!raw) return undefined
  const at = raw.toLowerCase().indexOf('/_apis/')
  if (at <= 0) return undefined
  const base = trimTrailingSlash(raw.slice(0, at))
  return isHttpUrl(base) ? base : undefined
}

/**
 * 构造工作项的 TFS 网页地址（编辑页）。
 *
 * ## 失败口径（重要）
 *
 * **任何一段拿不到就返回 `undefined`**，由调用方渲染成纯文本 ——
 * 绝不产出半截 URL、也不拿占位符糊弄：一个打不开的链接比一段纯文本更糟，
 * 因为它把"数据缺失"伪装成了"功能正常"。
 *
 * @param input - 见 {@link WorkItemLinkInput}。
 * @returns 完整网页地址；构造不出时返回 `undefined`。
 */
export function buildWorkItemUrl(input: WorkItemLinkInput): string | undefined {
  if (!Number.isInteger(input.id) || input.id <= 0) return undefined

  // 1) 首选：从工作项自带的 REST url 解出「地址 + 集合」。
  const fromRest = baseFromRestUrl(input.restUrl)
  let base = fromRest
  // 2) 兜底：活动档案 url + 集合（历史 board.json 条目可能没有 url）。
  if (base === undefined && input.baseUrl !== undefined && input.collection !== undefined) {
    const b = trimTrailingSlash(input.baseUrl)
    const c = trimTrailingSlash(input.collection)
    if (b && c && isHttpUrl(b)) base = `${b}/${c}`
  }
  if (base === undefined) return undefined

  // 团队项目是路径段且可能是中文（实测「体检管理」），必须编码。
  const project = (input.project ?? '').trim()
  if (!project) return undefined

  return `${base}/${encodeURIComponent(project)}/_workitems?id=${input.id}&_a=edit`
}

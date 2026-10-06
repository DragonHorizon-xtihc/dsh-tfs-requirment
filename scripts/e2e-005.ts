/**
 * E2E-005：需求池 / 任务中心标题直达 TFS 需求页（真实数据逐字符验证）。
 *
 * ## 为什么用真实载荷
 *
 * 这个功能的全部风险不在拼接逻辑（那是纯函数，已单测），而在于
 * **"真实 TFS 响应里的 `url` / `project` / `collection` 到底长什么样"** ——
 * 只要字段名或形态理解错，拼出来的就是打不开的地址。因此本脚本：
 *
 *  1. 用 `tests/fixtures/tfs-workitem-1997179-real.json`（2026-09-18 实抓的真实工作项载荷），
 *     经**真实的 `TfsAdapter.normalizeWorkItem`** 归一化（不是手搓对象）；
 *  2. 再读**真实落盘的 `board.json`**（1997179@WN_HIS）作为第二个独立来源；
 *  3. 两条来源都断言拼出的地址 == 用户给的目标样例（解码后逐字符）。
 *
 * 不连 TFS、不写任何数据。
 *
 * 运行：`node <repo>/node_modules/tsx/dist/cli.mjs scripts/e2e-005.ts`
 *
 * @module @deepseek-ai/dsh-tfs-requirment/scripts/e2e-005
 */

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { normalizeWorkItem } from '../src/tfs/adapter.js'
import { buildWorkItemUrl } from '../src/shared/workitem-url.js'
import type { RequirementSummary } from '../src/shared/contracts.js'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** 用户给出的目标地址（需求 #1997179，集合 WN_HIS，团队项目 体检管理）。 */
const EXPECTED =
  'http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/体检管理/_workitems?id=1997179&_a=edit'
/** 活动档案的服务地址（不含集合）—— 兜底路径用。 */
const BASE_URL = 'http://tfs2018-web.winning.com.cn:8080/tfs'

const results: Array<{ step: string; ok: boolean; detail: string }> = []
let failures = 0

function line(title: string): void {
  console.log(`\n${'='.repeat(78)}\n${title}\n${'='.repeat(78)}`)
}
function check(step: string, ok: boolean, detail: string): void {
  results.push({ step, ok, detail })
  if (!ok) failures += 1
  console.log(`  ${ok ? '✅' : '❌'} [${step}] ${detail}`)
}
function show(label: string, value: unknown): void {
  console.log(`  · ${label}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
}

/** 由需求摘要拼 TFS 网页地址（与组件里 `workItemUrl()` 同一条调用路径）。 */
function urlOf(r: RequirementSummary, baseUrl?: string): string | undefined {
  return buildWorkItemUrl({
    id: r.id,
    restUrl: r.url,
    project: r.project,
    baseUrl,
    collection: r.collection,
  })
}

/** 解码比对（项目名被 encodeURIComponent，解码后才是用户看到的原文）。 */
function decode(v: string | undefined): string {
  if (v === undefined) return ''
  try {
    return decodeURIComponent(v)
  } catch {
    return v
  }
}

async function main(): Promise<void> {
  line('步骤 1｜来源 A：真实 TFS 工作项载荷经真实 normalizeWorkItem 归一化')
  const fixturePath = join(pluginRoot, 'tests', 'fixtures', 'tfs-workitem-1997179-real.json')
  const raw = JSON.parse(readFileSync(fixturePath, 'utf8')) as unknown
  const fromAdapter = normalizeWorkItem(raw, 'WN_HIS')
  show('id', fromAdapter.id)
  show('collection', fromAdapter.collection)
  show('project', fromAdapter.project)
  show('url', fromAdapter.url)
  check(
    'S1-a',
    fromAdapter.id === 1997179 && fromAdapter.collection === 'WN_HIS' && fromAdapter.project === '体检管理',
    `真实适配器产出 id/collection/project 符合预期（project=${fromAdapter.project}）`,
  )
  check(
    'S1-b',
    (fromAdapter.url ?? '').includes('/_apis/wit/workItems/1997179'),
    '真实 url 含 `/_apis/wit/workItems/{id}` —— 这正是"地址+集合"的来源',
  )

  const urlA = decode(urlOf(fromAdapter))
  show('拼出的地址（解码后）', urlA)
  check('S1-c', urlA === EXPECTED, '与用户给出的目标地址**逐字符一致**')

  line('步骤 2｜来源 B：真实落盘的 board.json（跨重启后仍可拼出链接）')
  //
  // ⚠️ board.json 里存的是**领域模型** `Requirement`（`workItemId`），不是 `RequirementSummary`（`id`）。
  // UI 拿到的是经 `requirementToSummary()` 转换后的形状（`src/host/board-service.ts`）；
  // 这里直接读文件，必须自己做同一次转换，否则 `id` 为 undefined 而拼不出地址
  // （这正是本步骤存在的意义：把"落盘 → 摘要 → 链接"整条链验一遍）。
  const boardPath = join(pluginRoot, '.tfs-requirment-data', 'board.json')
  let boardReq: RequirementSummary | undefined
  try {
    const board = JSON.parse(readFileSync(boardPath, 'utf8')) as {
      requirements?: Record<string, {
        workItemId: number
        collection: string
        project: string
        title: string
        url?: string
        state: string
        assignedTo: string
        priority: string
        iteration: string
        tags: string[]
        updatedAt: string
      }>
    }
    const r = board.requirements?.['1997179@WN_HIS']
    boardReq = r === undefined
      ? undefined
      : {
          id: r.workItemId,
          collection: r.collection,
          project: r.project,
          title: r.title,
          type: '',
          state: r.state,
          assignedTo: r.assignedTo,
          priority: r.priority,
          areaPath: '',
          iterationPath: r.iteration,
          tags: r.tags ?? [],
          changedDate: r.updatedAt,
          url: r.url ?? '',
        }
  } catch {
    boardReq = undefined
  }
  if (!boardReq) {
    check('S2-a', false, `board.json 里没有 1997179@WN_HIS（路径 ${boardPath}）`)
  } else {
    show('id（由 workItemId 转换）', boardReq.id)
    show('project', boardReq.project)
    show('url', boardReq.url)
    const urlB = decode(urlOf(boardReq))
    show('拼出的地址（解码后）', urlB)
    check('S2-a', urlB === EXPECTED, '从**落盘数据**拼出的地址同样逐字符一致（证明重启后仍可点）')
  }

  line('步骤 3｜兜底路径：无 REST url 时用「活动档案 url + 集合」')
  const noUrl: RequirementSummary = { ...fromAdapter, url: '' }
  const urlC = decode(urlOf(noUrl, BASE_URL))
  show('拼出的地址（解码后）', urlC)
  check('S3-a', urlC === EXPECTED, '兜底路径产出同一地址（历史条目缺 url 也能点）')

  line('步骤 4｜失败口径：拿不到完整信息时退回纯文本，不产出假链接')
  check('S4-a', urlOf({ ...fromAdapter, project: '' }) === undefined, '缺团队项目 → undefined（渲染回退纯文本）')
  check('S4-b', urlOf({ ...fromAdapter, url: '' }) === undefined, '既无 REST url 又无兜底 → undefined')
  check(
    'S4-c',
    urlOf({ ...fromAdapter, url: 'javascript:alert(1)/_apis/x' }) === undefined,
    '非 http/https 的 REST url 被拒（外部数据不能直接进 href）',
  )

  line('步骤 5｜编码形态：中文项目名可安全放进 href')
  const encoded = urlOf(fromAdapter)
  check(
    'S5-a',
    encoded === undefined ? false : encoded.includes('/%E4%BD%93%E6%A3%80%E7%AE%A1%E7%90%86/_workitems?id=1997179&_a=edit'),
    '项目名百分号编码，查询串 `?id=…&_a=edit` 保持原样',
  )

  line('结果汇总')
  for (const r of results) console.log(`  ${r.ok ? '✅' : '❌'} ${r.step}  ${r.detail}`)
  console.log(`\n合计 ${results.length} 项断言，失败 ${failures} 项。`)
  console.log(`目标地址：${EXPECTED}`)
  if (failures > 0) process.exitCode = 1
}

main().catch(error => {
  console.error('\n演练异常：', error)
  process.exitCode = 1
})

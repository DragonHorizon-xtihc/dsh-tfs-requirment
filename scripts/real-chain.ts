/**
 * 真实链路演练（第七轮：工作目录接线 E2E）。
 *
 * 目的：用**需求 #1997179 的真实 TFS 响应** + **真实本地代码库路径**，走完整的
 * 「领取 → 拆解 → 指派 → 渲染看板」，并证明 `workspace` 一路抵达派发 prompt。
 *
 * **不写 TFS**：`claim` 传 `tag:false` 显式关闭标签写入，且脚本对任何写调用计数并断言为 0。
 *
 * 数据真实性：
 *  - 需求载荷来自 `tests/fixtures/tfs-workitem-1997179-real.json`（2026-09-18 经
 *    `mcp__tfs-mcp__tfs_get_workitem` 实抓，扁平形态）；
 *  - 载荷经**真实的 `TfsAdapter.getRequirement`**（含 `normalizeWorkItem`）归一化，
 *    不是手搓对象；
 *  - `workspace` 是真实存在的目录，经**真实的 `statSync` 存在性/目录校验**。
 *
 * 运行：`node <host>/node_modules/tsx/dist/cli.mjs scripts/real-chain.ts`
 *
 * @module dsh-tfs-requirment/scripts/real-chain
 */

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Board } from '../src/core/board/board.js'
import { BoardService } from '../src/host/board-service.js'
import { TfsAdapter, type TfsTools } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { DEFAULT_ROLES } from '../src/orchestration/roles.js'
import { buildWorkspacePromptSection } from '../src/shared/workspace.js'
import { createMemFs } from '../tests/helpers/memfs.js'

/** 真实需求号（可用 `TFS_WORK_ITEM` 覆盖）。 */
const WORK_ITEM_ID = Number(process.env['TFS_WORK_ITEM'] ?? 1997179)
/** 真实集合（可用 `TFS_COLLECTION` 覆盖）。 */
const COLLECTION = process.env['TFS_COLLECTION'] ?? 'WN_HIS'
/**
 * 真实本地代码库路径（可用 `TFS_WORKSPACE` 覆盖）。
 *
 * 默认值是 2026-09-18 那次演练用的真实目录；写成 env 可覆盖是为了让脚本在别处也能跑，
 * 而不是把某台机器的目录结构固化进仓库。
 */
const WORKSPACE = process.env['TFS_WORKSPACE'] ?? 'D:\\体检管理\\6.0\\03 源代码\\60混合框架\\GIT60混合框架\\Winning.WiNEX.Plugins'

const here = dirname(fileURLToPath(import.meta.url))
const pluginRoot = join(here, '..')

/** 看板落盘目录（gitignored，不污染用户仓库）。 */
const BOARD_DIR = join(pluginRoot, '.tfs-requirment-data', 'real-board')

/** 写调用计数器（断言"不改 TFS"）。 */
const writeCalls: string[] = []

function line(title: string): void {
  console.log(`\n${'='.repeat(72)}\n${title}\n${'='.repeat(72)}`)
}

async function main(): Promise<void> {
  line('步骤 0｜准备：真实响应载荷 + 真实 adapter + 干净看板目录')

  const fixturePath = join(pluginRoot, 'tests', 'fixtures', 'tfs-workitem-1997179-real.json')
  const rawWorkItem = JSON.parse(readFileSync(fixturePath, 'utf8')) as Record<string, unknown>
  console.log(`载荷：${fixturePath}`)
  console.log(`  id=${rawWorkItem['id']}  state=${rawWorkItem['state']}  relations=${(rawWorkItem['relations'] as unknown[]).length}`)

  // 工具出口：只读工具按需供给；**任何写工具都记为一次写调用**并拒绝，用于证明不改 TFS。
  // 严格实现真实 `ToolRuntime.execute` 契约（工具不是服务属性），返回 tfs-mcp 的 MCP 文本信封，
  // 以便演练同时覆盖 `unwrapToolValue()` 的解包路径。
  const READ_TOOLS: Record<string, unknown> = {
    tfs_get_workitem: rawWorkItem,
    tfs_whoami: { name: 'zhangbo3(张波)', account: 'WINNING\\zhangbo3' },
  }
  const tools: TfsTools = {
    execute(exec) {
      const raw = exec.name.replace(/^mcp__tfs-mcp__/, '')
      if (!(raw in READ_TOOLS)) {
        writeCalls.push(`${raw} ${JSON.stringify(exec.arguments)}`)
        // 真实宿主不会因"脚本不允许写"而抛错；这里用等价的 isError 失败表达同样的拒绝。
        return Promise.resolve({
          isError: true,
          error: { message: `演练脚本禁止写 TFS：${raw}` },
        })
      }
      return Promise.resolve({
        isError: false,
        value: { content: [{ type: 'text', text: JSON.stringify(READ_TOOLS[raw], null, 2) }] },
      })
    },
    schemas: () =>
      Object.keys(READ_TOOLS).map(name => ({ name: `mcp__tfs-mcp__${name}` })),
    // `register()` 只写 ctx.tools 的内部 layers，**不是服务属性**（`Object.keys(ctx.tools)` 恒空）；
    // REST 化后插件已不注册任何 mcp 工具，这里给出等价 no-op 桩以满足 `TfsTools` 接口。
    register: () => undefined,
  }

  const auditFs = createMemFs()
  const adapter = new TfsAdapter({
    tools,
    writeGuard: new WriteGuard(new AuditLog('/mem/audit', auditFs)),
    collection: COLLECTION,
    profileLabel: 'tfs-mcp',
  })

  // 清空上次演练产物（只动插件自有的 gitignored 目录，不碰用户仓库）。
  rmSync(BOARD_DIR, { recursive: true, force: true })
  mkdirSync(BOARD_DIR, { recursive: true })

  const board = new Board()
  const svc = new BoardService({
    baseDir: BOARD_DIR,
    board,
    adapter,
    roles: { list: () => DEFAULT_ROLES, getByName: n => DEFAULT_ROLES.find(r => r.name === n) },
    defaultLabel: 'dsh',
  })

  line('步骤 1｜归一化：真实响应 → RequirementSummary（走真实 adapter 代码路径）')

  const summary = await adapter.getRequirement(WORK_ITEM_ID, COLLECTION)
  console.log(JSON.stringify(summary, null, 2))

  line('步骤 2｜领取：携带真实本地路径，fail-loud 校验（tag:false ⇒ 不写 TFS）')

  const claim = await svc.claimRequirement({
    requirement: summary,
    workspace: WORKSPACE,
    tag: false,
  })
  console.log(JSON.stringify(claim, null, 2))
  if (!claim.ok) throw new Error(`领取失败：${claim.reason}`)
  console.log(`\n✓ 需求已入池，workspace = ${claim.requirement?.workspace}`)

  line('步骤 3｜拆解：三段式任务（DAG），验证 workspace 被任务继承')

  const decompose = svc.decompose(`${WORK_ITEM_ID}@${COLLECTION}`)
  console.log(JSON.stringify(decompose, null, 2))
  if (!decompose.ok) throw new Error(`拆解失败：${decompose.reason}`)

  const tasksAfterDecompose = svc.listTasks({ requirementId: `${WORK_ITEM_ID}@${COLLECTION}` })
  for (const t of tasksAfterDecompose) {
    console.log(`  · ${t.taskId.padEnd(46)} role=${t.roleAgent.padEnd(8)} blockedBy=[${t.blockedBy.join(', ')}] workspace=${t.workspace ?? '—'}`)
  }

  line('步骤 4｜指派：改派 impl 任务给「开发」角色')

  const implTaskId = `${WORK_ITEM_ID}@${COLLECTION}#impl`
  const assign = svc.assignTask(implTaskId, DEFAULT_ROLES.find(r => r.id === 'role-coder')!.name)
  console.log(JSON.stringify(assign, null, 2))

  line('步骤 5｜派发 prompt：workspace 作为任务上下文注入（确认子代理能看到路径）')

  const target = svc.listTasks({ requirementId: `${WORK_ITEM_ID}@${COLLECTION}` }).find(t => t.taskId === implTaskId)!
  const wsSection = buildWorkspacePromptSection({
    workspace: target.workspace,
    taskTitle: target.title,
    workItemId: WORK_ITEM_ID,
    collection: COLLECTION,
  })
  console.log('---- 注入到派发 prompt 的前置段落 ----')
  console.log(wsSection)
  console.log('-------------------------------------')

  line('步骤 6｜落盘：JSON 权威 + Markdown 渲染')

  const rendered = svc.renderMarkdown()
  console.log(JSON.stringify(rendered, null, 2))
  const md = svc.readMarkdown()
  console.log('\n---- .ai-board/计划看板.md ----')
  console.log(md)

  line('步骤 7｜断言')

  const failures: string[] = []
  const boardJson = JSON.parse(readFileSync(join(BOARD_DIR, 'board.json'), 'utf8')) as {
    tasks: Record<string, { workspace?: string }>
    requirements: Record<string, { workspace?: string }>
  }

  if (writeCalls.length !== 0) failures.push(`发生了 ${writeCalls.length} 次 TFS 写调用：${writeCalls.join('; ')}`)
  if (boardJson.requirements[`${WORK_ITEM_ID}@${COLLECTION}`]?.workspace !== WORKSPACE) {
    failures.push('board.json 中需求未带正确的 workspace')
  }
  for (const t of tasksAfterDecompose) {
    if (t.workspace !== WORKSPACE) failures.push(`任务 ${t.taskId} 未继承 workspace`)
  }
  if (!wsSection.includes(WORKSPACE)) failures.push('派发 prompt 段未包含 workspace 路径')
  if (!rendered.ok) failures.push('Markdown 渲染失败')

  console.log(`TFS 写调用次数：${writeCalls.length}（期望 0）`)
  console.log(`看板目录：${BOARD_DIR}`)
  console.log(`产物：board.json / events.jsonl / .ai-board/计划看板.md`)

  if (failures.length > 0) {
    console.log('\n✗ 演练失败：')
    for (const f of failures) console.log(`  - ${f}`)
    process.exitCode = 1
    return
  }
  console.log('\n✓ 真实链路演练全部通过：领取 → 拆解 → 指派 → 渲染，workspace 全程携带，TFS 零写入。')

  // 供验收清单引用的摘要文件。
  writeFileSync(
    join(BOARD_DIR, 'real-chain-summary.json'),
    JSON.stringify(
      {
        workItemId: WORK_ITEM_ID,
        collection: COLLECTION,
        workspace: WORKSPACE,
        taskIds: decompose.taskIds,
        tfsWriteCalls: writeCalls.length,
        promptSection: wsSection,
      },
      null,
      2,
    ),
    'utf8',
  )
}

main().catch(e => {
  console.error(e)
  process.exitCode = 1
})

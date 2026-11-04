/**
 * 「本地代码库路径」（workspace）的规范化与校验（本地补充字段，非 TFS 字段）。
 *
 * 设计依据 —— **宿主能力边界（已核实源码）**：
 * `@deepseek-ai/dsh-subagent/src/out-of-process.d.ts` 的 `resolveChildCwd(prefix, configured, parentCwd)`
 * 说明子代理工作目录的来源只有两条：**部署级 config override**，否则**父会话的 workspace cwd**；
 * 且 `SubagentStartRequest`（`src/types.d.ts:91`）**没有任何 cwd/workspace 字段**。
 * 因此插件**无法**为某个任务指定子代理进程的工作目录。
 *
 * 本模块的职责因此收敛为三件事（不夸大）：
 * 1. **规范化**用户输入的路径（去空白、去尾分隔符）；
 * 2. **fail loud 校验**：必须是绝对路径、且真实存在且是目录 —— 与宿主 `assertUsableCwd` 同哲学
 *    （"在进程边界之前失败，而不是变成一个含糊的 spawn ENOENT"）；
 * 3. 把该路径作为**任务上下文**交给角色智能体（写进派发 prompt），并在看板/UI 可见。
 *
 * @module dsh-tfs-requirment/shared/workspace
 */

/**
 * 是否为绝对路径（跨平台）。
 * - Windows 盘符：`C:\...` / `C:/...`
 * - Windows UNC：`\\server\share`
 * - POSIX：`/...`
 *
 * @param p - 候选路径。
 * @returns 绝对路径返回 true。
 */
export function isAbsolutePath(p: string): boolean {
  return /^[A-Za-z]:[\\/]/.test(p) || /^\\\\/.test(p) || p.startsWith('/')
}

/**
 * 规范化路径：去首尾空白；去掉**非根**的尾部路径分隔符（`D:\a\` → `D:\a`，`/` 保持 `/`）。
 *
 * @param p - 原始输入。
 * @returns 规范化后的路径。
 */
export function normalizeWorkspace(p: string): string {
  const t = (p ?? '').trim()
  if (t.length === 0) return ''
  // 仅盘符根（`C:\`）或 POSIX 根（`/`）保留其分隔符。
  if (/^[A-Za-z]:[\\/]$/.test(t) || t === '/' || /^\\\\$/.test(t)) return t
  return t.replace(/[\\/]+$/, '')
}

/**
 * 纯校验：路径本身是否可用作代码库根（不触碰文件系统）。
 *
 * @param p - 候选路径（可含空白）。
 * @returns 通过返回 `undefined`；否则返回可读原因。
 */
export function workspaceIssue(p: string): string | undefined {
  const t = (p ?? '').trim()
  if (t.length === 0) return '代码库路径不可为空'
  if (!isAbsolutePath(t)) {
    return `代码库路径必须是绝对路径（收到「${t}」）。相对路径会被锚定到宿主进程启动目录，语义不可控`
  }
  return undefined
}

/** 组装一段"任务上下文"文本，供派发 prompt 使用。 */
export interface WorkspaceContextInput {
  /** 规范化后的绝对路径；为空则不产出上下文。 */
  workspace?: string
  /** 任务标题（用于措辞）。 */
  taskTitle?: string
  /** 需求号（用于措辞）。 */
  workItemId?: number
  /** 集合名。 */
  collection?: string
}

/**
 * 生成派发 prompt 里的一段工作目录**硬约束**。
 *
 * ## 为什么是"硬约束 + 可执行动作"，而不是一句"代码库位于 X"
 *
 * 宿主没有 per-request cwd 通道（见本模块头部依据），子代理进程 cwd 恒等于父会话 workspace。
 * 于是"让子代理在指定目录干活"**只能**通过 prompt 落地 —— 而 prompt 只写"代码库位于 X"
 * 是无效的：模型会继续按进程 cwd（父会话工作区）去 glob/grep，产出与用户预期完全不同的工程
 * （2026-09-21 实机：任务工作区设为 `…\Winning.WiNEX.Plugins`，子代理仍在
 * `Winning.Tjgl.UI.Summary` 里找代码）。
 *
 * 有效写法必须给出**可执行动作**：
 *   - 文件工具一律用绝对路径（`<ws>\…`），不依赖进程 cwd；
 *   - shell 命令一律先 `cd`（Windows `cd /d`），再执行；
 *   - 显式禁止在父会话工作目录里"就近"找同名工程；
 *   - 目录不可访问时**停手上报**，而不是改到别的目录把活干完。
 *
 * 旧实现在这段里写了「宿主子代理进程的工作目录由…决定，插件不能按任务改变进程 cwd，
 * 若需让子进程 cwd 等于该路径，请把宿主会话/部署的 cwd 设为该路径」—— 那是给**开发者**
 * 的解释，模型读到只会得到"这个目录我做不了主"的结论，反而强化了"在 cwd 里干活"的行为。
 * 解释留在本注释里，prompt 只留动作。
 *
 * @param input - 上下文输入。
 * @returns prompt 文本；`workspace` 为空时返回空串（不产出噪声）。
 */
export function buildWorkspacePromptSection(input: WorkspaceContextInput): string {
  const ws = normalizeWorkspace(input.workspace ?? '')
  if (!ws) return ''
  const who = [
    input.workItemId !== undefined ? `工作项 #${input.workItemId}` : '',
    input.collection ? `集合 ${input.collection}` : '',
  ]
    .filter(Boolean)
    .join('、')
  const windowsPath = /^[A-Za-z]:[\\/]/.test(ws) || ws.startsWith('\\\\')
  const cdExample = windowsPath ? `cd /d "${ws}"` : `cd "${ws}"`
  return [
    '【工作目录（硬约束，必须遵守）】',
    `本任务对应的代码库根目录：${ws}`,
    who ? `（${who}${input.taskTitle ? `，任务：${input.taskTitle}` : ''}）` : '',
    '本任务的全部代码阅读、检索、修改与产物写出都必须发生在该目录内：',
    `1. 所有文件工具（read / write / edit / glob / grep 等）一律使用**绝对路径**，即以 \`${ws}\` 开头的完整路径；`,
    `2. 所有 shell 命令一律先切换目录再执行，例如 \`${cdExample} && <你的命令>\`；不要依赖进程的当前目录；`,
    '3. **不要**在当前会话的默认工作目录（父会话工作目录）中查找或修改本任务涉及的工程 —— 那里是会话的其它工作区，即使出现同名目录也不代表同一份代码；',
    '4. 若上述目录不存在或不可访问，请直接如实上报并停止，**不要**改到其它目录"就近"完成。',
  ]
    .filter(Boolean)
    .join('\n')
}

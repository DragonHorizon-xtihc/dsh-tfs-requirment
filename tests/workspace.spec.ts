import { describe, expect, it } from 'vitest'
import {
  buildWorkspacePromptSection,
  isAbsolutePath,
  normalizeWorkspace,
  workspaceIssue,
} from '../src/shared/workspace.js'

/**
 * 「本地代码库路径」纯函数单测（第七轮：工作目录接线）。
 *
 * 本模块是**纯函数**（不触碰文件系统），因此这里覆盖路径判定/规范化/校验/ prompt 组装的边界。
 * 存在性校验（`statSync`）不在本模块职责内，由 `board-service.spec.ts` 覆盖。
 *
 * 关键约束（来自宿主能力边界，见 `src/shared/workspace.ts` 头部）：
 * 插件无法改变子代理进程 cwd，`workspace` 只作为任务上下文写进 prompt，故 prompt 文本中
 * **必须**显式声明该边界，避免读者误以为 cwd 已被改写 —— 见最后一个用例。
 */

describe('isAbsolutePath（跨平台绝对路径判定）', () => {
  it.each([
    ['C:\\repo', 'Windows 盘符反斜杠'],
    ['C:/repo', 'Windows 盘符正斜杠'],
    ['D:\\', 'Windows 盘符根'],
    ['\\\\server\\share', 'Windows UNC'],
    ['/srv/repo', 'POSIX 绝对路径'],
    ['/', 'POSIX 根'],
  ])('「%s」→ true（%s）', p => {
    expect(isAbsolutePath(p)).toBe(true)
  })

  it.each([
    ['repo', '裸目录名'],
    ['./repo', '相对当前目录'],
    ['../repo', '相对上级目录'],
    ['D:repo', '盘符相对（无分隔符）'],
    ['', '空串'],
  ])('「%s」→ false（%s）', p => {
    expect(isAbsolutePath(p)).toBe(false)
  })
})

describe('normalizeWorkspace（去空白 + 去尾部分隔符）', () => {
  it('去首尾空白并去掉尾部反斜杠', () => {
    expect(normalizeWorkspace('  D:\\体检管理\\repo\\  ')).toBe('D:\\体检管理\\repo')
  })

  it('连续尾分隔符一并去掉', () => {
    expect(normalizeWorkspace('D:/a///')).toBe('D:/a')
  })

  it('POSIX 尾斜杠去掉，但根 `/` 保留', () => {
    expect(normalizeWorkspace('/srv/repo/')).toBe('/srv/repo')
    expect(normalizeWorkspace('/')).toBe('/')
  })

  it('盘符根（`C:\\` / `C:/`）保留分隔符', () => {
    expect(normalizeWorkspace('C:\\')).toBe('C:\\')
    expect(normalizeWorkspace('C:/')).toBe('C:/')
  })

  it('空串与纯空白 → 空串（不产生 `undefined` 噪声）', () => {
    expect(normalizeWorkspace('')).toBe('')
    expect(normalizeWorkspace('   ')).toBe('')
  })

  it('已经是规范形态时保持幂等', () => {
    const once = normalizeWorkspace('D:\\repo\\')
    expect(normalizeWorkspace(once)).toBe(once)
  })
})

describe('workspaceIssue（fail loud 校验，不触碰文件系统）', () => {
  it('空串 → 可读原因', () => {
    expect(workspaceIssue('')).toContain('不可为空')
    expect(workspaceIssue('   ')).toContain('不可为空')
  })

  it('相对路径 → 可读原因，且原样回显用户输入', () => {
    const issue = workspaceIssue('plugins/repo')
    expect(issue).toContain('绝对路径')
    expect(issue).toContain('plugins/repo')
  })

  it('绝对路径 → undefined（通过）', () => {
    expect(workspaceIssue('D:\\体检管理\\repo')).toBeUndefined()
    expect(workspaceIssue('/srv/repo')).toBeUndefined()
  })

  it('带空白的绝对路径视为通过（校验前会 trim）', () => {
    expect(workspaceIssue('  D:\\repo  ')).toBeUndefined()
  })
})

describe('buildWorkspacePromptSection（派发 prompt 的任务上下文）', () => {
  it('未接线（空 / undefined）→ 返回空串，不产出噪声', () => {
    expect(buildWorkspacePromptSection({})).toBe('')
    expect(buildWorkspacePromptSection({ workspace: '' })).toBe('')
    expect(buildWorkspacePromptSection({ workspace: '   ' })).toBe('')
  })

  it('仅路径 → 含路径、硬约束与可执行动作（绝对路径 / 先 cd）', () => {
    const s = buildWorkspacePromptSection({ workspace: 'D:\\repo' })
    expect(s).toContain('【工作目录')
    expect(s).toContain('D:\\repo')
    expect(s).toContain('绝对路径')
    // 可执行动作是关键：只写"代码库位于 X"会让模型继续按进程 cwd 去 glob/grep（问题 1 的成因）。
    expect(s).toContain('cd /d "D:\\repo"')
  })

  it('路径被规范化后再写入（尾部反斜杠不残留）', () => {
    const s = buildWorkspacePromptSection({ workspace: 'D:\\repo\\' })
    expect(s).toContain('D:\\repo')
    expect(s).not.toContain('D:\\repo\\\n')
  })

  it('携带工作项 + 集合 + 任务名 → 合成括注', () => {
    const s = buildWorkspacePromptSection({
      workspace: 'D:\\repo',
      workItemId: 1997179,
      collection: 'WN_HIS',
      taskTitle: '拆解需求',
    })
    expect(s).toContain('工作项 #1997179')
    expect(s).toContain('集合 WN_HIS')
    expect(s).toContain('任务：拆解需求')
  })

  it('仅工作项无集合 → 不产生空的分隔符', () => {
    const s = buildWorkspacePromptSection({ workspace: 'D:\\repo', workItemId: 42 })
    expect(s).toContain('工作项 #42')
    expect(s).not.toContain('、集合')
  })

  it('**不**把"插件不能改变进程 cwd"的自白写进 prompt（问题 1）', () => {
    const s = buildWorkspacePromptSection({ workspace: 'D:\\repo' })
    // 旧实现把"宿主决定 cwd、插件改不了"这段解释写进了 prompt（给开发者看的），
    // 模型读到只会得到"这个目录我做不了主"的结论，于是继续在父会话工作目录里干活。
    // 解释留在模块注释里，prompt 只留可执行动作。
    expect(s).not.toContain('插件不能按任务改变进程 cwd')
    expect(s).not.toContain('把宿主会话/部署的 cwd 设为该路径')
    // 替代它的是明确的禁止项与停手上报要求。
    expect(s).toContain('父会话工作目录')
    expect(s).toContain('改到其它目录')
  })

  it('POSIX 路径用不带 /d 的 cd 形式', () => {
    const s = buildWorkspacePromptSection({ workspace: '/srv/repo' })
    expect(s).toContain('cd "/srv/repo"')
    expect(s).not.toContain('cd /d')
  })
})

/**
 * 技能/MCP 分组存储（2026-11-03 用户诉求，宿主半）。
 *
 * 落 `skill-groups.json`（与 `roles.json` / `schedules.json` 同目录、同一 JsonStore 纪律：
 * 原子写、解析失败保留原文件抛错）。分组是"技能 + MCP 的可复用能力包"，供执行配置页
 * 与任务编辑弹框一键带出。
 *
 * @module host/skill-group-store
 */

import { JsonStore } from '../persistence/json-store.js'
import { realFs, type FsLike } from '../persistence/fs-like.js'
import type { SkillMcpGroup } from '../shared/contracts.js'

/** `skill-groups.json` 的根对象。 */
export interface SkillGroupStoreData {
  groups: SkillMcpGroup[]
}

export interface SkillGroupStoreOptions {
  /** 插件数据目录（`skill-groups.json` 落此）。 */
  baseDir: string
  /** 可注入文件系统（测试用内存实现）。 */
  fs?: FsLike
}

/**
 * 技能/MCP 分组存储。
 *
 * 纪律（与 RoleStore 同源）：
 *   - `list()` 读不到/解析失败时回退空清单并置 `degradedReason`，**不抛错**（面板还能开）；
 *   - `save()`/`delete()` 在降级态**拒绝执行**（避免用空清单覆盖损坏的原文件）。
 */
export class SkillGroupStore {
  private readonly store: JsonStore<SkillGroupStoreData>
  private degraded = ''

  constructor(opts: SkillGroupStoreOptions) {
    this.store = new JsonStore<SkillGroupStoreData>({
      baseDir: opts.baseDir,
      fileName: 'skill-groups.json',
      fs: opts.fs ?? realFs,
    })
  }

  /** `skill-groups.json` 是否处于"读不到、按空清单降级"的状态；空串表示正常。 */
  get degradedReason(): string {
    return this.degraded
  }

  /** 全部分组（读盘失败回退 `[]` 并记降级原因）。 */
  list(): SkillMcpGroup[] {
    try {
      const data = this.store.read()
      this.degraded = ''
      if (!data || !Array.isArray(data.groups)) return []
      return data.groups
    } catch (e) {
      this.degraded = (e as Error).message
      return []
    }
  }

  /** 按 id 查分组。 */
  get(id: string): SkillMcpGroup | undefined {
    return this.list().find(g => g.id === id)
  }

  /**
   * 保存/更新分组（同 id 覆盖；`name` 必填）。
   *
   * 同名（忽略首尾空白与大小写）但不同 id 的分组**拒绝保存**——否则下拉里会出现
   * 两个"前端基础包"，选哪个全靠运气。
   */
  save(group: SkillMcpGroup): void {
    if (this.degraded) {
      throw new Error(
        `skill-groups.json 读不到（${this.degraded}），保存被拒：`
        + '请先修复或手动删除 skill-groups.json 后再操作。',
      )
    }
    const name = (group.name ?? '').trim()
    if (!name) throw new Error('分组名必填')
    const now = new Date().toISOString()
    const all = this.list()
    const dup = all.find(
      g => g.id !== group.id && g.name.trim().toLowerCase() === name.toLowerCase(),
    )
    if (dup) throw new Error(`已存在同名分组「${dup.name}」，请换一个名字或直接编辑该分组`)
    const next: SkillMcpGroup = {
      id: group.id,
      name,
      description: (group.description ?? '').trim() || undefined,
      skills: [...new Set(group.skills ?? [])],
      mcp: [...new Set(group.mcp ?? [])],
      createdAt: group.createdAt || all.find(g => g.id === group.id)?.createdAt || now,
      updatedAt: now,
    }
    const idx = all.findIndex(g => g.id === next.id)
    if (idx >= 0) all[idx] = next
    else all.push(next)
    this.store.write({ groups: all })
  }

  /** 删除分组；返回是否真的删掉了。 */
  delete(id: string): boolean {
    if (this.degraded) {
      throw new Error(
        `skill-groups.json 读不到（${this.degraded}），删除被拒：`
        + '请先修复或手动删除 skill-groups.json 后再操作。',
      )
    }
    const all = this.list()
    const next = all.filter(g => g.id !== id)
    if (next.length === all.length) return false
    this.store.write({ groups: next })
    return true
  }
}

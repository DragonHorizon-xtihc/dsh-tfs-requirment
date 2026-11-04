/**
 * 需求 → 任务拆解辅助（T020 / spec 008 US1，五段式扩展）。
 *
 * 默认五段式拆解（分析 → 架构师拆解 → 开发 → 代码审核 → 测试），形成 `blockedBy` DAG；
 * 每个阶段指派**各自匹配到的角色**（匹配/通用兜底/自动创建由 `BoardService.decompose`
 * 经 `orchestration/role-match.ts` 完成，本函数只按传入的阶段角色映射出草稿，保持纯逻辑、
 * 可单测）。草稿落库经 `Board.addTask`。
 *
 * @module dsh-tfs-requirment/core/board/decompose
 */

import type { Requirement } from '../../tfs/types.js'
import { requirementDedupKey } from '../../tfs/types.js'
import { DECOMPOSE_STAGES, GENERAL_ROLE_NAME, type DecomposeStage } from '../../orchestration/role-match.js'
import type { FrozenConfig, TaskSnapshot } from './task.js'
import type { TaskDraft } from './board.js'

/** 角色引用（最小结构；完整 RoleDefinition 见 orchestration/roles.ts）。 */
export interface RoleRef {
  name: string
  defaultMcp?: string[]
  defaultSkills?: string[]
  defaultModel?: string
  /** 默认模型的 LLM 供应商路由 key（spec 009）；与 defaultModel 成对才有意义。 */
  defaultModelProvider?: string
}

/** 默认冻结配置（无角色时回落）。 */
const DEFAULT_FROZEN: FrozenConfig = { mcp: [], skills: [], model: '' }

/** 按角色引用生成冻结配置（无角色时为空快照）。 */
function frozenOf(role: RoleRef | undefined): FrozenConfig {
  if (!role) return DEFAULT_FROZEN
  // spec 009：供应商随角色默认模型成对冻结；trim 后为空不写键（旧 JSON 形状保持稳定）。
  const provider = role.defaultModelProvider?.trim() ?? ''
  return {
    mcp: role.defaultMcp ?? [],
    skills: role.defaultSkills ?? [],
    model: role.defaultModel ?? '',
    ...(provider ? { modelProvider: provider } : {}),
  }
}

/**
 * 各阶段任务的标题与描述（与 `DECOMPOSE_STAGES` 一一对应；顺序即 DAG 依赖顺序）。
 */
const STAGE_TASK_COPY: Record<
  DecomposeStage,
  { title: (reqTitle: string) => string; description: (req: Requirement) => string }
> = {
  analyze: {
    title: t => `分析任务：${t}`,
    description: req => `梳理工作项 ${req.workItemId}（${req.collection}）的需求背景、验收点与依赖`,
  },
  plan: {
    title: t => `架构师拆解任务：${t}`,
    description: () => '架构师基于分析结果设计技术方案、拆解实现任务与接口边界',
  },
  impl: {
    title: t => `开发任务：${t}`,
    description: () => '按架构方案编写并自测代码/配置',
  },
  review: {
    title: t => `审核代码任务：${t}`,
    description: () => '对开发产出做代码审核，定位缺陷、风险与规范符合性问题并给出结论',
  },
  verify: {
    title: t => `测试代码任务：${t}`,
    description: () => '设计并执行测试用例，回归确认验收点达成',
  },
}

/**
 * 把一条需求拆为默认任务草稿（五段式 DAG）。
 *
 * @param req - 需求。
 * @param rolesByStage - 五个阶段各自匹配到的角色（analyze/plan/impl/review/verify；缺项时以
 *  「通用工程师」名称占位、冻结配置为空——正常装配下 BoardService 已保证每阶段都有角色）。
 * @returns 任务草稿列表（含 blockedBy DAG，后一阶段依赖前一阶段）。
 */
export function decomposeRequirement(
  req: Requirement,
  rolesByStage: Record<DecomposeStage, RoleRef | undefined>,
): TaskDraft[] {
  const base = requirementDedupKey(req)
  // 目标代码库路径由需求继承到每个任务（本地补充字段，非 TFS 字段）。
  // 为空时不写入该键，避免在 board.json 里留下 `"workspace": undefined` 形状的空字段。
  const ws = req.workspace ? { workspace: req.workspace } : {}
  const drafts: TaskDraft[] = []
  let prevId: string | undefined
  for (const stage of DECOMPOSE_STAGES) {
    const taskId = `${base}#${stage}`
    const role = rolesByStage[stage]
    const copy = STAGE_TASK_COPY[stage]
    drafts.push({
      taskId,
      requirementId: base,
      idempotencyKey: `${taskId}:dsh`,
      title: copy.title(req.title),
      description: copy.description(req),
      roleAgent: role?.name ?? GENERAL_ROLE_NAME,
      frozenConfig: frozenOf(role),
      // DAG：除首个分析任务外，每个阶段依赖其前一阶段完成。
      blockedBy: prevId ? [prevId] : [],
      ...ws,
    })
    prevId = taskId
  }
  return drafts
}

/** 便捷类型再导出（避免调用方多重 import）。 */
export type { TaskSnapshot }

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
import type { Requirement } from '../../tfs/types.js';
import { type DecomposeStage } from '../../orchestration/role-match.js';
import type { TaskSnapshot } from './task.js';
import type { TaskDraft } from './board.js';
/** 角色引用（最小结构；完整 RoleDefinition 见 orchestration/roles.ts）。 */
export interface RoleRef {
    name: string;
    defaultMcp?: string[];
    defaultSkills?: string[];
    defaultModel?: string;
    /** 默认模型的 LLM 供应商路由 key（spec 009）；与 defaultModel 成对才有意义。 */
    defaultModelProvider?: string;
}
/**
 * 把一条需求拆为默认任务草稿（五段式 DAG）。
 *
 * @param req - 需求。
 * @param rolesByStage - 五个阶段各自匹配到的角色（analyze/plan/impl/review/verify；缺项时以
 *  「通用工程师」名称占位、冻结配置为空——正常装配下 BoardService 已保证每阶段都有角色）。
 * @returns 任务草稿列表（含 blockedBy DAG，后一阶段依赖前一阶段）。
 */
export declare function decomposeRequirement(req: Requirement, rolesByStage: Record<DecomposeStage, RoleRef | undefined>): TaskDraft[];
/** 便捷类型再导出（避免调用方多重 import）。 */
export type { TaskSnapshot };
//# sourceMappingURL=decompose.d.ts.map
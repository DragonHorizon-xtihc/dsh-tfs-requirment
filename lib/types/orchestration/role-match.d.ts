/**
 * 拆解任务 → 角色的智能匹配（spec 008 / US1~US3；五段式扩展）。
 *
 * ## 背景
 *
 * 旧 `decomposeRequirement(req, roles)` 只取 `roles[0]`，任务全部挂在角色列表第一个名下，
 * "分析→架构师、实现→开发、验证→测试"的预期匹配不存在。本模块按**五段式**阶段为每个任务
 * 匹配各自的角色，五段顺序即 DAG 依赖顺序：
 *
 *   分析（analyze）→ 架构师拆解（plan）→ 开发（impl）→ 代码审核（review）→ 测试（verify）
 *
 * 本模块是**纯逻辑**（只依赖 shared/contracts 的类型，不 import node:* / persistence），
 * 宿主装配在 `BoardService.decompose`，自动建角色通道（RoleStore.save）也在那里。
 *
 * ## 匹配纪律
 *
 * - **只认角色名称**（`role.name`），描述（自由文本）不参与：名称是用户刻意声明的身份信号，
 *   据描述指派会产生用户无法预期的错配（例如某角色描述里顺带提到"测试环境"就被当成测试工程师）。
 * - 关键词大小写不敏感，每个关键词在名称中至多计分一次（命中数，不看出现次数）。
 * - 平分时取**列表靠前**角色（调用方传入顺序即优先级，结果稳定可解释）。
 * - 通用型角色（通用/全栈/general…）与阶段专门匹配**分开判定**：专门命中永远优先，
 *   通用角色只作兜底，永远不会挤掉专门角色。
 * - 词表刻意保守：impl 不收裸"工程师"（否则"测试工程师"会被 impl 抢走），
 *   英文 `engineer` 不会命中中文"工程师"。
 *
 * ## 角色解析五级回落链（BoardService.decompose 使用）
 *
 * 1. `matchRoleForStage` 阶段专门匹配；
 * 2. `matchGeneralistRole` 通用型角色兜底（内置「通用工程师」即此类）；
 * 3. 自动创建该阶段标准内置角色（`STAGE_ROLE_TEMPLATES`，经 RoleStore.save 落盘）；
 * 4. 角色端口无写能力（测试/降级装配）→ 回落列表第一个角色；
 * 5. 一个角色都没有 → undefined（decompose 以「通用工程师」名称占位）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/orchestration/role-match
 */
import type { RoleDefinition } from '../shared/contracts.js';
/**
 * 五段式拆解阶段（与 decompose.ts 的 `#analyze/#plan/#impl/#review/#verify` 任务 id 对齐）。
 * 顺序即 DAG 依赖顺序：分析 → 架构师拆解 → 开发 → 代码审核 → 测试。
 */
export declare const DECOMPOSE_STAGES: readonly ['analyze', 'plan', 'impl', 'review', 'verify'];
/** 拆解阶段。 */
export type DecomposeStage = (typeof DECOMPOSE_STAGES)[number];
/** 通用兜底角色 id（与内置模板 ROLE_GENERAL 一致）。 */
export declare const GENERAL_ROLE_ID = "role-general";
/** 通用兜底角色展示名（无角色可派时 decompose 的占位名也用它，替代旧裸字面量 'general'）。 */
export declare const GENERAL_ROLE_NAME = "\u901A\u7528\u5DE5\u7A0B\u5E08";
/** 内置：需求分析师（分析阶段）。 */
export declare const ROLE_ANALYST: RoleDefinition;
/** 内置：架构师（架构师拆解/方案设计阶段）。 */
export declare const ROLE_ARCHITECT: RoleDefinition;
/** 内置：开发工程师（开发阶段）。 */
export declare const ROLE_CODER: RoleDefinition;
/** 内置：代码审核工程师（代码审核阶段）。 */
export declare const ROLE_REVIEWER: RoleDefinition;
/** 内置：测试工程师（测试阶段）。 */
export declare const ROLE_QA: RoleDefinition;
/** 内置：通用工程师（无专门角色时的通用兜底）。 */
export declare const ROLE_GENERAL: RoleDefinition;
/**
 * 内置角色集（单一事实源）。
 *
 * `roles.ts#DEFAULT_ROLES` 与启动对账 `ensureBuiltinRoles`、拆解自动创建都引用本数组/模板，
 * 避免"默认角色"和"自动创建角色"两处定义漂移。顺序即五段式流水线顺序，末尾为通用兜底。
 */
export declare const BUILTIN_ROLES: RoleDefinition[];
/** 阶段 → 该阶段标准内置角色模板（自动创建时使用）。 */
export declare const STAGE_ROLE_TEMPLATES: Record<DecomposeStage, RoleDefinition>;
/**
 * 各阶段的名称关键词（小写匹配，命中任一即视为该阶段的专门角色）。
 *
 * 防串台纪律：
 * - impl 刻意不收裸「工程师」：「测试工程师/代码审核工程师」均含"工程师"，收入会让 impl 抢人；
 * - analyze 与 plan 拆分：「分析/需求/分析师」归 analyze，「架构/方案/规划」归 plan，
 *   裸「设计」不收入 plan（避免把"UI 设计师"当成架构师）；
 * - review 收「审核/评审/审查」，与 verify 的「测试/验证/质量」互不交叠。
 */
export declare const STAGE_KEYWORDS: Record<DecomposeStage, readonly string[]>;
/** 通用型角色关键词（只作兜底，优先级低于阶段专门命中）。 */
export declare const GENERALIST_KEYWORDS: readonly string[];
/**
 * 在角色列表中按名称挑出命中阶段关键词最多的角色。
 *
 * @param stage - 拆解阶段。
 * @param roles - 候选角色（列表顺序即平分时的优先级）。
 * @returns 专门角色；无任何名称命中时返回 undefined（调用方应走通用/自动创建回落）。
 */
export declare function matchRoleForStage(stage: DecomposeStage, roles: readonly RoleDefinition[]): RoleDefinition | undefined;
/**
 * 在角色列表中挑出通用型角色（名称命中通用关键词）。
 *
 * 与 {@link matchRoleForStage} 分开判定：调用方必须**先**尝试阶段专门匹配，
 * 仅在没有专门角色时才使用通用兜底。
 *
 * @param roles - 候选角色。
 * @returns 通用角色；无命中返回 undefined。
 */
export declare function matchGeneralistRole(roles: readonly RoleDefinition[]): RoleDefinition | undefined;
//# sourceMappingURL=role-match.d.ts.map
/**
 * 角色智能体映射（T025 / FR-011 / S-13）。
 *
 * 角色 = 业务侧"指派给谁做"的抽象：每个角色绑定一个宿主 subagent provider（即
 * `ctx.subagents.start(name, request)` 的 `name`）与一个可选的 agent preset（preset id，
 * 见 dsh-agent-presets 的 `AgentPresetRow.id`）。此外角色携带本插件控制的默认 MCP / 技能 /
 * 模型 / 标签策略，供 ExecutionPanel 与 dispatch 复用。
 *
 * **关于 autoExecute（S-13）**：用户已核实 dsh-agent-presets 文档中**不存在** `autoExecute`
 * 字段（它不属于 host preset 的 schema）。因此 `autoExecute` 是本插件自身的角色属性，表示
 * "该角色被指派后是否自动发起执行"，而非转发给 host。实现时不臆造 host preset 字段。
 *
 * **关于引用缺失（S-13）**：若角色引用的 provider 或 preset 在宿主当前部署中不可用，则该角色
 * 在指派下拉中**禁用并提示原因**，而非静默失败。`resolveRoleAvailability` 接收宿主侧注入的
 * 可用 provider / preset 名称集合，保持本模块纯逻辑、可单测、不依赖宿主 API。
 *
 * 本模块不 import 任何 `@deepseek-ai/*`（host 类型在 slots.ts / dispatch.ts 注入），便于
 * 单测与跨宿主复用（与 T014 ProfileStore、T015 JsonStore 一致）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/orchestration/roles
 */
import { type FsLike } from '../persistence/fs-like.js';
import type { RolePermission, RoleDefinition } from '../shared/contracts.js';
/** 角色默认可绑定的执行权限（与「新建任务」弹窗的权限 select 对齐）。 */
export type { RolePermission, RoleDefinition };
/** 角色配置校验错误。 */
export interface RoleValidationError {
    /** 出错角色 id。 */
    roleId: string;
    /** 字段。 */
    field: string;
    /** 可读说明。 */
    message: string;
}
/** 角色可用性解析结果（S-13）。 */
export interface RoleAvailability {
    /** 角色 id。 */
    roleId: string;
    /** 是否可用（provider 与 preset 引用均存在）。 */
    available: boolean;
    /** 不可用原因（available=false 时）。 */
    disabledReason?: string;
}
/** 宿主当前可用的 provider / preset 名称（由 slots.ts 在运行时注入）。 */
export interface HostCapabilities {
    /** 可用的 subagent provider 名集合（dsh-subagent 注册的 provider.name）。 */
    providers: ReadonlySet<string> | readonly string[];
    /** 可用的 agent preset id 集合（AgentPresetRoster.presets[].id）。 */
    presets: ReadonlySet<string> | readonly string[];
}
/** 角色存储（落 `roles.json`，纯 JSON 权威，复用 JsonStore）。 */
export declare class RoleStore {
    private readonly store;
    constructor(baseDir: string, fs?: FsLike);
    /** 列出全部角色。 */
    list(): RoleDefinition[];
    /**
     * `roles.json` 是否处于"读不到、按内置角色降级"的状态；空串表示正常。
     *
     * 装配层（`index.ts`）用它把启动日志里那句承诺落到实际可观测的告警上，
     * 面板侧则据此阻止写入（见 `save`/`delete`）。
     */
    degradedReason: string;
    /** 按 id 取角色；不存在返回 undefined。 */
    get(id: string): RoleDefinition | undefined;
    /** 按展示名取角色（指派下拉用）。 */
    getByName(name: string): RoleDefinition | undefined;
    /** 保存/更新一个角色（含校验）。 */
    save(role: RoleDefinition): void;
    /** 删除角色；返回是否实际删除。 */
    delete(id: string): boolean;
}
/** 角色配置错误。 */
export declare class RoleConfigError extends Error {
    constructor(message: string);
}
/**
 * 单角色校验（id / name / provider 必填）。
 * @param role - 角色定义。
 * @returns 违规项列表；空表示通过。
 */
export declare function validateRole(role: RoleDefinition): RoleValidationError[];
/**
 * 找出第一个与其它角色重名的展示名。
 *
 * 单独抽出来是因为"展示名唯一"是 `roleAgent` 引用的承重约束：拆解与派发按名字解析
 * 角色（`core/board/decompose.ts` 的 `getByName`），重名会让解析结果取决于文件顺序。
 * 批量校验与逐个保存两条路径都要用它，否则约束会在其中一条上失效。
 *
 * @param roles - 待检查的角色列表（应传入"已合并本次改动"的最终列表）。
 * @returns 首个重名对；无重名时返回 `undefined`。
 */
export declare function findDuplicateDisplayName(roles: readonly RoleDefinition[]): {
    name: string;
    firstId: string;
} | undefined;
/**
 * 解析角色可用性（S-13）：provider 与 preset 引用必须都存在于宿主当前部署。
 * @param role - 角色。
 * @param caps - 宿主可用 provider / preset 名称集合。
 * @returns 可用性结果。
 */
export declare function resolveRoleAvailability(role: RoleDefinition, caps: HostCapabilities): RoleAvailability;
/**
 * 批量校验：命名引用缺失即报错（S-13 的静态配置层，运行时还需 resolveRoleAvailability）。
 * @param roles - 角色列表。
 * @param caps - 宿主可用能力（可选；不传则只做基本字段校验）。
 * @returns 全部违规项。
 */
export declare function validateRolesConfig(roles: RoleDefinition[], caps?: HostCapabilities): RoleValidationError[];
/**
 * 随插件内置的默认角色集（用户可在角色管理页增删改）。
 *
 * 单一事实源在 `role-match.ts#BUILTIN_ROLES`（拆解自动创建与本默认集共用同一份模板，
 * 避免两处定义漂移）：需求分析师 / 架构师 / 开发工程师 / 代码审核工程师 / 测试工程师 / 通用工程师
 * （spec 008 US2 新增兜底；五段式扩展补入需求分析师、代码审核工程师）。
 *
 * 这里刻意**拷贝**一份而不是直接再导出 `BUILTIN_ROLES`：同一个数组实例经两个导出同时可达，
 * 任何一处 push/splice/改元素都会从另一处可见（调用方把 `DEFAULT_ROLES` 当自己的模板用，
 * 而 `ensureBuiltinRoles` 读的正是 `BUILTIN_ROLES`）。模板是只读的，给各自一份拷贝。
 */
export declare const DEFAULT_ROLES: RoleDefinition[];
/**
 * 启动对账：把缺失的内置角色补写进角色仓（spec 008 US2）。
 *
 * 旧播种逻辑是"roles.json 为空才整体写入"，导致升级部署永远拿不到新增内置角色
 * （实机：老店只有早期 3 个角色，后续新增的「通用工程师 / 需求分析师 / 代码审核工程师」进不去）。本函数逐条对账：
 *
 * - 同 id 已存在 → 跳过（**永不覆盖**用户改名/改模型/改 provider 后的条目）；
 * - 同展示名已存在（用户自建了同名角色、id 不同）→ 跳过（展示名是 roleAgent 引用键，必须唯一）；
 * - 否则补写该内置角色。
 *
 * 既定策略：用户删除内置角色后，重启会被本对账补回——内置角色是拆解链路的兜底资产，
 * "删除后永不复活"需要墓碑机制，本期不做（见 spec 008 Out of Scope）。
 *
 * @param store - 角色存储。
 * @returns 本次补写的角色 id 列表（空表示无需迁移）。
 */
export declare function ensureBuiltinRoles(store: RoleStore): string[];
//# sourceMappingURL=roles.d.ts.map
/**
 * 技能/MCP 分组存储（2026-11-03 用户诉求，宿主半）。
 *
 * 落 `skill-groups.json`（与 `roles.json` / `schedules.json` 同目录、同一 JsonStore 纪律：
 * 原子写、解析失败保留原文件抛错）。分组是"技能 + MCP 的可复用能力包"，供执行配置页
 * 与任务编辑弹框一键带出。
 *
 * @module host/skill-group-store
 */
import { type FsLike } from '../persistence/fs-like.js';
import type { SkillMcpGroup } from '../shared/contracts.js';
/** `skill-groups.json` 的根对象。 */
export interface SkillGroupStoreData {
    groups: SkillMcpGroup[];
}
export interface SkillGroupStoreOptions {
    /** 插件数据目录（`skill-groups.json` 落此）。 */
    baseDir: string;
    /** 可注入文件系统（测试用内存实现）。 */
    fs?: FsLike;
}
/**
 * 技能/MCP 分组存储。
 *
 * 纪律（与 RoleStore 同源）：
 *   - `list()` 读不到/解析失败时回退空清单并置 `degradedReason`，**不抛错**（面板还能开）；
 *   - `save()`/`delete()` 在降级态**拒绝执行**（避免用空清单覆盖损坏的原文件）。
 */
export declare class SkillGroupStore {
    private readonly store;
    private degraded;
    constructor(opts: SkillGroupStoreOptions);
    /** `skill-groups.json` 是否处于"读不到、按空清单降级"的状态；空串表示正常。 */
    get degradedReason(): string;
    /** 全部分组（读盘失败回退 `[]` 并记降级原因）。 */
    list(): SkillMcpGroup[];
    /** 按 id 查分组。 */
    get(id: string): SkillMcpGroup | undefined;
    /**
     * 保存/更新分组（同 id 覆盖；`name` 必填）。
     *
     * 同名（忽略首尾空白与大小写）但不同 id 的分组**拒绝保存**——否则下拉里会出现
     * 两个"前端基础包"，选哪个全靠运气。
     */
    save(group: SkillMcpGroup): void;
    /** 删除分组；返回是否真的删掉了。 */
    delete(id: string): boolean;
}
//# sourceMappingURL=skill-group-store.d.ts.map
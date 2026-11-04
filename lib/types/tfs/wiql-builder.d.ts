/**
 * WIQL 构造纯函数（问题 13 配套）。
 *
 * 34 个新端点里有 6 个是"条件 → 工作项列表"的查询（按客户、最近已解决、Bug、自定义条件、
 * 标题搜索、执行已保存查询后的二次过滤）。把条件到 WIQL 的映射集中在这一个**无副作用、可单测**
 * 的模块，适配层只负责发请求与归一化，避免每个分支各拼一份字符串导致转义/括号漂移。
 *
 * WIQL 参考（TFS 2018 / Azure DevOps，api-version=4.1）：
 *   SELECT [System.Id] FROM WorkItems
 *   WHERE [System.TeamProject] = 'X' AND [System.WorkItemType] IN ('需求','任务')
 *   ORDER BY [System.ChangedDate] DESC
 * 条数上限不走 WIQL TOP 关键字（WIQL 不支持），由 HTTP 参数 `$top` 控制。
 *
 * @module dsh-tfs-requirment/tfs/wiql-builder
 */
/** 一组 WIQL 查询条件（全部可选；字段间 AND，同字段多值 OR 即 IN）。 */
export interface WiqlConditions {
    /** 团队项目（单值）。 */
    project?: string;
    /** 工作项类型显示名（多值 OR）。 */
    types?: string[];
    /** 状态显示名（多值 OR）。 */
    states?: string[];
    /** 指派人显示名/账号（多值 OR，WIQL 对 AssignedTo 支持显示名匹配）。 */
    assignedTo?: string[];
    /** 标题关键字（CONTAINS；非 ASCII 在部分 TFS 上会 414，由调用方做客户端兜底）。 */
    titleContains?: string;
    /** Winning 客户名称（`Winning.Custom.Name`，等值；中文实测可用）。 */
    customer?: string;
    /** 任意附加的原始 WIQL 条件（已由调用方保证合法，本模块不转义）。 */
    rawConditions?: string[];
    /** 排序字段引用名（默认 System.ChangedDate）。 */
    orderByField?: string;
    /** 排序方向（默认 DESC）。 */
    orderDirection?: 'ASC' | 'DESC';
}
/**
 * WIQL 字符串字面量转义：单引号翻倍（WIQL 唯一必需的转义）。
 * @param value - 原始值。
 * @returns 可直接放进单引号的安全值。
 */
export declare function wiqlEscape(value: string): string;
/**
 * 按条件构造 WIQL 查询字符串。
 * @param cond - 查询条件。
 * @returns 完整 WIQL（无任何条件时返回全量扫描语句，调用方应自行避免无界查询）。
 */
export declare function buildWiql(cond?: WiqlConditions): string;
//# sourceMappingURL=wiql-builder.d.ts.map
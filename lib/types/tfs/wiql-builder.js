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
 * @module @deepseek-ai/dsh-tfs-requirment/tfs/wiql-builder
 */
/**
 * WIQL 字符串字面量转义：单引号翻倍（WIQL 唯一必需的转义）。
 * @param value - 原始值。
 * @returns 可直接放进单引号的安全值。
 */
export function wiqlEscape(value) {
    return String(value ?? '').replace(/'/g, "''");
}
function inList(field, values) {
    const vals = (values ?? []).map(v => v?.trim()).filter((v) => !!v);
    if (vals.length === 0)
        return null;
    const first = vals[0];
    if (vals.length === 1 && first !== undefined)
        return `[${field}] = '${wiqlEscape(first)}'`;
    return `[${field}] IN (${vals.map(v => `'${wiqlEscape(v)}'`).join(', ')})`;
}
/**
 * 按条件构造 WIQL 查询字符串。
 * @param cond - 查询条件。
 * @returns 完整 WIQL（无任何条件时返回全量扫描语句，调用方应自行避免无界查询）。
 */
export function buildWiql(cond = {}) {
    const clauses = [];
    if (cond.project?.trim())
        clauses.push(`[System.TeamProject] = '${wiqlEscape(cond.project.trim())}'`);
    const typeClause = inList('System.WorkItemType', cond.types);
    if (typeClause)
        clauses.push(typeClause);
    const stateClause = inList('System.State', cond.states);
    if (stateClause)
        clauses.push(stateClause);
    const ownerClause = inList('System.AssignedTo', cond.assignedTo);
    if (ownerClause)
        clauses.push(ownerClause);
    if (cond.customer?.trim())
        clauses.push(`[Winning.Custom.Name] = '${wiqlEscape(cond.customer.trim())}'`);
    if (cond.titleContains?.trim())
        clauses.push(`[System.Title] CONTAINS '${wiqlEscape(cond.titleContains.trim())}'`);
    for (const raw of cond.rawConditions ?? []) {
        if (raw && raw.trim())
            clauses.push(raw.trim());
    }
    const where = clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
    const field = cond.orderByField ?? 'System.ChangedDate';
    const dir = cond.orderDirection === 'ASC' ? 'ASC' : 'DESC';
    return `SELECT [System.Id] FROM WorkItems${where} ORDER BY [${field}] ${dir}`;
}
//# sourceMappingURL=wiql-builder.js.map
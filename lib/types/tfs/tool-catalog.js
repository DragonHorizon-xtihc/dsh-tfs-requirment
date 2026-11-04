/**
 * TFS 操作目录：把本插件支持的**全部** TFS 操作收成一张可枚举、可分类、可判读写的契约表，
 * 并给出「插件工具名 ⇄ 操作键」的双向映射。
 *
 * ## 语义迁移（2026-09-19，REST 化）
 *
 * 本表原先登记的是"外部 tfs-mcp 实例注册了哪些工具"。REST 化后 **tfs-mcp 已完全移出运行期依赖**：
 * 适配层的 `wrappedCall` / `wrappedWrite` 不再经 `ctx.tools.execute('mcp__tfs-mcp__*')` 转发，
 * 而是把这里的**操作键**直接分派到 `/_apis/...` REST 端点（见 `tfs/adapter.ts#call` 的分支表）。
 *
 * 因此本表的定位从"外部 MCP 工具的清单"变成**插件自有能力清单**：
 *
 * 1. **它不再是外部事实的快照，而是插件的兼容契约**。`raw` 字段保留旧 mcp 工具名形态
 *    （`tfs_get_workitem` 等），因为它同时充当 `adapter.call(raw, args)` 的分派键；
 *    改名会让适配层的分支表、审计记录里的历史 `opType` 全部失配。
 * 2. **不再需要"按实例收敛"**。旧实现用 `catalogFromRawNames(listTfsTools())` 剔除实例
 *    未注册的工具，避免"有封装但一调就 UNKNOWN_TOOL"的假能力。REST 化后能力由
 *    `adapter.call` 的分支表**静态决定**：分支存在即可用，不存在即报可读错误。
 *    故 `catalogView()` 直接用全表，`missingCount` 语义改为"**已登记但适配层尚未实现 REST 分支**"。
 * 3. **"连接与凭据"页讲的事随之改变**：不再展示"插件把外部 MCP 工具封装成了什么"，
 *    而是展示"插件直连 REST 能做什么、要什么权限"。
 *
 * ## 仍然保留的设计约束
 *
 * 模型只看到插件工具 `tfs_req_*`，任何写操作**必须**过 WriteGuard 四道门禁
 * （dry-run / 确认 / 幂等 / 审计），不存在绕过路径 —— 这条与是否用 MCP 无关。
 *
 * @module @deepseek-ai/dsh-requirment/tfs/tool-catalog
 */
export const PLUGIN_TOOL_PREFIX = 'tfs_req_';
/**
 * TFS 操作契约表（共 49 条）。
 *
 * **不再按实例收敛**（2026-09-19 REST 化）：
 * 表内容 = 适配层 `call()` 实现了分支的操作集。表比实现全时，UI 会如实标出
 * "已登记但适配层未实现"（见 {@link catalogView}），这比静默截断更容易发现缺口。
 *
 * 顺序按分类聚集，便于 UI 分组渲染。
 */
export const TFS_TOOL_SPECS = [
    // ── 工作项：读 ──
    { raw: 'tfs_whoami', title: '当前身份', category: 'collection', access: 'read', description: '返回当前 PAT 对应的身份与可见集合，用于自检。', core: true },
    { raw: 'tfs_list_collections', title: '集合清单', category: 'collection', access: 'read', description: '列出该 TFS 服务上当前身份可见的集合。找不到目标项目时先用它确认集合名。' },
    { raw: 'tfs_get_current_collection', title: '当前集合', category: 'collection', access: 'read', description: '返回适配层当前生效的默认集合。', core: true },
    { raw: 'tfs_set_collection', title: '切换集合', category: 'collection', access: 'write', description: '改变适配层默认集合。**只影响后续调用**，不改 TFS 数据；仍按写操作过门禁以便审计。', params: { collection: '目标集合名' } },
    { raw: 'tfs_update_token', title: '更新访问令牌', category: 'collection', access: 'write', description: '运行期替换 PAT。凭据只在进程内生效，不会写回本插件存储。' },
    { raw: 'tfs_get_projects', title: '项目清单', category: 'query', access: 'read', description: '列出集合下的项目。**按项目筛选前必须先用它取到准确项目名**（TFS 的项目名与显示名可能不同）。', core: true },
    { raw: 'tfs_get_workitem', title: '取单个工作项', category: 'work-item', access: 'read', description: '按 id 取一个工作项（含字段与可选 relations）。**这是最稳的读取路径**，列表工具异常时仍可用。', params: { id: '工作项 id（必填）', collection: '集合（可选，缺省用当前集合）' }, core: true },
    { raw: 'tfs_get_work_items', title: '批量取工作项', category: 'work-item', access: 'read', description: '按 id 列表批量取工作项。注意：TFS 2018 上传 `fields` 会与 `expand` 冲突而报错，故一般不用该工具取字段。', params: { ids: '工作项 id 数组' } },
    { raw: 'tfs_get_work_items_by_customer', title: '按客户取工作项', category: 'work-item', access: 'read', description: '按客户维度检索工作项（Winning 自定义字段）。' },
    { raw: 'tfs_get_my_tasks', title: '我的任务', category: 'work-item', access: 'read', description: '取指派给当前 PAT 身份的工作项。', params: { top: '返回条数上限' } },
    { raw: 'tfs_get_recent_resolved', title: '近期已解决', category: 'work-item', access: 'read', description: '取近期状态为已解决/已验证的工作项。' },
    { raw: 'tfs_get_bugs', title: '缺陷清单', category: 'work-item', access: 'read', description: '按条件取 Bug 类工作项。' },
    { raw: 'tfs_get_relations', title: '工作项关系', category: 'relation', access: 'read', description: '取工作项的关联关系（父子/相关/变更集等）。根计划项的 relations 可能极大，注意熔断阈值。', params: { id: '工作项 id' } },
    { raw: 'tfs_get_work_item_commits', title: '工作项关联提交', category: 'relation', access: 'read', description: '取与工作项关联的代码提交。', params: { id: '工作项 id' } },
    // ── 工作项：写 ──
    { raw: 'tfs_create_workitem', title: '新建工作项', category: 'work-item', access: 'write', description: '在指定项目下新建工作项（类型/标题/描述/指派等）。', params: { project: '项目名（必填）', type: '工作项类型（必填）', title: '标题（必填）' }, core: true },
    { raw: 'tfs_update_workitem', title: '更新工作项字段', category: 'work-item', access: 'write', description: '按字段引用更新工作项（如 `System.Title`）。字段名须为 TFS 引用名，不是显示名。', params: { id: '工作项 id（必填）', fields: '字段引用 → 新值' } },
    { raw: 'tfs_change_state', title: '变更工作项状态', category: 'work-item', access: 'write', description: '改变工作项状态（如 Active → Resolved）。目标状态必须是该工作项类型状态机里的合法值。', params: { id: '工作项 id（必填）', state: '目标状态（必填）' }, core: true },
    { raw: 'tfs_assign', title: '变更指派人', category: 'work-item', access: 'write', description: '把工作项指派给某人。身份须用 TFS 账号名（如 `WINNING\\zhangbo3`）。', params: { id: '工作项 id（必填）', assignedTo: '指派对象（必填）' }, core: true },
    { raw: 'tfs_add_tags', title: '添加标签', category: 'work-item', access: 'write', description: '给工作项加标签（分号拼接字段）。本插件用于打 `dsh` 标签，必须幂等。', params: { id: '工作项 id（必填）', tags: '标签数组（必填）' }, core: true },
    // 2026-10-04 新增：与 add 对称的抽标签分支。此前 `removeTags()` 绕过写门禁自己 PATCH，
    // 现统一走 `executeWrite`，恢复「任何写操作必过四道门禁」的承诺。
    { raw: 'tfs_remove_tags', title: '移除标签', category: 'work-item', access: 'write', description: '从工作项上摘掉指定标签（其余标签保留）。本插件在「还原到需求池」时摘 `dsh` 标签；已无该标签时不发写调用。', params: { id: '工作项 id（必填）', tags: '待移除的标签数组（必填）' } },
    { raw: 'tfs_add_comment', title: '添加评论', category: 'work-item', access: 'write', description: '给工作项追加一条评论（历史记录）。用于回写执行结论。', params: { id: '工作项 id（必填）', comment: '评论正文（必填）' }, core: true },
    // ── 查询 ──
    { raw: 'tfs_query_wiql', title: 'WIQL 查询', category: 'query', access: 'read', description: '执行 WIQL 查询。**TFS 2018 上只支持 ASCII `CONTAINS` 形式的条件**，行数上限 200，响应可能很大；不要发无 WHERE 子句的查询（会超时）。', params: { wiql: 'WIQL 语句（必填）' }, core: true },
    { raw: 'tfs_custom_query', title: '自定义查询', category: 'query', access: 'read', description: '按项目/字段组合查询。**实测在 TFS 2018 上易因 expand+fields 冲突而失败**，优先用 WIQL。' },
    { raw: 'tfs_search_work_items', title: '全文检索工作项', category: 'query', access: 'read', description: '按关键词检索工作项标题/描述。', params: { searchText: '关键词' }, core: true },
    { raw: 'tfs_run_saved_query', title: '运行已保存查询', category: 'query', access: 'read', description: '执行 TFS 里已保存的查询（按查询 id 或路径）。' },
    // ── 附件 ──
    { raw: 'tfs_list_attachments', title: '附件清单', category: 'attachment', access: 'read', description: '列出工作项的附件（文件名/大小/下载地址）。', params: { id: '工作项 id' } },
    { raw: 'tfs_upload_attachment', title: '上传附件', category: 'attachment', access: 'write', description: '把本地文件作为附件上传到工作项。', params: { id: '工作项 id（必填）', path: '本地文件绝对路径（必填）' } },
    { raw: 'tfs_download_attachments', title: '下载附件', category: 'attachment', access: 'write', description: '把工作项附件下载到本地目录。**会写本机文件**，故按写操作过门禁。', params: { id: '工作项 id（必填）' } },
    { raw: 'tfs_download_tfvc_files', title: '下载 TFVC 文件', category: 'attachment', access: 'write', description: '从 TFVC 版本库下载文件到本地。**会写本机文件**，故按写操作过门禁。' },
    // ── 变更集 / 版本控制 ──
    { raw: 'tfs_list_tfvc_changesets', title: '变更集列表（TFVC）', category: 'changeset', access: 'read', description: '按条件列出 TFVC 变更集。', params: { top: '条数上限' } },
    { raw: 'tfs_get_tfvc_changeset', title: '取变更集（TFVC）', category: 'changeset', access: 'read', description: '取单个 TFVC 变更集详情。', params: { changesetId: '变更集号' } },
    { raw: 'tfs_get_tfvc_changeset_changes', title: '变更集改动（TFVC）', category: 'changeset', access: 'read', description: '取某变更集的文件改动清单。', params: { changesetId: '变更集号' } },
    { raw: 'tfs_check_commit_work_items', title: '校验提交关联工作项', category: 'changeset', access: 'read', description: '校验提交是否已关联工作项（合规检查用）。' },
    { raw: 'tfs_get_commits', title: '提交列表（Git）', category: 'version-control', access: 'read', description: '取 Git 仓库的提交列表。' },
    { raw: 'tfs_list_repos', title: '仓库清单（Git）', category: 'version-control', access: 'read', description: '列出项目下的 Git 仓库。' },
    { raw: 'tfs_get_repo', title: '仓库详情（Git）', category: 'version-control', access: 'read', description: '取单个 Git 仓库详情。' },
    { raw: 'tfs_list_branches', title: '分支清单（Git）', category: 'version-control', access: 'read', description: '列出 Git 仓库分支。' },
    { raw: 'tfs_get_branch', title: '分支详情（Git）', category: 'version-control', access: 'read', description: '取单个分支详情。' },
    { raw: 'tfs_get_branch_diffs', title: '分支差异（Git）', category: 'version-control', access: 'read', description: '比较两个分支的差异。' },
    { raw: 'tfs_list_tfvc_branches', title: '分支清单（TFVC）', category: 'version-control', access: 'read', description: '列出 TFVC 分支。' },
    { raw: 'tfs_list_tfvc_items', title: '条目清单（TFVC）', category: 'version-control', access: 'read', description: '列出 TFVC 路径下的条目。' },
    { raw: 'tfs_get_tfvc_item', title: '取条目（TFVC）', category: 'version-control', access: 'read', description: '取 TFVC 单个条目详情。' },
    { raw: 'tfs_get_tfvc_file', title: '取文件内容（TFVC）', category: 'version-control', access: 'read', description: '读取 TFVC 上某个文件的内容。' },
    // ── 拉取请求 ──
    { raw: 'tfs_list_prs', title: 'PR 列表', category: 'pull-request', access: 'read', description: '列出仓库的拉取请求。' },
    { raw: 'tfs_get_pr', title: 'PR 详情', category: 'pull-request', access: 'read', description: '取单个拉取请求详情。', params: { pullRequestId: 'PR 号' } },
    { raw: 'tfs_get_pr_commits', title: 'PR 提交', category: 'pull-request', access: 'read', description: '取 PR 中包含的提交。' },
    { raw: 'tfs_get_pr_diffs', title: 'PR 差异', category: 'pull-request', access: 'read', description: '取 PR 的文件差异。' },
    { raw: 'tfs_get_pr_workitems', title: 'PR 关联工作项', category: 'pull-request', access: 'read', description: '取 PR 关联的工作项。' },
    { raw: 'tfs_add_pr_comment', title: 'PR 评论', category: 'pull-request', access: 'write', description: '在 PR 上添加评论。', params: { pullRequestId: 'PR 号（必填）', comment: '评论正文（必填）' } },
    { raw: 'tfs_create_pr', title: '创建 PR', category: 'pull-request', access: 'write', description: '创建拉取请求（源分支 → 目标分支，可关联工作项）。', params: { sourceRefName: '源分支（必填）', targetRefName: '目标分支（必填）' } },
];
/** 契约表按原始工具名索引。 */
const SPEC_BY_RAW = new Map(TFS_TOOL_SPECS.map(spec => [spec.raw, spec]));
/** 取某个原始工具的契约；未知工具返回 `undefined`。 */
export function specOfRaw(raw) {
    return SPEC_BY_RAW.get(raw);
}
/**
 * 由操作键推导插件工具名。
 *
 * 去掉 `tfs_` 前缀再拼本插件前缀：`tfs_get_workitem` → `tfs_req_get_workitem`。
 * 目的：模型看到的名字能**一一对上**文档里的操作名，减少误用；
 * 同时与宿主/其它插件的工具名不可能相撞。
 *
 * @param raw - 操作键。
 * @returns 插件自有工具名。
 */
export function pluginToolName(raw) {
    const bare = raw.startsWith('tfs_') ? raw.slice('tfs_'.length) : raw;
    return `${PLUGIN_TOOL_PREFIX}${bare}`;
}
/**
 * 由插件工具名反查操作键；不是本插件工具时返回 `undefined`。
 * @param name - 插件工具名。
 * @returns 操作键。
 */
export function rawToolName(name) {
    if (!name.startsWith(PLUGIN_TOOL_PREFIX))
        return undefined;
    return `tfs_${name.slice(PLUGIN_TOOL_PREFIX.length)}`;
}
/**
 * 未知操作（契约表尚未登记）的兜底契约。
 *
 * **判读写靠名字前缀，且方向是"认读不认写"**（2026-09-18 修正）：
 * 只有名字以**明确的读动词**开头（`get_` / `list_` / `query` / `search_` / `whoami` /
 * `run_saved_` / `check_` / `read_` / `show_` / `find_`）才判为读，**其余一律判为写**。
 *
 * ## 为什么必须"认读不认写"（修前的实现是反的）
 *
 * 修前用"写动词白名单"（`add_` / `create_` / `update_` …）判写，其余判读。
 * 于是 `tfs_brand_new_write_tool` 这种**名字里带 write 但不在白名单**的工具会被判成 **read**，
 * 直接绕过 dry-run / 确认 / 幂等 / 审计四道写门禁 —— 与下面这条安全目标正面冲突：
 *
 *   > 漏判写 = 绕过写门禁（**不可接受**）；多判写 = 多一次人工确认（可接受）。
 *
 * 即"兜底偏保守"这句承诺在旧实现里根本没兑现（注释写保守、代码写宽松）。
 * 现在改成只有**认得出是读**才放行，认不出就当写。
 *
 * @param raw - 操作键。
 * @returns 兜底契约。
 */
export function fallbackSpec(raw) {
    const bare = raw.startsWith('tfs_') ? raw.slice('tfs_'.length) : raw;
    const looksRead = /^(get|list|query|search|whoami|run_saved|check|read|show|find)(_|$)/.test(bare);
    return {
        raw,
        title: bare,
        category: 'other',
        access: looksRead ? 'read' : 'write',
        description: looksRead
            ? `未登记操作（${raw}）：按名字前缀判定为读。请把该操作补进 TFS_TOOL_SPECS 以获得准确的中文说明与分类。`
            : `未登记操作（${raw}）：无法判定为读，保守起见按写处理（需人工确认，避免绕过写门禁）。请把该操作补进 TFS_TOOL_SPECS。`,
    };
}
/**
 * 取某操作的契约（契约表优先，未登记走 {@link fallbackSpec}）。
 * @param raw - 操作键。
 * @returns 契约。
 */
export function specOf(raw) {
    return SPEC_BY_RAW.get(raw) ?? fallbackSpec(raw);
}
/**
 * 取全部已登记的操作契约（REST 化后不再按实例收敛）。
 *
 * 旧实现 {@link catalogFromRawNames} 需要一个外部工具名清单来剔除实例未注册项；
 * REST 化后能力由适配层分支表静态决定，故不再需要入参。
 *
 * @returns 契约清单（保持契约表顺序）。
 */
export function catalogSpecs() {
    return [...TFS_TOOL_SPECS];
}
/** 分类的中文标题（UI 分组用）。 */
export const CATEGORY_LABELS = {
    'work-item': '工作项',
    query: '查询与检索',
    relation: '关系与关联',
    attachment: '附件',
    changeset: '变更集 / 提交',
    'version-control': '版本控制',
    'pull-request': '拉取请求',
    build: '构建',
    collection: '集合与身份',
    other: '其它（未登记）',
};
/**
 * 由契约条目的 `params` 生成工具的 JSON Schema 参数表（宿主 `defineTool` 的 `parameters`）。
 *
 * ## 为什么要生成而不是写死 `{}`
 *
 * 全部 49 个 `tfs_req_*` 工具此前都用 `parameters: {}` 注册，模型既看不到参数名，
 * 也看不到哪些必填，只能靠描述里的中文猜；而适配层对多个写分支的校验（正整数 id、
 * 非空 state/comment/assignedTo/tags）是在 2026-09-30 才补齐的（此前会 PATCH
 * `/workitems/NaN`、把负责人清空）。契约表里的 `params` 正是唯一同时知道**参数名**与
 * **是否必填**的地方，所以 schema 从它生成，两者不会漂移。
 *
 * ## 类型取值为什么保守
 *
 * 契约表的 `params` 值是**中文说明**，不是类型声明。因此：
 *
 * - 说明含「数组」⇒ `array` + `json` 元素（元素类型不约束：适配层两种都接受）；
 * - 说明是「A → B」这类映射 ⇒ 开放 `object`；
 * - 其余一律 `json`（宿主 `JsonValueSchemaSpec`：不受约束的 lossless JSON 节点）。
 *
 * 刻意**不**把标量参数声明成 `string`：适配层对 id 类参数做 `Number(...)`、
 * 对 `top` 类做数值解析，模型传数字是正确用法，声明 `string` 会被宿主判为非法入参。
 * `json` 只牺牲类型提示，不误拒任何合法调用。
 *
 * @param spec - 契约条目。
 * @returns 可直接作为 `defineTool({ parameters })` 的参数表；无登记参数时返回 `{}`。
 */
export function toolParameterSpec(spec) {
    const params = spec.params;
    if (!params)
        return {};
    const schema = {};
    for (const [name, hint] of Object.entries(params)) {
        // 「（必填）」是契约表里唯一显式的必填标记，也正是适配层真正会拒的那些参数。
        const required = hint.includes('（必填）');
        const node = /→|对象|字典/.test(hint)
            ? { type: 'object', additionalProperties: true, description: hint }
            : /数组|列表|多条/.test(hint)
                ? { type: 'array', items: { type: 'json' }, description: hint }
                : { type: 'json', description: hint };
        if (required)
            node.required = true;
        schema[name] = node;
    }
    return schema;
}
/**
 * 生成下发到 UI 的能力目录视图（问题 12）。
 *
 * 视图里**同时**给出封装名与操作键：`plugin` 是模型唯一能看到的工具名，
 * `raw` 是适配层内部的分派键。UI 要能把这层对应讲清楚 —— "连接与凭据"页展示
 * 插件直连 REST 的能力面，而不是教用户手工接一个 MCP 实例。
 *
 * @param implemented - 适配层 `call()` 已实现 REST 分支的操作键集合（可选）。
 *   传入时未实现的操作会被标 `unimplemented` 并计入 `missingCount`；
 *   缺省视为全部已实现（回到"契约表即能力面"）。
 * @returns 可 JSON 序列化的目录视图。
 */
export function catalogView(implemented) {
    const specs = catalogSpecs();
    const tools = specs.map(spec => ({
        raw: spec.raw,
        plugin: pluginToolName(spec.raw),
        title: spec.title,
        category: spec.category,
        categoryLabel: CATEGORY_LABELS[spec.category],
        access: spec.access,
        description: spec.description,
        // 显式写成 undefined 还是省略：省略（JSON 序列化后体积更小，UI 用 `?? false` 读）。
        ...(spec.core ? { core: true } : {}),
        ...(implemented && !implemented.has(spec.raw) ? { unimplemented: true } : {}),
    }));
    const missingCount = implemented
        ? specs.filter(spec => !implemented.has(spec.raw)).length
        : 0;
    return {
        ok: true,
        rawCount: specs.length,
        wrappedCount: tools.length - missingCount,
        tools,
        missingCount,
    };
}
//# sourceMappingURL=tool-catalog.js.map
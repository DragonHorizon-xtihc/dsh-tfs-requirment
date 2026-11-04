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
/** 插件自有工具名的统一前缀。 */
import type { ValueSchemaSpec } from '@deepseek-ai/dsh-tools';
import type { TfsToolCatalogView } from '../shared/contracts.js';
export declare const PLUGIN_TOOL_PREFIX = "tfs_req_";
/** 工具分类（UI 分组与文档用）。 */
export type TfsToolCategory = 'work-item' | 'query' | 'attachment' | 'relation' | 'changeset' | 'version-control' | 'pull-request' | 'build' | 'collection' | 'other';
/** 工具对 TFS / 本机的副作用性质。 */
export type TfsToolAccess = 
/** 纯读，不改 TFS、不落本地文件。 */
'read'
/** 改 TFS（必须过写门禁四道门）。 */
 | 'write';
/** 单个 TFS 操作的契约描述。 */
export interface TfsToolSpec {
    /**
     * 操作键，同时是 `adapter.call(raw, args)` 的**分派键**。
     *
     * 取值为旧 mcp 工具名形态（`tfs_get_workitem` 等）：REST 化后它已与任何 MCP 实例无关，
     * 保留该形态纯粹是为了让适配层分支表与历史审计记录（`opType`/`raw`）不失配。
     */
    raw: string;
    /** 中文标题（UI 展示）。 */
    title: string;
    /** 分类。 */
    category: TfsToolCategory;
    /** 读写性质。 */
    access: TfsToolAccess;
    /** 中文说明：做什么、关键参数、注意事项。 */
    description: string;
    /** 关键参数提示（参数名 → 说明）。仅作文档/提示，实际校验在适配层与 TFS 服务端。 */
    params?: Record<string, string>;
    /** 该工具是否为本插件核心链路依赖（缺失即能力降级，见 health 的 missing）。 */
    core?: boolean;
}
/**
 * TFS 操作契约表（共 49 条）。
 *
 * **不再按实例收敛**（2026-09-19 REST 化）：
 * 表内容 = 适配层 `call()` 实现了分支的操作集。表比实现全时，UI 会如实标出
 * "已登记但适配层未实现"（见 {@link catalogView}），这比静默截断更容易发现缺口。
 *
 * 顺序按分类聚集，便于 UI 分组渲染。
 */
export declare const TFS_TOOL_SPECS: readonly TfsToolSpec[];
/** 取某个原始工具的契约；未知工具返回 `undefined`。 */
export declare function specOfRaw(raw: string): TfsToolSpec | undefined;
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
export declare function pluginToolName(raw: string): string;
/**
 * 由插件工具名反查操作键；不是本插件工具时返回 `undefined`。
 * @param name - 插件工具名。
 * @returns 操作键。
 */
export declare function rawToolName(name: string): string | undefined;
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
export declare function fallbackSpec(raw: string): TfsToolSpec;
/**
 * 取某操作的契约（契约表优先，未登记走 {@link fallbackSpec}）。
 * @param raw - 操作键。
 * @returns 契约。
 */
export declare function specOf(raw: string): TfsToolSpec;
/**
 * 取全部已登记的操作契约（REST 化后不再按实例收敛）。
 *
 * 旧实现 {@link catalogFromRawNames} 需要一个外部工具名清单来剔除实例未注册项；
 * REST 化后能力由适配层分支表静态决定，故不再需要入参。
 *
 * @returns 契约清单（保持契约表顺序）。
 */
export declare function catalogSpecs(): TfsToolSpec[];
/** 分类的中文标题（UI 分组用）。 */
export declare const CATEGORY_LABELS: Readonly<Record<TfsToolCategory, string>>;
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
export declare function toolParameterSpec(spec: Pick<TfsToolSpec, 'params'>): Record<string, ValueSchemaSpec & {
    required?: true;
}>;
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
export declare function catalogView(implemented?: ReadonlySet<string>): TfsToolCatalogView;
//# sourceMappingURL=tool-catalog.d.ts.map
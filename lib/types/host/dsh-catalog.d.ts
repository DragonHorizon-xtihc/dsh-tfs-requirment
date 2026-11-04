/**
 * DSH 能力目录：把宿主**真实**可选的模型 / 技能 / 预设 / 工作区 / subagent provider /
 * MCP server 名枚举出来，供面板下拉使用。
 *
 * ## 为什么必须存在这个模块（2026-09-18 用户反馈 4/5/6/7/9/11）
 *
 * 此前 `src/index.ts` 的面板数据是**硬编码**的：
 * ```ts
 * models: ['deepseek-v4-flash', 'deepseek-v4-flash-0731', 'glm-4.6'],
 * mcpServers: [config.tfsServerName],   // 永远只有 TFS 那一个实例（该配置项与实例声明均已废弃）
 * skills: [],                           // 永远空
 * ```
 * 后果是面板里能选的模型/MCP/技能与 dsh 实际配置**对不上**：用户换了模型或装了技能，
 * 面板里看不到，也没法选；`skills` 恒空更是直接让"技能选择"整块失效。
 *
 * ## 数据来源（全部经源码核实，逐条标注 file:line）
 *
 * | 目录 | 宿主 API | 依据 |
 * |---|---|---|
 * | 模型 | `ctx.llm.listProviders(): LlmProviderInfo[]` + `ctx.llm.listModels(provider): Promise<LlmModelInfo[]>` | `dsh-llm/lib/types/index.d.ts`（LlmRuntime 方法表） |
 * | 技能 | `ctx.skills.list(options?): Promise<SkillSummary[]>` | `dsh-skill/lib/types/index.d.ts`（SkillRegistry.list） |
 * | 预设 | `ctx.agentPresets.list(): Promise<AgentPreset[]>` | `dsh-agent-preset-registry/lib/types/index.d.ts`（AgentPresetRegistry.list） |
 * | 工作区 | `ctx.workspaceRegistry.list(): Workspace[]` | `dsh-workspace/lib/types/index.d.ts`（WorkspaceRegistry.list） |
 * | provider | `ctx.subagents.list(): string[]` | `dsh-subagent/lib/types/index.d.ts:283` |
 * | MCP server | 从 `ctx.tools.schemas()` 的 `mcp__<server>__<tool>` 前缀反推 | `dsh-mcp-client/src/tools.ts:81`（工具全名规则） |
 *
 * ## 三类取值方式（决定本模块的形态）
 *
 * 1. **同步**：`workspaceRegistry.list()`、`subagents.list()`、`tools.schemas()`；
 * 2. **异步**：`skills.list()`、`agentPresets.list()`、`llm.listModels()`；
 * 3. **需两跳**：模型要先 `listProviders()` 再逐个 `listModels(provider)`。
 *
 * 因为存在异步项，目录**不能**在 `panel-data` 的同步返回里现算，故本模块实现为
 * **带缓存 + 可刷新**：`refresh()` 重新采集，`current()` 同步取上一份（首次可能为空）。
 * 面板先渲染缓存、再异步刷新，避免"打开面板要等所有 provider 走完一轮网络"。
 *
 * ## 降级纪律（沿用插件既有约定）
 *
 * 每一项独立 try/catch：某项失败只让该项为空并把**可读原因**收进 `warnings`，
 * 绝不让"某宿主服务缺失"把整个面板数据打没。`warnings` 会在 UI 上显式展示，
 * 保证"能力降级可见"而不是静默变空。
 *
 * @module @deepseek-ai/dsh-requirment/host/dsh-catalog
 */
import type { DshCatalog } from '../shared/contracts.js';
export type { DshModelOption, DshSkillOption, DshPresetOption, DshWorkspaceOption, DshCatalog, } from '../shared/contracts.js';
/** 空目录（首次采集前 / 宿主服务全不可用时的安全初值）。 */
export declare function emptyCatalog(): DshCatalog;
/**
 * 宿主上下文的最小访问面。
 *
 * 只声明本模块用到的两个能力：`get(name)`（**非抛出**服务访问器）与 `tools.schemas()`。
 * 这样本模块不 import cordis，可在单测里用普通对象驱动。
 */
export interface DshCatalogHost {
    /**
     * 取宿主服务，未提供时返回 `undefined`。
     *
     * **必须是 cordis 的「非严格」`ctx.get` 语义**（即 `ctx.get(name, false)`）：
     *   - 属性读取（`ctx.llm`）对未 inject 的服务会抛错，见 `vendor/cordis/lib/index.js:672-681`；
     *   - **严格模式**（`ctx.get(name)` / `ctx.get(name, true)`）在提供该服务的 fiber
     *     `state !== 2`（尚未激活）时**返回 `undefined`**，见同文件 `:762-772`（`_getImpl` 在 `:766`）。
     *
     * 2026-09-19 实测坐实（用真实 cordis 根上下文做一次性探针，探针用完即删）：
     * ```
     * root.get("llm", true)  → undefined    ← 严格模式：fiber 未激活
     * root.get("llm", false) → 有值          ← 非严格模式：拿得到
     * ```
     * 装配点（`src/index.ts`）据此显式传 `false`，否则模型/技能/预设/工作区/provider 五项
     * 会在插件 `apply` 期集体采空（且各自只留一条 warning）。
     */
    get(name: string): unknown;
    /** 工具运行时（用于反推 MCP server 名）。 */
    tools?: {
        schemas(scope?: unknown): Array<{
            name?: unknown;
        }>;
    } | undefined;
}
/** 从工具全名 `mcp__<serverName>__<rawName>` 反推 server 名。 */
export declare function mcpServerNamesFromSchemas(schemas: Array<{
    name?: unknown;
}>, fallback?: readonly string[]): string[];
/**
 * 按名字读取技能**正文**（`ctx.skills.get(name).content`），带作用域探测。
 *
 * ## 为什么不能直接 `skills.get(name)`
 *
 * `list()` / `get()` 省略 `scope` 时**只读全局层**；用户级技能（`$DSH_HOME/skills`、
 * `~/.agents/skills`）只挂在 preset 的 standing 作用域层（web profile 明确禁用宿主级
 * skill-filesystem，"presets own local discovery"）。直接 `get(name)` 对它们返回 `undefined`，
 * 若据此判"技能不可用"就会把**正常安装的用户技能**拒掉。
 *
 * 因此这里复用 {@link collectSkills} 的同一套作用域入口：全局层 → 每个非损坏 preset 的
 * `acquireScope(id).key`（0.1.7+，租约即时释放）→ `standingKeyFor(id)`（≤0.1.6 兼容）。
 *
 * 与目录采集的差别：**只读点名的那几个技能**（派发时通常 0–3 个），不做全量 O(N) 读取，
 * 也不缓存正文（正文可能很大，塞进面板数据会把响应体撑爆）。
 *
 * @param host - 宿主上下文（`get(name)` 非严格访问器）。
 * @param names - 技能名清单。
 * @returns 能读到的技能正文（读不到的**不出现在结果里**，由调用方决定是否报错）。
 */
export declare function loadSkillContents(host: DshCatalogHost, names: readonly string[]): Promise<Array<{
    name: string;
    content: string;
}>>;
/** 采集器构造参数。 */
export interface DshCatalogOptions {
    host: DshCatalogHost;
    /**
     * MCP server 兜底清单：`tools.schemas()` 不可用时至少要能看到配置里声明的那个，
     * 否则面板会给出"没有任何 MCP 可选"的错误结论。
     */
    fallbackMcpServers?: readonly string[];
    /** 注入的时钟（单测可固定）。 */
    now?: () => Date;
}
/** DSH 能力目录服务。 */
export interface DshCatalogService {
    /** 重新采集（并发安全：并发调用共享同一次采集）。 */
    refresh(): Promise<DshCatalog>;
    /** 同步取上一份快照（首次为 `emptyCatalog()`）。 */
    current(): DshCatalog;
}
/**
 * 构造 DSH 能力目录服务。
 * @param options - 见 {@link DshCatalogOptions}。
 * @returns 目录服务（`refresh` / `current`）。
 */
export declare function createDshCatalog(options: DshCatalogOptions): DshCatalogService;
//# sourceMappingURL=dsh-catalog.d.ts.map
/**
 * TFS 适配层（T011 / Principle IV：唯一出口）。
 *
 * **2026-09-19 REST 化（架构级变更，用户铁律）**：全部 TFS 访问走 **REST API 直连**，
 * **不再依赖 tfs-mcp**。本文件仍是业务层与 TFS 之间的唯一边界：
 * - 读路径 → `rest-client.ts` 的 `TfsRestRead`（WIQL / 批量取项 / 项目 / 类型 / 状态 / 身份）；
 * - 写路径 → `TfsRestWrite`（PATCH json-patch）+ WriteGuard 四道门禁 + `/rev` 乐观并发
 *   （实测：冲突 = **412** + `VS403351`，test 成功不递增 rev）；
 * - TFVC → `_apis/tfvc/*`（2026-09-19 全部实测 200，`api-version=4.1`）。
 *
 * 版本串硬事实（实测，勿改）：TFS 2018 一律 `4.1`（`7.1` → 404）；
 * `workitemtypes/{type}/states` 必须 `4.1-preview`；`connectionData` **不带** api-version。
 * 详见 `docs/plans/2026-09-19-p0-probe-and-three-questions.md`。
 *
 * `tools`（宿主 `ctx.tools`）已不再使用，保留字段仅为兼容既有装配与测试桩（渐进移除）。
 *
 * @module dsh-tfs-requirment/tfs/adapter
 */
import type { WriteOpType } from './types.js';
import type { RequirementFilter, RequirementListResult, RequirementQueryOptions, RequirementSummary } from '../shared/contracts.js';
import { WriteGuard } from '../write-guard/index.js';
import { type RestConfig } from './rest-client.js';
/** 一次工具调用的规范化结果（`ToolExecutionResult` 的结构化子集）。 */
export interface ToolRunOutcome {
    /** true = 工具失败（宿主已把 MCP `isError` 与工具抛错统一成这个形态）。 */
    isError: boolean;
    /** 成功时的载荷：MCP 信封 `{ content, structuredContent? }`。 */
    value?: unknown;
    /** 失败细节（`ToolFailure`：`message` 恒有，`info.code` 如 `UNKNOWN_TOOL`）。 */
    error?: {
        message?: unknown;
        info?: {
            code?: unknown;
            name?: unknown;
            reason?: unknown;
        };
    };
}
/**
 * 宿主工具运行时（`ctx.tools` = `ToolRuntime`）的结构化子集。
 *
 * 只声明本插件真正用到的成员，便于单测打桩；**不得**再用索引签名假装工具是可调用属性
 * （见文件头 2026-09-18 事故说明）。
 *
 * REST 化（2026-09-19）后本插件**不再经 `execute()` 调 tfs-mcp**；该成员仅保留给
 * `unwrapToolValue` 相关单测与"未来若需回退 mcp 通道"的兼容面。实际使用的是
 * `register()`（注册 `tfs_req_*`）与 `schemas()`（反推宿主已装载的 MCP server 清单）。
 */
export interface TfsTools {
    /** 程序化发起一次工具调用（`ToolRuntime.execute`，`ToolExecutionInput` 的子集）。 */
    execute(exec: {
        callId: string;
        name: string;
        arguments: unknown;
        signal: AbortSignal;
    }): Promise<ToolRunOutcome>;
    /** 枚举当前可见工具（`ToolRuntime.schemas`），用于反推宿主已装载的 MCP server 清单。 */
    schemas(scope?: unknown): Array<{
        name: string;
    }>;
    /**
     * 注册一个工具定义（`ToolRuntime.register`）。
     *
     * ⚠️ `register()` 只把定义插进内部 layers store，**不把工具挂成服务属性**
     * （`@deepseek-ai/dsh-tools/src/index.ts:1043`，全文件无 Proxy/defineProperty）——
     * 故 `Object.keys(ctx.tools)` 永远拿不到工具名，枚举一律走 `schemas()`。
     */
    register(definition: unknown): unknown;
}
/** 一次写操作的门禁结果。 */
export interface WriteOutcome {
    /** 是否成功发出（门禁通过且工具调用完成）。 */
    ok: boolean;
    /** 失败原因（ok=false 时）。 */
    reason?: string;
    /**
     * 结构化失败原因（ok=false 时）。
     *
     * `'IDEMPOTENT_SKIP'` 表示**门禁 3 主动跳过**（目标状态已达成，不是错误）；
     * `'NOT_CONFIRMED'` 表示门禁 2 拒绝（未获人工确认）；两者皆非则说明是真实失败
     * （REST 报错/网络错误/熔断），`reason` 里出现任何"重复/duplicate"字样都**不构成跳过理由**。
     *
     * 消费方必须按本字段判定，不要对 `reason` 做正则匹配（2026-10-05 新增）。
     */
    code?: 'IDEMPOTENT_SKIP' | 'NOT_CONFIRMED';
    /** 工具实际返回（ok=true 时）。 */
    result?: unknown;
}
/** 写操作构建输入。 */
export interface BuildWriteOpInput {
    targetWorkItem: string;
    opType: WriteOpType;
    collection?: string;
    before: unknown;
    after: unknown;
    /** 标签类操作可用单标签归一键（S-08）；不传则退化为回写幂等键。 */
    label?: string;
    /**
     * 该写操作**不参与门禁 3 的幂等判重**（幂等键留空）。
     *
     * 只用于"写本地磁盘、不改 TFS 状态"的一族操作（见 `REPEATABLE_WRITE_OPS`）：
     * 它们对同一参数天然可重复执行，而参数化幂等键是常量，于是第二次同参调用会被门禁 3
     * 判成重复——用户重新下载一次附件（因为上次把文件删了）会被无声拒绝。
     * 门禁 1/2/4 仍然照走：预览、在默认部署下的人工确认、以及审计留痕都不打折。
     */
    repeatable?: boolean;
}
/** 创建新工作项的入参（对齐实测 schema：必填 project/workItemType/title）。 */
export interface CreateWorkItemSpec {
    /** 项目名称（必填）。 */
    project: string;
    /** 工作项类型（必填），如 Task/Bug/User Story。 */
    workItemType: string;
    /** 标题（必填）。 */
    title: string;
    /** 描述（可选，支持 Markdown）。 */
    description?: string;
    /** 父工作项 ID（可选，建立父子关系）。 */
    parentWorkItemId?: number;
    /** 指派给谁（可选，用户名或邮箱）。 */
    assignedTo?: string;
    /** 区域路径（可选）。 */
    areaPath?: string;
    /** 迭代路径（可选）。 */
    iterationPath?: string;
    /** 自定义字段（可选），如 `{ "Microsoft.VSTS.Common.Priority": "1" }`。 */
    fields?: Record<string, unknown>;
}
/**
 * TFVC 变更集列表过滤（T051）。字段名严格对齐 `tfs_list_tfvc_changesets` 实测 schema
 * （`additionalProperties:false`：只允许以下字段，多传会被拒绝）。
 */
export interface ChangesetFilter {
    /** 返回条数。 */
    top?: number;
    /** 跳过条数。 */
    skip?: number;
    /** 作者（用户名或显示名）。 */
    author?: string;
    /** TFVC 路径过滤，如 `$/PEIS/...`。 */
    itemPath?: string;
    /** 起始日期（ISO 8601）。 */
    fromDate?: string;
    /** 截止日期（ISO 8601）。 */
    toDate?: string;
    /** 起始 changeset ID。 */
    fromId?: number;
    /** 截止 changeset ID。 */
    toId?: number;
    /** 集合（缺省用默认集合）。 */
    collection?: string;
}
/** 适配层构造选项。 */
export interface TfsAdapterOptions {
    /**
     * REST 连接配置（REST 化后的**唯一**数据通道配置）。
     * `pat` 只在 rest-client 调用栈内拼 Basic 头，不进本适配层字段、不进日志。
     *
     * **可选**：装配期可能尚未拿到连接档案/PAT（用户还没配置）。此时任何调用都会抛出
     * 可执行的诊断（见 {@link TfsAdapter.restFor}），而不是 `undefined.collection` 崩溃。
     */
    rest?: RestConfig;
    /** 宿主工具访问器（兼容字段，REST 化后不再使用；渐进移除）。 */
    tools?: TfsTools;
    /** 写门禁编排器（包裹 AuditLog）。 */
    writeGuard: WriteGuard;
    /** 默认集合（可选；调用未显式传集合时内联透传）。 */
    collection?: string;
    /** profile 展示引用（仅用于审计标注，绝不持有 PAT 明文）。 */
    profileLabel?: string;
    /**
     * 列表响应体积熔断阈值（默认 **16MB**，计量口径见 `safeSerializedBytes`）。
     *
     * 依据 2026-09-17/18 **真实 TFS 实测**（阈值是量出来的，不是拍的）：
     *   - 典型工作项（id=2，任务）≈4KB；
     *   - **一次真实常规列表 = 201 条 / 2,983,788 字节**（`CONTAINS 'MEMORY'`）≈ 15KB/条；
     *   - 离群根计划项（id=1，**7316 条 relations**）单条即 3,492,287 字节。
     * ⇒ 早期设的 2MB 会把"201 条常规列表"**误熔断**（实测确实熔断），故上调到 16MB：
     *   可容纳约 1000 条常规列表，同时仍能挡住"整集合全量拉取"这类百 MB 级灾难。
     */
    maxResponseBytes?: number;
    /**
     * 单次 REST 调用超时（毫秒，缺省 **20_000**，即 rest-client 的 `DEFAULT_REST_TIMEOUT_MS`）。
     *
     * ⚠️ 这个字段此前**声明了但从未被读取**（2026-10-05 修复）：注释承诺 120s、语义"不变"，
     * 实际生效的却是 rest-client 的 20s 缺省值。字段存在、类型检查通过，调用方会以为
     * 传了值就生效 —— 那是最坏的一种失效。现在它被真正透传给 `restFor()` 生成的
     * 每个 REST 客户端（见构造器），缺省行为与改动前**完全一致**（不传即 20s）。
     *
     * 为什么需要可调：WIQL 在超大集合上可能长时间不返回；不同部署对"看板刷新最多等多久"
     * 的容忍度不同（本地开发想快速失败，生产想给慢集合更多时间）。
     */
    callTimeoutMs?: number;
    /**
     * 「活项目清单」旁路（问题 3 修复，2026-09-19）。
     *
     * ## 为什么必须存在这个旁路
     *
     * `tfs_get_projects` **不是活的查询，是一张硬编码常量表**。实测坐实
     * （`C:/Users/user/.cache/WinCode/mcp/tfs-mcp/dist/tools/project.js`）：
     * ```js
     * import { PROJECTS, PROJECT_TO_COLLECTION } from '../config/constants.js';
     * export function getProjects() {
     *     return Object.entries(PROJECTS).map(([name, id]) => ({ id, name,
     *         collection: PROJECT_TO_COLLECTION[name] || 'WINNING-6.0' }));
     * }
     * ```
     * 而该常量表里 `WN_HIS` 只有 **7 项**
     * （`dist/config/constants.js:151`：`['EAHis','Framework','CIS','NIS','ICIS','EDIS','CDSS']`,
     *   且 `Framework` 还是错的 —— 真名 `Framework_His`）。
     *
     * 真实 TFS（直连 `_apis/projects` 实测，2026-09-19）：
     *   WN_HIS = **62** 个项目、WINNING-6.0 = 26、WN_TECH = 32（合计 120+）。
     *   用户点名的 **体检管理 / 4.0产品后台 / ACIS / ASMC 全是真实存在的 WN_HIS 项目**，
     *   却因为不在那张常量表里而**永远不出现在下拉里** —— 这就是问题 3 的根因。
     *
     * `getProjects()` 既不接受 `collection`，tfs-mcp 里也**没有任何 `_apis/projects` 调用**
     * （`grep -rn '_apis/projects' dist/` 零命中），故只能由本插件自己直连 REST 取活清单。
     *
     * 实现由宿主装配点注入（凭据只在该闭包内使用，不进本适配层的任何持有字段，
     * 也不进审计/日志）；缺失或抛错时**静默回退**到 `tfs_get_projects` 的旧行为。
     *
     * @param collection - 目标集合名。
     * @returns 该项目下的真实项目名清单；不可用时返回 `undefined`（调用方回退）。
     */
    liveProjects?: (collection: string) => Promise<string[] | undefined>;
    /**
     * 动态 REST 配置提供者（2026-09-19，修复"运行时激活/修改连接档案后类型/状态下拉仍为空"）。
     *
     * 装配期一次性传入的 `rest` 在插件启动时若没有活动档案，会是占位配置；用户在
     * 「连接与凭据」页激活/保存档案后，旧实现仍用冻结的占位配置，类型/状态元数据请求一直失败
     * （项目清单因 `liveProjects` 逐调用读档案可能侥幸有值，形成"项目有、类型/状态空"的割裂）。
     * 本提供者在**每次 REST 调用时**返回当前活动档案配置，凭据变更无需重启即生效。
     *
     * @returns 当前活动档案的 REST 配置；无活动档案时返回 `undefined`（回落装配期快照）。
     */
    restConfigProvider?: () => RestConfig | undefined;
    /**
     * 装配点已知的集合名清单（问题 13 `tfs_list_collections` / `tfs_set_collection` 兜底）。
     *
     * 实测该部署的 TFS 2018 不提供服务器级 `/_apis/projectCollections`（全版本 404），
     * tfs-mcp 自身也是读本地配置常量回答。装配点把 profiles 里的集合名注入这里作为权威兜底。
     */
    knownCollections?: string[];
    /**
     * 附件/TFVC 文件下载的根目录（问题 13 下载类端点）。
     * 缺省回落 `<cwd>/downloads`；调用方可显式传 `targetDir` 覆盖每次下载的落点
     * —— 前提是 {@link TfsAdapterOptions.allowExternalDownloadDir} 允许落在根目录之外。
     */
    downloadsDir?: string;
    /**
     * 是否允许下载落在 {@link TfsAdapterOptions.downloadsDir} **之外**（缺省否）。
     *
     * `targetDir` / `options.savePath` 由**调用方（可能是模型）**给出，未受约束时等于
     * "让请求在宿主任意绝对路径建目录并写文件"。缺省关闭时，越界的落点被拒并给出可读
     * 原因（见 `resolveDownloadDir`）；确实要往别处下载的部署显式打开。
     */
    allowExternalDownloadDir?: boolean;
    /**
     * 「采集可选项」的元数据请求并发上限（同时在飞的 HTTP 请求数）。
     *
     * 该采集是 O(项目×类型) 次 GET（WN_HIS 实测 62 个项目、约 800 次请求），
     * 缺省 {@link DEFAULT_QUERY_OPTIONS_CONCURRENCY}，由 `Config.queryOptionsConcurrency`
     * 覆盖 —— 部署现场的网络与 TFS 负载差别很大，属于部署可调项而非协议常量。
     */
    queryOptionsConcurrency?: number;
}
/**
 * TFS 适配层：业务层唯一出口。
 */
export declare class TfsAdapter {
    private readonly rest?;
    private readonly restRead?;
    private readonly restWrite?;
    private readonly writeGuard;
    private readonly profileLabel?;
    private readonly maxResponseBytes;
    private readonly liveProjects?;
    private readonly restConfigProvider?;
    private readonly knownCollections;
    private readonly downloadsDir;
    private readonly allowExternalDownloadDir;
    private readonly queryOptionsConcurrency;
    /** 单次 REST 调用超时（见 {@link TfsAdapterOptions.callTimeoutMs}）；undefined = 用缺省 20s。 */
    private readonly callTimeoutMs?;
    private defaultCollection?;
    /**
     * 运行期 PAT 覆盖（问题 13 `tfs_update_token`）。
     *
     * 只存在于进程内存，绝不写回本插件存储；`restFor` 合并到每次调用的配置上。
     * 与 restConfigProvider 的关系：provider 给出活动档案的 url/集合，运行期 PAT 优先于其中的 pat。
     */
    private runtimePat?;
    /**
     * 按"配置指纹"缓存的 REST 客户端（read/write 成对）。
     *
     * `restConfigProvider` 每次调用可能返回新对象，直接逐调用 `createRestRead/Write` 会让
     * 62 个项目 × N 类型的元数据采集反复重建客户端（含其内部 agent/超时设施）。指纹含
     * url/集合/PAT 的**不可逆摘要**（FNV-1a，同 `write-guard/idempotency` 的稳定哈希；PAT
     * 明文绝不进键、日志或错误信息）。用摘要而不是长度：等长换 token 时长度指纹会撞上旧槽，
     * 让新凭据的请求继续复用持有旧 PAT 的客户端，表现为"改了 PAT 却一直 401"，直到
     * `updateToken` 清缓存。切换/保存档案时也不再依赖"指纹会自然变化"。
     */
    private readonly restClientCache;
    private static readonly REST_CACHE_LIMIT;
    /**
     * 路径 B（含无法下推 WIQL 的非 ASCII 关键字/指派人）时，按 ChangedDate DESC 扫描取字段的
     * 最大 id 数。取 1000（5 批 × 200），兼顾过滤覆盖度与请求耗时，避免退化为全集合串行拉取。
     */
    private static readonly DEFERRED_SCAN_CAP;
    constructor(opts: TfsAdapterOptions);
    /**
     * 运行期替换 PAT（问题 13 `tfs_update_token`）。
     *
     * 仅当前进程内存生效，不写回任何存储；替换后清空 REST 客户端缓存，让所有槽位都用新凭据
     * 重建（指纹已含 PAT 摘要，换 token 自然换槽，清缓存只是不让旧凭据的槽继续占位）。
     * @param pat - 新 PAT 明文。
     */
    updateToken(pat: string): void;
    /**
     * 传输层告警（供 `runHealthCheck` 透到「连接与凭据」面板）。
     *
     * 目前只有一条：基址是 `http:`，PAT 仅以可逆 base64 过网。自检不因此判失败
     * （连通性由 whoami 定），但必须让人看见 —— 否则等于默默用明文信道送凭据。
     *
     * @returns 告警文本；配置缺失、地址不可解析或已是 https 时返回 `undefined`。
     */
    transportNotice(): string | undefined;
    /**
     * REST 客户端缓存指纹（url/集合/PAT 摘要；不含 PAT 明文）。
     *
     * PAT 走 `stableHash` 的 FNV-1a 摘要而非明文或长度：明文会随指纹泄漏到任何打印键的地方，
     * 长度则会让等长换 token 的档案复用旧客户端。
     */
    private restFingerprint;
    /**
     * 集合切换 + 动态凭据：REST 客户端按集合拼 URL，切集合/换档案 = 换一份配置。
     * （对比旧 mcp 路径：以前靠内联 `collection` 参数逐调用透传。）
     *
     * 配置解析顺序（2026-09-19）：**每次调用**先问 `restConfigProvider`（活动档案的最新
     * url/PAT/集合），拿不到才回落装配期冻结的 `rest` 快照。按指纹缓存客户端，上限
     * {@link REST_CACHE_LIMIT}，超出淘汰最久未用项。
     */
    private restFor;
    /**
     * REST 错误 → 可读消息（含 rev 冲突的"实际 rev"提示）。
     * 全文先过 scrubCredentials：URL/错误体可能回显请求串。
     */
    private restErrorMessage;
    /** 内联集合参数（REST 化后为兼容保留：旧调用点仍传 collection，call() 分支自行处理）。 */
    private withCollection;
    /**
     * 单一出口（Principle IV）—— **REST 版**。
     *
     * 旧版经 `ctx.tools.execute('mcp__tfs-mcp__<raw>')` 转发；REST 化后按 raw 语义分发到
     * `TfsRestRead` / `TfsRestWrite`。公开方法签名不变（D1），本方法是签名到端点的映射层：
     *
     * | raw（旧 mcp 工具名） | REST 实现 |
     * |---|---|
     * | `tfs_query_wiql` | `POST /_apis/wit/wiql` + `GET /_apis/wit/workitems?ids=`（**两段式**：WIQL 只回 id，需二次批量取字段） |
     * | `tfs_get_projects` | `GET /_apis/projects`（**活清单**，不再是硬编码表 —— 问题 3 根治） |
     * | `tfs_get_current_collection` | 本地配置直接回答（集合名内联在 URL 中，无需往返） |
     * | `tfs_whoami` | `GET /_apis/connectionData`（裸调用，不带 api-version） |
     * | `tfs_get_work_items` / `tfs_get_workitem` | `GET /_apis/wit/workitems[?ids=]` |
     * | 写类 | `PATCH/POST /_apis/wit/workitems`（json-patch） |
     *
     * 任何失败归一为 {@link TfsAdapterError}（调用方只处理一种错误类型）。
     * `wrappedCall` 传入的 raw 是旧 mcp 工具名，走本映射；未知 raw 报错（能力诚实可见）。
     *
     * @param raw - 旧 mcp 工具名（保持调用方兼容）。
     * @param args - 调用参数（各分支自行解构）。
     */
    /**
     * 纯本地分派：读取当前生效的集合（`tfs_get_current_collection`）。
     *
     * 不经 {@link restFor}，因此**没有凭据也能回答**（A20）。
     * 「当前集合」是本地配置事实（集合名内联在 REST URL 里），不需要网络往返；
     * 返回形状对齐旧 tfs-mcp 版本 `{name, url}`。
     */
    private callLocalCollection;
    /**
     * 纯本地分派：切换默认集合（`tfs_set_collection`）。
     *
     * 只改本地默认值，不写 TFS；集合名必须在装配点已知的清单内。
     */
    private callLocalSetCollection;
    /**
     * 纯本地分派：进程内覆盖 PAT（`tfs_update_token`）。
     *
     * 这是**凭据缺失或过期时的恢复动作**，所以绝不能要求先有可用凭据（A20）。
     * 新 PAT 只活在进程内存里，绝不写回档案或磁盘。
     */
    private callLocalUpdateToken;
    private call;
    /**
     * 当前生效集合（只读）。
     *
     * 存在的理由：`createHostApi(deps)` 是**值捕获**，运行期切换集合（`onCollectionChange`）
     * 改的是适配层而不是那份快照。任何"按当前集合"的判定（可选项缓存键就是其中之一）
     * 都必须从这里取，否则会用旧集合名去查新集合的数据。
     */
    get currentCollection(): string;
    /** 运行时切换默认集合（内联透传用；不预调 tfs_set_collection）。 */
    setCollection(collection: string): void;
    /** 当前身份（T027 契约测试用，只读）。实测：无必填参数。 */
    whoami(): Promise<unknown>;
    /** 当前集合（只读）。实测：无必填参数。 */
    getCurrentCollection(): Promise<unknown>;
    /** 项目清单（只读）。实测：无必填参数，返回全集合项目。 */
    getProjects(args?: unknown): Promise<unknown>;
    /** 工作项清单（只读）。实测必填 `ids: number[]`，可选 `collection`。 */
    getWorkItems(args: unknown): Promise<unknown>;
    /** 单个工作项（只读）。实测必填 `id: number`，可选 `collection`/`embedImages`。 */
    getWorkItem(id: number | string, args?: unknown): Promise<unknown>;
    /** WIQL 查询（只读）。实测必填 `query`，可选 `project`/`collection`。 */
    queryWiql(wiql: string, args?: unknown): Promise<unknown>;
    /** 我的任务（只读）。实测：无必填参数。 */
    getMyTasks(args?: unknown): Promise<unknown>;
    /** 全文检索工作项（只读）。实测必填 `keyword`，可选 `project`/`collection`。 */
    searchWorkItems(searchText: string, args?: unknown): Promise<unknown>;
    /**
     * 采集需求池筛选可选项（问题 3）：项目 / 工作项类型 / 状态 / 指派人。
     *
     * 数据源（全部为只读；REST 化后各自对应一个 `/_apis/*` 端点）：
     *   - 项目：`tfs_get_projects`（准确项目名，TFS 项目名与显示名可能不同，必须先用它取）；
     *   - 类型 / 状态：`GET {project}/_apis/wit/workitemtypes` 与其 `states` 子资源（权威元数据，全量遍历）；
     *   - 指派人：仅当前 PAT 身份（`tfs_whoami`）的 `displayName` 与账号名两种拼写。
     *
     * **指派人为什么只有一条**：TFS 2018 REST 没有"枚举集合内全部身份"的干净端点
     * （`/_apis/identities` 需要 Graph API 且分页语义不适用于工作项字段），WIQL 也不支持
     * GROUP BY 去重。因此这里**只**列出当前身份的两个拼写，不做采样，也不谎称采样；
     * 需要按他人筛选时用户直接在指派输入框里手输账号名即可（筛选按包含匹配、不区分大小写）。
     *
     * 每项独立 try/catch：某项失败只把原因收进 `reason`，不阻断其它项（降级可见）。
     *
     * @param collection - 集合（可选；缺省用默认集合）。
     */
    /**
     * 需求筛选可选项：项目 / 工作项类型 / 状态 / 指派人。
     *
     * @param collection - 集合（可选；缺省用默认集合）。
     * @returns 四项可选项 + 采集期间的可读告警（`reason`）。
     */
    getQueryOptions(collection?: string): Promise<RequirementQueryOptions>;
    /**
     * 按 id 取单个需求并归一化。
     *
     * **注意（实测）**：`tfs_get_workitem` 会连带返回**全部 relations**（实测工作项 #1 的响应达 3.3MB），
     * 因此本方法只应在"取详情"时调用，不用于列表循环（列表走 `listRequirements`）。
     *
     * @param id - 工作项 ID。
     * @param collection - 集合（可选，缺省用默认集合）。
     * @returns 归一化后的需求摘要。
     */
    getRequirement(id: number | string, collection?: string): Promise<RequirementSummary>;
    /**
     * 需求池列表（US2）。
     *
     * **出口选择（2026-09-17 实测证据，非推断）**：
     *   - `tfs_custom_query`（旧 mcp 出口）：**恒失败** —— `The expand parameter can not be used with the fields parameter.`
     *     实测即使**不传 `fields`**（仅 `{top:2}`）仍报同一错误，说明旧 tfs-mcp 内部固定同时发
     *     `expand` 与 `fields`。⇒ 结构性不可用，不作为出口（REST 化后已无此限制）。
     *   - `tfs_get_work_items`（`ids:number[]`）：**同样**报 `expand+fields` 冲突（实测 `{ids:[2]}`）。
     *   - `tfs_search_work_items`：HTTP 414。
     *   - `tfs_query_wiql`：**可用**（实测 `{query:"...WHERE [System.Id] = 2"}` 正常返回），
     *     典型工作项响应约 4KB。⇒ 选为主出口。
     *
     * **两道护栏（均由实测事实驱动）**：
     *   1. **空结果归一化**：旧 tfs-mcp 在 WIQL 命中 0 条时抛
     *      `items is not iterable (cannot read property null)`（实测）。这不是查询失败，
     *      必须归一化为「空列表 + ok:true」，否则 UI 会把"没有需求"误报成"连接故障"。
     *      （REST 化后服务端直接回空数组，见 {@link isWiqlEmptyResult}。
     *   2. **响应体积熔断**：WIQL **无视 SELECT**，一律返回全字段 + 全 relations；
     *      实测根计划项 id=1 单条即 3.4MB（7316 条 relations）。超过 `maxResponseBytes`
     *      （默认 16MB，由"真实 201 条列表 = 2.98MB"标定）即熔断并返回 ok:false +
     *      收窄条件建议，避免 MB 级 payload 进入下游。
     *
     * **分页声明**：`tfs_query_wiql` schema 仅 `query`/`project`/`collection`，**无 top/skip**，
     * 因此 `filter.top`/`filter.skip` 在**客户端侧**切片（并据此给出 `total`）。
     *
     * **第三道护栏（条件降级，真实 TFS 实测）**：`CONTAINS` 的**值含非 ASCII 必返 414**
     * （`CONTAINS '框架'` 414 / `CONTAINS 'MEMORY'` 正常 / 中文等值 `=` 正常）。
     * 故 `keyword`/`assignedTo` 含非 ASCII 时**不下推 WIQL**，改为归一化后客户端侧过滤；
     * `state` 用等值 `=`，实测中文可用，始终下推。
     *
     * @param filter - 筛选条件。
     * @returns 需求列表结果。
     */
    listRequirements(filter?: RequirementFilter): Promise<RequirementListResult>;
    /**
     * 插件自有工具（命名 `tfs_req_<raw>`）的读路径出口。
     *
     * 模型**只**看到插件工具；本方法是它们的内部实现：把调用按操作键分派到 REST 端点。
     * 所有读写仍经 `call()` 单一出口，保证失败归一为 {@link TfsAdapterError}，
     * 且凭据不进参数、不进日志。
     *
     * @param raw - 操作键（旧 mcp 工具名形态，适配层据此分派）。
     * @param args - 调用参数（由插件工具的 `parameters` 透传）。
     */
    wrappedCall(raw: string, args: unknown): Promise<unknown>;
    /**
     * 插件工具（命名 `tfs_req_<raw>`）的写路径出口。
     *
     * 写操作**必须**过 WriteGuard 四道门禁（dryrun → 确认 → 幂等 → 审计，FR-015 / SC-008）。
     * 模型经插件工具发起的写调用，视为已获用户授权（`confirmed=true`），但仍会：
     *   - 走 dryrun 预览与审计归档（S-03，`opType:'tool'` 让审计能区分"经插件工具发起的写"）；
     *   - 受幂等键保护（重复调用同一操作被拦截，避免模型重复写）。
     *
     * @param raw - 操作键（适配层据此分派到 REST 端点）。
     * @param args - 工具参数。
     * @param confirmed - 是否经确认（模型经插件工具调用恒为 true）。
     */
    wrappedWrite(raw: string, args: Record<string, unknown>, confirmed: boolean): Promise<WriteOutcome>;
    /**
     * WIQL 两段式查询并归一化（WIQL 只给 id，再批量取字段）。
     * @param wiql - 已构造好的 WIQL。
     * @param fallbackCollection - 兜底集合名。
     * @returns 归一化工作项列表。
     */
    private wiqlFetch;
    /** 按 id 批量（200 一批）取工作项并归一化。 */
    private wiqlFetchByIds;
    /**
     * 上传本地文件为附件并关联到工作项（两步：POST attachments → PATCH relations/-）。
     * @returns 含 attachmentId/rev 的结果。
     */
    private uploadWorkItemAttachment;
    /**
     * 归一化一个下载落点，并（缺省）把它限制在 {@link TfsAdapterOptions.downloadsDir} 内。
     *
     * `targetDir` / `options.savePath` 是**调用方给的任意绝对路径**：未受约束时，一次
     * 下载就等于"在宿主任意位置建目录并写文件"（模型也能给）。缺省
     * （`allowExternalDownloadDir` 为假）越界即拒，并如实告知根目录与配置开关；确实要
     * 往别处下载的部署打开开关即可。
     *
     * @param raw - 写类操作键（用于错误信息）。
     * @param targetDirArg - 调用方给的落点；空表示用 `fallback`。
     * @param fallback - 调用方未给落点时的缺省目录。
     * @returns 绝对路径，且已通过围栏校验。
     */
    private resolveDownloadDir;
    /**
     * 下载工作项的全部 AttachedFile 附件到本地目录。
     * 文件名取自服务端 attributes/URL 的 filename 参数并做路径穿越防护。
     */
    private downloadWorkItemAttachments;
    /**
     * 批量下载 TFVC 服务器路径文件（保留相对目录结构；支持 flatten/commonRoot/version）。
     */
    private downloadTfvcFiles;
    /**
     * 取单个 TFVC 文件内容（元数据 + 字节）。
     * options.savePath：落盘并返回路径；asBase64 或二进制内容：返回 base64；否则返回 utf8 文本。
     */
    private getTfvcFileContent;
    /**
     * Git/PR 类操作分派（从 call() 的 default 分支转入；未命中再抛"未映射"错误）。
     */
    private callGitPullRequest;
    /**
     * 列出 TFVC 变更集（只读）。
     *
     * **T051 重估依据（2026-09-17 实测）**：本轮工具目录中已出现 TFVC 系列工具
     * （`tfs_list_tfvc_changesets` / `tfs_get_tfvc_changeset` / `tfs_get_tfvc_changeset_changes` /
     * `tfs_list_tfvc_branches` / `tfs_list_tfvc_items`），第三轮「无 shelveset 工具」的降级前提已变化。
     * 但**仍没有任何"建立工作项↔变更集关系"的写工具**（目录内无 `add_relation` 类工具），
     * 故关联回写仍走 `tfs_add_comment`（S-04），但评论内容改为携带**真实变更集元数据**。
     *
     * @param filter - 过滤条件（实测 schema：top/skip/author/itemPath/fromDate/toDate/fromId/toId/collection）。
     */
    listChangesets(filter?: ChangesetFilter): Promise<unknown>;
    /** 取单个变更集详情（只读）。实测必填 `changesetId: number`。 */
    getChangeset(changesetId: number | string, collection?: string): Promise<unknown>;
    /** 取工作项已关联的代码提交（只读，含子工作项）。实测必填 `workItemId: number`。 */
    getWorkItemCommits(workItemId: number | string, collection?: string): Promise<unknown>;
    /**
     * 把 TFVC 变更集关联到工作项（T051 写路径，过四道门禁）。
     *
     * 实现：先**只读**取变更集元数据（`tfs_get_tfvc_changeset`），再以结构化评论回写
     * （`tfs_add_comment`）。取元数据失败时**降级为只带 changeset 号的精简评论**，不阻断关联。
     *
     * 幂等：评论文本由 `changesetId` 唯一决定 → 重复关联生成同一幂等键，被门禁 3 拦截（S-08 同类）。
     *
     * @param workItemId - 目标工作项 ID。
     * @param changesetId - TFVC 变更集号。
     * @param collection - 集合（可选）。
     * @param confirmed - 是否经用户确认。
     */
    linkChangeset(workItemId: string | number, changesetId: number | string, collection: string | undefined, confirmed: boolean): Promise<WriteOutcome>;
    /** 组装变更集关联评论（先取真实元数据，失败降级）。 */
    private buildChangesetComment;
    /** 构造 WriteOp（含幂等键）。 */
    private buildWriteOp;
    /**
     * 执行一次写操作：先过 WriteGuard 的前三道门禁，通过后才真正发出 REST 调用。
     *
     * 门禁4（审计落盘）由 {@link WriteGuard.record} 在 `call` **成功之后**补记，
     * 这样幂等键才代表"确实写进去了"。
     * @param raw - 写类操作键。
     * @param args - 调用参数（字段名严格匹配实测端点契约）。
     * @param opInput - 门禁所需 before/after/opType/label。
     * @param confirmed - 是否经用户确认（来自 UI「确认回写」）。
     */
    private executeWrite;
    /** 打标签（幂等 S-08；进入队列即打 dsh 标签，T48）。实测 schema：`{id:number, tags:string(分号拼接), collection?}`。 */
    addTags(workItemId: string | number, collection: string | undefined, tags: string[], beforeTags: string[], confirmed: boolean): Promise<WriteOutcome>;
    /** 变更状态。实测 schema：`{id:number, state:string, reason?, collection?}`。 */
    changeState(workItemId: string | number, collection: string | undefined, toState: string, beforeState: string, confirmed: boolean): Promise<WriteOutcome>;
    /** 追加评论（TFVC/变更集关联也走评论，S-04/T051）。实测 schema：`{id:number, comment:string, collection?}`。 */
    addComment(workItemId: string | number, collection: string | undefined, comment: string, confirmed: boolean): Promise<WriteOutcome>;
    /** 创建新工作项。实测 schema：必填 `project`/`workItemType`/`title`，其余可选，`fields` 承载自定义字段。 */
    createWorkItem(collection: string | undefined, spec: CreateWorkItemSpec, confirmed: boolean): Promise<WriteOutcome>;
    /** 指派工作项。实测 schema：`{id:number, assignedTo:string, collection?}`（注意字段名 assignedTo）。 */
    assign(workItemId: string | number, collection: string | undefined, assignTo: string, beforeAssignee: string, confirmed: boolean): Promise<WriteOutcome>;
    /**
     * 移除标签（问题 7「还原到需求池」使用）。
     *
     * ## 2026-10-04：改为**走 WriteGuard 四道门禁**
     *
     * 旧实现绕过适配层的写出口自己 `write.updateWorkItem`，于是：
     *   - 门禁 1（dry-run 预览）、2（人工确认）、3（幂等）全部未过；
     *   - 与 `tool-catalog.ts:26`「任何写操作必须过四道门禁，**不存在绕过路径**」的承诺矛盾；
     *   - 且用了 `' '` 作分隔符（`'; '`），而 add 分支用 `';'`，同一字段两种写法。
     * 现改为经 `executeWrite('tfs_remove_tags', …)`，与其它写操作完全同构。
     *
     * `confirmed` 由调用方给出：还原动作本身是用户在面板上的显式操作，构成人工确认。
     *
     * @returns 更新后的标签列表（失败时 `tags` 为移除前的原值）。
     */
    removeTags(workItemId: string | number, collection: string | undefined, tagsToRemove: string[], confirmed: boolean): Promise<{
        id: number;
        tags: string[];
    }>;
}
/** 适配层错误（工具未注册 / 调用失败）。 */
export declare class TfsAdapterError extends Error {
    constructor(message: string);
}
/** 适配层 `call()` 已实现 REST 分支的操作键（单一事实源，供能力目录标注缺口；问题 13 后覆盖契约全部 49 个操作）。 */
export declare const IMPLEMENTED_OPERATIONS: ReadonlySet<string>;
/**
 * 单次调用超时默认值：120s。
 *
 * REST 化后 rest-client 自带超时（默认 20s，见 `DEFAULT_REST_TIMEOUT_MS`），
 * 本常量保留仅为兼容既有引用（渐进移除）。
 */
export declare const DEFAULT_CALL_TIMEOUT_MS = 120000;
/**
 * 解包 `ToolExecutionResult.value`（MCP 信封）成业务载荷。
 *
 * REST 化后主路径不再经过 MCP 信封，但保留此函数：单测（adapter.spec.ts）仍用它
 * 验证信封解包行为，且若未来某能力回退 mcp 通道可复用。
 *
 * @param value - `ToolRunOutcome.value`。
 * @returns 业务载荷；无法解出时返回 `undefined`（调用方据此抛可读错误）。
 */
export declare function unwrapToolValue(value: unknown): unknown;
/** 列表响应体积熔断默认阈值：16MB（依据见 `TfsAdapterOptions.maxResponseBytes` 实测注释）。 */
export declare const DEFAULT_MAX_RESPONSE_BYTES: number;
/**
 * 旧 tfs-mcp 在 WIQL **命中 0 条**时抛出的内部错误特征串（2026-09-17 实测）。
 *
 * 实测：`{query:"SELECT [System.Id] FROM WorkItems WHERE [System.ChangedDate] >= '2026-09-16' AND ..."}`
 * 在 0 命中时返回 `items is not iterable (cannot read property null)`，而非空数组。
 * 这是 **tfs-mcp 侧缺陷**：把"没有数据"当成"查询失败"，若不归一化，UI 会把空需求池误报成连接故障。
 *
 * ## REST 化（2026-09-19）后本函数的现状：**已无调用点，仅作历史兼容保留**
 *
 * TFS REST 的 `POST /_apis/wit/wiql` 在 0 命中时**直接返回空数组**，
 * `rest-client.ts#queryWiql` 也据此直接返回 `[]`，不存在伪错 ⇒ `listRequirements` 里那个
 * `isWiqlEmptyResult` 分支**已不可能命中**。
 *
 * 保留原因：① 特征串本身是历史审计/验收记录里被反复引用的证据（specs/ 与 tasks.md 都按它描述
 * 旧行为），删掉会让那些记录失去对照物；② 万一将来回退到 mcp 通道，护栏不必重写。
 * **注意**：特征串取值是**实测事实**，不得改动，否则历史记录的对照失效。
 *
 * @param message - 已擦除凭据的错误文本。
 * @returns true = 属于"空结果"伪错误。
 */
export declare function isWiqlEmptyResult(message: string): boolean;
/**
 * 安全估算响应序列化**体积**（`JSON.stringify` 失败/循环引用时退化为 0，不抛）。
 *
 * ⚠️ 口径诚实说明：返回的是 `String.length`，即 **UTF-16 码元数**，不是 UTF-8 字节数。
 * 实测同一份真实响应：2,810,204 字符 / 2,983,788 字节（中文让字节数高约 6%）。
 * 用作熔断阈值时这是**偏保守**（先熔断）方向的误差，可接受，但命名保留 `Bytes` 需知此差异。
 */
export declare function safeSerializedBytes(raw: unknown): number;
/**
 * 取身份字段的可读字符串（TFS `IdentityRef`）。
 *
 * `System.AssignedTo` / `System.ChangedBy` 在 REST 路径上是 `IdentityRef` **对象**
 * （`{displayName, uniqueName, properties:{Account:{$value}}}`），不是字符串。
 * 直接 `String(v)` 会得到 `'[object Object]'`：列表里指派人不可读，且
 * `listRequirements` 的延迟指派筛选（`assignedTo.includes(a)`）永远匹配不上，
 * 中文姓名场景下筛选恒空。
 *
 * @param v - 身份字段原始值（IdentityRef 对象、字符串，或 undefined）。
 * @returns 依次尝试 `displayName` → `uniqueName` → `properties.Account.$value` →
 *   `properties.Mail.$value` → 字符串本身；都没有则空串。
 *
 * 导出供 `system-writeback` 复用（其 `getFields` 曾直接 `String(v)` 导致 IdentityRef
 * 字段变成 `"[object Object]"`，进而让回写前的幂等判断永远失配）。
 */
export declare function identityStr(v: unknown): string;
/**
 * 把 TFS 工作项归一化为需求摘要。
 *
 * 依据 **T013 实测**（`tfs_get_workitem` 返回的旧归一化扁平形状）：
 * `{ id, title, type, state, assignedTo, priority, areaPath, iterationPath, tags(分号字符串),
 *    changedDate, url, project, collection, ... }`。
 *
 * 对 `tfs_custom_query` 声明的 `{ id, fields: { 'System.Title': ... } }` 形状做兼容兜底：
 * 缺扁平字段时回退按标准字段引用取值。**REST 化后主路径走的正是这一支**——
 * `GET /_apis/wit/workitems?ids=` 返回 `{id, rev, fields:{...}}`，故该兼容分支反而成了常态。
 *
 * @param raw - TFS 返回的原始工作项对象（扁平形状、或 `{id, fields}` 包装）。
 * @param fallbackCollection - 集合兜底（响应未带 collection 时）。
 * @returns 需求摘要。
 */
export declare function normalizeWorkItem(raw: unknown, fallbackCollection: string): RequirementSummary;
/** WIQL 字符串字面量转义（单引号翻倍），避免注入（SC-008 安全面）。 */
export declare function escapeWiql(value: string): string;
/**
 * 该字面量能否安全进入 WIQL 的 **`CONTAINS`** 子句（纯可打印 ASCII 才可）。
 *
 * 实测依据（真实 TFS）：`CONTAINS '框架'` → **414**；`CONTAINS 'MEMORY'` → 正常；
 * `[System.State] = '不存在状态ZZZ'`（中文等值）→ 正常 `[]`。
 * ⇒ 限制只针对 `CONTAINS`，**等值 `=` 不受此限**。
 */
export declare function isAsciiSafe(value: string): boolean;
//# sourceMappingURL=adapter.d.ts.map
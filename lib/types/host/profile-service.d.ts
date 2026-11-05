/**
 * TFS 连接档案服务（T031 多 profile / FR-002 / FR-031 / S-12）。
 *
 * ## REST 化后的定位（2026-09-19）
 *
 * 本服务原先的旁支职责是"为 tfs-mcp 子进程准备启动环境"。REST 化后 **tfs-mcp 已整体移出**，
 * 本服务升格为本插件 TFS 凭据的**唯一来源**：
 *
 *   `ProfileService.restConfig()` → `TfsAdapter` 的 `restConfigProvider`
 *     → `/_apis/...` 的 `Authorization: Basic` 头
 *
 * 因此**改 PAT 当场生效、无需重启 dsh** —— 这是 REST 化带来的最直接的可用性提升。
 * 旧设计下 PAT 必须经 `cordis.patch.yml` 的 `env` 做 `!!js process.env.*` 声明，
 * 而 `!!js` 在**配置解析期**求值，早于任何插件 apply ⇒ 插件无法在运行期注入凭据。
 *
 * ## 为什么保留 `ProfileStore` 这一层
 *
 * 1. **`ProfileStore` 曾是死代码**：`src/profile/store.ts`（PAT 隔离、擦除删除）实现完整，
 *    但除自身模块外**全项目零引用**——FR-002/FR-031 在运行期并不存在。本模块把它接进宿主半。
 * 2. **凭据不落响应体/日志**是本模块的核心契约（见下方「安全契约」），
 *    而 REST 化让这条契约变得更关键：PAT 现在直接进 HTTP 头，泄漏面更大。
 *
 * ## 安全契约
 * - `list()` / `save()` / `activate()` **绝不回显 PAT**（只返回 `ProfileView`）；
 * - `getCredential()` 仅在 `restConfig()` 与导出用凭据文件这两条路径上被调用；
 * - `delete()` 走 `ProfileStore` 的随机字节覆写（S-12）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/profile-service
 */
import { ProfileStore } from '../profile/store.js';
import { type FsLike } from '../persistence/fs-like.js';
import type { EnvFileResult, McpEnvTemplate, McpInstanceInfo, ProfileOpResult, ProfileSaveInput, ProfileView } from '../shared/contracts.js';
/** 导出文件名（落插件数据目录，与 `profiles.json` 同目录）。 */
export declare const ENV_FILE_NAME = "tfs-credentials.env";
/** 导出文件里的变量名。 */
export declare const TFS_ENV_KEYS: {
    readonly url: 'TFS_URL';
    readonly collection: 'TFS_COLLECTION';
    readonly pat: 'TFS_PAT';
};
/** 依赖。 */
export interface ProfileServiceDeps {
    /** 插件数据目录。 */
    baseDir: string;
    /** profile 存储（可注入内存实现）。 */
    store?: ProfileStore;
    /** 可注入文件系统。 */
    fs?: FsLike;
}
/** 操作结果。 */
export type { ProfileOpResult } from '../shared/contracts.js';
/**
 * TFS 连接档案服务。
 */
export declare class ProfileService {
    private readonly deps;
    private readonly fs;
    private readonly store;
    private readonly activeStore;
    constructor(deps: ProfileServiceDeps);
    /** 导出文件绝对路径。 */
    get envFilePath(): string;
    /** 全部档案摘要（**不含 PAT**）。 */
    list(): ProfileView[];
    /** 取单个档案摘要；不存在返回 undefined。 */
    get(id: string): ProfileView | undefined;
    /** 当前活动档案 id（无则 undefined）。 */
    activeId(): string | undefined;
    /**
     * 活动档案的 REST 连接配置（REST 化改造，2026-09-19）。
     *
     * REST 化后本插件直连 TFS（不再经 tfs-mcp），adapter 需要 url/collection/pat 三件套。
     * 返回值**含 PAT 明文**，只允许交给 `TfsAdapter` 的 `rest` 配置（其内部仅在拼 Basic 头
     * 时使用，不进日志/审计/响应体）；无活动档案或凭据缺失时返回 `undefined`，
     * 调用方应提示用户先到「连接与凭据」页保存档案。
     */
    restConfig(collectionOverride?: string): {
        url: string;
        collection: string;
        pat: string;
    } | undefined;
    /**
     * 保存/更新档案。PAT 只进存储，**不回显**。
     *
     * 校验：`name` 非空、`url` 以 `http://` / `https://` 开头、`collection` 非空、`pat` 非空
     * （更新既有档案时 `pat` 可省略，表示"沿用原 PAT"——避免 UI 为了改名而被迫重新粘贴 PAT）。
     */
    save(input: ProfileSaveInput): ProfileOpResult;
    /** 删除档案（随机字节覆写，S-12）；若删除的是活动档案则清空活动指针。 */
    remove(id: string): ProfileOpResult;
    /**
     * 设为活动档案。
     *
     * **REST 化后是真的立即生效**（2026-09-19）：`TfsAdapter` 经 `restConfigProvider`
     * 每次调用都向本服务取最新凭据，故切换档案 = 下一次 TFS 调用就用新 url/PAT/集合，
     * 无需重启 dsh。调用方另需 `adapter.setCollection()` 把集合同步进本地默认值。
     *
     * （旧设计下这里只能"持久化指针"——已启动的 tfs-mcp 子进程环境改不了，必须重启。）
     */
    activate(id: string): ProfileOpResult;
    /**
     * 生成凭据导出模板（**PAT 用占位符，绝不含明文**）。
     *
     * 用途已从"给 tfs-mcp 子进程准备启动环境"变为**可移植的凭据备份/迁移**：
     * 换机器或换 dsh 实例时，按模板导出后重新导入即可，不必重新申请 PAT。
     * @param profileId - 指定档案；缺省用活动档案。
     */
    envTemplate(profileId?: string): McpEnvTemplate;
    /**
     * 直连 TFS REST 取**活的**项目清单（问题 3 修复，2026-09-19）。
     *
     * ## 为什么必须由本服务出这个口
     *
     * `tfs_get_projects` 在旧 tfs-mcp 里是**硬编码常量表**，不接受 `collection` 参数，
     * 且旧实现全库没有任何 `_apis/projects` 调用（都实测核实过）。WN_HIS 在表里只有 7 项
     * （还含拼错的 `Framework`），而真实有 **62** 项 ⇒ 体检管理 / 4.0产品后台 / ACIS / ASMC
     * 这些真实项目永远进不了下拉。
     *
     * 只有本服务同时持有 `url` 与 `pat`，所以这个 REST 调用只能放这里。凭据**只在本方法栈内**
     * 用于拼 Basic 头，不进返回值、不进日志（失败信息先过 `scrubCredentials`）。
     *
     * 用 Node 内置 `fetch`（Node ≥18），不引第三方 HTTP 依赖。
     *
     * @param collection - 目标集合；缺省用活动档案的集合。
     * @returns 项目名清单（已排序去重）；**任何失败返回 `undefined`**，调用方据此回退旧路径。
     */
    listLiveProjects(collection?: string): Promise<string[] | undefined>;
    /**
     * 把活动档案的凭据**写入导出文件**（明文只进文件，不回响应体）。
     *
     * 文件为 POSIX `export` 格式，供凭据备份/迁移使用（正常运行**不需要** source 它 ——
     * 插件直连 REST，凭据从活动档案实时读取）。真实文件系统上尽力收紧为 0600。
     * @param profileId - 指定档案；缺省用活动档案。
     */
    writeEnvFile(profileId?: string): EnvFileResult;
    /**
     * 连接诊断（T028b / REST 化后重定义）。
     *
     * **不再报告"要不要接 MCP"**（那个问题已随 REST 化消失）：现在报告本插件的真实连接形态 ——
     * 直连 `_apis/*`，凭据来自活动档案，读写路径只有适配层一条。
     *
     * 返回类型仍叫 `McpInstanceInfo`（契约稳定性：客户端半与路由都在用它），
     * 但字段语义已改为"连接诊断"，`serverName` 恒为空串、`serverNameValid` 恒 true。
     */
    instance(): McpInstanceInfo;
}
//# sourceMappingURL=profile-service.d.ts.map
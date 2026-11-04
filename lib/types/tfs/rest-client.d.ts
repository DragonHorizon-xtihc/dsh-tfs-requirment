/**
 * TFS REST 客户端（2026-09-19 REST 化改造，D2：纯函数式，不 import cordis）。
 *
 * ## 为什么存在（架构级约束变更）
 *
 * 用户铁律：TFS 看板的查询与操作**必须走 REST API**，不得依赖外部 tfs-mcp 进程。
 * 全部端点已于 2026-09-19 用真实 PAT 逐一实测通过（证据：
 * `docs/plans/2026-09-19-p0-probe-and-three-questions.md`），本文件即实测结论的代码化。
 *
 * ## 实测得到的硬事实（全部写死在此，勿凭记忆改）
 *
 * 1. **api-version 家族**：TFS 2018 只认 `4.1`；`7.1` / `7.2-preview` 一律 **404
 *    `Sorry, Page Not Found`**。预览资源（仅 `workitemtypes/{type}/states`）用 `4.1-preview`。
 * 2. **`connectionData` 不带 api-version**：`?api-version=4.1` → **400**；裸调用 → 200。
 * 3. **TFS 2018 的 `connectionData` 不返回路由表**（无 `serverCapabilities`）⇒ 端点路径硬编码。
 * 4. **身份字段**：只有 `providerDisplayName`（`displayName`/`uniqueName` 是 undefined）；
 *    更稳的来源是 `authorizedUser.properties.Account.$value`。
 * 5. **写回乐观并发**：`{"op":"test","path":"/rev","value":N}` 冲突时返回 **412**（不是 409）+
 *    错误码 `VS403351`；test 成功**不递增 rev**（无副作用）。
 * 6. **404 响应体是纯文本** `Sorry, Page Not Found`（不是 JSON）⇒ 错误归一必须先试
 *    `JSON.parse` 再回落文本，否则二次抛错。
 * 7. **集合名 ≠ 项目名**：`WHERE [System.TeamProject]='WN_HIS'` → 400「在层次结构中找不到
 *    指定的项目」。项目名唯一权威来源 = `GET /_apis/projects`。
 * 8. `GET /_apis/`（位置服务根）在此部署 **401**，不要依赖。
 *
 * @module dsh-tfs-requirment/tfs/rest-client
 */
/** TFS 2018 的主线 API 版本（`7.1` 家族会 404，勿改）。 */
export declare const API_VERSION = "4.1";
/** 预览资源专用版本（仅 `workitemtypes/{type}/states` 需要）。 */
export declare const API_VERSION_PREVIEW = "4.1-preview";
/** REST 调用默认超时（毫秒）。 */
export declare const DEFAULT_REST_TIMEOUT_MS = 20000;
/** REST 连接配置（凭据只在调用栈内使用，不持久化在本模块任何字段）。 */
export interface RestConfig {
    /** TFS 基址，如 `http://tfs2018-web.winning.com.cn:8080/tfs`（末尾斜杠会被规整）。 */
    url: string;
    /** 集合名，如 `WN_HIS`。 */
    collection: string;
    /** PAT 明文（仅在拼 Basic 头时使用；任何日志/错误先过 scrubCredentials）。 */
    pat: string;
    /** 超时毫秒（缺省 20s）。 */
    timeoutMs?: number;
    /** fetch 实现（测试打桩用；缺省全局 fetch）。 */
    fetchImpl?: typeof fetch;
}
/** 归一化后的 REST 失败（比 HTTPError 多一层"业务可读"语义）。 */
export declare class RestError extends Error {
    /** HTTP 状态码（网络错误时为 0）。 */
    readonly status: number;
    /** TFS 业务错误码（如 `VS403351` / `TF51535`），无则空串。 */
    readonly code: string;
    constructor(message: string, status: number, code?: string);
}
/** 判定「该工作项已被他人修改」（rev test 冲突，实测 412 + VS403351）。 */
export declare function isRevConflict(e: unknown): e is RestError;
/** 判定「资源不存在 / 项目名非法」（404 纯文本或 400 找不到项目）。 */
export declare function isNotFound(e: unknown): e is RestError;
/** 判定「凭据失效」（401）。 */
export declare function isUnauthorized(e: unknown): e is RestError;
/** Basic 认证头（`base64(":" + PAT)`，TFS 2018 实测形态）。 */
export declare function basicAuth(pat: string): string;
/**
 * 明文传输提示（不阻断调用）。
 *
 * PAT 只以 base64 出现在 `Authorization` 头里——那是**可逆编码，不是加密**。
 * 基址是 `http://` 时凭据与全部工作项内容都以明文过网。此处只产出提示文本，
 * 由调用方并入面向用户的可读原因（失败时用户必然看得到），成功路径不打扰。
 *
 * @param cfg - REST 连接配置。
 * @returns 提示文本；传输方式无风险时返回 `undefined`。
 */
export declare function restTransportNotice(cfg: RestConfig): string | undefined;
/**
 * 从 TFS 错误响应体萃取可读消息与业务错误码。
 *
 * 实测的两种形态：
 *   - JSON：`{"$id":"1","message":"VS403351: Test Operation ...","typeName":"..."}`
 *   - 纯文本：`Sorry, Page Not Found`（404）
 * 先试 JSON.parse 再回落文本；全文先过 scrubCredentials（错误体可能回显请求 URL）。
 */
export declare function parseErrorBody(status: number, rawBody: string): RestError;
/** 从 rev 冲突消息里抽实际 rev（`value 8 was not equal to test value 999999` → 8）。 */
export declare function extractActualRev(message: string): number | undefined;
/** 请求初始化（问题 13 扩展：原始字节体 / 绝对 URL / 自定义 Accept）。 */
export interface RestRequestInit {
    /** JSON 对象（默认 JSON.stringify），或 Uint8Array/字符串原始体（配合 octet-stream）。 */
    body?: unknown;
    contentType?: string;
    /** api-version：缺省 4.1；false = 不带；字符串 = 指定版本。 */
    apiVersion?: string | false;
    /** 绝对地址（如附件 URL）：原样使用，不拼集合段，默认也不追加 api-version。 */
    absolute?: boolean;
    /** 服务器级路径：拼 baseUrl + path 但不拼集合段（如 /_apis/projectCollections）。 */
    serverLevel?: boolean;
    /** 覆盖 Accept 头（下载二进制用 application/octet-stream）。 */
    accept?: string;
    /**
     * 把响应头交给调用方（分页游标 `x-ms-continuationtoken` 用）。
     *
     * TFS 2018 的列表端点在结果超过 `$top` 时**不报错**，而是在响应头里回一个游标，
     * 请求方必须带游标再取一页。缺少游标处理时，超限结果被静默丢弃，调用方拿到的是
     * 截断后的清单却以为它是完整的。
     *
     * 头对象允许为 `undefined`：测试打桩的 fetch 实现未必构造完整 `Response`，
     * 读游标的一方必须能容忍这种桩（视为「无游标」，即当作已取完）。
     */
    captureHeaders?: (headers: Headers | undefined) => void;
    /** 续取令牌：作为 `x-ms-continuationtoken` **请求头**发出（TFS 分页游标走头，不走查询串）。 */
    continuationToken?: string;
}
/** 二进制下载结果（附件 / TFVC 文件）。 */
export interface BlobResult {
    /** 文件字节。 */
    buffer: Buffer;
    /** 响应 Content-Type。 */
    contentType: string;
    /** Content-Disposition 头（可能含服务端给出的文件名）。 */
    disposition: string;
}
/** 项目（`_apis/projects` 返回项）。 */
export interface RestProject {
    id: string;
    name: string;
    state?: string;
}
/** `connectionData` 的身份信息（只取实测确认存在的字段）。 */
export interface RestIdentity {
    /** 账号名，如 `zhangbo3`（来自 authorizedUser.properties.Account）。 */
    account?: string;
    /** 显示名，如 `zhangbo3(张波)`（providerDisplayName）。 */
    displayName?: string;
    /** 实例 id。 */
    instanceId?: string;
}
/** REST 读路径（无状态；每次调用传入 cfg）。 */
export interface TfsRestRead {
    /** 活项目清单（`GET /_apis/projects?api-version=4.1&$top=1000`）。 */
    listProjects(): Promise<RestProject[]>;
    /** WIQL 查询，返回 `{workItems: [{id, url}]}`（0 命中 = 空数组，不抛）。 */
    queryWiql(query: string): Promise<Array<{
        id: number;
        url?: string;
    }>>;
    /** 批量取工作项（`?ids=...&fields=...`）。 */
    getWorkItems(ids: number[], fields?: string[]): Promise<Array<Record<string, unknown>>>;
    /** 单工作项（GET，可选指定字段）。 */
    getWorkItem(id: number, fields?: string[]): Promise<Record<string, unknown>>;
    /** 项目级工作项类型名清单（`GET /{project}/_apis/wit/workitemtypes`）。 */
    listWorkItemTypes(project: string): Promise<string[]>;
    /** 类型可用状态（`GET /{project}/_apis/wit/workitemtypes/{type}/states`，⚠️ 4.1-preview）。 */
    listStates(project: string, type: string): Promise<string[]>;
    /** 身份探测（`GET /_apis/connectionData`，⚠️ 不带 api-version）。 */
    whoAmI(): Promise<RestIdentity>;
    /**
     * 通用 GET（逃逸舱口）：给尚未有专用方法的端点用（TFVC 等）。
     *
     * 存在理由：`TfsRestRead` 不可能穷举 TFS 的每个端点；新增能力时先用本方法接入，
     * 稳定后再提升为专用方法。**不允许**用它绕过写路径（写一律走 `TfsRestWrite`）。
     *
     * @param path - 以 `/` 开头的集合相对路径（如 `/_apis/tfvc/changesets/123`）。
     * @param init - `apiVersion:false` 关闭 api-version 查询串；`continuationToken` 作为
     * `x-ms-continuationtoken` **请求头**带上服务端上一页给的游标；`captureHeaders` 用于
     * 读取响应头里的下一游标（见 {@link CONTINUATION_HEADER}）。
     */
    getJson<T = Record<string, unknown>>(path: string, init?: {
        apiVersion?: string | false;
        continuationToken?: string;
        captureHeaders?: (headers: Headers | undefined) => void;
    }): Promise<T>;
    /**
     * 服务器级 GET（不拼集合段，问题 13 `tfs_list_collections` 用）。
     * @param path - 以 `/` 开头的服务器相对路径（如 `/_apis/projectCollections`）。
     */
    serverGetJson<T = Record<string, unknown>>(path: string, apiVersion?: string | false): Promise<T>;
    /** 通用 JSON POST（执行已保存查询 `wiql/{id}` 等非写门禁只读查询用）。 */
    postJson<T = Record<string, unknown>>(path: string, body: unknown, apiVersion?: string | false): Promise<T>;
    /** 下载二进制（附件内容、TFVC 文件；传绝对 URL 时原样请求）。 */
    getBlob(path: string, absolute?: boolean): Promise<BlobResult>;
}
/** 响应头里的分页游标（TFS 2018 列表端点的续取令牌）。 */
export declare const CONTINUATION_HEADER = "x-ms-continuationtoken";
/**
 * 逐页取回一个 `value` 列表端点，跟随 `x-ms-continuationtoken` 直到取完。
 *
 * TFS 2018 不会因为结果被 `$top` 截断而报错，只回游标头；不跟随游标就会把
 * 「前 N 条」当成「全部」，而调用方（项目清单、PR 列表、变更条目、提交批次、
 * 仓库清单）都按全集做后续处理。
 *
 * @param fetchPage - 取一页：`{ $skip, continuationToken } → { items, nextToken }`。
 * @param opts.maxPages - 安全上限（页），防止服务端持续回游标导致无限翻页。
 * @returns 全部条目（保持服务端顺序）。
 */
export declare function collectPaged<T>(fetchPage: (input: {
    $skip: number;
    continuationToken?: string;
}) => Promise<{
    items: T[];
    nextToken?: string;
}>, opts?: {
    maxPages?: number;
}): Promise<T[]>;
/** 创建 REST 读客户端。 */
export declare function createRestRead(cfg: RestConfig): TfsRestRead;
/** JSON Patch 操作。 */
export interface JsonPatchOp {
    op: 'add' | 'replace' | 'test' | 'remove';
    path: string;
    value?: unknown;
}
/**
 * 组装带 rev 乐观并发的 PATCH 体（D7）。
 *
 * rev 已知时首条插 `{"op":"test","path":"/rev","value":rev}`（实测：test 成功不递增 rev，
 * 冲突返回 412 + VS403351）；rev 未知时直接用业务操作（服务端仍按最后写入者胜）。
 */
export declare function buildPatchOps(ops: JsonPatchOp[], rev?: number): JsonPatchOp[];
/** REST 写路径。 */
export interface TfsRestWrite {
    /**
     * 更新工作项（PATCH json-patch）。
     * @returns 更新后的工作项（含新 rev）。rev 冲突抛 RestError(412, 'VS403351')。
     */
    updateWorkItem(id: number, ops: JsonPatchOp[], rev?: number): Promise<Record<string, unknown>>;
    /** 创建工作项（POST，json-patch）。 */
    createWorkItem(project: string, type: string, ops: JsonPatchOp[]): Promise<Record<string, unknown>>;
    /**
     * 通用 JSON POST（创建 PR、PR 评论线程等问题 13 写端点）。
     *
     * ⚠️ 刻意**不叫 `postJson`**（2026-10-05 修复）：只读的 `TfsRestRead.postJson` 同名，
     * 但第三参是 `apiVersion`；这里第三参是 `contentType`。同名同位置、语义相反，
     * 任何把一侧换成另一侧的改动都会**静默**改变语义（传 `'4.1-preview'` 会被当 Content-Type
     * 发出；传 `'application/json'` 会被拼成 `api-version=application/json`）。
     * 改名后两侧不可能互相误用。
     *
     * @param path - 集合相对路径。
     * @param body - 请求体（按 JSON 序列化）。
     * @param contentType - 请求 Content-Type，缺省 `application/json`。
     */
    postJsonWithType<T = Record<string, unknown>>(path: string, body: unknown, contentType?: string): Promise<T>;
    /**
     * 上传附件二进制（问题 13：`POST /_apis/wit/attachments?fileName=...`，
     * octet-stream 原始字节体；返回 {id,url} 后再 PATCH 工作项 relations/- 关联 AttachedFile）。
     * @returns 附件描述（含 id/url）。
     */
    uploadAttachment(path: string, buffer: Uint8Array): Promise<Record<string, unknown>>;
}
/** 创建 REST 写客户端。 */
export declare function createRestWrite(cfg: RestConfig): TfsRestWrite;
//# sourceMappingURL=rest-client.d.ts.map
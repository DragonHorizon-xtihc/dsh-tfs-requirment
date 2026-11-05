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
 * @module @deepseek-ai/dsh-tfs-requirment/tfs/adapter
 */
import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { labelIdempotencyKey, stableHash, writeIdempotencyKey } from '../write-guard/idempotency.js';
import { scrubCredentials } from '../shared/redact.js';
import { htmlToPlainText, truncateText, MAX_DESCRIPTION_CHARS } from '../shared/text.js';
import { createRestRead, createRestWrite, extractActualRev, isNotFound, isRevConflict, isUnauthorized, CONTINUATION_HEADER, collectPaged, restTransportNotice, RestError, } from './rest-client.js';
import { buildWiql, wiqlEscape } from './wiql-builder.js';
/**
 * 允许重复执行、不参与幂等判重的写类操作。
 *
 * 共同特征：**只往本地磁盘落文件，不改 TFS 上任何字段**（下载附件 / 下载 TFVC 文件 /
 * 按路径保存 TFVC 文件）。重复执行只会重新落一份同样的文件，属于用户预期行为；
 * 而它们的参数化幂等键对同一组参数恒定，判重会把合法的重跑误杀。
 */
const REPEATABLE_WRITE_OPS = new Set([
    'tfs_download_attachments',
    'tfs_download_tfvc_files',
    'tfs_get_tfvc_file',
]);
/**
 * TFS 适配层：业务层唯一出口。
 */
export class TfsAdapter {
    rest;
    restRead;
    restWrite;
    writeGuard;
    profileLabel;
    maxResponseBytes;
    liveProjects;
    restConfigProvider;
    knownCollections;
    downloadsDir;
    allowExternalDownloadDir;
    queryOptionsConcurrency;
    /** 单次 REST 调用超时（见 {@link TfsAdapterOptions.callTimeoutMs}）；undefined = 用缺省 20s。 */
    callTimeoutMs;
    defaultCollection;
    /**
     * 运行期 PAT 覆盖（问题 13 `tfs_update_token`）。
     *
     * 只存在于进程内存，绝不写回本插件存储；`restFor` 合并到每次调用的配置上。
     * 与 restConfigProvider 的关系：provider 给出活动档案的 url/集合，运行期 PAT 优先于其中的 pat。
     */
    runtimePat;
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
    restClientCache = new Map();
    static REST_CACHE_LIMIT = 8;
    /**
     * 路径 B（含无法下推 WIQL 的非 ASCII 关键字/指派人）时，按 ChangedDate DESC 扫描取字段的
     * 最大 id 数。取 1000（5 批 × 200），兼顾过滤覆盖度与请求耗时，避免退化为全集合串行拉取。
     */
    static DEFERRED_SCAN_CAP = 1000;
    constructor(opts) {
        this.callTimeoutMs = opts.callTimeoutMs;
        this.rest = opts.rest;
        if (opts.rest) {
            // 超时并入**装配期快照**，使预填缓存槽与 `restFor` 生成的配置同形
            // （否则同一个 url+collection+pat 会算出两个不同指纹，缓存预填空转）。
            const bootRest = opts.callTimeoutMs !== undefined ? { ...opts.rest, timeoutMs: opts.callTimeoutMs } : opts.rest;
            this.restRead = createRestRead(bootRest);
            this.restWrite = createRestWrite(bootRest);
            // 预填装配期快照的缓存槽，使无 provider 的旧装配/测试桩行为与之前完全一致。
            this.restClientCache.set(this.restFingerprint(bootRest), {
                read: this.restRead,
                write: this.restWrite,
            });
        }
        this.writeGuard = opts.writeGuard;
        this.profileLabel = opts.profileLabel;
        this.defaultCollection = opts.collection;
        this.maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
        this.liveProjects = opts.liveProjects;
        this.restConfigProvider = opts.restConfigProvider;
        this.knownCollections = opts.knownCollections ?? [];
        this.downloadsDir = opts.downloadsDir ?? path.join(process.cwd(), 'downloads');
        this.allowExternalDownloadDir = opts.allowExternalDownloadDir === true;
        this.queryOptionsConcurrency = Math.max(1, Math.trunc(opts.queryOptionsConcurrency ?? DEFAULT_QUERY_OPTIONS_CONCURRENCY) || 1);
    }
    /**
     * 运行期替换 PAT（问题 13 `tfs_update_token`）。
     *
     * 仅当前进程内存生效，不写回任何存储；替换后清空 REST 客户端缓存，让所有槽位都用新凭据
     * 重建（指纹已含 PAT 摘要，换 token 自然换槽，清缓存只是不让旧凭据的槽继续占位）。
     * @param pat - 新 PAT 明文。
     */
    updateToken(pat) {
        this.runtimePat = pat;
        this.restClientCache.clear();
        if (this.rest) {
            const merged = { ...this.rest, pat };
            this.restClientCache.set(this.restFingerprint(merged), {
                read: createRestRead(merged),
                write: createRestWrite(merged),
            });
        }
    }
    /**
     * 传输层告警（供 `runHealthCheck` 透到「连接与凭据」面板）。
     *
     * 目前只有一条：基址是 `http:`，PAT 仅以可逆 base64 过网。自检不因此判失败
     * （连通性由 whoami 定），但必须让人看见 —— 否则等于默默用明文信道送凭据。
     *
     * @returns 告警文本；配置缺失、地址不可解析或已是 https 时返回 `undefined`。
     */
    transportNotice() {
        let cfg;
        try {
            cfg = this.restConfigProvider?.() ?? this.rest;
        }
        catch {
            cfg = this.rest;
        }
        if (!cfg)
            return undefined;
        return restTransportNotice(cfg);
    }
    /**
     * REST 客户端缓存指纹（url/集合/PAT 摘要；不含 PAT 明文）。
     *
     * PAT 走 `stableHash` 的 FNV-1a 摘要而非明文或长度：明文会随指纹泄漏到任何打印键的地方，
     * 长度则会让等长换 token 的档案复用旧客户端。
     */
    restFingerprint(config) {
        // 超时也进指纹：否则改了 `callTimeoutMs` 后，同一 (url,集合,pat) 会命中**旧超时**的
        // 缓存客户端，配置"传了不生效"依旧成立（且只在改配置后才显形，极难排查）。
        return `${config.url}|${config.collection ?? ''}|pat:${stableHash(config.pat ?? '')}|t:${config.timeoutMs ?? ''}`;
    }
    /**
     * 集合切换 + 动态凭据：REST 客户端按集合拼 URL，切集合/换档案 = 换一份配置。
     * （对比旧 mcp 路径：以前靠内联 `collection` 参数逐调用透传。）
     *
     * 配置解析顺序（2026-09-19）：**每次调用**先问 `restConfigProvider`（活动档案的最新
     * url/PAT/集合），拿不到才回落装配期冻结的 `rest` 快照。按指纹缓存客户端，上限
     * {@link REST_CACHE_LIMIT}，超出淘汰最久未用项。
     */
    restFor(collection) {
        const snapshot = this.rest;
        const dynamic = (() => {
            try {
                return this.restConfigProvider?.();
            }
            catch {
                // 提供者读档案失败不应把整次 TFS 调用打崩；回落快照。
                return undefined;
            }
        })();
        const base = dynamic ?? snapshot;
        // 防御：两条通路都没有配置（装配期未拿到 PAT/连接档案、当前也无活动档案）时给出
        // 可执行的诊断，而不是 `Cannot read properties of undefined (reading 'collection')`
        // 这种泄漏到 UI 的无信息报错。
        if (!base) {
            throw new TfsAdapterError('TFS 连接未配置（缺少 REST 凭据）：请到「连接与凭据」页选择连接档案并填写 PAT');
        }
        const col = collection ?? this.defaultCollection ?? base.collection;
        // 运行期 PAT 覆盖（tfs_update_token）优先于档案/快照里的 pat。
        const withPat = this.runtimePat ? { ...base, pat: this.runtimePat } : base;
        // `callTimeoutMs` 在此**真正生效**（此前是声明了从不读取的死字段）：
        // 不传时 `timeoutMs` 为 undefined ⇒ rest-client 用 `DEFAULT_REST_TIMEOUT_MS`，
        // 与改动前行为完全一致（不会把默认超时改成别的值）。
        const timed = this.callTimeoutMs !== undefined ? { ...withPat, timeoutMs: this.callTimeoutMs } : withPat;
        const config = col && col !== timed.collection ? { ...timed, collection: col } : timed;
        const fingerprint = this.restFingerprint(config);
        const hit = this.restClientCache.get(fingerprint);
        if (hit) {
            // Map 保持插入序，命中后重新插入把它挪到末尾，淘汰才是真正的 LRU；
            // 直接返回（不重插）实际是 FIFO：热点档案会被自己挤出去。
            this.restClientCache.delete(fingerprint);
            this.restClientCache.set(fingerprint, hit);
            return { ...hit, config };
        }
        const pair = { read: createRestRead(config), write: createRestWrite(config) };
        this.restClientCache.set(fingerprint, pair);
        // 超限时删最早的键（Map 保持插入序）。
        if (this.restClientCache.size > TfsAdapter.REST_CACHE_LIMIT) {
            const oldest = this.restClientCache.keys().next().value;
            if (oldest !== undefined)
                this.restClientCache.delete(oldest);
        }
        return { ...pair, config };
    }
    /**
     * REST 错误 → 可读消息（含 rev 冲突的"实际 rev"提示）。
     * 全文先过 scrubCredentials：URL/错误体可能回显请求串。
     */
    restErrorMessage(e) {
        if (e instanceof Error) {
            let msg = scrubCredentials(e.message);
            if (isRevConflict(e)) {
                const actual = extractActualRev(msg);
                msg = actual !== undefined
                    ? `该工作项已被他人修改（服务器当前 rev ${actual}），请刷新后重试`
                    : '该工作项已被他人修改（rev 不匹配），请刷新后重试';
            }
            else if (isUnauthorized(e)) {
                msg = `认证失败（401）：PAT 缺失或已失效，请到「连接与凭据」页检查`;
            }
            else if (isNotFound(e)) {
                msg = `资源不存在（404/项目名非法）：${msg}`;
            }
            return msg;
        }
        return scrubCredentials(String(e));
    }
    /** 内联集合参数（REST 化后为兼容保留：旧调用点仍传 collection，call() 分支自行处理）。 */
    withCollection(collection) {
        const c = collection ?? this.defaultCollection;
        return c ? { collection: c } : {};
    }
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
    callLocalCollection() {
        let cfg;
        try {
            cfg = this.restConfigProvider?.() ?? this.rest;
        }
        catch {
            // 提供者读档案失败不应让「当前集合」也答不出来；回落装配期快照，缺失则见下。
            cfg = this.rest;
        }
        const name = this.defaultCollection ?? cfg?.collection ?? '';
        const base = cfg?.url ?? '';
        return {
            name,
            url: base ? `${base.replace(/\/+$/, '')}/${name}` : '',
            configured: Boolean(this.runtimePat ?? cfg?.pat),
        };
    }
    /**
     * 纯本地分派：切换默认集合（`tfs_set_collection`）。
     *
     * 只改本地默认值，不写 TFS；集合名必须在装配点已知的清单内。
     */
    callLocalSetCollection(a) {
        const name = String(a['collection'] ?? a['collectionName'] ?? '').trim();
        if (!name)
            throw new TfsAdapterError('tfs_set_collection 需要 collection 参数');
        if (this.knownCollections.length > 0 && !this.knownCollections.includes(name)) {
            throw new TfsAdapterError(`集合不存在：${name}。可用集合：${this.knownCollections.join(', ')}`);
        }
        this.setCollection(name);
        return {
            success: true,
            message: `默认集合已设置为: ${name}（仅在当前会话生效）`,
            collection: name,
        };
    }
    /**
     * 纯本地分派：进程内覆盖 PAT（`tfs_update_token`）。
     *
     * 这是**凭据缺失或过期时的恢复动作**，所以绝不能要求先有可用凭据（A20）。
     * 新 PAT 只活在进程内存里，绝不写回档案或磁盘。
     */
    callLocalUpdateToken(a) {
        const pat = String(a['pat'] ?? a['token'] ?? a['password'] ?? '');
        if (!pat)
            throw new TfsAdapterError('tfs_update_token 需要 pat/token 参数');
        this.updateToken(pat);
        return { success: true, message: '访问令牌已更新（仅当前进程内存生效，不写入存储）' };
    }
    async call(raw, args) {
        const a = (args ?? {});
        const collection = typeof a['collection'] === 'string' ? a['collection'] : undefined;
        /**
         * 三个**纯本地**操作必须先于 `restFor` 处理（A20）。
         *
         * `restFor` 会校验凭据存在，缺失即抛「TFS 连接未配置」。但这三个操作根本不碰网络：
         * 「当前集合」是本地配置事实、「更新令牌」正是**凭据缺失/过期时的恢复动作**、
         * 「切换集合」只改本地默认值。把它们放在 `restFor` 之后，等于"没凭据时唯一能报错的
         * 那个工具恰好也报不了错"—— 模型和人都拿不到下一步。
         */
        if (raw === 'tfs_get_current_collection')
            return this.callLocalCollection();
        if (raw === 'tfs_set_collection')
            return this.callLocalSetCollection(a);
        if (raw === 'tfs_update_token')
            return this.callLocalUpdateToken(a);
        // `restFor` 会在此校验凭据存在（缺失即抛可执行诊断），并解析出本次调用实际生效的
        // 配置（动态档案优先，见 restConfigProvider）。
        const { read, write, config: restCfg } = this.restFor(collection);
        const inner = (collection ?? this.defaultCollection ?? restCfg.collection) ?? '';
        try {
            switch (raw) {
                // ── 读：WIQL 两段式（WIQL 拿 id → 批量取全字段。REST 无 tfs-mcp 的 ~200 条伪错，
                // 但服务端对一次 WIQL 返回的 id 数仍有大小限制，保持 listRequirements 的熔断护栏）。
                case 'tfs_query_wiql': {
                    // 契约键按**契约表为准**：`tool-catalog.ts` 给 `tfs_query_wiql` 声明的参数名是
                    // `wiql`（模型侧 schema 由 `toolParameterSpec` 从它生成，只有这个名字可见）。
                    // 旧实现只读 `query`，于是模型按 schema 传 wiql 必然拿到
                    // 「WIQL 查询缺少 query 参数」——该工具对模型 100% 不可用（2026-10-04 实测）。
                    // `query` 保留为内部别名（`tfs_get_my_tasks` 等内部调用在用），不以大而化之删。
                    const rawWiql = a['wiql'] ?? a['query'];
                    const query = typeof rawWiql === 'string' ? rawWiql : '';
                    if (!query)
                        throw new TfsAdapterError('WIQL 查询缺少 wiql 参数');
                    const hits = await read.queryWiql(query);
                    if (hits.length === 0)
                        return [];
                    const ids = hits.map(h => h.id);
                    const fields = [
                        'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
                        'System.AssignedTo', 'System.ChangedDate', 'System.AreaPath',
                        'System.IterationPath', 'System.Tags', 'System.TeamProject',
                        'Microsoft.VSTS.Common.Priority',
                        // 问题 11：目标填充需要正文四段（System.Description + 三个 Winning 自定义字段）。
                        'System.Description',
                        'Winning.Demand.Analysis', 'Winning.Data.Design', 'Winning.Demand.Config',
                    ];
                    // 分批取（每批 200，实测安全值），避免 URL 过长。
                    const rows = [];
                    for (let i = 0; i < ids.length; i += 200) {
                        rows.push(...(await read.getWorkItems(ids.slice(i, i + 200), fields)));
                    }
                    // REST 返回 `{id, rev, fields:{...}}` 形状；normalizeWorkItem 已兼容该形状。
                    // 为保住旧列表语义（tfs-mcp 曾返回扁平字段），透传原始形状给归一化层。
                    return rows;
                }
                case 'tfs_get_projects': {
                    const projects = await read.listProjects();
                    // 对齐旧 `tfs_get_projects` 返回形状 `[{id, name, collection}]`。
                    return projects.map(p => ({ id: p.id, name: p.name, collection: inner }));
                }
                case 'tfs_whoami': {
                    const me = await read.whoAmI();
                    // 对齐旧 `tfs_whoami` 可读形状：`uniqueName`/`displayName`。
                    return {
                        uniqueName: me.account ?? me.displayName ?? '',
                        displayName: me.displayName ?? me.account ?? '',
                        identity: me,
                    };
                }
                case 'tfs_get_work_items': {
                    const ids = Array.isArray(a['ids'])
                        ? a['ids'].map(v => Number(v)).filter(Number.isFinite)
                        : [];
                    const rows = await read.getWorkItems(ids);
                    return rows;
                }
                case 'tfs_get_workitem': {
                    const id = Number(a['id']);
                    const row = await read.getWorkItem(id);
                    return row;
                }
                case 'tfs_get_my_tasks': {
                    // WIQL：分配给我、未关闭的任务（对齐旧工具语义；身份用 connectionData 账号）。
                    const me = await read.whoAmI();
                    const who = me.account ?? '';
                    const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.WorkItemType] = 'Task' ` +
                        `AND [System.State] <> 'Closed' AND [System.AssignedTo] CONTAINS '${who.replace(/'/g, "''")}' ` +
                        `ORDER BY [System.ChangedDate] DESC`;
                    return await this.call('tfs_query_wiql', { query: wiql, collection });
                }
                // ── TFVC（2026-09-19 实测全部 200，api-version=4.1） ──
                // | `tfs_list_tfvc_changesets`    | `GET /_apis/tfvc/changesets?...` |
                // | `tfs_get_tfvc_changeset`      | `GET /_apis/tfvc/changesets/{id}`（**不含** changes/workItems） |
                // | `tfs_get_work_item_commits`   | `GET /_apis/wit/workItems/{id}/revisions` 不含提交 ⇒ 用 changesets 按工作项过滤 |
                case 'tfs_list_tfvc_changesets': {
                    const qs = new URLSearchParams();
                    // 只发允许的字段（对齐旧 schema 的 additionalProperties:false 语义）。
                    for (const k of ['author', 'itemPath', 'fromDate', 'toDate', 'fromId', 'toId']) {
                        const v = a[k];
                        if (v !== undefined && v !== null && String(v).length > 0)
                            qs.set(k, String(v));
                    }
                    if (typeof a['top'] === 'number')
                        qs.set('$top', String(a['top']));
                    if (typeof a['skip'] === 'number')
                        qs.set('$skip', String(a['skip']));
                    const q = qs.toString();
                    const j = await read.getJson(`/_apis/tfvc/changesets${q ? `?${q}` : ''}`);
                    return (Array.isArray(j?.value) ? j.value : []);
                }
                case 'tfs_get_tfvc_changeset': {
                    const cid = Number(a['changesetId']);
                    if (!Number.isFinite(cid))
                        throw new TfsAdapterError('tfs_get_tfvc_changeset 需要 changesetId');
                    const j = await read.getJson(`/_apis/tfvc/changesets/${cid}`);
                    // 形状归一：旧 tfs-mcp 返回 `{author: '名字', createdDate, comment}`；
                    // REST 的 `author` 是 `{displayName, uniqueName}` 对象 ⇒ 拍平以保住旧语义。
                    const authorRaw = j['author'];
                    const author = typeof authorRaw === 'string'
                        ? authorRaw
                        : typeof authorRaw?.['displayName'] === 'string'
                            ? authorRaw['displayName']
                            : typeof authorRaw?.['uniqueName'] === 'string'
                                ? authorRaw['uniqueName']
                                : undefined;
                    return {
                        changesetId: j['changesetId'] ?? cid,
                        author,
                        createdDate: j['createdDate'],
                        comment: j['comment'],
                    };
                }
                case 'tfs_get_work_item_commits': {
                    const wid = Number(a['workItemId'] ?? a['id']);
                    if (!Number.isInteger(wid) || wid <= 0) {
                        throw new TfsAdapterError('tfs_get_work_item_commits 需要工作项 id 参数（workItemId）');
                    }
                    /**
                     * TFVC 变更集与工作项的关联**没有服务端查询**：TFS 2018 的
                     * `GET /_apis/tfvc/changesets` 只接受 fromId/toId/fromDate/toDate/
                     * fromUser/toUser/itemPath 若干 `searchCriteria.*` 维度，没有 `workItemId`。
                     * 早先这里发 `searchCriteria=workItemId:<id>` —— 服务端会**静默忽略**这个未知
                     * 维度并返回集合里最新的 100 个变更集，于是"工作项关联提交"列出的是别人的提交。
                     *
                     * 现改为按游标分页拉取最近的变更集（`includeWorkItems=true` 让每个变更集带上
                     * 关联的工作项），在客户端过滤。这是有界的"最近窗口"扫描：TFS 侧没有更精确的
                     * 入口，窗口上限 {@link WORK_ITEM_COMMITS_SCAN_LIMIT} 在返回里如实说明扫了多少个。
                     */
                    const seen = new Set();
                    const matched = [];
                    let scanned = 0;
                    let token;
                    while (scanned < WORK_ITEM_COMMITS_SCAN_LIMIT) {
                        const qs = new URLSearchParams({
                            $top: String(Math.min(200, WORK_ITEM_COMMITS_SCAN_LIMIT - scanned)),
                            includeWorkItems: 'true',
                        });
                        let next;
                        const page = await read.getJson(`/_apis/tfvc/changesets?${qs.toString()}`, {
                            captureHeaders: headers => {
                                next = headers?.get(CONTINUATION_HEADER) ?? undefined;
                            },
                            ...(token ? { continuationToken: token } : {}),
                        });
                        const items = Array.isArray(page?.value) ? page.value : [];
                        scanned += items.length;
                        for (const cs of items) {
                            const csid = Number(cs['changesetId']);
                            if (Number.isInteger(csid)) {
                                if (seen.has(csid))
                                    continue;
                                seen.add(csid);
                            }
                            const links = cs['workItems'];
                            if (!Array.isArray(links))
                                continue;
                            const linked = links.some(link => {
                                const l = link;
                                return Number(l['id']) === wid || String(l['url'] ?? '').endsWith(`/${wid}`);
                            });
                            if (linked)
                                matched.push(cs);
                        }
                        if (!next || items.length === 0)
                            break;
                        token = next;
                    }
                    return {
                        workItemId: wid,
                        scannedChangesets: scanned,
                        scannedLimit: WORK_ITEM_COMMITS_SCAN_LIMIT,
                        note: 'TFVC 变更集与工作项之间没有服务端查询接口（TFS 2018 不支持 searchCriteria.workItemId），此结果来自最近窗口的客户端过滤；早于该窗口的关联提交不会出现在这里。',
                        total: matched.length,
                        changesets: matched,
                    };
                }
                // ── 写：全部过 WriteGuard 四道门禁（在 executeWrite 层），此处只做端点映射。
                case 'tfs_change_state': {
                    const id = requireWorkItemId(a, 'tfs_change_state');
                    const state = String(a['state'] ?? '').trim();
                    if (!state)
                        throw new TfsAdapterError('tfs_change_state 需要非空 state 参数');
                    const row = await write.updateWorkItem(id, [{ op: 'replace', path: '/fields/System.State', value: state }], typeof a['rev'] === 'number' ? a['rev'] : undefined);
                    return row;
                }
                case 'tfs_add_comment': {
                    const id = requireWorkItemId(a, 'tfs_add_comment');
                    const comment = String(a['comment'] ?? '').trim();
                    if (!comment)
                        throw new TfsAdapterError('tfs_add_comment 需要非空 comment 参数');
                    const row = await write.updateWorkItem(id, [{ op: 'add', path: '/fields/System.History', value: comment }], typeof a['rev'] === 'number' ? a['rev'] : undefined);
                    return row;
                }
                case 'tfs_assign': {
                    const id = requireWorkItemId(a, 'tfs_assign');
                    const to = String(a['assignedTo'] ?? '').trim();
                    // 空值会变成 `replace System.AssignedTo = ''`，等于无声抹掉工作项负责人。
                    if (!to)
                        throw new TfsAdapterError('tfs_assign 需要非空 assignedTo 参数（空值会清空 TFS 上的负责人）');
                    const row = await write.updateWorkItem(id, [{ op: 'replace', path: '/fields/System.AssignedTo', value: to }], typeof a['rev'] === 'number' ? a['rev'] : undefined);
                    return row;
                }
                case 'tfs_add_tags': {
                    const id = requireWorkItemId(a, 'tfs_add_tags');
                    const incoming = parseTagList(a['tags']);
                    if (incoming.length === 0)
                        throw new TfsAdapterError('tfs_add_tags 需要非空 tags 参数（字符串数组或分号分隔字符串）');
                    // `System.Tags` 走 JSON-Patch `replace`（覆盖整个字段），故先读回既有标签取并集。
                    const merged = Array.from(new Set([...await readCurrentTags(read, id), ...incoming]));
                    const row = await write.updateWorkItem(id, [{ op: 'replace', path: '/fields/System.Tags', value: merged.join(';') }], typeof a['rev'] === 'number' ? a['rev'] : undefined);
                    return row;
                }
                // 2026-10-04：抽标签此前**没有任何 REST 分支**——`removeTags()` 直接自己 PATCH，
                // 绕过写门禁四道中的前三道。`tfs_add_tags` 只做并集（没法表达"去掉"），故单开此分支，
                // 使抽标签与打标签走完全对称的门禁路径。
                case 'tfs_remove_tags': {
                    const id = requireWorkItemId(a, 'tfs_remove_tags');
                    const incoming = parseTagList(a['tags']);
                    if (incoming.length === 0)
                        throw new TfsAdapterError('tfs_remove_tags 需要非空 tags 参数（字符串数组或分号分隔字符串）');
                    const removeSet = new Set(incoming);
                    const current = await readCurrentTags(read, id);
                    // 只读其余标签；写字段同样用 `replace` 覆盖整串（与 add 分支一致）。
                    const kept = current.filter(t => !removeSet.has(t));
                    const row = await write.updateWorkItem(id, [{ op: 'replace', path: '/fields/System.Tags', value: kept.join(';') }], typeof a['rev'] === 'number' ? a['rev'] : undefined);
                    return row;
                }
                case 'tfs_create_workitem': {
                    const project = String(a['project'] ?? '');
                    // 同 `tfs_query_wiql`：契约表声明的是 `type`（且标记「必填」），旧实现只读
                    // `workItemType` ⇒ 模型按 schema 传 type 时拿到空串，请求路径落成
                    // `/_apis/wit/workitems/$` 而 404。`workItemType` 保留为兼容别名。
                    const type = String(a['type'] ?? a['workItemType'] ?? '');
                    const ops = [
                        { op: 'add', path: '/fields/System.Title', value: String(a['title'] ?? '') },
                    ];
                    if (typeof a['description'] === 'string' && a['description'].length > 0) {
                        ops.push({ op: 'add', path: '/fields/System.Description', value: a['description'] });
                    }
                    if (typeof a['assignedTo'] === 'string' && a['assignedTo'].length > 0) {
                        ops.push({ op: 'add', path: '/fields/System.AssignedTo', value: a['assignedTo'] });
                    }
                    if (typeof a['areaPath'] === 'string' && a['areaPath'].length > 0) {
                        ops.push({ op: 'add', path: '/fields/System.AreaPath', value: a['areaPath'] });
                    }
                    if (typeof a['iterationPath'] === 'string' && a['iterationPath'].length > 0) {
                        ops.push({ op: 'add', path: '/fields/System.IterationPath', value: a['iterationPath'] });
                    }
                    if (a['fields'] && typeof a['fields'] === 'object') {
                        for (const [k, v] of Object.entries(a['fields'])) {
                            ops.push({ op: 'add', path: `/fields/${k}`, value: v });
                        }
                    }
                    if (typeof a['parentWorkItemId'] === 'number') {
                        // 关系 URL 必须是**绝对地址**（TFS 会据此解析链接目标），集合段用本次调用
                        // 实际生效的集合（`inner`），而非配置里的默认集合。
                        ops.push({
                            op: 'add',
                            path: '/relations/-',
                            value: {
                                rel: 'System.LinkTypes.Hierarchy-Reverse',
                                url: `${restCfg.url.replace(/\/+$/, '')}/${inner}/_apis/wit/workItems/${a['parentWorkItemId']}`,
                            },
                        });
                    }
                    const row = await write.createWorkItem(project, type, ops);
                    return row;
                }
                // ── 集合管理（问题 13） ──
                case 'tfs_list_collections': {
                    // 实测该部署 TFS 2018 不提供 /_apis/projectCollections（全版本 404）：先试 REST，
                    // 任何失败都静默回落装配点注入的配置清单（与 tfs-mcp 读本地常量的行为一致，不伪称枚举成功）。
                    try {
                        const j = await read.serverGetJson('/_apis/projectCollections');
                        const value = Array.isArray(j?.value) ? j.value : [];
                        if (value.length > 0) {
                            return {
                                defaultCollection: inner,
                                source: 'rest',
                                collections: value.map(c => ({
                                    name: str(c['name']),
                                    url: str(c['url']),
                                    description: str(c['description']),
                                    isDefault: str(c['name']) === inner,
                                })),
                            };
                        }
                    }
                    catch {
                        // 404/401：回落配置清单。
                    }
                    const names = this.knownCollections.length > 0 ? this.knownCollections : inner ? [inner] : [];
                    return {
                        defaultCollection: inner,
                        source: 'local-config',
                        collections: names.map(name => ({
                            name,
                            url: `${restCfg.url.replace(/\/+$/, '')}/${encodeURIComponent(name)}`,
                            isDefault: name === inner,
                        })),
                    };
                }
                // ── 工作项查询族（问题 13，WIQL 两段式 + 归一化） ──
                case 'tfs_get_work_items_by_customer': {
                    // Winning 自定义字段「客户」：实测中文等值查询可用（CONTAINS 才会 414）。
                    const customer = String(a['customerName'] ?? a['customer'] ?? '').trim();
                    if (!customer)
                        throw new TfsAdapterError('tfs_get_work_items_by_customer 需要 customerName');
                    const extra = [];
                    for (const s of strArray(a['excludeStates'])) {
                        extra.push(`[System.State] <> '${wiqlEscape(s)}'`);
                    }
                    if (typeof a['changedAfter'] === 'string' && a['changedAfter']) {
                        extra.push(`[System.ChangedDate] >= '${dateOnly(a['changedAfter'])}'`);
                    }
                    if (typeof a['changedBefore'] === 'string' && a['changedBefore']) {
                        extra.push(`[System.ChangedDate] <= '${dateOnly(a['changedBefore'])}'`);
                    }
                    const wiql = buildWiql({
                        project: str(a['project']) || undefined,
                        states: strArray(a['stateIn']),
                        customer,
                        rawConditions: extra,
                    });
                    const items = await this.wiqlFetch(read, wiql, inner);
                    return items.slice(0, numberArg(a['top'], 200));
                }
                case 'tfs_get_recent_resolved': {
                    const days = numberArg(a['days'], 7);
                    const states = strArray(a['states']).length > 0
                        ? strArray(a['states'])
                        : ['已解决', '已验证', 'Resolved', 'Closed'];
                    const wiql = buildWiql({
                        project: str(a['project']) || undefined,
                        states,
                        rawConditions: [`[System.ChangedDate] >= '${isoDaysAgo(days)}'`],
                    });
                    const items = await this.wiqlFetch(read, wiql, inner);
                    return items.slice(0, numberArg(a['top'], 200));
                }
                case 'tfs_get_bugs': {
                    // 中文过程模板缺陷类型名可能是「Bug」或「缺陷」，两种都带上（多余名称不命中即可）。
                    const wiql = buildWiql({
                        project: str(a['project']) || undefined,
                        types: ['Bug', '缺陷'],
                        rawConditions: ["[System.State] <> 'Closed'", "[System.State] <> '已关闭'"],
                        orderByField: 'System.CreatedDate',
                    });
                    const items = await this.wiqlFetch(read, wiql, inner);
                    return items.slice(0, numberArg(a['top'], 200));
                }
                case 'tfs_get_relations': {
                    const id = Number(a['id']);
                    if (!Number.isFinite(id))
                        throw new TfsAdapterError('tfs_get_relations 需要 id');
                    const row = await read.getWorkItem(id);
                    const rels = Array.isArray(row['relations']) ? row['relations'] : [];
                    const kind = str(a['relationType']);
                    const want = kind === 'parent' ? 'System.LinkTypes.Hierarchy-Reverse'
                        : kind === 'children' ? 'System.LinkTypes.Hierarchy-Forward'
                            : null;
                    const relations = rels
                        .filter(r => !want || r['rel'] === want)
                        .map(r => ({
                        rel: str(r['rel']),
                        url: str(r['url']),
                        targetId: idFromUrl(str(r['url'])),
                        attributes: (r['attributes'] ?? {}),
                    }));
                    return { workItemId: id, count: relations.length, relations };
                }
                case 'tfs_update_workitem': {
                    // 通用字段更新（写，过门禁）：fields/updates 为「字段引用名 → 新值」。
                    const id = Number(a['id'] ?? a['workItemId']);
                    const fields = (a['fields'] ?? a['updates']);
                    if (!Number.isFinite(id) || !fields || typeof fields !== 'object') {
                        throw new TfsAdapterError('tfs_update_workitem 需要 id 与 fields（字段引用名 → 新值）');
                    }
                    const ops = [];
                    for (const [k, v] of Object.entries(fields)) {
                        const p = k.startsWith('/fields/') ? k : `/fields/${k}`;
                        /**
                         * 清空字段一律走 `add` + `null`，不用 `remove`。
                         *
                         * `remove /fields/X` 要求该字段**当前有值**；对从未赋过值的字段它会让整个
                         * patch 失败，而 TFS 的 JSON Patch 是**原子**的 —— 一次调用里其他字段的更新
                         * 会被一起回滚，于是"只清一个没值的字段"变成"什么都没改，还报错"。
                         * `add /fields/X null` 对有无值都成立，是 TFS 清空字段值的写法。
                         */
                        if (v === '')
                            ops.push({ op: 'add', path: p, value: null });
                        else
                            ops.push({ op: 'add', path: p, value: v });
                    }
                    if (typeof a['comment'] === 'string' && a['comment'].length > 0) {
                        ops.push({ op: 'add', path: '/fields/System.History', value: a['comment'] });
                    }
                    const result = await write.updateWorkItem(id, ops, typeof a['rev'] === 'number' ? a['rev'] : undefined);
                    return result;
                }
                case 'tfs_custom_query': {
                    // 自定义条件 → WIQL（问题 13）。where 为调用方负责合法性的原始条件片段。
                    const rawConditions = [];
                    if (typeof a['where'] === 'string' && a['where'].trim().length > 0) {
                        rawConditions.push(a['where'].trim());
                    }
                    let orderByField;
                    let orderDirection;
                    if (typeof a['orderBy'] === 'string' && a['orderBy'].trim()) {
                        const m = /^\s*([\w.]+)\s*(ASC|DESC)?\s*$/i.exec(a['orderBy']);
                        if (m) {
                            orderByField = m[1];
                            orderDirection = m[2]?.toUpperCase() === 'ASC' ? 'ASC' : 'DESC';
                        }
                    }
                    const wiql = buildWiql({
                        project: str(a['project']) || undefined,
                        types: strArray(a['types']),
                        states: strArray(a['states']),
                        rawConditions,
                        ...(orderByField ? { orderByField, orderDirection } : {}),
                    });
                    const items = await this.wiqlFetch(read, wiql, inner);
                    const skip = numberArg(a['skip'], 0);
                    const top = a['disableLimit'] === true ? items.length : numberArg(a['top'], 50);
                    const slice = items.slice(skip, skip + top);
                    // 形状对齐 tfs-mcp：{ total, returned, workItems }。
                    return { total: items.length, returned: slice.length, workItems: slice };
                }
                case 'tfs_search_work_items': {
                    const keyword = String(a['keyword'] ?? a['searchText'] ?? '').trim();
                    if (!keyword)
                        throw new TfsAdapterError('tfs_search_work_items 需要 keyword/searchText');
                    const project = str(a['project']) || undefined;
                    if (isAsciiSafe(keyword)) {
                        // ASCII：标题/描述 OR CONTAINS 下推（实测可用）。
                        const k = wiqlEscape(keyword);
                        const wiql = buildWiql({
                            project,
                            rawConditions: [`([System.Title] CONTAINS '${k}' OR [System.Description] CONTAINS '${k}')`],
                        });
                        return (await this.wiqlFetch(read, wiql, inner)).slice(0, numberArg(a['top'], 200));
                    }
                    // 非 ASCII（CONTAINS 必 414，实测）：拉最近 365 天变更项（最多 500），客户端标题/描述包含过滤。
                    const wiql = buildWiql({
                        project,
                        rawConditions: [`[System.ChangedDate] >= '${isoDaysAgo(365)}'`],
                    });
                    const base = (await this.wiqlFetch(read, wiql, inner)).slice(0, 500);
                    return base.filter(r => r.title.includes(keyword) || (r.description ?? '').includes(keyword)).slice(0, numberArg(a['top'], 200));
                }
                case 'tfs_run_saved_query': {
                    // 实测：集合级 POST /_apis/wit/wiql/{id} 返回 400；必须走**项目级**路径。
                    const project = str(a['project']);
                    const qid = String(a['queryId'] ?? a['id'] ?? '').trim();
                    if (!project || !qid)
                        throw new TfsAdapterError('tfs_run_saved_query 需要 project 与 queryId');
                    const j = await read.postJson(`/${encodeURIComponent(project)}/_apis/wit/wiql/${encodeURIComponent(qid)}`, {});
                    const hits = Array.isArray(j?.workItems) ? j.workItems : [];
                    if (hits.length === 0)
                        return [];
                    return (await this.wiqlFetchByIds(read, hits.map(h => h.id), inner));
                }
                // ── 附件（问题 13） ──
                case 'tfs_list_attachments': {
                    const id = Number(a['id'] ?? a['workItemId']);
                    if (!Number.isFinite(id))
                        throw new TfsAdapterError('tfs_list_attachments 需要 id');
                    const row = await read.getWorkItem(id);
                    const rels = Array.isArray(row['relations']) ? row['relations'] : [];
                    const attachments = rels
                        .filter(r => r['rel'] === 'AttachedFile')
                        .map((r, index) => {
                        const attrs = (r['attributes'] ?? {});
                        const url = str(r['url']);
                        const name = str(attrs['name']) || filenameFromUrl(url) || `附件${index + 1}`;
                        return {
                            index,
                            name,
                            url,
                            size: Number(attrs['resourceSize'] ?? 0),
                            attachmentId: attrs['id'],
                        };
                    });
                    return { workItemId: id, count: attachments.length, attachments };
                }
                case 'tfs_upload_attachment': {
                    const id = Number(a['id'] ?? a['workItemId']);
                    const filePath = str(a['path']);
                    if (!Number.isFinite(id) || !filePath) {
                        throw new TfsAdapterError('tfs_upload_attachment 需要 id 与 path（本地文件绝对路径）');
                    }
                    return (await this.uploadWorkItemAttachment(read, write, id, filePath, str(a['fileName']) || undefined, str(a['comment']) || undefined));
                }
                case 'tfs_download_attachments': {
                    const id = Number(a['id'] ?? a['workItemId']);
                    if (!Number.isFinite(id))
                        throw new TfsAdapterError('tfs_download_attachments 需要 id');
                    return (await this.downloadWorkItemAttachments(read, id, str(a['targetDir']) || undefined));
                }
                case 'tfs_download_tfvc_files': {
                    const paths = strArray(a['paths']);
                    const targetDir = str(a['targetDir']);
                    if (paths.length === 0 || !targetDir) {
                        throw new TfsAdapterError('tfs_download_tfvc_files 需要 paths（$/ 路径数组）与 targetDir');
                    }
                    const opts = (a['options'] ?? {});
                    return (await this.downloadTfvcFiles(read, paths, targetDir, {
                        version: opts['version'] !== undefined ? String(opts['version']) : undefined,
                        flatten: opts['flatten'] === true,
                        commonRoot: str(opts['commonRoot']) || undefined,
                    }));
                }
                // ── TFVC 补充端点（问题 13，全部实测 200） ──
                case 'tfs_get_tfvc_changeset_changes': {
                    const cid = Number(a['changesetId']);
                    if (!Number.isFinite(cid))
                        throw new TfsAdapterError('tfs_get_tfvc_changeset_changes 需要 changesetId');
                    const top = numberArg(a['top'], DEFAULT_LIST_PAGE_SIZE);
                    const value = await readPagedList(read, `/_apis/tfvc/changesets/${cid}/changes`, { pageSize: top });
                    return value.map(c => {
                        const item = (c['item'] ?? {});
                        return {
                            changeType: str(c['changeType']),
                            path: str(item['path']),
                            isFolder: item['isFolder'] === true,
                            version: item['version'],
                            url: str(item['url']),
                        };
                    });
                }
                case 'tfs_list_tfvc_branches': {
                    // 实测 includeChildren=false 返回扁平分支清单（全量 children 在此部署会超时）。
                    const qs = new URLSearchParams({ includeChildren: 'false' });
                    const scope = str(a['scopePath']);
                    if (scope)
                        qs.set('scopePath', scope);
                    const j = await read.getJson(`/_apis/tfvc/branches?${qs.toString()}`);
                    const value = Array.isArray(j?.value) ? j.value : [];
                    return value.map(b => ({
                        path: str(b['path']),
                        description: str(b['description']),
                        owner: str(b['owner']?.['displayName']),
                        createdDate: str(b['createdDate']),
                        url: str(b['url']),
                    }));
                }
                case 'tfs_list_tfvc_items': {
                    const scopePath = str(a['scopePath'] ?? a['path']);
                    if (!scopePath.startsWith('$/')) {
                        throw new TfsAdapterError(`scopePath 必须以 "$/" 开头：${scopePath}`);
                    }
                    const recursionLevel = ['None', 'OneLevel', 'Full'].includes(str(a['recursionLevel']))
                        ? str(a['recursionLevel'])
                        : 'OneLevel';
                    const qs = new URLSearchParams({ scopePath, recursionLevel });
                    const j = await read.getJson(`/_apis/tfvc/items?${qs.toString()}`);
                    const value = Array.isArray(j?.value) ? j.value : [];
                    return {
                        scopePath,
                        recursionLevel,
                        count: value.length,
                        folders: value.filter(i => i['isFolder'] === true).map(tfvcItemView),
                        files: value.filter(i => i['isFolder'] !== true).map(tfvcItemView),
                    };
                }
                case 'tfs_get_tfvc_item': {
                    const p = str(a['path'] ?? a['scopePath']);
                    if (!p.startsWith('$/'))
                        throw new TfsAdapterError(`path 必须以 "$/" 开头：${p}`);
                    const j = await read.getJson(`/_apis/tfvc/items?path=${encodeURIComponent(p)}`);
                    return tfvcItemView(j);
                }
                case 'tfs_get_tfvc_file': {
                    return (await this.getTfvcFileContent(read, a));
                }
                default:
                    // Git / PR 族在下方补丁分支处理（switch 不允许跨段声明，集中到独立方法）。
                    return (await this.callGitPullRequest(raw, a, read, write));
            }
        }
        catch (e) {
            if (e instanceof TfsAdapterError)
                throw e;
            throw new TfsAdapterError(`TFS REST 调用失败：${raw} —— ${this.restErrorMessage(e)}`);
        }
    }
    /**
     * 当前生效集合（只读）。
     *
     * 存在的理由：`createHostApi(deps)` 是**值捕获**，运行期切换集合（`onCollectionChange`）
     * 改的是适配层而不是那份快照。任何"按当前集合"的判定（可选项缓存键就是其中之一）
     * 都必须从这里取，否则会用旧集合名去查新集合的数据。
     */
    get currentCollection() {
        return this.defaultCollection ?? '';
    }
    /** 运行时切换默认集合（内联透传用；不预调 tfs_set_collection）。 */
    setCollection(collection) {
        this.defaultCollection = collection;
    }
    // ───────────────────────── 只读调用（不过门禁） ─────────────────────────
    /** 当前身份（T027 契约测试用，只读）。实测：无必填参数。 */
    async whoami() {
        return this.call('tfs_whoami', {});
    }
    /** 当前集合（只读）。实测：无必填参数。 */
    async getCurrentCollection() {
        return this.call('tfs_get_current_collection', {});
    }
    /** 项目清单（只读）。实测：无必填参数，返回全集合项目。 */
    async getProjects(args = {}) {
        return this.call('tfs_get_projects', args);
    }
    /** 工作项清单（只读）。实测必填 `ids: number[]`，可选 `collection`。 */
    async getWorkItems(args) {
        return this.call('tfs_get_work_items', args);
    }
    /** 单个工作项（只读）。实测必填 `id: number`，可选 `collection`/`embedImages`。 */
    async getWorkItem(id, args = {}) {
        return this.call('tfs_get_workitem', { id: Number(id), ...args });
    }
    /** WIQL 查询（只读）。实测必填 `query`，可选 `project`/`collection`。 */
    async queryWiql(wiql, args = {}) {
        return this.call('tfs_query_wiql', { query: wiql, ...args });
    }
    /** 我的任务（只读）。实测：无必填参数。 */
    async getMyTasks(args = {}) {
        return this.call('tfs_get_my_tasks', args);
    }
    /** 全文检索工作项（只读）。实测必填 `keyword`，可选 `project`/`collection`。 */
    async searchWorkItems(searchText, args = {}) {
        return this.call('tfs_search_work_items', { keyword: searchText, ...args });
    }
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
    async getQueryOptions(collection) {
        const col = collection ?? this.defaultCollection ?? '';
        const warnings = [];
        const result = {
            projects: [],
            types: [],
            states: [],
            assignees: [],
            collectedAt: new Date().toISOString(),
        };
        const seenAssignee = new Set();
        /** 从 `tfs_whoami` 返回值里抽取身份名（形状未强约束，尽力取值）。 */
        function extractIdentityName(raw) {
            if (typeof raw === 'string')
                return raw;
            if (raw === null || typeof raw !== 'object')
                return undefined;
            const o = raw;
            const pick = ['uniqueName', 'name', 'displayName', 'identity', 'user'];
            for (const k of pick) {
                const v = o[k];
                if (typeof v === 'string' && v.length > 0)
                    return v;
            }
            return undefined;
        }
        /** 从 `tfs_get_projects` 返回值里抽取项目名清单（形状未强约束，尽力取值）。 */
        function extractProjects(raw) {
            if (raw === null || typeof raw !== 'object')
                return [];
            const arr = Array.isArray(raw) ? raw : raw['value'] ?? raw['projects'];
            if (!Array.isArray(arr))
                return [];
            const out = [];
            const seen = new Set();
            for (const p of arr) {
                let name = '';
                if (typeof p === 'string')
                    name = p;
                else if (p && typeof p === 'object') {
                    const o = p;
                    name = typeof o['name'] === 'string' ? o['name'] : typeof o['id'] === 'string' ? o['id'] : '';
                }
                if (name && !seen.has(name)) {
                    seen.add(name);
                    out.push({ value: name, label: name });
                }
            }
            // 同 `result.projects`：用码点序而非 `localeCompare`（本机 full-ICU 下后者
            // 是「数字 < 中文 < 拉丁」，会让混合命名的项目清单顺序难以预期）。
            return out.sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
        }
        // 默认指派人：whoami 身份。`whoami` 同时给出显示名与账号名，两种拼写都列出来，
        // 否则用户按显示名筛不出自己（工作项上的 `System.AssignedTo` 显示名与
        // `uniqueName` 大小写/域前缀常不一致）。筛选侧按包含匹配且不区分大小写。
        try {
            const me = (await this.whoami());
            const meName = extractIdentityName(me);
            if (meName) {
                result.defaultAssignee = meName;
                for (const name of [meName, me['displayName'], me['uniqueName']]) {
                    if (typeof name !== 'string' || !name || seenAssignee.has(name))
                        continue;
                    seenAssignee.add(name);
                    result.assignees.push({ value: name, label: name });
                }
            }
        }
        catch (e) {
            warnings.push(`默认指派人采集失败（whoami）：${e.message}`);
        }
        // 项目清单（问题 3 根治）：REST 化后 `tfs_get_projects` 已映射为 `GET /_apis/projects`
        // 活清单（62 项真实数据），旧的"liveProjects 旁路 + 硬编码表降级"不再必要，但保留
        // liveProjects 作为可注入覆盖点（测试桩用），缺失时走统一 REST 出口。
        try {
            let live;
            try {
                live = await this.liveProjects?.(col);
            }
            catch (e) {
                warnings.push(`活项目清单旁路不可用（${e.message}），走统一 REST 出口`);
            }
            if (live && live.length > 0) {
                // ⚠️ 不用 `localeCompare`：本机 full-ICU 下它是「数字 < 中文 < 拉丁」，
                // 会让「体检管理」「4.0产品台」「ACIS」「ASMC」这类混合命名显得**顺序诡异**
                // （用户报告问题 3 时列出的正是这几个）。用码点序 `sort()` 得到稳定、
                // 可预期的分组（数字 → 拉丁 → 中文），与 dsh 其它清单的观感一致。
                result.projects = live
                    .map(name => ({ value: name, label: name }))
                    .sort((a, b) => (a.value < b.value ? -1 : a.value > b.value ? 1 : 0));
            }
            else {
                const rawProjects = (await this.getProjects(this.withCollection(col)));
                result.projects = extractProjects(rawProjects);
            }
        }
        catch (e) {
            warnings.push(`项目清单采集失败：${e.message}`);
        }
        // 类型 / 状态（问题 4/5 根治）：**元数据端点，不再采样**。
        //
        // ## 为什么旧方案（WIQL 窗口阶梯采样）被替换
        //
        // 旧方案对每个项目依次试 [30,7,1] 天窗口采样最近变更项，存在三类问题：
        //   1. `tfs_query_wiql` 约 200 条命中的硬上限 → 主力项目单日变更就超线，阶梯频繁回退；
        //   2. 62 个项目只采前 8 个 → 冷门类型的值永远采不到；
        //   3. 伪错消息（items is not iterable / 在层次结构中找不到指定的项目）会漏进 warnings，
        //      用户看到一串"项目「X」类型/状态采样失败"误以为系统坏了。
        //
        // REST 化后有权威元数据端点（2026-09-19 全部实测 200）：
        //   - `GET /{project}/_apis/wit/workitemtypes?api-version=4.1` → 19 个类型（体检管理实测）
        //   - `GET /{project}/_apis/wit/workitemtypes/{type}/states?api-version=4.1-preview` → 6 个状态
        //
        // ## 为什么**不能**再截断项目/类型集合（问题 3/4 实测复发的直接原因）
        //
        // 曾经的 `MAX_TYPES_PROJECTS = 3` + `types.slice(0, 8)` 是"怕拖慢面板"的保守取值，
        // 但它正是用户看到下拉缺项的原因：
        //   - 类型下拉一个都没有（问题 4）：`result.projects` 前 3 个若都是**非法/无类型**的项目，
        //     `listWorkItemTypes` 全 404 → 整个 `typeSet` 为空；而 `System.WorkItemType`
        //     的**权威全集**其实来自任意一个有效项目（TFS 的类型定义是集合级共享的）；
        //   - 项目下拉缺项（问题 3）：`result.projects` 本身已由 `GET /_apis/projects` 拿全，
        //     但**类型/状态采集失败会把 `result.reason` 填满**，UI 侧据此误判"清单不可信"。
        //
        // 正确做法：**全量遍历**，但把并发/请求数控制做到位（见下）。62 个项目 × 1 次
        // `workitemtypes` 请求 = 62 次 GET，在本地 TFS 上约 1–2 秒；用 `Promise.all` 并行
        // 且每个项目独立 catch，失败不阻断也不影响其它项目。
        //
        // 状态请求（每类型一次）**数量是 O(项目×类型)**，这才是真正的压力点，故保留
        // 类型维度的上限（见 STATE_PROBE_TYPES）；但**类型本身不截断** —— 类型是问题 4
        // 的直接诉求，必须全量。
        try {
            const typeSet = new Map();
            const stateSet = new Map();
            // 状态探测的类型上限：状态对"筛选下拉"的价值低于类型，且请求数是 O(项目×类型)。
            // 每个项目取前 N 个类型探状态；类型清单本身仍全量（不被截断）。
            const STATE_PROBE_TYPES = 12;
            // 元数据采集失败的可见性：**逐项目、逐类型独立降级**，失败只记 warning 并继续。
            // 反例（曾踩）：把 `listWorkItemTypes` 放在循环里裸调，单项目 404 会一路抛到外层
            // catch → warnings 只剩笼统的"类型/状态元数据采集异常"，掩盖了真实原因，
            // 且后续项目完全不再尝试（一处失败 = 全量放弃）。这与"降级可见"的设计目标相悖。
            const metaWarnings = [];
            // 项目清单为空时退回默认集合名（至少试一次，别直接放弃）。
            const metaProjects = result.projects.length > 0
                ? result.projects.map(p => p.value)
                : [col];
            // 并行采集类型：项目之间互不依赖，串行会让 62 个项目变成线性等待；
            // 但并发数要有上限（A16）——见 `mapWithLimit`。
            const concurrency = this.queryOptionsConcurrency;
            const perProject = await mapWithLimit(metaProjects, concurrency, async (project) => {
                // 每次调用都取一份 read（`restFor` 会按传入集合解析；同一集合下等价于复用）。
                const { read } = this.restFor(collection);
                try {
                    return { project, types: await read.listWorkItemTypes(project) };
                }
                catch (e) {
                    metaWarnings.push(`项目「${project}」工作项类型采集失败：${this.restErrorMessage(e)}`);
                    return { project, types: [] };
                }
            });
            for (const { project, types } of perProject) {
                for (const t of types)
                    typeSet.set(t, t);
                // 状态需要逐类型查询；类型多时限制请求数（每项目最多 STATE_PROBE_TYPES 个类型的状态）。
                // 同一项目内并行、项目间也已并行 —— 失败逐个吞掉，不让单个类型拖垮整批。
                const probed = types.slice(0, STATE_PROBE_TYPES);
                const stateLists = await mapWithLimit(probed, concurrency, async (t) => {
                    try {
                        const { read } = this.restFor(collection);
                        return await read.listStates(project, t);
                    }
                    catch {
                        // 单类型状态失败不阻断其它类型（能力降级可见性由空集 warning 兜底）。
                        return [];
                    }
                });
                for (const states of stateLists)
                    for (const s of states)
                        stateSet.set(s, s);
            }
            result.types = [...typeSet.values()].sort().map(v => ({ value: v, label: v }));
            result.states = [...stateSet.values()].sort().map(v => ({ value: v, label: v }));
            if (result.types.length === 0) {
                warnings.push('工作项类型为空（元数据端点不可用或项目名非法）');
                warnings.push(...metaWarnings);
            }
            else if (metaWarnings.length > 0) {
                // 类型有结果、只有部分项目失败时，把失败明细降为"部分采集"提示，
                // **不要**让它像"整体不可用"那样盖住已成功的清单（问题 3 的观感根因之一）。
                warnings.push(`部分项目类型采集降级（已获得 ${result.types.length} 个类型）：${metaWarnings.join('；')}`);
            }
        }
        catch (e) {
            warnings.push(`类型/状态元数据采集异常：${e.message}`);
        }
        if (warnings.length)
            result.reason = warnings.join('；');
        return result;
    }
    // ───────────────────────── 需求读取与归一化（US2 / T013 实测形状） ─────────────────────────
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
    async getRequirement(id, collection) {
        const raw = await this.getWorkItem(id, this.withCollection(collection));
        return normalizeWorkItem(raw, collection ?? this.defaultCollection ?? '');
    }
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
    async listRequirements(filter = {}) {
        const collection = filter.collection ?? this.defaultCollection;
        const where = [];
        // 客户端侧兜底过滤（见下方 `deferred`）：WIQL 放不进来的条件在这里补。
        const deferred = {};
        // 项目：多选 OR（未传 = 不限）。单值 `filter.project` 与数组 `filter.projects` 兼容合并
        // （数组优先；合同规定单值别名与数组都传时以数组为准，这里把单值并入数组统一处理）。
        const projectOrs = [];
        for (const p of filter.projects ?? []) {
            if (p && p.length > 0)
                projectOrs.push(`[System.TeamProject] = '${escapeWiql(p)}'`);
        }
        if (filter.project && !projectOrs.includes(`[System.TeamProject] = '${escapeWiql(filter.project)}'`)) {
            projectOrs.push(`[System.TeamProject] = '${escapeWiql(filter.project)}'`);
        }
        if (projectOrs.length)
            where.push(`(${projectOrs.join(' OR ')})`);
        // 工作项类型：多选 OR（未传 = 全部类型）。中文等值实测可用，无条件下推。
        const types = [...(filter.types ?? [])];
        if (filter.state === undefined && filter.states === undefined) {
            // 不在此处处理 state，交由下方 states 分支
        }
        if (types.length) {
            where.push(`(${types.map(t => `[System.WorkItemType] = '${escapeWiql(t)}'`).join(' OR ')})`);
        }
        // 状态：多选 OR（未传 = 全部状态）。单值 `filter.state` 与数组 `filter.states` 合并。
        const states = [...(filter.states ?? [])];
        if (filter.state && !states.includes(filter.state))
            states.push(filter.state);
        if (states.length) {
            where.push(`(${states.map(s => `[System.State] = '${escapeWiql(s)}'`).join(' OR ')})`);
        }
        // assignedTo / keyword 用 CONTAINS：实测返回值为 `xbp（徐保平) <WINNING\xbp>` 这类显示串，
        // 精确等于几乎永不命中，故按包含匹配。
        //
        // ⚠️ **实测硬约束（2026-09-17/18 真实 TFS）**：`CONTAINS` 的**值含非 ASCII 必返 414**
        //   —— `CONTAINS '框架'`（带/不带 project 均 414）、`CONTAINS 'MEMORY'`（ASCII）正常、
        //   `[System.State] = '不存在状态ZZZ'`（中文等值）正常。
        //   即：**414 由「CONTAINS + 非 ASCII」触发**，与查询长度、ORDER BY、project 参数均无关。
        //   中文关键字/中文姓名是常态，故：非 ASCII 的 CONTAINS **不下推**，改为客户端侧过滤。
        // assignedTo 既可能是数组（契约 `string[]`），也可能被调用方误传为单字符串
        // （如契约早期单值形态 / 测试）。单字符串经 `for...of` 会逐字符展开 → 产生
        // `CONTAINS 'z' AND 'h' …` 这类错误子句，故此处归一为数组（防御性，问题 3 的多选指派过滤）。
        const assignedTos = Array.isArray(filter.assignedTo)
            ? filter.assignedTo
            : filter.assignedTo
                ? [filter.assignedTo]
                : [];
        //
        // **多值必须是 OR，不能是 AND**（2026-09-18 修正，契约语义：同字段内 OR、字段间 AND）。
        // 修前逐个 `where.push(...)`，最终被 `where.join(' AND ')` 拼成
        // `[System.AssignedTo] CONTAINS 'a' AND [System.AssignedTo] CONTAINS 'b'`；
        // 一个工作项的指派人只有一个，这样的条件**恒为空集** —— 多选指派人直接失效（问题 3）。
        //
        // 混合 ASCII / 非 ASCII 时的取舍：只要有任何一项是非 ASCII（CONTAINS 会 414），
        // 就把**全部**指派人条件交给客户端侧过滤，而不是"ASCII 的走 WIQL、非 ASCII 的走客户端"。
        // 后者会让两组条件变成 AND（既要在 WIQL 子集里、又要匹配中文名），语义与"OR"不符。
        const asciiAssignees = assignedTos.filter(a => a && a.length > 0 && isAsciiSafe(a));
        const nonAsciiAssignees = assignedTos.filter(a => a && a.length > 0 && !isAsciiSafe(a));
        if (assignedTos.length > 0) {
            if (nonAsciiAssignees.length === 0) {
                where.push(`(${asciiAssignees.map(a => `[System.AssignedTo] CONTAINS '${escapeWiql(a)}'`).join(' OR ')})`);
            }
            else {
                deferred.assignedTo = [...asciiAssignees, ...nonAsciiAssignees];
            }
        }
        if (filter.keyword) {
            if (isAsciiSafe(filter.keyword))
                where.push(`[System.Title] CONTAINS '${escapeWiql(filter.keyword)}'`);
            else
                deferred.keyword = filter.keyword;
        }
        const skip = Math.max(0, Math.trunc(num(filter.skip)));
        const top = Math.max(1, Math.trunc(num(filter.top) || 20));
        const hasDeferred = !!deferred.keyword || !!deferred.assignedTo?.length;
        // D2 护栏：无任何收窄条件（WHERE 为空、也无客户端侧过滤条件）时，若发起到 TFS 会生成
        // 无 WHERE 的全集合 WIQL（实测命中约 203 万个工作项、耗时 60s+，必然撞上 20s 超时）。
        // 这里直接拒绝并给出可操作提示，不发起到 TFS。
        if (where.length === 0 && !hasDeferred) {
            return {
                ok: false,
                items: [],
                reason: '查询条件过宽：未指定任何筛选会触发 TFS 全集合扫描（实测约 203 万个工作项、耗时超过 ' +
                    '60 秒并超时）。请至少指定「项目 / 工作项类型 / 状态 / 指派人 / 关键字」之一后再查询。',
            };
        }
        const query = `SELECT [System.Id] FROM WorkItems` +
            (where.length ? ` WHERE ${where.join(' AND ')}` : '') +
            ` ORDER BY [System.ChangedDate] DESC`;
        // 注意：多项目筛选统一走 WHERE `[System.TeamProject]`（见上方 projectOrs），
        // 不再传 `project` 单值参数（否则会与 WHERE 叠加 scope，导致跨项目查询被错误收窄）。
        // D1 修复：不再走通用 `tfs_query_wiql`（它对 WIQL 命中的**全部** id 按 200 一批串行取字段，
        // 最后才由调用方分页 —— 大项目如体检管理命中 4 万+ id，需 200+ 次串行请求必然超时）。
        // 这里直接用 REST 读客户端：第一段 WIQL 只取 id（轻量、不含 relations），随后按是否存在
        // 无法下推的 deferred 条件决定分页方式。
        const { read, config: restCfg } = this.restFor(collection);
        const inner = (collection ?? this.defaultCollection ?? restCfg.collection) ?? '';
        let hits;
        try {
            hits = await read.queryWiql(query);
        }
        catch (e) {
            const msg = this.restErrorMessage(e);
            // 护栏 1：旧 tfs-mcp 把「0 命中」当成内部异常抛出 → 归一为空结果。
            if (isWiqlEmptyResult(msg)) {
                return { ok: true, items: [], total: 0 };
            }
            return { ok: false, items: [], reason: `需求列表查询失败（TFS REST）：${msg}` };
        }
        if (hits.length === 0)
            return { ok: true, items: [], total: 0 };
        // 路径 A（无 deferred，UI 默认/绝大多数查询）：所有条件都已下推 WIQL，命中 id 即最终集合。
        // 只对「当前页」的 id（最多 top 个）取一次字段，total 直接取 WIQL 命中数，单次请求即可完成。
        if (!hasDeferred) {
            const total = hits.length;
            const pageIds = hits.slice(skip, skip + top).map(h => h.id);
            if (pageIds.length === 0)
                return { ok: true, items: [], total };
            try {
                const rows = await read.getWorkItems(pageIds, WIQL_FETCH_FIELDS);
                const items = rows.map(r => normalizeWorkItem(r, inner));
                return { ok: true, items, total };
            }
            catch (e) {
                return { ok: false, items: [], reason: `需求详情获取失败（TFS REST）：${this.restErrorMessage(e)}` };
            }
        }
        // 路径 B（有 deferred）：非 ASCII 的关键字/指派人无法下推 WIQL（CONTAINS 非 ASCII 会 414），
        // 必须取字段后在客户端过滤，无法只靠 id 精确分页。为避免无界拉取，按 ChangedDate DESC 只扫描
        // 前 DEFERRED_SCAN_CAP 个 id（分批取字段），在该窗口内过滤后再分页。
        const scanIds = hits.slice(0, TfsAdapter.DEFERRED_SCAN_CAP).map(h => h.id);
        const scanned = [];
        let sizeBytes = 0;
        let sizeCapped = false;
        try {
            for (let i = 0; i < scanIds.length; i += 200) {
                const batch = await read.getWorkItems(scanIds.slice(i, i + 200), WIQL_FETCH_FIELDS);
                scanned.push(...batch);
                // 体积熔断（沿用 maxResponseBytes）：deferred 扫描可能累积上千条字段响应，超过阈值即
                // 停止拉取后续批次，避免大响应拖垮/超时（与旧列表体积熔断同一意图，现只作用于路径 B）。
                sizeBytes += Buffer.byteLength(JSON.stringify(batch), 'utf8');
                if (sizeBytes >= this.maxResponseBytes) {
                    sizeCapped = true;
                    break;
                }
            }
        }
        catch (e) {
            return { ok: false, items: [], reason: `需求详情获取失败（TFS REST）：${this.restErrorMessage(e)}` };
        }
        // 客户端侧补齐被 WIQL 拒收的 CONTAINS 条件（非 ASCII）。
        const filtered = scanned.map(r => normalizeWorkItem(r, inner)).filter(r => {
            if (deferred.keyword && !r.title.includes(deferred.keyword))
                return false;
            // 多指派人：任一命中即可（OR 语义，与下推到 WIQL 的 OR 一致）。
            // 比对不区分大小写：TFS 的 `IdentityRef.displayName` 与下拉里存的
            // `uniqueName`（域\账号）大小写常不一致，区分写会让筛选恒空。
            if (deferred.assignedTo?.length) {
                const actual = r.assignedTo.toLowerCase();
                if (!deferred.assignedTo.some(a => actual.includes(a.toLowerCase())))
                    return false;
            }
            return true;
        });
        const result = {
            ok: true,
            items: filtered.slice(skip, skip + top),
            total: filtered.length,
        };
        // 命中超出扫描窗口 / 触发体积熔断时结果可能不完整，明确告知而非静默截断。
        if (hits.length > TfsAdapter.DEFERRED_SCAN_CAP || sizeCapped) {
            const why = sizeCapped
                ? `响应体积达到熔断阈值（${this.maxResponseBytes} 字节），已停止继续扫描`
                : `已按最近更新时间扫描前 ${TfsAdapter.DEFERRED_SCAN_CAP} 项`;
            result.reason =
                `命中较多，${why}后再过滤，结果可能不完整；请增加项目/状态等条件进一步收窄。`;
        }
        return result;
    }
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
    async wrappedCall(raw, args) {
        return this.call(raw, args);
    }
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
    async wrappedWrite(raw, args, confirmed) {
        const coll = args?.collection ?? this.defaultCollection;
        // 目标工作项：写工具若带 `id` 字段则作为去重键右半；否则归入匿名 `tfs-tool` 桶（仍过审计）。
        const id = typeof args?.id === 'number' ? args.id : typeof args?.id === 'string' ? Number(args.id) : undefined;
        const targetWorkItem = id !== undefined && Number.isFinite(id)
            ? `${id}@${coll ?? ''}`
            : `tfs-tool@${coll ?? ''}`;
        return this.executeWrite(raw, args ?? {}, {
            targetWorkItem,
            opType: 'tool',
            collection: coll,
            before: null,
            after: args ?? {},
            // 下载/落盘一族只写本地磁盘，参数化幂等键对同一组参数恒定：判重会把用户
            // 「重下一次附件」的正当请求误杀成重复，故显式声明为可重复（门禁 1/2/4 仍生效）。
            repeatable: REPEATABLE_WRITE_OPS.has(raw),
        }, confirmed);
    }
    // ─────────────── 问题 13：WIQL 族 / 附件 / TFVC 文件 私有实现 ───────────────
    /**
     * WIQL 两段式查询并归一化（WIQL 只给 id，再批量取字段）。
     * @param wiql - 已构造好的 WIQL。
     * @param fallbackCollection - 兜底集合名。
     * @returns 归一化工作项列表。
     */
    async wiqlFetch(read, wiql, fallbackCollection) {
        const hits = await read.queryWiql(wiql);
        if (hits.length === 0)
            return [];
        return this.wiqlFetchByIds(read, hits.map(h => h.id), fallbackCollection);
    }
    /** 按 id 批量（200 一批）取工作项并归一化。 */
    async wiqlFetchByIds(read, ids, fallbackCollection) {
        const out = [];
        for (let i = 0; i < ids.length; i += 200) {
            const rows = await read.getWorkItems(ids.slice(i, i + 200), WIQL_FETCH_FIELDS);
            for (const r of rows)
                out.push(normalizeWorkItem(r, fallbackCollection));
        }
        return out;
    }
    /**
     * 上传本地文件为附件并关联到工作项（两步：POST attachments → PATCH relations/-）。
     * @returns 含 attachmentId/rev 的结果。
     */
    async uploadWorkItemAttachment(read, write, id, filePath, fileName, comment) {
        void read;
        let buffer;
        try {
            buffer = await fsp.readFile(filePath);
        }
        catch (e) {
            throw new TfsAdapterError(`读取本地文件失败：${filePath} —— ${this.restErrorMessage(e)}`);
        }
        const name = safeBasename(fileName ?? path.basename(filePath));
        const meta = await write.uploadAttachment(`/_apis/wit/attachments?fileName=${encodeURIComponent(name)}`, buffer);
        const url = str(meta['url']);
        if (!url)
            throw new TfsAdapterError('附件上传成功但未返回 url，无法关联工作项');
        const ops = [
            { op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url, attributes: { name } } },
        ];
        if (comment)
            ops.push({ op: 'add', path: '/fields/System.History', value: comment });
        const updated = await write.updateWorkItem(id, ops);
        return {
            success: true,
            workItemId: id,
            attachmentId: meta['id'],
            name,
            size: buffer.length,
            rev: typeof updated['rev'] === 'number' ? updated['rev'] : undefined,
        };
    }
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
    resolveDownloadDir(raw, targetDirArg, fallback) {
        const requested = str(targetDirArg).trim();
        const dir = requested ? path.resolve(requested) : path.resolve(fallback);
        if (this.allowExternalDownloadDir || requested === '')
            return dir;
        const root = path.resolve(this.downloadsDir);
        if (dir === root || dir.startsWith(root + path.sep))
            return dir;
        throw new TfsAdapterError(`${raw}：落点 ${dir} 不在下载根目录 ${root} 内。附件与 TFVC 文件只允许落在下载根目录内；`
            + '确需写到其它位置请把配置项 tfs-requirment.allowExternalDownloadDir 设为 true。');
    }
    /**
     * 下载工作项的全部 AttachedFile 附件到本地目录。
     * 文件名取自服务端 attributes/URL 的 filename 参数并做路径穿越防护。
     */
    async downloadWorkItemAttachments(read, id, targetDirArg) {
        const row = await read.getWorkItem(id);
        const rels = Array.isArray(row['relations']) ? row['relations'] : [];
        const attachments = rels.filter(r => r['rel'] === 'AttachedFile');
        const targetDir = this.resolveDownloadDir('tfs_download_attachments', targetDirArg, path.join(this.downloadsDir, 'attachments', String(id)));
        await fsp.mkdir(targetDir, { recursive: true });
        const downloaded = [];
        let failCount = 0;
        for (let i = 0; i < attachments.length; i += 1) {
            const r = attachments[i];
            if (!r)
                continue;
            const url = str(r['url']);
            const attrs = (r['attributes'] ?? {});
            const name = safeBasename(str(attrs['name']) || filenameFromUrl(url) || `attachment-${i + 1}`);
            try {
                const blob = await read.getBlob(url, true);
                const dest = safeJoin(targetDir, name);
                await fsp.writeFile(dest, blob.buffer);
                downloaded.push({ name, path: dest, size: blob.buffer.length });
            }
            catch (e) {
                failCount += 1;
                downloaded.push({ name, error: this.restErrorMessage(e) });
            }
        }
        return {
            success: failCount === 0,
            workItemId: id,
            downloadDir: targetDir,
            total: attachments.length,
            successCount: attachments.length - failCount,
            failCount,
            downloaded,
        };
    }
    /**
     * 批量下载 TFVC 服务器路径文件（保留相对目录结构；支持 flatten/commonRoot/version）。
     */
    async downloadTfvcFiles(read, paths, targetDirArg, opts) {
        const targetDir = this.resolveDownloadDir('tfs_download_tfvc_files', targetDirArg, this.downloadsDir);
        await fsp.mkdir(targetDir, { recursive: true });
        const root = opts.commonRoot ?? commonRootOf(paths);
        const downloaded = [];
        let failCount = 0;
        for (const tfvcPath of paths) {
            if (!tfvcPath.startsWith('$/')) {
                failCount += 1;
                downloaded.push({ sourcePath: tfvcPath, error: 'TFVC 路径必须以 "$/" 开头' });
                continue;
            }
            try {
                const qs = new URLSearchParams({ path: tfvcPath });
                if (opts.version)
                    qs.set('versionDescriptor.version', opts.version);
                const blob = await read.getBlob(`/_apis/tfvc/items?${qs.toString()}`);
                const rel = opts.flatten ? safeBasename(tfvcPath) : stripRoot(tfvcPath, root);
                const dest = safeJoin(targetDir, rel);
                await fsp.mkdir(path.dirname(dest), { recursive: true });
                await fsp.writeFile(dest, blob.buffer);
                downloaded.push({ sourcePath: tfvcPath, path: dest, size: blob.buffer.length });
            }
            catch (e) {
                failCount += 1;
                downloaded.push({ sourcePath: tfvcPath, error: this.restErrorMessage(e) });
            }
        }
        return {
            success: failCount === 0,
            downloadDir: targetDir,
            total: paths.length,
            successCount: paths.length - failCount,
            failCount,
            downloaded,
        };
    }
    /**
     * 取单个 TFVC 文件内容（元数据 + 字节）。
     * options.savePath：落盘并返回路径；asBase64 或二进制内容：返回 base64；否则返回 utf8 文本。
     */
    async getTfvcFileContent(read, a) {
        const tfvcPath = str(a['tfvcPath'] ?? a['path']);
        if (!tfvcPath.startsWith('$/'))
            throw new TfsAdapterError(`TFVC 路径必须以 "$/" 开头：${tfvcPath}`);
        const opts = (a['options'] ?? {});
        const qs = new URLSearchParams({ path: tfvcPath });
        if (opts['version'])
            qs.set('versionDescriptor.version', String(opts['version']));
        const meta = await read.getJson(`/_apis/tfvc/items?${qs.toString()}`);
        const blob = await read.getBlob(`/_apis/tfvc/items?${qs.toString()}`);
        if (str(opts['savePath'])) {
            const abs = this.resolveDownloadDir('tfs_get_tfvc_file', str(opts['savePath']), this.downloadsDir);
            await fsp.mkdir(path.dirname(abs), { recursive: true });
            await fsp.writeFile(abs, blob.buffer);
            return { path: tfvcPath, savedTo: abs, size: blob.buffer.length, version: meta['version'] };
        }
        if (opts['asBase64'] === true || !isProbablyText(blob.buffer)) {
            return {
                path: tfvcPath,
                version: meta['version'],
                size: blob.buffer.length,
                encoding: 'base64',
                content: blob.buffer.toString('base64'),
            };
        }
        return {
            path: tfvcPath,
            version: meta['version'],
            size: blob.buffer.length,
            encoding: 'utf8',
            content: blob.buffer.toString('utf8'),
        };
    }
    // ─────────────── 问题 13：Git 仓库 / 分支 / PR 族分派 ───────────────
    /**
     * Git/PR 类操作分派（从 call() 的 default 分支转入；未命中再抛"未映射"错误）。
     */
    async callGitPullRequest(raw, a, read, write) {
        const enc = encodeURIComponent;
        const needGitArgs = () => {
            const project = str(a['project']);
            const repo = str(a['repositoryId'] ?? a['repo']);
            if (!project || !repo)
                throw new TfsAdapterError(`${raw} 需要 project 与 repositoryId 参数`);
            return { project, repo };
        };
        try {
            switch (raw) {
                case 'tfs_list_repos': {
                    const project = str(a['project']);
                    if (!project)
                        throw new TfsAdapterError('tfs_list_repos 需要 project');
                    const repos = await readPagedList(read, `/${enc(project)}/_apis/git/repositories`);
                    return repos.map(r => ({
                        id: str(r['id']),
                        name: str(r['name']),
                        url: str(r['url']),
                        defaultBranch: str(r['defaultBranch']),
                        remoteUrl: str(r['remoteUrl']),
                        project: str(r['project']?.['name']) || project,
                    }));
                }
                case 'tfs_get_repo': {
                    const { project, repo } = needGitArgs();
                    const r = await read.getJson(`/${enc(project)}/_apis/git/repositories/${enc(repo)}`);
                    return {
                        id: str(r['id']),
                        name: str(r['name']),
                        url: str(r['url']),
                        defaultBranch: str(r['defaultBranch']),
                        remoteUrl: str(r['remoteUrl']),
                        size: r['size'],
                        project: str(r['project']?.['name']) || project,
                    };
                }
                case 'tfs_get_commits': {
                    const { project, repo } = needGitArgs();
                    const top = numberArg(a['top'], 20);
                    const j = await read.getJson(`/${enc(project)}/_apis/git/repositories/${enc(repo)}/commits?$top=${top}`);
                    return (j.value ?? []).map(gitCommitView);
                }
                case 'tfs_check_commit_work_items': {
                    const { project, repo } = needGitArgs();
                    const commitId = str(a['commitId'] ?? a['id']);
                    if (!commitId)
                        throw new TfsAdapterError('tfs_check_commit_work_items 需要 commitId');
                    const base = `/${enc(project)}/_apis/git/repositories/${enc(repo)}/commits/${enc(commitId)}`;
                    const commit = await read.getJson(base);
                    let workItems = Array.isArray(commit['workItems'])
                        ? commit['workItems']
                        : [];
                    if (workItems.length === 0) {
                        try {
                            const j2 = await read.getJson(`${base}/workitems`);
                            workItems = Array.isArray(j2?.value) ? j2.value : [];
                        }
                        catch (e) {
                            // 实测 TFS 2018（api 4.1）该子资源 404：给可读错误，不回退成静默空列表。
                            if (e instanceof RestError && e.status === 404) {
                                throw new TfsAdapterError('TFS 2018（api-version 4.1）不支持「提交关联工作项」端点（commits/{id}/workItems 返回 404）。' +
                                    '反向查询请改用 tfs_get_work_item_commits（按工作项查关联变更）。');
                            }
                            throw e;
                        }
                    }
                    return {
                        commitId,
                        shortId: commitId.slice(0, 8),
                        hasWorkItems: workItems.length > 0,
                        workItemCount: workItems.length,
                        workItems,
                    };
                }
                case 'tfs_list_branches': {
                    const { project, repo } = needGitArgs();
                    const value = await readPagedList(read, `/${enc(project)}/_apis/git/repositories/${enc(repo)}/refs?filter=heads`);
                    return value.map(r => ({
                        name: str(r['name']).replace(/^refs\/heads\//, ''),
                        objectId: str(r['objectId']),
                    }));
                }
                case 'tfs_get_branch': {
                    const { project, repo } = needGitArgs();
                    const branch = str(a['branchName'] ?? a['branch']);
                    if (!branch)
                        throw new TfsAdapterError('tfs_get_branch 需要 branchName');
                    const j = await read.getJson(`/${enc(project)}/_apis/git/repositories/${enc(repo)}/refs?filter=heads/${enc(branch)}`);
                    const found = (j.value ?? []).find(r => str(r['name']).replace(/^refs\/heads\//, '') === branch);
                    if (!found)
                        throw new TfsAdapterError(`分支不存在：${branch}`);
                    return {
                        name: str(found['name']).replace(/^refs\/heads\//, ''),
                        objectId: str(found['objectId']),
                    };
                }
                case 'tfs_get_branch_diffs': {
                    const { project, repo } = needGitArgs();
                    const baseBranch = str(a['baseBranch']);
                    const targetBranch = str(a['targetBranch']);
                    if (!baseBranch || !targetBranch) {
                        throw new TfsAdapterError('tfs_get_branch_diffs 需要 baseBranch 与 targetBranch');
                    }
                    const top = numberArg(a['top'], 100);
                    // commitsbatch：GitQueryCommitsCriteria 的 from/to 接受分支引用名。
                    const j = await read.postJson(`/${enc(project)}/_apis/git/repositories/${enc(repo)}/commitsbatch?$top=${top}`, { fromCommitId: baseBranch, toCommitId: targetBranch });
                    const arr = Array.isArray(j) ? j : (Array.isArray(j?.value) ? j.value : []);
                    return {
                        baseBranch,
                        targetBranch,
                        commitCount: arr.length,
                        // `commitsbatch` 是 POST 端点，回不了续页游标（`postJson` 无游标管道），
                        // 命中单请求上限时必须如实说明，别把"前 top 条"当成全量提交差异。
                        ...(arr.length >= top
                            ? { truncated: true, note: `提交批次已达单请求上限 ${top} 条，仅返回前 ${top} 条；如需更全请缩小分支跨度` }
                            : {}),
                        commits: arr.slice(0, top).map(gitCommitView),
                    };
                }
                case 'tfs_list_prs': {
                    const project = str(a['project']);
                    if (!project)
                        throw new TfsAdapterError('tfs_list_prs 需要 project');
                    const repo = str(a['repositoryId'] ?? a['repo']);
                    const status = str(a['status']) || 'active';
                    const top = numberArg(a['top'], 50);
                    let repoIds = [];
                    if (repo) {
                        repoIds = [repo];
                    }
                    else {
                        const repos = await readPagedList(read, `/${enc(project)}/_apis/git/repositories`);
                        repoIds = repos.map(r => str(r['id']) || str(r['name'])).filter(Boolean);
                    }
                    const out = [];
                    for (const rid of repoIds) {
                        const prs = await readPagedList(read, `/${enc(project)}/_apis/git/repositories/${enc(rid)}/pullrequests` +
                            `?searchCriteria.status=${enc(status)}`, { pageSize: top });
                        for (const pr of prs)
                            out.push(prView(pr, rid));
                    }
                    return { count: out.length, pullRequests: out };
                }
                case 'tfs_get_pr': {
                    const { project, repo } = needGitArgs();
                    const prid = Number(a['pullRequestId'] ?? a['id']);
                    if (!Number.isFinite(prid))
                        throw new TfsAdapterError('tfs_get_pr 需要 pullRequestId');
                    const pr = await read.getJson(`/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests/${prid}`);
                    return prView(pr, repo);
                }
                case 'tfs_get_pr_commits': {
                    const { project, repo } = needGitArgs();
                    const prid = Number(a['pullRequestId'] ?? a['id']);
                    const top = numberArg(a['top'], DEFAULT_LIST_PAGE_SIZE);
                    const value = await readPagedList(read, `/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests/${prid}/commits`, { pageSize: top });
                    return value.map(gitCommitView);
                }
                case 'tfs_get_pr_workitems': {
                    const { project, repo } = needGitArgs();
                    const prid = Number(a['pullRequestId'] ?? a['id']);
                    try {
                        const j = await read.getJson(`/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests/${prid}/workitems`);
                        const value = Array.isArray(j?.value) ? j.value : [];
                        return { pullRequestId: prid, count: value.length, workItems: value };
                    }
                    catch (e) {
                        if (e instanceof RestError && e.status === 404) {
                            throw new TfsAdapterError('TFS 2018（api-version 4.1）不支持 PR 关联工作项查询端点（pullrequests/{id}/workItems 返回 404）。');
                        }
                        throw e;
                    }
                }
                case 'tfs_get_pr_diffs': {
                    const { project, repo } = needGitArgs();
                    const prid = Number(a['pullRequestId'] ?? a['id']);
                    const prBase = `/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests/${prid}`;
                    const iterations = await read.getJson(`${prBase}/iterations`);
                    const list = iterations.value ?? [];
                    const latest = list[list.length - 1];
                    const iid = Number(latest?.['id']);
                    if (!Number.isFinite(iid) || iid <= 0) {
                        return { pullRequestId: prid, iterationCount: list.length, changeCount: 0, changes: [] };
                    }
                    const entries = await readPagedList(read, `${prBase}/iterations/${iid}/changes`, {
                        key: 'changeEntries',
                    });
                    return {
                        pullRequestId: prid,
                        iterationId: iid,
                        iterationCount: list.length,
                        changeCount: entries.length,
                        changes: entries.map(e => {
                            const item = (e['item'] ?? {});
                            return {
                                path: str(item['path']),
                                objectId: str(item['objectId']),
                                changeType: str(e['changeType']),
                            };
                        }),
                    };
                }
                case 'tfs_add_pr_comment': {
                    const { project, repo } = needGitArgs();
                    const prid = Number(a['pullRequestId'] ?? a['id']);
                    const content = str(a['comment'] ?? a['content']);
                    if (!Number.isFinite(prid) || !content) {
                        throw new TfsAdapterError('tfs_add_pr_comment 需要 pullRequestId 与 comment/content');
                    }
                    const base = `/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests/${prid}`;
                    const threadId = a['threadId'] !== undefined && a['threadId'] !== null
                        ? Number(a['threadId'])
                        : NaN;
                    if (Number.isFinite(threadId) && threadId > 0) {
                        return await write.postJsonWithType(`${base}/threads/${threadId}/comments`, { content });
                    }
                    // 不开新线程时 status=1（Active）。
                    return await write.postJsonWithType(`${base}/threads`, { comments: [{ content }], status: 1 });
                }
                case 'tfs_create_pr': {
                    const { project, repo } = needGitArgs();
                    const source = normalizeRef(str(a['sourceRefName'] ?? a['sourceBranch']));
                    const target = normalizeRef(str(a['targetRefName'] ?? a['targetBranch']));
                    const title = str(a['title']);
                    if (!source || !target || !title) {
                        throw new TfsAdapterError('tfs_create_pr 需要 sourceRefName、targetRefName、title');
                    }
                    const pr = await write.postJsonWithType(`/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests`, {
                        sourceRefName: source,
                        targetRefName: target,
                        title,
                        description: str(a['description']),
                    });
                    // PR-工作项关联端点在 TFS 2018 上可能缺失：逐个 best-effort，失败只告警不回滚 PR。
                    const warnings = [];
                    const workItemIds = Array.isArray(a['workItems'])
                        ? a['workItems'].map(Number).filter(Number.isFinite)
                        : [];
                    for (const wid of workItemIds) {
                        try {
                            await write.postJsonWithType(`/${enc(project)}/_apis/git/repositories/${enc(repo)}/pullrequests/${pr['pullRequestId']}/workitems`, { workItemId: String(wid) });
                        }
                        catch {
                            warnings.push(`工作项 ${wid} 自动关联失败（TFS 2018 可能不支持该端点），请在 PR 页面手工关联 #${wid}`);
                        }
                    }
                    return warnings.length > 0 ? { ...pr, warnings } : pr;
                }
                default:
                    throw new TfsAdapterError(`REST 化后该能力暂无映射：${raw}。契约 49 个操作中其余已映射操作见「连接与凭据」页能力清单。`);
            }
        }
        catch (e) {
            if (e instanceof TfsAdapterError)
                throw e;
            throw new TfsAdapterError(`TFS REST 调用失败：${raw} —— ${this.restErrorMessage(e)}`);
        }
    }
    // ───────────────────────── TFVC / 变更集关联（T051） ─────────────────────────
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
    async listChangesets(filter = {}) {
        const args = {};
        if (filter.top !== undefined)
            args.top = filter.top;
        if (filter.skip !== undefined)
            args.skip = filter.skip;
        if (filter.author !== undefined)
            args.author = filter.author;
        if (filter.itemPath !== undefined)
            args.itemPath = filter.itemPath;
        if (filter.fromDate !== undefined)
            args.fromDate = filter.fromDate;
        if (filter.toDate !== undefined)
            args.toDate = filter.toDate;
        if (filter.fromId !== undefined)
            args.fromId = filter.fromId;
        if (filter.toId !== undefined)
            args.toId = filter.toId;
        Object.assign(args, this.withCollection(filter.collection));
        return this.call('tfs_list_tfvc_changesets', args);
    }
    /** 取单个变更集详情（只读）。实测必填 `changesetId: number`。 */
    async getChangeset(changesetId, collection) {
        return this.call('tfs_get_tfvc_changeset', {
            changesetId: Number(changesetId),
            ...this.withCollection(collection),
        });
    }
    /** 取工作项已关联的代码提交（只读，含子工作项）。实测必填 `workItemId: number`。 */
    async getWorkItemCommits(workItemId, collection) {
        return this.call('tfs_get_work_item_commits', {
            workItemId: Number(workItemId),
            ...this.withCollection(collection),
        });
    }
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
    async linkChangeset(workItemId, changesetId, collection, confirmed) {
        const cid = Number(changesetId);
        const comment = await this.buildChangesetComment(cid, collection);
        return this.executeWrite('tfs_add_comment', { id: Number(workItemId), comment, ...this.withCollection(collection) }, {
            targetWorkItem: `${workItemId}@${collection ?? this.defaultCollection ?? ''}`,
            opType: 'comment',
            collection,
            before: null,
            after: comment,
            label: `changeset:${cid}`,
        }, confirmed);
    }
    /** 组装变更集关联评论（先取真实元数据，失败降级）。 */
    async buildChangesetComment(changesetId, collection) {
        let meta = '';
        try {
            const raw = (await this.getChangeset(changesetId, collection));
            if (raw && typeof raw === 'object') {
                const author = typeof raw['author'] === 'string' ? raw['author'] : str(raw['author']?.displayName);
                const date = typeof raw['createdDate'] === 'string' ? raw['createdDate'] : '';
                const commentText = typeof raw['comment'] === 'string' ? raw['comment'] : '';
                meta = [
                    author ? `作者：${author}` : '',
                    date ? `时间：${date}` : '',
                    commentText ? `说明：${commentText}` : '',
                ]
                    .filter(Boolean)
                    .join('；');
            }
        }
        catch {
            // 只读取元数据失败 → 降级为精简评论（不阻断关联回写）。
        }
        return meta
            ? `[DSH] 关联 TFVC 变更集 C${changesetId}（${meta}）`
            : `[DSH] 关联 TFVC 变更集 C${changesetId}`;
    }
    // ───────────────────────── 写调用（过四道门禁） ─────────────────────────
    /** 构造 WriteOp（含幂等键）。 */
    buildWriteOp(input) {
        const idempotencyKey = input.repeatable === true
            ? ''
            : input.label
                ? labelIdempotencyKey(input.targetWorkItem, input.collection ?? '', input.label)
                : writeIdempotencyKey({
                    targetWorkItem: input.targetWorkItem,
                    opType: input.opType,
                    before: input.before,
                    after: input.after,
                });
        return {
            targetWorkItem: input.targetWorkItem,
            opType: input.opType,
            before: input.before,
            after: input.after,
            idempotencyKey,
        };
    }
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
    async executeWrite(raw, args, opInput, confirmed) {
        const op = this.buildWriteOp(opInput);
        const gate = this.writeGuard.gate(op, { confirmed });
        if (!gate.ok) {
            // 透传门禁的**结构化**拒绝码：调用方（如 system-writeback 的幂等归一）据此判定
            // "这是门禁主动跳过"而不是"真实失败"，无需对中文 reason 做正则猜测。
            return { ok: false, reason: gate.reason, ...(gate.code ? { code: gate.code } : {}) };
        }
        try {
            const result = await this.call(raw, args);
            // 门禁4 在写调用**成功之后**补记：门禁3 的判重依据就是审计里的幂等键，
            // 先记账的话一次超时 / 412 / 5xx 也会把键标成"已应用"，重试随即被门禁3 拒掉，
            // 一次从未发生的写入会被报成"幂等跳过"（A3）。
            this.writeGuard.record(op);
            return { ok: true, result };
        }
        catch (e) {
            // profileLabel 仅用于审计标注（标识本次写调用归属的 profile 上下文），绝不携带 PAT 明文。
            // 报错文本经 scrubCredentials 擦除：tfs-mcp/TFS 常回显请求 URL（可能带 ?token=/pat=），
            // 直接透出等于把凭据送进面板与日志（T033/CHK002/SC-008）。
            return {
                ok: false,
                reason: `TFS REST 调用失败（profile=${this.profileLabel ?? 'default'}）：${scrubCredentials(e.message)}`,
            };
        }
    }
    /** 打标签（幂等 S-08；进入队列即打 dsh 标签，T48）。实测 schema：`{id:number, tags:string(分号拼接), collection?}`。 */
    async addTags(workItemId, collection, tags, beforeTags, confirmed) {
        const id = Number(workItemId);
        const merged = Array.from(new Set([...beforeTags, ...tags]));
        return this.executeWrite('tfs_add_tags', { id, tags: tags.join(';'), ...this.withCollection(collection) }, {
            targetWorkItem: `${workItemId}@${collection ?? this.defaultCollection ?? ''}`,
            opType: 'tag',
            collection,
            before: beforeTags,
            after: merged,
            label: tags.length === 1 ? tags[0] : undefined,
        }, confirmed);
    }
    /** 变更状态。实测 schema：`{id:number, state:string, reason?, collection?}`。 */
    async changeState(workItemId, collection, toState, beforeState, confirmed) {
        return this.executeWrite('tfs_change_state', { id: Number(workItemId), state: toState, ...this.withCollection(collection) }, {
            targetWorkItem: `${workItemId}@${collection ?? this.defaultCollection ?? ''}`,
            opType: 'state',
            collection,
            before: beforeState,
            after: toState,
        }, confirmed);
    }
    /** 追加评论（TFVC/变更集关联也走评论，S-04/T051）。实测 schema：`{id:number, comment:string, collection?}`。 */
    async addComment(workItemId, collection, comment, confirmed) {
        return this.executeWrite('tfs_add_comment', { id: Number(workItemId), comment, ...this.withCollection(collection) }, {
            targetWorkItem: `${workItemId}@${collection ?? this.defaultCollection ?? ''}`,
            opType: 'comment',
            collection,
            before: null,
            after: comment,
        }, confirmed);
    }
    /** 创建新工作项。实测 schema：必填 `project`/`workItemType`/`title`，其余可选，`fields` 承载自定义字段。 */
    async createWorkItem(collection, spec, confirmed) {
        const args = {
            project: spec.project,
            workItemType: spec.workItemType,
            title: spec.title,
        };
        if (spec.description !== undefined)
            args.description = spec.description;
        if (spec.parentWorkItemId !== undefined)
            args.parentWorkItemId = spec.parentWorkItemId;
        if (spec.assignedTo !== undefined)
            args.assignedTo = spec.assignedTo;
        if (spec.areaPath !== undefined)
            args.areaPath = spec.areaPath;
        if (spec.iterationPath !== undefined)
            args.iterationPath = spec.iterationPath;
        if (spec.fields !== undefined)
            args.fields = spec.fields;
        Object.assign(args, this.withCollection(collection));
        return this.executeWrite('tfs_create_workitem', args, {
            targetWorkItem: `new@${collection ?? this.defaultCollection ?? ''}`,
            opType: 'state',
            collection,
            before: null,
            after: spec,
        }, confirmed);
    }
    /** 指派工作项。实测 schema：`{id:number, assignedTo:string, collection?}`（注意字段名 assignedTo）。 */
    async assign(workItemId, collection, assignTo, beforeAssignee, confirmed) {
        return this.executeWrite('tfs_assign', { id: Number(workItemId), assignedTo: assignTo, ...this.withCollection(collection) }, {
            targetWorkItem: `${workItemId}@${collection ?? this.defaultCollection ?? ''}`,
            opType: 'state',
            collection,
            before: beforeAssignee,
            after: assignTo,
        }, confirmed);
    }
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
    async removeTags(workItemId, collection, tagsToRemove, confirmed) {
        const id = Number(workItemId);
        const targetWorkItem = `${workItemId}@${collection ?? this.defaultCollection ?? ''}`;
        const { read } = this.restFor(collection);
        // ⚠️ 只读 `System.Tags` 一个字段，不要拉全字段（2026-10-06 修复）。
        //
        // `GET /_apis/wit/workitems/{id}` **不带 `fields`** 会连带返回**全部 relations**：
        // 实测根计划项 id=1 单条响应达 3.3MB（7316 条 relations）。而「还原到需求池」是
        // 高频操作，这里唯一的目的只是读出当前标签做差集——为一个字符串付出 MB 级传输，
        // 在大工作项上还会把 20s 超时真正吃掉。同文件的 `readCurrentTags` 早已用
        // `fields` 限定，这里与其保持一致（直接复用它）。
        const currentTags = await readCurrentTags(read, id);
        const removeSet = new Set(tagsToRemove);
        const removed = currentTags.filter(t => removeSet.has(t));
        // 标签已不存在 ⇒ 目标状态已达成，不发写调用（幂等：重复点击还原不该反复写 TFS）。
        if (removed.length === 0)
            return { id, tags: currentTags };
        const kept = currentTags.filter(t => !removeSet.has(t));
        const outcome = await this.executeWrite('tfs_remove_tags', { id, tags: [...removeSet].join(';'), ...this.withCollection(collection) }, {
            targetWorkItem,
            opType: 'tag',
            collection,
            before: currentTags,
            after: kept,
        }, confirmed);
        if (!outcome.ok)
            throw new TfsAdapterError(outcome.reason ?? '移除标签失败');
        // 标签类幂等键编码的是"当前带这个标签"这一状态；摘掉标签就得把账本里的 apply 作废，
        // 否则同一需求还原后再也领不回来——门禁 3 会把重领判成重复（claim 只剩 tag:{ok:false}）。
        // 这一段必须**在 return 之前**执行（曾因重构顺序被压到 return 之后变成死代码）。
        for (const tag of removed) {
            this.writeGuard.release(labelIdempotencyKey(`${id}@${collection ?? this.defaultCollection ?? ''}`, collection ?? '', tag), { workItemId: id, collection: collection ?? this.defaultCollection, removed: tag });
        }
        return { id, tags: kept };
    }
}
/** 适配层错误（工具未注册 / 调用失败）。 */
export class TfsAdapterError extends Error {
    constructor(message) {
        super(message);
        this.name = 'TfsAdapterError';
    }
}
/** 适配层 `call()` 已实现 REST 分支的操作键（单一事实源，供能力目录标注缺口；问题 13 后覆盖契约全部 49 个操作）。 */
export const IMPLEMENTED_OPERATIONS = new Set([
    // 连接 / 集合
    'tfs_whoami',
    'tfs_get_current_collection',
    'tfs_set_collection',
    'tfs_update_token',
    'tfs_list_collections',
    // 工作项读
    'tfs_get_projects',
    'tfs_get_workitem',
    'tfs_get_work_items',
    'tfs_query_wiql',
    'tfs_get_my_tasks',
    'tfs_get_work_items_by_customer',
    'tfs_get_recent_resolved',
    'tfs_get_bugs',
    'tfs_get_relations',
    'tfs_custom_query',
    'tfs_search_work_items',
    'tfs_run_saved_query',
    // 工作项写
    'tfs_update_workitem',
    'tfs_add_tags',
    'tfs_remove_tags',
    'tfs_add_comment',
    'tfs_change_state',
    'tfs_assign',
    'tfs_create_workitem',
    // 附件
    'tfs_list_attachments',
    'tfs_upload_attachment',
    'tfs_download_attachments',
    'tfs_download_tfvc_files',
    // TFVC
    'tfs_list_tfvc_changesets',
    'tfs_get_tfvc_changeset',
    'tfs_get_tfvc_changeset_changes',
    'tfs_list_tfvc_branches',
    'tfs_list_tfvc_items',
    'tfs_get_tfvc_item',
    'tfs_get_tfvc_file',
    'tfs_get_work_item_commits',
    // Git
    'tfs_list_repos',
    'tfs_get_repo',
    'tfs_get_commits',
    'tfs_list_branches',
    'tfs_get_branch',
    'tfs_get_branch_diffs',
    'tfs_check_commit_work_items',
    // Pull Request
    'tfs_list_prs',
    'tfs_get_pr',
    'tfs_get_pr_commits',
    'tfs_get_pr_diffs',
    'tfs_get_pr_workitems',
    'tfs_add_pr_comment',
    'tfs_create_pr',
]);
// ─────────────── 宿主工具运行时适配（2026-09-18 安装期实测纠正） ───────────────
/**
 * 单次调用超时默认值：120s。
 *
 * REST 化后 rest-client 自带超时（默认 20s，见 `DEFAULT_REST_TIMEOUT_MS`），
 * 本常量保留仅为兼容既有引用（渐进移除）。
 */
export const DEFAULT_CALL_TIMEOUT_MS = 120_000;
/**
 * 解包 `ToolExecutionResult.value`（MCP 信封）成业务载荷。
 *
 * REST 化后主路径不再经过 MCP 信封，但保留此函数：单测（adapter.spec.ts）仍用它
 * 验证信封解包行为，且若未来某能力回退 mcp 通道可复用。
 *
 * @param value - `ToolRunOutcome.value`。
 * @returns 业务载荷；无法解出时返回 `undefined`（调用方据此抛可读错误）。
 */
export function unwrapToolValue(value) {
    if (value === null || typeof value !== 'object')
        return value;
    const envelope = value;
    const structured = envelope['structuredContent'];
    if (structured !== undefined)
        return structured;
    const content = envelope['content'];
    if (Array.isArray(content)) {
        for (const block of content) {
            if (block === null || typeof block !== 'object')
                continue;
            const text = block['text'];
            if (typeof text !== 'string')
                continue;
            const parsed = tryParseJson(text);
            return parsed === undefined ? text : parsed;
        }
        // 有 content 但没有文本块（例如纯图片块）：交给调用方判为"无法解析"。
        return undefined;
    }
    // 既不是信封也不带 content：视为裸载荷透传。
    return value;
}
/** `JSON.parse` 的安全包装：失败返回 `undefined` 而非抛错。 */
function tryParseJson(text) {
    try {
        return JSON.parse(text);
    }
    catch {
        return undefined;
    }
}
// ───────────────────────── 归一化辅助（T013 实测形状） ─────────────────────────
/** 列表响应体积熔断默认阈值：16MB（依据见 `TfsAdapterOptions.maxResponseBytes` 实测注释）。 */
export const DEFAULT_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
/**
 * 「工作项关联提交」扫描的变更集数量上限。
 *
 * TFVC 变更集与工作项的关联没有服务端查询入口（TFS 2018 的 `searchCriteria.*` 只认
 * fromId/toId/fromDate/toDate/fromUser/toUser/itemPath，没有 `workItemId`），只能按游标
 * 拉最近变更集并在客户端过滤。此值是那个"最近窗口"的大小，响应里如实回报扫了多少个。
 */
const WORK_ITEM_COMMITS_SCAN_LIMIT = 500;
/**
 * 单页列表端点的默认页大小。
 *
 * TFS 2018 在结果超过 `$top` 时既不报错也不在响应体里标注总数，只回
 * `x-ms-continuationtoken` 游标头。不跟随游标就会把「前 N 条」当成「全部」，
 * 而 PR 列表、变更条目、提交批次、仓库清单的调用方都按全集做后续处理。
 */
const DEFAULT_LIST_PAGE_SIZE = 200;
/**
 * 元数据采集的**并发上限**（同时在飞的 HTTP 请求数）。
 *
 * 缺省值。`getQueryOptions` 的类型/状态采集是 O(项目×类型) 次 GET：WN_HIS 实测 62 个
 * 项目、每项目最多 `STATE_PROBE_TYPES` 个类型要探状态，合计约 800 次请求。裸
 * `Promise.all` 会一次性开出 62 条并发连接，每条还自带一个 20 s `AbortController`，
 * 对一台本地 TFS 是相当粗暴的压力。实际部署可按现场网络调小/调大（见 `Config` 的
 * `queryOptionsConcurrency`）。
 */
const DEFAULT_QUERY_OPTIONS_CONCURRENCY = 8;
/**
 * 带并发上限的 `map`：结果顺序与入参一致。
 *
 * @param items - 待处理项。
 * @param limit - 同时在飞的任务数（小于 1 时按 1 处理；比入参多时不会白开 worker）。
 * @param fn - 单项处理（内部已各自 try/catch 降级，此处不吞异常）。
 * @returns 与 `items` 等长、按原序排列的结果。
 */
async function mapWithLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    const workers = Array.from({ length: Math.max(1, Math.min(Math.trunc(limit) || 1, items.length)) }, async () => {
        for (;;) {
            const index = next++;
            const item = items[index];
            if (index >= items.length || item === undefined)
                return;
            results[index] = await fn(item, index);
        }
    });
    await Promise.all(workers);
    return results;
}
/**
 * 逐页取回一个返回 `{ value: [...] }` 的列表端点的**全部**条目。
 *
 * TFS 2018 超过 `$top` 时只回 `x-ms-continuationtoken` 游标头，不报错、也不在响应体里
 * 标注总数；单发一次请求会把「前 N 条」当成「全部」交给调用方（PR 列表、变更条目、
 * 提交批次、仓库清单都按全集做后续处理）。此方法按 `collectPaged` 跟随游标直到取完，
 * 或达到 `maxPages` 安全上限。
 *
 * @param read - REST 读客户端。
 * @param basePath - 端点路径（可自带查询串，分隔符按是否已有 `?` 决定）。
 * @param opts.pageSize - 单页条数，缺省 {@link DEFAULT_LIST_PAGE_SIZE}。
 * @param opts.maxPages - 页数安全上限，缺省沿用 `collectPaged` 的 50。
 * @param opts.key - 响应体里列表所在的字段，缺省 `value`（PR 变更条目是 `changeEntries`）。
 * @returns 按服务端顺序排列的全部条目（响应体无该字段时返回空数组）。
 */
async function readPagedList(read, basePath, opts) {
    const top = Math.max(1, Math.trunc(opts?.pageSize ?? DEFAULT_LIST_PAGE_SIZE));
    const key = opts?.key ?? 'value';
    const sep = basePath.includes('?') ? '&' : '?';
    return collectPaged(async ({ $skip, continuationToken }) => {
        let next = '';
        const j = await read.getJson(`${basePath}${sep}$top=${top}&$skip=${$skip}`, {
            ...(continuationToken ? { continuationToken } : {}),
            captureHeaders: headers => {
                next = headers?.get(CONTINUATION_HEADER) ?? '';
            },
        });
        const items = j?.[key];
        return { items: Array.isArray(items) ? items : [], nextToken: next };
    }, opts?.maxPages === undefined ? undefined : { maxPages: opts.maxPages });
}
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
export function isWiqlEmptyResult(message) {
    const m = message.toLowerCase();
    return m.includes('items is not iterable') || m.includes('cannot read property null');
}
/**
 * 安全估算响应序列化**体积**（`JSON.stringify` 失败/循环引用时退化为 0，不抛）。
 *
 * ⚠️ 口径诚实说明：返回的是 `String.length`，即 **UTF-16 码元数**，不是 UTF-8 字节数。
 * 实测同一份真实响应：2,810,204 字符 / 2,983,788 字节（中文让字节数高约 6%）。
 * 用作熔断阈值时这是**偏保守**（先熔断）方向的误差，可接受，但命名保留 `Bytes` 需知此差异。
 */
export function safeSerializedBytes(raw) {
    try {
        if (raw === null || raw === undefined)
            return 0;
        const s = typeof raw === 'string' ? raw : JSON.stringify(raw);
        return typeof s === 'string' ? s.length : 0;
    }
    catch {
        return 0;
    }
}
/** 取字符串（非字符串返回空串）。 */
function str(v) {
    return typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v);
}
/** 取数字（无法解析返回 0）。 */
function num(v) {
    const n = typeof v === 'number' ? v : Number(v);
    return Number.isFinite(n) ? n : 0;
}
/**
 * 取写操作的工作项 id，缺失或非法即拒绝。
 *
 * 写端点 URL 里带 id：`Number(undefined)` 得 `NaN`，会让 `PATCH /_apis/wit/workitems/NaN`
 * 返回难以理解的 404/Bad Request。这里在发出请求前拦住，并把可执行诊断交给调用方。
 *
 * @param a - 调用参数（取 `id`）。
 * @param raw - 工具名（用于诊断文本）。
 * @returns 正整数工作项 id。
 */
function requireWorkItemId(a, raw) {
    const id = typeof a['id'] === 'number' ? a['id'] : Number(a['id']);
    if (!Number.isInteger(id) || id <= 0)
        throw new TfsAdapterError(`${raw} 需要正整数 id 参数（收到：${String(a['id'] ?? '')}）`);
    return id;
}
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
export function identityStr(v) {
    if (typeof v === 'string')
        return v;
    if (v === undefined || v === null)
        return '';
    const o = v;
    const direct = str(o['displayName']) || str(o['uniqueName']);
    if (direct)
        return direct;
    const props = (o['properties'] ?? {});
    const account = (props['Account'] ?? {});
    const mail = (props['Mail'] ?? {});
    return str(account['$value']) || str(mail['$value']) || str(v);
}
/**
 * 把标签入参归一化为字符串数组。
 *
 * TFS REST 的 `System.Tags` 是**分号分隔的单字符串**，而工具契约声明的是字符串数组
 * （`tool-catalog.ts`：`tags: '标签数组（必填）'`）。两种形态都接受；数组里的每一项
 * 视为一个标签，绝不再 `String()` 拼接（那会把 `['a','b']` 变成单个标签 `"a,b"`）。
 *
 * @param v - 入参（字符串数组，或分号/逗号分隔的字符串）。
 * @returns 去空去重后的标签数组（保持首次出现顺序）。
 */
function parseTagList(v) {
    const parts = Array.isArray(v)
        ? v.map(item => (typeof item === 'string' ? item : str(item)))
        : str(v).split(/[;,]/);
    const out = [];
    for (const p of parts) {
        const t = p.trim();
        if (t && !out.includes(t))
            out.push(t);
    }
    return out;
}
/**
 * 读工作项当前的 `System.Tags` 并切成数组。
 *
 * JSON-Patch 的 `replace` 覆盖整个字段，所以加标签前必须先读回既有值做并集 ——
 * 否则「领取需求打 dsh 标签」会顺手抹掉用户在 TFS 上打的所有其他标签。
 *
 * @param read - REST 读端点。
 * @param id - 工作项 id。
 * @returns 既有标签数组（字段缺失或为空时返回空数组）。
 */
async function readCurrentTags(read, id) {
    const row = await read.getWorkItem(id, ['System.Tags']);
    const fields = (row['fields'] ?? {});
    return parseTagList(fields['System.Tags']);
}
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
export function normalizeWorkItem(raw, fallbackCollection) {
    const o = (raw ?? {});
    const fields = (o['fields'] ?? {});
    const pick = (flatKey, refKey) => o[flatKey] !== undefined ? o[flatKey] : fields[refKey];
    const rawTags = str(pick('tags', 'System.Tags'));
    // 正文（US3）：TFS 的 `System.Description` 是富文本 HTML，**在此处**转成可读纯文本。
    //
    // 为什么在适配层转而不是让客户端自己转：① 转换只需做一次，落进 board.json 与所有
    // 下发的都是干净文本；② 客户端半编译范围不含本模块，且没有 HTML 解析依赖；
    // ③ 转换是纯函数（`src/shared/text.ts`），可被单测直接覆盖。
    /**
     * HTML 富文本字段 → 纯文本并截断（问题 11 的三个 Winning 字段同 System.Description 处理）。
     * 空串归一为空串，由调用方决定是否写入键。
     */
    const richField = (refKey) => truncateText(htmlToPlainText(str(fields[refKey] ?? o[refKey])), MAX_DESCRIPTION_CHARS);
    const description = truncateText(htmlToPlainText(str(pick('description', 'System.Description'))), MAX_DESCRIPTION_CHARS);
    // 问题 11：需求分析 / 数据结构 / 需求配置（字段引用名为 2026-09-20 探针对「需求」类型实测）。
    const analysis = richField('Winning.Demand.Analysis');
    const dataStructure = richField('Winning.Data.Design');
    const demandConfig = richField('Winning.Demand.Config');
    return {
        id: num(pick('id', 'System.Id')),
        collection: str(o['collection']) || fallbackCollection,
        project: str(o['project']) || identityStr(fields['System.TeamProject']),
        title: str(pick('title', 'System.Title')),
        // 空正文不写字段：避免 board.json 里堆满空串（与 `workspace` 同纪律）。
        ...(description.length > 0 ? { description } : {}),
        ...(analysis.length > 0 ? { analysis } : {}),
        ...(dataStructure.length > 0 ? { dataStructure } : {}),
        ...(demandConfig.length > 0 ? { config: demandConfig } : {}),
        type: str(pick('type', 'System.WorkItemType')),
        state: str(pick('state', 'System.State')),
        assignedTo: identityStr(pick('assignedTo', 'System.AssignedTo')),
        priority: str(pick('priority', 'Microsoft.VSTS.Common.Priority')),
        areaPath: str(pick('areaPath', 'System.AreaPath')),
        iterationPath: str(pick('iterationPath', 'System.IterationPath')),
        tags: parseTagList(rawTags),
        changedDate: str(pick('changedDate', 'System.ChangedDate')),
        url: str(o['url']),
    };
}
/** WIQL 字符串字面量转义（单引号翻倍），避免注入（SC-008 安全面）。 */
export function escapeWiql(value) {
    return value.replace(/'/g, "''");
}
/**
 * WIQL 命中后批量取工作项的字段清单（问题 11/13 统一）。
 * 含目标填充四段（System.Description + 三个 Winning 自定义字段）。
 */
const WIQL_FETCH_FIELDS = [
    'System.Id', 'System.Title', 'System.WorkItemType', 'System.State',
    'System.AssignedTo', 'System.ChangedDate', 'System.AreaPath',
    'System.IterationPath', 'System.Tags', 'System.TeamProject',
    'Microsoft.VSTS.Common.Priority',
    'System.Description',
    'Winning.Demand.Analysis', 'Winning.Data.Design', 'Winning.Demand.Config',
];
/** 工具参数 → 字符串数组（数组原样；字符串按逗号拆分）；空值过滤。 */
function strArray(v) {
    if (Array.isArray(v))
        return v.map(x => String(x ?? '').trim()).filter(Boolean);
    if (typeof v === 'string')
        return v.split(',').map(s => s.trim()).filter(Boolean);
    return [];
}
/** 工具参数 → 正整数，缺失/非法时回落默认值。 */
function numberArg(v, fallback) {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}
/** ISO/任意日期串 → YYYY-MM-DD（WIQL 日期字面量）。 */
function dateOnly(v) {
    return v.slice(0, 10);
}
/** n 天前的 YYYY-MM-DD（本地时区）。 */
function isoDaysAgo(days) {
    const d = new Date();
    d.setDate(d.getDate() - days);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
/** 从工作项关联 URL 末尾提取目标 id（取不到返回 0）。 */
function idFromUrl(url) {
    const m = /(\d+)(?:\?[^/]*)?$/.exec(url);
    return m ? Number(m[1]) : 0;
}
/** 从附件 URL 的 filename 查询参数取文件名。 */
function filenameFromUrl(url) {
    try {
        const u = new URL(url);
        const f = u.searchParams.get('filename');
        return f ? safeBasename(f) : '';
    }
    catch {
        return '';
    }
}
/**
 * 文件名清洗：只保留 basename，替换 Windows 非法字符（防目录穿越/落盘失败）。
 */
function safeBasename(name) {
    const b = path.basename(name).replace(/[<>:"|?*\x00-\x1f]/g, '_').trim();
    return b.length > 0 ? b : 'unnamed';
}
/**
 * 安全拼接落盘路径：解析后目标必须仍在 rootDir 内，否则视为目录穿越攻击直接拒绝。
 */
function safeJoin(rootDir, rel) {
    const root = path.resolve(rootDir);
    const dest = path.resolve(root, rel);
    if (dest !== root && !dest.startsWith(root + path.sep)) {
        throw new TfsAdapterError(`非法的文件相对路径（疑似目录穿越）：${rel}`);
    }
    return dest;
}
/** 一组 $/ 路径的公共父目录（如 $/A/B 与 $/A/C → $/A；无公共父级 → $/）。 */
function commonRootOf(paths) {
    const split = paths.map(p => p.split('/').slice(0, -1));
    let common = split[0] ?? [];
    for (const parts of split.slice(1)) {
        let i = 0;
        while (i < common.length && i < parts.length && common[i] === parts[i])
            i += 1;
        common = common.slice(0, i);
    }
    return common.length > 0 ? common.join('/') : '$/';
}
/** TFVC 路径去掉公共根后的相对路径（始终以 $/ 开头的输入）。 */
function stripRoot(tfvcPath, root) {
    const normRoot = root.endsWith('/') ? root : `${root}/`;
    const rel = tfvcPath.startsWith(normRoot)
        ? tfvcPath.slice(normRoot.length)
        : tfvcPath.replace(/^\$\//, '');
    return rel.replace(/^\/+/, '');
}
/** TFVC item JSON → 精简视图。 */
function tfvcItemView(item) {
    return {
        path: str(item['path']),
        isFolder: item['isFolder'] === true,
        version: item['version'],
        changeDate: str(item['changeDate']),
        size: item['size'],
        url: str(item['url']),
    };
}
/** Git commit JSON → 精简视图。 */
function gitCommitView(c) {
    const author = (c['author'] ?? {});
    const committer = (c['committer'] ?? {});
    return {
        commitId: str(c['commitId']),
        shortId: str(c['commitId']).slice(0, 8),
        comment: str(c['comment']),
        author: str(author['displayName'] ?? author['name']) || str(c['author']),
        date: str(author['date'] ?? committer['date']),
        url: str(c['url']),
    };
}
/** Git PR JSON → 精简视图。 */
function prView(pr, repositoryId) {
    const createdBy = (pr['createdBy'] ?? {});
    return {
        pullRequestId: pr['pullRequestId'],
        repositoryId,
        title: str(pr['title']),
        status: str(pr['status']),
        createdBy: str(createdBy['displayName'] ?? createdBy['uniqueName']),
        creationDate: str(pr['creationDate']),
        sourceRefName: str(pr['sourceRefName']),
        targetRefName: str(pr['targetRefName']),
        description: str(pr['description']),
        url: str(pr['url']),
    };
}
/** 分支名归一：裸分支名补 refs/heads/ 前缀（已是完整引用则原样）。 */
function normalizeRef(ref) {
    if (!ref)
        return '';
    return ref.startsWith('refs/') ? ref : `refs/heads/${ref}`;
}
/** 字节内容是否大概率为文本（前 1KB 无 NUL 字节即视为文本）。 */
function isProbablyText(buf) {
    const head = buf.subarray(0, 1024);
    for (const b of head) {
        if (b === 0)
            return false;
    }
    return true;
}
/**
 * 该字面量能否安全进入 WIQL 的 **`CONTAINS`** 子句（纯可打印 ASCII 才可）。
 *
 * 实测依据（真实 TFS）：`CONTAINS '框架'` → **414**；`CONTAINS 'MEMORY'` → 正常；
 * `[System.State] = '不存在状态ZZZ'`（中文等值）→ 正常 `[]`。
 * ⇒ 限制只针对 `CONTAINS`，**等值 `=` 不受此限**。
 */
export function isAsciiSafe(value) {
    return /^[\x20-\x7E]*$/.test(value);
}
//# sourceMappingURL=adapter.js.map
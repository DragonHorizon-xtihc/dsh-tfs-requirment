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
 * @module @deepseek-ai/dsh-tfs-requirment/tfs/rest-client
 */
import { scrubCredentials } from '../shared/redact.js';
/** TFS 2018 的主线 API 版本（`7.1` 家族会 404，勿改）。 */
export const API_VERSION = '4.1';
/** 预览资源专用版本（仅 `workitemtypes/{type}/states` 需要）。 */
export const API_VERSION_PREVIEW = '4.1-preview';
/** REST 调用默认超时（毫秒）。 */
export const DEFAULT_REST_TIMEOUT_MS = 20_000;
/** 归一化后的 REST 失败（比 HTTPError 多一层"业务可读"语义）。 */
export class RestError extends Error {
    /** HTTP 状态码（网络错误时为 0）。 */
    status;
    /** TFS 业务错误码（如 `VS403351` / `TF51535`），无则空串。 */
    code;
    constructor(message, status, code = '') {
        super(message);
        this.name = 'RestError';
        this.status = status;
        this.code = code;
    }
}
/** 判定「该工作项已被他人修改」（rev test 冲突，实测 412 + VS403351）。 */
export function isRevConflict(e) {
    return e instanceof RestError && e.status === 412;
}
/** 判定「资源不存在 / 项目名非法」（404 纯文本或 400 找不到项目）。 */
export function isNotFound(e) {
    return e instanceof RestError && (e.status === 404 || /在层次结构中找不到指定的项目/.test(e.message));
}
/** 判定「凭据失效」（401）。 */
export function isUnauthorized(e) {
    return e instanceof RestError && e.status === 401;
}
/** Basic 认证头（`base64(":" + PAT)`，TFS 2018 实测形态）。 */
export function basicAuth(pat) {
    return `Basic ${Buffer.from(`:${pat}`, 'utf8').toString('base64')}`;
}
/**
 * 校验 TFS 基址可拼 URL（此前 `RestConfig.url` 从不校验，拼出非法 URL 后只得到
 * 一条无信息量的「网络错误：fetch failed」）。
 *
 * @param url - 待校验的基址。
 * @returns 非空串表示不可用（作为 RestError 消息），空串表示通过。
 */
function baseUrlIssue(url) {
    const trimmed = url.trim();
    if (trimmed.length === 0)
        return 'TFS 基址为空：请在「连接与凭据」页填写 TFS 服务地址';
    let parsed;
    try {
        parsed = new URL(trimmed);
    }
    catch {
        return `TFS 基址不是合法 URL：${trimmed}（应形如 http://host:8080/tfs）`;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
        return `TFS 基址协议不支持：${parsed.protocol}（只支持 http/https）`;
    }
    return '';
}
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
export function restTransportNotice(cfg) {
    try {
        if (new URL(cfg.url.trim()).protocol === 'http:') {
            return 'TFS 基址是 http 明文传输：PAT 仅 base64 编码（可逆），凭据与工作项内容在网络上可被读取，建议改用 https 或经内网/VPN 访问';
        }
    }
    catch {
        // 基址非法由 baseUrlIssue 单独报错。
    }
    return undefined;
}
/**
 * 绝对地址必须与基址同源，否则不得携带 PAT 发出请求。
 *
 * 附件下载的 URL 来自工作项的 `AttachedFile` 关系，是**服务端数据**。缺少这道
 * 同源校验时，一条指向外部主机的关系会让插件把 base64 PAT 主动送到该主机
 * （凭据外泄 / SSRF）。同源判定含 scheme + host + port。
 *
 * @param cfg - REST 连接配置（含基址与 PAT）。
 * @param absoluteUrl - 待请求的绝对地址。
 * @returns 非空串表示不可用（作为 RestError 消息），空串表示通过。
 */
function absoluteUrlIssue(cfg, absoluteUrl) {
    let base;
    let target;
    try {
        base = new URL(cfg.url.trim());
        target = new URL(absoluteUrl);
    }
    catch {
        return `请求地址不是合法 URL：${absoluteUrl}`;
    }
    const same = base.protocol === target.protocol && base.host === target.host && base.port === target.port;
    return same ? '' : `拒绝跨源请求 ${target.origin}：地址与已配置的 TFS 基址 ${base.origin} 不同源，携带 PAT 的请求不得发往外部主机`;
}
/**
 * 从 TFS 错误响应体萃取可读消息与业务错误码。
 *
 * 实测的两种形态：
 *   - JSON：`{"$id":"1","message":"VS403351: Test Operation ...","typeName":"..."}`
 *   - 纯文本：`Sorry, Page Not Found`（404）
 * 先试 JSON.parse 再回落文本；全文先过 scrubCredentials（错误体可能回显请求 URL）。
 */
export function parseErrorBody(status, rawBody) {
    const text = scrubCredentials(rawBody).trim();
    let message = text;
    let code = '';
    try {
        const j = JSON.parse(text);
        if (j && typeof j === 'object' && typeof j['message'] === 'string') {
            message = j['message'];
            const typeName = typeof j['typeName'] === 'string' ? j['typeName'] : '';
            // VS403351（rev 冲突）/ TF51535（字段不存在）这类业务码在 message 前缀或 typeName 里。
            const m = /^(VS\d+|TF\d+)/.exec(message);
            if (m && m[1])
                code = m[1];
            else {
                const t = /([\w.]+Exception)/.exec(typeName);
                if (t && t[1])
                    code = (t[1].split('.').pop() ?? '');
            }
        }
    }
    catch {
        // 非 JSON（如 `Sorry, Page Not Found`）：原样作为消息。
    }
    // rev 冲突码兜底（消息里有但前缀正则没命中的情况）。
    if (!code && message.includes('VS403351'))
        code = 'VS403351';
    const label = status === 0 ? '网络错误' : `HTTP ${status}`;
    return new RestError(`${label}：${message}`, status, code);
}
/** 从 rev 冲突消息里抽实际 rev（`value 8 was not equal to test value 999999` → 8）。 */
export function extractActualRev(message) {
    const m = /value (\d+) was not equal to test value (\d+)/.exec(message);
    return m ? Number(m[1]) : undefined;
}
/** 内部请求实现（拼接 URL、超时、认证、错误归一）。 */
async function request(cfg, method, path, init) {
    const baseIssue = baseUrlIssue(cfg.url);
    if (baseIssue)
        throw new RestError(baseIssue, 0);
    const base = cfg.url.replace(/\/+$/, '');
    const isAbsolute = init?.absolute === true || /^https?:\/\//.test(path);
    let url;
    if (isAbsolute) {
        // 绝对地址（附件下载 URL 已自带完整签名路径）：原样使用；仅当显式给了 apiVersion 才追加。
        // 同源校验：地址来自服务端数据，不能让它把 PAT 带走。
        const cross = absoluteUrlIssue(cfg, path);
        if (cross)
            throw new RestError(cross, 0);
        url = path;
        if (typeof init?.apiVersion === 'string') {
            url += `${url.includes('?') ? '&' : '?'}api-version=${init.apiVersion}`;
        }
    }
    else if (init?.serverLevel === true) {
        // 服务器级端点（集合清单等）：拼 baseUrl 但不拼集合段。
        const av = init?.apiVersion === false
            ? ''
            : `${path.includes('?') ? '&' : '?'}api-version=${init?.apiVersion ?? API_VERSION}`;
        url = `${base}/${path.replace(/^\/+/, '')}${av}`;
    }
    else {
        const colPart = cfg.collection ? `${encodeURIComponent(cfg.collection)}` : '';
        const av = init?.apiVersion === false
            ? ''
            : `${path.includes('?') ? '&' : '?'}api-version=${init?.apiVersion ?? API_VERSION}`;
        // path 约定以 / 开头，这里剥掉后再拼，保证不出现双斜杠。
        const rel = `/${colPart}${colPart ? '/' : ''}${path.replace(/^\/+/, '')}`;
        url = `${base}${rel}${av}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS);
    // 原始字节体（附件上传）直接发送；对象体按 JSON 序列化。
    const isRawBody = init?.body instanceof Uint8Array || typeof init?.body === 'string';
    let res;
    try {
        res = await (cfg.fetchImpl ?? fetch)(url, {
            method,
            headers: {
                Authorization: basicAuth(cfg.pat),
                Accept: init?.accept ?? 'application/json',
                ...(init?.body !== undefined
                    ? { 'Content-Type': init?.contentType ?? 'application/json' }
                    : {}),
                ...(init?.continuationToken
                    ? { [CONTINUATION_HEADER]: init.continuationToken }
                    : {}),
            },
            // 原始字节体（Uint8Array/Buffer）或字符串直接发送；undici 的 body 接受两者。
            // 经 RequestInit['body'] 索引访问转型：Node（undici-types）与 DOM 两套 fetch
            // 类型对 Uint8Array 的泛型参数判定不同（TS 5.7+ 的 Uint8Array<ArrayBufferLike>
            // 不满足 DOM BodyInit），索引访问在两套 lib 下都成立。
            body: (init?.body === undefined
                ? undefined
                : isRawBody
                    ? init.body
                    : JSON.stringify(init.body)),
            signal: controller.signal,
        });
        // ⚠️ **响应体必须在同一个 AbortController 的监管下读完**（2026-10-05 修复）：
        // 原实现在 fetch resolve 后就 `finally { clearTimeout(timer) }`，于是「服务端已回响应头、
        // 但体极慢」这一阶段完全没有超时保护 —— 而这恰恰是下载大附件 / 大 WIQL 结果最易命中的形态，
        // 表现为请求永久挂起、20s 超时形同虚设。故 clearTimeout 移到**两个 await 都结束之后**。
        const rawBody = await res.text();
        init?.captureHeaders?.(res.headers);
        if (!res.ok) {
            throw parseErrorBody(res.status, rawBody);
        }
        if (rawBody.length === 0)
            return undefined;
        try {
            return JSON.parse(rawBody);
        }
        catch {
            // 200 但非 JSON（不应发生，防御性透传文本）。
            return rawBody;
        }
    }
    catch (e) {
        throw wrapTransportError(e, cfg);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 下载二进制（GET，不做 JSON 解析；404/401 等仍归一为 RestError）。
 *
 * 集合相对路径必须带 `api-version=4.1`：该服务的版本串决定 404 与 200（见文件头
 * 硬事实 1），缺了它 TFVC 文件下载会走一条未经实测的路径。绝对地址（附件签名 URL）
 * 已自带完整路径，不追加查询串，但必须与基址同源才允许携带 PAT。
 */
async function requestBlob(cfg, path, absolute = false) {
    const baseIssue = baseUrlIssue(cfg.url);
    if (baseIssue)
        throw new RestError(baseIssue, 0);
    const base = cfg.url.replace(/\/+$/, '');
    const isAbsolute = absolute || /^https?:\/\//.test(path);
    let url;
    if (isAbsolute) {
        const cross = absoluteUrlIssue(cfg, path);
        if (cross)
            throw new RestError(cross, 0);
        url = path;
    }
    else {
        const rel = `${cfg.collection ? `${encodeURIComponent(cfg.collection)}/` : ''}${path.replace(/^\/+/, '')}`;
        const av = `${rel.includes('?') ? '&' : '?'}api-version=${API_VERSION}`;
        url = `${base}/${rel}${av}`;
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), cfg.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS);
    try {
        const res = await (cfg.fetchImpl ?? fetch)(url, {
            method: 'GET',
            headers: { Authorization: basicAuth(cfg.pat), Accept: 'application/octet-stream' },
            signal: controller.signal,
        });
        // 同 `request`：读取响应体期间**不**清超时（见该函数注释）。
        if (!res.ok) {
            const raw = await res.text().catch(() => '');
            throw parseErrorBody(res.status, raw);
        }
        const ab = await res.arrayBuffer();
        return {
            buffer: Buffer.from(ab),
            contentType: res.headers.get('content-type') ?? 'application/octet-stream',
            disposition: res.headers.get('content-disposition') ?? '',
        };
    }
    catch (e) {
        // `parseErrorBody` 抛出的 RestError 必须原样透传（它已带 HTTP 状态与业务码）。
        if (e instanceof RestError)
            throw e;
        throw wrapTransportError(e, cfg);
    }
    finally {
        clearTimeout(timer);
    }
}
/**
 * 把 fetch 阶段的异常归一为 `RestError`，并**区分超时与真实网络故障**（2026-10-05 修复）。
 *
 * 为什么必须区分：`AbortController` 触发的超时与真实的 `fetch failed`（DNS/连接被拒）
 * 原先都落进同一条 `网络错误：…` 文案、status 都是 0。用户看到"网络错误"会去查网络，
 * 而真实原因往往是 TFS 慢或响应体过大 —— 排查方向被带偏。
 *
 * 判据：优先看 `AbortController` 是否真的被我们自己的定时器打断（`timedOut` 标记），
 * 退化到 `err.name === 'AbortError'`（宿主 fetch 可能在 abort 前先 reject）。
 *
 * @param e - 捕获到的异常。
 * @param cfg - 当前 REST 配置（取超时值以给出可执行提示）。
 * @returns 归一后的 `RestError`。
 */
function wrapTransportError(e, cfg) {
    if (e instanceof RestError)
        return e;
    const raw = e instanceof Error ? e.message : String(e);
    const scrubbed = scrubCredentials(raw);
    // BodyTimeoutError 是 undici 对"响应体读取超时"的命名；AbortError 是标准 abort 标记。
    const timedOut = e instanceof Error && (e.name === 'AbortError' || e.name === 'BodyTimeoutError');
    if (timedOut) {
        const secs = Math.round((cfg.timeoutMs ?? DEFAULT_REST_TIMEOUT_MS) / 1000);
        return new RestError(`请求超时（${secs}s）：TFS 响应过慢或响应体过大，请缩小查询范围后重试`, 0, 'TIMEOUT');
    }
    return new RestError(`网络错误：${scrubbed}`, 0);
}
/** 响应头里的分页游标（TFS 2018 列表端点的续取令牌）。 */
export const CONTINUATION_HEADER = 'x-ms-continuationtoken';
/** 单页最大条数（与各端点原有的 `$top` 一致，避免改动既有端点语义）。 */
const PAGE_LIMIT = 500;
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
export async function collectPaged(fetchPage, opts) {
    const maxPages = opts?.maxPages ?? 50;
    const out = [];
    let token;
    let skip = 0;
    for (let page = 0; page < maxPages; page++) {
        const got = await fetchPage({ $skip: skip, ...(token ? { continuationToken: token } : {}) });
        out.push(...got.items);
        const next = got.nextToken?.trim();
        if (!next)
            return out;
        token = next;
        skip += got.items.length;
        if (got.items.length === 0)
            return out;
    }
    return out;
}
/** 创建 REST 读客户端。 */
export function createRestRead(cfg) {
    const enc = encodeURIComponent;
    return {
        /**
         * `GET /_apis/projects?$top=500&$skip=N` + 游标翻页。
         *
         * 原实现一次 `$top=1000` 收工，超过 1000 的部署会静默少列项目（而项目清单是
         * WIQL `[System.TeamProject]` 校验与下拉选项的唯一来源）。
         */
        async listProjects() {
            return collectPaged(async ({ $skip, continuationToken }) => {
                let next = '';
                const j = await request(cfg, 'GET', `/_apis/projects?$top=${PAGE_LIMIT}&$skip=${$skip}`, {
                    ...(continuationToken ? { continuationToken } : {}),
                    captureHeaders: h => {
                        next = h?.get(CONTINUATION_HEADER) ?? '';
                    },
                });
                return {
                    items: Array.isArray(j?.value) ? j.value : [],
                    ...(next ? { nextToken: next } : {}),
                };
            });
        },
        async queryWiql(query) {
            const j = await request(cfg, 'POST', '/_apis/wit/wiql', { body: { query } });
            // TFS 直接返回空数组（对比旧 tfs-mcp 的 "items is not iterable" 伪错——REST 无此问题）。
            return Array.isArray(j?.workItems) ? j.workItems : [];
        },
        async getWorkItems(ids, fields) {
            const f = fields?.length
                ? `&fields=${fields.map(enc).join(',')}`
                : '';
            const j = await request(cfg, 'GET', `/_apis/wit/workitems?ids=${ids.map(String).join(',')}${f}`);
            return Array.isArray(j?.value) ? j.value : [];
        },
        async getWorkItem(id, fields) {
            const f = fields?.length ? `?fields=${fields.map(enc).join(',')}` : '';
            return request(cfg, 'GET', `/_apis/wit/workitems/${id}${f}`);
        },
        async listWorkItemTypes(project) {
            const j = await request(cfg, 'GET', `/${enc(project)}/_apis/wit/workitemtypes`);
            const rows = Array.isArray(j?.value) ? j.value : [];
            return rows.map(r => (typeof r?.name === 'string' ? r.name : '')).filter(n => n.length > 0);
        },
        async listStates(project, type) {
            // ⚠️ 必须用 4.1-preview（4.1 返回 400 VssInvalidPreviewVersionException，实测）。
            const j = await request(cfg, 'GET', `/${enc(project)}/_apis/wit/workitemtypes/${enc(type)}/states`, { apiVersion: API_VERSION_PREVIEW });
            const rows = Array.isArray(j?.value) ? j.value : [];
            return rows.map(r => (typeof r?.name === 'string' ? r.name : '')).filter(n => n.length > 0);
        },
        async whoAmI() {
            // ⚠️ 不带 api-version（带 4.1 会 400，实测）。身份只存在于 providerDisplayName /
            // authorizedUser.properties.Account（displayName/uniqueName 是 undefined）。
            const j = await request(cfg, 'GET', '/_apis/connectionData', { apiVersion: false });
            const au = (j['authorizedUser'] ?? {});
            const props = (au['properties'] ?? {});
            const account = (props['Account'] ?? {});
            return {
                account: typeof account['$value'] === 'string' ? account['$value'] : undefined,
                displayName: typeof au['providerDisplayName'] === 'string'
                    ? au['providerDisplayName']
                    : typeof j['authenticatedUser'] === 'object' && j['authenticatedUser'] !== null
                        ? j['authenticatedUser']['providerDisplayName']
                        : undefined,
                instanceId: typeof j['instanceId'] === 'string' ? j['instanceId'] : undefined,
            };
        },
        async getJson(path, init) {
            // 逃逸舱口：TFVC 等扩展端点用。apiVersion 缺省为 4.1（`false` 则完全不带）。
            //
            // ⚠️ 必须**透传字符串**（2026-10-05 修复）：原实现只处理 `apiVersion === false`，
            // 传 `'4.1-preview'` 会被**无声忽略**并实际发出 `api-version=4.1` ——
            // 而某些端点（`workitemtypes/{type}/states`）在 4.1 下返回 400，
            // 失败原因里却完全看不出"版本被丢弃"这一层，排查成本极高。
            // 语义与同文件的 `serverGetJson` / `postJson` 对齐（`undefined` = 用缺省）。
            return request(cfg, 'GET', path, {
                ...(init?.apiVersion === undefined ? {} : { apiVersion: init.apiVersion }),
                ...(init?.continuationToken ? { continuationToken: init.continuationToken } : {}),
                ...(init?.captureHeaders ? { captureHeaders: init.captureHeaders } : {}),
            });
        },
        async serverGetJson(path, apiVersion) {
            // 服务器级端点（集合清单等）：不拼集合段。
            const av = apiVersion === undefined ? {} : { apiVersion };
            return request(cfg, 'GET', path, { serverLevel: true, ...av });
        },
        async postJson(path, body, apiVersion) {
            const av = apiVersion === undefined ? {} : { apiVersion };
            return request(cfg, 'POST', path, { body, ...av });
        },
        async getBlob(path, absolute = false) {
            return requestBlob(cfg, path, absolute);
        },
    };
}
/**
 * 组装带 rev 乐观并发的 PATCH 体（D7）。
 *
 * rev 已知时首条插 `{"op":"test","path":"/rev","value":rev}`（实测：test 成功不递增 rev，
 * 冲突返回 412 + VS403351）；rev 未知时直接用业务操作（服务端仍按最后写入者胜）。
 */
export function buildPatchOps(ops, rev) {
    if (typeof rev === 'number' && Number.isFinite(rev) && rev > 0) {
        return [{ op: 'test', path: '/rev', value: rev }, ...ops];
    }
    return ops;
}
/** 创建 REST 写客户端。 */
export function createRestWrite(cfg) {
    const enc = encodeURIComponent;
    return {
        async updateWorkItem(id, ops, rev) {
            // ⚠️ api-version=4.1（7.1 → 404，实测）。Content-Type 必须是 json-patch+json。
            return request(cfg, 'PATCH', `/_apis/wit/workitems/${id}`, { body: buildPatchOps(ops, rev), contentType: 'application/json-patch+json' });
        },
        async createWorkItem(project, type, ops) {
            // TFS 的创建端点路径 = /{collection}/{project}/_apis/wit/workitems/{type}。
            // project 是**项目名**（不是集合）：这里用 project 临时覆盖 cfg.collection 段 ——
            // 实测 create 端点的第一段既接受集合、也接受项目（按项目作用域时自动限定）。
            // 参照官方形态 POST https://dev.azure.com/{org}/{project}/_apis/wit/workitems/${type}。
            const scoped = { ...cfg, collection: project };
            return request(scoped, 'POST', `/_apis/wit/workitems/$${enc(type)}`, { body: ops, contentType: 'application/json-patch+json' });
        },
        async postJsonWithType(path, body, contentType) {
            // 通用 JSON POST：Git PR 创建/评论等。Content-Type 默认 application/json。
            return request(cfg, 'POST', path, {
                body,
                contentType: contentType ?? 'application/json',
            });
        },
        async uploadAttachment(path, buffer) {
            // 附件上传：path 已带 ?uploadFile=true&fileName=xxx；体为原始字节。
            return request(cfg, 'POST', path, {
                body: buffer,
                contentType: 'application/octet-stream',
            });
        },
    };
}
//# sourceMappingURL=rest-client.js.map
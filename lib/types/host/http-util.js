/**
 * 宿主半 HTTP 工具（Phase 3，本地实现，不依赖宿主包）。
 *
 * 提供路由处理函数共用的三件事：读 JSON body（带体积上限，防滥用）、发 JSON、发错误。
 * 形态对齐 dsh-optimized-prompt/src/http-util.ts（该插件实测可用）。
 *
 * @module dsh-tfs-requirment/host/http-util
 */
/** 请求体体积上限（字节）。回写/派发的 body 都很小，512KB 足够。 */
export const MAX_BODY_BYTES = 512 * 1024;
/**
 * 读取并解析 JSON 请求体，带体积上限。
 * @param req - 传入请求。
 * @returns 解析结果（ok / 错误原因）。
 */
export function readJsonBody(req) {
    return new Promise(resolve => {
        let size = 0;
        const chunks = [];
        let aborted = false;
        req.on('data', (chunk) => {
            if (aborted)
                return;
            size += chunk.length;
            if (size > MAX_BODY_BYTES) {
                aborted = true;
                resolve({ ok: false, error: 'too_large' });
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => {
            if (aborted)
                return;
            const raw = Buffer.concat(chunks).toString('utf-8');
            if (raw.length === 0) {
                resolve({ ok: true, value: undefined });
                return;
            }
            try {
                resolve({ ok: true, value: JSON.parse(raw) });
            }
            catch {
                resolve({ ok: false, error: 'bad_json' });
            }
        });
        req.on('error', () => {
            if (!aborted)
                resolve({ ok: false, error: 'bad_json' });
        });
        // ⚠️ 必须监听 `aborted` / `close`（2026-10-05 修复）：客户端在**发送 body 途中**断连时，
        // Node 不保证派发 `error`，只可能派发这两个事件。此前只监听 data/end/error，
        // 该情形下这个 promise 永远不 resolve ⇒ handler 永不响应（客户端只能等浏览器超时），
        // 且 `web-guard` 的错误边界也救不了（它等的是 handler 返回，handler 根本没返回）。
        // `aborted` 是服务端确认的客户端中断；`close` 兜住"连接消失但没派发 aborted"的形态。
        //
        // 错误码沿用既有的 `bad_json`（不新增 `aborted`）：调用方一律回 400 且**不会**真写响应
        // （连接已断，写了也白写），新增码只会让 8 处 `body.error === 'too_large' ? 413 : 400`
        // 的三元表达式全部需要跟着改，收益为零。
        const onClientGone = () => {
            if (aborted)
                return;
            aborted = true;
            resolve({ ok: false, error: 'bad_json' });
        };
        req.on('aborted', onClientGone);
        req.on('close', () => {
            // `close` 在正常读完 body 后也会触发；此时已 resolve，重复 resolve 无副作用，
            // 但用 `aborted` 标记会让正常路径也置位，故先判断是否已收过尾。
            if (!req.complete)
                onClientGone();
        });
    });
}
/**
 * 发送 JSON 响应。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 任意可序列化对象。
 */
export function sendJson(res, status, body) {
    if (res.writableEnded)
        return;
    const payload = JSON.stringify(body);
    res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
    });
    res.end(payload);
}
/**
 * 发送错误响应。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param message - 可读说明。
 */
export function sendError(res, status, message) {
    sendJson(res, status, { error: message });
}
//# sourceMappingURL=http-util.js.map
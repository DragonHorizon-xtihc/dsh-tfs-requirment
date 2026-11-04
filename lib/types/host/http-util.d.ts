/**
 * 宿主半 HTTP 工具（Phase 3，本地实现，不依赖宿主包）。
 *
 * 提供路由处理函数共用的三件事：读 JSON body（带体积上限，防滥用）、发 JSON、发错误。
 * 形态对齐 dsh-optimized-prompt/src/http-util.ts（该插件实测可用）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/http-util
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
/** 请求体体积上限（字节）。回写/派发的 body 都很小，512KB 足够。 */
export declare const MAX_BODY_BYTES: number;
/** readJsonBody 的结果。 */
export type ReadBodyResult = {
    readonly ok: true;
    readonly value: unknown;
} | {
    readonly ok: false;
    readonly error: 'too_large' | 'bad_json';
};
/**
 * 读取并解析 JSON 请求体，带体积上限。
 * @param req - 传入请求。
 * @returns 解析结果（ok / 错误原因）。
 */
export declare function readJsonBody(req: IncomingMessage): Promise<ReadBodyResult>;
/**
 * 发送 JSON 响应。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param body - 任意可序列化对象。
 */
export declare function sendJson(res: ServerResponse, status: number, body: unknown): void;
/**
 * 发送错误响应。
 * @param res - 响应对象。
 * @param status - HTTP 状态码。
 * @param message - 可读说明。
 */
export declare function sendError(res: ServerResponse, status: number, message: string): void;
//# sourceMappingURL=http-util.d.ts.map
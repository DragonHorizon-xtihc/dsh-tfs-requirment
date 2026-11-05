/**
 * 「子会话对话」资源地址的编解码（US4 / AC4.5）。
 *
 * ## 格式来源（已核实，不臆造）
 *
 * 宿主 `ui-subagent` 的侧边对话（`packages/client/ui-subagent/src/client/sidebar-chat/index.tsx:21,51-89`）：
 *
 * ```
 * dsh-resource://subagentchat/session/<encodeURIComponent(childSessionId)>?parent=<parentSessionId>&mode=<mode>
 * ```
 *
 * `mode` 只接受 `one-shot` / `continuable` / `unknown` 三个字面量（同文件 `:76`）。
 *
 * ## 为什么不直接 import 宿主的 `subagentChatAddress`
 *
 * 客户端半只能 require `PLATFORM_MODULES`
 * （`packages/client/web/src/platform.ts:8-14`），其中**没有** `@deepseek-ai/dsh-subagent/client`，
 * 也没有 `ui-subagent`。故本模块按已核实的格式自行实现（纯字符串处理，可单测），
 * 与宿主实现**格式对齐**而非共享代码。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/chat-address
 */
/** 宿主侧边对话的资源协议前缀（`ui-subagent/.../sidebar-chat/index.tsx:21`）。 */
export const SUBAGENT_CHAT_ADDRESS = 'dsh-resource://subagentchat/session/';
/**
 * 构造子会话对话地址。
 *
 * @param address - 会话三元组。
 * @returns 规范地址；父会话 id 为空时返回空串（地址不可用，调用方应降级而不是造一个坏地址）。
 */
export function buildChatAddress(address) {
    const child = (address.childSessionId ?? '').trim();
    const parent = (address.parentSessionId ?? '').trim();
    if (!child || !parent)
        return '';
    const query = new URLSearchParams({ parent, mode: address.mode });
    return `${SUBAGENT_CHAT_ADDRESS}${encodeURIComponent(child)}?${query}`;
}
/**
 * 解析子会话对话地址。
 *
 * @param value - 候选地址。
 * @returns 解析成功返回三元组；非本协议的其它资源地址 / 缺参 / mode 非法一律返回 undefined。
 */
export function parseChatAddress(value) {
    if (typeof value !== 'string' || value.length === 0)
        return undefined;
    let url;
    try {
        url = new URL(value);
    }
    catch {
        return undefined;
    }
    if (url.protocol !== 'dsh-resource:' || url.hostname.toLowerCase() !== 'subagentchat')
        return undefined;
    const parts = url.pathname.split('/').filter(Boolean);
    if (parts.length !== 2 || parts[0] !== 'session')
        return undefined;
    const parentSessionId = url.searchParams.get('parent');
    const mode = url.searchParams.get('mode');
    if (!parentSessionId)
        return undefined;
    if (mode !== 'one-shot' && mode !== 'continuable' && mode !== 'unknown')
        return undefined;
    let childSessionId;
    try {
        childSessionId = decodeURIComponent(parts[1]);
    }
    catch {
        return undefined;
    }
    if (!childSessionId)
        return undefined;
    return { childSessionId, parentSessionId, mode };
}
//# sourceMappingURL=chat-address.js.map
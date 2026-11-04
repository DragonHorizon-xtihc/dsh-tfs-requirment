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
 * @module dsh-tfs-requirment/shared/chat-address
 */
/** 宿主侧边对话的资源协议前缀（`ui-subagent/.../sidebar-chat/index.tsx:21`）。 */
export declare const SUBAGENT_CHAT_ADDRESS = "dsh-resource://subagentchat/session/";
/** 子会话模式（宿主 `SubagentAddress.mode` 的三个字面量）。 */
export type ChatSessionMode = 'one-shot' | 'continuable' | 'unknown';
/** 构成一个子会话对话地址所需的三元组。 */
export interface ChatSessionAddress {
    /** 子会话 id（编排主 agent = 其 continuable childId；任务子 agent = attempt.runId）。 */
    childSessionId: string;
    /** 直接父会话 id（编排会话与任务子会话的父都是发起派发的那个宿主会话）。 */
    parentSessionId: string;
    /** 子会话模式。 */
    mode: ChatSessionMode;
}
/**
 * 构造子会话对话地址。
 *
 * @param address - 会话三元组。
 * @returns 规范地址；父会话 id 为空时返回空串（地址不可用，调用方应降级而不是造一个坏地址）。
 */
export declare function buildChatAddress(address: ChatSessionAddress): string;
/**
 * 解析子会话对话地址。
 *
 * @param value - 候选地址。
 * @returns 解析成功返回三元组；非本协议的其它资源地址 / 缺参 / mode 非法一律返回 undefined。
 */
export declare function parseChatAddress(value: string): ChatSessionAddress | undefined;
//# sourceMappingURL=chat-address.d.ts.map
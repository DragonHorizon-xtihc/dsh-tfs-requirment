/**
 * 模型下拉值的 (LLM 供应商, 模型 id) 编解码与分组纯函数（spec 009 US1）。
 *
 * ## 为什么需要复合值
 *
 * `DshModelOption.id` 只在**单个 provider 内**唯一（contracts 已注明
 * "id 全局唯一性由 provider + id 保证"）。本机 `deepseek-v4-flash` 同时被
 * 火山方舟（arkcode）与 deepseek-official 暴露，`glm-5-3-flash`/`qwen3.7-plus`
 * 等也存在跨供应商重名。若 `<option value={m.id}>` 只存裸 id，用户在
 * 「火山方舟」分组下选中的模型与其它分组下同名项提交值完全相同，供应商信息在
 * 点击瞬间丢失——子 agent 随后继承父聊天会话的供应商（本机现场即英伟达），
 * 造成"选火山方舟、跑英伟达"。
 *
 * 本模块是客户端半与宿主半共用的**唯一值语义收口**：
 *   - option value 用 JSON 复合值（provider/id 中允许出现 `/`、`-` 等字符也不歧义）；
 *   - 解码容错：任何非本模块编码的值（含历史裸 id）都安全返回 undefined 或走旧值兼容；
 *   - 不依赖 node / React，可在客户端半直接 import。
 *
 * @module dsh-tfs-requirment/shared/model-route
 */
import type { DshModelOption } from './contracts.js';
/** 模型下拉的一个分组（同 provider 的模型，组内按 id 去重）。 */
export interface ModelOptionGroup {
    /** LLM 供应商路由 key。 */
    provider: string;
    /** 供应商展示名（缺省回落路由 key）。 */
    providerName: string;
    /** 该供应商下的模型（保持目录顺序，组内按 id 去重）。 */
    items: DshModelOption[];
}
/**
 * 把 `(provider, id)` 编码为模型下拉 option 的 value。
 * @returns JSON 复合值，形如 `{"p":"arkcode","i":"deepseek-v4-flash"}`。
 */
export declare function modelOptionValue(provider: string, id: string): string;
/**
 * 解码 {@link modelOptionValue} 复合值。
 * @returns 供应商与模型 id；非法 JSON / 字段缺失 / 空 id 时返回 undefined。
 */
export declare function parseModelOptionValue(value: string | undefined | null): {
    provider: string;
    id: string;
} | undefined;
/**
 * 把扁平模型目录按 provider 分组；**同一 provider 内按 id 去重**，
 * 跨 provider 的同名模型保留为不同分组下的独立选项（这是与旧
 * RoleSettings.buildModelItems 跨 provider 去重的本质区别）。
 *
 * @param options - 宿主下发的模型目录。
 * @returns 分组列表，保持 provider 与模型在目录中的首次出现顺序。
 */
export declare function groupModelOptions(options: readonly DshModelOption[] | undefined | null): ModelOptionGroup[];
/** 精确查找某个 `(provider, id)` 模型项。 */
export declare function findModelOption(options: readonly DshModelOption[] | undefined | null, provider: string, id: string): DshModelOption | undefined;
/**
 * 解码下拉当前值的**宽容版**：复合值正常解析；历史裸 id（spec 009 之前落盘/缓存的值）
 * 回落为 `{ provider: '', id }`，provider 空串即"未绑定供应商，沿用父会话供应商"的旧语义。
 *
 * 与 {@link parseModelOptionValue} 的分工：后者严格（非法即 undefined，供
 * {@link modelValueExists} 判断"值是否仍在目录中"）；本函数供提交/展示侧把任何
 * 非空值都解释成一条模型路由。
 *
 * @returns 空值返回 undefined；裸 id 返回 provider 为空串的路由。
 */
export declare function decodeModelValue(value: string | undefined | null): {
    provider: string;
    id: string;
} | undefined;
/**
 * 判断下拉当前值在目录中是否仍存在（目录重采后已选供应商/模型可能消失）。
 * 复合值存在即有效；裸值（历史数据）交调用方按旧值兼容处理。
 */
export declare function modelValueExists(options: readonly DshModelOption[] | undefined | null, value: string): boolean;
/** 供应商展示名：providerName → provider 路由 key → 空串。 */
export declare function providerLabel(options: readonly DshModelOption[] | undefined | null, provider: string | undefined): string;
/**
 * 渲染「供应商 / 模型」的统一展示文案。
 * @param options - 模型目录（用于把路由 key 翻译成展示名）。
 * @param model - 模型 id。
 * @param modelProvider - 供应商路由 key（缺省=未绑定，沿用父会话供应商）。
 */
export declare function formatModelRoute(options: readonly DshModelOption[] | undefined | null, model: string | undefined, modelProvider?: string): string;
//# sourceMappingURL=model-route.d.ts.map
/**
 * 会话事件 → 执行时间线条目的纯映射（spec 006 US2）。
 *
 * 为什么是纯函数：`sessionQuery.observeSession` 返回的 `SessionEvent[]` 形态来自宿主
 * `@deepseek-ai/dsh-session`（见 research.md 的词表），把"事件 → UI 时间线"的转换抽成**不依赖
 * 宿主/ node** 的纯函数，既能在单测里用合成事件穷举配对/截断/异常形态，也让客户端半与宿主半
 * 对同一份契约（`TaskTraceEntry`）理解一致。本文件只 import 共享类型。
 *
 * 防御式取数：宿主事件是 merge-extensible 的判别联合，且冷读日志可能缺头少尾，故这里全部按
 * `unknown` 读取、逐字段判型，任何非预期形态都**跳过而不抛错**（绝不能因为一条怪事件让整个
 * 任务详情白屏）。
 *
 * @module dsh-tfs-requirment/host/trace-mapper
 */
import type { TaskTraceEntry, TaskTraceStats, TraceToolKind } from '../shared/contracts.js';
/** 单段文本（user/assistant/工具结果）的最大字符数，超出截断（避免超大工具输出灌爆 HTTP/UI）。 */
export declare const MAX_TEXT_CHARS = 2000;
/** 工具入参原始 JSON 的最大字符数。 */
export declare const MAX_ARGS_CHARS = 1500;
/** 时间线条目上限；超出后保留开头（含首轮指令）+ 最近的尾部。 */
export declare const MAX_ENTRIES = 400;
/** 超上限时保留的开头条目数。 */
export declare const KEEP_HEAD = 20;
/**
 * 截断并加省略号。
 *
 * 切点按码点对齐：`String.prototype.slice` 按 UTF-16 码元计数，正好切在高代理项上会把一个
 * 字符劈成两半，页面上显示为替换符（U+FFFD），emoji 与增补平面汉字都会中招。
 *
 * @param text - 待截断的原文。
 * @param max - 保留的最大字符数；不超过时原样返回。
 * @returns 最长 `max` 个字符的前缀加上省略说明（总长取原文的 `text.length`）。
 */
export declare function truncate(text: string, max: number): string;
/** 按工具全名判定类别：MCP（mcp__server__tool）/ 技能 / 普通工具。 */
export declare function classifyTool(name: string): TraceToolKind;
/**
 * 从消息 content 块里防御式抽取可读文本。
 * 处理：字符串、TextBlock（type:'text'）、以及 ToolResultBlock 内嵌的 content（递归一层）。
 * 忽略 reasoning/image/file/tool-call 等非文本块（它们各自有专门事件或不适合文本时间线）。
 */
export declare function blocksToText(content: unknown): string;
/**
 * 从消息 content 块里防御式抽取**思考 / reasoning**文本（type:'reasoning' 块）。
 *
 * 与 {@link blocksToText} 刻意分开：可见文本与内部思考是两条通道，混在一起会让"模型在想什么"
 * 灌进正文。子 agent 执行中常只产出 reasoning + tool-call（无可见文本），正是旧时间线"只剩工具"
 * 的根因——这里把思考单独取出，交给 UI 折叠展示。
 */
export declare function blocksToReasoning(content: unknown): string;
export interface MapTraceResult {
    entries: TaskTraceEntry[];
    /** 是否因超过上限而丢弃过中间条目。 */
    truncated: boolean;
    /** 截断前映射出的条目总数（UI 据此提示"共 N 条"）。 */
    total: number;
    /** 最后事件 seq（游标）。 */
    cursor?: number;
}
/**
 * 把会话事件数组映射为时间线条目（按 seq 升序）。
 * @param rawEvents - `SessionObservation.events`（元素为 SessionEvent 信封 `{type,seq,time,data}`）。
 */
export declare function mapTraceEvents(rawEvents: readonly unknown[]): MapTraceResult;
/**
 * 从**完整会话事件**聚合一次任务执行的统计（问题 2，对标 dsh-context 的上下文统计）。
 *
 * 与 {@link mapTraceEvents} 独立：时间线可能为防灌爆而截断，但统计必须全量，故这里直接遍历
 * 原始事件，不复用截断后的 entries。所有取数防御式判型，怪事件跳过不抛。
 *
 * 计数口径：
 *   - 模型请求 = `step/start` 数（一次模型思考 + 其工具执行）；日志无该事件时降级为助手消息数；
 *   - 工具调用 = `tool/call` 数，按 MCP / 技能 / 普通工具分类，并以"同名 + 同入参"识别重复请求；
 *   - token = 各步 `assistant/message.message.usage` 之和；total 按供应商计费口径
 *         = 未缓存 input + 缓存读 + 缓存写 + output（reasoning 已含在 output 内，不重复加）。
 *
 * @param rawEvents - `SessionObservation.events`（元素为 SessionEvent 信封）。
 */
export declare function summarizeTrace(rawEvents: readonly unknown[]): TaskTraceStats;
/**
 * 从复用 continuable 子会话的全部事件中，切出**某一轮（turn）**的事件（D6）。
 *
 * 复用子会话被多个任务顺序复用，整段会话含多轮；本函数以 `turn/start`、`turn/end` 的 seq
 * 为边界切片，使一次任务的轨迹与统计只反映本轮，不混入其它任务。
 *
 * 降级（冷读日志截断 / 事件形态缺失）：
 * - 找不到本 turn 的 `turn/start` 时，退而保留所有 `data.turn===turn` 的事件；
 * - 若连这也没有（无法判定），原样返回全部事件（旧行为），避免轨迹空白。
 *
 * @param rawEvents - observeSession 返回的完整事件。
 * @param turn - 本轮 turn 序号。
 */
export declare function filterEventsForTurn(rawEvents: readonly unknown[], turn: number): readonly unknown[];
//# sourceMappingURL=trace-mapper.d.ts.map
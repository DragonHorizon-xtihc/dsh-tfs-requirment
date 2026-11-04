/**
 * 任务执行协议（宿主半 / 客户端半共享的纯逻辑，无 node / 宿主依赖）。
 *
 * 集中定义三件事，供派发 prompt 组装与结果收口共用，避免"协议字符串散落在多处、对不上"：
 *
 * 1. **执行预算与终止纪律**（问题 1）：{@link buildExecBudgetSection} 拼进每个子任务 prompt，
 *    约束子智能体不做计划外工作、不重复请求、不无限派生子智能体，从源头压低 token 与请求次数；
 * 2. **人工确认协议**（问题 5）：子智能体需要人工拍板时必须在结尾输出
 *    `NEEDS_HUMAN_CONFIRM: …`，收口由 {@link detectOutcome} 判为 `needs_confirmation`
 *    （而非"已完成"），任务停在待确认、不自动进入下游；
 * 3. **关键产物清单**（问题 4）：子智能体在结尾用 `ARTIFACTS:` 段给出要归档的文件绝对路径，
 *    由 {@link parseArtifactPaths} 解析后上传为需求附件。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/exec-protocol
 */
/** 收口判定的三态：成功 / 失败 / 待人工确认（问题 5）。 */
export type ExecOutcome = 'success' | 'failed' | 'needs_confirmation';
/** 任务正常完成时，子智能体最终回复最后一行需输出的标记。 */
export declare const TASK_DONE_MARKER = "TASK_DONE";
/** 任务需要人工确认/决定时，子智能体最终回复最后一行需输出的标记前缀（冒号后接原因）。 */
export declare const NEEDS_HUMAN_CONFIRM_MARKER = "NEEDS_HUMAN_CONFIRM";
/** 关键产物清单段头：其后每行一个文件绝对路径。 */
export declare const ARTIFACTS_HEADER = "ARTIFACTS:";
/**
 * 输出中是否包含显式 `NEEDS_HUMAN_CONFIRM:` 标记（最高可信度）。
 * @param output - 子智能体最终输出文本。
 */
export declare function hasExplicitConfirmMarker(output: string): boolean;
/**
 * 在输出中查找兜底的"请求人工确认"短语（仅结论窗口、排除否定语境）。
 * @returns 命中的匹配（含位置与文本），未命中返回 undefined。
 */
export declare function findConfirmPhrase(output: string): {
    index: number;
    text: string;
} | undefined;
/**
 * 判定一次子 run 的收口结果（问题 5 的核心）。
 *
 * 口径：
 *   - stopReason ≠ 'completed' → `failed`（模型/传输错误、拒绝、超 token、中止）；
 *   - completed 但输出要求人工确认（显式标记或结论窗口兜底短语）→ `needs_confirmation`；
 *   - 其余 completed → `success`。
 *
 * 旧实现只看 stopReason（`mapStopReasonToOutcome`），于是"模型正常结束、但结论是请人工确认"
 * 被误判为成功，任务直接完成、自动进入下游。本函数补上"看输出内容"这一维。
 *
 * @param stopReason - 子 run 落定原因。
 * @param output - 子智能体最终输出文本（已抽取/截断均可）。
 */
export declare function detectOutcome(stopReason: string | undefined, output: string | undefined): ExecOutcome;
/**
 * 抽取"需要人工确认的具体内容"，用于任务备注与 UI 展示。
 *
 * 优先取显式标记 `NEEDS_HUMAN_CONFIRM: <原因>`（冒号后到行尾，或其后连续的缩进行）；
 * 兜底取结论窗口中命中短语所在的整行。结果限长，避免把整篇输出塞进备注。
 * @param output - 子智能体最终输出文本。
 * @param maxLen - 返回文本上限（默认 300 字）。
 */
export declare function extractHumanConfirmReason(output: string | undefined, maxLen?: number): string;
/**
 * 从最终输出的 `ARTIFACTS:` 段解析关键产物的**绝对路径**（问题 4）。
 *
 * 规则（保守，宁缺毋滥）：
 *   - 只解析 `ARTIFACTS:` 之后、到空行或下一个 `全大写:` 段头之间的行；
 *   - 去掉列表符号（`-`/`*`/数字编号）、反引号、尖括号、行内说明（空格后的中文备注保留前半段路径）；
 *   - 仅保留绝对路径（POSIX `/...` 或 Windows `X:\\...`）；相对路径/文件名一律忽略；
 *   - 去重、保序。无法识别该段时返回空数组（不猜测文件，避免误传）。
 *
 * @param output - 子智能体最终输出文本。
 */
export declare function parseArtifactPaths(output: string | undefined): string[];
/**
 * 生成拼入每个子任务 prompt 的「执行预算与终止纪律」段（问题 1 / 问题 4 / 问题 5 共用）。
 *
 * 纯文本、无副作用；调用方把它接在任务正文之后。预算取值仅用于**告知**子智能体委派深度，
 * 真正的硬限制（maxDepth / maxTokens / 运行看门狗）由宿主在派发参数层强制，双保险。
 *
 * @param budget - 当前生效的委派深度（maxDepth）；传 0/undefined 表示不限制（提示语相应弱化）。
 */
export declare function buildExecBudgetSection(budget?: {
    maxDepth?: number;
}): string;
//# sourceMappingURL=exec-protocol.d.ts.map
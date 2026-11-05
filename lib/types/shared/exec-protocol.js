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
/** 任务正常完成时，子智能体最终回复最后一行需输出的标记。 */
export const TASK_DONE_MARKER = 'TASK_DONE';
/** 任务需要人工确认/决定时，子智能体最终回复最后一行需输出的标记前缀（冒号后接原因）。 */
export const NEEDS_HUMAN_CONFIRM_MARKER = 'NEEDS_HUMAN_CONFIRM';
/** 关键产物清单段头：其后每行一个文件绝对路径。 */
export const ARTIFACTS_HEADER = 'ARTIFACTS:';
/** 兜底"待人工确认"语义时，只在最终输出末尾这么多字符的"结论窗口"内匹配，避免误判正文举例。 */
const CONFIRM_TAIL_WINDOW = 600;
/**
 * 强"请求人工确认"短语（兜底识别，防止模型不遵守显式标记）。
 * 仅匹配祈使/请求语气；"无需人工确认"这类否定语境由 {@link isNegatedAround} 排除。
 */
const CONFIRM_PHRASES = [
    /请\s*人工\s*(确认|确定|审核|审查|核对|核验|验收|介入|判断|拍板|决定)/,
    /请\s*用户\s*人工\s*(确认|确定|审核|验收)/,
    /等待\s*人工\s*(确认|确定|审核|审查|验收)/,
    /待\s*人工\s*(确认|确定|审核|审查|验收)/,
    /需要\s*人工\s*(确认|确定|审核|审查|验收|介入|判断|拍板|决定)/,
    /需\s*人工\s*(确认|确定|审核|审查|验收)/,
    /请\s*等待\s*人工/,
    /请\s*相关人员\s*(确认|确定|审核|验收)/,
];
/** 命中短语前若紧邻这些否定词，则不算"请求人工确认"（如"该步骤无需人工确认"）。 */
const NEGATION_WORDS = ['无需', '不需要', '不用', '无须', '不必', '免去', '免除', '不再需要', '无', '不', '勿', '别', '非'];
/** 判断命中位置前一小段是否为否定语境。 */
function isNegatedAround(text, index) {
    // 短语可能从"需/需要"起匹配，使其前方只剩一个否定字（如"无需人工确认"命中在第二个字"需"，
    // 其前仅"无"；"不需要人工确认"命中在"需要"，其前仅"不"），故窗口取 8、收录单字否定，并用 endsWith 贴边判定。
    const before = text.slice(Math.max(0, index - 8), index);
    return NEGATION_WORDS.some(w => before.endsWith(w));
}
/**
 * 在**结论窗口**内查找行首的显式 `NEEDS_HUMAN_CONFIRM:` 标记。
 *
 * 两个约束缺一不可：
 *  - **行首**：协议要求标记独占一行的行首（见 {@link buildExecBudgetSection} 第 6 条）。
 *    此前只做 `marker\s*[:：]` 的全文匹配，于是子智能体只要在正文里**谈论**这个协议
 *    （"本任务无需人工确认；按协议本应输出 NEEDS_HUMAN_CONFIRM: …"）就被判成
 *    `needs_confirmation`，任务卡在待确认且没有任何东西会推进它。
 *  - **结论窗口**（{@link CONFIRM_TAIL_WINDOW}）：与兜底短语同一口径，标记只出现在
 *    早期正文里说明"先前某轮曾请求过确认"时不应按本轮结论处理。
 *
 * @param output - 子智能体最终输出文本。
 * @returns 命中的行首标记（含位置与冒号后的原因），未命中返回 undefined。
 */
function findExplicitConfirmMarker(output) {
    if (!output)
        return undefined;
    const re = new RegExp(`^[ \\t]*${NEEDS_HUMAN_CONFIRM_MARKER}\\s*[:：][ \\t]*(.*)$`, 'm');
    let from = 0;
    for (;;) {
        const m = re.exec(output.slice(from));
        if (!m || m.index === undefined)
            return undefined;
        const index = from + m.index;
        // 只认落在结论窗口内的标记（窗口按全文末尾对齐）。
        if (index >= output.length - CONFIRM_TAIL_WINDOW) {
            return { index, reason: m[1]?.trim() ?? '' };
        }
        from = index + 1;
    }
}
/**
 * 输出中是否包含显式 `NEEDS_HUMAN_CONFIRM:` 标记（最高可信度）。
 * @param output - 子智能体最终输出文本。
 */
export function hasExplicitConfirmMarker(output) {
    return findExplicitConfirmMarker(output) !== undefined;
}
/**
 * 在输出中查找兜底的"请求人工确认"短语（仅结论窗口、排除否定语境）。
 * @returns 命中的匹配（含位置与文本），未命中返回 undefined。
 */
export function findConfirmPhrase(output) {
    if (!output)
        return undefined;
    const tail = output.slice(-CONFIRM_TAIL_WINDOW);
    const offset = output.length - tail.length;
    for (const re of CONFIRM_PHRASES) {
        const m = tail.match(re);
        if (m && m.index !== undefined) {
            const index = offset + m.index;
            if (isNegatedAround(output, index))
                continue;
            return { index, text: m[0] };
        }
    }
    return undefined;
}
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
/**
 * 输出里是否有「任务已实质交付」的证据（2026-11-04）。
 *
 * ## 为什么要引入这一维
 *
 * 协议第 6 条让子智能体只要报告里存在"必须人工确认后才能继续的事项"就输出
 * `NEEDS_HUMAN_CONFIRM`。真实工程任务几乎总有这类遗留项（真机桌面端补测、TFS
 * 状态流转、写门禁确认），于是模型在**已经交付完整报告与产物**后仍会输出该标记。
 * 旧判据见标记就判 `needs_confirmation`，任务停在「待确认」，自动扫尾反复续跑，
 * 最终主 agent 兜底无产出时把任务收口成 `failed` —— 表现为「所有子 Agent 完成后
 * 都被标记失败」（真机 2059017：7 次 attempt 里 3 次 needs_confirmation、
 * 1 次 sweep-main-agent-empty，只有人工确认才落 success）。
 *
 * 因此区分两种语义：
 *   - **有交付证据**（TASK_DONE 独占一行，或 ARTIFACTS 段里有真实绝对路径）⇒
 *     任务已经干完，末尾的确认请求只是**非阻塞遗留项**，按 `success` 收口并写进备注；
 *   - **无交付证据、纯粹在等人拍板** ⇒ 才是真正的 `needs_confirmation`。
 *
 * 判据刻意保守：只认协议里两个"我交付了"的强信号，不靠长度或标题猜。
 *
 * @param output - 子智能体最终输出文本。
 */
export function hasDeliveredArtifacts(output) {
    const text = output ?? '';
    if (!text)
        return false;
    // 1) 完成标记必须独占一行（正文里提到 "TASK_DONE" 这个词不算）。
    if (new RegExp(`^[ \\t]*${TASK_DONE_MARKER}[ \\t]*$`, 'm').test(text))
        return true;
    // 2) ARTIFACTS: 段里至少一条真实绝对路径 —— 说明活干完并落了产物。
    return parseArtifactPaths(text).length > 0;
}
/**
 * 评估一次子 run 的收口结果（在 {@link detectOutcome} 的三态之上补充遗留项备注）。
 *
 * 口径：
 *   - stopReason ≠ 'completed' → `failed`；
 *   - completed + 请求人工确认 + **有交付证据** → `success` + `deferredNote`
 *     （任务已完成，遗留项不阻塞，写进备注供人查看）；
 *   - completed + 请求人工确认 + 无交付证据 → `needs_confirmation`（真的卡住等人）；
 *   - 其余 completed → `success`。
 */
export function assessOutcome(stopReason, output) {
    if (stopReason !== 'completed')
        return { outcome: 'failed' };
    const text = output ?? '';
    const confirmation = hasExplicitConfirmMarker(text) || findConfirmPhrase(text) !== undefined;
    if (!confirmation)
        return { outcome: 'success' };
    if (!hasDeliveredArtifacts(text))
        return { outcome: 'needs_confirmation' };
    const reason = extractHumanConfirmReason(text, 200);
    return {
        outcome: 'success',
        deferredNote: `任务已交付；下列遗留项需人工补做（不阻塞本次完成）：${reason}`,
    };
}
/** 判定一次子 run 的收口结果（{@link assessOutcome} 的三态视图）。 */
export function detectOutcome(stopReason, output) {
    return assessOutcome(stopReason, output).outcome;
}
/**
 * 抽取"需要人工确认的具体内容"，用于任务备注与 UI 展示。
 *
 * 优先取显式标记 `NEEDS_HUMAN_CONFIRM: <原因>`（冒号后到行尾，或其后连续的缩进行）；
 * 兜底取结论窗口中命中短语所在的整行。结果限长，避免把整篇输出塞进备注。
 * @param output - 子智能体最终输出文本。
 * @param maxLen - 返回文本上限（默认 300 字）。
 */
export function extractHumanConfirmReason(output, maxLen = 300) {
    const text = output ?? '';
    if (!text)
        return '子智能体请求人工确认（未给出具体原因）';
    const explicit = findExplicitConfirmMarker(text);
    if (explicit) {
        // 取标记所在行冒号后的内容；若为空，继续吃后续以空白/列表符号开头的行。
        let reason = explicit.reason;
        if (!reason) {
            const after = text.slice(explicit.index);
            const following = after.split('\n').slice(1, 4).map(l => l.trim()).filter(Boolean);
            reason = following.join('；');
        }
        if (reason)
            return reason.length > maxLen ? `${reason.slice(0, maxLen)}…` : reason;
    }
    const hit = findConfirmPhrase(text);
    if (hit) {
        const lineStart = text.lastIndexOf('\n', hit.index) + 1;
        let lineEnd = text.indexOf('\n', hit.index);
        if (lineEnd === -1)
            lineEnd = text.length;
        const line = text.slice(lineStart, lineEnd).trim();
        if (line)
            return line.length > maxLen ? `${line.slice(0, maxLen)}…` : line;
        return hit.text;
    }
    return '子智能体请求人工确认（未给出具体原因）';
}
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
export function parseArtifactPaths(output) {
    const text = output ?? '';
    const lines = text.split('\n');
    // 段头必须**行首**出现。此前用 `includes` 定位，于是正文里"如下格式：ARTIFACTS:"
    // 这样一句说明也会被当成段头，解析从说明的下一行散文开始，一路吃到第一个空行 ——
    // 结果要么什么都没有，要么把散文里提到的绝对路径当成产物上传成需求附件，
    // 与本函数"宁缺毋滥 / 无法识别该段时返回空数组"的约定相反。
    const startIdx = lines.findIndex(l => {
        const trimmed = l.trim();
        return trimmed === ARTIFACTS_HEADER || trimmed.startsWith(ARTIFACTS_HEADER);
    });
    if (startIdx === -1)
        return [];
    const paths = [];
    const seen = new Set();
    for (let i = startIdx + 1; i < lines.length; i++) {
        const raw = lines[i]?.trim() ?? '';
        // 空行结束本段落。
        if (!raw)
            break;
        // 遇到完成标记（子 agent 按协议把 TASK_DONE 放在最后单独一行，无冒号）结束本段落。
        if (raw === TASK_DONE_MARKER || raw.startsWith(`${TASK_DONE_MARKER} `))
            break;
        // 遇到下一个"全大写单词:"段头（如 NOTES:）结束。
        if (/^[A-Z_]{2,}\s*:/.test(raw) && !/^[A-Za-z]:[\\/]/.test(raw))
            break;
        // 同一行可能是 "- C:\\path\\file.doc 说明文字"：路径不含空格时取首段；含空格路径尽量保留到常见扩展名。
        let candidate = raw
            .replace(/^[-*•]\s*/, '')
            .replace(/^\d+[.)、]\s*/, '')
            .replace(/^[`"'<]+/, '')
            .replace(/[`"'>]+$/, '')
            .trim();
        // 抽取绝对路径（Windows 盘符 或 POSIX 根）。
        const win = candidate.match(/^([A-Za-z]:[\\/][^\s"'`]*)/);
        const posix = candidate.match(/^(\/[^\s"'`]*)/);
        const matched = win?.[1] ?? posix?.[1];
        if (!matched)
            continue;
        const clean = matched.replace(/[.,;，。；、)]+$/, '');
        if (clean && !seen.has(clean)) {
            seen.add(clean);
            paths.push(clean);
        }
    }
    return paths;
}
/**
 * 生成拼入每个子任务 prompt 的「执行预算与终止纪律」段（问题 1 / 问题 4 / 问题 5 共用）。
 *
 * 纯文本、无副作用；调用方把它接在任务正文之后。预算取值仅用于**告知**子智能体委派深度，
 * 真正的硬限制（maxDepth / maxTokens / 运行看门狗）由宿主在派发参数层强制，双保险。
 *
 * @param budget - 当前生效的委派深度（maxDepth）；传 0/undefined 表示不限制（提示语相应弱化）。
 */
export function buildExecBudgetSection(budget) {
    const depth = typeof budget?.maxDepth === 'number' && budget.maxDepth >= 1 ? budget.maxDepth : 0;
    const depthLine = depth >= 1
        ? `4. 委派受限：你最多只能向下委派 ${depth} 层子任务；本任务默认**不要再派生新的子智能体**，能在本会话内直接完成的就自己完成，避免层层放大开销。`
        : '4. 委派克制：尽量不要向下派生新的子智能体，能在本会话内直接完成的就自己完成，避免层层放大开销。';
    return [
        '【执行纪律（务必严格遵守：控制开销、避免空转、避免重复请求）】',
        '1. 目标导向：只完成本任务明确要求的工作，达到目标立即停止；不要做计划外的扩展、重构、全面调研或反复试探。',
        '2. 禁止重复请求：同一工具以完全相同的参数只允许调用一次，已经拿到的结果必须直接复用；不得重复读取同一个文件、同一条工作项或同一接口的相同内容。先用好已有上下文，再决定是否需要新的调用。',
        '3. 批量优先：能用一次查询/一次批量调用取得的信息，不要逐条多次请求（例如优先用一条 WIQL 取多条工作项，而不是逐条拉取）；调用前先想清楚要哪些字段，避免反复补取。',
        depthLine,
        '5. 简洁输出：回复聚焦结论与必要依据，不要逐字复述工具返回的大段内容，不要输出无意义的过程寒暄。',
        '6. 完成 / 人工确认协议（最重要，关系到流程能否正确流转）：',
        `   - 任务确已完成：在最终回复的**最后单独一行**输出 ${TASK_DONE_MARKER}。若还有非阻塞的遗留事项（真机环境补测、TFS 状态流转、人工后续验收等），**仍按已完成收口**，在报告里单列「遗留事项」说明即可，不要因此改用 ${NEEDS_HUMAN_CONFIRM_MARKER}。`,
        `   - 仅当任务**无法继续**、必须人先拍板才能往下做（需求口径未定、关键方案需人认可、写门禁拦住且无人确认）时，才不得当作已完成：在最终回复的**最后单独一行**输出`,
        `     ${NEEDS_HUMAN_CONFIRM_MARKER}: 需要人工确认/决定的具体内容`,
        '     系统会把任务停在「待人工确认」，不会自动进入下一个任务；人工确认通过后才继续。',
        `7. 关键产物归档：若本任务产出了需要归档到需求的文件（方案/报告/补丁/截图等），在最终回复中用如下段落列出其**真实存在的绝对路径**，每行一个，只列与本需求相关的关键产物、不要罗列依赖目录或无关文件：`,
        `${ARTIFACTS_HEADER}`,
        '- /绝对路径/产物文件',
    ].join('\n');
}
//# sourceMappingURL=exec-protocol.js.map
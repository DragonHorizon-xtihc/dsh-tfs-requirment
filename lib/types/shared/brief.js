/**
 * 需求级「共享简报」（brief）—— 同一条需求下所有子 agent 复用的上下文（US3 / AC3.1）。
 *
 * ## 为什么需要它（"重复造轮"的结构性根因）
 *
 * 派发链路此前是 **ONE-SHOT + 每段 prompt 各自拼**：每个任务子 agent 都从零收到
 * 「工作目录 + 需求提示词全文 + 本任务正文 + 执行纪律」，于是它会**各自**重新读一遍需求正文、
 * 重新探索一遍代码库、重新判断一遍要改哪些文件。N 个任务 = N 份重复理解，且相互之间
 * **没有任何结论传递**（前序任务踩过的坑、定下的方案，下一个完全不知道）。
 *
 * 简报把"这条需求我们已经知道的东西"沉淀成**一份需求级事实**，随任务推进**增量更新**：
 *
 *   - 需求摘要 `digest`：只在**第一个**任务（尚无 digest）时把需求正文全文发出去，
 *     之后一律只发摘要 ⇒ 正文全文不再重复进 prompt（AC3.2）；
 *   - 已完成任务结论 `conclusions`：有序、限长，替代"每个人都自己重新读代码"；
 *   - 产物清单 `artifacts`：已产出的绝对路径，避免下游任务重复产出同一份东西；
 *   - 已绑定工具 `tools`（MCP + 技能）：取自角色冻结配置，显式写进 prompt，
 *     并附"优先使用已绑定工具"的硬要求（AC5.2）。
 *
 * ## 为什么放在 `shared/`
 *
 * 组装与解析是**纯逻辑**，且宿主半（组装 prompt / 落盘）与客户端半（面板展示简报）
 * 都要用同一口径。组件层没有渲染测试手段，规则写进 JSX 就只能靠人眼保证（项目既有纪律）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/brief
 */
import { ARTIFACTS_HEADER, NEEDS_HUMAN_CONFIRM_MARKER, TASK_DONE_MARKER } from './exec-protocol.js';
import { truncateText } from './text.js';
/** 结论摘要的字数上限（超过截断；避免简报把 prompt 撑爆）。 */
export const CONCLUSION_MAX_CHARS = 300;
/** 需求摘要的字数上限。 */
export const DIGEST_MAX_CHARS = 1500;
/** 简报里保留的结论条数上限（超出丢弃**最早**的，保留最近的上下文）。 */
export const CONCLUSION_MAX_ENTRIES = 30;
/** 产物清单条数上限。 */
export const ARTIFACT_MAX_ENTRIES = 50;
/** 简报段的段头（收口时据此判断"是否已注入简报"）。 */
export const BRIEF_HEADER = '【共享简报（本需求已确认的事实，直接复用，不要重复推导）】';
/** 主 agent 归纳回复里的结论段头。 */
export const SUMMARY_HEADER = 'SUMMARY:';
/** 当前时间 ISO（抽成参数便于测试注入）。 */
function nowIso(now) {
    if (typeof now === 'string')
        return now;
    if (typeof now === 'function')
        return now();
    return new Date().toISOString();
}
/**
 * 创建空简报。
 *
 * @param requirementKey - 需求去重键。
 * @param title - 需求标题。
 * @param input - 可选初值（工作目录 / 已绑定工具）。
 * @param now - 时间注入（测试用）。
 * @returns 新简报。
 */
export function emptyBrief(requirementKey, title, input = {}, now) {
    return {
        requirementKey,
        title,
        ...(input.workspace ? { workspace: input.workspace } : {}),
        conclusions: [],
        artifacts: [],
        tools: { mcp: input.tools?.mcp ?? [], skills: input.tools?.skills ?? [] },
        updatedAt: nowIso(now),
    };
}
/**
 * 写入/覆盖一条任务结论（幂等：同 taskId 覆盖而非追加）。
 *
 * 为什么按 `taskId` 幂等：同一任务可能重试（`followUpTask`）或重复收口，
 * 追加会让简报里出现同一任务的两条互相矛盾的结论。
 *
 * @param brief - 原简报（不修改入参）。
 * @param entry - 结论条目。
 * @param now - 时间注入。
 * @returns 新简报。
 */
export function upsertConclusion(brief, entry, now) {
    const next = { ...brief, conclusions: [...brief.conclusions], artifacts: [...brief.artifacts] };
    const idx = next.conclusions.findIndex(c => c.taskId === entry.taskId);
    const normalized = {
        taskId: entry.taskId,
        title: entry.title,
        summary: truncateText(entry.summary, CONCLUSION_MAX_CHARS),
        ...(entry.artifacts && entry.artifacts.length > 0 ? { artifacts: entry.artifacts } : {}),
    };
    if (idx >= 0)
        next.conclusions[idx] = normalized;
    else
        next.conclusions.push(normalized);
    // 超限丢弃**最早**的：最近的上下文对下游更有用。
    if (next.conclusions.length > CONCLUSION_MAX_ENTRIES) {
        next.conclusions = next.conclusions.slice(next.conclusions.length - CONCLUSION_MAX_ENTRIES);
    }
    next.updatedAt = nowIso(now);
    return next;
}
/**
 * 合并产物路径（去重、保序、限条数）。
 *
 * @param brief - 原简报。
 * @param paths - 新增产物绝对路径。
 * @param now - 时间注入。
 * @returns 新简报。
 */
export function mergeArtifacts(brief, paths, now) {
    if (paths.length === 0)
        return brief;
    const next = { ...brief, artifacts: [...brief.artifacts] };
    for (const p of paths) {
        if (!p)
            continue;
        if (!next.artifacts.includes(p))
            next.artifacts.push(p);
    }
    if (next.artifacts.length > ARTIFACT_MAX_ENTRIES) {
        next.artifacts = next.artifacts.slice(next.artifacts.length - ARTIFACT_MAX_ENTRIES);
    }
    next.updatedAt = nowIso(now);
    return next;
}
/**
 * 从需求自带的正文段落生成初始摘要种子（spec 010）。
 *
 * ## 为什么需要它
 *
 * 共享简报要"替代需求正文全文"，但**第一条任务还没有任何 AI 归纳**可用。
 * 若此时摘要为空，简报段会退化为「需求提示词全文」，第 2 个任务起才生效 —— 省得不够干净。
 * 需求正文（`description` / 需求分析 / 数据结构 / 需求配置）本来就以纯文本躺在
 * `board.json` 里，直接截断拼成种子即可，无需额外一轮模型调用（那才是真浪费 token）。
 *
 * 注意它**不是** `Requirement.prompt`（用户填的"需求提示词"）：两者用途不同，
 * 摘要只承载"这条需求要做什么"，执行约束仍由需求提示词在首个任务里下发一次。
 *
 * @param input - 需求正文段落。
 * @returns 摘要种子；全部为空时返回空串。
 */
export function buildDigestSeed(input) {
    const parts = [];
    const push = (label, text) => {
        const t = (text ?? '').trim();
        if (t)
            parts.push(`${label}：${t}`);
    };
    push('需求正文', input.description);
    push('需求分析', input.analysis);
    push('数据结构', input.dataStructure);
    push('需求配置', input.config);
    if (parts.length === 0)
        return '';
    return truncateText(parts.join('\n'), DIGEST_MAX_CHARS);
}
/**
 * 设置需求摘要（首次由主 agent 生成；空串视为"未生成"）。
 *
 * @param brief - 原简报。
 * @param digest - 摘要正文。
 * @param now - 时间注入。
 * @returns 新简报。
 */
export function setDigest(brief, digest, now) {
    const text = (digest ?? '').trim();
    if (!text)
        return brief;
    return { ...brief, digest: truncateText(text, DIGEST_MAX_CHARS), updatedAt: nowIso(now) };
}
/**
 * 渲染派发 prompt 里的【共享简报】段。
 *
 * @param brief - 需求级简报。
 * @param input - 渲染输入。
 * @returns prompt 文本；`brief` 无任何可用内容且无兜底正文时返回空串（不产出噪声）。
 */
export function buildBriefSection(brief, input = {}) {
    const lines = [];
    lines.push(BRIEF_HEADER);
    lines.push(`需求：${brief.title}（${brief.requirementKey}）`);
    if (brief.workspace)
        lines.push(`工作目录：${brief.workspace}（一切读写都在这里，见上方【工作目录】硬约束）`);
    // 摘要优先：一旦有了摘要，需求正文全文**不再**下发（这是"不重复造轮"的核心断言）。
    const digest = (brief.digest ?? '').trim();
    if (digest) {
        lines.push('');
        lines.push('【需求已确认的理解（直接采用，不要重新通读需求原文）】');
        lines.push(digest);
    }
    else if (input.requirementPrompt && input.requirementPrompt.trim()) {
        lines.push('');
        lines.push('【需求提示词（本需求首个任务：请顺带在结论里给出一份 ≤1500 字的需求理解摘要）】');
        lines.push(input.requirementPrompt.trim());
    }
    if (brief.conclusions.length > 0) {
        lines.push('');
        lines.push('【已完成任务及其结论（直接复用其结论与产出，不要重复实现、不要重复排查）】');
        for (const c of brief.conclusions) {
            lines.push(`- ${c.title}：${c.summary}`);
            if (c.artifacts && c.artifacts.length > 0)
                lines.push(`  产物：${c.artifacts.join('、')}`);
        }
    }
    const mcp = input.mcp ?? brief.tools.mcp;
    const skills = input.skills ?? brief.tools.skills;
    if ((mcp && mcp.length > 0) || (skills && skills.length > 0)) {
        lines.push('');
        lines.push('【已绑定工具（优先使用，不要自行寻找替代方案）】');
        if (mcp && mcp.length > 0)
            lines.push(`- 已启用 MCP：${mcp.join('、')}`);
        if (skills && skills.length > 0)
            lines.push(`- 已启用技能：${skills.join('、')}`);
        lines.push('- 这些就是本需求可用的全部外部能力；不要假设存在其它 MCP server 或工具，需要的能力缺失时直接上报。');
    }
    if (brief.artifacts.length > 0) {
        lines.push('');
        lines.push(`【已产出产物（不要重复生成）】${brief.artifacts.join('、')}`);
    }
    // 只有段头 + 需求行的空简报没有信息量，不产出。
    if (lines.length <= 2)
        return '';
    return lines.join('\n');
}
/**
 * 构造发给**编排主 agent** 的"任务已收口，请归纳"请求（US2 / AC2.2）。
 *
 * 明确要求输出 `SUMMARY:` 段并限长：不限长的主 agent 抒情会把简报撑爆，
 * 反而让下游任务读更多 token —— 与"省 token"的目标背道而驰。
 *
 * @param input - 任务与输出信息。
 * @returns 发给主 agent 的消息正文。
 */
export function buildSummarizePrompt(input) {
    const lines = [];
    lines.push(`【编排通知】需求 ${input.requirementKey} 的任务已收口，请归纳。`);
    lines.push('');
    lines.push(`任务：${input.title}（${input.taskId}）`);
    lines.push('');
    lines.push('该任务的最终输出：');
    lines.push(input.output && input.output.trim() ? input.output.trim() : '（无输出）');
    if (input.artifacts && input.artifacts.length > 0) {
        lines.push('');
        lines.push(`产物：${input.artifacts.join('、')}`);
    }
    lines.push('');
    lines.push('请输出：');
    lines.push(`1. 第一行起一段 \`${SUMMARY_HEADER}\`，其后给出**不超过 ${CONCLUSION_MAX_CHARS} 字**的结论：`);
    lines.push('   改了什么、结论是什么、有哪些需要注意的坑（三句话以内，写给下一个要接着干活的智能体看）。');
    lines.push('2. 不要复述任务过程，不要输出寒暄，不要重复粘贴上面的原始输出。');
    if (input.hasNext)
        lines.push('3. 归纳完成后不要自行派发下一个任务，等待系统放行。');
    return lines.join('\n');
}
/**
 * 构造发给编排主 agent 的"全部完成，请出最终总结"请求（US2 / AC2.4）。
 *
 * @param input - 需求与任务清单。
 * @returns 发给主 agent 的消息正文。
 */
export function buildFinalSummaryPrompt(input) {
    const lines = [];
    lines.push(`【编排通知】需求 ${input.requirementKey}（${input.title}）的全部任务已完成，请出最终总结。`);
    lines.push('');
    lines.push('各任务结论：');
    for (const t of input.tasks) {
        lines.push(`- ${t.title}${t.summary ? `：${t.summary}` : ''}`);
    }
    lines.push('');
    lines.push('请输出一段**面向需求评审人**的总结（不超过 800 字），包含：');
    lines.push('1. 本次改造达成了什么（对应需求目标）；');
    lines.push('2. 关键改动与影响面（文件/模块级别即可，不要逐行列代码）；');
    lines.push('3. 遗留问题与后续建议（没有就写"无"）。');
    lines.push('');
    lines.push(`不要输出 ${TASK_DONE_MARKER} 或 ${NEEDS_HUMAN_CONFIRM_MARKER} 标记（流程已结束，无人等待你的确认）。`);
    return lines.join('\n');
}
/**
 * 从主 agent 的回复里抽取结论摘要（US2 / AC2.2）。
 *
 * 优先级：
 *   1. 显式 `SUMMARY:` 段（冒号后到下一个全大写段头/结尾）；
 *   2. 去掉协议标记后的正文（截断到上限）。
 *
 * @param text - 主 agent 的最终输出。
 * @returns 结论摘要；输出为空时返回空串（调用方据此判"无摘要"）。
 */
export function parseOrchestratorSummary(text) {
    const raw = (text ?? '').trim();
    if (!raw)
        return '';
    // 只匹配"段头所在行"，段头后的正文一律从**下一行**开始取：
    // 若在这里用 `\s*`，它会把行尾换行一起吃掉，导致第一行正文被当成段头的一部分丢掉。
    const header = new RegExp(`^${SUMMARY_HEADER}[ \\t]*$`, 'im').exec(raw);
    if (header) {
        const after = raw.slice(header.index + header[0].length);
        // 段结束：空行、或遇到下一个"全大写单词:"段头。
        const endIdx = after.search(/\n\s*\n|\n[A-Z_]{2,}\s*:/);
        const body = (endIdx === -1 ? after : after.slice(0, endIdx)).trim();
        if (body)
            return truncateText(body, CONCLUSION_MAX_CHARS);
    }
    const cleaned = stripProtocolMarkers(raw);
    return cleaned ? truncateText(cleaned, CONCLUSION_MAX_CHARS) : '';
}
/**
 * 去掉执行协议标记行（`TASK_DONE` / `NEEDS_HUMAN_CONFIRM` / `ARTIFACTS:` 段），
 * 只留下可当结论用的正文。
 *
 * @param text - 原始输出。
 * @returns 清洗后的文本。
 */
export function stripProtocolMarkers(text) {
    const lines = text.split('\n');
    const kept = [];
    let inArtifacts = false;
    for (const line of lines) {
        const t = line.trim();
        if (t === TASK_DONE_MARKER || t.startsWith(`${TASK_DONE_MARKER} `))
            continue;
        if (new RegExp(`^${NEEDS_HUMAN_CONFIRM_MARKER}\\s*[:：]`).test(t))
            continue;
        if (t.startsWith(ARTIFACTS_HEADER)) {
            inArtifacts = true;
            continue;
        }
        if (inArtifacts) {
            if (!t)
                inArtifacts = false;
            continue;
        }
        kept.push(line);
    }
    return kept.join('\n').trim();
}
//# sourceMappingURL=brief.js.map
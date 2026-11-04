/**
 * 「所选技能 / MCP / 工作流」的**强制执行**计划（纯逻辑，宿主半与客户端半共享）。
 *
 * ## 为什么需要这个模块（2026-10-29 用户诉求 3 / 4）
 *
 * 面板里的「技能」「MCP」选择此前只是**写在冻结快照里**：派发时它们只被拼进简报的一句
 * 提示（「已绑定工具：…」），子 agent 完全可以不加载技能、不调用任何 MCP 工具。
 * 根因是宿主**没有** per-child 工具限制通道：
 *
 *   - `SubagentStartRequest`（`packages/subagent/subagent/src/types.ts:170-221`）
 *     只有 `cwd/label/prompt/parent/signal/agentOptions/agentPreset/outputSchema/maxDepth`；
 *     插件旧实现传的 `toolFilter` / `persona` **根本不在类型里**（tsc 直接报
 *     `TS2353: 'toolFilter' does not exist in type 'SubagentStartRequest'`）。
 *   - `ctx.tools.restrict()` 明确要求 **scoped（agent.ctx）** 上下文
 *     （`packages/core/tools/src/index.ts:1108`），宿主半根上下文调用会抛错；
 *     唯一调用点 `child-agent.ts:217` 只在**冷恢复**时按历史 descriptor 重放限制。
 *
 * 因此本插件能做的"强制"只有两条，且两条都做：
 *
 *   1. **下发**：把所选技能的正文（`ctx.skills.get(name).content`）与所选 MCP 的**真实工具名**
 *      （`ctx.tools.schemas()` 里 `mcp__<server>__*`）整段写进子 agent 的首条 prompt，
 *      并附可验收的执行纪律（工作流逐步勾选、每步产出）。
 *   2. **验收**：任务落定后从子会话事件里读 `tool/call`，核对"技能是否被加载""每个所选
 *      MCP 是否至少被调用一次""工作流步骤是否逐步报告"。不达标不静默通过，而是收口为
 *      「待人工确认」并写清缺了哪一项。
 *
 * 纯函数（无 node/DOM 依赖）以便客户端半复用文案与步骤解析、并在单测里直接驱动。
 *
 * @module dsh-tfs-requirment/shared/capability-plan
 */
/** 默认技能调用工具名（`packages/skill/tool-skill/src/index.ts:83`）。 */
export const DEFAULT_SKILL_TOOL = 'skill';
/** 识别"像步骤的标题"的正则族（按序尝试；命中即算一步）。 */
const STEP_HEADING_PATTERNS = [
    // `## Phase 1: 编码实现` / `### Step 0.0b: 校验上游` / `## Stage 2`
    /^#{2,4}\s*(?:[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\s*)?(?:phase|stage|step)\s*([0-9]+(?:\.[0-9]+)*[a-z]?)\b/iu,
    // `## 阶段 1：PM 需求分析` / `### 步骤 2 校验` / `## 环节 3`
    /^#{2,4}\s*(?:[\u{1F300}-\u{1FAFF}\u2600-\u27BF]\s*)?(?:阶段|步骤|环节)\s*([0-9]+(?:\.[0-9]+)*[a-z]?)/u,
    // `## 1. 需求分析` / `### 2.3 校验` / `## 1) 概览`
    /^#{2,4}\s*([0-9]+(?:\.[0-9]+){0,2})[.、)）]\s*\S/u,
];
/**
 * 去掉 YAML frontmatter（`---` 块）。
 *
 * 技能正文里的 frontmatter 是路由元数据（keywords/tags/requires_tools），
 * 对子 agent 是噪声；而 `requires_tools` 一类信息由本模块的 MCP 段单独表达。
 */
export function stripFrontmatter(content) {
    const text = content ?? '';
    if (!text.startsWith('---'))
        return text;
    const end = text.indexOf('\n---', 3);
    if (end < 0)
        return text;
    const after = text.indexOf('\n', end + 4);
    return after < 0 ? '' : text.slice(after + 1);
}
/**
 * 从技能正文解析**有序工作流步骤**（标题级）。
 *
 * 只认"像步骤"的 2–4 级标题（Phase/Stage/Step/阶段/步骤/环节 + 编号，或 `1.` 编号标题），
 * 因为技能正文普遍用 `## 流程总览`、`## 关键规则` 这类非步骤标题，全量标题当步骤会
 * 把"规则"也算成待执行步骤 —— 那种清单既不可执行，也会在验收时整片误判。
 *
 * @param content - 技能正文（可含 frontmatter）。
 * @returns 步骤标题清单（按正文顺序；少于 2 步时返回空数组，交由调用方按"整篇即流程"处理）。
 */
export function extractWorkflowSteps(content) {
    const body = stripFrontmatter(content);
    const lines = body.split(/\r?\n/);
    const steps = [];
    let inFence = false;
    for (const line of lines) {
        if (/^\s*```/.test(line)) {
            inFence = !inFence;
            continue;
        }
        if (inFence)
            continue;
        if (!/^#{2,4}\s/.test(line))
            continue;
        const hit = STEP_HEADING_PATTERNS.some(re => re.test(line));
        if (!hit)
            continue;
        const title = line
            .replace(/^#{2,4}\s*/, '')
            // 去掉标题里的 emoji / 装饰符号，保留可读文字。
            .replace(/[\u{1F300}-\u{1FAFF}\u2600-\u27BF\u2B00-\u2BFF]/gu, '')
            .replace(/\s+/g, ' ')
            .trim();
        if (title.length === 0)
            continue;
        if (steps.includes(title))
            continue;
        steps.push(title);
    }
    return steps.length >= 2 ? steps : [];
}
/** 步骤勾选标记的正则（子 agent 按纪律输出的 `✅ 步骤 1/5 …` / `步骤 1/5`）。 */
const STEP_MARK_PATTERN = /(?:✅|✔|☑)?\s*(?:步骤|step)\s*(\d+)\s*\/\s*(\d+)/gi;
/**
 * 整体完成标记（2026-11-03 问题 4）：`工作流：xxx（已完成 2/2 步）` / `已完成 2/2 步`。
 *
 * 现场：子 agent 用"已完成 2/2 步"收尾而非逐步打 `✅ 步骤 i/N`，被 `STEP_MARK_PATTERN`
 * 漏读成"缺 2/2 步"误判。只认 **N/N 全完成**（两数相等且等于总步数）——
 * 部分进度（"已完成 1/3 步"）语义含糊（是序号还是比例），不猜。
 */
const STEP_AGGREGATE_PATTERN = /已完成\s*(\d+)\s*\/\s*(\d+)\s*步/g;
/**
 * 从子 agent 的最终输出里解析"已报告完成的步骤序号"。
 *
 * 纪律要求每条步骤完成后输出 `✅ 步骤 i/N：…`，因此这里以这种可机验的标记为准；
 * 另接受整段工作流"已完成 N/N 步"的全完成汇报（见 {@link STEP_AGGREGATE_PATTERN}）。
 * 不接受"我按流程做了"这类自然语言承诺。
 *
 * @param output - 最终助手输出文本。
 * @param total - 工作流总步数。
 * @returns 已报告的步骤序号（1-based，去重升序）。
 */
export function parseReportedSteps(output, total) {
    const seen = new Set();
    const text = output ?? '';
    STEP_MARK_PATTERN.lastIndex = 0;
    let m;
    while ((m = STEP_MARK_PATTERN.exec(text)) !== null) {
        const idx = Number(m[1]);
        if (!Number.isInteger(idx) || idx < 1)
            continue;
        if (total > 0 && idx > total)
            continue;
        seen.add(idx);
    }
    // 整体完成："已完成 N/N 步"（N = 总步数）⇒ 全部步骤计入。
    STEP_AGGREGATE_PATTERN.lastIndex = 0;
    while ((m = STEP_AGGREGATE_PATTERN.exec(text)) !== null) {
        const done = Number(m[1]);
        const all = Number(m[2]);
        if (!Number.isInteger(done) || !Number.isInteger(all))
            continue;
        if (done !== all)
            continue;
        if (total > 0 && all !== total)
            continue;
        for (let i = 1; i <= (total > 0 ? total : all); i += 1)
            seen.add(i);
    }
    return [...seen].sort((a, b) => a - b);
}
/** 从 `tool/call` 入参里尽量取出 `name` 字段（技能工具的参数通常是 `{name:"x"}`）。 */
function skillNameFromArgs(args) {
    const raw = (args ?? '').trim();
    if (!raw.startsWith('{'))
        return '';
    try {
        const parsed = JSON.parse(raw);
        const value = typeof parsed.name === 'string' ? parsed.name : typeof parsed.skill === 'string' ? parsed.skill : '';
        return value.trim();
    }
    catch {
        return '';
    }
}
/**
 * 验收一次执行是否真的用上了所选技能 / MCP / 工作流。
 *
 * 判定口径（与 {@link buildCapabilityPlanSection} 下发的纪律一一对应）：
 *   - **技能**：出现 `tool/call`，工具名为技能调用工具（默认 `skill`）且入参 `name` 命中技能名
 *     —— 若入参无法解析但技能正文已整篇下发，则退化为"该工具被调用过即算"（避免误杀）；
 *   - **MCP**：至少出现一次 `mcp__<server>__*` 的 `tool/call`；
 *   - **工作流**：最终输出里报告的步骤序号覆盖 1..N。
 *
 * 无任何要求时恒为 `ok: true`（不改变旧行为）。
 *
 * @param input.skills - 所选技能名。
 * @param input.mcp - 所选 MCP server 名。
 * @param input.workflowSteps - 工作流步骤（空 = 不校验步骤）。
 * @param input.toolCalls - 子会话的 `tool/call` 切片（读不到时传 undefined = 跳过验收）。
 * @param input.output - 子 agent 最终输出文本。
 * @param input.skillToolName - 技能调用工具名。
 * @returns 验收结果（不达标时带可读 note）。
 */
export function verifyCapabilityUsage(input) {
    const skills = [...new Set((input.skills ?? []).filter(s => typeof s === 'string' && s.trim().length > 0))];
    const mcp = [...new Set((input.mcp ?? []).filter(s => typeof s === 'string' && s.trim().length > 0))];
    const steps = input.workflowSteps ?? [];
    const skillTool = (input.skillToolName ?? DEFAULT_SKILL_TOOL).toLowerCase();
    const calls = input.toolCalls ?? [];
    // 事件不可读 ⇒ 没有证据可判，按通过处理（降级纪律：不因观测能力缺失误杀任务）。
    const observable = input.toolCalls !== undefined;
    /**
     * 子会话自述"MCP 工具未注入"。是否属实**必须用真实工具表核对**（2026-10-30 现场教训）：
     *   - `toolSurface` 里确实没有 `mcp__<server>__*` ⇒ 环境缺失（装配问题，模型所言属实）；
     *   - `toolSurface` 里**有** ⇒ 模型谎报/拒用（`mcpClaimedMissing`），按不诚信处理。
     * `toolSurface` 未提供（读不到会话请求头）时只能按自述归因，标记 `mcpNotInjected`。
     */
    const claimsNotInjected = /MCP 工具未注入|未注入本会话|未注入子会话|没有注入(?:这些)?工具/i.test(input.output);
    const surface = input.toolSurface;
    const surfaceHas = (server) => surface === undefined ? false : surface.some(name => name.startsWith(`mcp__${server}__`));
    const claimedButPresent = claimsNotInjected && surface !== undefined && mcp.some(surfaceHas);
    const mcpNotInjected = claimsNotInjected && !claimedButPresent;
    const mcpClaimedMissing = claimedButPresent;
    /**
     * 文本形态的伪工具调用（现场：最终输出是 5 段重复的 `<read>…</read>`，而不是真实
     * tool/call）—— 模型把工具调用写进了正文，实际一次工具都没执行。
     */
    const pseudoToolCalls = /<\/?(?:read|write|edit|bash|shell|glob|grep|search|todo)\b/i.test(input.output);
    /**
     * 技能使用判据（2026-11-03 问题 4 收紧）：技能正文由 `buildCapabilityPlanSection`
     * **整篇注入 prompt**（设计如此："即便子会话没有 skill 工具，它也已经拿到了技能内容"）。
     * 因此"未加载技能"不能只认 skill 工具的 `tool/call` —— dsh 子会话根本没有 skill 工具时，
     * 这种判据必然把正常完成的任务误判为 needs_confirmation（实机 2055202：5 次尝试全部
     * `stopReason=completed`、TASK_DONE，却因"未加载全部技能"连环重跑）。
     *
     * 收紧口径：只有当**技能工具确实存在**（真实工具表里有该工具，或会话里真调用过它）
     * 却没调到对应技能时才算未加载；技能工具不存在 / 无法证明存在 ⇒ 视为正文随 prompt 交付。
     */
    const isSkillToolName = (toolName) => toolName === skillTool || toolName.endsWith(`_${skillTool}`) || toolName.includes('skill');
    /** 工具表可读时按表判；不可读时退化为"会话里是否出现过技能调用"。 */
    const skillToolUsable = input.toolSurface === undefined
        ? calls.some(c => isSkillToolName((c.name ?? '').toLowerCase()))
        : input.toolSurface.some(n => isSkillToolName((n ?? '').toLowerCase()));
    const missingSkills = [];
    if (observable && skillToolUsable) {
        for (const name of skills) {
            const used = calls.some((call) => {
                const toolName = (call.name ?? '').toLowerCase();
                if (!isSkillToolName(toolName))
                    return false;
                const argName = skillNameFromArgs(call.args);
                return argName.length === 0 ? true : argName === name;
            });
            if (!used)
                missingSkills.push(name);
        }
    }
    const missingMcp = [];
    if (observable) {
        for (const server of mcp) {
            const prefix = `mcp__${server}__`;
            if (!calls.some(call => (call.name ?? '').startsWith(prefix)))
                missingMcp.push(server);
        }
    }
    const missingSteps = [];
    if (steps.length > 0) {
        const reported = new Set(parseReportedSteps(input.output, steps.length));
        for (let i = 1; i <= steps.length; i += 1) {
            if (!reported.has(i))
                missingSteps.push(i);
        }
    }
    const ok = missingSkills.length === 0 && missingMcp.length === 0 && missingSteps.length === 0;
    if (ok) {
        return {
            ok,
            missingSteps,
            missingSkills,
            missingMcp,
            // 只在为真时写键（与接口的可选语义一致，避免 false/undefined 两种假值并存）。
            ...(mcpNotInjected ? { mcpNotInjected: true } : {}),
            ...(mcpClaimedMissing ? { mcpClaimedMissing: true } : {}),
            ...(pseudoToolCalls ? { pseudoToolCalls: true } : {}),
        };
    }
    const parts = [];
    if (missingSkills.length > 0)
        parts.push(`未加载所选技能：${missingSkills.join('、')}`);
    if (missingMcp.length > 0) {
        if (mcpClaimedMissing) {
            parts.push(`所选 MCP 未被调用，且模型谎称"工具未注入"（真实工具表中存在 mcp__* 工具，属拒用/不诚信）：${missingMcp.join('、')}`);
        }
        else if (mcpNotInjected) {
            parts.push(`所选 MCP 未被调用（子会话未注入这些工具，属环境缺失）：${missingMcp.join('、')}`);
        }
        else {
            parts.push(`未调用所选 MCP 工具：${missingMcp.join('、')}`);
        }
    }
    if (missingSteps.length > 0) {
        const names = missingSteps.map(i => `${i}.${steps[i - 1] ?? ''}`).join('；');
        parts.push(`工作流未逐步执行（缺 ${missingSteps.length}/${steps.length} 步）：${names}`);
    }
    if (pseudoToolCalls) {
        parts.push('输出中出现文本形态的工具调用（如 <read>），并未真正调用工具——可能是模型 tool-call 格式漂移');
    }
    return {
        ok,
        missingSteps,
        missingSkills,
        missingMcp,
        ...(mcpNotInjected ? { mcpNotInjected: true } : {}),
        ...(mcpClaimedMissing ? { mcpClaimedMissing: true } : {}),
        ...(pseudoToolCalls ? { pseudoToolCalls: true } : {}),
        note: `未按要求使用所选能力：${parts.join('｜')}`,
    };
}
/**
 * 构造下发到子 agent 首条 prompt 的「强制执行」段。
 *
 * 段内三层信息，缺一层都会让"选了但没执行"重新变得不可追究：
 *   1. **必须调用的技能**：显式给出调用工具与名字，并整篇附上正文（即便子会话没有 `skill` 工具，
 *      它也已经拿到了技能内容，不能以"我不知道这个技能"为由跳过）；
 *   2. **必须使用的 MCP**：给出真实工具全名（从宿主注册表反推），而不是 server 名；
 *   3. **工作流**：逐步清单 + 可机验的勾选纪律（验收就按这个纪律读输出）。
 *
 * @param input - 计划输入。
 * @returns Markdown 段（无任何要求时返回空串，调用方 `filter(Boolean)`）。
 */
export function buildCapabilityPlanSection(input) {
    const skills = input.skills ?? [];
    const mcp = input.mcp ?? [];
    const unusableMcp = (input.unusableMcp ?? []).filter(s => typeof s === 'string' && s.length > 0);
    const workflow = input.workflow?.trim() ?? '';
    const steps = input.workflowSteps ?? [];
    const skillTool = input.skillToolName ?? DEFAULT_SKILL_TOOL;
    if (skills.length === 0 && mcp.length === 0 && unusableMcp.length === 0 && workflow.length === 0)
        return '';
    const blocks = ['【必须使用的技能与 MCP（强制执行，未使用即判本次执行不达标）】'];
    if (skills.length > 0) {
        blocks.push('', `必须加载并遵循的技能（先用 \`${skillTool}\` 工具逐个加载，name 必须完全一致）：`);
        for (const skill of skills) {
            const isWorkflow = workflow.length > 0 && skill.name === workflow;
            blocks.push(`- \`${skill.name}\`${isWorkflow ? '（本任务的工作流，见下方步骤清单）' : ''}`);
        }
        blocks.push('', '技能正文（能预载的已在此下发，按正文要求执行；正文与你的通用习惯冲突时以正文为准）：');
        for (const skill of skills) {
            const body = stripFrontmatter(skill.content).trim();
            blocks.push('', `──── 技能 ${skill.name} 开始 ────`);
            blocks.push(body.length > 0
                ? body
                : `（正文未能预载：必须先调用 \`${skillTool}\` 工具以 name="${skill.name}" 加载，再按加载到的正文执行）`);
            blocks.push(`──── 技能 ${skill.name} 结束 ────`);
        }
    }
    if (mcp.length > 0) {
        blocks.push('', '必须使用的 MCP 工具（每个 server 至少实际调用一次，用于完成本任务的实际工作；不得只声明不调用）：');
        for (const server of mcp) {
            const tools = server.tools.length > 0 ? server.tools.join('、') : `（该 server 当前未注册任何工具，需在结论中说明）`;
            blocks.push(`- \`${server.server}\`：${tools}`);
        }
        blocks.push('- **先看工具表再下结论**：这些工具在不在，以你本次请求随附的 tools 列表为准——'
            + '列表里有 `mcp__…` 就必须直接调用；**禁止**在未查工具表的情况下声称"未注入/不可用"（谎报按拒用处理）。', '- **工具未注入时怎么办**（现场事故教训）：只有当这些 `mcp__…` 工具**确实不在你的 tools 列表里**时，'
            + '才按环境问题处理，此时必须：'
            + '① 在最终结论里显式写明 `MCP 工具未注入：<server>名`；'
            + '② 用现有工具（bash 等）尽力完成核心工作；'
            + '③ **禁止**声称调用过、禁止伪造调用记录。', '- **凭据纪律（硬性）**：任何时候都**禁止**把 PAT / token / 密钥 / 连接串写入文件、脚本、命令行参数或仓库；'
            + '需要访问 TFS 就用 `mcp__tfs-mcp__*` 工具（凭据由 MCP 实例管理，不经过你）。'
            + '若你已在脚本里写过凭据，必须删除并在结论中说明残留位置。');
    }
    if (unusableMcp.length > 0) {
        blocks.push('', `注意：以下 MCP server 已被勾选但**当前不可用**（未启动 / 未注册任何工具），本任务无法使用它们：${unusableMcp.join('、')}。`
            + '请在最终结论中说明因此缺少了哪部分能力，不要假装调用过。');
    }
    if (workflow.length > 0) {
        blocks.push('', `【强制工作流：${workflow}】`);
        if (steps.length > 0) {
            blocks.push(`本任务的执行流程由技能 \`${workflow}\` 定义，共 ${steps.length} 步，必须**严格按顺序逐步执行**：`);
            steps.forEach((step, i) => blocks.push(`${i + 1}. ${step}`));
            blocks.push('', '执行纪律（违反任一条 = 本次任务不达标）：', `- 每一步开始时先输出一行：\`▶ 步骤 i/${steps.length}：<步骤名>\``, `- 每一步完成后输出一行：\`✅ 步骤 i/${steps.length}：<该步实际产出/结论>\``, `- **禁止跳过、合并、乱序执行任何步骤**。唯一例外：该步骤因缺依赖/工具报错确实无法执行 —— `
                + `此时必须输出 \`⏭ 步骤 i/${steps.length}：<具体原因>\`，并在最终结论里列出未完成步骤与阻塞原因。`, `- 最终回复必须包含完整勾选清单（\`✅ 步骤 i/${steps.length}\` 逐条出现），`
                + `以及 \`工作流：${workflow}（已完成 x/${steps.length} 步）\`。`, '- 步骤的判定以技能正文为准；本清单只用于排序与自检，不是对正文的替代。');
        }
        else {
            blocks.push(`本任务必须严格按技能 \`${workflow}\` 正文描述的流程执行，禁止跳步。`
                + '每一步开始时输出 `▶ 步骤 i/N：<名称>`，完成后输出 `✅ 步骤 i/N：<产出>`（N = 实际步数），'
                + '最终回复给出完整勾选清单与 `工作流：' + workflow + '（已完成 x/N 步）`。');
        }
    }
    return blocks.join('\n');
}
//# sourceMappingURL=capability-plan.js.map
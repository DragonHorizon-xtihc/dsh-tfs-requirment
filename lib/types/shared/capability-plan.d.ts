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
/** 一个技能正文（宿主 `ctx.skills.get()` 的结果切片）。 */
export interface CapabilitySkillBody {
    /** 技能名（与 `FrozenConfig.skills` 一致）。 */
    name: string;
    /** 去掉 frontmatter 后的 Markdown 正文。 */
    content: string;
}
/** 一个所选 MCP server 的真实工具全名（`mcp__<server>__<tool>`）。 */
export interface CapabilityMcpServer {
    /** server 名（与 `FrozenConfig.mcp` 一致）。 */
    server: string;
    /** 该 server 当前注册的工具全名。 */
    tools: string[];
}
/** 一次 `tool/call` 事件的切片（验收用）。 */
export interface ChildToolCall {
    /** 工具全名。 */
    name: string;
    /** 入参（JSON 字符串；解析失败按原文处理）。 */
    args: string;
}
/** 强制执行计划的输入。 */
export interface CapabilityPlanInput {
    /** 所选技能（已含正文；读不到的技能由调用方显式标记，见 {@link CapabilitySkillBody.content} 为空）。 */
    skills: CapabilitySkillBody[];
    /** 所选 MCP（已含真实工具名；无工具的 server 由调用方排除到 {@link unusableMcp}）。 */
    mcp: CapabilityMcpServer[];
    /**
     * 勾选但**当前不可用**的 MCP server（未启动 / 未注册任何工具）。
     *
     * 为什么不在这是直接报错：角色的 `defaultMcp` 里常留有已下线的实例
     * （本机 `roles.json` 的 `tfs-mcp` 就是历史值）。因此"某个 server 没起来"只降级为
     * prompt 里的一句明确声明——用户能看到"它没生效"，但不会因此整条派发失败。
     */
    unusableMcp?: string[];
    /** 工作流技能名（`FrozenConfig.workflow`；必须能读到正文）。 */
    workflow?: string;
    /** 工作流步骤（由技能正文解析；空数组表示"整篇正文即流程"）。 */
    workflowSteps?: string[];
    /** 技能调用工具名（宿主 `dsh-tool-skill` 注册为 `skill`；不同部署可能不同）。 */
    skillToolName?: string;
}
/** 验收结果。 */
export interface CapabilityVerification {
    /** 全部要求都满足。 */
    ok: boolean;
    /** 未按流程报告的工作流步骤（1-based）。 */
    missingSteps: number[];
    /** 未被加载的技能名。 */
    missingSkills: string[];
    /** 一次都没被调用的 MCP server 名。 */
    missingMcp: string[];
    /**
     * 输出里出现了"工具没注入本会话"的自述（2026-10-30 现场事故）。
     *
     * 为 true 时 `missingMcp` 应理解为**环境缺失**（子会话工具列表里根本没有这些工具），
     * 而不是"模型拒绝调用"——这两者的处置完全不同（前者要修装配，后者要换模型/加纪律）。
     */
    mcpNotInjected?: boolean;
    /**
     * 输出声称"工具未注入"，但**子会话真实工具表里确实有**这些工具（谎报）。
     *
     * 2026-10-30 现场纠正：子代理说"MCP 工具未注入本会话"，但解包其 `request/header`
     * 发现模型收到的工具表里 `mcp__tfs-mcp__*` 全在 —— 未注入是模型的错误自述。
     * 这与 {@link CapabilityVerification.mcpNotInjected}（工具表里真的没有）是两种事实，
     * 处置相反：前者要按"拒用/谎报"处理，后者才是环境缺失。
     */
    mcpClaimedMissing?: boolean;
    /**
     * 输出里出现了**文本形态的工具调用**（如 `<read>…</read>`）而不是真实 tool/call。
     * 典型成因：模型 tool-call 格式漂移（把工具调用写成了正文），等于什么都没执行。
     */
    pseudoToolCalls?: boolean;
    /** 人类可读的结论（不达标时可直接写进任务诊断）。 */
    note?: string;
}
/** 默认技能调用工具名（`packages/skill/tool-skill/src/index.ts:83`）。 */
export declare const DEFAULT_SKILL_TOOL = "skill";
/**
 * 去掉 YAML frontmatter（`---` 块）。
 *
 * 技能正文里的 frontmatter 是路由元数据（keywords/tags/requires_tools），
 * 对子 agent 是噪声；而 `requires_tools` 一类信息由本模块的 MCP 段单独表达。
 */
export declare function stripFrontmatter(content: string): string;
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
export declare function extractWorkflowSteps(content: string): string[];
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
export declare function parseReportedSteps(output: string, total: number): number[];
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
export declare function verifyCapabilityUsage(input: {
    skills: readonly string[];
    mcp: readonly string[];
    workflowSteps?: readonly string[];
    toolCalls?: readonly ChildToolCall[];
    /**
     * 子会话**真实工具表**（`request/header` 里的工具名并集，见 task-trace.readChildToolSurfaceFrom）。
     * 传 undefined = 无法核实工具是否注入，此时只按输出自述归因。
     */
    toolSurface?: readonly string[];
    output: string;
    skillToolName?: string;
}): CapabilityVerification;
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
export declare function buildCapabilityPlanSection(input: CapabilityPlanInput): string;
//# sourceMappingURL=capability-plan.d.ts.map
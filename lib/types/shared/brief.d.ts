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
 * @module dsh-tfs-requirment/shared/brief
 */
/** 单条已完成任务的结论。 */
export interface BriefConclusion {
    /** 看板任务 id。 */
    taskId: string;
    /** 任务标题（便于人读与模型对齐）。 */
    title: string;
    /** 结论摘要（主 agent 归纳产出；已限长）。 */
    summary: string;
    /** 该任务产出的关键产物绝对路径。 */
    artifacts?: string[];
}
/** 本需求可用的已绑定工具（口径 = 角色冻结配置，见 AC5.1）。 */
export interface BriefTools {
    /** 已绑定 MCP server 名。 */
    mcp: string[];
    /** 已绑定技能名。 */
    skills: string[];
}
/** 需求级共享简报。全部字段可选兼容旧 `board.json`（无简报 = 退化到现状语义）。 */
export interface RequirementBrief {
    /** 需求去重键 `id@collection`。 */
    requirementKey: string;
    /** 需求标题。 */
    title: string;
    /** 工作目录绝对路径（规范化后）。 */
    workspace?: string;
    /** 需求正文摘要（首次由主 agent 生成；为空表示尚未生成）。 */
    digest?: string;
    /** 已完成任务的结论（有序，按任务完成顺序）。 */
    conclusions: BriefConclusion[];
    /** 已产出的关键产物绝对路径（去重、保序）。 */
    artifacts: string[];
    /** 已绑定工具。 */
    tools: BriefTools;
    /** 最后更新时间 ISO。 */
    updatedAt: string;
}
/** 结论摘要的字数上限（超过截断；避免简报把 prompt 撑爆）。 */
export declare const CONCLUSION_MAX_CHARS = 300;
/** 需求摘要的字数上限。 */
export declare const DIGEST_MAX_CHARS = 1500;
/** 简报里保留的结论条数上限（超出丢弃**最早**的，保留最近的上下文）。 */
export declare const CONCLUSION_MAX_ENTRIES = 30;
/** 产物清单条数上限。 */
export declare const ARTIFACT_MAX_ENTRIES = 50;
/** 简报段的段头（收口时据此判断"是否已注入简报"）。 */
export declare const BRIEF_HEADER = "\u3010\u5171\u4EAB\u7B80\u62A5\uFF08\u672C\u9700\u6C42\u5DF2\u786E\u8BA4\u7684\u4E8B\u5B9E\uFF0C\u76F4\u63A5\u590D\u7528\uFF0C\u4E0D\u8981\u91CD\u590D\u63A8\u5BFC\uFF09\u3011";
/** 主 agent 归纳回复里的结论段头。 */
export declare const SUMMARY_HEADER = "SUMMARY:";
/**
 * 创建空简报。
 *
 * @param requirementKey - 需求去重键。
 * @param title - 需求标题。
 * @param input - 可选初值（工作目录 / 已绑定工具）。
 * @param now - 时间注入（测试用）。
 * @returns 新简报。
 */
export declare function emptyBrief(requirementKey: string, title: string, input?: {
    workspace?: string;
    tools?: Partial<BriefTools>;
}, now?: string | (() => string)): RequirementBrief;
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
export declare function upsertConclusion(brief: RequirementBrief, entry: BriefConclusion, now?: string | (() => string)): RequirementBrief;
/**
 * 合并产物路径（去重、保序、限条数）。
 *
 * @param brief - 原简报。
 * @param paths - 新增产物绝对路径。
 * @param now - 时间注入。
 * @returns 新简报。
 */
export declare function mergeArtifacts(brief: RequirementBrief, paths: readonly string[], now?: string | (() => string)): RequirementBrief;
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
export declare function buildDigestSeed(input: {
    description?: string;
    analysis?: string;
    dataStructure?: string;
    config?: string;
}): string;
/**
 * 设置需求摘要（首次由主 agent 生成；空串视为"未生成"）。
 *
 * @param brief - 原简报。
 * @param digest - 摘要正文。
 * @param now - 时间注入。
 * @returns 新简报。
 */
export declare function setDigest(brief: RequirementBrief, digest: string, now?: string | (() => string)): RequirementBrief;
/** 简报渲染的输入。 */
export interface BriefSectionInput {
    /** 已绑定 MCP server 名（缺省取 brief.tools.mcp）。 */
    mcp?: readonly string[];
    /** 已绑定技能名（缺省取 brief.tools.skills）。 */
    skills?: readonly string[];
    /**
     * 需求正文全文的兜底（**仅当** `brief.digest` 为空时使用）。
     *
     * 传它不代表一定会进 prompt：一旦简报里已有摘要，正文全文就**不再**重复下发（AC3.2）。
     */
    requirementPrompt?: string;
}
/**
 * 渲染派发 prompt 里的【共享简报】段。
 *
 * @param brief - 需求级简报。
 * @param input - 渲染输入。
 * @returns prompt 文本；`brief` 无任何可用内容且无兜底正文时返回空串（不产出噪声）。
 */
export declare function buildBriefSection(brief: RequirementBrief, input?: BriefSectionInput): string;
/**
 * 构造发给**编排主 agent** 的"任务已收口，请归纳"请求（US2 / AC2.2）。
 *
 * 明确要求输出 `SUMMARY:` 段并限长：不限长的主 agent 抒情会把简报撑爆，
 * 反而让下游任务读更多 token —— 与"省 token"的目标背道而驰。
 *
 * @param input - 任务与输出信息。
 * @returns 发给主 agent 的消息正文。
 */
export declare function buildSummarizePrompt(input: {
    requirementKey: string;
    taskId: string;
    title: string;
    /** 子 agent 的最终输出（已截断）。 */
    output: string;
    /** 该任务产出的产物绝对路径。 */
    artifacts?: readonly string[];
    /** 是否还有后续任务。 */
    hasNext: boolean;
}): string;
/**
 * 构造发给编排主 agent 的"全部完成，请出最终总结"请求（US2 / AC2.4）。
 *
 * @param input - 需求与任务清单。
 * @returns 发给主 agent 的消息正文。
 */
export declare function buildFinalSummaryPrompt(input: {
    requirementKey: string;
    title: string;
    tasks: ReadonlyArray<{
        title: string;
        summary?: string;
    }>;
}): string;
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
export declare function parseOrchestratorSummary(text: string | undefined): string;
/**
 * 去掉执行协议标记行（`TASK_DONE` / `NEEDS_HUMAN_CONFIRM` / `ARTIFACTS:` 段），
 * 只留下可当结论用的正文。
 *
 * @param text - 原始输出。
 * @returns 清洗后的文本。
 */
export declare function stripProtocolMarkers(text: string): string;
//# sourceMappingURL=brief.d.ts.map
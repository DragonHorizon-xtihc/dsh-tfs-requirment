/**
 * 跨宿主半 / 客户端半共享的类型契约（T047 / US4）。
 *
 * **为什么存在这个文件**：DSH 插件分两个独立编译程序——
 *   - 宿主半（tsconfig.host.json）：include `src/**`（排除 src/client），可依赖 @deepseek-ai/* 与 node:fs；
 *   - 客户端半（tsconfig.client.json）：include 仅 `src/client/**` + `src/shared/**`，`types: []`（无 node 全局）。
 *
 * 因此任何"宿主半与客户端半都要用"的类型，必须放在 `src/shared` 且**不得**依赖 node / @deepseek-ai，
 * 否则客户端半类型检查会因 `node:fs` 不可见或勾不到宿主服务而失败。
 *
 * `src/client/components/ExecutionPanel.tsx`（客户端半）与宿主半的 `roles.ts`/`adapter.ts`/`dispatch.ts`
 * 都从这里取类型，保证两端对同一数据结构理解一致，且互不引入对方的编译依赖。
 *
 * 本文件是**纯类型**（`type`-only 导出也行，但这里用普通 interface/type 以便值语义兼容），
 * 不 export 任何运行时值，避免被错打包进任一端。
 *
 * @module dsh-tfs-requirment/shared/contracts
 */
import type { RequirementBrief } from './brief.js';
export type { RequirementBrief } from './brief.js';
/** 角色默认可绑定的执行权限（与「新建任务」弹窗的权限 select 对齐）。 */
export type RolePermission = 'read-only' | 'workspace-write' | 'danger-full-access';
/**
 * 角色智能体定义（业务侧"指派给谁做"的抽象）。
 * 在宿主半由 `RoleStore` 落盘 `roles.json`；在客户端半由 ExecutionPanel 的角色下拉渲染。
 * 不得在客户端半 import `../orchestration/roles.js`（那是宿主半，会拉入 node:fs）。
 */
export interface RoleDefinition {
    /** 稳定 ID（持久化主键）。 */
    id: string;
    /** 展示名（TaskSnapshot.roleAgent 引用此名；US3 指派下拉显示）。 */
    name: string;
    /** 可选描述。 */
    description?: string;
    /**
     * 宿主 subagent provider 名（对应 `ctx.subagents.start(name, request)` 的 `name`）。
     * 例如 `spawn` / `fork` / `acp`（来自 dsh-subagent 的 SubagentProvider.name）。
     *
     * 注意：这是**子智能体驱动名**，不是 LLM 供应商路由 key；模型实际路由到哪家 LLM
     * 供应商由 {@link defaultModelProvider} 决定，两者是独立的两条轴。
     */
    provider: string;
    /**
     * 可选的 agent preset 引用（preset id，来自 dsh-agent-presets 的 `AgentPresetRow.id`）。
     * 注意：这不是 host preset 的 `autoExecute` 字段，仅为 id 引用。
     */
    preset?: string;
    /**
     * 默认模型 id（派发时作 `agentOptions.model`，由所选 LLM provider 的适配器解释）。
     * 与 {@link defaultModelProvider} 成对语义。
     */
    defaultModel?: string;
    /**
     * 默认 LLM 供应商路由 key（= `llm.listProviders()` 返回的 id，如本机 `arkcode`/`nvida`），
     * 与 {@link defaultModel} 成对；缺省 = 子 agent 继承父聊天会话当前的 LLM 供应商。
     */
    defaultModelProvider?: string;
    /** 默认绑定 MCP server 名列表。 */
    defaultMcp?: string[];
    /** 默认绑定技能名列表。 */
    defaultSkills?: string[];
    /** 默认执行权限。 */
    defaultPermission?: RolePermission;
    /**
     * 本插件控制：该角色被指派后是否自动发起执行（S-13）。
     * **不是** host preset 字段；仅本插件逻辑使用。
     */
    autoExecute?: boolean;
    /** 默认标签策略（如固定 `dsh` 或自定义前缀）。 */
    tagStrategy?: string;
}
/**
 * 回写操作类型。
 *
 * `tool` 是 2026-09-18 新增：封装层把 TFS 的**全部**操作都收进插件（见
 * `src/tfs/tool-catalog.ts`），其中大量写操作（新建工作项 / 更新字段 / 指派 / 上传附件 /
 * 创建 PR …）无法归入 tag/comment/state/link 四类。为了不让它们**绕过**审计，
 * `tool` 作为"经封装工具发起的写操作"的审计类型存在，审计详情里会带上操作键。
 */
export type WriteOpType = 'state' | 'comment' | 'link' | 'tag' | 'tool';
/** 回写意图（dry-run 预览源，S-05）。 */
export interface WriteOp {
    /** 目标工作项 dedupKey。 */
    targetWorkItem: string;
    /** 操作类型。 */
    opType: WriteOpType;
    /** 变更前（字段级 diff 的 before）。 */
    before: unknown;
    /** 变更后（字段级 diff 的 after）。 */
    after: unknown;
    /** 幂等键（S-08）。 */
    idempotencyKey: string;
    /** dry-run 预览结果（可选，经 write-guard 生成）。 */
    dryRun?: unknown;
    /** 是否经用户确认。 */
    confirmed?: boolean;
    /** 最终执行结果（可选）。 */
    result?: unknown;
}
/** 创建时冻结的配置快照（运行期不可改）。 */
export interface FrozenConfig {
    /** MCP 引用列表。 */
    mcp: string[];
    /** 技能引用列表。 */
    skills: string[];
    /**
     * 模型 id（由所选 LLM provider 的适配器解释；跨供应商不保证唯一）。
     */
    model: string;
    /**
     * LLM 供应商路由 key（= `llm.listProviders()` 返回的 id，如本机 `arkcode`/`nvida`）。
     *
     * 与 {@link model} 成对：派发时作 `agentOptions.provider`。缺省（旧数据/未指定）=
     * 子 agent 继承父聊天会话当前的 LLM 供应商——这正是"选了火山方舟同名模型却跑到英伟达"
     * 事故的根因，故新数据必须尽量携带。仅在 model 非空时有意义；落盘时空串不写键。
     */
    modelProvider?: string;
    /**
     * agent preset id（问题 3：任务级可编辑预设）。
     *
     * 任务级预设在派发时**覆盖**角色自带 `RoleDefinition.preset`；空串/缺省表示沿用角色定义。
     * 与执行配置页 `DispatchDraft.preset` 同语义，只是随任务冻结持久化，使"未执行任务可改预设"
     * 在重新派发时生效。落盘时空串不写键（保持旧 JSON 形状）。
     */
    preset?: string;
    /**
     * 子智能体委派深度上限（问题 1：0/缺省 = 沿用插件默认 `defaultMaxDepth`）。
     * 任务级可覆盖，限制孙 agent 无限派生导致 token 爆炸。
     */
    maxDepth?: number;
    /**
     * 单次模型响应输出 token 上限（问题 1：0/缺省 = 不设置）。任务级可覆盖。
     */
    maxTokens?: number;
    /**
     * 工作流技能名（2026-10-29 用户诉求 4：**工作流从技能中选择**）。
     *
     * 语义：该任务的执行流程由这个技能定义，派发时插件会
     *   ① 把技能正文整篇下发；② 从正文解析有序步骤，生成"禁止跳步"的逐步勾选纪律；
     *   ③ 落定后按 `✅ 步骤 i/N` 标记验收，未逐条报告则收口为「待人工确认」。
     *
     * 取值必须是 `skills` 之一（工作流就是一种技能）。空串/缺省 = 不启用工作流强制。
     */
    workflow?: string;
}
/**
 * 技能/MCP 分组：把一组常用技能 + MCP server 打包成一个可复用的"能力包"。
 *
 * 存在的理由：执行配置页与任务编辑弹框各自都要勾一遍技能/MCP，换一台机器/换个人
 * 就得重新勾。分组落 `skill-groups.json`（宿主半 `SkillGroupStore`，与 roles.json
 * 同一 JsonStore 纪律），在执行配置页/任务编辑弹框选中分组后**自动带出**其技能与 MCP
 * （带出后仍可微调，分组只是填充器，不是绑定）。
 */
export interface SkillMcpGroup {
    /** 分组 id（创建时生成；保存时同 id 覆盖）。 */
    id: string;
    /** 分组名（必填，同名保存=覆盖该分组，避免出现两个"前端基础包"）。 */
    name: string;
    /** 可选说明。 */
    description?: string;
    /** 该组包含的技能名（取值域 = DshSkillOption.name）。 */
    skills: string[];
    /** 该组包含的 MCP server 名（取值域 = 宿主真实注册的 mcpServers）。 */
    mcp: string[];
    /** 创建时刻（ISO）。 */
    createdAt: string;
    /** 最近更新时刻（ISO）。 */
    updatedAt: string;
}
/**
 * 一个可选模型（provider 维度已拍平，id 全局唯一性由 `provider + id` 保证）。
 * 由 `DshCatalog` 从宿主 `ctx.llm` 采集，供面板下拉渲染（按 provider 分组）。
 */
export interface DshModelOption {
    /** provider 路由键（`GenerateOptions.provider`）。 */
    provider: string;
    /** provider 展示名（下拉分组标题）。 */
    providerName: string;
    /** 模型 id（`GenerateOptions.model`）。 */
    id: string;
    /** 模型展示名。 */
    name: string;
    /** 可选补充说明。 */
    description?: string;
}
/** 一个可选技能。 */
export interface DshSkillOption {
    name: string;
    description: string;
    /** 来源桶（`project-dsh` / `user-dsh` / `bundled` …）。 */
    source: string;
    /** 是否可被模型调用（`invocation.modelInvocable`）。 */
    modelInvocable: boolean;
    /** 是否可被用户调用（`invocation.userInvocable`）。 */
    userInvocable: boolean;
}
/** 一个可选 agent preset。 */
export interface DshPresetOption {
    id: string;
    name: string;
    description: string;
    /** 是否为宿主默认预设。 */
    isDefault: boolean;
    /** 该预设当前是否损坏（宿主 `broken` 字段；有值即不可用）。 */
    broken?: string;
}
/** 一个可选工作区。 */
export interface DshWorkspaceOption {
    id: string;
    title: string;
    /** 工作区绝对路径。 */
    path: string;
}
/**
 * DSH 能力目录快照（全部字段均为可 JSON 序列化的值，可安全经 HTTP 下发）。
 * 由宿主半 `DshCatalog` 采集，面板静态数据据此渲染真实下拉（而非硬编码清单）。
 */
export interface DshCatalog {
    models: DshModelOption[];
    skills: DshSkillOption[];
    presets: DshPresetOption[];
    workspaces: DshWorkspaceOption[];
    /** 可用 subagent provider 名（`ctx.subagents.start(name, …)` 的 name）。 */
    providers: string[];
    /** 已注册的 MCP server 名（从工具名前缀反推，非配置回显）。 */
    mcpServers: string[];
    /** 各项降级原因（空数组表示全部采集成功）。 */
    warnings: string[];
    /** 采集完成时刻（ISO）。 */
    collectedAt: string;
}
/** 一次回写草稿（UI → 宿主）。 */
export interface WriteOpDraft {
    opType: WriteOpType;
    /** 变更前值（标签类为 string[]，评论类为 string）。 */
    before: unknown;
    /** 变更后值。 */
    after: unknown;
}
/** 发起执行草稿（UI → 宿主）。 */
export interface DispatchDraft {
    roleName: string;
    /**
     * 任务标题（问题 6）。
     *
     * 从「执行配置 → 发起执行」派发时，宿主会把这次执行**落地为一条看板任务**；
     * 该字段即这条任务的标题（缺省时宿主回落为「<角色名> 手工执行」）。
     */
    title?: string;
    /** 任务描述（问题 6；写入看板任务的 `description`）。 */
    description?: string;
    prompt: string;
    /**
     * 需求级提示词**本次覆盖**（2026-11-03 问题 1/3）。
     *
     * 缺省时宿主实时读看板 `Requirement.prompt`（"用户改了需求提示词后未派发任务立刻采用新值"）。
     * 「选为目标」把任务中心的需求级提示词带进执行配置后，用户可能就地微调 —— 那份微调
     * 只该影响**本次**派发，故走本字段覆盖而非回写看板（不制造两份真相）。
     */
    requirementPrompt?: string;
    /**
     * 执行时机（2026-11-03 问题 4）：'now'/缺省 = 立刻派发；mode='at' = 到 `dueAt` 才派发。
     * `dueAt` 为 ISO 8601，精确到分；校验在宿主（`shared/schedule.ts#validateSchedule` 同口径）。
     */
    schedule?: {
        mode: 'now' | 'at';
        dueAt?: string;
    };
    frozenConfig: FrozenConfig;
    permission: RolePermission;
    /**
     * agent preset id 覆盖（问题 6）。
     *
     * 执行配置页选的预设**覆盖**角色自带的 `preset`（角色没配预设时也可单独指定）；
     * 空串/缺省表示沿用角色定义。宿主侧通过"克隆角色并改写 preset"落地，
     * 不改变 `RoleDefinition` 的持久化内容（避免把一次性执行选择写进角色档案）。
     */
    preset?: string;
    /** 工作区 id（问题 5；dsh 已添加工作区之一）。 */
    workspace?: string;
    /** 子智能体委派深度上限（问题 1；缺省沿用插件默认）。 */
    maxDepth?: number;
    /** 单次模型响应输出 token 上限（问题 1；0/缺省不设置）。 */
    maxTokens?: number;
}
/**
 * 派发 / 回写目标（需求 dedupKey + 集合）。
 *
 * **为什么必须由 UI 显式传下来**（2026-09-21 实机事故）：
 * 宿主下发的 `ExecutionPanelData.targetWorkItem` 里那个 `'—'` 是**占位符**
 * （`host/api.ts#getPanelData` 硬编码），用户「选为目标」只改了客户端 `target` state，
 * 于是同一屏里出现两个"目标"：渲染用的那份是对的（`1997179@WN_HIS`），
 * 而动作回调若从桥自己的快照取目标，发出去的仍是 `'—'` —— 表现为
 * 「确认回写」得到 *targetWorkItem 缺少有效工作项 id：—*、
 * 「发起执行」得到 `task=—#role-coder`。
 * 因此目标随**渲染这一屏的那份数据**一起传给动作：UI 显示什么，就写什么。
 */
export interface TargetRef {
    /** 目标工作项 dedupKey，如 `123@WN_HIS`；也接受看板任务 id 形态 `123@WN_HIS#analyze`（宿主会剥掉 `#…` 段）。 */
    targetWorkItem: string;
    /** 集合（dedupKey 未带集合时的回退）。 */
    collection: string;
}
/**
 * 「发起执行」的结果（问题 1/6）。
 *
 * 比裸 `{ok, reason}` 多三样东西，都是 2026-09-21 两个实机问题的**可见性**要求：
 *   - `taskId` / `createdTask`：这次执行落地成了哪条看板任务、是否新建（问题 6：
 *     此前"执行配置发起执行"不产生任务，用户完全看不到执行内容）；
 *   - `workspace`：**实际生效**的工作目录（问题 1：面板上选的值可能是回落的第一个工作区，
 *     也可能被任务/需求上的配置覆盖 —— 界面必须显示真正生效的那个，而不是它以为的那个）。
 */
export interface DispatchActionResult {
    ok: boolean;
    reason?: string;
    /** 本次派发关联的看板任务 id。 */
    taskId?: string;
    /** 该看板任务是否由本次派发新建。 */
    createdTask?: boolean;
    /** 实际生效的工作目录（绝对路径）。 */
    workspace?: string;
    /** true = 已登记为定时执行（问题 4）：到 `scheduledAt` 才真正派发，此刻不建任务。 */
    scheduled?: boolean;
    /** 定时派发的到点时刻（ISO 8601，精确到分；仅 scheduled=true 时有）。 */
    scheduledAt?: string;
}
/**
 * 定时调度条目的 UI 视图（2026-11-03 问题 3：任务中心要能看到/修改定时条目）。
 *
 * 与宿主 `ScheduledEntry` 落盘形状字段对齐；`requirementKey` 由宿主从 payload 归一
 * （dispatch 取 targetWorkItem，chain 取 requirementKey），供需求行"定时待执行"派生。
 */
export interface ScheduleEntryView {
    /** 条目 id（同 id 重登记 = 覆盖）。 */
    id: string;
    /** 到点时刻（ISO 8601，精确到分）。 */
    dueAt: string;
    /** 'dispatch' = 到点发起一次执行；'chain' = 到点开始编排某需求的子 Agent 链。 */
    kind: 'dispatch' | 'chain';
    /** 创建时刻（ISO）。 */
    createdAt: string;
    /** 人类可读备注。 */
    note?: string;
    /** 关联需求键（`{id}@{collection}`）；无法归一时省略。 */
    requirementKey?: string;
}
/** 执行面板动作（由 HostBridge 在宿主半接线，客户端半仅消费）。 */
export interface ExecutionActions {
    /** 确认回写：过 WriteGuard 四门禁后直连 TFS REST 调用。 */
    confirmWrite: (ops: WriteOpDraft[], target?: TargetRef) => Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /**
     * 发起执行：经 ctx.subagents.start 并发分发。
     * `taskId` 为看板任务 ID（有则绑定看板状态）；`target` 为回写/记录用的需求目标。
     */
    dispatch: (req: DispatchDraft, taskId?: string, target?: TargetRef) => Promise<DispatchActionResult>;
    /**
     * 注：`parse`（AI 解析粘贴文本 → 回填表单）已于 2026-10-04 移除。
     * 它曾以可选成员声明，但 `HostBridge` 从未实现，导致「AI 解析」按钮恒定禁用且无任何说明。
     * 真要做需要宿主 LLM 的**文本补全** API，而本插件目前只用到 `llm.listProviders/listModels`
     * （能力目录采集），没有可校核的补全通道，故不臆造实现；待宿主接口明确后再连同 UI 一起加回。
     */
    /**
     * 强制重采 DSH 能力目录（问题 1/2）。
     *
     * 面板必须给用户一个**自救入口**：技能/MCP/模型是"插件已打开之后"才可能新增的，
     * 只读内存快照的下拉永远缺项。接线层（`slots.tsx`）落地为 `bridge.refreshPanelData()`
     * （先 POST catalog-refresh 重采，再取面板数据）。
     */
    refreshCatalog?: () => Promise<void>;
    /**
     * 发起执行**成功**后的导航钩子（2026-11-03 用户诉求 1）。
     *
     * 执行面板自身不知道外层 Tab 结构（中央工作台 TabKey / 右栏 SideTab 两套），
     * 由接线层（slots.tsx / SidePanel.tsx）注入"切到任务中心"的动作。
     * 只在**立刻执行**成功（看板任务已创建）时被调用——定时执行只登记条目、
     * 任务中心看不到新任务，留在执行页展示"到点自动派发"的成功消息更有用。
     */
    onDispatched?: () => void;
}
/** 面板静态数据（由 HostBridge 从宿主/本地注入）。 */
export interface ExecutionPanelData {
    /** 目标工作项 dedupKey，如 `123@WN_HIS`。 */
    targetWorkItem: string;
    collection: string;
    roles: RoleDefinition[];
    /** 扁平模型 id 列表（保留以兼容既有消费方）。 */
    models: string[];
    /** 真实模型清单（按 provider 分组渲染，问题 4）。 */
    modelOptions: DshModelOption[];
    /** 真实工作区清单（问题 5）。 */
    workspaces: DshWorkspaceOption[];
    /** 真实 agent 预设清单（问题 6）。 */
    presets: DshPresetOption[];
    /** 真实 subagent provider 名清单（问题 9，角色 provider 下拉）。 */
    providers: string[];
    /** 真实已注册 MCP server 名清单（从工具名前缀反推，问题 7，非配置回显）。 */
    mcpServers: string[];
    /** 扁平技能名列表（保留以兼容既有消费方）。 */
    skills: string[];
    /** 真实技能清单（问题 7 / 11）。 */
    skillOptions: DshSkillOption[];
    /**
     * 技能/MCP 分组清单（2026-11-03 用户诉求，宿主 `skill-groups.json`）。
     *
     * 执行配置页与任务编辑弹框据此渲染"分组"下拉，选中后自动带出组内技能/MCP。
     * 缺省（宿主未接线/读盘失败）= 不渲染分组选择器（能力降级，不阻断主流程）。
     */
    skillGroups?: SkillMcpGroup[];
    /** 标签候选（datalist）。 */
    tagSuggestions: string[];
    /** 可切换的集合清单（FR-025，来自 `config.collections`）。 */
    collections: string[];
    /** 定时轮询间隔（分钟，FR-024/S-14）；客户端据此排程刷新。 */
    pollIntervalMinutes: number;
    /**
     * DSH 能力目录的降级原因（问题 1/2 的可见性）。
     *
     * 目录采集是"逐项独立降级"的（某项宿主服务缺失只让该项为空），但**降级原因此前被丢掉**，
     * 于是"技能下拉为空"在 UI 上看起来就是"你没有技能"，用户无从判断是没装还是没采到。
     * 透出 warnings 后，用户能直接看到 "技能目录：无法读取 preset 挂载作用域（…）" 这类原因。
     */
    catalogWarnings?: string[];
    /** 该目录快照的采集时刻（ISO；空表示尚未采集）。 */
    catalogCollectedAt?: string;
    /**
     * 活动连接档案的服务地址（**不含集合**，如 `http://tfs2018-web.winning.com.cn:8080/tfs`）。
     *
     * 用途：需求池/任务中心的标题要拼出 TFS 需求页
     * `{地址}/{集合}/{团队项目}/_workitems?id={id}&_a=edit`。
     * 首选数据源是工作项自带的 REST `url`（含 `/_apis/`，最可靠）；
     * 本字段是**兜底**——历史 `board.json` 条目可能没有 url。
     * 只含地址，**永不含 PAT**（`ProfileView` 无 pat 字段，类型系统即防线）。
     */
    tfsBaseUrl?: string;
    /**
     * 批量派发时的单波并发上限（问题 5；来自 `config.maxConcurrentRequirements`，缺省 3）。
     *
     * 为何要下发给客户端：批量派发的**分波编排在客户端**（见 `src/shared/batch-dispatch.ts`），
     * 它需要知道"一波最多同时派几个"才能与宿主 `RequirementDispatcher` 的并发上限对齐，
     * 否则客户端会把 10 个任务一次性推给宿主，全部堆在宿主的排队队列里（虽然不会错，
     * 但用户看不到"分批推进"的进度）。
     */
    dispatchConcurrency?: number;
    /**
     * US4 编排能力（宿主 `subagents` 服务）在**本次请求时**的可达性快照（2026-09-21）。
     *
     * 为什么要有它：旧实现把"服务不可用"这个结论做在**插件 apply 期**（那时提供方 fiber
     * 还没激活，探测必然为 false），于是分发器被永久钉成"永远抛错的桩"，用户只能通过
     * 点击「发起执行」并读报错才知道编排能力坏了。现在该结论**每次取面板数据时现算**，
     * 面板可以在点击前就如实告知，并给出原因。
     *
     * 缺省（未接线）时面板不做任何编排能力提示。
     */
    orchestration?: {
        /** 派发入口可用（`startActivation` 或旧版 `start`）⇒ 可以派发子智能体。 */
        available: boolean;
        /** 宿主真实注册的 provider 名（角色 `provider` 下拉的取值域；老版本服务可能为空）。 */
        providers: string[];
        /** 不可用/降级原因。 */
        reason?: string;
        /**
         * 实际生效的派发 API（2026-10-29 诊断字段）。
         *
         * `startActivation` = 现行宿主（0.2.1+，`packages/subagent/subagent/src/index.ts:269`）；
         * `start` = 旧宿主（≤0.2.0）。面板据此显示"派发通道"，让"到底走哪条路"可见，
         * 而不是只看到一个 available 布尔值。
         */
        api?: 'startActivation' | 'start';
        /**
         * true = **当前没有活跃会话**，但派发时会由宿主 `sessionController` 现场准备一个
         * （2026-11-03）。面板据此显示"无活跃会话，派发时自动准备"，而不是把能力判成不可用。
         *
         * 为什么不是"不可用"：定时执行到点那一刻用户会话通常早已关闭，能否派发不该取决于
         * 「此刻是否开着聊天窗口」——`available:true` + 本标记才是如实描述。
         */
        parentOnDemand?: boolean;
    };
    /**
     * **宿主半插件的加载时刻**（ISO，2026-10-29 新增）。
     *
     * 为什么需要它：宿主半是 node 模块，**只在 dsh 启动时加载一次**——重新构建 `lib/` 后
     * 不重启 dsh，界面仍会跑旧代码，而报错文案看起来完好无损（用户无法判断"改了没生效"）。
     * 面板显示这个时间，配合构建产物时间就能一眼判定"要不要重启"。
     */
    pluginLoadedAt?: string;
    /**
     * 当前目标需求的**完整快照**（US3 / FR-009），带 `System.Description` 转出的正文。
     *
     * 为什么不是只给 id 让客户端回查：执行面板在客户端半，没有 TFS 凭据，也拿不到
     * 宿主半 adapter；`targetWorkItem` 只是个字符串键，客户端凭它无法取到正文，
     * 于是"设为目标"后用户只能自己回 TFS 复制粘贴（这正是要修的行为）。
     *
     * 可选：未设置目标时（数据里没有对应需求）不下发，客户端按"无目标"渲染。
     */
    target?: RequirementSummary;
    /**
     * 「选为目标」填充序号（spec 008 US4，**纯客户端会话态**：由 slots.tsx 注入，
     * 宿主 getPanelData 不下发、不落盘、不进路由白名单）。
     *
     * 用户每显式点击一次「选为目标」就 +1；执行面板据此把目标标题/描述/执行 Prompt
     * **重新填入**表单——同一需求第二次选为目标（如发起执行后表单已清空）也必须重新带入。
     * 后台轮询刷新不产生新序号，因此不会顶掉用户的手工编辑。
     */
    targetFillNonce?: number;
}
/** 表单内部状态（也可被 parse 回填）。 */
export interface ExecutionFormState {
    title: string;
    description: string;
    execPrompt: string;
    /**
     * 需求级提示词（2026-11-03 问题 1/3：「选为目标」从任务中心带入）。
     *
     * 与 `execPrompt` 分开放：宿主派发时会把需求级提示词拼在任务提示词**之前**，
     * 复制进 execPrompt 会让同一段话发两份。这里带入是为了**可见与可微调**，
     * 派发时以 `DispatchDraft.requirementPrompt` 作本次覆盖下发。
     */
    reqPrompt: string;
    tags: string[];
    workspace: string;
    permission: RolePermission;
    /**
     * 执行模型下拉值（`modelOptionValue(provider, id)` 复合值，见 shared/model-route.ts）；
     * 空串表示未选择（渲染时回落目录第一项）。派发时解码为 frozenConfig.model/modelProvider。
     */
    model: string;
    /**
     * agent preset id（问题 6）。
     *
     * 取自宿主 `ctx.agentPresets.list()`，与 DSH 的预设下拉一致；空串表示"不指定预设"。
     * 派发时随冻结配置下发给角色智能体。
     */
    preset: string;
    selectedMcp: string[];
    selectedSkills: string[];
    /**
     * 工作流技能名（2026-10-29 用户诉求 4）。
     *
     * 取值来自「技能」下拉（工作流就是一种技能）：选中后派发时按该技能正文的步骤
     * 强制逐步执行，禁止跳步；空串 = 不启用工作流。
     */
    workflow: string;
    roleName: string;
    /** 执行时机（2026-11-03 问题 4）：'now' = 立刻（默认）；'at' = 定时。 */
    scheduleMode: 'now' | 'at';
    /** 定时执行时刻（`datetime-local` 值，精确到分；仅 scheduleMode='at' 有效）。 */
    scheduleAtLocal: string;
}
/**
 * 宿主桥：客户端半 → 宿主半的命令通道。
 *
 * **为何需要**：宿主半与客户端半是独立打包的，客户端半不能直接访问宿主服务
 * （如 `ctx.tools.execute({…})`、`ctx.subagents.start`——
 * 注意工具是经 `ToolRuntime.execute` 调用的，**不是**服务上的可调用属性）。
 * 客户端半的按钮动作必须经此桥转发到宿主半，由宿主半落地真实写调用 / 子 agent 分发。
 *
 * **真实通道（Phase 3 已落地，实测复核 dsh-optimized-prompt）**：客户端半用 `fetch`
 * 调宿主半经 `webServer.register` 挂的 HTTP 路由（见 `TFS_ROUTES`）；宿主半在路由处理器里
 * 读 roles.json / 过 WriteGuard 四道门禁直连 TFS REST 写入 / 经 RequirementDispatcher 派发 subagent。
 * 这套模式不依赖 `dsh-client-store` 的未核实 API，也不臆造宿主调用，是仓库既有先例。
 */
export interface HostBridge {
    /** 取面板静态数据（角色 / 模型 / MCP / 技能 / 标签候选）。经 HTTP 路由到宿主半，故异步。 */
    getPanelData(): Promise<ExecutionPanelData>;
    /**
     * 强制重采 DSH 能力目录后再取面板数据（问题 4/5/6/7/9/11）。
     *
     * 存在的理由：目录在宿主 `apply` 期采集一次。用户"先打开插件、后配置模型 / 装技能 /
     * 加 MCP server"是常态，只读内存快照的下拉会永远缺项。本方法触发宿主重采。
     */
    refreshPanelData(): Promise<ExecutionPanelData>;
    /** 确认回写（过四道门禁后直连 TFS REST 写入）。`target` 缺省时退化为面板快照里的目标。 */
    confirmWrite(ops: WriteOpDraft[], target?: TargetRef): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** 发起执行（并发派发到角色智能体）。`target` 为需求目标（缺省时退化为主机快照）。 */
    dispatch(req: DispatchDraft, taskId?: string, target?: TargetRef): Promise<DispatchActionResult>;
    /** 需求池列表（US2）。 */
    listRequirements(filter: RequirementFilter): Promise<RequirementListResult>;
    /** 需求筛选可选项（问题 3：项目/类型/状态/指派人，由宿主从真实 TFS 采集；宿主侧有进程内缓存）。 */
    getQueryOptions(): Promise<RequirementQueryOptions>;
    /**
     * 强制重采需求筛选可选项（绕过宿主缓存）。
     *
     * 存在的理由：可选项在服务进程内缓存，TFS 上新建了项目/工作项类型后，
     * 缓存会滞后到服务重启。用户需要一个明确入口主动刷新（FR-003）。
     */
    refreshQueryOptions(): Promise<RequirementQueryOptions>;
    /** 角色清单（US5）。 */
    listRoles(): Promise<RoleDefinition[]>;
    /** 保存/更新角色（US5）。 */
    saveRole(role: RoleDefinition): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /**
     * 删除角色（US5 / T057）。被任务引用的角色默认拒绝，给出受影响引用清单；
     * `force=true` 时显式确认后删除。
     */
    deleteRole(id: string, force?: boolean): Promise<{
        ok: boolean;
        reason?: string;
        references?: string[];
    }>;
    /** 技能/MCP 分组清单（2026-11-03 用户诉求）。 */
    listSkillGroups(): Promise<SkillMcpGroup[]>;
    /** 保存/更新技能/MCP 分组（同名=覆盖）。 */
    saveSkillGroup(group: SkillMcpGroup): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** 删除技能/MCP 分组。 */
    deleteSkillGroup(id: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** 看板快照（US3 任务中心 / US6 恢复）。 */
    getBoard(): Promise<BoardSnapshotView>;
    /** 领取需求入本地池（US2 / T036，幂等 S-01）+ 打 `dsh` 标签（T048，幂等 S-08）。 */
    claimRequirement(input: ClaimRequirementInput): Promise<ClaimRequirementResult>;
    /**
     * 拆解需求为默认五段式任务（分析 → 架构师拆解 → 开发 → 代码审核 → 测试）（US3 / T041，问题 9/10）。
     * 同 id 任务不存在→新建；为 deleted（已取消）→删旧记录后原地重建为全新 pending；
     * 其他在办/已完成状态→跳过（不重置运行成果）。
     */
    decomposeRequirement(requirementId: string): Promise<{
        ok: boolean;
        taskIds?: string[];
        created?: number;
        skipped?: number;
        createdRoles?: string[];
        reason?: string;
    }>;
    /**
     * 开始编排（2026-11-03 问题 4/5）：'now' = 立刻按依赖顺序启动子 Agent 链
     * （上个任务完成才编排下个）；'at' = 登记定时（精确到分，持久化 + 重启补跑）。
     */
    orchestrationStart(input: {
        requirementKey: string;
        mode: 'now' | 'at';
        dueAt?: string;
        sequential?: boolean;
    }): Promise<{
        ok: boolean;
        reason?: string;
        scheduledAt?: string;
    }>;
    /** 定时执行条目清单（问题 4/5；2026-11-03 问题 3 改为类型化视图）。 */
    listSchedules(): Promise<{
        ok: boolean;
        entries?: ScheduleEntryView[];
        reason?: string;
    }>;
    /** 取消一条定时执行。 */
    cancelSchedule(id: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /**
     * 修改一条定时执行的到点时刻（2026-11-03 问题 3：用户要求"有地方可以修改执行时间"）。
     * 同 id 重登记语义（覆盖旧条目并重新武装）；`dueAt` 为 ISO 8601，必须晚于当前时间。
     */
    updateSchedule(id: string, dueAt: string): Promise<{
        ok: boolean;
        reason?: string;
        scheduledAt?: string;
    }>;
    /** 还原已领取需求回需求池（2026-09-20 问题 7）：仅当其任务全部已取消时允许。 */
    restoreRequirement(requirementKey: string): Promise<RestoreResult>;
    /** 实时重取需求工作项，把详细信息/需求分析/数据结构/需求配置回写到看板（问题 11）。 */
    enrichRequirement(requirementKey: string): Promise<EnrichResult>;
    /** 删除已取消任务（问题 8）：整批门禁 + 级联清理 blockedBy/artifacts。 */
    deleteTasks(taskIds: string[]): Promise<DeleteTasksResult>;
    /**
     * 编辑已领取需求的本地字段（问题 3：增加提示词、切换工作目录）。
     * 只改本地补充字段（prompt/workspace），TFS 字段仍走 `confirmWrite`。
     */
    updateRequirement(input: UpdateRequirementInput): Promise<UpdateRequirementResult>;
    /**
     * 设置需求级执行状态（问题 5）：`'active'` = 取消完成（退回「任务中心」），
     * `'completed'` = 人工确认完成（迁入「已完成」）。
     *
     * 用于"已完成需求必须先取消完成才能还原到需求池"这条门禁的前半段：
     * 完成与撤销都是显式动作，不允许一步跨过。
     */
    setRequirementExecState(input: SetRequirementExecStateInput): Promise<RequirementExecStateResult>;
    /**
     * 编辑任务字段（问题 4：提示词 / 模型 / 技能 / MCP / 工作目录），走 revision 乐观锁。
     */
    updateTask(input: UpdateTaskInput): Promise<TaskOpResult>;
    /** 读取某次任务执行的过程轨迹（技能/MCP/工具调用时间线；业务不可用返回 available:false）。 */
    getTaskTrace(taskId: string, attemptIndex?: number): Promise<TaskTraceResult>;
    /** 对任务追问 / 补充指令（同配置起新一轮执行，返回新 runId 与尝试序号）。 */
    followUpTask(input: FollowUpTaskInput): Promise<FollowUpTaskResult>;
    /** 读本地落盘的需求池可选项（问题 1）；无缓存返回 data=null。 */
    loadQueryOptions(collection?: string): Promise<{
        ok: boolean;
        data: RequirementQueryOptions | null;
        savedAt?: string;
    }>;
    /** 强制重新采集需求池可选项并落盘覆盖（问题 1「采集可选项」按钮）。 */
    collectQueryOptions(collection?: string): Promise<{
        ok: boolean;
        data?: RequirementQueryOptions;
        reason?: string;
    }>;
    /** 读 UI 状态（筛选/每页条数，问题 2/4/6）。 */
    loadUiState(collection?: string): Promise<UiState>;
    /** 合并保存 UI 状态（按集合命名空间深合并）。 */
    saveUiState(patch: Partial<UiState>, collection?: string): Promise<{
        ok: boolean;
        reason?: string;
    }>;
    /** 指派任务角色（US3 / T042）。 */
    assignTask(taskId: string, roleName: string): Promise<TaskOpResult>;
    /** 任务状态操作（US3 / T043）。 */
    setTaskState(taskId: string, action: TaskAction, expectedRevision?: number): Promise<TaskOpResult>;
    /** 连通性自检（US1 / T029）。 */
    healthCheck(): Promise<HealthResult>;
    /** 审计状态（T063 / S-03）。 */
    getAudit(): Promise<AuditView>;
    /** 执行审计滚动归档（T063）：过期条目落独立归档文件，live 日志不被改动。 */
    archiveAudit(): Promise<ArchiveResult>;
    /** 切换默认集合（T030 / FR-003/FR-025）；须属于 `collections` 清单。 */
    setCollection(collection: string): Promise<{
        ok: boolean;
        reason?: string;
        collection?: string;
    }>;
    /** 连接档案清单（T031；**不含 PAT**）。 */
    listProfiles(): Promise<ProfileListResult>;
    /** 保存/更新档案（T031；PAT 只进存储，不回显）。 */
    saveProfile(input: ProfileSaveInput): Promise<ProfileOpResult>;
    /** 删除档案（T031；随机字节覆写擦除 S-12）。 */
    deleteProfile(id: string): Promise<ProfileOpResult>;
    /** 设为活动档案（T031）；返回的 profile 不含 PAT。 */
    activateProfile(id: string): Promise<ProfileOpResult>;
    /**
     * MCP 接入诊断 + 环境模板（T028b）：**一次请求同时返回**（宿主路由 `/mcp-instance` 即如此），
     * 避免 UI 为渲染一块面板发两次往返。
     */
    getMcpSetup(profileId?: string): Promise<McpSetup>;
    /** 写出 MCP 启动环境文件（T028b；明文只进文件，不回响应体）。 */
    writeMcpEnvFile(profileId?: string): Promise<EnvFileResult>;
    /** 能力目录（问题 8 / 12）：模型可见的 `tfs_req_*` 与其内部操作键的一一对应。 */
    getTfsToolCatalog(): Promise<TfsToolCatalogView>;
    /**
     * 需求完成回写（问题 4）：触发 / 重跑自动回写并返回报告。
     * `force=true` 时允许对已回写过的需求重新执行（幂等，已成功项跳过）。
     */
    writeBackRequirement(input: {
        requirementKey: string;
        force?: boolean;
    }): Promise<{
        ok: boolean;
        reason?: string;
        report?: RequirementWriteBackReport;
    }>;
    /**
     * spec 010：确保需求有编排主 agent 会话（幂等）。
     *
     * 任务中心右侧「主对话框」的「创建编排会话」按钮用它；`ok=false` 时 `reason` 是
     * **可读降级原因**（provider 不支持 continuable / 宿主无 subagents 服务 / 配置关闭），
     * 面板如实展示，不伪装成功。
     */
    /**
     * 确保焦点需求存在编排主 agent 会话。
     *
     * @param requirementKey - 需求去重键 `id@collection`。
     * @param force - 面板「创建编排会话」按钮传 true：宿主即便此前判过 `off` 也会再试一次，
     *   编排会话 id 陈旧时也会重建（幂等复用是 `force` 为 false 时的默认行为）。
     */
    orchestratorEnsure(requirementKey: string, force?: boolean): Promise<OrchestratorEnsureResult>;
}
/**
 * 客户端半 → 宿主半的 HTTP 路由路径（Phase 3 真实通道，对齐 dsh-optimized-prompt 的
 * `/optimized-prompt/*` 模式：客户端 `fetch` → 宿主 `webServer.register`）。路径为编译期常量，
 * 两侧必须一致；放在共享契约里避免两端各写一份、配置一改就分家。
 */
export declare const TFS_ROUTES: {
    /** GET 取面板静态数据。 */
    readonly panelData: "/tfs-requirment/panel-data";
    /** POST 确认回写（tag/comment/state）。 */
    readonly confirmWrite: "/tfs-requirment/confirm-write";
    /** POST 发起执行（按角色派发 subagent）。 */
    readonly dispatch: "/tfs-requirment/dispatch";
    /**
     * POST 需求池列表（US2）。
     *
     * 用 POST 而非 GET：筛选条件含 projects/types/states/assignedTo 等数组与关键字，放在 query
     * string 上易超长且需重复转义；请求体承载 {@link RequirementFilter}，返回 {@link RequirementListResult}。
     */
    readonly requirements: "/tfs-requirment/requirements";
    /** GET 需求筛选可选项（问题 3：项目/类型/状态/指派人；命中宿主进程内缓存则不重采）。 */
    readonly queryOptions: "/tfs-requirment/query-options";
    /**
     * POST 强制重采需求筛选可选项（绕过缓存）。
     *
     * 用 POST 而非 GET：它有**副作用**（丢弃缓存并重新拉取 TFS 元数据），
     * 放在 GET 上会让任何预取/重试链路意外触发整轮元数据采集。
     */
    readonly queryOptionsRefresh: "/tfs-requirment/query-options-refresh";
    /** GET 角色清单（US5）。 */
    readonly roles: "/tfs-requirment/roles";
    /** POST 保存/更新角色（US5）。 */
    readonly roleSave: "/tfs-requirment/role-save";
    /** POST 删除角色（US5；被引用时需 force）。 */
    readonly roleDelete: "/tfs-requirment/role-delete";
    /** GET 技能/MCP 分组清单（2026-11-03 用户诉求）。 */
    readonly skillGroups: "/tfs-requirment/skill-groups";
    /** POST 保存/更新技能/MCP 分组。 */
    readonly skillGroupSave: "/tfs-requirment/skill-group-save";
    /** POST 删除技能/MCP 分组。 */
    readonly skillGroupDelete: "/tfs-requirment/skill-group-delete";
    /** GET 看板快照（US3 任务中心 / US6 恢复）。 */
    readonly board: "/tfs-requirment/board";
    /** POST 领取需求入本地池（US2 / T036）+ 打 dsh 标签（T048）。 */
    readonly claim: "/tfs-requirment/claim";
    /** POST 拆解需求为任务（US3 / T041）。 */
    readonly decompose: "/tfs-requirment/decompose";
    /** POST 指派任务角色（US3 / T042）。 */
    readonly taskAssign: "/tfs-requirment/task-assign";
    /** POST 任务状态操作 启动/完成/重试/取消（US3 / T043）。 */
    readonly taskState: "/tfs-requirment/task-state";
    /** GET 连通性自检（US1 / T029 测试连接）。 */
    readonly health: "/tfs-requirment/health";
    /** GET 审计状态（T063）。 */
    readonly audit: "/tfs-requirment/audit";
    /** POST 执行审计滚动归档（T063）。 */
    readonly auditArchive: "/tfs-requirment/audit-archive";
    /** POST 切换默认集合（T030 / FR-003）。 */
    readonly collection: "/tfs-requirment/collection";
    /** GET 连接档案清单（T031；不含 PAT）。 */
    readonly profiles: "/tfs-requirment/profiles";
    /** POST 保存/更新连接档案（T031）。 */
    readonly profileSave: "/tfs-requirment/profile-save";
    /** POST 删除连接档案（T031）。 */
    readonly profileDelete: "/tfs-requirment/profile-delete";
    /** POST 设为活动档案（T031）。 */
    readonly profileActivate: "/tfs-requirment/profile-activate";
    /** GET MCP 接入模板 + 实例诊断（T028b）。 */
    readonly mcpInstance: "/tfs-requirment/mcp-instance";
    /** POST 写出 MCP 启动环境文件（T028b）。 */
    readonly mcpEnvFile: "/tfs-requirment/mcp-env-file";
    /** GET 本插件的能力目录（问题 8 / 12）。 */
    readonly tfsTools: "/tfs-requirment/tfs-tools";
    /**
     * POST 强制重采 DSH 能力目录（模型 / 技能 / 预设 / 工作区 / provider / MCP）。
     *
     * 存在的理由：目录在 `apply` 期只采一次，而用户可能**先打开插件、后配置模型**
     * （如新增 provider key、装新技能、加新 MCP server）。没有这条路由，UI 拿到的永远是
     * 首次采集的空/旧快照 —— 表现为"下拉里没有我刚配的模型"，且用户无法自救。
     * 该路由让"执行配置"标签页的刷新按钮真正触发重采，而不是只重读同一份内存快照。
     */
    readonly catalogRefresh: "/tfs-requirment/catalog-refresh";
    /** GET 读本地落盘的需求池可选项（问题 1；无缓存返回 data:null）。 */
    readonly queryOptionsLoad: "/tfs-requirment/query-options-load";
    /** POST 强制重采需求池可选项并落盘覆盖（问题 1「采集可选项」）。 */
    readonly queryOptionsCollect: "/tfs-requirment/query-options-collect";
    /** GET/POST UI 状态（筛选/每页条数，问题 2/4/6）。 */
    readonly uiState: "/tfs-requirment/ui-state";
    /** POST 还原已领取需求回需求池（问题 7）。 */
    readonly requirementRestore: "/tfs-requirment/requirement-restore";
    /** POST 实时重取需求四段描述并回写看板（问题 11）。 */
    readonly requirementEnrich: "/tfs-requirment/requirement-enrich";
    /** POST 删除已取消任务（问题 8，批量）。 */
    readonly taskDelete: "/tfs-requirment/task-delete";
    /** POST 编辑已领取需求本地字段（问题 3：提示词 / 工作目录）。 */
    readonly requirementUpdate: "/tfs-requirment/requirement-update";
    /** POST 设置需求级执行状态（问题 5：确认完成 / 取消完成）。 */
    readonly requirementExecState: "/tfs-requirment/requirement-exec-state";
    /** POST 编辑任务字段（问题 4：提示词 / 模型 / 技能 / MCP / 工作目录）。 */
    readonly taskUpdate: "/tfs-requirment/task-update";
    /** GET 任务执行过程轨迹（spec 006 US2；query：taskId、attempt?）。 */
    readonly taskTrace: "/tfs-requirment/task-trace";
    /** POST 对任务追问 / 补充指令（spec 006 US3；body：FollowUpTaskInput）。 */
    readonly taskFollowUp: "/tfs-requirment/task-follow-up";
    /**
     * POST 需求完成自动回写（问题 4；body：{ requirementKey, force? }）。
     *
     * 全部任务完成时宿主会自动调用一次；此路由用于：① 自动回写关闭时的"手动回写"入口；
     * ② 部分失败后的"重新回写"（幂等，已成功的项跳过）。GET（query requirementKey）只读回写报告。
     */
    readonly requirementWriteBack: "/tfs-requirment/requirement-write-back";
    /**
     * POST 确保需求有编排主 agent 会话（spec 010 US1；body：{ requirementKey }）。
     *
     * 幂等：已存在 continuable 编排会话时直接返回既有上下文，不重复创建。
     * provider 不支持 / 宿主不可用 ⇒ 返回 `mode:'off'` + 可读 `reason`（fail-loud，不静默）。
     */
    readonly orchestratorEnsure: "/tfs-requirment/orchestrator-ensure";
    /**
     * POST 开始编排（2026-11-03 问题 4/5）。
     * body：{ requirementKey, mode: 'now' | 'at', dueAt?, sequential? }。
     * 'at' = 登记定时（精确到分，持久化 + 重启补跑）；'now' = 立刻按依赖顺序启动子 Agent 链。
     */
    readonly orchestrationStart: "/tfs-requirment/orchestration-start";
    /** GET 定时执行条目清单（问题 4/5）。 */
    readonly schedules: "/tfs-requirment/schedules";
    /** POST 取消一条定时执行（body：{ id }）。 */
    readonly scheduleCancel: "/tfs-requirment/schedule-cancel";
    /** POST 修改定时执行的到点时刻（body：{ id, dueAt }，2026-11-03 问题 3）。 */
    readonly scheduleUpdate: "/tfs-requirment/schedule-update";
};
/** spec 010：创建/取回编排主 agent 会话的入参。 */
export interface OrchestratorEnsureInput {
    /** 需求去重键 `id@collection`。 */
    requirementKey: string;
    /** 是否强制重建（编排会话失效时用；默认 false = 幂等复用）。 */
    force?: boolean;
}
/** spec 010：编排会话确保结果。 */
export interface OrchestratorEnsureResult {
    ok: boolean;
    /** 编排上下文（含会话 id / 父会话 id / 简报 / 降级原因）。 */
    orchestration?: RequirementOrchestrationView;
    /** 失败原因。 */
    reason?: string;
}
/**
 * 需求池列表项（客户端半渲染用）。
 *
 * 字段来自 `GET /_apis/wit/workitems?ids=` **归一化后**的工作项形状（T013 实测，形状沿用旧
 * `tfs_get_workitem` 的扁平产出以保持不变）：适配层已把原始 TFS 字段引用（`System.Title` 等）
 * 与 Winning 自定义字段转成一组扁平字段，业务层据此映射，不直接打 REST。
 */
export interface RequirementSummary {
    /** 工作项 ID。 */
    id: number;
    /** 所属集合（去重键右半，S-01）。 */
    collection: string;
    /** 所属项目。 */
    project: string;
    /** 标题。 */
    title: string;
    /**
     * 需求正文（**已由宿主半从 TFS 的 HTML 富文本转为可读纯文本**）。
     *
     * 来源：`System.Description`。客户端半不做 HTML 解析——转换在 `normalizeWorkItem` 里
     * 经 `src/shared/text.ts#htmlToPlainText` 完成，故此处必已是干净文本。
     * 可选：TFS 上正文可为空，且历史 `board.json` 没有该字段（须能正常反序列化）。
     *
     * 用途：US3「选为目标」时自动带出需求内容，免去复制粘贴。
     */
    description?: string;
    /**
     * 需求分析（Winning「需求」类型自定义字段 `Winning.Demand.Analysis`，HTML 已转纯文本）。
     *
     * 2026-09-20 探针实测字段引用名（`/_apis/wit/workitemtypes/需求/fields`）：
     * 详细信息=`System.Description`、需求分析=`Winning.Demand.Analysis`、
     * 数据结构=`Winning.Data.Design`、需求配置=`Winning.Demand.Config`。
     * 可选：非「需求」类型或字段为空时不存在；历史 board.json 没有这些字段（须能反序列化）。
     */
    analysis?: string;
    /** 数据结构（`Winning.Data.Design`，HTML 已转纯文本）。 */
    dataStructure?: string;
    /** 需求配置（`Winning.Demand.Config`，HTML 已转纯文本）。 */
    config?: string;
    /** 工作项类型（显示名，如「产品或项目计划」）。 */
    type: string;
    /** TFS 状态（实测值，非枚举）。 */
    state: string;
    /** 指派给（形如 `ysh（杨善辉） <WINNING\ysh>`）。 */
    assignedTo: string;
    /** 优先级。 */
    priority: string;
    /** 区域路径。 */
    areaPath: string;
    /** 迭代路径。 */
    iterationPath: string;
    /** 标签集合（TFS 以分号拼接字符串返回，适配层已拆分为数组）。 */
    tags: string[];
    /** 更新时间 ISO（增量更新判定，S-14）。 */
    changedDate: string;
    /** 工作项 REST URL。 */
    url: string;
    /**
     * 本地代码库绝对路径（**本地补充字段，非 TFS 字段**）。
     *
     * 领取需求时可指定；拆解时由任务继承，派发时写进子代理 prompt（"代码库位于 X"）。
     * **能力边界**：宿主不支持按请求指定子代理 cwd（只能由部署 override 或父会话 workspace 决定），
     * 故本字段是**任务上下文**，不改变子代理进程工作目录。
     */
    workspace?: string;
    /**
     * 需求级执行提示词（问题 3/6，**本地补充字段，非 TFS 字段**）。
     *
     * 领取入池或编辑已领取需求时填写；派发子任务时由宿主实时读取并拼在任务级提示词之前。
     */
    prompt?: string;
    /**
     * 需求级执行状态（问题 3/4，**本地补充字段，非 TFS 字段**）。
     *
     * `'completed'` = 该需求名下全部任务均已完成（自动迁移，或人工确认），UI 据此把它
     * 从「任务中心」迁到「已完成」页；缺省/未提供一律按 `'active'` 渲染（历史 board.json 无此键）。
     */
    execState?: 'active' | 'completed';
    /** 置为已完成的时间（ISO，问题 3；仅 execState='completed' 时有值）。 */
    completedAt?: string;
    /**
     * 需求完成后的 TFS 自动回写结果（问题 4，**本地补充字段，非 TFS 字段**）。
     *
     * 全部任务完成（且无待人工确认任务）后由宿主自动回写；缺省表示尚未回写。
     * UI 据此在「已完成」页展示回写明细 / 失败项，并提供"重新回写"入口。
     */
    writeBack?: RequirementWriteBackReport;
    /**
     * 需求级编排上下文（spec 010，**本地补充字段，非 TFS 字段**）。
     *
     * 承载「编排主 agent 会话 id」与「共享简报」。缺省 = 该需求从未启用编排
     * （历史 `board.json` 无此键），行为与 010 之前完全一致。
     */
    orchestration?: RequirementOrchestrationView;
}
/**
 * 编排模式。
 *
 * - `'continuable'`：已有（或可创建）编排主 agent 的持久子会话，归纳与最终总结由主 agent 产出；
 * - `'off'`：宿主 provider 不支持 continuable、或编排会话创建/观测连续失败 ⇒ **fail-loud 降级**。
 *   此时归纳退化为"无摘要"、最终总结退化为既有模板文案，任务链路**照常跑完**。
 */
export type OrchestrationMode = 'continuable' | 'off';
/** 任务归纳状态（供 UI 与降级判定；`pending` 表示已发出但尚未拿到主 agent 回复）。 */
export type TaskSummaryState = 'pending' | 'done' | 'failed' | 'timeout' | 'skipped';
/**
 * 需求级编排上下文（spec 010）。
 *
 * 全部字段可选：旧看板没有该对象 ⇒ 无编排、无简报，语义与 010 前一致。
 */
export interface RequirementOrchestrationView {
    /** 编排模式；缺省按 `'off'` 处理（未启用）。 */
    mode: OrchestrationMode;
    /** 编排主 agent 的持久子会话 id（continuable childId）。 */
    orchestratorSessionId?: string;
    /** 派生编排会话的父会话 id（构造子会话对话地址需要，见 `shared/chat-address.ts`）。 */
    parentSessionId?: string;
    /** 降级原因（`mode='off'` 时给出，UI 如实展示，不静默）。 */
    reason?: string;
    /** 共享简报（US3）。 */
    brief?: RequirementBrief;
    /**
     * 任务子会话复用表：`复用键 → 持久子会话 id`（AC3.3）。
     *
     * 复用键 = `需求键|provider|preset`。同一键的连续任务复用同一 continuable 子会话，
     * 后续任务以 inbox 消息续跑，避免每个任务都从零理解需求。
     */
    taskSessions?: Record<string, string>;
}
/** 任务级编排上下文（spec 010）。 */
export interface TaskOrchestrationView {
    /** 该任务当前/最近使用的子会话 id（复用会话 = 持久 childId；one-shot = attempt.runId）。 */
    sessionId?: string;
    /** 该任务是否复用了既有子会话（续跑），而非新建。 */
    reused?: boolean;
    /** 编排主 agent 归纳出的结论摘要。 */
    summary?: string;
    /** 归纳状态。 */
    summaryState?: TaskSummaryState;
    /** 主 agent 扫尾轮数（2026-11-03 问题 7；超上限转主 agent 亲做）。 */
    sweepRound?: number;
}
/**
 * 需求完成自动回写的**单项结果**（问题 4）。
 * 每一项都是一次对 TFS 的具体写操作，逐项记录成功/失败/跳过，失败不阻断其余项。
 */
export interface WriteBackItemResult {
    /** 回写项类别：需求字段 / 结论评论 / 产物附件 / 关联人员任务。 */
    kind: 'field' | 'comment' | 'attachment' | 'linked-task';
    /** 人类可读的目标描述（字段名 / 附件名 / 关联任务 id 与标题）。 */
    target: string;
    status: 'ok' | 'skipped' | 'error';
    /** 失败/跳过原因（status≠ok 时）。 */
    reason?: string;
}
/**
 * 需求完成自动回写的完整报告（问题 4）。
 *
 * 触发：需求下全部任务完成（无待人工确认）后，宿主把
 *   ① 需求评审 `Microsoft.VSTS.Common.RequirementReview` 置为"评审通过"；
 *   ② 需求自测 `Microsoft.VSTS.Common.RequirementTest` 置为"自测通过"；
 *   ③ 各任务重要结论汇总为一条评论（System.History）；
 *   ④ 关键产物上传为需求附件；
 *   ⑤ 需求关联的人员任务置为"已解决"，`Microsoft.VSTS.Scheduling.FinishDate` = 明天。
 * 全程幂等（每类操作带幂等键），可安全"重新回写"。
 */
export interface RequirementWriteBackReport {
    /** 整体状态：进行中 / 全部成功 / 部分失败 / 全部失败。 */
    status: 'running' | 'ok' | 'partial' | 'error';
    /** 最近一次回写时间（ISO）。 */
    at: string;
    /** 逐项结果。 */
    items: WriteBackItemResult[];
    /** 成功上传的附件名清单（便于 UI 展示）。 */
    attachments?: string[];
    /** 汇总说明 / 顶层失败原因。 */
    summary?: string;
}
/**
 * 需求池筛选条件（宿主半映射为 WIQL 条件；REST 化后由适配层直连 `POST /_apis/wit/wiql`）。
 *
 * ## 2026-09-18 改为多值（用户反馈 3）
 *
 * 原设计四项（项目/状态/指派给）都是**单值字符串**，实际用起来只能一次筛一个项目、
 * 一个状态、一个人，与"我要看这几个项目的所有进行中需求"这种真实诉求对不上。
 * 现改为数组语义：
 *   - **空数组或未传 = 不限**（不是"筛空"）；
 *   - 多值之间是 **OR**（同一字段内），字段之间是 **AND**；
 *   - `assignedTo` 未传时由宿主半填入**当前 PAT 用户**（"默认看自己的"）；
 *   - 工作项类型原先根本没有筛选项，现补上 `types`。
 *
 * 为兼容既有单值调用方（含测试），保留 `project` / `state` 两个单值别名；
 * 宿主半会把它并入对应数组（单值别名与数组都传时以数组为准）。
 */
export interface RequirementFilter {
    /** 集合；缺省用插件默认集合。 */
    collection?: string;
    /** 项目，多选（OR）。空/未传 = 不限。 */
    projects?: string[];
    /** 工作项类型，多选（OR）。空/未传 = 全部类型。 */
    types?: string[];
    /** 状态，多选（OR）。空/未传 = 全部状态。 */
    states?: string[];
    /** 指派给，多选（OR）。**未传** = 宿主半填当前 PAT 用户；传空数组 = 显式不限。 */
    assignedTo?: string[];
    /** 关键字（标题包含）。 */
    keyword?: string;
    /** 返回条数上限（默认 20）。 */
    top?: number;
    /** 分页偏移。 */
    skip?: number;
    /** @deprecated 单值别名，等价于 `projects: [project]`。 */
    project?: string;
    /** @deprecated 单值别名，等价于 `states: [state]`。 */
    state?: string;
}
/**
 * 一个筛选选项（`value` 为查询用的真实值，`label` 为展示名）。
 *
 * 为何要区分：TFS 里项目名与显示名可能不同，工作项类型的显示名也不等于查询值。
 * 混用会让"界面上选的是显示名、查询用的是显示名"这种错误在 TFS 2018 上静默返回空集。
 */
export interface NamedOption {
    value: string;
    label: string;
}
/** 需求筛选的可选项（问题 3；由宿主半从真实 TFS 采集）。 */
export interface RequirementQueryOptions {
    projects: NamedOption[];
    types: NamedOption[];
    states: NamedOption[];
    assignees: NamedOption[];
    /** 默认指派人（当前 PAT 身份对应的 TFS 账号名），UI 据默认勾选。 */
    defaultAssignee?: string;
    /** 采集失败/降级的可读原因（空表示全部成功）。 */
    reason?: string;
    /** 采集时刻（ISO）。 */
    collectedAt?: string;
}
/** 需求池查询结果（失败时 ok=false 且给出可读原因，UI 据此提示而非静默空列表）。 */
export interface RequirementListResult {
    ok: boolean;
    items: RequirementSummary[];
    reason?: string;
    /** 命中总数（宿主若能提供）。 */
    total?: number;
}
/**
 * 单次执行尝试的可序列化视图（spec 006 US2）。
 *
 * 对应宿主半 `AttemptRecord`；新增的 runId/stopReason/diagnostic/output 均为可选，
 * 升级前的历史 board.json 反序列化时这些字段缺失也能正常渲染。
 */
export interface TaskAttemptView {
    /** 开始时间 ISO。 */
    startedAt: string;
    /** 结束时间 ISO（运行中缺省）。 */
    endedAt?: string;
    /** 执行链路态：queued/running/success/failed/cancelled。 */
    outcome: string;
    /** 备注（失败原因等）。 */
    note?: string;
    /** 本次尝试对应的子 agent 会话 id（SubagentRun.id），用于读取执行轨迹。 */
    runId?: string;
    /** 子 run 落定原因（completed/error/refusal/max-tokens/aborted）。 */
    stopReason?: string;
    /** 非 completed 落定时宿主给出的失败诊断（Provider-authored，已限长，不含工具入参/凭据）。 */
    diagnostic?: string;
    /** 最终助手输出摘要（文本，已截断）。 */
    output?: string;
}
/**
 * 看板任务视图（客户端半渲染用）。
 *
 * 这是宿主半 `TaskSnapshot`（`core/board/task.ts`）的**可序列化镜像**：只保留 UI 需要的字段，
 * 不让客户端半 import 宿主半模块（那样会拉入 `node:fs`，客户端半类型检查会失败）。
 */
export interface BoardTaskView {
    taskId: string;
    /** 所属需求去重键 `id@collection`。 */
    requirementId: string;
    title: string;
    description: string;
    /** 指派角色展示名。 */
    roleAgent: string;
    /** 看板四态。 */
    state: 'pending' | 'in_progress' | 'completed' | 'deleted';
    /** 执行链路态：queued/running/success/failed/cancelled。 */
    execState: string;
    /** DAG 依赖（被阻断的任务 ID）。 */
    blockedBy: string[];
    /** 本地代码库绝对路径（由所属需求继承；本地补充字段，非 TFS 字段）。 */
    workspace?: string;
    /** 任务级执行提示词（本地补充字段，非 TFS 字段）。 */
    prompt?: string;
    /** 乐观锁版本。 */
    revision: number;
    /** 冻结配置（模型 / MCP / 技能）。 */
    frozenConfig: FrozenConfig;
    /** 尝试次数（断点重试 S-07）。 */
    attemptCount: number;
    /** 最后一次尝试的备注（失败原因等）。 */
    lastNote?: string;
    /** 全部执行尝试明细（spec 006：任务详情页据此渲染每次执行与 runId/诊断）。 */
    attempts: TaskAttemptView[];
    /** 是否由"自动链式执行"派发（问题 6；UI 标注"自动续跑"，手动启动的任务无此键）。 */
    autoLaunched?: boolean;
    /** 关键产物的本地绝对路径（问题 4：完成回写时上传为需求附件的候选文件）。 */
    artifactPaths?: string[];
    /**
     * 任务级编排上下文（spec 010）：该任务使用的子会话 id、是否复用、主 agent 归纳的结论。
     *
     * 客户端半据此在「主对话框」的切换条里给出"切到该任务子会话"的入口。
     * 缺省 = 无编排信息（历史看板 / 未启用编排）。
     */
    orchestration?: TaskOrchestrationView;
}
/** 任务尝试的执行链路态（问题 5 新增 needs_confirmation：等待人工确认，看板态保持 in_progress）。 */
export type TaskExecOutcome = 'queued' | 'running' | 'success' | 'failed' | 'cancelled' | 'needs_confirmation';
/** 看板快照（US3 任务中心 / US6 恢复）。 */
export interface BoardSnapshotView {
    ok: boolean;
    reason?: string;
    /** 快照版本（乐观锁）。 */
    version: number;
    updatedAt: string;
    /** 已领取的需求（本地池权威副本）。 */
    requirements: RequirementSummary[];
    tasks: BoardTaskView[];
    /** 渲染出的 Markdown 看板路径（若已渲染）。 */
    markdownViewPath?: string;
    /** 计数摘要（UI 角标用）。 */
    counts: {
        pending: number;
        inProgress: number;
        completed: number;
        /** 并发器当前运行中 run 数。 */
        running: number;
        /** 并发器当前排队数（S-06 可见性）。 */
        queued: number;
    };
}
/**
 * 任务操作动作（T043 启动 / 完成 / 失败 / 重试 / 取消；问题 5 新增 confirm）。
 *
 * `confirm` = 人工确认通过：把一条 `needs_confirmation`（子 agent 输出"请人工确认"）的任务
 * 收口为完成，随后才允许自动链式执行其下游、并触发需求完成回写。
 */
export type TaskAction = 'start' | 'complete' | 'fail' | 'retry' | 'cancel' | 'confirm';
/** 工具调用类别（时间线 UI 据此打标签/图标）。 */
export type TraceToolKind = 'mcp' | 'skill' | 'tool';
/** 执行时间线的单条条目（由宿主 sessionQuery 事件映射，全部 JSON 可序列化、文本已截断）。 */
export type TaskTraceEntry = {
    kind: 'turn';
    /** turn 序号。 */
    turn: number;
    /** 开始 / 结束。 */
    phase: 'start' | 'end';
    /** turn 结束原因（结束时可能有）。 */
    reason?: string;
    /** 事件时间（Unix ms）。 */
    time?: number;
} | {
    kind: 'user';
    /** 用户/注入指令文本。 */
    text: string;
    time?: number;
} | {
    kind: 'assistant';
    /** 助手输出的可见文本（可能为空串：该步仅思考或仅发起工具调用）。 */
    text: string;
    /** 助手的思考 / reasoning 内容（type:'reasoning' 块，已截断；默认折叠展示）。 */
    thinking?: string;
    /** 是否为被中断的输出前缀。 */
    interrupted?: boolean;
    time?: number;
} | {
    kind: 'tool';
    /** 工具调用 id（与结果配对）。 */
    callId: string;
    /** 工具全名（MCP 形如 mcp__<server>__<tool>）。 */
    name: string;
    /** 类别：MCP / 技能 / 普通工具。 */
    toolKind: TraceToolKind;
    /** 原始入参 JSON 字符串（已截断）。 */
    args: string;
    /** 调用状态：已调用待结果 / 成功 / 失败。 */
    status: 'running' | 'ok' | 'error';
    /** 成功结果文本（已截断）。 */
    result?: string;
    /** 失败原因（tool/result.error.reason 或结果块 isError 文本）。 */
    error?: string;
    /** 调用耗时（结果时间 - 调用时间，毫秒；未配对结果时缺省）。 */
    durationMs?: number;
    turn?: number;
    step?: number;
    time?: number;
};
/**
 * 一次任务执行的**聚合统计**（问题 2，参考 dsh-context 的上下文统计思路）。
 *
 * 与时间线（{@link TaskTraceEntry}）互补：时间线回答"每一步发生了什么"，统计回答
 * "这次执行一共发了多少次模型请求、烧了多少 token、调了多少工具、有没有重复请求"。
 * 全部由宿主从**完整会话事件**（而非可能被截断的时间线）聚合，故即使时间线截断，
 * 计数仍是全量的。
 */
export interface TaskTraceStats {
    /** 模型请求次数（= step/start 数，一次"模型思考 + 工具执行"算一次请求）。 */
    modelRequests: number;
    /** 对话轮次数（turn/start 数）。 */
    turns: number;
    /** 人工/注入输入条数（user/message 数）。 */
    userInputs: number;
    /** 助手消息条数（assistant/message 数）。 */
    assistantMessages: number;
    /** 工具调用总次数（tool/call 数）。 */
    toolCalls: number;
    /** 按类别统计的工具调用次数。 */
    toolByKind: Record<TraceToolKind, number>;
    /** 工具调用结果计数：成功 / 失败 / 仍在运行（未配对结果）。 */
    toolOk: number;
    toolError: number;
    toolRunning: number;
    /** 工具调用总耗时（毫秒，已配对结果的调用之和）。 */
    toolDurationMs: number;
    /**
     * 每个工具的调用明细（按调用次数降序），用于发现"哪个工具被反复调用"。
     */
    toolBreakdown: Array<{
        name: string;
        kind: TraceToolKind;
        count: number;
        ok: number;
        error: number;
        /** 同名 + 完全相同入参被调用的最大重复次数（≥2 即疑似重复请求，问题 1 可见性）。 */
        duplicate: number;
    }>;
    /**
     * 疑似重复请求告警（同名 + 同入参出现 ≥2 次），按重复次数降序，最多保留若干条。
     * 这是"避免重复请求相同内容"在 UI 上的抓手：用户能直接看到子 agent 重复读了什么。
     */
    repeatedCalls: Array<{
        name: string;
        args: string;
        count: number;
    }>;
    /** 累计 token 用量（来自每步 assistant/message 的 usage 之和；缺失则为 0）。 */
    tokens: {
        input: number;
        output: number;
        /** 缓存命中读取的 prompt token。 */
        cacheRead: number;
        /** 写缓存的 prompt token。 */
        cacheWrite: number;
        /** 推理（thinking）token。 */
        reasoning: number;
        /** 总计 = input + output（缓存 token 已计入 input，不重复相加）。 */
        total: number;
    };
    /** 首个事件时间（Unix ms）。 */
    startedAt?: number;
    /** 末个事件时间（Unix ms）。 */
    endedAt?: number;
    /** 端到端运行时长（毫秒）。 */
    durationMs?: number;
}
/** 一次任务执行轨迹读取结果（业务不可用也返回 200 + ok:true，用 available 表达降级）。 */
export interface TaskTraceResult {
    ok: boolean;
    /** 任务 ID。 */
    taskId: string;
    /** 尝试序号（从 0 开始）。 */
    attempt: number;
    /** 该尝试对应的子会话 id（无则缺省）。 */
    runId?: string;
    /** 是否成功取到会话事件；false 时 entries 为空且 reason 说明原因（无 runId / sessionQuery 缺失 / 会话不可读）。 */
    available: boolean;
    /** 子会话是否仍在运行（观察来源为 live 视为运行中）。 */
    running?: boolean;
    /** 观察来源：live=活动会话，prepared=冷读持久化日志。 */
    source?: 'live' | 'prepared';
    /** 会话日志游标（最后事件 seq）。 */
    cursor?: number;
    /** 时间线条目（按 seq 升序）。 */
    entries: TaskTraceEntry[];
    /** 聚合统计（问题 2：请求次数 / token / 工具调用 / 重复请求；available=false 时缺省）。 */
    stats?: TaskTraceStats;
    /** 是否因事件过多而丢弃过中间条目（保留首轮指令 + 最近尾部）。 */
    truncated?: boolean;
    /** 截断前映射出的条目总数。 */
    total?: number;
    /** 降级/不可用原因。 */
    reason?: string;
}
/** 任务追问入参（spec 006 US3：同任务同配置发起一轮新执行）。 */
export interface FollowUpTaskInput {
    taskId: string;
    /** 追问 / 补充指令文本。 */
    message: string;
}
/** 任务追问结果。 */
export interface FollowUpTaskResult {
    ok: boolean;
    reason?: string;
    /** 新一轮子 run 的会话 id。 */
    runId?: string;
    /** 新一轮对应的尝试序号。 */
    attempt?: number;
    /** 收口后该任务的最新视图（便于 UI 就地刷新）。 */
    task?: BoardTaskView;
}
/** 领取需求入参：可给完整摘要，也可只给 id+collection（此时宿主按可用读路径补全）。 */
export interface ClaimRequirementInput {
    /** 完整需求摘要（需求池「领取」按钮直传）。 */
    requirement?: RequirementSummary;
    /** 仅有 id 时（「按 ID 添加」），宿主经 `tfs_get_workitem` 补全。 */
    id?: number;
    collection?: string;
    /**
     * 本地代码库绝对路径（可选；**本地补充字段，非 TFS 字段**）。
     *
     * 须为绝对路径且指向真实存在的目录，否则拒收（fail loud，与宿主 `assertUsableCwd` 同哲学）。
     * 供角色智能体定位代码、供看板显示；**不改变子代理进程 cwd**（宿主能力边界）。
     */
    workspace?: string;
    /**
     * 需求级执行提示词（问题 6：领取弹框里填写的"增加提示词"）。
     *
     * 与 `workspace` 同纪律：本地补充字段，随需求落 `board.json`；派发子任务时被
     * `host/api.ts#dispatch` 实时读取并拼在任务级提示词之前。
     */
    prompt?: string;
    /**
     * 是否同时打 `dsh` 标签（T048：进入队列即打标签，幂等 S-08）。
     * 缺省 true；标签写失败**不**使领取失败（FR-014：失败/取消/中断保留本地池条目）。
     */
    tag?: boolean;
}
/** 领取结果。 */
export interface ClaimRequirementResult {
    ok: boolean;
    /** true = 新增入池；false = 已存在（S-01 去重，幂等）。 */
    added: boolean;
    /** 入池后的需求（补全后）。 */
    requirement?: RequirementSummary;
    /** 打标签结果（T048）。 */
    tag?: {
        ok: boolean;
        reason?: string;
    };
    reason?: string;
}
/** 通用任务操作结果。 */
export interface TaskOpResult {
    ok: boolean;
    reason?: string;
    /** 受影响任务的当前快照（操作成功后返回，便于 UI 就地更新）。 */
    task?: BoardTaskView;
}
/** 连通性自检结果（T029 测试连接）。 */
export interface HealthResult {
    ok: boolean;
    /** `tfs_whoami` 返回的身份摘要。 */
    identity?: string;
    /** 当前集合名。 */
    collection?: string;
    /** 可见项目数。 */
    projectCount?: number;
    /** 失败归类：认证 / 地址 / 权限 / 未知（T029）。 */
    kind?: 'auth' | 'address' | 'permission' | 'unknown';
    /** 可读原因（**保证不含凭据片段**，T029/CHK002）。 */
    reason?: string;
    /**
     * 传输层告警（不含凭据片段）。
     *
     * 目前只有一条：基址是 `http:`，PAT 仅 base64 编码（可逆）过网。自检结论仍按实际
     * 探测结果给（连通就是连通），但这条告警必须让人看见——否则等于默默用明文信道送凭据。
     */
    notice?: string;
    /** 当前 TFS 操作可用性摘要（T028b MCP 管理区展示）。 */
    tools?: {
        /** 已注册的 `mcp__<server>__*` 工具名（去掉前缀）。 */
        available: string[];
        /** 本插件期望但当前缺失的工具名（能力降级可见）。 */
        missing: string[];
    };
}
/** 审计状态视图（客户端「连接与凭据」页展示）。 */
export interface AuditView {
    ok: boolean;
    /** live `audit.jsonl` 条目总数。 */
    total: number;
    /** 早于保留期、待归档的条目数（>0 表示需要归档）。 */
    expired: number;
    /** 生效的保留天数（来自 `config.auditRetentionDays`，S-03）。 */
    retentionDays: number;
    /** 已有归档文件（按文件名升序）。 */
    archiveFiles: Array<{
        name: string;
        bytes: number;
    }>;
    reason?: string;
}
/** 归档执行结果。 */
export interface ArchiveResult {
    ok: boolean;
    /** 本次实际新写入归档的条目数（重复条目不计）。 */
    archived?: number;
    /** 本次写到的归档文件路径。 */
    archivePath?: string;
    reason?: string;
}
/**
 * 连接档案的**对外视图**。
 *
 * 存在的唯一理由是**锁死"绝不回显 PAT"**：存储层的 `TfsProfile` 带明文 `pat`，
 * 若直接把它当接口返回类型，任何一次 `JSON.stringify` 都会把 PAT 送进浏览器与日志。
 * 故接口层只允许出现本类型（无 `pat` 字段，类型系统即防线）。
 */
export interface ProfileView {
    id: string;
    name: string;
    /** 服务地址（不含集合）。 */
    url: string;
    /** 默认集合。 */
    collection: string;
}
/** 保存档案入参（更新既有档案时 `pat` 可省略，表示沿用原 PAT）。 */
export interface ProfileSaveInput {
    /** 缺省时新建档案（服务端生成 id）。 */
    id?: string;
    name: string;
    url: string;
    collection: string;
    pat?: string;
}
/** 档案清单结果（含活动档案指针，便于 UI 标注"当前使用"）。 */
export interface ProfileListResult {
    ok: boolean;
    profiles: ProfileView[];
    /** 活动档案 id；无则缺省。 */
    activeId?: string;
    reason?: string;
}
/** 档案操作结果（`profile` 永不含 PAT）。 */
export interface ProfileOpResult {
    ok: boolean;
    reason?: string;
    profile?: ProfileView;
}
/** 写出环境文件的结果（**永不包含 PAT**）。 */
export interface EnvFileResult {
    ok: boolean;
    path?: string;
    /** 写入字节数。 */
    bytes?: number;
    /** 权限位是否成功收紧为 0600；false = 文件系统不支持该能力（需运维自行收紧）。 */
    hardened?: boolean;
    reason?: string;
}
/** MCP 接入环境模板（PAT 为占位符，可安全展示/复制）。 */
export interface McpEnvTemplate {
    ok: boolean;
    serverName: string;
    /** `serverName` 是否满足宿主 `mcp-client` 的 `^[A-Za-z0-9_-]{1,32}$` 约束。 */
    serverNameValid: boolean;
    /** 模板基于哪个档案生成（缺省活动档案）。 */
    profileId?: string;
    /** 生成出的环境文件绝对路径。 */
    envFilePath: string;
    /** POSIX shell 行（PAT 为占位符）。 */
    posixLines: string[];
    /** PowerShell 行（PAT 为占位符）。 */
    powershellLines: string[];
    /** 为什么必须走"启动前 export"而不是运行期注入（含宿主源码依据）。 */
    note: string;
}
/**
 * MCP 实例诊断（T028b）。
 *
 * ⚠️ **REST 化（2026-09-19）后本类型已名不副实**：它现在是「TFS 连接诊断」的载体。
 * 字段名全部**保留不改**（客户端半、路由与单测都在按这些名字消费，改名等于破坏既有契约），
 * 但语义已变：
 *   - `serverName` **恒为空串**、`serverNameValid` **恒 true**（不再有"MCP 实例名"这个概念）；
 *   - `toolPrefix` 恒为空串；
 *   - `serverNameConstraint` 填的是"不适用"的说明文字；
 *   - `runtimeAddSupported` / `duplicateRisk` / `credentialPath` 讲的是**连接档案**能否运行期
 *     变更、当前活动档案是谁、凭据存在哪。
 * 实现见 `host/profile-service.ts#instance`。
 */
export interface McpInstanceInfo {
    serverName: string;
    serverNameValid: boolean;
    /** 该实例注册的工具名前缀 `mcp__<serverName>__`。 */
    toolPrefix: string;
    /** 宿主是否支持运行期增删 MCP server 实例。实测为 false（源码依据见 `runtimeAddReason`）。 */
    runtimeAddSupported: boolean;
    /** 为何不支持（含 `@deepseek-ai/dsh-mcp-client` 源码位置）。 */
    runtimeAddReason: string;
    /** 宿主对 `serverName` 的约束（正则字面量字符串）。 */
    serverNameConstraint: string;
    /** 同名实例会让实例加载失败的风险说明（含源码位置）。 */
    duplicateRisk: string;
    /** 凭据传入子进程的真实路径说明（含源码位置）。 */
    credentialPath: string;
}
/** MCP 接入一次性结果（实例诊断 + 环境模板）。 */
export interface McpSetup {
    ok: boolean;
    instance: McpInstanceInfo;
    template: McpEnvTemplate;
    reason?: string;
}
/**
 * 一个「本插件封装后的 TFS 操作」的可序列化视图（问题 8 / 12）。
 *
 * 为什么要有这一层视图：
 *   - 宿主半 `src/tfs/tool-catalog.ts` 的 `TfsToolSpec` 带 `Map`/`readonly` 等形态，
 *     且**不在客户端半的编译范围**（客户端半 include 仅 `src/client/**` + `src/shared/**`），
 *     客户端半直接 import 会因路径越界而失败；
 *   - `TfsToolSpec` 里没有"插件工具名"与"分类中文名"（那是 `pluginToolName()`/`CATEGORY_LABELS`
 *     运行期算出来的）。UI 要展示「模型看到的工具名 → 内部由适配层哪条 REST 分支实现」，
 *     这两个字段必须由宿主半算好再下发，客户端半不能自己拼（拼错就会与真实注册名不一致）。
 */
export interface TfsToolWrapView {
    /**
     * 操作键（适配层 `adapter.call(raw, args)` 的分派键）。
     *
     * REST 化后它已与任何 MCP 实例无关，取值保留旧 mcp 工具名形态纯粹是为了让
     * 适配层分支表与历史审计记录不失配。
     */
    raw: string;
    /** 本插件封装后的工具名（模型唯一可见的名字）。 */
    plugin: string;
    /** 中文标题。 */
    title: string;
    /** 分类键。 */
    category: string;
    /** 分类中文名（宿主半算好，客户端半不自行维护映射表）。 */
    categoryLabel: string;
    /** 读写性质：读工具直接透传；写工具过四道写门禁。 */
    access: 'read' | 'write';
    /** 中文说明。 */
    description: string;
    /** 是否为本插件核心链路依赖。 */
    core?: boolean;
    /** 是否为契约表未登记、按名字前缀兜底判定的操作。 */
    unregistered?: boolean;
    /** 契约表已登记，但适配层 `call()` 尚未实现对应 REST 分支（能力缺口可见）。 */
    unimplemented?: boolean;
}
/** 能力目录结果（问题 12：「连接与凭据」页据此展示插件直连 REST 的能力面）。 */
export interface TfsToolCatalogView {
    ok: boolean;
    /** 契约表登记的操作总数。 */
    rawCount: number;
    /** 适配层已实现、真正可用的操作数。 */
    wrappedCount: number;
    tools: TfsToolWrapView[];
    /** 契约表已登记、但适配层未实现 REST 分支的操作数（能力缺口可见）。 */
    missingCount: number;
    reason?: string;
}
/**
 * 需求池可选项的本地落盘文件（问题 1）。
 *
 * 首次采集后原子写入插件私有数据目录 `query-options.json`，按集合命名空间隔离；
 * 每次打开需求池优先读它，不再请求 TFS，点「采集可选项」才重新采集并覆盖。
 */
export type QueryOptionsCacheFile = Record<string, {
    /** 采集到的四类可选项。 */
    data: RequirementQueryOptions;
    /** 落盘时刻 ISO。 */
    savedAt: string;
}>;
/**
 * 面板 UI 状态（问题 2/4/6）：需求池筛选与三个列表的每页条数。
 *
 * 只存"值得跨会话保留"的状态：关键字搜索框、「仅看未入池」、当前页码不持久化。
 */
export interface UiState {
    /** 需求池上次筛选（问题 2：团队项目/工作项类型/状态/指派给，重开面板默认恢复）。 */
    poolFilters?: {
        /** @deprecated 早期单选项目字段，读取时并入 projects。 */
        projectId?: string;
        /** 团队项目（多选，与 UI 一致；projectId 为兼容旧文件的单值别名）。 */
        projects?: string[];
        types?: string[];
        states?: string[];
        assignedTo?: string[];
        /** 「不限指派人」开关（与 assignedTo=[] 的"默认当前 PAT 用户"语义区分）。 */
        assigneeUnlimited?: boolean;
    };
    /** 需求池每页条数（默认 20）。 */
    poolPageSize?: number;
    /** 任务中心「已领取需求」每页条数（默认 10）。 */
    claimedPageSize?: number;
    /** 任务中心「全部任务」表每页条数（默认 20）。 */
    taskPageSize?: number;
    /** 任务中心「已完成」页已领取需求每页条数（问题 2；默认 10）。 */
    donePageSize?: number;
}
/** `ui-state.json` 文件形状：按集合命名空间。 */
export type UiStateFile = Record<string, UiState>;
/** 删除任务结果（问题 8）。 */
export interface DeleteTasksResult {
    ok: boolean;
    /** 实际删除的任务 id。 */
    deleted?: string[];
    /** 删除数量。 */
    count?: number;
    reason?: string;
}
/** 还原需求到需求池的结果（问题 7）。 */
export interface RestoreResult {
    ok: boolean;
    /** 被一并清理的已取消任务 id。 */
    removedTasks?: string[];
    /** TFS dsh 标签移除失败时的可读告警（不阻断还原）。 */
    tagWarning?: string;
    /** continuable 任务子会话释放失败时的可读告警（D4，不阻断还原）。 */
    sessionWarning?: string;
    reason?: string;
}
/** 需求详情补偿结果（问题 11）。 */
export interface EnrichResult {
    ok: boolean;
    requirement?: RequirementSummary;
    reason?: string;
}
/**
 * 编辑已领取需求的本地字段（问题 3）。
 *
 * 只允许改**本地补充字段**（`prompt` / `workspace`）——TFS 侧字段（标题/状态/标签）
 * 属于回写链路，必须走 `confirmWrite` 的四道门禁，不能从这里偷偷改。
 *
 * 语义：字段**不传 = 不动**；传 `null` = **清空**；传字符串 = 设值。
 * （必须区分"不传"与"清空"，否则用户删不掉已填的提示词。）
 */
export interface UpdateRequirementInput {
    /** 需求去重键 `id@collection`。 */
    requirementKey: string;
    /** 本地代码库绝对路径；`null` 清空。fail-loud 校验：绝对路径 + 真实存在且为目录。 */
    workspace?: string | null;
    /** 需求级执行提示词；`null` 清空。 */
    prompt?: string | null;
}
/** 编辑任务字段（问题 4）。 */
export interface UpdateTaskInput {
    taskId: string;
    /** 任务级执行提示词；`null` 清空。 */
    prompt?: string | null;
    /** 工作目录；`null` 清空。 */
    workspace?: string | null;
    /** 模型（写进 `frozenConfig.model`）。 */
    model?: string;
    /**
     * LLM 供应商路由 key（写进 `frozenConfig.modelProvider`，与 model 成对）。
     * 传空串表示清空绑定（随 model 一同回落为继承父会话供应商）。
     */
    modelProvider?: string;
    /** 技能（写进 `frozenConfig.skills`，整体替换）。 */
    skills?: string[];
    /** MCP（写进 `frozenConfig.mcp`，整体替换）。 */
    mcp?: string[];
    /**
     * 工作流技能名（2026-10-29 用户诉求 4；写进 `frozenConfig.workflow`，整体替换）。
     * 传空串表示清空工作流（不启用逐步强制）。取值必须在 `skills` 内（宿主会校验）。
     */
    workflow?: string;
    /**
     * agent preset id（问题 3：未执行任务可改预设）。
     * 写进 `frozenConfig.preset`；传空串表示清空（回落为沿用角色定义）。
     */
    preset?: string;
    /** 委派深度上限（问题 1；写进 `frozenConfig.maxDepth`，0 表示沿用插件默认）。 */
    maxDepth?: number;
    /** 单次输出 token 上限（问题 1；写进 `frozenConfig.maxTokens`，0 表示不设置）。 */
    maxTokens?: number;
    /** 期望 revision（乐观锁；缺省用当前值）。 */
    expectedRevision?: number;
}
/** 需求本地字段编辑结果。 */
export interface UpdateRequirementResult {
    ok: boolean;
    reason?: string;
    /** 更新后的需求（已补全）。 */
    requirement?: RequirementSummary;
}
/**
 * 设置需求级执行状态（问题 5）。
 *
 * `state='active'` = **取消完成**（需求退回「任务中心」，其任务保持原状，
 * 之后若要还原到需求池仍需逐个取消任务）；`state='completed'` = 人工确认完成。
 */
export interface SetRequirementExecStateInput {
    /** 需求去重键 `id@collection`。 */
    requirementKey: string;
    state: 'active' | 'completed';
}
/** 需求级执行状态设置结果。 */
export interface RequirementExecStateResult {
    ok: boolean;
    reason?: string;
    /** 更新后的需求摘要。 */
    requirement?: RequirementSummary;
}
/** 批量派发的一波结果。 */
export interface DispatchBatchWave {
    /** 本波派发的任务 id。 */
    taskIds: string[];
    /** 派发失败的（`taskId → 原因`）。 */
    failures: Array<{
        taskId: string;
        reason: string;
    }>;
}
/** 批量派发结果。 */
export interface DispatchBatchResult {
    ok: boolean;
    /** 成功派发并已收口（completed）的任务数。 */
    dispatched: number;
    /** 未能派发的任务与原因（依赖卡住 / 派发失败 / 超时）。 */
    skipped: Array<{
        taskId: string;
        reason: string;
    }>;
    /** 分波明细（用于 UI 展示"第 N 波放了哪些"）。 */
    waves: DispatchBatchWave[];
    reason?: string;
}
//# sourceMappingURL=contracts.d.ts.map
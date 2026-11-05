/**
 * 宿主半编排核心（Phase 3：真实 HostBridge 的宿主侧实现）。
 *
 * 这是客户端半 `fetch` 调用的三个能力在宿主半的落地：
 *  - `getPanelData`：读 roles.json + 注入的模型/MCP/技能，返回面板静态数据；
 *  - `confirmWrite`：把 UI 的回写草稿（tag/comment/state）逐一过四道门禁后直连 TFS REST 写入；
 *  - `dispatch`：按角色名解析角色 → 构建 DispatchRequest → 经 RequirementDispatcher 派发。
 *
 * 本模块是**纯编排**：所有宿主 API（roles 落盘、TFS 适配层、subagent 派发）均以可注入依赖
 * 形式传入，因此可在单测里用桩驱动，无需起真实 DSH 宿主（参考 dsh-optimized-prompt 的
 * host-api / routes 分离）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/api
 */
import { resolveFrozenModelRoute } from '../orchestration/dispatch.js';
import { runHealthCheck } from './health.js';
import { blocksToText, truncate } from './trace-mapper.js';
import { buildWorkspacePromptSection, normalizeWorkspace } from '../shared/workspace.js';
import { buildExecBudgetSection, assessOutcome, extractHumanConfirmReason, parseArtifactPaths, } from '../shared/exec-protocol.js';
import { buildContinuePrompt, buildMainAgentCompletePrompt, decideSweep, } from '../shared/sweep.js';
import { buildBriefSection, buildDigestSeed } from '../shared/brief.js';
import { describeRunTimeout } from '../shared/run-timeout.js';
import { buildCapabilityPlanSection, extractWorkflowSteps, verifyCapabilityUsage, } from '../shared/capability-plan.js';
/**
 * 子 run 落定原因 → 看板收口结果（spec 006 US2）。
 *
 * 关键修复：`SubagentRun.result` 对**模型/传输失败是 resolve**（带 stopReason='error'/'refusal'/
 * 'max-tokens'/'aborted' + diagnostic），只有基础设施无法表达的故障才 reject。旧实现用
 * `.then(成功, 失败)` 收口，于是所有模型失败都被误标成「已完成」。只有 'completed' 算成功。
 */
export function mapStopReasonToOutcome(stopReason) {
    return stopReason === 'completed' ? 'success' : 'failed';
}
/**
 * 在 subagents 服务可达的探测结果上，再前置校验「当前是否有可派发的顶层会话」（D7）。
 *
 * 2026-11-03 修正：**"当前没有活跃会话"不等于"派发不了"**。只要宿主能现造一个会话
 * （`sessionController.create`，见 `canPrepareParent`），就不该把编排能力判成不可用并拦住
 * 用户 —— 旧行为在"从工作台直接发起"和"定时执行到点"两种场景下都是死路（后者还会因
 * 调度器 at-most-once 直接丢任务）。
 *
 * @param probe - {@link probeSubagents} 的现算结果（服务/工具/provider 是否就绪）。
 * @param getParent - 解析顶层父 Agent；无存活顶层会话时抛错（parent-resolver 同一判据）。
 * @param canPrepareParent - 能否在派发时准备出父会话（同步判定，无副作用）。
 * @returns 服务不可达则原样返回；服务可达时：
 *   - 有顶层会话 ⇒ 原样放行；
 *   - 无但能准备 ⇒ available:true + `parentOnDemand:true`（面板给"派发时自动准备"的提示）；
 *   - 无且不能准备 ⇒ 降级 available:false + 「请先开会话」的可操作提示，前端据此禁用。
 */
export function gateProbeByParent(probe, getParent, canPrepareParent) {
    if (!probe.available)
        return probe;
    try {
        getParent();
        return probe;
    }
    catch (e) {
        let prepare = false;
        try {
            prepare = canPrepareParent?.() === true;
        }
        catch {
            prepare = false;
        }
        if (prepare) {
            return { ...probe, available: true, parentOnDemand: true };
        }
        return {
            available: false,
            providers: probe.providers,
            // 保留派发通道信息：本层阻断的是"没有顶层会话"，不是"没有派发 API"，
            // 面板据此仍能显示走的是 startActivation 还是 start（诊断时不必再猜）。
            ...(probe.api ? { api: probe.api } : {}),
            reason: `当前没有可派发的顶层会话（${e.message}）——请先在主会话中开始一轮对话/打开会话后，再发起执行`,
        };
    }
}
/** 各非 completed 落定原因的中文兜底说明（diagnostic 缺失时使用）。 */
export function stopReasonNote(stopReason) {
    switch (stopReason) {
        case 'error':
            return '子智能体执行失败：模型或传输错误（stopReason=error）';
        case 'refusal':
            return '子智能体拒绝执行该任务（stopReason=refusal）';
        case 'max-tokens':
            return '子智能体在完成前达到输出 token 上限（stopReason=max-tokens）';
        case 'aborted':
            return '子智能体执行被中止（stopReason=aborted）';
        case 'completed':
            return '';
        default:
            return `子智能体未正常完成（stopReason=${String(stopReason ?? 'unknown')}）`;
    }
}
/**
 * 单次尝试**落盘**的助手输出上限（字符）。
 *
 * 与"展示上限"分开：`MAX_TEXT_CHARS`（trace-mapper 的轨迹展示上限）若用在落盘上，
 * 一次运行的结论段往往落在第 2000 字符之后，等于永久丢掉；而 TFS 结论评论由
 * `RequirementFinalizer` 按**每任务** `MAX_TASK_OUTPUT_CHARS`、整体
 * `MAX_COMMENT_CHARS` 逐层截断，展示口径由它负责（两者都不看这里的上限）。
 * 这里留足余量（远大于 `MAX_COMMENT_CHARS` 的单任务配额之和量级），使落盘层不成为瓶颈。
 */
const MAX_PERSISTED_OUTPUT_CHARS = 20_000;
/** 从子 run 的 ContentBlock[] 输出里抽取文本并截断为可落盘摘要。 */
export function extractOutputText(output) {
    const text = blocksToText(output);
    return text ? truncate(text, MAX_PERSISTED_OUTPUT_CHARS) : '';
}
/**
 * 取"真正有值"的字符串：`''` 与纯空白都视为**未设置**。
 *
 * 用于 model / preset 这类字段——它们语义上"空串 ≠ 有效值"，而 `??` 只挡 `null`/`undefined`。
 * 看板拆解冻结的 `frozenConfig.model` 经常是空串（角色没配默认模型），若直接透传会**覆盖**
 * 宿主为子会话解析出的模型路由（`resolveChildAgentOptions` 是 `...requested` 覆盖式合并），
 * 令子 agent 拿到不可解析的模型名（2026-09-21 假执行事故的伴生问题）。
 *
 * @param value - 原始字符串。
 * @returns 去空白后非空的字符串；否则 undefined。
 */
function nonEmptyString(value) {
    return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}
/**
 * 从 `123@WN_HIS` 解析出 id 与集合。
 *
 * **容忍看板任务 id 形态**：`123@WN_HIS#analyze` 这种 `<需求key>#<阶段>` 的字符串
 * （任务中心/右栏「设为目标」会把 taskId 当目标用）若直接按 `@` 切分，集合会变成
 * `WN_HIS#analyze` —— 写回时拿着这种集合去打 TFS 只会得到一个更费解的 404。
 * 因此这里先剥掉 `#…` 段，只认需求键部分。
 *
 * @param targetWorkItem - 目标键（`id@collection` 或 `id@collection#stage`）。
 * @param fallbackCollection - 键里没带集合时的回退集合。
 * @returns 工作项 id 与集合。
 */
function parseTarget(targetWorkItem, fallbackCollection) {
    const hash = targetWorkItem.indexOf('#');
    const base = hash >= 0 ? targetWorkItem.slice(0, hash) : targetWorkItem;
    const at = base.indexOf('@');
    if (at < 0)
        return { id: base, collection: fallbackCollection };
    const id = base.slice(0, at);
    const collection = base.slice(at + 1) || fallbackCollection;
    return { id, collection };
}
/**
 * 构造宿主半编排实例。
 * @param deps - 编排依赖（roles/adapter/dispatcher/getParent/面板静态数据）。
 * @returns HostApi 实例。
 */
export function createHostApi(deps) {
    function getPanelData() {
        const roles = deps.roles.list();
        // 每次请求取最新快照：apply 时 refresh() 可能尚未完成，current() 在运行时必定已是最新。
        const catalog = deps.catalog?.current();
        return {
            targetWorkItem: '—',
            collection: deps.collection,
            roles: roles.length > 0 ? roles : [],
            // 兼容清单（保留以兼容既有消费方 / 兜底）：优先取自 catalog 的真实项，否则回退 deps 旧字段。
            models: catalog?.models.length ? catalog.models.map(m => m.id) : deps.models,
            mcpServers: catalog?.mcpServers.length ? catalog.mcpServers : deps.mcpServers,
            skills: catalog?.skills.length ? catalog.skills.map(s => s.name) : deps.skills,
            // 真实枚举（问题 4/5/6/7/9/11）：直接透传 catalog 快照，UI 据此渲染真实下拉。
            modelOptions: catalog?.models ?? [],
            workspaces: catalog?.workspaces ?? [],
            presets: catalog?.presets ?? [],
            providers: catalog?.providers ?? [],
            skillOptions: catalog?.skills ?? [],
            // 技能/MCP 分组（2026-11-03）：每次请求现读 store（分组改动少、量小，不缓存）。
            ...(deps.skillGroups ? { skillGroups: deps.skillGroups.list() } : {}),
            tagSuggestions: deps.tagSuggestions,
            // 集合清单至少含当前集合：否则 UI 的切换器会出现"当前值不在选项里"的空选中态。
            collections: deps.collections?.length ? deps.collections : [deps.collection],
            pollIntervalMinutes: deps.pollIntervalMinutes ?? 5,
            dispatchConcurrency: deps.dispatchConcurrency ?? 3,
            // 问题 1/2：把目录采集的降级原因透出（"技能为空"要能区分"没装"与"没采到"）。
            ...(catalog ? { catalogWarnings: catalog.warnings, catalogCollectedAt: catalog.collectedAt } : {}),
            // 宿主半模块加载时刻：用于判断"重新构建后到底有没有重启"。
            ...(deps.pluginLoadedAt ? { pluginLoadedAt: deps.pluginLoadedAt } : {}),
            // US4 编排能力：每次请求现算（`subagents` 服务是否真的可用），让面板在点击前就能
            // 如实提示"派不了"，而不是让用户点了才收到一句"服务不可用"。
            // D7：在服务可达之外，再前置校验「当前是否有可派发的顶层会话」——无会话时 parent-resolver
            // 必然失败，这里提前把 available 置 false 并给出"先开会话"的可操作提示，按钮据此禁用。
            ...(deps.probeOrchestration
                ? {
                    orchestration: gateProbeByParent(deps.probeOrchestration(), deps.getParent, 
                    // "当前没有活跃会话"不该判死：能现造就一直可用（见 gateProbeByParent 注释）。
                    deps.canPrepareParent),
                }
                : {}),
            // 需求池/任务中心标题拼 TFS 需求页的兜底地址（只含 url，绝不含 PAT）。
            // 每次调用现取：档案会在运行期被切换（`deps` 是值捕获，缓存下来会拿旧地址）。
            ...(activeBaseUrl() ? { tfsBaseUrl: activeBaseUrl() } : {}),
        };
    }
    /**
     * 活动档案的服务地址（不含集合）。
     *
     * `ProfileView` 结构上没有 `pat` 字段，故这里**不可能**把凭据带进面板数据 ——
     * 这与"永不回显 PAT"是同一条纪律。
     */
    function activeBaseUrl() {
        const id = deps.profiles?.activeId();
        if (!id)
            return undefined;
        return deps.profiles?.get(id)?.url;
    }
    /**
     * 重采能力目录后再返回面板数据。
     *
     * `getPanelData` 只读内存快照，而用户在插件已挂载后仍可能补配模型 / 装技能 / 加 MCP
     * （这是常态，不是异常）。`catalog.refresh()` 自带 inflight 去重与逐项降级，故并发点击
     * 刷新按钮不会打爆 provider；`refresh` 本身从不抛错（内部 catch 后返回上一份快照）。
     */
    async function refreshPanelData() {
        if (deps.catalog) {
            try {
                await deps.catalog.refresh();
            }
            catch {
                // refresh 内部已兜底；这里的 catch 只为"目录服务实现意外抛错"兜底，
                // 让面板仍能拿到上一份快照，而不是把错误抛给 HTTP 路由。
            }
        }
        return getPanelData();
    }
    async function confirmWrite(input) {
        // 回退集合用**调用方给的 collection**优先（视图所在集合），其次才是插件默认集合：
        // 目标键没带集合时（如 `1997179`），用默认集合会把写入打到另一个集合去。
        const { id, collection } = parseTarget(input.targetWorkItem, input.collection || deps.collection);
        // TFS 工作项 id 必为数字；占位 '—' 或非数字一律拒绝，避免发出 id:NaN 的无效写调用。
        const numericId = Number(id);
        if (!id || id.trim().length === 0 || !Number.isInteger(numericId) || numericId <= 0) {
            return { ok: false, results: [], reason: `targetWorkItem 缺少有效工作项 id：${input.targetWorkItem}` };
        }
        const results = [];
        for (const op of input.ops) {
            try {
                if (op.opType === 'tag') {
                    const before = Array.isArray(op.before) ? op.before : [];
                    const after = Array.isArray(op.after) ? op.after : [];
                    const r = await deps.adapter.addTags(id, collection, after, before, true);
                    results.push({ opType: 'tag', ok: r.ok, reason: r.reason });
                }
                else if (op.opType === 'comment') {
                    const text = typeof op.after === 'string' ? op.after : '';
                    if (!text) {
                        results.push({ opType: 'comment', ok: false, reason: '评论内容为空' });
                        continue;
                    }
                    const r = await deps.adapter.addComment(id, collection, text, true);
                    results.push({ opType: 'comment', ok: r.ok, reason: r.reason });
                }
                else if (op.opType === 'state') {
                    const to = typeof op.after === 'string' ? op.after : '';
                    const from = typeof op.before === 'string' ? op.before : '';
                    if (!to) {
                        results.push({ opType: 'state', ok: false, reason: '目标状态为空' });
                        continue;
                    }
                    const r = await deps.adapter.changeState(id, collection, to, from, true);
                    results.push({ opType: 'state', ok: r.ok, reason: r.reason });
                }
                else if (op.opType === 'link') {
                    // S-04：关联（变更集/TFVC）经评论回写实现，本插件暂不提供独立的 link 写工具。
                    results.push({ opType: 'link', ok: false, reason: '暂不支持 link 回写（S-04：关联经评论实现）' });
                }
                else {
                    results.push({ opType: op.opType, ok: false, reason: `未知回写类型 ${op.opType}` });
                }
            }
            catch (e) {
                results.push({ opType: op.opType, ok: false, reason: e.message });
            }
        }
        const failed = results.filter(r => !r.ok);
        return {
            ok: failed.length === 0,
            results,
            ...failed.length === 0 ? {} : { reason: failed.map(f => `${f.opType}:${f.reason}`).join('; ') },
        };
    }
    async function dispatch(input) {
        const role = deps.roles.getByName(input.draft.roleName);
        if (!role) {
            return { ok: false, reason: `角色 "${input.draft.roleName}" 不存在（检查 US5 角色配置）` };
        }
        if (!role.provider || role.provider.trim().length === 0) {
            return { ok: false, reason: `角色 "${role.name}" 未绑定 provider（S-13）` };
        }
        // 冻结配置：MCP/技能 UI 提交优先，缺省用角色默认值兜底；模型路由（model + LLM provider）
        // 经 resolveFrozenModelRoute 成对回落（spec 009：裸 model 会让子 agent 继承父会话供应商，
        // 造成"选火山方舟却跑英伟达"）。
        const modelRoute = resolveFrozenModelRoute({ frozen: input.draft.frozenConfig, role });
        const draftPreset = typeof input.draft.preset === 'string' ? input.draft.preset.trim() : '';
        const draftSkills = input.draft.frozenConfig?.skills?.length
            ? input.draft.frozenConfig.skills
            : (role.defaultSkills ?? []);
        // 2026-10-29（诉求 4）：工作流技能必须落在本次技能清单内 —— 工作流就是一种技能，
        // 指向一个没勾选的技能会同时导致"取不到正文"与"生成无依据的强制流程"。
        const draftWorkflow = typeof input.draft.frozenConfig?.workflow === 'string'
            ? input.draft.frozenConfig.workflow.trim()
            : '';
        if (draftWorkflow.length > 0 && !draftSkills.includes(draftWorkflow)) {
            return {
                ok: false,
                reason: `工作流「${draftWorkflow}」不在本次技能选择内：工作流从技能中选择，请先在「技能」里勾选它`,
            };
        }
        const frozenConfig = {
            mcp: input.draft.frozenConfig?.mcp?.length ? input.draft.frozenConfig.mcp : (role.defaultMcp ?? []),
            skills: draftSkills,
            model: modelRoute.model,
            ...(modelRoute.modelProvider ? { modelProvider: modelRoute.modelProvider } : {}),
            // 问题 3/1：预设与执行预算随任务冻结落库（空串/0 不写键，保持旧 JSON 形状）。
            ...(draftPreset ? { preset: draftPreset } : {}),
            ...(draftWorkflow ? { workflow: draftWorkflow } : {}),
            ...(input.draft.maxDepth && input.draft.maxDepth > 0 ? { maxDepth: Math.floor(input.draft.maxDepth) } : {}),
            ...(input.draft.maxTokens && input.draft.maxTokens > 0 ? { maxTokens: Math.floor(input.draft.maxTokens) } : {}),
        };
        /**
         * 问题 6：执行配置页选的预设**覆盖**角色自带 `preset`。
         *
         * 为什么是克隆而不是改 `role`：`role` 取自 `RoleStore`（持久化在 roles.json），
         * 直接改字段会把一次性执行选择写回角色档案。克隆只在本次派发生效。
         */
        const dispatchRole = input.draft.preset && input.draft.preset !== role.preset ? { ...role, preset: input.draft.preset } : role;
        // 任务上下文：把该任务的目标代码库路径写进 prompt。
        // **为何是 prompt 而不是 cwd**：宿主 `SubagentStartRequest` 无 cwd/workspace 字段，
        // 子代理工作目录只能来自「部署 cwd 覆盖 → 否则父会话 workspace」（dsh-subagent 的 resolveChildCwd）。
        // prompt 是插件唯一能影响子代理的通道，故 `shared/workspace.ts` 在这里给出一段**硬约束 + 可执行动作**
        // （绝对路径 / 先 cd 再执行 / 禁止在父会话工作目录里就近找代码），而不是一句"代码库位于 X"。
        const boardTask = input.taskId
            ? deps.board?.snapshot().tasks.find(t => t.taskId === input.taskId)
            : undefined;
        /**
         * 需求键的**权威来源**：看板任务的 `requirementId` 优先于调用方传来的 target。
         *
         * 为什么：任务中心的 taskId 形如 `1997179@WN_HIS#analyze`，而客户端"目标"字段在多条
         * 路径上曾是面板占位符 `—`（2026-09-21 事故）。即便调用方给的目标不理想，
         * 只要任务本身知道它属于哪个需求，就应该用任务的答案 —— 否则子 agent 的 prompt 里
         * 会丢掉工作项号/集合（`workItemId: undefined`），run 也会被归到错误的 requirementId 桶里。
         */
        const requirementKey = boardTask?.requirementId ?? input.targetWorkItem;
        const targetRef = parseTarget(requirementKey, input.collection || deps.collection);
        /**
         * 无看板任务时必须有**有效需求键**，否则拒绝派发。
         *
         * 旧行为会把兜底 taskId 拼成 `—#role-coder`（目标为面板占位符时的产物）：run 没有需求
         * 上下文、归组键也是垃圾值，用户只看到一句费解的 `分发失败（task=—#role-coder）`。
         * 宁可不派发，也要给出"该去哪儿选目标"的可执行提示。
         */
        if (!input.taskId && !/^\d+@/.test(requirementKey)) {
            return {
                ok: false,
                reason: `缺少有效的派发目标（当前目标：${input.targetWorkItem || '(空)'}）：`
                    + '请先在「需求池」或「任务中心」把某个需求「选为目标」，再从「执行配置」发起执行',
            };
        }
        /**
         * 问题 4（2026-11-03）：定时执行 —— 校验通过后**先登记调度，不建任务不派发**。
         *
         * 放在校验后、建任务前：角色/目标等错误当场暴露（fail fast），而看板任务留到
         * 到点真正派发时再创建（避免"任务已建但人还没到点"的半执行假象）。
         * 到点后调度器回调 `dispatch` 同一入参（schedule 已是 'now' 语义），走完正常链路。
         */
        const schedule = input.draft.schedule;
        if (schedule?.mode === 'at') {
            const dueAt = schedule.dueAt ?? '';
            const dueMs = Date.parse(dueAt);
            if (Number.isNaN(dueMs))
                return { ok: false, reason: '定时时间无效（不是合法 ISO 时间）' };
            if (dueMs <= Date.now())
                return { ok: false, reason: '定时时间必须晚于当前时间' };
            if (!deps.scheduler) {
                return { ok: false, reason: '调度器未装配（插件与宿主版本不匹配）：无法登记定时执行' };
            }
            const entryId = `dispatch:${input.taskId ?? requirementKey}:${Date.now()}`;
            const reg = deps.scheduler.schedule({
                id: entryId,
                dueAt,
                kind: 'dispatch',
                payload: { ...input, draft: { ...input.draft, schedule: { mode: 'now' } } },
                note: `定时执行：${nonEmptyString(input.draft.title) ?? input.draft.roleName}`,
            });
            if (!reg.ok)
                return { ok: false, reason: reg.reason ?? '登记定时执行失败' };
            // 2026-11-03 问题 3：把实际生效的工作目录一并回带 —— 否则执行面板无从显示
            // "用的是哪个目录"，会误报"未指定工作目录"（定时分支此前不回带 workspace）。
            return {
                ok: true,
                scheduled: true,
                scheduledAt: dueAt,
                ...(input.taskId ? { taskId: input.taskId } : {}),
                ...(input.draft.workspace ? { workspace: input.draft.workspace } : {}),
            };
        }
        /**
         * 工作目录取值链（问题 1，2026-09-21 修复）。
         *
         * 优先级：**面板显式选择** > **看板任务自身的 workspace** > **需求级 workspace**。
         *
         * 旧实现只取 `boardTask?.workspace`：从「执行配置」发起执行时根本没有看板任务
         * （`input.taskId` 为空）⇒ 整段【工作目录】**完全不出现**在 prompt 里 ⇒ 子代理按进程 cwd
         * （父会话工作区）干活，用户看到的就是"任务上明明设了工作区，子代理却在另一个工程里改代码"。
         * 同时 `draft.workspace`（面板里选的工作区）此前是**死字段**（从未被读取），也一并接上。
         *
         * 2026-11-03：这一段**上移到 parent 解析之前** —— `ensureParent` 需要用它在"没有活跃会话"
         * 时新建一个以该目录为 cwd 的会话（子会话继承父会话目录，否则子代理会在错误工程里干活）。
         * 这段只读 board 快照与入参，不产生任何状态变更，前移安全。
         */
        const requirementWorkspace = deps.board?.board?.snapshot?.requirements?.[requirementKey]?.workspace;
        const explicitWorkspace = nonEmptyString(input.draft.workspace);
        const workspace = normalizeWorkspace(explicitWorkspace ?? boardTask?.workspace ?? requirementWorkspace ?? '');
        /**
         * 解析真实 parent Agent，**然后**才创建/启动看板任务（2026-09-21 假执行事故修复点）。
         *
         * 为什么顺序不能反：`parent` 拿不到时（宿主无存活会话 / 不在 agent 调用链上），
         * 若已把任务置为 `in_progress/running`（或建了一条注定派不出去的手工任务），看板就会显示
         * "执行中"/多一条悬空任务，而子 agent 从未创建 —— 这正是"假执行"的用户可见形态。
         * 拿不到 parent 就**拒绝派发且不碰状态**，让"未派发"在 UI 上如实呈现。
         *
         * 2026-11-03：先 `ensureParent`（同步链失败时恢复/新建会话），再退回同步 `getParent`。
         * 这一步是"定时执行到点"能跑通的关键 —— 到点时用户会话通常早已不在。
         */
        let parent;
        try {
            parent = deps.ensureParent ? await deps.ensureParent(workspace) : deps.getParent();
        }
        catch (e) {
            return { ok: false, reason: `派发前置条件不满足：${e.message}` };
        }
        /**
         * spec 010：派发前 **best-effort** 建立编排主 agent（仅当该需求还没有）。
         *
         * 为什么这里要补一条：`ensure` 原本只在**拆解成功**时调用，于是"需求早就拆过、
         * 用户直接点派发"的场景**永远不会有主 agent** ⇒ 任务完成后无人归纳、也无人做最终总结
         * —— 这正是"主 agent 没有自动总结"的一条真实路径。
         *
         * 两个护栏：
         *   - 失败**绝不阻塞派发**（没有编排会话也要能把任务派出去）；
         *   - `OrchestratorSessionManager.ensure` 对 `mode:'off'` 直接返回既有结论，
         *     不会每次派发都重试一次注定失败的 `startContinuable`。
         */
        if (deps.orchestrator && requirementKey && !deps.board?.getOrchestration?.(requirementKey)) {
            try {
                const req0 = deps.board?.board?.snapshot?.requirements?.[requirementKey];
                await deps.orchestrator.ensure(requirementKey, {
                    ...(req0 ? { title: req0.title, workspace: req0.workspace } : {}),
                    ...(req0 ? { digestSeed: buildDigestSeed(req0) } : {}),
                });
            }
            catch {
                // best-effort：编排是增强能力，派发才是主路径。
            }
        }
        /**
         * 问题 6：「执行配置 → 发起执行」必须**落地为看板任务**，否则这次执行在任务中心里
         * 什么都看不到（无 attempt、无 runId、无轨迹、无失败原因），用户无从确认它跑没跑。
         *
         * 需求未领取时 `createManualTask` 会给出可读原因（不隐式入池）。
         */
        let effectiveTaskId = input.taskId;
        let createdTask = false;
        if (!effectiveTaskId) {
            const boardSvc = deps.board;
            if (!boardSvc) {
                return {
                    ok: false,
                    reason: '看板服务不可用，无法把本次执行登记为任务：拒绝"无任务的派发"（否则执行内容在界面上不可见）',
                };
            }
            // 老版本装配（board 桩/旧服务）可能没有该方法：给出可读原因，而不是抛 TypeError 让路由 500。
            if (typeof boardSvc.createManualTask !== 'function') {
                return {
                    ok: false,
                    reason: '看板服务不支持"手工任务登记"（插件与宿主版本不匹配）：请从「任务中心」对具体任务点「派发执行」',
                };
            }
            const created = boardSvc.createManualTask({
                requirementKey,
                title: nonEmptyString(input.draft.title) ?? `${role.name} 手工执行`,
                description: input.draft.description ?? '',
                prompt: nonEmptyString(input.draft.prompt) ?? '',
                roleAgent: role.name,
                frozenConfig,
                ...(workspace ? { workspace } : {}),
            });
            if (!created.ok || !created.taskId) {
                return { ok: false, reason: created.reason ?? '创建执行任务失败' };
            }
            effectiveTaskId = created.taskId;
            createdTask = true;
        }
        // 有看板 taskId 时用看板 ID（两套命名空间必须一致，否则 run 结果无法回绑），否则退回兜底 ID。
        const taskId = effectiveTaskId ?? `${requirementKey}#${role.id}`;
        const wsSection = buildWorkspacePromptSection({
            ...(workspace ? { workspace } : {}),
            ...(input.taskId ? { taskTitle: boardTask?.title } : {}),
            workItemId: Number(targetRef.id) || undefined,
            collection: targetRef.collection,
        });
        /**
         * 三段式 prompt 组装（问题 3/4/6/408）。
         *
         * 顺序固定为：**工作目录上下文 → 需求级提示词 → 任务级正文**。空段不产出空行
         * （`filter(Boolean)`），否则子代理会收到一串无意义的空行。
         *
         * - 「需求级提示词」取自看板需求记录（`Requirement.prompt`），**实时读取**而非随任务冻结：
         *   用户改了需求提示词后，尚未派发的任务必须立刻采用新值（复制进任务会制造两份真相）。
         * - 「任务级正文」优先任务自己的 `prompt`（问题 4 的编辑入口），其次用调用方给的
         *   `draft.prompt`（执行配置页手写的 prompt / 旧客户端），最后才回落
         *   `标题 + 描述`（保持看板任务的旧行为，不让用户拿到空 prompt）。
         *
         * 注意 `deps.board` 可能是测试桩（只有 snapshot/setTaskState）：这里全程可选链，
         * 拿不到需求记录时只少一段，不让派发失败。
         */
        // 需求级提示词：`draft.requirementPrompt`（执行配置页带入/微调的本次覆盖，2026-11-03 问题 1/3）
        // 优先，缺省实时读看板 `Requirement.prompt`（用户改了需求提示词后未派发任务立刻采用新值）。
        const requirementPrompt = (typeof input.draft.requirementPrompt === 'string' && input.draft.requirementPrompt.trim().length > 0
            ? input.draft.requirementPrompt.trim()
            : deps.board?.board?.snapshot?.requirements?.[requirementKey]?.prompt);
        const freshBoardTask = createdTask
            ? deps.board?.snapshot().tasks.find(t => t.taskId === taskId)
            : boardTask;
        const fallbackBody = freshBoardTask
            ? [freshBoardTask.title, freshBoardTask.description].filter(s => typeof s === 'string' && s.trim().length > 0).join('\n\n')
            : '';
        const taskBody = freshBoardTask?.prompt?.trim() || input.draft.prompt?.trim() || fallbackBody;
        const promptText = [
            wsSection,
            buildSharedBriefSection({
                requirementKey,
                frozenConfig,
                ...(requirementPrompt?.trim() ? { requirementPrompt: requirementPrompt.trim() } : {}),
            }),
            taskBody,
        ].filter(s => s.length > 0).join('\n\n');
        const prompt = [{ type: 'text', text: promptText }];
        // 看板绑定（US3）：把任务置为「进行中/运行中」并打开一次 attempt。失败即拒（依赖未就绪 /
        // 已终态 / revision 冲突），避免"派发了但看板上任务没动"这种静默不一致。
        if (deps.board) {
            const started = deps.board.setTaskState(taskId, 'start');
            if (!started.ok) {
                return {
                    ok: false,
                    reason: `看板任务不可启动：${started.reason}`,
                    taskId,
                    createdTask,
                };
            }
        }
        const launched = await launchRun({
            requirementId: requirementKey,
            taskId,
            boardTaskId: deps.board ? taskId : undefined,
            role: dispatchRole,
            frozenConfig,
            prompt,
            parent,
        });
        return {
            ...launched,
            taskId,
            ...(createdTask ? { createdTask: true } : {}),
            ...(workspace ? { workspace } : {}),
        };
    }
    /**
     * 真正发起一次子 run 并接好「启动 → 立即绑定 runId → 按 stopReason 收口」（dispatch 与 followUp 共用）。
     *
     * 调用前看板 attempt 必须已打开：首次派发走 `setTaskState('start')`，追问走 `openFollowUp`。
     *
     * ## 收口修复（spec 006 US2）
     * `SubagentRun.result` 对模型/传输失败是 **resolve**（stopReason≠completed + diagnostic），只有
     * 基础设施故障才 reject。故这里按 `stopReason` 判定成败，并把 runId/stopReason/diagnostic/输出摘要
     * 落进 attempt——旧实现 `.then(完成, 失败)` 会把模型失败误标成已完成，且丢弃失败原因。
     */
    /**
     * 组装派发 prompt 的「共享简报」段（spec 010 US3 / AC3.2）。
     *
     * ## 为什么它能省 token
     *
     * 旧口径把**需求提示词全文**塞进每一个任务的 prompt；N 个任务 = N 份相同正文，
     * 且前序任务的结论一点都不传递。现在需求级简报一旦有 `digest`，后续任务只拿
     * 「摘要 + 已完成结论 + 产物 + 已绑定工具」，需求正文**不再重复下发**。
     *
     * ## 降级
     *
     * 无编排能力 / 旧看板（没有 `orchestration`）时，原样退回「【需求提示词】全文」——
     * 与 010 之前逐字一致，不改变任何既有行为。
     *
     * @param input.requirementKey - 需求去重键。
     * @param input.frozenConfig - 本次生效的冻结配置（MCP/技能以它为准，简报可能滞后）。
     * @param input.requirementPrompt - 需求提示词全文（仅无简报摘要时使用）。
     */
    function buildSharedBriefSection(input) {
        const orch = deps.board?.getOrchestration?.(input.requirementKey);
        const brief = orch?.brief;
        if (!brief) {
            return input.requirementPrompt ? `【需求提示词】\n${input.requirementPrompt}` : '';
        }
        return buildBriefSection(brief, {
            mcp: input.frozenConfig.mcp,
            skills: input.frozenConfig.skills,
            ...(input.requirementPrompt ? { requirementPrompt: input.requirementPrompt } : {}),
        });
    }
    /**
     * 在任务 prompt 末尾统一追加「执行预算与终止纪律」段（问题 1/4/5）。
     *
     * 三条派发路径（执行配置派发 / 任务中心启动 / 追问）都经 launchRun，故在这里统一注入，
     * 避免散落三处对不上。追加到最后一个 text 块；没有 text 块则新增一个。
     */
    function withBudgetSection(prompt, frozen) {
        const effectiveDepth = frozen.maxDepth && frozen.maxDepth > 0 ? frozen.maxDepth : (deps.defaultMaxDepth ?? 0);
        const section = buildExecBudgetSection({ maxDepth: effectiveDepth });
        const lastText = (() => {
            for (let i = prompt.length - 1; i >= 0; i--) {
                const b = prompt[i];
                if (b && typeof b === 'object' && b.type === 'text')
                    return i;
            }
            return -1;
        })();
        if (lastText === -1)
            return [...prompt, { type: 'text', text: section }];
        return prompt.map((b, i) => {
            if (i !== lastText)
                return b;
            const prev = b.text ?? '';
            return { ...b, text: `${prev}\n\n${section}` };
        });
    }
    /**
     * 把一段 Markdown 追加到 prompt 的**最后一个 text 块**末尾（没有则新增一块）。
     *
     * 与 {@link withBudgetSection} 同一手法：保持 ContentBlock 数组形状不变，
     * 避免同一件事在两处各写一遍拼接逻辑（顺序/空行迟早漂移）。
     */
    function appendPromptSection(prompt, section) {
        if (!section)
            return prompt;
        const lastText = (() => {
            for (let i = prompt.length - 1; i >= 0; i--) {
                const b = prompt[i];
                if (b && typeof b === 'object' && b.type === 'text')
                    return i;
            }
            return -1;
        })();
        if (lastText === -1)
            return [...prompt, { type: 'text', text: section }];
        return prompt.map((b, i) => {
            if (i !== lastText)
                return b;
            const prev = b.text ?? '';
            return { ...b, text: `${prev}\n\n${section}` };
        });
    }
    /**
     * 解析"所选技能 / MCP / 工作流"并生成强制段（诉求 3 / 4 的下发侧）。
     *
     * ## 为什么"选了就必须真的用上"要靠这里
     *
     * 宿主没有 per-child 工具限制通道（`SubagentStartRequest` 无 `toolFilter`；
     * `ctx.tools.restrict()` 只接受 scoped 上下文），所以插件能做的最强约束是两段：
     *   1. **下发**：技能正文 + MCP 真实工具全名 + 工作流逐步纪律写进子 agent 首条 prompt；
     *   2. **验收**：落定后读子会话 `tool/call`，核对是否真用上了（{@link verifyRunCapabilities}）。
     *
     * ## 分级处理（为什么不一律硬失败）
     *
     * 真实部署里角色的 `defaultMcp` / `defaultSkills` 常带**历史值**（本机 roles.json 的
     * `tfs-mcp` 就是 2026-09-19 已下线的实例，`brainstorming` 等技能也未必装在全局层）。
     * 若把"取不到正文 / 没注册工具"一律判成派发失败，一次历史配置就能把所有派发打死。
     * 因此只有**用户显式要求且无法降级**的情况才硬失败：
     *
     * | 情况 | 处理 |
     * |---|---|
     * | 工作流技能取不到正文 | **硬失败**（"按该技能流程执行"这个要求会变成空话） |
     * | 工作流不在技能清单内 | **硬失败**（自相矛盾的配置） |
     * | 其它所选技能取不到正文 | 降级：仍下发名字 + "必须先调用 skill 工具加载"的纪律 |
     * | 所选 MCP 有注册工具 | 下发真实工具全名 + 强制调用 + 落定验收 |
     * | 所选 MCP 无注册工具 | 降级：从强制清单排除，并在 prompt 里显式声明"不可用" |
     *
     * @param frozen - 本次生效的冻结配置。
     * @returns 强制段 + 验收所需的计划；无法满足时给出可读原因。
     */
    async function resolveCapabilityPlan(frozen) {
        const skillNames = [...new Set((frozen.skills ?? []).filter(s => typeof s === 'string' && s.trim().length > 0))];
        const mcpNames = [...new Set((frozen.mcp ?? []).filter(s => typeof s === 'string' && s.trim().length > 0))];
        const workflow = typeof frozen.workflow === 'string' ? frozen.workflow.trim() : '';
        if (skillNames.length === 0 && mcpNames.length === 0 && workflow.length === 0) {
            return { ok: true, section: '' };
        }
        // 工作流必须是所选技能之一：否则既加载不到正文，又会生成一份"无正文可依"的强制流程。
        if (workflow.length > 0 && !skillNames.includes(workflow)) {
            return {
                ok: false,
                reason: `工作流「${workflow}」不在该任务的技能清单内：工作流从技能中选择，请先勾选该技能`,
            };
        }
        // ① 技能正文：取不到**不直接判失败**（技能可能只在子会话自己的作用域可见，
        //    宿主的 skill 工具仍能加载它）；但工作流技能取不到正文 ⇒ 硬失败，
        //    因为"按该技能流程执行"这个要求本身就是空的。
        let bodies = [];
        if (deps.loadSkillBodies && skillNames.length > 0) {
            try {
                bodies = await deps.loadSkillBodies(skillNames);
            }
            catch (e) {
                return { ok: false, reason: `读取技能正文失败：${e.message}` };
            }
        }
        else {
            // 未接线（测试桩 / 旧装配）：保留名字，正文缺省。
            bodies = skillNames.map(name => ({ name, content: '' }));
        }
        const available = new Set(bodies.map(b => b.name));
        // 补齐读不到正文的技能：仍下发名字 + "必须先加载"的纪律。
        for (const name of skillNames) {
            if (!available.has(name))
                bodies.push({ name, content: '' });
        }
        if (workflow.length > 0) {
            const wfBody = bodies.find(b => b.name === workflow)?.content ?? '';
            if (wfBody.trim().length === 0) {
                return {
                    ok: false,
                    reason: `工作流技能「${workflow}」取不到正文，无法生成强制流程：`
                        + '请确认该技能已安装（技能目录可见）或改选其它技能作为工作流',
                };
            }
        }
        // ② MCP 真实工具名：注册了工具的才进入"强制清单"；没注册的降级为 prompt 里的
        //    一句明确声明（不硬失败）—— 角色的 defaultMcp 里常留有已下线实例，
        //    一旦硬失败会把整条派发打死，那不是用户想要的结果。
        const mcp = [];
        const unusableMcp = [];
        if (mcpNames.length > 0) {
            const toolNames = deps.listToolNames?.() ?? [];
            for (const server of mcpNames) {
                const prefix = `mcp__${server}__`;
                const tools = toolNames.filter(n => typeof n === 'string' && n.startsWith(prefix));
                if (tools.length > 0)
                    mcp.push({ server, tools });
                else if (deps.listToolNames)
                    unusableMcp.push(server);
                else
                    mcp.push({ server, tools: [] });
            }
        }
        // ③ 工作流步骤：从技能正文解析（解析不到则按"整篇即流程"下发纪律）。
        const workflowBody = workflow.length > 0 ? bodies.find(b => b.name === workflow)?.content ?? '' : '';
        const steps = workflow.length > 0 ? extractWorkflowSteps(workflowBody) : [];
        const section = buildCapabilityPlanSection({
            skills: bodies,
            mcp,
            ...(unusableMcp.length > 0 ? { unusableMcp } : {}),
            ...(workflow ? { workflow } : {}),
            workflowSteps: steps,
            ...(deps.skillToolName ? { skillToolName: deps.skillToolName } : {}),
        });
        return {
            ok: true,
            section,
            plan: {
                skills: skillNames,
                // 只有**可用**的 server 参与验收：不可用的已在 prompt 里声明，不能因它判不达标。
                mcp: mcp.map(m => m.server),
                ...(workflow ? { workflow } : {}),
                steps,
            },
        };
    }
    /**
     * 落定后验收：所选技能 / MCP / 工作流步骤是否**真的**被使用（诉求 3 / 4 的验收侧）。
     *
     * 判据全部来自子会话的 `tool/call` 事件与最终输出，见
     * `shared/capability-plan.ts#verifyCapabilityUsage`。事件读不到时按通过处理
     * （观测能力缺失不应误杀任务），但会在返回里标明 `observable:false` 便于诊断。
     */
    async function verifyRunCapabilities(sessionId, plan, output) {
        let toolCalls;
        if (deps.readChildToolCalls) {
            try {
                toolCalls = await deps.readChildToolCalls(sessionId);
            }
            catch {
                // 读取失败 ⇒ 视为不可观测（不因观测失败判任务不达标）。
                toolCalls = undefined;
            }
        }
        /** 2026-10-30：子会话真实工具表（request/header），用于戳穿工具未注入的谎报。 */
        let toolSurface;
        if (deps.readChildToolNames) {
            try {
                toolSurface = await deps.readChildToolNames(sessionId);
            }
            catch {
                toolSurface = undefined;
            }
        }
        const verdict = verifyCapabilityUsage({
            skills: plan.skills,
            mcp: plan.mcp,
            workflowSteps: plan.steps,
            ...(toolCalls !== undefined ? { toolCalls } : {}),
            ...(toolSurface !== undefined ? { toolSurface } : {}),
            output,
            ...(deps.skillToolName ? { skillToolName: deps.skillToolName } : {}),
        });
        return { ...verdict, observable: toolCalls !== undefined };
    }
    async function launchRun(p) {
        try {
            // 问题 3：任务级冻结预设覆盖角色自带 preset（克隆而非改 role 实例，避免污染 RoleStore）。
            // 2026-10-29：宿主 `SubagentStartRequest.agentPreset` 已是真实字段，
            // `orchestration/dispatch.ts` 会把它下发到 `startActivation`，preset 真正作用到子 agent。
            const effectiveRole = p.frozenConfig.preset && p.frozenConfig.preset !== p.role.preset
                ? { ...p.role, preset: p.frozenConfig.preset }
                : p.role;
            /**
             * 诉求 3 / 4（2026-10-29）：所选技能 / MCP / 工作流**先预检、再下发**。
             *
             * 预检失败（技能取不到正文、所选 MCP 一个工具都没注册、工作流不在技能清单内）⇒
             * **在动看板状态之前**就返回可读原因，让"选了但不生效"变成用户能看到的错误，
             * 而不是一次看起来正常、实际什么都没用的执行。
             */
            const capability = await resolveCapabilityPlan(p.frozenConfig);
            if (!capability.ok) {
                if (deps.board && p.boardTaskId) {
                    deps.board.settleTask(p.boardTaskId, 'failed', {
                        stopReason: 'dispatch-failed',
                        diagnostic: capability.reason,
                        note: capability.reason,
                    });
                }
                return { ok: false, reason: capability.reason };
            }
            const withCapability = capability.section
                ? appendPromptSection(p.prompt, capability.section)
                : p.prompt;
            const budgetedPrompt = withBudgetSection(withCapability, p.frozenConfig);
            /**
             * spec 010 AC3.3：**优先复用同一需求的持久任务子会话**。
             *
             * 前置条件（三者缺一即回退 ONE-SHOT）：
             *   ① 配置开启；② 装配注入了复用派发出口；③ 该需求的编排能力**已被证明可用**
             *   （`mode === 'continuable'`）—— 复用与编排依赖同一个 continuable 能力，
             *   没有理由一边判定不可用、一边还去试。
             *
             * 复用失败（provider 拒绝续投 / 会话已被清理）时记事件并**当场回退** ONE-SHOT：
             * 用户要的是"任务跑起来"，不是"必须复用"。
             */
            // 两个分支（复用 / ONE-SHOT）都必然赋值；用断言让 TS 认可这一事实。
            let handle;
            let usedReuse = false;
            /** 复用失败的原因（仅用于诊断与回写任务上下文；成功时为空）。 */
            let reuseFallbackReason;
            const reuseReady = deps.reuseTaskSessions === true
                && typeof deps.launchReusedTask === 'function'
                && deps.board?.getOrchestration?.(p.requirementId)?.mode === 'continuable';
            if (reuseReady && p.boardTaskId) {
                try {
                    const r = await deps.launchReusedTask({
                        requirementId: p.requirementId,
                        taskId: p.taskId,
                        parent: p.parent,
                        prompt: budgetedPrompt,
                        role: effectiveRole,
                        frozenConfig: p.frozenConfig,
                    });
                    handle = { id: r.id, provider: effectiveRole.provider, reused: r.reused, turn: r.turn, result: r.result };
                    usedReuse = true;
                }
                catch (e) {
                    usedReuse = false;
                    // ⚠️ 兑现上面注释的承诺：**记下原因**再回退（2026-10-06 修复）。
                    // 此前是空 `catch {}`，复用为什么没生效完全没有痕迹 —— 而 `launchReusedTask`
                    // 内部已经排过一次队（`acquireReuseTurn`），回退 ONE-SHOT 又要再排一次并发槽，
                    // 用户等了两轮排队却只看到 ONE-SHOT 成功，无从追问。典型原因（provider 不支持
                    // continuable / 排队超时 / 会话已被清理）本来都是可诊断的，留下来才谈得上排查。
                    // 下面会把原因写进任务编排上下文（随 board.json 落盘，任务详情可读）。
                    reuseFallbackReason = e instanceof Error ? e.message : String(e);
                }
            }
            if (!usedReuse) {
                // 把"为什么没复用"回写到任务编排上下文，让它在任务详情里可见（事件日志之外再留一处）。
                if (reuseFallbackReason && p.boardTaskId) {
                    try {
                        deps.board?.setTaskOrchestration?.(p.boardTaskId, { reused: false, fallbackReason: reuseFallbackReason });
                    }
                    catch {
                        /* 同上：诊断写不进去不影响派发 */
                    }
                }
                const result = await deps.dispatcher.dispatch({
                    requirementId: p.requirementId,
                    taskId: p.taskId,
                    role: effectiveRole,
                    frozenConfig: p.frozenConfig,
                    // 问题 1：统一注入执行纪律段（控 token / 防重复 / 防死循环 / 人工确认与产物协议）。
                    prompt: budgetedPrompt,
                    // 问题 1：任务级执行预算（maxDepth 缺省由分发器构造默认值兜底）。
                    ...(p.frozenConfig.maxDepth && p.frozenConfig.maxDepth > 0
                        ? { maxDepth: p.frozenConfig.maxDepth }
                        : {}),
                    ...(p.frozenConfig.maxTokens && p.frozenConfig.maxTokens > 0
                        ? { maxTokens: p.frozenConfig.maxTokens }
                        : {}),
                }, { parent: p.parent });
                const run = deps.dispatcher.getRun?.(p.taskId);
                if (deps.dispatcher.getRun && !run) {
                    /**
                     * 分发器**能**给出 run 句柄、但这一刻没有 ⇒ 没有任何东西会回调收口。不显式判失败
                     * 的话，这个任务会永远停在 `in_progress/running`（看板里可编辑被 `execState=running`
                     * 挡住），正是"假执行"。`getRun` 整个缺失属能力降级（自定义分发器实现），此时沿用
                     * 宽松语义，不据 absence 判失败。
                     */
                    const diagnostic = '分发完成但拿不到子会话句柄（dispatcher.getRun 未返回 run）：无法观测收口，任务已判失败';
                    deps.dispatcher.forget?.(p.taskId);
                    deps.board?.settleTask(p.boardTaskId ?? p.taskId, 'failed', {
                        runId: result.runId,
                        stopReason: 'infrastructure-error',
                        diagnostic,
                        note: diagnostic,
                    });
                    return { ok: false, reason: diagnostic };
                }
                handle = {
                    id: result.runId,
                    provider: result.provider,
                    reused: false,
                    ...(run ? { result: run.result } : {}),
                };
            }
            if (deps.board && p.boardTaskId) {
                // 立即绑定 runId：任务运行中也能按 runId 冷读执行轨迹，而不必等落定。
                // 复用子会话时同时绑定本轮 turn（D6），运行中查轨迹也能隔离到本轮。
                deps.board.bindRun(p.boardTaskId, handle.id, handle.provider, handle.turn);
                if (usedReuse) {
                    // spec 010：把复用会话落到任务上，UI 的"切换到子 agent"据此定位会话。
                    deps.board.setTaskOrchestration?.(p.boardTaskId, { sessionId: handle.id, reused: true });
                }
                const runResult = handle.result;
                const bindTaskId = p.boardTaskId;
                runResult?.then(async (sr) => {
                    const output = extractOutputText(sr?.output);
                    // 问题 4：从最终输出解析关键产物绝对路径（ARTIFACTS 段），落到任务级清单。
                    const artifactPaths = parseArtifactPaths(output);
                    /**
                     * 问题 1：总时长看门狗终止优先于 run 自报原因（aborted 也可能是用户手动取消，
                     * 但 consumeTimeout 命中即确定是看门狗），落"运行超时"失败。
                     *
                     * 2026-11-04：证据（实际跑了多久、最后一次活动距今多久）必须在 `forget()` **之前**
                     * 取出——forget 会清掉该任务的追踪记录（含证据）。文案交纯函数生成，不再断言
                     * "可能存在死循环"（真机上被掐死的那轮其实刚产出完整报告）。
                     */
                    const timedOut = deps.dispatcher.consumeTimeout?.(bindTaskId) === true;
                    const timeoutEvidence = timedOut
                        ? deps.dispatcher.takeTimeoutDetail?.(bindTaskId)
                        : undefined;
                    // 超时标记消费后即可丢弃该任务的 run 追踪（run 句柄 + 需求索引 + 看门狗定时器）。
                    deps.dispatcher.forget?.(bindTaskId);
                    if (timedOut) {
                        const note = describeRunTimeout(timeoutEvidence);
                        deps.board?.settleTask(bindTaskId, 'failed', {
                            runId: handle.id,
                            stopReason: 'timeout',
                            diagnostic: note,
                            ...(output ? { output } : {}),
                            note,
                        });
                        return;
                    }
                    /**
                     * 诉求 3 / 4（2026-10-29）：**落定后验收所选能力是否真被使用**。
                     *
                     * 为什么要在这里而不是"只看 stopReason"：子 agent 完全可能"完成"了任务却一次
                     * 技能没加载、一次 MCP 没调（旧实现就是这种状态，因为选择从未真正下发）。
                     * 验收不达标的处理是**收口为待人工确认**而非直接判失败：任务本身可能确实干完了活，
                     * 只是没按纪律留痕，需要人看一眼 —— 直接判失败会把有效产出丢掉。
                     *
                     * 验收本身**绝不允许**把收口流程搞崩：内部全部 catch，异常时退回原本的成功收口。
                     */
                    let verification;
                    if (capability.ok && capability.plan && (capability.plan.skills.length > 0 || capability.plan.steps.length > 0)) {
                        try {
                            verification = await verifyRunCapabilities(handle.id, capability.plan, output);
                        }
                        catch {
                            verification = undefined;
                        }
                    }
                    /**
                     * 问题 5：收口不再只看 stopReason。`assessOutcome` 同时检查输出内容——
                     * stopReason=completed 但结论是"请人工确认/人工确定"时判 needs_confirmation，
                     * 任务停在待确认（看板态保持 in_progress），不自动进入下游、不触发完成回写。
                     *
                     * 2026-11-04：`NEEDS_HUMAN_CONFIRM` 常被模型用来描述**非阻塞遗留项**，而任务
                     * 本身已经交付完整报告与 ARTIFACTS。assessOutcome 在有交付证据时判 success
                     * 并给 deferredNote，避免"所有子 agent 完成后都被判失败/待确认"（真机 2059017）。
                     */
                    const assessment = assessOutcome(sr?.stopReason, output);
                    const outcome = assessment.outcome;
                    /**
                     * 2026-10-30（诉求 2）：pseudoToolCalls（输出里是 <read> 这类文本形态工具调用）
                     * **直接判失败**，不再降级为待人工确认——那不是"没留痕"，而是什么都没执行
                     * （模型 tool-call 格式漂移），留给人确认只会让人误以为产出可用。
                     */
                    const hardFail = verification?.pseudoToolCalls === true;
                    if (hardFail) {
                        const note = verification?.note
                            ?? '执行无效：输出只有文本形态的工具调用（如 <read>），并未真正调用工具（模型 tool-call 格式漂移）';
                        deps.board?.settleTask(bindTaskId, 'failed', {
                            runId: handle.id,
                            stopReason: sr?.stopReason,
                            diagnostic: note,
                            ...(output ? { output } : {}),
                            ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
                            note,
                        });
                    }
                    else if (outcome === 'success' && verification && !verification.ok) {
                        deps.board?.settleTask(bindTaskId, 'needs_confirmation', {
                            runId: handle.id,
                            stopReason: sr?.stopReason,
                            ...(output ? { output } : {}),
                            ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
                            note: verification.note ?? '待人工确认：未按要求使用所选技能 / MCP / 工作流',
                        });
                        // 问题 7 扫尾：验收不达标的待确认同样自动善后（补用所选能力继续）。
                        void maybeSweep({
                            taskId: bindTaskId,
                            outcome: 'needs_confirmation',
                            ...(sr?.stopReason ? { stopReason: sr.stopReason } : {}),
                            ...(output ? { output } : {}),
                        });
                    }
                    else if (outcome === 'success') {
                        deps.board?.settleTask(bindTaskId, 'success', {
                            runId: handle.id,
                            stopReason: sr?.stopReason,
                            ...(output ? { output } : {}),
                            ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
                            // 已交付但模型标注了需人工补做的遗留项：写进备注，不阻断完成。
                            ...(assessment.deferredNote ? { note: assessment.deferredNote } : {}),
                        });
                    }
                    else if (outcome === 'needs_confirmation') {
                        const reason = extractHumanConfirmReason(output);
                        deps.board?.settleTask(bindTaskId, 'needs_confirmation', {
                            runId: handle.id,
                            stopReason: sr?.stopReason,
                            ...(output ? { output } : {}),
                            ...(artifactPaths.length > 0 ? { artifactPaths } : {}),
                            note: `待人工确认：${reason}`,
                        });
                        // 问题 7 扫尾：主 agent 选推荐选项、编排同一子 agent 继续（不再停等人工）。
                        void maybeSweep({
                            taskId: bindTaskId,
                            outcome: 'needs_confirmation',
                            ...(sr?.stopReason ? { stopReason: sr.stopReason } : {}),
                            ...(output ? { output } : {}),
                        });
                    }
                    else {
                        const diagnostic = sr?.diagnostic?.trim() || stopReasonNote(sr?.stopReason);
                        deps.board?.settleTask(bindTaskId, 'failed', {
                            runId: handle.id,
                            stopReason: sr?.stopReason,
                            diagnostic,
                            ...(output ? { output } : {}),
                            note: diagnostic,
                        });
                        // 问题 7 扫尾：瞬时失败续跑同一子 agent；拒绝/轮数耗尽转主 agent 亲做。
                        void maybeSweep({
                            taskId: bindTaskId,
                            outcome: 'failed',
                            ...(sr?.stopReason ? { stopReason: sr.stopReason } : {}),
                            ...(output ? { output } : {}),
                        });
                    }
                }, (e) => {
                    // 仅基础设施无法表达为 stopReason 的故障才会走到 reject。
                    deps.dispatcher.forget?.(bindTaskId);
                    const message = e instanceof Error ? e.message : String(e);
                    deps.board?.settleTask(bindTaskId, 'failed', {
                        runId: handle.id,
                        stopReason: 'infrastructure-error',
                        diagnostic: message,
                        note: message,
                    });
                });
            }
            return { ok: true, runId: handle.id };
        }
        catch (e) {
            // 启动失败（信号量/start 抛错）：把已打开的 attempt 收口为失败（保留条目 FR-014），不留 running 悬挂。
            const message = e.message;
            if (deps.board && p.boardTaskId) {
                deps.board.settleTask(p.boardTaskId, 'failed', {
                    stopReason: 'dispatch-failed',
                    diagnostic: message,
                    note: message,
                });
            }
            return { ok: false, reason: message };
        }
    }
    /** 读取某次任务执行的过程轨迹（spec 006 US2）；服务缺失/会话不可读均降级为 available:false。 */
    async function getTaskTrace(taskId, attemptIndex) {
        if (!deps.trace) {
            return {
                ok: false,
                taskId,
                attempt: attemptIndex ?? -1,
                available: false,
                entries: [],
                reason: '轨迹服务不可用（宿主未提供 sessionQuery）',
            };
        }
        return deps.trace.getTrace(taskId, attemptIndex);
    }
    /**
     * 对任务追问 / 补充指令（spec 006 US3）。
     *
     * v1 采用「关联追问轮次」：同一任务、同一角色、同一冻结配置（模型/MCP/技能）与工作区，
     * 打开一条**新的 attempt / 新的子 run**，prompt 带上一轮输出或失败诊断 + 追问内容；
     * completed 任务由 `openFollowUp` 显式重开，历史 attempts 全部保留。
     * （continuable 同会话续聊需持久父会话，本插件 parent 不保证，列为后续增强，见 research.md。）
     */
    async function followUpTask(input) {
        const message = typeof input?.message === 'string' ? input.message.trim() : '';
        if (!message)
            return { ok: false, reason: '追问内容为空' };
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        const taskId = typeof input?.taskId === 'string' ? input.taskId : '';
        if (!taskId)
            return { ok: false, reason: 'taskId 必填' };
        const task = deps.board.snapshot().tasks.find(t => t.taskId === taskId);
        if (!task)
            return { ok: false, reason: `未知任务：${taskId}` };
        if (task.state === 'deleted')
            return { ok: false, reason: '任务已取消（终态），不可追问' };
        const role = deps.roles.getByName(task.roleAgent);
        if (!role || !role.provider?.trim()) {
            return { ok: false, reason: `任务角色「${task.roleAgent}」不存在或未绑定 provider，无法追问` };
        }
        // 沿用任务创建时冻结的配置（FR-012），不回退到角色当前值，保证可复现。
        // 模型路由成对回落（spec 009）：任务冻结缺 modelProvider 时再看角色默认 provider。
        const followUpRoute = resolveFrozenModelRoute({ frozen: task.frozenConfig, role });
        const frozenConfig = {
            mcp: [...(task.frozenConfig?.mcp ?? [])],
            skills: [...(task.frozenConfig?.skills ?? [])],
            model: followUpRoute.model,
            ...(followUpRoute.modelProvider ? { modelProvider: followUpRoute.modelProvider } : {}),
            // 问题 3/1：追问沿用任务冻结的预设、工作流与执行预算，保证可复现。
            ...(task.frozenConfig?.preset ? { preset: task.frozenConfig.preset } : {}),
            ...(task.frozenConfig?.workflow ? { workflow: task.frozenConfig.workflow } : {}),
            ...(task.frozenConfig?.maxDepth ? { maxDepth: task.frozenConfig.maxDepth } : {}),
            ...(task.frozenConfig?.maxTokens ? { maxTokens: task.frozenConfig.maxTokens } : {}),
        };
        // 工作目录沿用 任务级 > 需求级 回落（问题 1）；追问与首轮必须是同一个代码库。
        // 2026-11-03：上移到 parent 解析之前，理由同 `dispatch`（ensureParent 要用它当会话 cwd）。
        const requirementId = String(task.requirementId);
        const workspace = normalizeWorkspace(task.workspace ?? deps.board.board?.snapshot?.requirements?.[requirementId]?.workspace ?? '');
        // 与 dispatch 同样：先解析真实 parent，拿不到就**不**开新一轮 attempt，
        // 避免留下"running 但从未派发"的假执行。
        let parent;
        try {
            parent = deps.ensureParent ? await deps.ensureParent(workspace) : deps.getParent();
        }
        catch (e) {
            return { ok: false, reason: `派发前置条件不满足：${e.message}` };
        }
        // 上一轮结果/诊断（开新 attempt 之前最后一条已闭合尝试）。
        const prior = [...(task.attempts ?? [])].reverse().find(a => a.endedAt);
        const opened = deps.board.openFollowUp(taskId);
        if (!opened.ok || opened.attempt === undefined)
            return { ok: false, reason: opened.reason };
        const wsSection = buildWorkspacePromptSection({
            ...(workspace ? { workspace } : {}),
            taskTitle: task.title,
            workItemId: Number(requirementId.split('@')[0]) || undefined,
            collection: requirementId.split('@')[1],
        });
        const requirementPrompt = deps.board.board?.snapshot?.requirements?.[requirementId]?.prompt;
        const priorLines = [];
        if (prior) {
            priorLines.push(`【上一轮执行（${prior.outcome}${prior.stopReason ? ` / ${prior.stopReason}` : ''}）】`);
            if (prior.diagnostic)
                priorLines.push(`失败诊断：${prior.diagnostic}`);
            if (prior.output)
                priorLines.push(`上一轮输出：\n${prior.output}`);
        }
        const taskBackground = task.prompt?.trim() || [task.title, task.description].filter(s => s.trim().length > 0).join('\n\n');
        const promptText = [
            wsSection,
            requirementPrompt?.trim() ? `【需求提示词】\n${requirementPrompt.trim()}` : '',
            taskBackground ? `【任务背景】\n${taskBackground}` : '',
            priorLines.join('\n\n'),
            `【追问 / 补充指令】\n${message}\n\n请在同一代码库与需求上下文内继续完成该任务，并保持既有角色、模型与工具配置。`,
        ]
            .filter(s => s.length > 0)
            .join('\n\n');
        const prompt = [{ type: 'text', text: promptText }];
        const launched = await launchRun({
            requirementId: task.requirementId,
            taskId,
            boardTaskId: taskId,
            role,
            frozenConfig,
            prompt,
            parent,
        });
        const fresh = deps.board.snapshot().tasks.find(t => t.taskId === taskId);
        if (!launched.ok || !launched.runId) {
            return { ok: false, reason: launched.reason, ...(fresh ? { task: fresh } : {}) };
        }
        return {
            ok: true,
            runId: launched.runId,
            attempt: opened.attempt,
            ...(fresh ? { task: fresh } : {}),
        };
    }
    function listRequirements(filter) {
        return deps.adapter.listRequirements(filter);
    }
    // ───────────────── 需求筛选可选项缓存（问题 1：落盘优先） ─────────────────
    //
    // ## 缓存语义（2026-09-20 按问题 1 重写）
    //
    // - 权威缓存是插件数据目录的 **`query-options.json`（按集合命名空间）**，由 BoardService
    //   两个 JsonStore 方法读写：首次采集后落盘，之后每次打开面板/切页签都**优先读盘**，
    //   不再重复调用 TFS 元数据接口（逐项目取类型/状态曾是数百次 REST 的开销）。
    // - 「采集可选项」按钮 → `collectQueryOptions` 强制重采并原子覆盖落盘。
    // - 进程内只保留**并发去重**登记（同一集合的并发首采共享一次真实采集），不做第二份缓存。
    /**
     * 并发去重：同一集合的并发请求共享一次真实采集（否则 N 次进入 = N 轮全量采集）。
     *
     * 值是 `{ key, promise }` 而不是裸 promise：`key` 是本次登记的令牌，用于收尾时
     * "只撤自己那一项"（期间登记项可能已被 `refreshQueryOptions` 换成别人的）。
     * 裸 promise 做不到这点——要么自引用（TS2454），要么误删别人的登记。
     */
    const queryOptionsInflight = new Map();
    /** 只撤自己登记的那一项；若期间已被别人替换，则原样保留。 */
    function retireInflight(col, key) {
        const cur = queryOptionsInflight.get(col);
        if (cur && cur.key === key)
            queryOptionsInflight.delete(col);
    }
    /** 当前生效集合（优先取运行期 getter，回退值捕获的 `deps.collection`）。 */
    function currentCollection() {
        const live = deps.currentCollection?.();
        return typeof live === 'string' && live.length > 0 ? live : deps.collection;
    }
    /**
     * 读盘优先的可选项获取（问题 1）。
     * 落盘缓存命中 → 直接返回；未命中 → 采集一轮并落盘（BoardService.collectQueryOptions
     * 内部含"全空不落盘"判据）；看板服务缺失时回退直接采集（旧行为）。
     */
    function getQueryOptions() {
        const col = currentCollection();
        if (deps.board) {
            const cached = deps.board.loadQueryOptions(col);
            if (cached.data)
                return Promise.resolve(cached.data);
        }
        const pending = queryOptionsInflight.get(col);
        if (pending)
            return pending.promise;
        const key = {};
        const promise = (async () => {
            try {
                if (deps.board) {
                    const r = await deps.board.collectQueryOptions(col);
                    if (r.ok && r.data)
                        return r.data;
                    // 落盘采集失败：回落直接调适配层（保留旧的错误透传行为）。
                }
                return await deps.adapter.getQueryOptions(col);
            }
            finally {
                retireInflight(col, key);
            }
        })();
        queryOptionsInflight.set(col, { key, promise });
        return promise;
    }
    /** 「采集可选项」按钮：强制重采并落盘覆盖（问题 1）。 */
    async function refreshQueryOptions() {
        const col = currentCollection();
        // 刻意**不复用** inflight 里的旧采集：本方法的语义就是"另起一次真实采集"。
        // 但仍把自己登记进 inflight，让并发的普通请求共享这次重采，不重复打 TFS。
        const key = {};
        const promise = (async () => {
            if (deps.board) {
                const r = await deps.board.collectQueryOptions(col);
                if (r.ok && r.data)
                    return r.data;
                throw new Error(r.reason ?? '采集可选项失败');
            }
            return await deps.adapter.getQueryOptions(col);
        })();
        queryOptionsInflight.set(col, { key, promise });
        try {
            return await promise;
        }
        finally {
            retireInflight(col, key);
        }
    }
    /** HostBridge 直通：读盘（无缓存 data=null）。 */
    async function loadQueryOptions(collection) {
        const col = collection || currentCollection();
        if (deps.board)
            return deps.board.loadQueryOptions(col);
        return { ok: false, data: null, reason: '看板服务不可用' };
    }
    /** HostBridge 直通：强制重采并落盘。 */
    async function collectQueryOptions(collection) {
        const col = collection || currentCollection();
        if (deps.board)
            return deps.board.collectQueryOptions(col);
        return { ok: false, reason: '看板服务不可用' };
    }
    async function loadUiState(collection) {
        const col = collection || currentCollection();
        return deps.board ? deps.board.loadUiState(col) : {};
    }
    async function saveUiState(patch, collection) {
        const col = collection || currentCollection();
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        return deps.board.saveUiState(patch, col);
    }
    function listRoles() {
        return deps.roles.list();
    }
    function saveRole(role) {
        try {
            deps.roles.save(role);
            return { ok: true };
        }
        catch (e) {
            return { ok: false, reason: e.message };
        }
    }
    function deleteRole(id, force) {
        const role = deps.roles.list().find(r => r.id === id);
        if (!role)
            return { ok: false, reason: `角色 ${id} 不存在` };
        // T057：被任务引用的角色默认拒绝删除，给出受影响引用清单；force=true 才真正删除。
        const references = (deps.getRoleReferences ?? defaultRoleReferences)?.(role.name) ?? [];
        if (references.length > 0 && !force) {
            return {
                ok: false,
                reason: `角色「${role.name}」仍被 ${references.length} 处引用，删除前请确认`,
                references,
            };
        }
        const removed = deps.roles.delete(id);
        return removed ? { ok: true } : { ok: false, reason: `角色 ${id} 删除失败` };
    }
    /** 缺省引用解析：从看板任务里找引用该角色的任务 ID（真实引用，非空壳实现）。 */
    function defaultRoleReferences(roleName) {
        if (!deps.board)
            return [];
        return deps.board.listTasks({ roleAgent: roleName }).map(t => t.taskId);
    }
    // ── 技能/MCP 分组（2026-11-03 用户诉求） ──
    function listSkillGroups() {
        return deps.skillGroups?.list() ?? [];
    }
    function saveSkillGroup(group) {
        if (!deps.skillGroups)
            return { ok: false, reason: '技能分组存储不可用（宿主未接线 SkillGroupStore）' };
        try {
            deps.skillGroups.save(group);
            return { ok: true };
        }
        catch (e) {
            return { ok: false, reason: e.message };
        }
    }
    function deleteSkillGroup(id) {
        if (!deps.skillGroups)
            return { ok: false, reason: '技能分组存储不可用（宿主未接线 SkillGroupStore）' };
        try {
            const removed = deps.skillGroups.delete(id);
            return removed ? { ok: true } : { ok: false, reason: `分组 ${id} 不存在` };
        }
        catch (e) {
            return { ok: false, reason: e.message };
        }
    }
    /** 看板能力缺失时的统一降级返回。 */
    function boardUnavailable() {
        return {
            ok: false,
            reason: '看板服务不可用（插件数据目录不可写或初始化失败）',
            version: 0,
            updatedAt: '',
            requirements: [],
            tasks: [],
            counts: { pending: 0, inProgress: 0, completed: 0, running: 0, queued: 0 },
        };
    }
    function getBoard() {
        if (!deps.board)
            return boardUnavailable();
        return deps.board.snapshot();
    }
    async function claimRequirement(input) {
        if (!deps.board)
            return { ok: false, added: false, reason: '看板服务不可用' };
        return deps.board.claimRequirement(input);
    }
    async function decomposeRequirement(requirementId) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        if (typeof requirementId !== 'string' || requirementId.length === 0) {
            return { ok: false, reason: 'requirementId 必填' };
        }
        const result = deps.board.decompose(requirementId);
        /**
         * spec 010 US2：拆解成功后**立即**为该需求准备编排主 agent。
         *
         * 为什么放在这里：`ensure` 之后共享简报才存在，随后自动链式派发的第一个任务
         * 就能拿到「摘要 + 已绑定工具」而不是需求正文全文。失败只记原因（`mode:'off'`），
         * **不影响拆解结果** —— 编排是增强能力，不是拆解的前置条件。
         */
        if (result.ok) {
            try {
                const req = deps.board.board?.snapshot?.requirements?.[requirementId];
                await deps.orchestrator?.ensure(requirementId, {
                    ...(req ? { title: req.title, workspace: req.workspace } : {}),
                    ...(req ? { digestSeed: buildDigestSeed(req) } : {}),
                    tools: { mcp: [], skills: [] },
                });
            }
            catch {
                // 编排会话创建失败由 ensure 内部落 `mode:'off'` + reason，此处不外溢。
            }
        }
        return result;
    }
    /**
     * spec 010 US1：确保需求有编排主 agent 会话（幂等；失败 fail-loud 落 `mode:'off'`）。
     */
    async function orchestratorEnsure(input) {
        const key = typeof input?.requirementKey === 'string' ? input.requirementKey.trim() : '';
        if (key.length === 0)
            return { ok: false, reason: 'requirementKey 必填' };
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用，无法登记编排会话' };
        if (!deps.orchestrator) {
            return {
                ok: false,
                reason: '编排主 agent 未装配（宿主未提供 continuable 能力或插件配置已关闭）：'
                    + '任务仍可正常派发与执行，但没有 AI 归纳与最终总结',
            };
        }
        try {
            const req = deps.board.board?.snapshot?.requirements?.[key];
            const orch = await deps.orchestrator.ensure(key, {
                ...(req ? { title: req.title, workspace: req.workspace } : {}),
                ...(req ? { digestSeed: buildDigestSeed(req) } : {}),
                // 面板按钮 = 用户显式要求重试：即便之前判过 "off" 也再试一次。
                ...(input.force === true ? { force: true } : {}),
            });
            return { ok: orch.mode === 'continuable', orchestration: orch, ...(orch.reason ? { reason: orch.reason } : {}) };
        }
        catch (e) {
            return { ok: false, reason: e.message };
        }
    }
    async function restoreRequirement(requirementKey) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
            return { ok: false, reason: 'requirementKey 必填' };
        }
        return deps.board.restoreRequirement(requirementKey);
    }
    async function enrichRequirement(requirementKey) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        if (typeof requirementKey !== 'string' || requirementKey.length === 0) {
            return { ok: false, reason: 'requirementKey 必填' };
        }
        return deps.board.enrichRequirement(requirementKey);
    }
    async function deleteTasks(taskIds) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        if (!Array.isArray(taskIds) || taskIds.length === 0)
            return { ok: false, reason: '未选择任何任务' };
        return deps.board.deleteTasks(taskIds);
    }
    /**
     * 编辑已领取需求的本地字段（问题 3）。
     *
     * 只透传**本地补充字段**（prompt / workspace）：TFS 侧字段必须走 `confirmWrite` 的四道门禁，
     * 从这条路径改会绕过写门禁与审计 —— 这正是本方法要做输入白名单的原因，而不是直接
     * 把 body 展开给 BoardService。
     */
    async function updateRequirement(input) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        const key = typeof input?.requirementKey === 'string' ? input.requirementKey : '';
        if (key.length === 0)
            return { ok: false, reason: 'requirementKey 必填' };
        const patch = {};
        if ('workspace' in input) {
            const ws = input.workspace;
            if (ws !== null && typeof ws !== 'string')
                return { ok: false, reason: 'workspace 必须是字符串或 null' };
            patch.workspace = ws;
        }
        if ('prompt' in input) {
            const p = input.prompt;
            if (p !== null && typeof p !== 'string')
                return { ok: false, reason: 'prompt 必须是字符串或 null' };
            patch.prompt = p;
        }
        if (Object.keys(patch).length === 0)
            return { ok: false, reason: '未提供任何可改字段（prompt / workspace）' };
        return deps.board.updateRequirementMeta(key, patch);
    }
    /**
     * 设置需求级执行状态（问题 5：确认完成 / 取消完成）。
     *
     * 只接受 `'active' | 'completed'` 两个字面量：状态是 UI 分页（任务中心 ⇄ 已完成）的依据，
     * 放开成任意字符串会让需求掉进"两个页都不显示"的缝隙。
     */
    async function setRequirementExecState(input) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        const key = typeof input?.requirementKey === 'string' ? input.requirementKey : '';
        if (key.length === 0)
            return { ok: false, reason: 'requirementKey 必填' };
        const state = input?.state;
        if (state !== 'active' && state !== 'completed') {
            return { ok: false, reason: "state 必须是 'active'（取消完成）或 'completed'（确认完成）" };
        }
        return deps.board.setRequirementExecState(key, state);
    }
    /** 编辑任务字段（问题 4）。校验放宿主：客户端半没有类型运行时，入参可能来自任意调用方。 */
    async function updateTask(input) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        const taskId = typeof input?.taskId === 'string' ? input.taskId : '';
        if (taskId.length === 0)
            return { ok: false, reason: 'taskId 必填' };
        const patch = {};
        if ('prompt' in input) {
            const p = input.prompt;
            if (p !== null && typeof p !== 'string')
                return { ok: false, reason: 'prompt 必须是字符串或 null' };
            patch.prompt = p;
        }
        if ('workspace' in input) {
            const ws = input.workspace;
            if (ws !== null && typeof ws !== 'string')
                return { ok: false, reason: 'workspace 必须是字符串或 null' };
            patch.workspace = ws;
        }
        if (input.model !== undefined) {
            if (typeof input.model !== 'string')
                return { ok: false, reason: 'model 必须是字符串' };
            patch.model = input.model;
        }
        if (input.modelProvider !== undefined) {
            if (typeof input.modelProvider !== 'string') {
                return { ok: false, reason: 'modelProvider 必须是字符串' };
            }
            patch.modelProvider = input.modelProvider;
        }
        for (const field of ['skills', 'mcp']) {
            const v = input[field];
            if (v === undefined)
                continue;
            if (!Array.isArray(v) || v.some(x => typeof x !== 'string')) {
                return { ok: false, reason: `${field} 必须是字符串数组` };
            }
            patch[field] = [...v];
        }
        // 问题 3：预设（agent preset id，允许空串=清空回落角色定义）。
        if (input.preset !== undefined) {
            if (typeof input.preset !== 'string')
                return { ok: false, reason: 'preset 必须是字符串' };
            patch.preset = input.preset;
        }
        // 2026-10-29（诉求 4）：工作流技能名（空串 = 清空工作流）。
        if (input.workflow !== undefined) {
            if (typeof input.workflow !== 'string')
                return { ok: false, reason: 'workflow 必须是字符串' };
            patch.workflow = input.workflow;
        }
        // 问题 1：执行预算（非负有限数；0 = 沿用默认/不限制）。
        for (const field of ['maxDepth', 'maxTokens']) {
            const v = input[field];
            if (v === undefined)
                continue;
            if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
                return { ok: false, reason: `${field} 必须是非负有限数` };
            }
            patch[field] = v;
        }
        if (Object.keys(patch).length === 0) {
            return {
                ok: false,
                reason: '未提供任何可改字段（prompt / workspace / model / modelProvider / skills / mcp / preset / workflow / maxDepth / maxTokens）',
            };
        }
        if (input.expectedRevision !== undefined) {
            if (!Number.isInteger(input.expectedRevision) || input.expectedRevision < 0) {
                return { ok: false, reason: 'expectedRevision 必须是非负整数' };
            }
        }
        return deps.board.updateTask(taskId, patch, input.expectedRevision);
    }
    function assignTask(taskId, roleName) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        return deps.board.assignTask(taskId, roleName);
    }
    /**
     * 「启动 / 重试」任务时**真正发起一次派发**（2026-09-21 假执行事故修复点）。
     *
     * ## 为什么需要
     *
     * 看板 `start` / `retry` 只把任务写成 `in_progress + execState=running` 并追加一条空
     * attempt（`Board.startTask`），**本身不做任何派发**；UI 上「启动」「重试」又是独立按钮。
     * 于是用户点完看到的是"进行中"，而子智能体从未创建 —— 零 token、零产物，且永远没有收口，
     * 任务会永久停在 running。这不是"重试"，是假执行。
     *
     * 这里在状态落地后立即按任务自己的角色与冻结配置发起真实派发。任一前置条件不满足
     * （角色未绑 provider / 拿不到真实 parent）都**当场收口为 failed 并写诊断**，
     * 绝不留悬空 running。
     *
     * @param taskId - 看板任务 id（调用前该任务的 attempt 必须已由 start/retry 打开）。
     */
    async function launchBoardTaskExecution(taskId) {
        if (!deps.board)
            return;
        /** 收口为失败并写入可读诊断（attempt 有 endedAt 与 diagnostic，用户能看到原因）。 */
        const settleFailed = (note) => {
            deps.board?.settleTask(taskId, 'failed', {
                stopReason: 'dispatch-failed',
                diagnostic: note,
                note,
            });
        };
        try {
            const task = deps.board.snapshot().tasks.find(t => t.taskId === taskId);
            if (!task)
                return;
            const role = deps.roles.getByName(task.roleAgent);
            if (!role?.provider?.trim()) {
                settleFailed(`任务角色「${task.roleAgent}」不存在或未绑定 provider（检查 US5 角色配置）`);
                return;
            }
            // 与 `dispatch` / `followUpTask` 同口径的三段式组装：工作目录 → 需求级提示词 → 任务正文。
            // 工作目录同样按 任务级 > 需求级 回落（问题 1：只在任务上设、或只在需求上设，都必须生效）。
            // 2026-11-03：上移到 parent 解析之前（ensureParent 需要它当会话 cwd）。
            const requirementId = String(task.requirementId);
            const requirementWorkspace = deps.board.board?.snapshot?.requirements?.[requirementId]?.workspace;
            const workspace = normalizeWorkspace(task.workspace ?? requirementWorkspace ?? '');
            let parent;
            try {
                parent = deps.ensureParent ? await deps.ensureParent(workspace) : deps.getParent();
            }
            catch (e) {
                settleFailed(`派发前置条件不满足：${e.message}`);
                return;
            }
            const wsSection = buildWorkspacePromptSection({
                ...(workspace ? { workspace } : {}),
                taskTitle: task.title,
                workItemId: Number(requirementId.split('@')[0]) || undefined,
                collection: requirementId.split('@')[1],
            });
            const requirementPrompt = deps.board.board?.snapshot?.requirements?.[requirementId]?.prompt;
            const body = task.prompt?.trim()
                || [task.title, task.description].filter(s => typeof s === 'string' && s.trim().length > 0).join('\n\n');
            const promptText = [
                wsSection,
                requirementPrompt?.trim() ? `【需求提示词】\n${requirementPrompt.trim()}` : '',
                body,
            ].filter(s => s.length > 0).join('\n\n');
            const boardRoute = resolveFrozenModelRoute({ frozen: task.frozenConfig, role });
            await launchRun({
                requirementId: task.requirementId,
                taskId,
                boardTaskId: taskId,
                role,
                frozenConfig: {
                    mcp: [...(task.frozenConfig?.mcp ?? [])],
                    skills: [...(task.frozenConfig?.skills ?? [])],
                    model: boardRoute.model,
                    ...(boardRoute.modelProvider ? { modelProvider: boardRoute.modelProvider } : {}),
                    // 问题 3/1：任务编辑后的预设、工作流与执行预算随启动生效。
                    ...(task.frozenConfig?.preset ? { preset: task.frozenConfig.preset } : {}),
                    ...(task.frozenConfig?.workflow ? { workflow: task.frozenConfig.workflow } : {}),
                    ...(task.frozenConfig?.maxDepth ? { maxDepth: task.frozenConfig.maxDepth } : {}),
                    ...(task.frozenConfig?.maxTokens ? { maxTokens: task.frozenConfig.maxTokens } : {}),
                },
                prompt: [{ type: 'text', text: promptText }],
                parent,
            });
        }
        catch (e) {
            // 调用方（setTaskState）是 fire-and-forget，不会 await 本函数：这里必须吞掉一切异常
            // 并收口，绝不能让它变成 unhandled rejection（那会连同进程一起把错误藏起来）。
            settleFailed(`派发过程异常：${e instanceof Error ? e.message : String(e)}`);
        }
    }
    function setTaskState(taskId, action, expectedRevision) {
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        const result = deps.board.setTaskState(taskId, action, expectedRevision);
        if (!result.ok)
            return result;
        /**
         * 启动 / 重试 = 真的执行。
         *
         * 状态已落地为 `in_progress + running`，这里必须紧跟着发起真实派发，否则该任务会
         * 永远停在"执行中"（假执行）。fire-and-forget 是刻意的：本 API 是同步契约，
         * 派发时长不可预期（含并发排队）；失败由 `launchBoardTaskExecution` 内部收口为
         * failed 并写诊断，UI 下一次轮询即可看到真实结局。
         */
        if (action === 'start' || action === 'retry') {
            void launchBoardTaskExecution(taskId);
        }
        return result;
    }
    async function healthCheck() {
        if (!deps.health)
            return { ok: false, kind: 'unknown', reason: '连通性自检不可用（适配层未接线）' };
        return runHealthCheck(deps.health.port, deps.health.availableTools?.());
    }
    // ───────────────────────── T063 审计归档 ─────────────────────────
    function getAudit() {
        if (!deps.audit) {
            return {
                ok: false,
                total: 0,
                expired: 0,
                retentionDays: 0,
                archiveFiles: [],
                reason: '审计归档服务不可用（数据目录不可写或初始化失败）',
            };
        }
        return deps.audit.inspect();
    }
    function archiveAudit() {
        if (!deps.audit)
            return { ok: false, reason: '审计归档服务不可用' };
        return deps.audit.archive();
    }
    // ───────────────────────── T030 集合切换 ─────────────────────────
    function setCollection(collection) {
        const name = (collection ?? '').trim();
        if (name.length === 0)
            return { ok: false, reason: 'collection 不可为空' };
        const allowed = deps.collections?.length ? deps.collections : [deps.collection];
        if (!allowed.includes(name)) {
            return { ok: false, reason: `集合 "${name}" 不在可切换清单内（allowed: ${allowed.join(', ')}）` };
        }
        if (!deps.onCollectionChange) {
            return { ok: false, reason: '集合切换未接线（运行期无法改变目标集合）' };
        }
        try {
            deps.onCollectionChange(name);
        }
        catch (e) {
            return { ok: false, reason: `切换集合失败：${e.message}` };
        }
        return { ok: true, collection: name };
    }
    // ───────────────────────── T031 连接档案 + T028b MCP 接入 ─────────────────────────
    function listProfiles() {
        if (!deps.profiles)
            return { ok: false, profiles: [], reason: '连接档案服务不可用' };
        const profiles = deps.profiles.list();
        const activeId = deps.profiles.activeId();
        return { ok: true, profiles, ...(activeId ? { activeId } : {}) };
    }
    function saveProfile(input) {
        if (!deps.profiles)
            return { ok: false, reason: '连接档案服务不可用' };
        if (typeof input !== 'object' || input === null)
            return { ok: false, reason: '请求体必须为对象' };
        return deps.profiles.save(input);
    }
    function deleteProfile(id) {
        if (!deps.profiles)
            return { ok: false, reason: '连接档案服务不可用' };
        if (typeof id !== 'string' || id.trim().length === 0)
            return { ok: false, reason: 'id 必填' };
        return deps.profiles.remove(id);
    }
    function activateProfile(id) {
        if (!deps.profiles)
            return { ok: false, reason: '连接档案服务不可用' };
        if (typeof id !== 'string' || id.trim().length === 0)
            return { ok: false, reason: 'id 必填' };
        const result = deps.profiles.activate(id);
        // 真实效果：把活动档案的集合同步到适配层（URL/PAT 变更需重启，见 ProfileService 注释）。
        if (result.ok && result.profile && deps.onCollectionChange) {
            const allowed = deps.collections?.length ? deps.collections : [deps.collection];
            if (allowed.includes(result.profile.collection))
                deps.onCollectionChange(result.profile.collection);
        }
        return result;
    }
    function getMcpEnvTemplate(profileId) {
        if (!deps.profiles) {
            return {
                ok: false,
                serverName: deps.mcpServers[0] ?? '',
                serverNameValid: false,
                envFilePath: '',
                posixLines: [],
                powershellLines: [],
                note: '连接档案服务不可用，无法生成接入模板',
            };
        }
        return deps.profiles.envTemplate(profileId);
    }
    function writeMcpEnvFile(profileId) {
        if (!deps.profiles)
            return { ok: false, reason: '连接档案服务不可用' };
        return deps.profiles.writeEnvFile(profileId);
    }
    function getMcpInstance() {
        if (deps.profiles)
            return deps.profiles.instance();
        return {
            serverName: deps.mcpServers[0] ?? '',
            serverNameValid: false,
            toolPrefix: `mcp__${deps.mcpServers[0] ?? ''}__`,
            runtimeAddSupported: false,
            runtimeAddReason: '连接档案服务不可用，无法读取实例诊断',
            serverNameConstraint: '^[A-Za-z0-9_-]{1,32}$',
            duplicateRisk: '未知',
            credentialPath: '未知',
        };
    }
    function getTfsToolCatalog() {
        if (!deps.tfsToolCatalog)
            return TFS_TOOL_CATALOG_UNAVAILABLE;
        try {
            return deps.tfsToolCatalog();
        }
        catch (e) {
            // 目录是现算的（读 ctx.tools.schemas()），失败必须给出原因而不是静默空表。
            return { ...TFS_TOOL_CATALOG_UNAVAILABLE, reason: e.message };
        }
    }
    /**
     * 任务收口后的宿主侧编排（问题 6 自动链式 / 问题 4 自动回写）。
     *
     * 由 BoardService 在任务收口且看板落盘后以 microtask 异步调用（见 `setSettledHook`）。
     * - 仅 `success` 收口推进：待人工确认 / 失败任务**不**自动续跑、**不**触发回写（问题 5）；
     * - 自动链式：`autoStartRunnable` 一次性启动所有已就绪任务（引擎按在跑数扣并发槽、幂等防重），
     *   再逐个 fire-and-forget 发起真实派发；
     * - 自动回写：交给 finalizer 的 `maybeFinalize`（内部判"需求全部完成"、幂等、防重入），失败不外溢。
     */
    /**
     * 任务收口后的宿主侧编排（问题 6 自动链式 / 问题 4 自动回写 / spec 010 主 agent 归纳）。
     *
     * 顺序（spec 010 US2）：
     *   1. 只有 `success` 收口才推进（待人工确认 / 失败一律阻断，沿用既有门禁）；
     *   2. **先让编排主 agent 归纳**本任务并把结论合进共享简报（AC2.2）；
     *      归纳是 `await` 的 —— 否则下一个任务会在结论写进简报**之前**就被派发出去，
     *      简报复用就成了空话。但它带超时，主 agent 卡住时按"无摘要"放行，不阻断链路；
     *   3. 再 `autoStartRunnable` 放行下一批就绪任务；
     *   4. 需求全部完成时：先问主 agent 要**最终总结**（AC2.4），再触发 TFS 回写。
     */
    async function handleTaskSettled(info) {
        if (info.outcome !== 'success')
            return;
        /**
         * ── ② 主 agent 归纳：**不能阻塞放行**（2026-10-01 修复）──
         *
         * 上一版写成 `await summarize(...)` 再 `autoStartRunnable`：而 continuable 子会话
         * **没有 per-message result**，归纳完成只能靠事件/轮询观测，观测不到就会等满
         * `summarizeTimeoutSeconds`（默认 120s）⇒ 用户看到"上一个任务完成了，下一个 2 分钟没动静"。
         *
         * 现在的口径：**归纳与放行并行**，只给归纳一个短"宽限"
         * （`summarizeGraceMs`，默认 20s）——
         *   - 宽限内拿到结论 ⇒ 结论进简报，**下一个任务的 prompt 就能复用它**（AC2.2 的本意）；
         *   - 宽限内没拿到 ⇒ **立刻放行下一个任务**，归纳继续在后台跑完并写回简报（给再下一个任务用）；
         *   - 归纳自身永不 reject（已在闭包里吞掉），后台跑完不会变成 unhandled rejection。
         *
         * 结论：链路推进（主路径）不再依赖归纳（增强路径）。
         */
        const summarizeDone = (async () => {
            try {
                await deps.orchestrator?.summarize(info.requirementKey, info.taskId);
            }
            catch {
                // 归纳是增强能力：任何意外都不应影响已完成任务的收口结果。
            }
        })();
        await Promise.race([summarizeDone, delay(deps.summarizeGraceMs ?? 20_000)]);
        if (deps.autoChainTasks !== false && deps.board && typeof deps.board.autoStartRunnable === 'function') {
            try {
                await startRequirementChain(info.requirementKey);
            }
            catch {
                // 自动续跑是增强能力：任何意外都不应影响已完成任务的收口结果。
            }
        }
        // ── ④ 回写：需求全部完成时才先问主 agent 要最终总结（AC2.4）──
        if (deps.autoWriteBack !== false && deps.finalizer) {
            const allDone = deps.board?.board?.isRequirementAllTasksDone?.(info.requirementKey) === true;
            let finalSummary;
            if (allDone) {
                /**
                 * 全部完成时已没有"下一个任务"要放行，这里等最终总结是合理的；
                 * 但同样加宽限（不无限等）——拿不到就回退模板总结，并在评论里标注来源。
                 */
                const finalizeDone = (async () => {
                    try {
                        return await deps.orchestrator?.finalize(info.requirementKey);
                    }
                    catch {
                        return undefined;
                    }
                })();
                finalSummary = await Promise.race([
                    finalizeDone,
                    delay(deps.finalizeGraceMs ?? 60_000).then(() => undefined),
                ]);
            }
            void deps.finalizer
                .maybeFinalize(info.requirementKey, ...(finalSummary ? [{ finalSummary }] : []))
                .catch(() => {
                /* 回写失败由报告与"重新回写"入口承载，不打断任务流 */
            });
        }
    }
    /**
     * 启动某需求的编排链：把**已就绪**（依赖全完成）的待办任务置为运行中并逐个真实派发。
     *
     * 串行口径（2026-11-03 问题 5）：需求的 `orchestration.dispatchSequential=true`
     * 时并发上限压到 1 —— 上个任务完成才编排下个；否则沿用全局 `dispatchConcurrency`。
     * 依赖顺序本身由引擎 `blockedBy` 保证（只选"依赖全 completed"的就绪任务）。
     */
    async function startRequirementChain(requirementKey) {
        if (!deps.board || typeof deps.board.autoStartRunnable !== 'function')
            return;
        const orch = deps.board.getOrchestration?.(requirementKey);
        const limit = orch?.dispatchSequential ? 1 : (deps.dispatchConcurrency ?? 3);
        const started = deps.board.autoStartRunnable(limit, requirementKey);
        for (const id of started.taskIds)
            void launchBoardTaskExecution(id);
    }
    /**
     * 开始编排（2026-11-03 问题 4/5）：立刻启动某需求的子 Agent 链，或登记为定时启动。
     *
     * - `mode:'now'` ⇒ 直接 {@link startRequirementChain}（拆解弹框「立刻」/ 到点触发共用）；
     * - `mode:'at'` ⇒ 交给调度器，到点后调度器以 `mode:'now'` 回调本方法（持久化 + 重启补跑）。
     *
     * `sequential:true`（拆解弹框的默认口径）会写进需求编排状态，链式放行全程保持
     * "一次只编排一个子 Agent"。
     */
    async function orchestrationStart(input) {
        const key = typeof input?.requirementKey === 'string' ? input.requirementKey.trim() : '';
        if (!key)
            return { ok: false, reason: 'requirementKey 必填' };
        if (!deps.board)
            return { ok: false, reason: '看板服务不可用' };
        const seq = input.sequential === true;
        // 串行标志先落编排状态：链式放行（handleTaskSettled）据此压并发。
        const existing = deps.board.getOrchestration?.(key);
        if (existing && (existing.dispatchSequential === true) !== seq && typeof deps.board.setOrchestration === 'function') {
            deps.board.setOrchestration(key, { ...existing, dispatchSequential: seq });
        }
        else if (!existing && seq && typeof deps.board.setOrchestration === 'function') {
            deps.board.setOrchestration(key, { mode: 'off', dispatchSequential: true });
        }
        if (input.mode === 'now') {
            await startRequirementChain(key);
            return { ok: true };
        }
        const dueAt = input.dueAt ?? '';
        const dueMs = Date.parse(dueAt);
        if (Number.isNaN(dueMs))
            return { ok: false, reason: '定时时间无效（不是合法 ISO 时间）' };
        if (dueMs <= Date.now())
            return { ok: false, reason: '定时时间必须晚于当前时间' };
        if (!deps.scheduler)
            return { ok: false, reason: '调度器未装配（插件与宿主版本不匹配）：无法登记定时编排' };
        const reg = deps.scheduler.schedule({
            id: `chain:${key}`,
            dueAt,
            kind: 'chain',
            payload: { requirementKey: key, sequential: seq },
            note: `定时开始编排：${key}`,
        });
        if (!reg.ok)
            return { ok: false, reason: reg.reason ?? '登记定时编排失败' };
        return { ok: true, scheduledAt: dueAt };
    }
    /**
     * 主 agent 扫尾（2026-11-03 问题 7）：任务收口为 `needs_confirmation` / `failed` 时的
     * 自动善后。决策纯逻辑在 `shared/sweep.ts#decideSweep`，本函数只执行：
     *
     *   1. **续跑**（待人工确认 ⇒ 选推荐选项让同一子 agent 继续；瞬时失败 ⇒ 继续/重试）——
     *      走既有 `followUpTask`（同角色同冻结配置起新一轮，携带上一轮输出）；
     *   2. **主 agent 亲做**（拒绝 / 扫尾轮数耗尽 / 续跑派发失败）——
     *      `openFollowUp` 重开后由编排主 agent 直接完成，产出按 TASK_DONE 判成败收口；
     *   3. 收口成功即触发既有链式放行（`afterTaskSettled`），自动编排下一个子 agent。
     *
     * **永不抛错**：扫尾是增强能力，任何异常只落事件级痕迹，不打断收口主路径。
     */
    async function maybeSweep(input) {
        try {
            if (deps.sweepEnabled === false)
                return;
            const board = deps.board;
            if (!board)
                return;
            const task = board.snapshot().tasks.find(t => t.taskId === input.taskId);
            if (!task)
                return;
            const sweepRound = task.orchestration?.sweepRound ?? 0;
            const action = decideSweep({
                outcome: input.outcome,
                ...(input.stopReason ? { stopReason: input.stopReason } : {}),
                ...(input.output ? { output: input.output } : {}),
                sweepRound,
                maxSweepRounds: deps.sweepMaxRounds ?? 2,
            });
            if (action.kind === 'none')
                return;
            if (action.kind === 'continue_with_recommendation' || action.kind === 'retry_continue') {
                let recommendation = action.kind === 'continue_with_recommendation' ? action.recommendation : '';
                // 推荐项解析不出时交主 agent 对着输出决断（诉求 7："主 agent 选择推荐选项"）。
                if (action.kind === 'continue_with_recommendation' && !recommendation) {
                    recommendation = await (deps.orchestrator?.decide(task.requirementId, `【主 agent 扫尾】子 agent 请求人工确认，请你看它的输出并**选出推荐选项**，`
                        + `只回复一行：CHOICE: <选项或决定>\n\n子 agent 输出尾部：\n${(input.output ?? '').slice(-1200)}`) ?? Promise.resolve(''));
                    if (recommendation) {
                        const m = /CHOICE\s*[:：]\s*(.+)/i.exec(recommendation);
                        recommendation = (m?.[1] ?? recommendation).trim();
                    }
                }
                const message = buildContinuePrompt({
                    recommendation,
                    ...(input.output ? { outputTail: input.output.slice(-800) } : {}),
                });
                if (typeof board.setTaskOrchestration === 'function') {
                    board.setTaskOrchestration(input.taskId, { sweepRound: sweepRound + 1 });
                }
                const r = await followUpTask({ taskId: input.taskId, message });
                if (!r.ok) {
                    await mainAgentComplete(input.taskId, `扫尾续跑派发失败：${r.reason ?? '未知原因'}`);
                }
                return;
            }
            // action.kind === 'main_agent_completes'
            await mainAgentComplete(input.taskId, action.reason);
        }
        catch {
            // 扫尾绝不外溢：留待人工处理（UI 上任务状态已如实可见）。
        }
    }
    /**
     * 扫尾兜底：主 agent **亲自**完成任务（问题 7 第 3 条）。
     *
     * `openFollowUp` 重开一条 attempt → 编排主 agent 直接干活 → 按其输出收口。
     * 收口成功会经 `afterTaskSettled` 自动放行下一个子 agent（问题 7 末句）。
     */
    async function mainAgentComplete(taskId, reason) {
        const board = deps.board;
        if (!board)
            return;
        const task = board.snapshot().tasks.find(t => t.taskId === taskId);
        if (!task)
            return;
        const opened = board.openFollowUp(taskId);
        if (!opened.ok) {
            // 连重开都失败（终态/并发冲突）：任务保持原样，人工入口仍在。
            return;
        }
        const prompt = buildMainAgentCompletePrompt({
            taskId,
            title: task.title,
            ...(task.prompt ? { taskPrompt: task.prompt } : {}),
            reason,
        });
        /**
         * 2026-11-03 问题 4：**开 attempt 后必须恒收口** —— `decide` 抛错/悬挂曾让
         * 打开的尝试裸奔到运行期看门狗（无 runId 超时 → 标 failed），而任务本体可能
         * 早已被子 agent 做完（实机 2055202 attempt 4）。故 try/catch 兜异常、
         * race 兜悬挂（decide 自身超时即便失效也有硬上限）。
         */
        const decideTimeoutMs = 240_000;
        let text = '';
        try {
            text = await Promise.race([
                deps.orchestrator?.decide(task.requirementId, prompt, {
                    // 亲做是"整干一个任务"，给足时间（缺省 4 分钟；编排内部超时不受此影响）。
                    timeoutMs: decideTimeoutMs,
                }) ?? Promise.resolve(''),
                // 悬挂兜底：decide 若不兑现自身超时，5s 宽限后按"无产出"收口，绝不留 running。
                delay(decideTimeoutMs + 5_000).then(() => ''),
            ]);
        }
        catch (e) {
            /**
             * 2026-11-04：扫尾是**增强能力**，绝不能把子 agent 已经交付的产出覆盖成"失败"
             * （纪律 16）。真机 2059017 的 `sweep-main-agent-empty` 就是这样把一份完整报告
             * 判成失败的。异常/无产出/仍需人工一律停在 `needs_confirmation` 等人处理。
             */
            board.settleTask(taskId, 'needs_confirmation', {
                note: `扫尾未产出（增强能力异常，不影响既有产出）：${reason}；${e instanceof Error ? e.message : String(e)}。请在任务详情确认通过或追问。`,
                stopReason: 'sweep-main-agent-error',
            });
            return;
        }
        if (!text) {
            board.settleTask(taskId, 'needs_confirmation', {
                note: `扫尾未产出（主 agent 未返回结果，不影响既有产出）：${reason}。请查看「执行过程」里的既有报告，确认通过或追问。`,
                stopReason: 'sweep-main-agent-empty',
            });
            return;
        }
        // 亲做结果判定与子 agent 同口径：完成标记/无待确认迹象 ⇒ 成功；否则停在待确认（留人工），不判死。
        const done = /\bTASK_DONE\b/.test(text) || !/NEEDS_HUMAN_CONFIRM|请人工确认|人工确认/.test(text);
        board.settleTask(taskId, done ? 'success' : 'needs_confirmation', {
            output: text,
            note: `主 agent 亲自完成（扫尾）：${reason}`,
            ...(done ? {} : { stopReason: 'sweep-main-agent-needs-human' }),
        });
    }
    /**
     * 调度条目清单（问题 4/5；2026-11-03 问题 3 归一为 UI 视图）。
     * 调度器未装配返回空表（UI 如实显示"无"）。
     */
    function listSchedules() {
        return (deps.scheduler?.list() ?? []).map(e => {
            // 需求键归一：chain 条目 payload 是 { requirementKey }；dispatch 条目是完整
            // DispatchInput（取 targetWorkItem —— 登记时就是 `{id}@{collection}` 需求键）。
            let requirementKey;
            const payload = e.payload;
            if (e.kind === 'chain' && typeof payload?.requirementKey === 'string') {
                requirementKey = payload.requirementKey;
            }
            else if (e.kind === 'dispatch' && typeof payload?.targetWorkItem === 'string') {
                requirementKey = payload.targetWorkItem;
            }
            return {
                id: e.id,
                dueAt: e.dueAt,
                kind: e.kind,
                createdAt: e.createdAt,
                ...(e.note ? { note: e.note } : {}),
                ...(requirementKey ? { requirementKey } : {}),
            };
        });
    }
    /** 取消一条调度（问题 4/5）。 */
    function cancelSchedule(id) {
        return deps.scheduler?.cancel(id) ?? false;
    }
    /**
     * 修改一条调度的到点时刻（2026-11-03 问题 3）。
     * 同 id 重登记即覆盖旧条目（`ScheduleService.schedule` 语义）并重新武装定时器；
     * 校验同登记口径：dueAt 必须是合法且晚于当前时间的 ISO 时刻。
     */
    function updateSchedule(id, dueAt) {
        const scheduler = deps.scheduler;
        if (!scheduler)
            return { ok: false, reason: '调度器未装配（插件与宿主版本不匹配）' };
        const key = typeof id === 'string' ? id.trim() : '';
        if (!key)
            return { ok: false, reason: 'id 必填' };
        const dueMs = Date.parse(dueAt ?? '');
        if (Number.isNaN(dueMs))
            return { ok: false, reason: '定时时间无效（不是合法 ISO 时间）' };
        if (dueMs <= Date.now())
            return { ok: false, reason: '定时时间必须晚于当前时间' };
        const existing = scheduler.list().find(e => e.id === key);
        if (!existing)
            return { ok: false, reason: '无此调度条目（可能已触发或已取消）' };
        const reg = scheduler.schedule({
            id: existing.id,
            dueAt,
            kind: existing.kind,
            payload: existing.payload,
            ...(existing.note ? { note: existing.note } : {}),
        });
        if (!reg.ok)
            return { ok: false, reason: reg.reason ?? '修改定时执行失败' };
        return { ok: true, scheduledAt: dueAt };
    }
    /** 纯粹的延时（用于给异步增强步骤设"宽限"，避免主路径被它拖住）。 */
    function delay(ms) {
        return new Promise(resolve => setTimeout(resolve, Math.max(0, ms)));
    }
    /** 需求完成回写（问题 4）：手动触发 / 部分失败后重跑，返回逐项报告。 */
    async function writeBackRequirement(input) {
        if (!deps.finalizer) {
            return { ok: false, reason: '需求完成回写器不可用（未接线 TFS 系统写通道 / finalizer 未注入）' };
        }
        const key = typeof input?.requirementKey === 'string' ? input.requirementKey.trim() : '';
        if (!key)
            return { ok: false, reason: 'requirementKey 必填' };
        try {
            const report = await deps.finalizer.runWriteBack(key, input.force === true);
            if (report.status === 'error') {
                return { ok: false, reason: report.summary ?? '回写失败', report };
            }
            // ok / partial 都返回报告（partial 时报告内含失败项，UI 可"重新回写"）。
            return { ok: true, report };
        }
        catch (e) {
            return { ok: false, reason: e instanceof Error ? e.message : String(e) };
        }
    }
    // 把收口编排钩子接到看板服务（BoardService 先于本 api 构造，故在此补接）。
    deps.board?.setSettledHook?.(handleTaskSettled);
    return {
        getPanelData,
        refreshPanelData,
        confirmWrite,
        dispatch,
        listRequirements,
        getQueryOptions,
        refreshQueryOptions,
        loadQueryOptions,
        collectQueryOptions,
        loadUiState,
        saveUiState,
        listRoles,
        saveRole,
        deleteRole,
        listSkillGroups,
        saveSkillGroup,
        deleteSkillGroup,
        getBoard,
        claimRequirement,
        decomposeRequirement,
        orchestrationStart,
        listSchedules,
        cancelSchedule,
        updateSchedule,
        restoreRequirement,
        enrichRequirement,
        deleteTasks,
        updateRequirement,
        setRequirementExecState,
        updateTask,
        getTaskTrace,
        followUpTask,
        assignTask,
        setTaskState,
        healthCheck,
        getAudit,
        archiveAudit,
        setCollection,
        listProfiles,
        saveProfile,
        deleteProfile,
        activateProfile,
        getMcpEnvTemplate,
        writeMcpEnvFile,
        getMcpInstance,
        getTfsToolCatalog,
        writeBackRequirement,
        orchestratorEnsure,
    };
}
/**
 * 能力目录（问题 8 / 12）。
 *
 * 缺省（apply 未注入 `tfsToolCatalog`）时给出**可读的降级原因**而不是空数组：
 * 空数组会让 UI 显示"0 个工具"，既像是插件坏了、又看不出为什么。
 *
 * 触发时机：`deps.tfsToolCatalog` 只在 `index.ts#apply` 里经 `catalogView(IMPLEMENTED_OPERATIONS)`
 * 注入（纯内存计算，不依赖宿主服务）。因此这里只会在**单测/未走 apply 的装配**下兜到；
 * 与"宿主有没有装 MCP 实例"无关 —— REST 化后本插件不再依赖任何 MCP 实例。
 */
const TFS_TOOL_CATALOG_UNAVAILABLE = {
    ok: false,
    rawCount: 0,
    wrappedCount: 0,
    tools: [],
    missingCount: 0,
    reason: '能力目录服务不可用（装配未注入 tfsToolCatalog，本插件自身的能力目录未能生成）',
};
//# sourceMappingURL=api.js.map
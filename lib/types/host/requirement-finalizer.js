/**
 * 需求完成自动回写编排器（问题 4）。
 *
 * 触发：某任务收口成功后由宿主收口钩子调用 {@link RequirementFinalizer.maybeFinalize}；
 * 仅当需求下**全部任务完成**（无待人工确认 / 失败 / 运行中 / 待执行）时执行一次。
 *
 * 回写内容（逐项、独立 try/catch，失败不阻断其余项）：
 *  1. 需求评审 `Microsoft.VSTS.Common.RequirementReview` = "评审通过"；
 *  2. 需求自测 `Microsoft.VSTS.Common.RequirementTest` = "自测通过"；
 *  3. 各任务重要结论汇总为一条历史评论（System.History）；
 *  4. 任务产出的关键产物（子 agent 输出 `ARTIFACTS:` 段的绝对路径，经严格校验）上传为需求附件；
 *  5. 需求关联的人员任务置为"已解决"，`Microsoft.VSTS.Scheduling.FinishDate` = 明天（@today+1）。
 *
 * 幂等：报告（`requirement.writeBack`）兼作账本——已 `ok` 的项在非 force 重跑时跳过；
 * 字段 / 任务状态在写入前先读服务端当前值，已是目标即跳过；TFS 写门禁3 判重归一为 skipped。
 * 防重入：同一需求并发触发只跑一个（{@link inFlight}）。
 *
 * @module dsh-tfs-requirment/host/requirement-finalizer
 */
import path from 'node:path';
import { realFs } from '../persistence/fs-like.js';
/** 需求评审字段与目标值（用户口径，verbatim）。 */
const REVIEW_FIELD = 'Microsoft.VSTS.Common.RequirementReview';
const REVIEW_VALUE = '评审通过';
/** 需求自测字段与目标值（用户口径，verbatim）。 */
const TEST_FIELD = 'Microsoft.VSTS.Common.RequirementTest';
const TEST_VALUE = '自测通过';
/** 关联人员任务完成日期字段。 */
const FINISH_DATE_FIELD = 'Microsoft.VSTS.Scheduling.FinishDate';
/** 允许作为需求附件上传的产物扩展名白名单（保守，挡住可执行/系统文件）。 */
const ALLOWED_ARTIFACT_EXT = new Set([
    '.md', '.txt', '.pdf', '.doc', '.docx', '.xls', '.xlsx', '.ppt', '.pptx',
    '.png', '.jpg', '.jpeg', '.zip', '.json', '.html', '.csv', '.log', '.patch', '.diff',
]);
/** 单个附件大小上限：25 MiB。 */
const DEFAULT_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** 结论评论总长上限（保守，避免超过 TFS History 可接受范围）。 */
const MAX_COMMENT_CHARS = 18_000;
/** 单个任务结论在评论中的截断长度。 */
const MAX_TASK_OUTPUT_CHARS = 1500;
/** 关联任务视为"已是终态、无需再置已解决"的状态集合（跨过程模板的常见中文/英文值）。 */
const TASK_TERMINAL_STATES = new Set([
    '已解决', '已验证', '已关闭', '关闭', '已完成', '完成', 'Resolved', 'Closed', 'Done',
]);
function msgOf(e) {
    return e instanceof Error ? e.message : String(e);
}
function truncate(s, n) {
    const t = s.trim();
    return t.length > n ? `${t.slice(0, n)}…` : t;
}
/** 本地时区的明天，格式 YYYY-MM-DD（@today + 1，避免 UTC 偏移在凌晨算错日）。 */
function tomorrowLocalISO(now) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    d.setDate(d.getDate() + 1);
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
}
export class RequirementFinalizer {
    deps;
    fs;
    resolvedState;
    getNow;
    maxAttachmentBytes;
    /** 正在回写的需求键（防重入）。 */
    inFlight = new Set();
    constructor(deps) {
        this.deps = deps;
        this.fs = deps.fs ?? realFs;
        this.resolvedState = deps.resolvedState?.trim() || '已解决';
        this.getNow = deps.now ?? (() => new Date());
        this.maxAttachmentBytes = deps.maxAttachmentBytes ?? DEFAULT_MAX_ATTACHMENT_BYTES;
    }
    /** 前置条件：至少一个任务且全部 completed。 */
    isReady(key) {
        const tasks = Object.values(this.deps.board.snapshot.tasks)
            .filter(t => t.requirementId === key && t.state !== 'deleted');
        return tasks.length > 0 && tasks.every(t => t.state === 'completed');
    }
    /**
     * @param options.finalSummary - spec 010：编排主 agent 产出的最终总结。
     *   提供时它作为结论评论的**主文案**；不提供（或主 agent 超时/失败）则用既有模板，
     *   并在评论里标注 `总结来源：模板兜底`，不假装是 AI 写的。
     */
    async maybeFinalize(requirementKey, options) {
        if (this.inFlight.has(requirementKey))
            return undefined;
        const req = this.deps.board.snapshot.requirements[requirementKey];
        if (!req)
            return undefined;
        if (!this.isReady(requirementKey))
            return undefined;
        // 已成功回写：不重复（自动触发路径）。
        if (req.writeBack?.status === 'ok')
            return req.writeBack;
        this.inFlight.add(requirementKey);
        try {
            return await this.runWriteBack(requirementKey, false, options, true);
        }
        catch {
            // 自动触发不外露错误：顶层意外时静默（逐项错误已在 runWriteBack 内落账）。
            return undefined;
        }
        finally {
            this.inFlight.delete(requirementKey);
        }
    }
    async runWriteBack(requirementKey, force = false, options, 
    /**
     * 调用方是否已持有 `inFlight`（`maybeFinalize` 持锁后再调本方法）。
     * 为 true 时跳过下面的防重入检查，否则自动触发路径会把自己当成并发调用而失败。
     */
    guardHeldByCaller = false) {
        /**
         * 防重入：手动「重新回写」直接走本方法，而自动触发（`maybeFinalize`）持有同一把
         * `inFlight`。两者并发时两个流程会同时越过下面 `writeBack.status === 'running'`
         * 的占位检查，于是结论评论与附件被各写一份（后写的报告还覆盖先写的）。
         * 同一需求已有回写在跑时直接失败并给出可读原因，不静默排队。
         */
        if (!guardHeldByCaller && this.inFlight.has(requirementKey)) {
            throw new Error(`需求 ${requirementKey} 正在回写 TFS，请等待当前回写结束后再试`);
        }
        /**
         * 手动路径**自己登记** `inFlight`（2026-10-05 修复）：此前只做检查、不登记，
         * 于是「手动在跑 → 某任务收口触发 `maybeFinalize`」时后者看到 `inFlight` 为空
         * 也能进入 ⇒ 两个流程并发跑完整套回写，结论评论与附件各写一份（正是上面注释
         * 想防的后果）。反向（自动在跑时手动被拒）本来就是好的，现在两侧对称。
         *
         * `guardHeldByCaller=true` 时锁已由 `maybeFinalize` 持有，不能重复登记/释放。
         */
        if (guardHeldByCaller)
            return this.runWriteBackLocked(requirementKey, force, options);
        this.inFlight.add(requirementKey);
        try {
            return await this.runWriteBackLocked(requirementKey, force, options);
        }
        finally {
            this.inFlight.delete(requirementKey);
        }
    }
    /**
     * {@link runWriteBack} 的真实主体（调用方已处理 `inFlight` 的检查与登记）。
     *
     * @param requirementKey - 需求去重键。
     * @param force - 是否允许对已回写需求重跑。
     * @param options - 可选的 AI 最终总结。
     * @returns 回写报告。
     */
    async runWriteBackLocked(requirementKey, force, options) {
        const req = this.deps.board.snapshot.requirements[requirementKey];
        if (!req)
            throw new Error(`需求不在本地池：${requirementKey}`);
        const tasks = Object.values(this.deps.board.snapshot.tasks)
            .filter(t => t.requirementId === requirementKey && t.state !== 'deleted')
            .map(t => ({
            state: t.state,
            title: t.title,
            roleAgent: t.roleAgent,
            ...(t.workspace ? { workspace: t.workspace } : {}),
            ...(t.artifactPaths ? { artifactPaths: [...t.artifactPaths] } : {}),
            attempts: t.attempts,
        }));
        // 前置不满足：返回错误报告但**不落账**（手动触发给用户可读原因，也不污染自动判定）。
        const pending = tasks.filter(t => t.state !== 'completed');
        if (tasks.length === 0 || pending.length > 0) {
            return {
                status: 'error',
                at: this.getNow().toISOString(),
                items: [],
                summary: `需求尚有 ${pending.length} 个任务未完成（共 ${tasks.length} 个任务），全部完成后才能回写 TFS`,
            };
        }
        // 已成功且非强制：直接回原报告（幂等）。
        if (!force && req.writeBack?.status === 'ok')
            return req.writeBack;
        // 账本：上一份报告中已 ok 的项本次跳过（partial 重跑只补失败项）。
        //
        // `force` 只表示"即便 status==='ok' 也重跑一遍"，**不是**"清空账本"：清空会让
        // 结论评论与附件各被追加一份，TFS 上留下重复的历史记录与重复附件，而报告里的
        // done 账本恰好把这份重复记录遮住了（`api.ts` 的契约是"幂等跳过已成功项"）。
        const doneTargets = new Set((req.writeBack?.items ?? []).filter(i => i.status === 'ok').map(i => i.target));
        const priorAttachments = [...(req.writeBack?.attachments ?? [])];
        const now = this.getNow();
        const at = now.toISOString();
        const id = req.workItemId;
        const coll = req.collection;
        const items = [];
        const record = (kind, target, status, reason) => {
            items.push({ kind, target, status, ...(reason ? { reason } : {}) });
        };
        // running 占位（让 UI / 并发触发看到"回写中"，并配合防重入）。
        this.deps.saveReport(requirementKey, { status: 'running', at, items: [], summary: '需求完成回写进行中…' });
        // ── ①② 评审 / 自测字段（一次 PATCH 合并，减少请求数）──
        await this.writeReviewAndTestFields(id, coll, doneTargets, record);
        // ── ④ 关键产物上传为附件（先于评论，便于评论里列出清单）──
        const uploadedNames = await this.uploadArtifacts(req, tasks, id, coll, doneTargets, record);
        // ── ③ 结论评论（汇总各任务最终 output + 附件清单 + 任务收口说明）──
        {
            const target = '结论评论 System.History';
            if (doneTargets.has(target)) {
                record('comment', target, 'skipped', '上次已回写结论评论');
            }
            else {
                try {
                    const comment = this.buildSummaryComment(req, tasks, uploadedNames, now, options?.finalSummary);
                    const r = await this.deps.port.addComment(id, coll, comment);
                    record('comment', target, r.status, r.reason);
                }
                catch (e) {
                    record('comment', target, 'error', `结论评论回写失败：${msgOf(e)}`);
                }
            }
        }
        // ── ⑤ 关联人员任务置"已解决" + FinishDate=明天 ──
        await this.resolveLinkedTasks(id, coll, doneTargets, now, record);
        // ── 汇总 ──
        const errors = items.filter(i => i.status === 'error');
        const oks = items.filter(i => i.status === 'ok');
        const skips = items.filter(i => i.status === 'skipped');
        const status = errors.length === 0 ? 'ok' : oks.length > 0 ? 'partial' : 'error';
        const attachments = [...new Set([...priorAttachments, ...uploadedNames])];
        const summary = `需求 #${id} 完成回写${status === 'ok' ? '成功' : status === 'partial' ? '部分成功' : '失败'}：` +
            `成功 ${oks.length} 项，跳过 ${skips.length} 项，失败 ${errors.length} 项；` +
            `上传附件 ${uploadedNames.length} 个。` +
            (errors.length > 0 ? `失败项：${errors.map(e => e.target).join('、')}` : '');
        const report = {
            status,
            at,
            items,
            ...(attachments.length > 0 ? { attachments } : {}),
            summary,
        };
        this.deps.saveReport(requirementKey, report);
        return report;
    }
    /** ①② 评审 / 自测字段：读当前值，仅把未达标字段合并成一次 PATCH。 */
    async writeReviewAndTestFields(id, coll, doneTargets, record) {
        const reviewTarget = `字段 ${REVIEW_FIELD}`;
        const testTarget = `字段 ${TEST_FIELD}`;
        const need = {};
        const pendingTargets = [];
        let current = {};
        try {
            current = await this.deps.port.getFields(id, coll);
        }
        catch (e) {
            record('field', reviewTarget, 'error', `读取需求当前字段失败：${msgOf(e)}`);
            record('field', testTarget, 'error', '同上，未能读取当前字段');
            return;
        }
        for (const [target, field, value] of [
            [reviewTarget, REVIEW_FIELD, REVIEW_VALUE],
            [testTarget, TEST_FIELD, TEST_VALUE],
        ]) {
            if (doneTargets.has(target)) {
                record('field', target, 'skipped', '上次已回写');
            }
            else if (current[field]?.trim() === value) {
                record('field', target, 'skipped', `TFS 上已是「${value}」`);
            }
            else {
                need[field] = value;
                pendingTargets.push(target);
            }
        }
        if (Object.keys(need).length === 0)
            return;
        try {
            const r = await this.deps.port.updateFields(id, coll, need);
            for (const t of pendingTargets)
                record('field', t, r.status, r.reason);
        }
        catch (e) {
            for (const t of pendingTargets)
                record('field', t, 'error', msgOf(e));
        }
    }
    /** ④ 收集并校验产物，逐个上传；返回本次成功上传的附件名。 */
    async uploadArtifacts(req, tasks, id, coll, doneTargets, record) {
        const candidates = [...new Set(tasks.flatMap(t => t.artifactPaths ?? []))];
        if (candidates.length === 0)
            return [];
        // 允许的工作区根：需求 / 各任务配置的代码库目录（产物应落在工作区内，防止误传系统文件）。
        const roots = [req.workspace, ...tasks.map(t => t.workspace)].filter((x) => Boolean(x))
            .map(p => path.resolve(p));
        const uploaded = [];
        const seenName = new Set();
        for (const filePath of candidates) {
            const name = path.basename(filePath);
            const target = `附件：${name}`;
            const reject = (reason) => record('attachment', target, 'skipped', reason);
            if (!path.isAbsolute(filePath)) {
                reject(`产物不是绝对路径，已跳过：${filePath}`);
                continue;
            }
            const ext = path.extname(name).toLowerCase();
            if (!ALLOWED_ARTIFACT_EXT.has(ext)) {
                reject(`产物扩展名「${ext || '无'}」不在允许清单，已跳过：${name}`);
                continue;
            }
            if (roots.length === 0) {
                // 产物路径是**模型写的文本**（子 agent 的 ARTIFACTS: 段），没有工作目录就无法判断它
                // 是否属于本需求。放行等于让被注入提示词的子 agent 任意指名盘上的 .txt/.json/.md
                // 上传成 TFS 附件，因此无工作目录时一律拒绝，而不是"无从校验就放行"。
                reject(`需求与任务都未配置工作目录，无法校验产物归属，已跳过（防误传）：${filePath}`);
                continue;
            }
            if (!roots.some(root => filePath === root || filePath.startsWith(root + path.sep))) {
                reject(`产物不在需求/任务工作目录内，已跳过（防误传）：${filePath}`);
                continue;
            }
            let stat;
            if (typeof this.fs.statSync !== 'function') {
                reject('文件系统接口不可用（statSync 缺失），已跳过');
                continue;
            }
            try {
                stat = this.fs.statSync(filePath);
            }
            catch {
                stat = undefined;
            }
            if (!stat || typeof stat.isFile !== 'function' || !stat.isFile()) {
                reject(`产物文件不存在或不是文件，已跳过：${filePath}`);
                continue;
            }
            if (stat.size <= 0) {
                reject(`产物为空文件，已跳过：${name}`);
                continue;
            }
            if (stat.size > this.maxAttachmentBytes) {
                reject(`产物超过 ${(this.maxAttachmentBytes / 1024 / 1024).toFixed(0)}MB 上限，已跳过：${name}`);
                continue;
            }
            if (doneTargets.has(target) || seenName.has(name)) {
                record('attachment', target, 'skipped', '该产物已上传过');
                continue;
            }
            try {
                const r = await this.deps.port.uploadAttachment(id, coll, filePath, name);
                if (r.status === 'ok') {
                    uploaded.push(name);
                    seenName.add(name);
                }
                record('attachment', target, r.status, r.reason ?? (r.status === 'skipped' ? '写门禁判定为重复，已跳过' : undefined));
            }
            catch (e) {
                record('attachment', target, 'error', `附件上传失败：${msgOf(e)}`);
            }
        }
        return uploaded;
    }
    /** ⑤ 找关联人员任务，非终态的置"已解决"并设 FinishDate=明天。 */
    async resolveLinkedTasks(id, coll, doneTargets, now, record) {
        let linked;
        try {
            linked = await this.deps.port.findLinkedTasks(id, coll);
        }
        catch (e) {
            record('linked-task', '关联人员任务', 'error', `检索关联任务失败：${msgOf(e)}`);
            return;
        }
        if (linked.length === 0) {
            record('linked-task', '关联人员任务', 'skipped', '未检索到关联任务（子级 / 相关链接 / WIQL Parent 均无 Task）');
            return;
        }
        const finishDate = tomorrowLocalISO(now);
        for (const t of linked) {
            const target = `关联任务 #${t.id} ${t.title}`.trim();
            if (doneTargets.has(target)) {
                record('linked-task', target, 'skipped', '上次已处理');
                continue;
            }
            if (TASK_TERMINAL_STATES.has(t.state.trim())) {
                record('linked-task', target, 'skipped', `当前状态「${t.state}」已是终态`);
                continue;
            }
            try {
                const r = await this.deps.port.resolveTask(t.id, coll, this.resolvedState, finishDate);
                record('linked-task', target, r.status, r.reason ?? (r.status === 'skipped' ? '写门禁判定为重复，已跳过' : undefined));
            }
            catch (e) {
                record('linked-task', target, 'error', `置「${this.resolvedState}」失败：${msgOf(e)}`);
            }
        }
    }
    /** 取任务最后一次有内容的执行输出（人工确认通过的补记无 output，向前找真实产出）。 */
    lastTaskOutput(task) {
        for (let i = task.attempts.length - 1; i >= 0; i -= 1) {
            const a = task.attempts[i];
            if (a?.output && a.output.trim().length > 0)
                return a.output;
        }
        return '';
    }
    /** 组装 System.History 汇总评论。 */
    buildSummaryComment(req, tasks, attachmentNames, now, finalSummary) {
        const lines = [];
        lines.push(`【DSH 自动回写】需求「${req.title}」（#${req.workItemId}）已由本地需求管理插件自动执行完成。`);
        lines.push('');
        // spec 010：编排主 agent 的最终总结优先作为主文案；没有时如实标注来源，不伪造 AI 结论。
        const summary = (finalSummary ?? '').trim();
        if (summary) {
            lines.push('【编排主 agent 最终总结】');
            lines.push(summary.split('\n').map(l => l.trimEnd()).join('\n'));
            lines.push('');
        }
        else {
            lines.push('总结来源：模板兜底（编排主 agent 未产出总结：可能未启用、超时或失败）');
            lines.push('');
        }
        lines.push('各任务执行结论：');
        tasks.filter(t => t.state === 'completed').forEach((t, i) => {
            lines.push(`${i + 1}. 【${t.roleAgent}】${t.title}`);
            const out = this.lastTaskOutput(t);
            if (out) {
                const body = truncate(out, MAX_TASK_OUTPUT_CHARS);
                lines.push(body.split('\n').map(l => `    ${l}`).join('\n'));
            }
        });
        lines.push('');
        if (attachmentNames.length > 0) {
            lines.push(`关键产物（已上传为需求附件）：${attachmentNames.join('、')}`);
        }
        lines.push(`关联人员任务已置为「${this.resolvedState}」，任务完成日期（${FINISH_DATE_FIELD}）：${tomorrowLocalISO(now)}。`);
        lines.push(`回写时间：${now.toISOString()}`);
        return truncate(lines.join('\n'), MAX_COMMENT_CHARS);
    }
}
//# sourceMappingURL=requirement-finalizer.js.map
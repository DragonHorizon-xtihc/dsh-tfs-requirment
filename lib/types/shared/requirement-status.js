/**
 * 需求级执行状态的**派生视图**（问题 2/3/4，纯逻辑，客户端半与宿主半共用口径）。
 *
 * ## 为什么要有这一层
 *
 * 任务中心的界面此前只显示 TFS 的 `state`（如「已建议」），与本地执行进度毫无关系，
 * 于是"这条需求做到哪一步了"在界面上无从回答（问题 4：已领取需求缺少执行状态）。
 * 而"做到哪一步"**不是**一个落库字段，它是任务集合的派生量：
 *
 *   - 没有任务 ⇒ 未拆解；
 *   - 有任务在跑 ⇒ 执行中 N；
 *   - 有任务失败（未收口）⇒ 有失败 N；
 *   - 有任务还没动 ⇒ 待办 N；
 *   - 全部收口 ⇒ 已完成 c/t（t 不含已取消）；
 *   - 需求级 `execState === 'completed'` ⇒ 已完成（迁到「已完成」页）。
 *
 * 把它放在 `shared/` 而不是组件里：组件层没有渲染测试手段（客户端半无 React 测试库），
 * 派生规则一旦写进 JSX 就只能靠人眼保证；这里是可单测的纯函数，且宿主半若将来要按同一口径
 * 做筛选也能直接复用（避免两端各写一份必然漂移）。
 *
 * @module dsh-tfs-requirment/shared/requirement-status
 */
/** 需求是否已完成（缺省 = 进行中；历史 `board.json` 没有该字段）。 */
export function isRequirementCompleted(r) {
    return r.execState === 'completed';
}
/**
 * 把需求集合拆成「任务中心（进行中）」与「已完成」两页（问题 3）。
 *
 * 保持**输入顺序**（不做排序）：列表顺序由上游决定，派生层擅自重排会让"我刚领取的需求
 * 跑到第 5 行"这种预期外的跳动出现。
 *
 * @param requirements - 全部已领取需求（看板快照）。
 */
export function splitRequirementsByExecState(requirements) {
    const active = [];
    const completed = [];
    for (const r of requirements) {
        if (isRequirementCompleted(r))
            completed.push(r);
        else
            active.push(r);
    }
    return { active, completed };
}
/**
 * 已完成页检索（问题 2：按**需求 ID** 与**需求标题**检索）。
 *
 * ID 用 `includes` 而非严格相等：用户常记得"最后四位"而不是完整号。
 * 关键字为空/全空白时返回原集合的**浅拷贝**（调用方通常直接当列表渲染，避免共享引用）。
 *
 * @param items - 已完成需求。
 * @param keyword - 检索词（空 = 不过滤）。
 */
export function filterCompletedRequirements(items, keyword) {
    const kw = keyword.trim().toLowerCase();
    if (kw.length === 0)
        return [...items];
    return items.filter(r => String(r.id).includes(kw) || r.title.toLowerCase().includes(kw));
}
/** ISO 时刻 → 本地 `HH:mm`（定时待执行文案用；非法时刻回退原串）。 */
function formatDueMinute(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime()))
        return iso;
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    return `${hh}:${mm}`;
}
/**
 * 派生某需求的执行状态（问题 4；2026-11-03 问题 3 增「定时待执行」）。
 *
 * 判定顺序即优先级：已完成（需求级）> 未拆解 > 定时待执行 > 执行中 > 有失败 > 待办 > 已完成 c/t。
 * 这个顺序是有意的：**"正在跑"比"有失败"更需要被看到**（失败任务可能已经有人在处理），
 * 而"有失败"又比"还有待办"更需要被看到（用户需要知道有东西卡住了）。
 *
 * 「定时待执行」只替换**无任务**时的「未拆解」：定时登记此刻不建任务（到点才派发），
 * 界面若仍显示「未拆解」会误导用户"定时没生效"（2026-11-03 实机反馈）。
 * 名下已有任务时（如 chain 定时编排已有拆解任务）仍按任务集合派生，定时信息在
 * 任务中心「定时执行」区展示。
 *
 * @param r - 需求（只看 `execState`）。
 * @param ownTasks - 该需求名下的全部任务（含已取消）。
 * @param scheduledDueAt - 该需求挂起的定时条目到点时刻（ISO 8601；无 = 不参与派生）。
 */
export function summarizeRequirementExec(r, ownTasks, scheduledDueAt) {
    if (isRequirementCompleted(r))
        return { text: '已完成', tone: 'done' };
    if (ownTasks.length === 0) {
        if (scheduledDueAt) {
            return { text: `定时待执行 ${formatDueMinute(scheduledDueAt)}`, tone: 'pending' };
        }
        return { text: '未拆解', tone: 'todo' };
    }
    const running = ownTasks.filter(t => t.execState === 'running').length;
    if (running > 0)
        return { text: `执行中 ${running}`, tone: 'running' };
    const failed = ownTasks.filter(t => t.execState === 'failed').length;
    if (failed > 0)
        return { text: `有失败 ${failed}`, tone: 'failed' };
    const deleted = ownTasks.filter(t => t.state === 'deleted').length;
    const open = ownTasks.filter(t => t.state !== 'completed' && t.state !== 'deleted').length;
    if (open > 0)
        return { text: `待办 ${open}`, tone: 'pending' };
    const completed = ownTasks.filter(t => t.state === 'completed').length;
    // 走到这里说明需求**不是** `execState==='completed'`，而 open 又为 0 ⇒ 每个任务都是终态。
    // 若 completed 仍为 0，那只能是"全部已取消"，不是一个完成的进度：看板引擎的
    // `isRequirementAllTasksDone` 也明确要求至少一个 completed 才允许自动收口
    // （board.ts）。原来此处照样输出 `已完成 0/0` 且 tone 为 done，与引擎判定相矛盾，
    // 会让用户以为这条需求真的做完了。
    if (completed === 0)
        return { text: '已全部取消', tone: 'todo' };
    // 分母排除已取消任务：它们是"放弃掉的"，算进总数会让 3/3 变成 3/5，用户以为还有两件没做完。
    const total = ownTasks.length - deleted;
    return { text: `已完成 ${completed}/${total}`, tone: 'done' };
}
//# sourceMappingURL=requirement-status.js.map
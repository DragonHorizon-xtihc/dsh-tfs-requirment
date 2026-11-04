/**
 * 定时轮询的纯逻辑（T037 / FR-024 / S-14）。
 *
 * **为什么把合并逻辑单独放在 shared 且做成纯函数**：
 *  - 客户端半是独立编译程序（`types: []`，无 node 全局），轮询定时器只能在浏览器侧跑，
 *    但"哪些是新增、哪些是更新"的判定**不该埋在 React 组件里**——那样只能靠 UI 点击来验证；
 *  - 抽成纯函数后可用假时钟直接测到期判定、用列表夹具直接测增量判定，不依赖 DOM。
 *
 * ## 增量语义（UI 上必须真的能看出差别，否则"轮询"只是重复全量刷新）
 * - 键为 `id@collection`（与 S-01 去重键一致），保证跨集合同号工作项不被误判为同一条；
 * - `incoming` 中不存在的旧条目**保留**（需求池是分页视图，不是全量集合，丢弃会造成"刷新后条目消失"）；
 * - 仅当可见字段真的变化时才算 `updated`（用 `changedDate` 之外还比对状态/指派/标题/标签，
 *   因为部分 TFS 部署返回的 `changedDate` 精度只到秒、或同一秒内多次改动）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/poll
 */
/** 需求去重键（S-01）：`id@collection`。 */
export function requirementKey(r) {
    return `${r.id}@${r.collection}`;
}
/** 参与"内容是否变化"比对的字段（顺序无关，逐字段严格比较）。 */
function contentSignature(r) {
    return JSON.stringify([
        r.title,
        r.state,
        r.assignedTo,
        r.priority,
        r.iterationPath,
        r.areaPath,
        r.project,
        r.type,
        r.url,
        // `tags` 在契约里是可选的，而这里的入参既可能来自接口也可能来自 board.json 里的
        // 历史条目。直接展开会在缺字段时抛 `TypeError: r.tags is not iterable`，
        // 一个残缺条目就能让整轮增量合并失败、整个需求池刷不出来。
        [...(r.tags ?? [])].sort(),
        r.changedDate,
    ]);
}
/**
 * 把一轮列表响应合并进既有列表（增量）。
 *
 * @param prev - 既有列表（上一轮结果）。
 * @param incoming - 本轮响应条目。
 * @returns 合并结果与增量计数。
 */
export function mergeRequirementPage(prev, incoming) {
    const index = new Map();
    prev.forEach((r, i) => index.set(requirementKey(r), i));
    const items = prev.slice();
    const seen = new Set();
    const changedKeys = [];
    let added = 0;
    let updated = 0;
    let unchanged = 0;
    for (const next of incoming) {
        const key = requirementKey(next);
        if (seen.has(key))
            continue; // 同一响应内的重复条目只取第一条（防御后端重复）
        seen.add(key);
        const at = index.get(key);
        if (at === undefined) {
            items.push(next);
            added++;
            changedKeys.push(key);
            continue;
        }
        const before = items[at];
        if (contentSignature(before) === contentSignature(next)) {
            unchanged++;
        }
        else {
            items[at] = next;
            updated++;
            changedKeys.push(key);
        }
    }
    const retained = prev.reduce((n, r) => (seen.has(requirementKey(r)) ? n : n + 1), 0);
    return { items, added, updated, unchanged, retained, changedKeys };
}
/** 轮询间隔下限（分钟）。S-14 要求最小 1 分钟；配置层校验之外在客户端侧再夹一次。 */
export const MIN_POLL_INTERVAL_MINUTES = 1;
/** 把间隔夹到合法范围（小于下限视为下限，非有限数视为下限）。 */
export function clampPollInterval(minutes) {
    if (!Number.isFinite(minutes) || minutes < MIN_POLL_INTERVAL_MINUTES)
        return MIN_POLL_INTERVAL_MINUTES;
    return minutes;
}
/**
 * 是否到点该轮询。
 * @param lastPolledAtMs - 上次轮询时间戳（ms）；0/未轮询过视为立即到期。
 * @param intervalMinutes - 配置的间隔（分钟）。
 * @param nowMs - 当前时间戳（ms）。
 */
export function isPollDue(lastPolledAtMs, intervalMinutes, nowMs) {
    if (!Number.isFinite(lastPolledAtMs) || lastPolledAtMs <= 0)
        return true;
    const intervalMs = clampPollInterval(intervalMinutes) * 60_000;
    return nowMs - lastPolledAtMs >= intervalMs;
}
/** 下次到期还需等待的毫秒数（用于 setTimeout 排程；已过期返回 0）。 */
export function msUntilNextPoll(lastPolledAtMs, intervalMinutes, nowMs) {
    if (!Number.isFinite(lastPolledAtMs) || lastPolledAtMs <= 0)
        return 0;
    const intervalMs = clampPollInterval(intervalMinutes) * 60_000;
    return Math.max(0, lastPolledAtMs + intervalMs - nowMs);
}
//# sourceMappingURL=poll.js.map
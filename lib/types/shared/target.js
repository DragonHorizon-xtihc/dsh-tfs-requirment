/**
 * 派发/回写目标的纯逻辑（客户端半与宿主半共用口径，可单测）。
 *
 * ## 背景（2026-09-21 实机事故）
 *
 * "当前目标"在插件里有**两种**字符串形态，混用会静默取到错的集合：
 *   - 需求键：`1997179@WN_HIS`（需求池「选为目标」）；
 *   - 看板任务 id：`1997179@WN_HIS#analyze`（任务中心/右栏「设为目标」）。
 *
 * 若把任务 id 直接当需求键用，按 `@` 切分会得到集合 `WN_HIS#analyze` —— 拿去打 TFS
 * 只会换来一个更费解的 404。故统一经这里**先剥 `#…` 段**再切集合。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/target
 */
/**
 * 把 `id@collection` / `id@collection#stage` / 裸 id 归一成 {@link TargetRef}。
 *
 * @param key - 目标键（需求键或看板任务 id；空串表示未选目标）。
 * @param fallbackCollection - 键里没带集合时的回退集合。
 * @returns 归一后的目标（`key` 为空时返回空 `targetWorkItem`，交由调用方判有效性）。
 */
export function targetRefFromKey(key, fallbackCollection) {
    const raw = typeof key === 'string' ? key.trim() : '';
    const hash = raw.indexOf('#');
    const base = hash >= 0 ? raw.slice(0, hash) : raw;
    const at = base.indexOf('@');
    if (at < 0)
        return { targetWorkItem: base, collection: fallbackCollection };
    const collection = base.slice(at + 1);
    // `1997179@`（有分隔符但集合为空）视同"只有 id"：不要把 '@' 留在键里，
    // 否则它既不是有效需求键、又会污染下游按 '@' 切分的解析。
    if (collection.length === 0)
        return { targetWorkItem: base.slice(0, at), collection: fallbackCollection };
    return { targetWorkItem: base, collection };
}
/**
 * 判断（**归一后**的）目标键是否可用于 TFS 回写：`<正整数>@<集合>`（或裸 `<正整数>`，
 * 此时集合由调用方随 `TargetRef.collection` 一起给出）。
 *
 * 面板占位符 `'—'`、空串、非数字都返回 false。调用方应先经 {@link targetRefFromKey}
 * 归一，再校验 —— 这样"用户选的目标是看板任务 id"也能正确判为有效。
 *
 * @param value - 归一后的目标键。
 * @returns 是否为有效需求键。
 */
export function isValidTargetWorkItem(value) {
    return /^\d+(@[^#\s]+)?$/.test(typeof value === 'string' ? value.trim() : '');
}
//# sourceMappingURL=target.js.map
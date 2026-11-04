/**
 * 槽位注册的**纯逻辑**（不依赖 DOM / JSX / 宿主服务）。
 *
 * ## 为什么单独放在 `src/shared`
 *
 * 本插件有三个编译程序，边界是硬的：
 *   - `tsconfig.host.json`：`src/**`（排除 `src/client`）；
 *   - `tsconfig.client.json`：仅 `src/client/**` + `src/shared/**`（带 DOM lib + JSX）；
 *   - `tsconfig.tests.json`：`src/**` + `tests/**`，但**排除 `src/client`**
 *     （客户端半要 DOM lib，测试程序不带）。
 *
 * 于是"想在测试里验证的客户端逻辑"不能写在 `src/client` —— 那会
 * `TS6142: --jsx is not set`。把纯逻辑下沉到 `src/shared`，客户端半与测试都能引用，
 * 且不引入 DOM 依赖。这与 `src/shared/redact.ts` / `src/shared/poll.ts` 是同一手法。
 *
 * @module dsh-tfs-requirment/shared/slot-registration
 */
/**
 * 幂等注册：把「同一槽 + 同一 key」的重复注册变成**安全 no-op**。
 *
 * ## 它防的是什么（问题 1 的真正根因，2026-09-19 由宿主源码坐实）
 *
 * `main` 是 **keyed** 槽（`ui-layout/src/client/index.ts:153`），而宿主的
 * `SlotCore.register` 对**同 key 同 priority** 的第二次注册**直接抛错**
 * （`ui-slots/src/index.ts:844-851`）：
 *
 * ```
 * keyed slot "main" already has an entry for key "tfs-requirment" at priority 0
 *   — register at a different priority to shadow it (lowest renders)
 * ```
 *
 * 这条错误一旦从 `slots.inject` 的 callback 里抛出，后果是**永久性**的：
 * `SlotRegistry.inject` 的 `changed()` 捕获异常后调用 `stop()`
 * （`ui-renderer/src/client/registry.ts:210-222`），而 `stop()` 的注释写得明白 ——
 * *"Failure callers retire the injection permanently: a delayed setup failure
 * never retries on a later declaration."*（同文件 `:180-190`）
 *
 * ⇒ **一次重复注册 = 这份注入被永久注销**。此后菜单行可能还在（它在另一个槽里），
 *   但 `main` 槽里再也没有本插件的 entry ⇒ 宿主
 *   `LayoutController.selectPanel(id)` 的 `hasMainPanel(id)` 恒 false ⇒
 *   **点几次都没反应，看不见 TFS 看板**（用户报告的问题 1）；
 *   同时 `retainMainPanels`（`ui-layout/stores.ts:97-100`）把 `activePanelId` 置 null ⇒
 *   **关闭后再也开不出来**（与问题 2 的表现耦合）。
 *
 * ## 为什么会重复注册
 *
 * `inject` 的 callback 在**每次槽声明生命周期开始**时都会重新执行
 * （`registry.ts:192-208` 的 `reconcile` 按 `declarationEpoch` 判定）。
 * `main` 由 `ui-layout` 的 `root` 注册声明；`ui-layout` 的 `ctx.effect`
 * 一旦重跑（构建 / HMR / 布局重挂），`main` 的 `declarationEpoch` 就 +1，
 * 于是本插件的 callback 被再次调用 —— 若此时旧 entry 尚未释放，第二次
 * `register` 便撞上"已存在同 key"并抛错，注入随即被永久注销。
 *
 * ## 修法
 *
 * 注册前先探测该 key 是否已被占用；已占用就**直接返回**（复用既有 entry，
 * 不抛错、不注销）。这样无论 callback 被重跑多少次都收敛到"恰好一份"。
 *
 * ### 「先查后写」的竞态在此不成立
 *
 * 探测与注册都在**同一个同步块**内完成，而 `SlotCore.register` 是同步的 ——
 * JS 单线程下二者之间不可能插入别的注册，故不存在 TOCTOU 窗口。
 *
 * @param slots - 宿主 `ctx.slots` 服务（或其等价结构面）。
 * @param spec - 注册规约（`name` 必填；list 槽给 `id`，keyed 槽给 `key`）。
 * @param component - 该槽位的组件。
 * @returns 本次注册的注销函数（cordis effect 合法 disposer）；该 cell 已被
 *   占用、本次跳过时返回 `undefined`。**绝不能返回布尔值** —— 本函数的返回
 *   值直接作为 `slots.inject(key, () => registerOnce(...))` 的 effect 返回值，
 *   而 cordis 只接受 function/null/undefined/thenable/iterable；2026-09-26
 *   实测旧版返回 true/false 每次启动必抛 `TypeError: Invalid effect`
 *   （key=main / sidebar.panellist），并打断声明周期、连锁引发启动早期
 *   React #130。
 */
export function registerOnce(slots, spec, component) {
    const cellKey = spec.key ?? spec.id;
    // 探测既有占用。**只用 `entriesOfSlot`（胜出的 entry）**。
    //
    // 缺 `entriesOfSlot` 的老部署上**不做探测**、直接注册：`entries` 给出的是全部
    // entry（含被 shadow 的），用它判定"该 cell 已被占用"会把一个**已被别人 shadow 掉的
    // 同名 entry** 当成占用，于是本插件的 entry 永不注册、面板直接消失 —— 正是上面整段
    // JSDoc 要防的那个后果。误判"占用 ⇒ 跳过注册"的代价远大于"漏判 ⇒ 撞上同优先级
    // 重复注册的报错"，后者由宿主报错、不会静默消失。
    const probe = slots.entriesOfSlot;
    if (cellKey !== undefined && typeof probe === 'function') {
        try {
            const occupied = probe.call(slots, spec.name).some(entry => {
                const options = entry.options;
                if (options === undefined)
                    return false;
                return (spec.key !== undefined ? options.key : options.id) === cellKey;
            });
            // 已有同 cell 的 entry：本次是重跑，复用它。**不抛错**是关键 ——
            // 抛错会让 `slots.inject` 永久注销这份注入（见上）。返回 undefined：
            // 对 cordis effect 是合法的"无 disposer"返回，不能返回 false。
            if (occupied)
                return undefined;
        }
        catch {
            // 探针本身失败（例如槽尚未声明）：继续走注册，由宿主给出权威判断。
        }
    }
    // 透传宿主返回的注销函数：inject 声明效果在 epoch 切换/插件卸载时靠它
    // 注销旧 entry（旧实现把它丢弃，叠加布尔返回，是 Invalid effect 的根源）。
    //
    // 运行时再确认一次：cordis effect 只接受 function/null/undefined/thenable/iterable，
    // 宿主若返回别的形态（如布尔），直接把它交出去就是 `TypeError: Invalid effect`
    // —— 那正是上面记录过的故障。这里宁可当成"无注销函数"（让旧 entry 由宿主回收），
    // 也不能把非法值当成 disposer 返回。
    const disposer = slots.register(spec, component);
    return typeof disposer === 'function' ? disposer : undefined;
}
//# sourceMappingURL=slot-registration.js.map
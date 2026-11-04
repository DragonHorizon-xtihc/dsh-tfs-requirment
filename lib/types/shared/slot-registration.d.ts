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
 * 注册规约的最小结构面。
 *
 * 刻意**不 import** 宿主的 `SlotSpec`：客户端半用的是结构类型（见 `slots.tsx` 的
 * `SlotSpec`），shared 层保持零宿主依赖，两端都能用。
 */
export interface SlotSpecLike {
    /** 槽名（如 `'main'` / `'sidebar.panellist'`）。 */
    name: string;
    /** list 槽的单元格键（如菜单行 id）。 */
    id?: string;
    /** keyed 槽的单元格键（如中央面板 key）。 */
    key?: string;
    /** list 槽排序权重。 */
    order?: number;
    /** 展示文案。 */
    label?: string;
    /**
     * 子槽声明表（spec 010）。
     *
     * 宿主 `SlotCore.register` 会在注册父条目时把这些键**声明**为子槽
     * （`ui-slots/src/index.ts:1287-1298`）；未声明的子槽在别处注册会抛
     * `slot "X" is not declared`（同文件 `:1205-1207`）。声明含
     * `scope: 'session'` 的子槽时，渲染器会额外给父条目注入 `SessionProvider`
     * （`ui-renderer/src/client/scoped-slots.tsx:575-590`）。
     *
     * 同一个子槽键**只能被一个父条目声明**（`ui-slots/src/index.ts:1241-1245`），
     * 故不同父条目必须用不同的键。
     */
    children?: Record<string, {
        kind: string;
        scope?: string;
    }>;
}
/**
 * 注册入口 + 只读探针的最小结构面。
 *
 * `entries` / `entriesOfSlot` 在宿主 `ctx.slots` 上是**实打实存在的**
 * （`SlotRegistry extends Service`，其 `entries`/`entriesOfSlot` 由
 * `ui-renderer/src/client/registry.ts:362-389` 委派到 `SlotCore`）。
 * 这里标可选是**打包/版本防御**：客户端半是独立 bundle，更老的部署上
 * 本插件的类型面与运行期服务可能不完全对齐，缺探针时退回直接注册。
 */
export interface SlotRegistryLike {
    /** 注册一个槽位 entry。 */
    register(spec: SlotSpecLike, component: unknown): unknown;
    /** 只读：该槽的**全部** entry（含被 shadow 的）。 */
    entries?: (slot: string) => readonly SlotEntryLike[];
    /** 只读：该槽**胜出**的 entry（每个 cell 一个）。 */
    entriesOfSlot?: (slot: string) => readonly SlotEntryLike[];
}
/** entry 的只读视图（只取判别 cell 归属所需的字段）。 */
export interface SlotEntryLike {
    options?: {
        key?: string;
        id?: string;
    };
}
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
export declare function registerOnce(slots: SlotRegistryLike, spec: SlotSpecLike, component: unknown): (() => void) | undefined;
//# sourceMappingURL=slot-registration.d.ts.map
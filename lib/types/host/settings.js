/**
 * 设置区注册（T028 / US1 / FR-022）。
 *
 * 把插件配置（{@link TfsRequirmentConfig}）注册进宿主设置服务，使配置页出现本插件的分区，
 * 用户改动经宿主持久化后回调本插件。
 *
 * **API 依据（已核实，非臆测）**：`@deepseek-ai/dsh-settings` 的
 * `SettingsProvider.installSection(owner, ns, schema, entry, hooks)`
 * （`node_modules/@deepseek-ai/dsh-settings/lib/types/index.d.ts:228`）：
 *   - `ns` 必须是**小写连字符**标识符，重复注册会显式失败；
 *   - `entry` 是合成基线值（composition base）；
 *   - `hooks.setSource(current)` 收到"当前权威值的 thunk"；
 *   - `hooks.onChange()` 在 attach/detach/提交后触发，供消费者重判派生状态；
 *   - `hooks.validate?(value)` 用于表达 **schema 无法表达的约束**（正是本插件的情况：
 *     `pollIntervalMinutes ≥ 1`、`maxConcurrentRequirements ≥ 1`、`defaultLabel` 非空、
 *     `defaultCollection ∈ collections` —— 见 `config.ts#validateConfig`）。
 *
 * 注册失败（宿主无 settings 服务 / 命名空间冲突）只让"设置区"这一项能力降级，
 * 不影响工具与看板（沿用 dsh-optimized-prompt 的装配纪律）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/settings
 */
import { Config, validateConfig } from '../config.js';
/** 本插件的设置命名空间（小写连字符，符合 settings 服务约束）。 */
export const SETTINGS_NAMESPACE = 'tfs-requirment';
/**
 * 注册插件设置分区。
 *
 * @param ctx - 宿主上下文。
 * @param entry - 合成基线配置（通常来自 cordis.patch.yml / Config 默认值）。
 * @param callbacks - 解析回调。
 * @returns 是否成功注册（false 表示宿主无 settings 服务，能力降级）。
 * @throws 当 entry 本身不合规时（配置错误应在装配期暴露，而非运行期静默）。
 */
export function installSettingsSection(ctx, entry, callbacks) {
    // 装配期先自检一次：基线就违规说明配置写错了，立即暴露（宪法 VI：配置违规可见）。
    const entryErrors = validateConfig(entry);
    if (entryErrors.length) {
        throw new Error(`tfs-requirment 配置不合规：${entryErrors.map(e => `${e.field}（${e.message}）`).join('；')}`);
    }
    // ⚠️ 必须 `ctx.get('settings')`，不能读 `ctx.settings`：本插件 `inject = ['tools']`，
    // 对已注册但未 inject 的服务做属性读取会被 cordis 抛错（`vendor/cordis/lib/index.js:672-681`），
    // 而 `ctx.get(name)` 未提供时返回 `undefined`（同文件 `:762-765`）—— 正是这里需要的降级语义。
    //
    // `typeof` 守卫兜住"轻量 ctx"（单测桩、未来的最小宿主）：真实 cordis Context 恒有 `get`，
    // 这里多一次判断是为了让**缺能力时降级**而不是把 apply 抛穿（抛穿 = 整个插件树加载失败）。
    const settings = typeof ctx?.get === 'function' ? ctx.get('settings') : undefined;
    if (!settings || typeof settings.installSection !== 'function')
        return false;
    // 权威配置的读取口：installSection 会经 setSource 注入 thunk，未注入前用 entry 兜底。
    let readSource = () => entry;
    settings.installSection(ctx, SETTINGS_NAMESPACE, Config, entry, {
        setSource(current) {
            readSource = current;
            callbacks.onResolved(current());
        },
        onChange() {
            callbacks.onResolved(readSource());
        },
        validate(value) {
            // 表达 schema 无法承载的约束：违规即抛，宿主据此拒绝该次写入。
            const errors = validateConfig(value);
            if (errors.length) {
                throw new Error(errors.map(e => `${e.field}：${e.message}`).join('；'));
            }
        },
    });
    return true;
}
//# sourceMappingURL=settings.js.map
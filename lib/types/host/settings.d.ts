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
 * @module dsh-tfs-requirment/host/settings
 */
import type { Context } from '@deepseek-ai/cordis';
import { type TfsRequirmentConfig } from '../config.js';
/** 本插件的设置命名空间（小写连字符，符合 settings 服务约束）。 */
export declare const SETTINGS_NAMESPACE = "tfs-requirment";
/** settings 服务的 installSection 钩子（结构类型，避免静态依赖该包）。 */
export interface SettingsSectionHooks<T> {
    setSource(current: () => T): void;
    onChange(): void;
    validate?(value: T): void;
}
/** settings 服务最小面（结构类型）。 */
export interface SettingsProviderLike {
    installSection<T>(owner: Context, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooks<T>): void;
}
/** installSettingsSection 的运行时回调。 */
export interface SettingsCallbacks {
    /**
     * 配置被解析/变更时调用（attach/detach/提交后）。
     * @param next - 当前权威配置。
     */
    onResolved(next: TfsRequirmentConfig): void;
}
/**
 * 注册插件设置分区。
 *
 * @param ctx - 宿主上下文。
 * @param entry - 合成基线配置（通常来自 cordis.patch.yml / Config 默认值）。
 * @param callbacks - 解析回调。
 * @returns 是否成功注册（false 表示宿主无 settings 服务，能力降级）。
 * @throws 当 entry 本身不合规时（配置错误应在装配期暴露，而非运行期静默）。
 */
export declare function installSettingsSection(ctx: Context, entry: TfsRequirmentConfig, callbacks: SettingsCallbacks): boolean;
//# sourceMappingURL=settings.d.ts.map
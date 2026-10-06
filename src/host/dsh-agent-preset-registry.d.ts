/**
 * 宿主 agent-preset-registry 包的最小类型面（本插件自持，避免构建期包解析失败）。
 *
 * ## 为什么需要这份声明
 *
 * 0.1.7 起 preset 包从 `@deepseek-ai/dsh-agent-presets` 改名为
 * `@deepseek-ai/dsh-agent-preset-registry`，且旧包已被删除。而本插件的构建环境
 * （deepseek-harness 仓库根 node_modules）没有任何 preset 包的符号链接（已实测：
 * `node_modules/@deepseek-ai/dsh-agent-preset-registry` 不存在，旧名符号链接悬空），
 * tsc 按包名解析两条动态 import 都会 TS2307。本文件按**运行期真实导出面**声明
 * 本插件实际用到的最小子集，来源：
 * `@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-agent-preset-registry/lib/types/index.d.ts`
 * （0.1.7-alpha.2，`livePresetMounts` 导出于 :9；`acquireScope` 于 :118-121，
 * 返回 `{ key: ScopeKey } & AsyncDisposable`）。
 *
 * 当依赖环境能真实解析到该包时，包自身的 .d.ts 优先于这份 ambient 声明，
 * 不会产生类型冲突。
 */

/** 进程内所有存活 preset 挂载（模块级状态，跨 cordis 运行时；本插件只读 `key`）。 */
declare module '@deepseek-ai/dsh-agent-preset-registry' {
  /** 枚举当前进程内全部存活 preset 挂载（`within` 参数本插件用不到，收窄为 unknown）。 */
  export function livePresetMounts(within?: unknown): ReadonlyArray<{ key?: unknown }>
}

/**
 * 旧包名（≤0.1.6 宿主）：仅作为动态 import 的兼容回退目标。
 * 0.1.7 起该包已删除，本声明只为让回退分支通过类型检查；
 * 运行期 import 失败会被 collectSkills 逐名 catch 并记入 warnings（可见降级）。
 */
declare module '@deepseek-ai/dsh-agent-presets' {
  /** 旧名包的 `livePresetMounts` 导出面与新名一致（≤0.1.6 宿主）。 */
  export function livePresetMounts(within?: unknown): ReadonlyArray<{ key?: unknown }>
}

// 浏览器半入口。由 `dsh.client.platform:'web'` 自动加载（package.json exports "./client"）。
//
// DSH 客户端半契约（已对照宿主真实插件 ui-jobs / ui-attachment 核实）：
//   - 导出 `inject`：声明本插件客户端半需要的 cordis 服务（此处仅需 `slots`）；
//   - 导出 `apply(ctx)`：宿主在加载 "./client" 时调用，ctx 为客户端根上下文。
//
// 旧占位 `clientEntry()` 不符合该契约（宿主不会调用），已替换为 `apply` + `inject`，
// 并由 registerExecutionPanel 把 ExecutionPanel 注册到 `sidebar.panellist` 与 `main` 槽
// （早期挂在 `shell.overlay` 浮层上，因为启动即遮住应用而放弃）。

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { registerExecutionPanel } from './slots.js'

/**
 * 客户端模块名。与宿主半的 `tfs-requirment` 区分开，便于日志定位。
 * DSH 客户端契约只认命名导出 `name`/`inject`/`apply`（对齐 dsh-optimized-prompt/client），
 * 因此**不要**再加 `export default`——那会触发 tsdown 的 MIXED_EXPORTS 并让加载器可能取到 `default`。
 */
export const name = 'tfs-requirment-client'

/** 本插件客户端半所需的 cordis 服务。 */
export const inject = ['slots']

/**
 * 客户端半入口：宿主在 web 平台加载 "./client" 时调用。
 * @param ctx - 客户端根上下文。
 */
export function apply(ctx: ClientContext): void {
  registerExecutionPanel(ctx)
}

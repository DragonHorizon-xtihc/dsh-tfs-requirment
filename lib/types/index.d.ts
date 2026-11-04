/**
 * `dsh-tfs-requirment` —— 宿主半入口。
 *
 * 一个 DSH 插件的最小形态是这里的三个导出：`name`、`inject`、`apply`（外加 `Config`）。
 * 宿主半负责一切有状态、有权限的动作：**TFS REST 直连**、凭据 profile、看板状态持久化、
 * 回写四道门禁、角色编排。
 *
 * ## 铁律：TFS 查询与操作一律走 REST，不经 tfs-mcp（2026-09-19）
 *
 * 适配层 `TfsAdapter.call(raw, args)` 把操作键直接分派到 `/_apis/...` 端点，
 * **不经过** `ctx.tools.execute('mcp__<server>__*')`。因此：
 *   - 插件运行期**不需要**宿主装载任何 tfs-mcp 实例；
 *   - `cordis.patch.yml` 不再声明 `@deepseek-ai/dsh-mcp-client` 行；
 *   - 凭据（URL/集合/PAT）由本插件的连接档案服务提供，不依赖 MCP 子进程 env。
 * 参数名仍叫 `raw`（旧工具名形态），只是为了让适配层分支表与历史审计记录不失配。
 *
 * 界面由客户端半（exports `./client`，由 `dsh.client.platform:'web'` 自动加载）承载。
 *
 * ## 装配纪律：每个能力独立降级，且失败要看得见
 *
 * 实测确认（见 dsh-optimized-prompt 先例）：插件模块加载失败时 loader 只打日志并跳过该行，
 * 本插件 id 也不在 `requiredStartupEntryIds` 里，所以不会拖垮 `dsh web`。但 `dsh web` 的启动
 * 审计可能只传空 warn —— 错误在 Web 下不可见，插件会静默消失。因此后续各阶段能力逐个
 * try/catch，单项失败只禁用那一项并把原因写进日志，绝不因为一个可选能力缺失让整个插件消失。
 *
 * @module dsh-tfs-requirment
 */
import type { Context } from '@deepseek-ai/cordis';
import { Config } from './config.js';
import type { TfsRequirmentConfig } from './config.js';
/** 插件名，同时用作 loader 行 id 与客户端 bundle id。 */
export declare const name = "tfs-requirment";
/**
 * 宿主半模块的**加载时刻**（进程内只算一次）。
 *
 * 用途（2026-10-29 事故教训）：宿主半是普通 node 模块，`dsh` 启动时 `import` 一次即固化；
 * 重新 `tsc` 出 `lib/` 之后如果不重启 dsh，运行期仍是旧代码——而报错文案看上去"很正常"
 * （本次现场：构建产物已更新，用户仍收到上一版的 *缺少 start(name, request) 方法*）。
 * 面板把这个时间显示出来，"要不要重启"就不再靠猜。
 */
export declare const PLUGIN_LOADED_AT: string;
/**
 * 依赖的宿主服务（扁平字符串数组，cordis 按元素取服务名）。
 *
 * **不再注入 `tools`**（2026-09-19 REST 化）：旧实现必须靠 `ctx.tools.execute` 才能调
 * 外部 tfs-mcp 实例的 `mcp__tfs-mcp__*` 工具；REST 化后适配层直接用 `fetch` 打 `/_apis/*`，
 * `ctx.tools` 只剩
 * "注册本插件的 `tfs_req_*` 工具"这一个用途 —— 那是**可选能力**（headless 部署没有工具
 * 运行时也不该让插件整体加载失败），故改为 `ctx.get('tools', false)` 惰性取用。
 *
 * `settings`/`slots`/`subagents`/`webServer` 本就用 `ctx.inject` 惰性获取，
 * 这样在缺少 web 服务的装配下本插件仍能加载（只是对应 UI/编排能力不可用），
 * 沿用 dsh-optimized-prompt 的装配纪律。
 */
export declare const inject: readonly [];
export { Config };
export type { TfsRequirmentConfig };
/**
 * 装配插件。
 * @param ctx - 宿主上下文。所有依赖（settings / slots / subagents / webServer / dataDir）
 *   均经 `ctx.get()` 惰性读取；`tools` 仅用于注册本插件的 `tfs_req_*` 工具。
 * @param config - 经 `Config` 校验并填过默认值的配置。
 */
export declare function apply(ctx: Context, config: TfsRequirmentConfig): void;
//# sourceMappingURL=index.d.ts.map
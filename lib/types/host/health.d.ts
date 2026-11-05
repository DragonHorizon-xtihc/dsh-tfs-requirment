/**
 * TFS 连通性自检（US1 / T029）+ MCP 工具可用性盘点（T028b）。
 *
 * **为什么单独成文件**：这段逻辑有两个必须被单测锁定的安全契约——
 *   1. **错误不得含凭据片段**（T033 / CHK002）：TFS 的报错可能回显请求 URL（含 `?token=`）
 *      或 `Authorization` 头，本模块在返回前统一擦除，绝不把凭据透出到面板/日志；
 *   2. **失败必须归类**（T029）：把底层错误映射为 认证 / 地址 / 权限 / 未知 四类，
 *      让用户知道该改 PAT、还是改 URL、还是找管理员，而不是看一坨堆栈。
 *
 * 只读：仅调用 `tfs_whoami` / `tfs_get_current_collection` / `tfs_get_projects`，
 * 不触发任何写操作。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/health
 */
import type { HealthResult } from '../shared/contracts.js';
import { scrubCredentials } from '../shared/redact.js';
export { scrubCredentials };
/** 连通性探测所需的最小 adapter 面。 */
export interface HealthProbePort {
    whoami(): Promise<unknown>;
    getCurrentCollection(): Promise<unknown>;
    getProjects(args?: unknown): Promise<unknown>;
    /**
     * 传输层告警（可选）。
     *
     * 真实实现为 `TfsAdapter.transportNotice`：基址是 `http:` 时 PAT 仅以 base64
     * （可逆）过网。自检结论不受影响（连通性由 whoami 定），但告警要透给面板，
     * 否则用户无从得知自己在用明文信道送凭据。
     */
    transportNotice?(): string | undefined;
}
/**
 * 本插件运行期依赖的**操作键**清单（用于 T028b「缺失操作」可见）。
 *
 * REST 化（2026-09-19）后这些键不再是"某个 MCP 实例注册的工具名"，而是
 * `adapter.call(raw, args)` 的分派键；运行期传入的 `availableTools` 实为
 * `IMPLEMENTED_OPERATIONS`（适配层已实现 REST 分支的操作集）。
 * 取值保留 `tfs_*` 形态是为了与契约表 `TFS_TOOL_SPECS` 的 `raw` 一一对齐。
 */
export declare const EXPECTED_TFS_TOOLS: readonly string[];
/**
 * 归类 TFS 连通性错误（T029）。
 * @param message - 原始错误消息。
 * @returns 类别 + 可读原因（已擦除凭据）。
 */
export declare function classifyTfsError(message: string): {
    kind: HealthResult['kind'];
    reason: string;
};
/**
 * 执行连通性自检（T029）+ 工具可用性盘点（T028b）。
 *
 * @param port - 探测面（真实为 TfsAdapter，测试可打桩）。
 * @param availableTools - 适配层已实现 REST 分支的操作键（不含 `mcp__<server>__` 前缀）。
 * @returns 自检结果（失败也返回 200 语义的对象，UI 据此渲染红/绿）。
 */
export declare function runHealthCheck(port: HealthProbePort, availableTools?: readonly string[]): Promise<HealthResult>;
//# sourceMappingURL=health.d.ts.map
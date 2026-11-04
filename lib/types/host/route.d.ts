/**
 * 宿主半 HTTP 路由（Phase 3：真实 client→host 通道）。
 *
 * 客户端半 `fetch(TFS_ROUTES.*)` 调到这里；三个端点分别由 `host/api.ts` 的编排落地：
 *  - `GET  /tfs-requirment/panel-data`    → getPanelData
 *  - `POST /tfs-requirment/confirm-write` → confirmWrite（过四道门禁后直连 TFS REST 写入）
 *  - `POST /tfs-requirment/dispatch`      → dispatch（按角色派发 subagent）
 *
 * 设计对齐 dsh-optimized-prompt/routes.ts：
 *  - 业务失败返回 **200** + `ok:false`（把"模型没写好"与"请求非法/被拒"区分开）；
 *  - 用 `guardedWebServer` 给每条路由套鉴权栅栏（未鉴权 401/403，门禁不可用 503）；
 *  - 用 `ctx.inject(['webServer'], ...)` 惰性注册，宿主无 web 服务时插件仍可加载（仅无按钮端点）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/route
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Context } from '@deepseek-ai/cordis';
import type { HostApi } from './api.js';
/** 取面板数据处理器。 */
export declare function createPanelDataHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/**
 * 能力目录强制重采处理器（POST）。
 *
 * 与 `panel-data` 的差别：本处理器 `await api.refreshPanelData()`，即**先重采再返回**。
 * `refresh()` 内部用 inflight 去重 + 逐项 try/catch 降级，从不抛错，故这里不需要额外超时或
 * 错误分支；用户连点刷新也只会共享同一次采集。
 */
export declare function createCatalogRefreshHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/** 需求池列表处理器（POST，body = RequirementFilter）。 */
export declare function createRequirementsHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 需求筛选可选项处理器（GET，问题 3：项目/类型/状态/指派人，由宿主从真实 TFS 采集）。 */
export declare function createQueryOptionsHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/**
 * 需求筛选可选项**强制重采**处理器（POST）。
 *
 * 与 `query-options`（GET）的差别：本处理器绕过宿主进程内缓存，直接重采一轮 TFS 元数据。
 * 存在的理由：缓存在进程内，TFS 上新建项目/工作项类型后它会滞后到服务重启，
 * 用户需要一个明确入口自救（FR-003）。用 POST 是因为它有副作用（丢弃缓存 + 触发采集）。
 */
export declare function createQueryOptionsRefreshHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/**
 * 可选项**读盘**处理器（GET，问题 1）：直接返回 query-options.json 里的缓存，
 * 不触发任何 TFS 元数据采集；无缓存时 data=null（客户端据此决定是否首次采集）。
 */
export declare function createQueryOptionsLoadHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/** 可选项**强制重采并落盘**处理器（POST，问题 1「采集可选项」按钮，body 可带 collection）。 */
export declare function createQueryOptionsCollectHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * UI 状态处理器（问题 2/4/6）：
 *  - GET：返回当前集合的 UiState（无记录返回 `{}`，客户端回退默认值）；
 *  - POST：body 为 UiState 补丁（可带 collection 覆盖集合命名空间），浅合并落盘。
 */
export declare function createUiStateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 还原已领取需求回需求池处理器（POST，问题 7，body = { requirementKey }）。 */
export declare function createRequirementRestoreHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 实时重取需求四段正文处理器（POST，问题 11，body = { requirementKey }）。 */
export declare function createRequirementEnrichHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 删除已取消任务处理器（POST，问题 8，body = { taskIds: string[] }，整批门禁）。 */
export declare function createTaskDeleteHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 编辑已领取需求本地字段处理器（POST，问题 3，body = UpdateRequirementInput）。
 *
 * 只接受 `requirementKey` + `prompt` / `workspace` 三个键：TFS 侧字段（标题/状态/标签）
 * 必须走 `confirm-write` 的四道门禁，这条路由**不是**它们的旁路。
 * `null` 需要显式保留（= 清空），故不能用 `typeof x === 'string'` 过滤后直接丢弃。
 */
export declare function createRequirementUpdateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 需求级执行状态处理器（POST，问题 5，body = { requirementKey, state }）。
 *
 * `state='active'` = 取消完成（需求退回「任务中心」）；`'completed'` = 确认完成（迁入「已完成」）。
 * 只接受这两个字面量：状态是 UI 分页的依据，放开成任意字符串会让需求掉进"两页都不显示"的缝隙。
 */
export declare function createRequirementExecStateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 编辑任务字段处理器（POST，问题 4，body = UpdateTaskInput）。 */
export declare function createTaskUpdateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 角色清单处理器（GET）。 */
export declare function createRolesListHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/** 保存角色处理器（POST，body = RoleDefinition）。 */
export declare function createRoleSaveHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 删除角色处理器（POST，body = { id, force? }）。 */
export declare function createRoleDeleteHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 技能/MCP 分组清单处理器（GET，2026-11-03 用户诉求）。 */
export declare function createSkillGroupsListHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/** 保存技能/MCP 分组处理器（POST，body = SkillMcpGroup）。 */
export declare function createSkillGroupSaveHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 删除技能/MCP 分组处理器（POST，body = { id }）。 */
export declare function createSkillGroupDeleteHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 看板快照处理器（GET，US3 任务中心 / US6 恢复）。 */
export declare function createBoardHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/** 连通性自检处理器（GET，US1/T029）。 */
export declare function createHealthHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 审计状态处理器（GET，T063）。 */
export declare function createAuditHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/**
 * 审计归档处理器（POST，T063）。
 *
 * 用 POST 而非 GET：它有**副作用**（写归档文件）。虽然 live 日志不被改动，
 * 但把有副作用的动作放在 GET 上会让任何预取/重试链路意外触发归档。
 */
export declare function createAuditArchiveHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 切换集合处理器（POST，body = { collection }，T030）。 */
export declare function createCollectionHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 连接档案清单处理器（GET，T031；响应中永不含 PAT）。 */
export declare function createProfilesHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/** 保存档案处理器（POST，body = ProfileSaveInput，T031）。 */
export declare function createProfileSaveHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 删除档案处理器（POST，body = { id }，T031）。 */
export declare function createProfileDeleteHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 设为活动档案处理器（POST，body = { id }，T031）。 */
export declare function createProfileActivateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** MCP 接入诊断处理器（GET，T028b）：实例信息 + 环境模板一并返回，UI 一次请求即可渲染。 */
export declare function createMcpInstanceHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/**
 * 能力目录处理器（GET，问题 8 / 12）。
 *
 * 返回 `tfs_req_*` ⇄ 适配层操作键的一一对应，供「连接与凭据」页展示
 * 「插件直连 REST 能做什么」（REST 化后不再讲"把哪个 MCP 工具封装成了什么"）。
 */
export declare function createTfsToolsHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => void;
/** 写出 MCP 启动环境文件处理器（POST，body = { profileId? }，T028b；响应永不含 PAT）。 */
export declare function createMcpEnvFileHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 领取需求处理器（POST，body = ClaimRequirementInput）。 */
export declare function createClaimHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 拆解需求处理器（POST，body = { requirementId }；问题 10：await 完成后再响应，UI 即可实时刷新）。 */
export declare function createDecomposeHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 指派任务角色处理器（POST，body = { taskId, roleName }）。 */
export declare function createTaskAssignHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 任务状态操作处理器（POST，body = { taskId, action, expectedRevision? }）。 */
export declare function createTaskStateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 任务执行轨迹处理器（GET `?taskId=&attempt=`，spec 006 US2）。
 *
 * 会话不可读 / 无 runId / 服务缺失都由 api 层收敛为 **200 + available:false**（探测结果，
 * 不是请求非法）；只有缺 taskId / attempt 形状不对才回 400。
 */
export declare function createTaskTraceHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 任务追问 / 补充指令处理器（POST body = { taskId, message }，spec 006 US3）。 */
export declare function createTaskFollowUpHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 需求完成自动回写处理器（问题 4）。
 *
 * - GET  `?requirementKey=`：读本地落盘的最近一次回写报告（无则 `report=null`），不触发 TFS 写；
 * - POST body `{ requirementKey, force? }`：触发（或 force 重跑）回写，返回逐项报告。
 */
export declare function createRequirementWriteBackHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 确保需求有编排主 agent 会话的处理器（spec 010 US1）。
 *
 * POST body `{ requirementKey, force? }` ⇒ `{ ok, orchestration?, reason? }`。
 * 幂等（已存在 continuable 会话则原样返回）；游 downgrade 时返回 `mode:'off'` + 可读原因，
 * 由 UI 如实展示 —— 这里**不**把降级伪装成成功。
 */
export declare function createOrchestratorEnsureHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 开始编排处理器（2026-11-03 问题 4/5）。
 *
 * POST body `{ requirementKey, mode: 'now'|'at', dueAt?, sequential? }`：
 * 'now' = 立刻按依赖顺序启动子 Agent 链；'at' = 登记定时（精确到分，持久化 + 重启补跑）。
 */
export declare function createOrchestrationStartHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 定时执行清单处理器（GET）。 */
export declare function createSchedulesHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 取消定时执行处理器（POST body `{ id }`）。 */
export declare function createScheduleCancelHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 修改定时执行到点时刻处理器（POST body `{ id, dueAt }`；2026-11-03 问题 3）。
 * 同 id 重登记语义：覆盖旧条目并重新武装定时器。
 */
export declare function createScheduleUpdateHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 确认回写处理器。 */
export declare function createConfirmWriteHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/** 发起执行处理器。 */
export declare function createDispatchHandler(api: HostApi): (req: IncomingMessage, res: ServerResponse) => Promise<void>;
/**
 * 注册本插件全部 HTTP 路由。
 *
 * 用 `ctx.inject(['webServer'], ...)` 而非静态 `inject`：宿主没有 web 服务（headless / TUI）
 * 时插件照常加载，只是没有按钮端点，工具的读取链路仍可用（沿用 dsh-optimized-prompt 装配纪律）。
 *
 * @param ctx - 宿主上下文。
 * @param api - 宿主半编排实例。
 */
export declare function registerTfsRoutes(ctx: Context, api: HostApi): void;
//# sourceMappingURL=route.d.ts.map
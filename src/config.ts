/**
 * 插件配置：全部部署间会变化的取值都在这里，且都可在 `cordis.patch.yml` 覆盖。
 *
 * 依据宪法 VI，禁止把这类取值写成模块级常量再留一个"测试钩子"。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/config
 */

import z from '@deepseek-ai/schemastery'

/** 插件配置的已解析形态（schemastery 已填默认值）。 */
export interface TfsRequirmentConfig {
  /** 目标集合清单（FR-025）。运行时可在清单内切换（FR-003）。 */
  collections: string[]
  /** 默认目标集合（FR-025）。必须是 collections 之一。 */
  defaultCollection: string
  /** 定时轮询间隔（分钟），最小 1（FR-024/S-14）。 */
  pollIntervalMinutes: number
  /** 打标签默认标签（FR-013）。 */
  defaultLabel: string
  /** 同时执行需求数上限（FR-029）。 */
  maxConcurrentRequirements: number
  /** 审计日志滚动保留天数（S-03）。 */
  auditRetentionDays: number
  /**
   * 可关闭开关。
   *
   * 注：旧字段 `tfsServerName` 已于 2026-09-19 REST 化时**移除** —— 本插件不再声明也不
   * 依赖任何 tfs-mcp 实例，TFS 读写一律直连 `/_apis/*`。用户 profile 里的残留取值会被
   * schemastery 忽略（不报错），无需手工清理。
   */
  enabled: boolean
  /**
   * 任务自动链式执行（问题 6）：一条任务成功收口后，宿主自动派发同需求下依赖已就绪、
   * 已指派角色的下一条任务，无需逐个点击；待人工确认 / 失败的任务会阻断其下游。
   * 默认开启；关闭后退回"逐条手动点击运行"。
   */
  autoChainTasks: boolean
  /**
   * 需求完成后自动回写 TFS（问题 4）：需求下全部任务完成后，自动把需求评审/自测字段
   * 置为通过、回写执行结论评论、上传关键产物附件，并把关联人员任务置为"已解决"。
   * 默认开启；关闭后仅在任务中心提供"手动回写"入口。
   */
  autoWriteBack: boolean
  /**
   * 子智能体委派深度上限（问题 1：限制孙 agent 无限派生导致 token 爆炸）。
   * 默认 1 = 只允许任务子 agent 自身干活、不再向下派生子智能体；0 表示不限制（不推荐）。
   */
  defaultMaxDepth: number
  /**
   * 单次模型响应输出 token 上限（问题 1：0 = 不设置，沿用模型/宿主默认）。
   * >0 时透传为子 agent 的 `agentOptions.maxTokens`，防止单次输出失控。
   */
  defaultMaxTokens: number
  /**
   * 单条任务运行总时长看门狗（分钟，问题 1：防止死循环永久占用并发槽）。
   * 超时后中止子 run 并把任务收口为失败；0 = 不启用总时长看门狗（仍保留启动/排队超时）。
   */
  runTimeoutMinutes: number
  /**
   * 是否启用「编排主 agent」（spec 010 US1/US2）。
   *
   * 开启后，每条需求会有一个 continuable 持久子会话当"编排负责人"：任务完成后归纳结论、
   * 全部完成后出最终总结并写入 TFS。关闭则完全退回 010 之前的语义（无归纳、模板总结）。
   *
   * 宿主 provider 不支持 continuable、或创建/观测连续失败时，会自动按需求级降级为关闭
   * 并在面板给出原因 —— 本开关是"用户层面的总闸"，不是唯一保险。
   */
  orchestratorEnabled: boolean
  /**
   * 编排主 agent 使用的 subagent provider 名（空串 = 取宿主第一个已注册 provider）。
   *
   * 只在该 provider 支持 continuable 时生效；不支持则 fail-loud 降级（不静默）。
   */
  orchestratorProvider: string
  /**
   * 是否复用任务子会话（spec 010 AC3.3）：同一需求 + 同一 provider/preset 的连续任务
   * 复用同一个 continuable 子会话、以 inbox 消息续跑，避免每个任务都从零理解需求。
   *
   * 关闭则每个任务仍是独立的 ONE-SHOT 子 agent（010 之前的语义），共享简报仍会注入。
   */
  reuseTaskSessions: boolean
  /**
   * 等待编排主 agent 归纳的**硬超时**（秒；超时按"无摘要"收口该次归纳）。
   *
   * `0` **不是**"不启用"：装载时按 `Math.max(1, x)` 折成 1 秒，等于"永远超时"，
   * 每条任务都拿不到归纳结论。此类超时没有关闭形态，必须给正数。
   */
  summarizeTimeoutSeconds: number
  /**
   * 归纳的**放行宽限**（秒）。任务收口后至多等这么久让主 agent 出结论，
   * 超时就先放行下一个任务、归纳继续在后台跑完。
   *
   * 与 `summarizeTimeoutSeconds` 的区别：后者是"归纳本身允许跑多久"，
   * 前者是"链路愿意为结论阻塞多久"。链路推进不该被增强能力拖住，故宽限应远小于硬超时。
   *
   * 与硬超时同理：`0` 不是"不等待"，而是折成 1 秒（链路立即放行，不等结论）。
   */
  summarizeGraceSeconds: number
  /**
   * 等待编排主 agent 最终总结的超时（秒；超时回退到既有模板总结）。
   *
   * `0` 折成 1 秒 ⇒ 每次都回退到模板总结（界面上的"总结来源：模板兜底"）。
   */
  finalizeTimeoutSeconds: number
  /**
   * 最终总结的放行宽限（秒；此时已无下一任务，故可略长）。
   *
   * `0` 折成 1 秒 ⇒ 需求收口不等最终总结。
   */
  finalizeGraceSeconds: number
  /**
   * 复用会话任务的收口观测超时（分钟；AC3.4）。
   *
   * continuable 子**没有** per-message result，完成只能靠观测；超时后该任务按失败收口
   * 并给出可读诊断 —— 绝不让任务永久停在 running。
   *
   * `0` 折成 1 毫秒 ⇒ **每个**复用任务都会以"未观测到收口"失败。必须给正数。
   */
  taskSessionSettleTimeoutMinutes: number
  /**
   * 假执行巡检阈值（分钟；`0` = 关闭巡检）。
   *
   * 进程长驻期间，若一个任务卡在 `in_progress`/`running` 且**没有绑定子会话 runId**
   * 超过这么久，宿主把它标失败并留待人工核对。装载时的崩溃对账只跑一次，覆盖不到
   * 运行期新产生的悬空（丢失的 HTTP 请求、复用会话投递后无人观测等）。
   */
  staleRunningReapMinutes: number
  /**
   * 假执行巡检节奏（秒；`0` = 关闭巡检）。
   *
   * 巡检本身的间隔，与阈值分开配置：阈值决定"多久算悬空"，节奏决定"多久复查一次"。
   */
  staleRunningSweepSeconds: number
  /**
   * 是否允许**模型自己**发起 TFS 写操作（写门禁 2「人工确认」的总闸）。
   *
   * 写门禁 4 道：① dry-run 预览 ② 用户确认 ③ 幂等键判重 ④ 审计留痕。② 的含义是
   * "这次写由人点头"，面板「确认回写」与需求完成回写都满足它；但 `tfs_req_*` 工具是
   * **模型**在调用，若也传 `confirmed=true`，门禁 2 就永远不可能失败，"任何写操作必须
   * 过人工确认"沦为一句空话。
   *
   * 默认 `false`：模型发起的写操作一律被门禁 2 拒绝（返回可读原因，不落审计、不改
   * TFS），人写仍不受影响。只有当部署确实信任模型自行改动 TFS（例如只读工作项集合）
   * 时才打开。打开即视为**主动放弃**这一层防护，需在部署文档中说明。
   */
  allowModelWrites: boolean
  /**
   * 「采集可选项」时同时在飞的元数据 HTTP 请求数上限。
   *
   * 类型/状态采集是 O(项目×类型) 次 GET（WN_HIS 实测 62 个项目、约 800 次请求）。
   * 裸并行会一次性开出 62 条连接（每条自带一个 20 s 超时控制器），对本地 TFS 过重；
   * 串行则让面板等待数十秒。此处限流，取值由现场网络与 TFS 负载决定，故为配置项
   * 而非写死常量。缺省 8；`0` 或负数按 1 处理（等价于"尽量串行"）。
   */
  queryOptionsConcurrency: number
  /**
   * 是否允许附件/TFVC 下载落到数据目录的 `downloads/` **之外**（缺省否）。
   *
   * 下载类端点接受调用方给的 `targetDir` / `options.savePath`。未受约束时它等于
   * "让请求在宿主任意绝对路径建目录并写文件"，而这些参数可能来自模型。缺省关闭时
   * 越界落点被拒并给出可读原因；确实要把文件写到别处的部署显式打开。
   */
  allowExternalDownloadDir: boolean
}

/**
 * schemastery 配置 schema。字段注释即面向使用者的说明，会出现在配置报错里。
 * 注意：schemastery 的 `.number()` 不保证 `.min()` 语义（与 zod 不同），因此数值下限
 * 由 `validateConfig` 在运行期强制，并由单元测试 T032 覆盖，而非依赖 schema 链。
 */
export const Config: z<TfsRequirmentConfig> = z.object({
  collections: z.array(z.string()).default(['WN_HIS']),
  defaultCollection: z.string().default('WN_HIS'),
  pollIntervalMinutes: z.number().default(5),
  defaultLabel: z.string().default('dsh'),
  maxConcurrentRequirements: z.number().default(3),
  auditRetentionDays: z.number().default(90),
  enabled: z.boolean().default(true),
  autoChainTasks: z.boolean().default(true),
  autoWriteBack: z.boolean().default(true),
  defaultMaxDepth: z.number().default(1),
  defaultMaxTokens: z.number().default(0),
  runTimeoutMinutes: z.number().default(30),
  orchestratorEnabled: z.boolean().default(true),
  orchestratorProvider: z.string().default(''),
  reuseTaskSessions: z.boolean().default(true),
  summarizeTimeoutSeconds: z.number().default(120),
  summarizeGraceSeconds: z.number().default(20),
  finalizeTimeoutSeconds: z.number().default(180),
  finalizeGraceSeconds: z.number().default(60),
  taskSessionSettleTimeoutMinutes: z.number().default(30),
  staleRunningReapMinutes: z.number().default(10),
  staleRunningSweepSeconds: z.number().default(60),
  allowModelWrites: z.boolean().default(false),
  queryOptionsConcurrency: z.number().default(8),
  allowExternalDownloadDir: z.boolean().default(false),
})

/** 单条配置校验错误。 */
export interface ConfigValidationError {
  /** 出错的字段名。 */
  field: string
  /** 可读说明。 */
  message: string
}

/**
 * 运行期配置校验（供设置页保存前与单元测试 T032 调用）。
 *
 * 返回非空数组表示存在违规；宪法与 FR 要求：轮询间隔与并发上限 ≥ 1、默认标签非空、
 * 默认集合必须属于已配置清单。
 *
 * @param config - 已解析的插件配置。
 * @returns 违规项列表；空数组表示通过。
 */
export function validateConfig(config: TfsRequirmentConfig): ConfigValidationError[] {
  const errors: ConfigValidationError[] = []
  if (!(config.pollIntervalMinutes >= 1)) {
    errors.push({ field: 'pollIntervalMinutes', message: '必须 ≥ 1（FR-024/S-14）' })
  }
  if (!(config.maxConcurrentRequirements >= 1)) {
    errors.push({ field: 'maxConcurrentRequirements', message: '必须 ≥ 1（FR-029）' })
  }
  if (!config.defaultLabel || config.defaultLabel.trim().length === 0) {
    errors.push({ field: 'defaultLabel', message: '不可为空（FR-013）' })
  }
  if (config.collections.length === 0 || !config.collections.includes(config.defaultCollection)) {
    errors.push({ field: 'defaultCollection', message: '必须属于 collections 清单（FR-025）' })
  }
  if (!(config.queryOptionsConcurrency >= 1)) {
    errors.push({ field: 'queryOptionsConcurrency', message: '必须 ≥ 1（元数据采集并发上限）' })
  }
  // 问题 1：执行预算只接受非负整数（0 对 maxDepth 表示不限制、对 maxTokens/runTimeout 表示不启用）。
  // 注意 0 在各处含义不同：maxDepth/maxTokens/runTimeout/staleRunning* 表示"不启用"，
  // 而 summarize*/finalize*/taskSessionSettle* 的 0 会被 Math.max(1, x) 折成"立即失败"
  // （它们没有"不启用"形态，必须给正数），故下面不额外拒绝 0。
  for (const [field, label] of [
    ['defaultMaxDepth', '委派深度上限'],
    ['defaultMaxTokens', '单次输出 token 上限'],
    ['runTimeoutMinutes', '任务运行看门狗（分钟）'],
    ['summarizeTimeoutSeconds', '编排归纳硬超时（秒）'],
    ['summarizeGraceSeconds', '编排归纳放行宽限（秒）'],
    ['finalizeTimeoutSeconds', '编排最终总结硬超时（秒）'],
    ['finalizeGraceSeconds', '编排最终总结宽限（秒）'],
    ['taskSessionSettleTimeoutMinutes', '复用会话收口观测超时（分钟）'],
    ['staleRunningReapMinutes', '假执行巡检阈值（分钟）'],
    ['staleRunningSweepSeconds', '假执行巡检节奏（秒）'],
  ] as const) {
    const value = config[field]
    if (!Number.isFinite(value) || value < 0) {
      errors.push({ field, message: `${label}必须是 ≥ 0 的数值` })
    }
  }
  return errors
}

/** 配置是否全部合规。 */
export function isConfigValid(config: TfsRequirmentConfig): boolean {
  return validateConfig(config).length === 0
}

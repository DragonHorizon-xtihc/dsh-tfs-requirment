/**
 * TFS 领域类型（Principle IV 单一出口的入参/出参契约）。
 *
 * 这些类型由 `tfs/adapter.ts` 在归一化 TFS REST 响应前后使用；业务层不直接依赖 TFS REST 形态。
 * 字段名以 `sampling.ts`（T013）在目标项目实测为准，本文件先给最小可用骨架。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/tfs/types
 */

import type {
  OrchestrationMode,
  RequirementBrief,
  RequirementWriteBackReport,
  WriteOp,
  WriteOpType,
} from '../shared/contracts.js'

/** 编排模式与共享简报类型在此再导出，下游不必再从 contracts 单独取。 */
export type { OrchestrationMode, RequirementBrief } from '../shared/contracts.js'

/**
 * 需求级编排上下文（spec 010，**落 `board.json` 的本地字段，非 TFS 字段**）。
 *
 * 与视图类型 `RequirementOrchestrationView` 同形：看板落的是权威副本，
 * 视图只是它的可序列化镜像（历史 `board.json` 缺字段时按"未启用编排"处理）。
 */
export interface RequirementOrchestration {
  /** 编排模式；缺省按 `'off'`（未启用）处理。 */
  mode: OrchestrationMode
  /** 编排主 agent 的持久子会话 id（continuable childId）。 */
  orchestratorSessionId?: string
  /** 派生编排会话的父会话 id（构造子会话对话地址需要）。 */
  parentSessionId?: string
  /** 降级原因（`mode='off'` 时有值，UI 如实展示）。 */
  reason?: string
  /** 共享简报（US3）。 */
  brief?: RequirementBrief
  /** 任务子会话复用表：`复用键 → 持久子会话 id`（AC3.3）。 */
  taskSessions?: Record<string, string>
  /**
   * 串行编排（2026-11-03 问题 5）：true = 同一时刻只编排一个子 Agent，
   * 上个任务完成才编排下个（拆解弹框选「立刻/定时」时置位）。缺省 false（并发沿用全局上限）。
   */
  dispatchSequential?: boolean
}

/** 来自 TFS 的工作项（需求）。 */
export interface Requirement {
  /** TFS 工作项 ID。 */
  workItemId: number
  /** 所属集合（去重键左半，S-01）。 */
  collection: string
  /** 所属项目。 */
  project: string
  /** 标题。 */
  title: string
  /** TFS 状态（实测值，非枚举）。 */
  state: string
  /** 指派给。 */
  assignedTo: string
  /** 优先级（实测值）。 */
  priority: string
  /** 迭代。 */
  iteration: string
  /** 当前标签集合。 */
  tags: string[]
  /** 创建时间 ISO。 */
  createdAt: string
  /** 更新时间 ISO（增量更新判定，S-14）。 */
  updatedAt: string
  /** 当前 revision（revision 冲突检测，FR-017）。 */
  revision: number
  /**
   * 需求正文（可选；**宿主半已由 TFS HTML 富文本转为可读纯文本**）。
   *
   * TFS 侧无正文字段时为空。落 `board.json` 后即便服务重启，"选为目标"仍能带出内容，
   * 无需再打 TFS（US3）。
   */
  description?: string
  /**
   * 需求分析（问题 11，Winning 自定义字段 `Winning.Demand.Analysis`，HTML 已转纯文本）。
   * 与 description 同纪律：随需求落 board.json，选为目标时参与四段拼接。
   */
  analysis?: string
  /** 数据结构（问题 11，`Winning.Data.Design`）。 */
  dataStructure?: string
  /** 需求配置（问题 11，`Winning.Demand.Config`）。 */
  config?: string
  /** 工作项类型显示名（可选；来自适配层的归一化形状，T013 实测）。 */
  type?: string
  /** 工作项 REST URL（可选）。 */
  url?: string
  /** 区域路径（可选）。 */
  areaPath?: string
  /**
   * 该需求对应的**本地代码库绝对路径**（可选）。
   *
   * ⚠️ 这是**本地补充字段，不是 TFS 字段**——TFS 侧没有"代码目录"概念，由用户在领取时指定。
   * 用途：让角色智能体知道"去哪个目录改代码"（写进派发 prompt），并在看板/UI 可见。
   * **能力边界**：宿主 `SubagentStartRequest` 没有 cwd/workspace 字段，子代理工作目录由
   * 「部署 config override → 否则父会话 workspace」决定（`@deepseek-ai/dsh-subagent/src/out-of-process.d.ts`
   * 的 `resolveChildCwd`），**插件无法按任务改变子代理进程 cwd**；本字段只承载"任务上下文"。
   */
  workspace?: string
  /**
   * 需求级执行提示词（问题 3/6，**本地补充字段，非 TFS 字段**）。
   *
   * 描述"这条需求整体的背景与目标"，由用户在领取入池或编辑已领取需求时填写。
   * 派发任一子任务时会被 `host/api.ts#dispatch` **实时读取**并拼在任务级提示词之前
   * （顺序：工作目录上下文 → 需求级 → 任务级）。刻意**不**复制进各任务：
   * 复制会产生两份真相，用户改了需求提示词后已拆解的任务不会跟着变。
   */
  prompt?: string
  /**
   * 需求级执行状态（问题 3/4/5，**本地补充字段，非 TFS 字段**）。
   *
   * 缺省视为 `'active'`（历史 `board.json` 没有该键，反序列化后必须仍按"进行中"处理，
   * 否则老数据会整体消失到已完成页）。全部任务完成时由看板引擎自动置为 `'completed'`。
   */
  execState?: RequirementExecState
  /**
   * 置为已完成的时间（ISO，问题 3；仅 `execState === 'completed'` 时有意义）。
   * 用户点「取消完成」时一并清除 —— 保留陈旧时间会让"完成于何时"误导人。
   */
  completedAt?: string
  /**
   * 需求完成后的 TFS 自动回写报告（问题 4，**本地补充字段，非 TFS 字段**）。
   *
   * 兼作**重跑幂等账本**：报告中已 `ok` 的项在"重新回写"时默认跳过（除非 force），
   * 避免结论评论 / 附件被重复追加。缺省表示尚未回写。
   */
  writeBack?: RequirementWriteBackReport
  /**
   * 需求级编排上下文（spec 010，**本地补充字段，非 TFS 字段**）。
   *
   * 承载「编排主 agent 的持久子会话 id」与「共享简报」。缺省 = 该需求未启用编排
   * （历史 `board.json` 无此键），任务派发与回写语义与 010 之前完全一致。
   */
  orchestration?: RequirementOrchestration
}

/**
 * 需求级执行状态（**本地补充字段，非 TFS 字段**）。
 *
 * ## 为什么需求需要一个"执行状态"
 *
 * 任务有四态（`pending/in_progress/completed/deleted`），但用户看的是**需求**：
 * "这条需求做完了没有" 在界面上此前无从回答 —— 任务中心的需求行只显示 TFS 的 `state`
 * （如「已建议」），与本地执行进度毫无关系（问题 4：已领取需求缺少执行状态）。
 *
 * ## 取值
 *
 * - `active`：进行中（默认；含"未拆解""部分任务完成""有失败待重试"等一切未收口形态）；
 * - `completed`：该需求名下**全部任务均已完成**（自动迁移，见 `Board.markRequirementCompletedIfAllDone`），
 *   或由用户在处理完后确认。已完成需求从「任务中心」迁到「已完成」页（问题 3），
 *   且**必须先取消完成**才允许「还原到需求池」（问题 5）—— 完成与撤销必须是两个显式动作。
 */
export type RequirementExecState = 'active' | 'completed'

/**
 * 需求去重键 = `workItemId@collection`（S-01，领取幂等）。
 * @param r - 至少含 workItemId 与 collection 的对象。
 * @returns 去重键。
 */
export function requirementDedupKey(r: Pick<Requirement, 'workItemId' | 'collection'>): string {
  return `${r.workItemId}@${r.collection}`
}

// 回写类型已上移到 src/shared/contracts.ts（宿主半/客户端半共享）。
// 此处再导出以保持 `import { WriteOp } from './types.js'` 的历史引用仍然有效。
export type { WriteOpType, WriteOp }

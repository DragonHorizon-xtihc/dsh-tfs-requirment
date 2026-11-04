/**
 * 看板任务快照与状态机（借鉴 agent-team TeamTaskBoard 四态模型，自实现落 JSON）。
 *
 * 四态 `pending/in_progress/completed/deleted` + `blockedBy[]` DAG + `revision` 乐观锁。
 * 状态机转换集中在此文件，供 board 引擎统一校验（US3 T045）。
 *
 * @module dsh-tfs-requirment/core/board/task
 */
import type { ExecState } from './exec-state.js';
import type { FrozenConfig } from '../../shared/contracts.js';
/** 看板任务四态（与 agent-team TeamTaskSnapshot 对齐，自实现）。 */
export type TaskState = 'pending' | 'in_progress' | 'completed' | 'deleted';
/** 执行链路附加态（执行内部用，区别于看板四态）。 */
export type { ExecState };
export type { FrozenConfig };
/** 单次尝试记录（断点重试按子任务粒度，S-07）。 */
export interface AttemptRecord {
    /** 开始时间 ISO。 */
    startedAt: string;
    /** 结束时间 ISO（进行中则缺省）。 */
    endedAt?: string;
    /** 本次尝试结果。 */
    outcome: ExecState;
    /** 备注（可选）。 */
    note?: string;
    /**
     * 本次尝试对应的子 agent 会话 id（`SubagentRun.id`，spec 006 US2）。
     * 派发返回后立即写入（运行中也可据此冷读轨迹）；历史记录可能缺省。
     */
    runId?: string;
    /** 子 run 落定原因（completed/error/refusal/max-tokens/aborted）。 */
    stopReason?: string;
    /** 非 completed 落定时宿主给出的失败诊断（Provider-authored，已限长，不含工具入参/凭据）。 */
    diagnostic?: string;
    /** 最终助手输出摘要（文本，已截断）。 */
    output?: string;
    /** 本次尝试使用的 subagent provider 名（诊断用）。 */
    provider?: string;
    /**
     * 复用 continuable 子会话时，本次尝试对应的**轮次序号**（D6）。
     * 一次投递 = 子会话一个 turn；轨迹读取据此只取该 turn 的事件，避免混入同会话其它任务。
     * one-shot 子会话缺省（整个会话即本次尝试，无需隔离）。
     */
    turn?: number;
}
/** 任务快照（看板权威状态的最小单元）。 */
export interface TaskSnapshot {
    /** 本地任务 ID。 */
    taskId: string;
    /** 所属需求 dedupKey。 */
    requirementId: string;
    /** 回写/打标签幂等键（S-08）。 */
    idempotencyKey: string;
    /** 标题。 */
    title: string;
    /** 描述。 */
    description: string;
    /** 指派角色（引用 RoleAgent.name）。 */
    roleAgent: string;
    /** 创建时冻结的配置。 */
    frozenConfig: FrozenConfig;
    /** 看板四态。 */
    state: TaskState;
    /** 执行链路态。 */
    execState: ExecState;
    /** DAG 依赖（被阻断的任务 ID 列表）。 */
    blockedBy: string[];
    /**
     * 该任务的目标代码库绝对路径（由所属需求在拆解时继承；**本地补充字段，非 TFS 字段**）。
     * 派发时被写进子代理 prompt 作为任务上下文；**不改变子代理进程 cwd**（宿主能力边界）。
     */
    workspace?: string;
    /**
     * 任务级执行提示词（问题 4，**本地补充字段，非 TFS 字段**）。
     *
     * 与"需求级提示词"（`Requirement.prompt`）是**两层**：需求级描述整条需求的背景，
     * 任务级描述"这一个子任务要做什么"。派发时由 `host/api.ts#dispatch` 按
     * `工作目录上下文 → 需求级 → 任务级` 顺序拼接（空段不产出空行）。
     *
     * 为空时回落为派发方的默认文案（`title\n\ndescription`），保持与旧行为一致。
     */
    prompt?: string;
    /** 乐观锁版本号。 */
    revision: number;
    /** 尝试历史。 */
    attempts: AttemptRecord[];
    /** 产物路径。 */
    artifactPaths: string[];
    /**
     * 是否由宿主"自动链式执行"派发（问题 6）。
     *
     * 手动「运行/发起执行」启动的任务无此键；当上一条依赖任务成功收口、宿主自动派发本任务时置 true。
     * 仅用于 UI 标注与诊断，不参与状态机。
     */
    autoLaunched?: boolean;
    /**
     * 任务级编排上下文（spec 010，**本地补充字段，非 TFS 字段**）。
     *
     * 记录该任务实际使用的子会话 id（复用会话时是持久 childId）、是否复用、
     * 以及编排主 agent 归纳出的结论。缺省 = 无编排信息，语义与 010 之前一致。
     */
    orchestration?: TaskOrchestration;
}
/** 任务级编排上下文（spec 010）。 */
export interface TaskOrchestration {
    /** 该任务当前/最近使用的子会话 id（复用 = 持久 childId；one-shot = attempt.runId）。 */
    sessionId?: string;
    /** 该任务是否复用了既有子会话（续跑），而非新建。 */
    reused?: boolean;
    /** 编排主 agent 归纳出的结论摘要。 */
    summary?: string;
    /** 归纳状态。 */
    summaryState?: TaskSummaryState;
    /**
     * 本任务**本该复用持久子会话却回退成 ONE-SHOT** 的原因（2026-10-06 新增）。
     *
     * 存在理由：spec 010 的会话复用（AC3.3）失败时会静默回退 ONE-SHOT，任务照样跑起来，
     * 于是"为什么这次没复用"长期不可观测——而复用是省 token 与保留上下文的关键路径。
     * 这里留一条可读原因（provider 不支持 continuable / 排队超时 / 会话已被清理 …），
     * 让任务详情能如实回答"这次为什么没复用"，而不是让人靠猜。
     */
    fallbackReason?: string;
    /**
     * 主 agent 扫尾轮数（2026-11-03 问题 7）：本任务已被扫尾续跑过几轮。
     * 超过上限即转"主 agent 亲做"，防止失败-续跑死循环（决策见 `shared/sweep.ts#decideSweep`）。
     */
    sweepRound?: number;
}
/** 任务归纳状态（供 UI 与降级判定）。 */
export type TaskSummaryState = 'pending' | 'done' | 'failed' | 'timeout' | 'skipped';
/**
 * 允许的状态转换（闭环，无隐式跳转）。
 * deleted 为终态；completed 仅可转 deleted（撤销）。
 */
export declare const TASK_TRANSITIONS: Readonly<Record<TaskState, readonly TaskState[]>>;
/**
 * 校验状态转换是否合法。
 * @param from - 当前态。
 * @param to - 目标态。
 * @returns 合法返回 true。
 */
export declare function canTransition(from: TaskState, to: TaskState): boolean;
/**
 * 计算下一 revision（乐观锁 +1）。
 * @param current - 当前 revision。
 * @returns current + 1。
 */
export declare function bumpRevision(current: number): number;
//# sourceMappingURL=task.d.ts.map
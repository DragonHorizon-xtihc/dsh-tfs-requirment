/**
 * 审计滚动归档（T063 / S-03）。
 *
 * **为什么单独一个模块**：`AuditLog.rollOver()`（`write-guard/audit.ts:95`）早已实现"筛出过期条目"，
 * 但**全项目无调用点**——也就是说 90 天保留策略在运行期并不存在（`config.auditRetentionDays`
 * 只是个未被消费的配置项）。本模块把"筛选 → 归档落盘 → 可查询状态"接起来。
 *
 * ## 三条硬约束（都直接对应用户可见的后果）
 * 1. **live 日志保持 append-only**：归档只**读** `audit.jsonl`、把过期条目写进**独立文件**，
 *    绝不改写或截断 live 日志。插件在任何情况下都不得删改已提交的审计条目（Principle II）。
 * 2. **重复归档幂等**：因为 live 未被改动，再点一次「归档」必然又筛出同一批过期条目。
 *    若直接追加就会产生重复行，所以归档前先按**整条记录序列化文本**去重（同一条目只归档一次）。
 * 3. **凭据不落归档**：`AuditLog.append` 已在落盘前递归剔除凭据字段，而归档的数据源正是
 *    live 文件（已剔除），故本模块无需也不应再做一次剔除——但要断言"归档内容 == live 内容"。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/host/audit-archive
 */
import type { AuditEvent, AuditLog } from '../write-guard/audit.js';
import { type FsLike } from '../persistence/fs-like.js';
import type { ArchiveResult, AuditView } from '../shared/contracts.js';
/** 归档文件名前缀（`audit-archive-YYYYMMDD.jsonl`）。 */
export declare const ARCHIVE_PREFIX = "audit-archive-";
/** 归档依赖（全部可注入）。 */
export interface AuditArchiveDeps {
    /** 插件数据目录（`audit.jsonl` 与归档文件同目录）。 */
    baseDir: string;
    /** 审计日志（只用到 rollOver / replay 两个只读能力）。 */
    audit: Pick<AuditLog, 'rollOver' | 'replay'>;
    /** 保留天数（S-03，来自配置）。 */
    retentionDays: number;
    /** 可注入文件系统。 */
    fs?: FsLike;
    /** 当前时间（可注入，便于测试到期边界）。 */
    now?: () => Date;
}
/**
 * 审计滚动归档器。
 */
export declare class AuditArchive {
    private readonly deps;
    private readonly fs;
    private readonly now;
    constructor(deps: AuditArchiveDeps);
    /** 某时刻对应的归档文件名。 */
    archiveFileName(at?: Date): string;
    /** 某时刻对应的归档文件绝对路径。 */
    archivePath(at?: Date): string;
    /** 列出既有归档文件（含字节数）。 */
    listArchiveFiles(): Array<{
        name: string;
        bytes: number;
    }>;
    /**
     * 归档状态（只读，不产生副作用）。
     *
     * 审计文件解析失败不应让整个诊断页崩掉，故 `replay()` 异常被转成 `ok:false + reason`。
     */
    inspect(): AuditView;
    /**
     * 收集**全部既有归档文件**中已出现的条目文本（跨文件去重键）。
     *
     * 为什么必须跨文件去重：live 日志是 append-only、**从不截断**，所以过期条目在源里永远还在。
     * 若只跟"今天这个归档文件"比对，那么**每天归档一次就会把同一批条目再写一遍**，
     * 归档目录会随天数线性膨胀成 N 份重复数据。
     */
    private seenInArchives;
    /**
     * 执行归档：把过期条目追加到 `audit-archive-YYYYMMDD.jsonl`。
     *
     * - live 日志**不被修改**（append-only 不可破）；
     * - 已归档过的条目（不论在哪个归档文件里）**不再重复写入**；
     * - 无过期条目时**不创建空文件**，直接返回 `archived: 0`。
     *
     * @param at - 归档时点（默认当前时间，注入便于测试）。
     */
    archive(at?: Date): ArchiveResult;
    /** 读取某归档文件的条目（诊断/验收清点用）。 */
    readArchive(name: string): AuditEvent[];
}
//# sourceMappingURL=audit-archive.d.ts.map
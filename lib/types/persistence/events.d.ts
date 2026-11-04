/**
 * 事件日志（append-only，Principle VI / S-03）。
 *
 * 所有状态变更与审计事件以行式 JSON 追加到 `events.jsonl`；**绝不**修改或删除已有行
 * （审计剔除凭据在写入侧保证，见 write-guard/audit.ts）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/persistence/events
 */
import { type FsLike } from './fs-like.js';
/** 可序列化事件（任意对象）。 */
export type EventRecord = Record<string, unknown> & {
    ts: string;
};
/**
 * 行式事件日志。
 */
export declare class EventLog {
    private readonly filePath;
    private readonly fs;
    constructor(baseDir: string, fileName?: string, fs?: FsLike);
    /**
     * 追加一条事件（自动打 ts）。
     * @param event - 事件对象（不含 ts 时自动补）。
     */
    append(event: Record<string, unknown>): void;
    /**
     * 重放全部事件（按写入顺序）。
     *
     * `skipCorrupt` 只给**判重账本**用（`AuditLog.replayForDedupe`）：append-only 日志
     * 可能被并发进程交错写、被外部工具截断，或在崩溃时留下半行；这类坏行会让
     * `JSON.parse` 抛 `SyntaxError`，而门禁 3 依赖重放幂等键——一行坏行会让**此后
     * 所有 TFS 写操作**带着未处理异常失败，且没有可恢复路径。诊断类调用
     * （`AuditArchive.inspect` / `archive`）必须继续看到损坏，所以默认是严格模式：
     * 坏行抛错，由调用方转成 `ok:false + 可读原因`。
     *
     * @param opts - `skipCorrupt: true` 时跳过无法解析的行而不抛错。
     * @returns 事件数组（保持其余事件的写入顺序）。
     */
    replay(opts?: {
        skipCorrupt?: boolean;
    }): EventRecord[];
    /** 文件路径（测试/诊断用）。 */
    get path(): string;
}
//# sourceMappingURL=events.d.ts.map
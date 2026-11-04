/**
 * 文件系统的可注入抽象（依赖反转，Principle VII：可测性）。
 *
 * 持久化模块（JsonStore / EventLog）只依赖此最小接口，生产默认用真实
 * `node:fs`，测试可注入内存实现，从而：
 * - 不触碰被杀软实时扫描的真实磁盘（避免 rmSync 等清理动作被锁超时）；
 * - 用例确定性、秒级、可并行。
 *
 * @module dsh-tfs-requirment/persistence/fs-like
 */
/**
 * 持久化模块所需的文件系统最小能力集合。
 *
 * `readdirSync` 是 T063（审计滚动归档需列出既有归档文件）引入的；
 * `chmodSync` 为**可选**能力：真实 `node:fs` 提供，用于把含凭据的环境文件收紧为 0600
 * （内存实现无权限概念，故可选而非必需——调用方必须容忍它缺失）。
 */
export interface FsLike {
    existsSync(path: string): boolean;
    mkdirSync(path: string, options?: {
        recursive?: boolean;
    }): void;
    readFileSync(path: string, encoding: 'utf8'): string;
    writeFileSync(path: string, data: string, encoding?: 'utf8'): void;
    renameSync(oldPath: string, newPath: string): void;
    appendFileSync(path: string, data: string, encoding?: 'utf8'): void;
    /** 目录直接子项名（不递归）；目录不存在返回空数组（不抛错，便于"首次运行"路径）。 */
    readdirSync(path: string): string[];
    /** 可选：设置权限位（含凭据文件收紧用）。缺失时调用方自行降级。 */
    chmodSync?(path: string, mode: number): void;
    /**
     * 可选：取路径状态（用于"目录是否存在"这类校验）。
     * 返回 `undefined` 表示路径不存在；缺失该能力时调用方应**跳过**存在性校验而非判失败。
     */
    statSync?(path: string): {
        isDirectory?(): boolean;
    } | undefined;
}
/** 生产默认实现：直接转发到 `node:fs`。 */
export declare const realFs: FsLike;
//# sourceMappingURL=fs-like.d.ts.map
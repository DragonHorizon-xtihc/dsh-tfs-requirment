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
import { appendFileSync, chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync, } from 'node:fs';
/** 生产默认实现：直接转发到 `node:fs`。 */
export const realFs = {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
    renameSync,
    appendFileSync,
    readdirSync,
    chmodSync,
    statSync: path => {
        try {
            return statSync(path);
        }
        catch {
            return undefined;
        }
    },
};
//# sourceMappingURL=fs-like.js.map
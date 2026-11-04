/**
 * 单文件 JSON 主数据存储（Principle VI：JSON 为权威）。
 *
 * - 单 `board.json`（collection 命名空间在 BoardState 内部，S-02，不按集合分文件）；
 * - 原子写（tmp + rename），避免半写；
 * - 解析失败**保留原文件、抛错**，不静默重建（FR-020 / T062）；
 * - 可选 version 乐观锁（落盘前后版本校验，崩溃保留 S-09）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/persistence/json-store
 */
import { dirname, join } from 'node:path';
import { realFs } from './fs-like.js';
/** 解析失败错误（原文件保留）。 */
export class JsonStoreParseError extends Error {
    filePath;
    constructor(filePath, cause) {
        super(`JSON 解析失败，原文件已保留：${filePath}`);
        this.filePath = filePath;
        this.name = 'JsonStoreParseError';
        if (cause !== undefined)
            this.cause = cause;
    }
}
/** 版本冲突错误（乐观锁）。 */
export class JsonStoreVersionConflict extends Error {
    expected;
    actual;
    constructor(expected, actual) {
        super(`版本冲突：期望 ${expected} 实得 ${actual}`);
        this.expected = expected;
        this.actual = actual;
        this.name = 'JsonStoreVersionConflict';
    }
}
/**
 * 通用单文件 JSON 存储。
 * @typeParam T - 存储的数据类型（应为可序列化对象）。
 */
export class JsonStore {
    filePath;
    fs;
    constructor(opts) {
        this.filePath = join(opts.baseDir, opts.fileName ?? 'board.json');
        this.fs = opts.fs ?? realFs;
    }
    /** 读取；不存在返回 null；解析失败抛 JsonStoreParseError（原文件保留）。 */
    read() {
        if (!this.fs.existsSync(this.filePath))
            return null;
        let raw;
        try {
            raw = this.fs.readFileSync(this.filePath, 'utf8');
        }
        catch (e) {
            throw new JsonStoreParseError(this.filePath, e);
        }
        try {
            return JSON.parse(raw);
        }
        catch (e) {
            // 关键：保留原文件，不重建（FR-020）。
            throw new JsonStoreParseError(this.filePath, e);
        }
    }
    /**
     * 原子写入。先写 tmp 再 rename。
     * @param data - 数据。
     */
    write(data) {
        this.fs.mkdirSync(dirname(this.filePath), { recursive: true });
        const tmp = `${this.filePath}.tmp`;
        this.fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
        this.fs.renameSync(tmp, this.filePath);
    }
    /**
     * 带版本乐观锁的写入：期望版本须匹配数据中的 `version` 字段。
     * @param data - 含 `version` 字段的数据。
     * @param expectedVersion - 期望版本。
     */
    writeIfVersion(data, expectedVersion) {
        if (data.version !== expectedVersion) {
            throw new JsonStoreVersionConflict(expectedVersion, data.version);
        }
        this.write(data);
    }
    /** 文件路径（测试/诊断用）。 */
    get path() {
        return this.filePath;
    }
}
//# sourceMappingURL=json-store.js.map
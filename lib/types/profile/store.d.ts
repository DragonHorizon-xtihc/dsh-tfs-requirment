/**
 * PAT profile 隔离存储（Principle III / FR-002 / FR-031 / S-12）。
 *
 * - 多 profile（url + pat）以独立记录存储，内存/磁盘隔离；
 * - 落插件私有目录（gitignored），绝不进 `.env`、不进日志、不进 board.json；
 * - `list()` / `get()` **绝不回显 PAT**；仅 `getCredential()` 在即将注入 MCP 时返回明文；
 * - `delete()` 先覆写随机字节（彻底擦除 S-12）再移除记录。
 *
 * 本模块不依赖任何宿主 API，纯逻辑可单测（基建待 T011 adapter 接入时再调 `getCredential`）。
 *
 * @module dsh-tfs-requirment/profile/store
 */
import { type FsLike } from '../persistence/fs-like.js';
/** 单个 TFS profile（含明文 pat，仅写入/凭证读取时持有）。 */
export interface TfsProfile {
    /** 稳定 ID。 */
    id: string;
    /** 展示名。 */
    name: string;
    /** 服务地址（不含集合，集合单独配）。 */
    url: string;
    /** 默认集合（如 WN_HIS）。 */
    collection: string;
    /** 个人访问令牌（明文，仅内部持有，对外不回显）。 */
    pat: string;
}
/** 对外安全的 profile 摘要（不含 pat）。 */
export type ProfileSummary = Omit<TfsProfile, 'pat'>;
/** profile 存储错误。 */
export declare class ProfileStoreError extends Error {
    constructor(message: string);
}
/**
 * profile 存储（落 `profiles.json`）。
 */
export declare class ProfileStore {
    private readonly fs;
    private readonly filePath;
    constructor(baseDir: string, fs?: FsLike);
    private readAll;
    private writeAll;
    /** 列出所有 profile 摘要（**不含 pat**，绝不回显）。 */
    list(): ProfileSummary[];
    /** 取单个 profile 摘要（**不含 pat**）；不存在返回 undefined。 */
    get(id: string): ProfileSummary | undefined;
    /**
     * 保存/更新 profile（含 pat）。
     * @param profile - 含明文 pat 的 profile。
     */
    save(profile: TfsProfile): void;
    /**
     * 取凭证明文（仅用于注入 MCP，**不用于展示**）。
     * @param id - profile ID。
     * @returns pat 明文；不存在返回 undefined。
     */
    getCredential(id: string): string | undefined;
    /**
     * 删除 profile：先彻底擦除文件（随机字节覆写），再落盘移除记录（S-12）。
     * @param id - profile ID。
     * @returns 是否实际删除了某条。
     */
    delete(id: string): boolean;
}
//# sourceMappingURL=store.d.ts.map
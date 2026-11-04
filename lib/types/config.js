/**
 * 插件配置：全部部署间会变化的取值都在这里，且都可在 `cordis.patch.yml` 覆盖。
 *
 * 依据宪法 VI，禁止把这类取值写成模块级常量再留一个"测试钩子"。
 *
 * @module dsh-tfs-requirment/config
 */
import z from '@deepseek-ai/schemastery';
/**
 * schemastery 配置 schema。字段注释即面向使用者的说明，会出现在配置报错里。
 * 注意：schemastery 的 `.number()` 不保证 `.min()` 语义（与 zod 不同），因此数值下限
 * 由 `validateConfig` 在运行期强制，并由单元测试 T032 覆盖，而非依赖 schema 链。
 */
export const Config = z.object({
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
    runTimeoutMinutes: z.number().default(120),
    runTimeoutGraceMinutes: z.number().default(30),
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
});
/**
 * 运行期配置校验（供设置页保存前与单元测试 T032 调用）。
 *
 * 返回非空数组表示存在违规；宪法与 FR 要求：轮询间隔与并发上限 ≥ 1、默认标签非空、
 * 默认集合必须属于已配置清单。
 *
 * @param config - 已解析的插件配置。
 * @returns 违规项列表；空数组表示通过。
 */
export function validateConfig(config) {
    const errors = [];
    if (!(config.pollIntervalMinutes >= 1)) {
        errors.push({ field: 'pollIntervalMinutes', message: '必须 ≥ 1（FR-024/S-14）' });
    }
    if (!(config.maxConcurrentRequirements >= 1)) {
        errors.push({ field: 'maxConcurrentRequirements', message: '必须 ≥ 1（FR-029）' });
    }
    if (!config.defaultLabel || config.defaultLabel.trim().length === 0) {
        errors.push({ field: 'defaultLabel', message: '不可为空（FR-013）' });
    }
    if (config.collections.length === 0 || !config.collections.includes(config.defaultCollection)) {
        errors.push({ field: 'defaultCollection', message: '必须属于 collections 清单（FR-025）' });
    }
    if (!(config.queryOptionsConcurrency >= 1)) {
        errors.push({ field: 'queryOptionsConcurrency', message: '必须 ≥ 1（元数据采集并发上限）' });
    }
    // 问题 1：执行预算只接受非负整数（0 对 maxDepth 表示不限制、对 maxTokens/runTimeout 表示不启用）。
    // 注意 0 在各处含义不同：maxDepth/maxTokens/runTimeout/staleRunning* 表示"不启用"，
    // 而 summarize*/finalize*/taskSessionSettle* 的 0 会被 Math.max(1, x) 折成"立即失败"
    // （它们没有"不启用"形态，必须给正数），故下面不额外拒绝 0。
    for (const [field, label] of [
        ['defaultMaxDepth', '委派深度上限'],
        ['defaultMaxTokens', '单次输出 token 上限'],
        ['runTimeoutMinutes', '任务运行看门狗（分钟）'],
        ['runTimeoutGraceMinutes', '看门狗到点活性宽限（分钟）'],
        ['summarizeTimeoutSeconds', '编排归纳硬超时（秒）'],
        ['summarizeGraceSeconds', '编排归纳放行宽限（秒）'],
        ['finalizeTimeoutSeconds', '编排最终总结硬超时（秒）'],
        ['finalizeGraceSeconds', '编排最终总结宽限（秒）'],
        ['taskSessionSettleTimeoutMinutes', '复用会话收口观测超时（分钟）'],
        ['staleRunningReapMinutes', '假执行巡检阈值（分钟）'],
        ['staleRunningSweepSeconds', '假执行巡检节奏（秒）'],
    ]) {
        const value = config[field];
        if (!Number.isFinite(value) || value < 0) {
            errors.push({ field, message: `${label}必须是 ≥ 0 的数值` });
        }
    }
    return errors;
}
/** 配置是否全部合规。 */
export function isConfigValid(config) {
    return validateConfig(config).length === 0;
}
//# sourceMappingURL=config.js.map
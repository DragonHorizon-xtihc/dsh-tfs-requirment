/**
 * 写门禁编排（四道门禁：dryrun → 确认 → 幂等 → 审计，FR-050 / SC-008）。
 *
 * 组合 dryrun / idempotency / audit 三个纯模块：
 * 1. 生成 dry-run 预览（S-05，纯函数，必过）；
 * 2. 要求用户确认（confirmed）；
 * 3. 幂等：从审计重放取已应用幂等键集合，重复即拒（S-08）；
 * 4. 审计落盘：剔除凭据、idempotencyKey 与写调用一一对齐（SC-008）。
 *
 * **第 4 道门禁单独提供 {@link WriteGuard.record}**，由调用方在写调用**成功之后**调用。
 * 门禁 3 的判重依据就是审计里的幂等键，若在写入之前记账，一次超时 / 412 / 5xx 也会把键
 * 标成"已应用"，重试随即被门禁 3 拒掉——一次**从未发生**的写入会被报成"幂等跳过"。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/write-guard
 */
import { buildDryRunPreview } from './dryrun.js';
/**
 * 写门禁编排器。
 */
export class WriteGuard {
    audit;
    constructor(audit) {
        this.audit = audit;
    }
    /**
     * 生成 dry-run 预览（门禁1，纯函数）。
     * @param op - 回写操作。
     */
    preview(op) {
        return buildDryRunPreview({
            targetWorkItem: op.targetWorkItem,
            opType: op.opType,
            idempotencyKey: op.idempotencyKey,
            before: op.before,
            after: op.after,
        });
    }
    /**
     * 前三道门禁：dryrun → 确认 → 幂等。**不落审计**（门禁 4 见 {@link WriteGuard.record}）。
     *
     * 审计必须由调用方在写调用成功之后补记：门禁 3 的判重集合来自审计，若这里就记账，
     * 一次失败的写入也会把幂等键标成已应用，重试被门禁 3 拒成"幂等跳过"。
     *
     * @param op - 回写操作。
     * @param ctx - 门禁上下文（用户确认）。
     * @returns 通过则 ok=true；否则 ok=false 并给原因。preview 无论成败都返回。
     */
    gate(op, ctx) {
        // 门禁1：dry-run 预览（始终可生成，纯函数）
        const preview = this.preview(op);
        // 门禁2：用户确认
        if (!ctx.confirmed) {
            return { ok: false, reason: '未确认回写（门禁2：需用户确认）', code: 'NOT_CONFIRMED', preview };
        }
        // 门禁3：幂等——从审计重放取已应用键集合，重复即拒（S-08）
        // 用 `replayForDedupe`（跳过坏行）：日志里一行半行不应让此后所有写永久失败。
        //
        // 重放必须**按写入顺序**处理 apply 与 release：带 `releases` 的补偿事件把该键从
        // 已应用集合里摘掉（「还原到需求池」摘掉标签后，同一需求才能重新领），其后若再有
        // 同键的 apply 会把它加回来。先收集成一个 Set 会丢掉这个顺序语义。
        const applied = new Set();
        for (const event of this.audit.replayForDedupe()) {
            if (event.releases)
                applied.delete(event.releases);
            if (event.idempotencyKey)
                applied.add(event.idempotencyKey);
        }
        if (op.idempotencyKey && applied.has(op.idempotencyKey)) {
            return {
                ok: false,
                reason: '幂等键已应用，跳过重复回写（门禁3）',
                code: 'IDEMPOTENT_SKIP',
                preview,
            };
        }
        return { ok: true, preview };
    }
    /**
     * 门禁4：审计落盘（剔除凭据，idempotencyKey 对齐，SC-008）。
     *
     * 只在写调用**成功之后**调用——此时幂等键才代表"确实写进去了"。
     *
     * @param op - 已成功执行的回写操作。
     */
    record(op) {
        this.audit.append({
            kind: 'write',
            opType: op.opType,
            idempotencyKey: op.idempotencyKey,
            detail: { targetWorkItem: op.targetWorkItem, before: op.before, after: op.after },
            confirmed: true,
        });
    }
    /**
     * 门禁 4 的补偿动作：作废一个已记录的幂等键（append-only，只能追加不能删改）。
     *
     * 用于标签类幂等键——它编码的是"工作项当前带这个标签"这一状态，而「还原到需求池」
     * 会把标签摘掉。状态没了，账本里的 apply 也必须跟着作废，否则同一需求**再也无法
     * 重新领取**（门禁 3 会判成重复）。
     *
     * @param idempotencyKey - 待作废的键（用 `labelIdempotencyKey` 生成）。
     * @param detail - 审计详情（凭据在落盘前剔除）。
     */
    release(idempotencyKey, detail = {}) {
        if (!idempotencyKey)
            return;
        this.audit.append({ kind: 'tag', releases: idempotencyKey, detail });
    }
}
//# sourceMappingURL=index.js.map
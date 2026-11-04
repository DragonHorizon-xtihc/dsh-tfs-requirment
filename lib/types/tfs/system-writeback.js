/**
 * 需求完成自动回写的「系统写端口」（问题 4）。
 *
 * ## 为什么单独成文件
 * `tfs/adapter.ts` 体量大（2700+ 行），本文件把"需求完成后自动回写"所需的**确定性读写**收口为
 * 一个最小端口 {@link RequirementWriteBackPort}，由 `requirement-finalizer.ts` 依赖：
 * - 单测可用内存桩驱动 finalizer，完全不触真实 TFS；
 * - 生产实现 {@link createSystemWriteBack} 复用 `TfsAdapter` 的**公开方法**，不新开第二条写链路。
 *
 * ## 与"模型写"门禁的关系
 * `TfsAdapter.addComment / wrappedWrite` 内部仍过 WriteGuard 四道门禁。自动回写是**用户在配置中
 * 开启的、触发条件与目标字段都由代码固定**的系统动作，故以 `confirmed=true` 调用（语义等同
 * "已获授权的系统动作"，与领取需求自动打 `dsh` 标签走 `addTags(..., true)` 同一先例）；
 * 幂等性由 finalizer 的报告账本 + 门禁3 双重保证。门禁3 判重拒绝时本端口归一为 `skipped`
 * （而非错误），其余门禁 / REST 失败抛错，由 finalizer 记为逐项 `error`，不阻断其它项。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/tfs/system-writeback
 */
import { identityStr } from './adapter.js';
/**
 * 把 WriteGuard / REST 的写结果归一为 ok / skipped；真正失败抛错（交由 finalizer 记 error 项）。
 *
 * ⚠️ 判据是**结构化**的 `code === 'IDEMPOTENT_SKIP'`（2026-10-05 修复）。
 * 旧实现用 `REPEAT_RE = /幂等|重复回写|跳过重复|idempoten|already applied|duplicate/i`
 * 去匹配**整条失败原因串**，而适配层把底层 REST 错误包进同一个字段
 * （`TFS REST 调用失败（profile=…）：<原始消息>`）。于是 TFS 只要在错误消息里出现
 * "重复"/"duplicate"/"already applied"（例如字段名、重复提交提示），一次**真实失败**
 * 就会被归一成 `skipped` —— 回写失败被静默吞掉、且不阻断后续项，报告里还显示"已跳过"。
 *
 * 现在只有门禁 3 **主动**跳过时才判 skipped；其余（含门禁 2 未确认）一律抛错。
 *
 * @param outcome - 适配层写结果。
 * @returns 归一后的状态。
 */
function normalizeWrite(outcome) {
    if (outcome?.ok)
        return { status: 'ok' };
    if (outcome?.code === 'IDEMPOTENT_SKIP') {
        return { status: 'skipped', reason: outcome.reason };
    }
    throw new Error(outcome?.reason ?? '写门禁拒绝（未知原因）');
}
/** 从工作项关联 URL 提取目标 id（取不到返回 NaN）。 */
function idFromWorkItemUrl(u) {
    const m = /workItems\/(\d+)/i.exec(u) ?? /(\d+)(?:\?[^/]*)?$/.exec(u);
    return m ? Number(m[1]) : NaN;
}
/** 从 TFS 工作项行（`{id, fields}`）吸收一条任务（仅任务类型）。 */
function absorbTaskRow(map, row, via) {
    const r = (row ?? {});
    const f = (r['fields'] ?? {});
    const rid = Number(r['id'] ?? f['System.Id']);
    if (!Number.isInteger(rid))
        return;
    const type = String(f['System.WorkItemType'] ?? '');
    if (!/任务|Task/i.test(type))
        return;
    map.set(rid, {
        id: rid,
        title: String(f['System.Title'] ?? ''),
        state: String(f['System.State'] ?? ''),
        via,
    });
}
/** 生产实现：把端口方法映射到 TfsAdapter 的公开读写方法。 */
export function createSystemWriteBack(adapter) {
    const collArg = (collection) => (collection ? { collection } : {});
    return {
        async getFields(id, collection) {
            const row = (await adapter.getWorkItem(id, collArg(collection)));
            const fields = (row?.['fields'] ?? {});
            const out = {};
            for (const [k, v] of Object.entries(fields)) {
                // ⚠️ **不能**直接 `String(v)`（2026-10-05 修复）：REST 下 IdentityRef 字段
                // （`System.AssignedTo` / `System.ChangedBy` …）是对象
                // `{displayName, uniqueName, properties:{Account:{$value}}}`，
                // `String(对象)` 得到字面量 `"[object Object]"`。回写前拿它判断
                // 「评审/自测字段是否已有值」会**永远判成未回写** ⇒ 重复写评论与附件。
                // 复用适配层同一份 IdentityRef 解析（单一事实源）。
                out[k] = v === null || v === undefined ? '' : identityStr(v);
            }
            return out;
        },
        async updateFields(id, collection, fields) {
            if (Object.keys(fields).length === 0)
                return { status: 'skipped', reason: '无待更新字段' };
            return normalizeWrite(await adapter.wrappedWrite('tfs_update_workitem', { id: Number(id), fields, ...collArg(collection) }, true));
        },
        async addComment(id, collection, comment) {
            return normalizeWrite(await adapter.addComment(id, collection, comment, true));
        },
        async uploadAttachment(id, collection, filePath, fileName) {
            const outcome = await adapter.wrappedWrite('tfs_upload_attachment', {
                id: Number(id),
                path: filePath,
                ...(fileName ? { fileName } : {}),
                ...collArg(collection),
            }, true);
            const r = normalizeWrite(outcome);
            // ⚠️ 附件名必须在**调用方没传 fileName 时也能给出**（2026-10-05 修复）：
            // 端口契约写的是"成功带回附件名"，而旧实现只在 `fileName` 为真时才填 `name`，
            // 于是"按路径上传"这一路（finalizer 正是这么调的）永远拿不到名字，
            // 回写报告里该项缺标识、用户无法判断上传的是哪个产物。
            // 取值优先级：显式 fileName → 适配层返回值 → 路径 basename（两种分隔符都认）。
            if (r.status !== 'ok')
                return r;
            const fromAdapter = outcome.result && typeof outcome.result === 'object'
                ? outcome.result['name']
                : undefined;
            const name = fileName ||
                (typeof fromAdapter === 'string' && fromAdapter.length > 0 ? fromAdapter : undefined) ||
                filePath.split(/[\\/]/).filter(Boolean).pop() ||
                filePath;
            return name ? { ...r, name } : r;
        },
        async resolveTask(id, collection, resolvedState, finishDateISO) {
            return normalizeWrite(await adapter.wrappedWrite('tfs_update_workitem', {
                id: Number(id),
                fields: {
                    'System.State': resolvedState,
                    'Microsoft.VSTS.Scheduling.FinishDate': finishDateISO,
                },
                ...collArg(collection),
            }, true));
        },
        async findLinkedTasks(id, collection) {
            const numId = Number(id);
            const map = new Map();
            // 路 1：relations（子级 Hierarchy-Forward / 相关 Related）。补 WIQL Parent 查不到的"相关任务"。
            try {
                const row = (await adapter.getWorkItem(numId, collArg(collection)));
                const rels = Array.isArray(row['relations'])
                    ? row['relations']
                    : [];
                for (const rel of rels) {
                    const relType = String(rel['rel'] ?? '');
                    if (!/Hierarchy-Forward|Related/.test(relType))
                        continue;
                    const cid = idFromWorkItemUrl(String(rel['url'] ?? ''));
                    if (!Number.isInteger(cid) || map.has(cid))
                        continue;
                    try {
                        absorbTaskRow(map, await adapter.getWorkItem(cid, collArg(collection)), 'relation');
                    }
                    catch {
                        // 单条关联任务读取失败：跳过，不影响其余。
                    }
                }
            }
            catch {
                // relations 路整体失败：降级为仅 WIQL 路。
            }
            // 路 2：WIQL 父链接（tfs_query_wiql 经两段式返回全字段行数组）。
            try {
                // 工作项类型名随项目过程模板的语言而变：英文模板是 `Task`，中文模板（本插件
                // 对接的 WN_HIS 就是）是 `任务`。这里写死英文名会让整条 WIQL 在中文模板上
                // 匹配不到任何子任务，于是"归位子任务 + 写 FinishDate"这一步静默失效。
                // 两种写法都放进 IN，与上面 `absorbTaskRow` 的行过滤（`/任务|Task/i`）保持一致。
                const wiql = `SELECT [System.Id] FROM WorkItems WHERE [System.Parent] = ${numId} ` +
                    `AND [System.WorkItemType] IN ('Task', '任务')`;
                const rows = (await adapter.queryWiql(wiql, collArg(collection)));
                if (Array.isArray(rows)) {
                    for (const r of rows)
                        absorbTaskRow(map, r, 'wiql');
                }
            }
            catch {
                // WIQL 路失败：至少保留 relations 路结果。
            }
            return [...map.values()];
        },
    };
}
//# sourceMappingURL=system-writeback.js.map
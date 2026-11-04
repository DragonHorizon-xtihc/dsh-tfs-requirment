/**
 * 需求池的共享纯逻辑（宿主半与客户端半共享，无 DOM 依赖）。
 *
 * ## 为什么这些函数必须在这里
 *
 * 客户端半**没有 React 测试库**（`tests/` 下 32 个用例全为 `.ts`），写在组件里的逻辑等于不可测。
 * 与 `src/shared/poll.ts`（增量合并）同一纪律：组件只做渲染与事件，判定与计算下沉共享层。
 *
 * 本模块承载三条修复的可测部分：
 *   - **US1**：可选项缓存的"能否入缓存"判据（全空结果不得锁死缓存）；
 *   - **US2**：已入池去重键集合（行内"已入池"标记的数据源）；
 *   - **US3**：目标 → 执行配置表单的自动填充。
 *
 * @module dsh-tfs-requirment/shared/pool
 */
import { sliceTextByCodePoint } from './text.js';
/**
 * 需求去重键 `id@collection`（S-01）。
 *
 * 与宿主半 `requirementDedupKey`（`src/tfs/types.ts:61`）**同构但独立**：客户端半编译范围不含
 * `src/tfs`（会勾到 `node:fs`），故不能 import 它。两处格式必须一致，否则"已入池"判定会
 * 与本地池的实际键对不上 —— 这是本模块最容易漂移的地方，改一处必须改另一处。
 *
 * @param id - 工作项 ID。
 * @param collection - 集合名。
 * @returns 去重键。
 */
export function requirementKey(id, collection) {
    return `${id}@${collection}`;
}
/** 从需求摘要取去重键（列表渲染时的行键兼已入池判定键）。 */
export function summaryKey(r) {
    return requirementKey(r.id, r.collection);
}
/**
 * 已领取需求的去重键集合（US2 行内标记的数据源）。
 *
 * 数据源是本地池快照 `BoardSnapshotView.requirements`——它已经在客户端手上
 * （`Workbench` 每次 `reloadBoard` 都会取），因此判定"某行是否已入池"**不需要新增任何接口**。
 *
 * @param requirements - 本地池中的已领取需求。
 * @returns 去重键数组（去重、顺序稳定 = 输入顺序）。
 */
export function claimedKeysOf(requirements) {
    const out = new Set();
    for (const r of requirements ?? [])
        out.add(summaryKey(r));
    return [...out];
}
/**
 * 可选项结果是否**值得**进缓存（US1）。
 *
 * ## 为什么不能无条件缓存
 *
 * `TfsAdapter.getQueryOptions` 逐项 try/catch：任何一项失败只把原因收进 `reason`，
 * 其余项仍可能为空。若把"四项全空"当成有效缓存写进去，一次网络抖动就会把空下拉
 * **锁死到服务重启为止** —— 比现在"慢"更糟，而且是静默的。
 *
 * 判据取「项目清单或类型清单任一非空」而非"四项都非空"：状态/指派人采集失败不该阻止
 * 复用已成功的项目与类型（降级部分可见即可用，见 FR-005）。
 *
 * @param options - 采集结果。
 * @returns true = 可写入缓存。
 */
export function shouldCacheQueryOptions(options) {
    if (!options)
        return false;
    const projects = options.projects?.length ?? 0;
    const types = options.types?.length ?? 0;
    return projects > 0 || types > 0;
}
/** 目标正文的填充上限（防止超长正文撑爆面板，同时不把 MB 级内容塞进表单）。 */
export const TARGET_TEXT_LIMIT = 4000;
/** 无正文时的明确说明（空框会让用户以为功能坏了）。 */
export const EMPTY_DESCRIPTION_HINT = '（该需求在 TFS 上无正文：详细信息/需求分析/数据结构/需求配置均为空）';
/**
 * 需求四段正文（问题 11）。
 *
 * 字段引用名为 2026-09-20 探针对「需求」工作项类型实测所得：
 * 详细信息=`System.Description`、需求分析=`Winning.Demand.Analysis`、
 * 数据结构=`Winning.Data.Design`、需求配置=`Winning.Demand.Config`。
 * 顺序即目标填充中的拼接顺序（详细信息优先，超长时从末段开始舍弃）。
 */
export const TARGET_SECTIONS = [
    { heading: '详细信息', key: 'description' },
    { heading: '需求分析', key: 'analysis' },
    { heading: '数据结构', key: 'dataStructure' },
    { heading: '需求配置', key: 'config' },
];
/**
 * 取出目标需求的非空正文分段（已 trim，空段跳过）。
 * @param target - 目标需求。
 * @returns 非空分段数组。
 */
export function targetSections(target) {
    if (!target)
        return [];
    const out = [];
    for (const s of TARGET_SECTIONS) {
        const v = target[s.key];
        if (typeof v === 'string' && v.trim().length > 0)
            out.push({ heading: s.heading, text: v.trim() });
    }
    return out;
}
/**
 * 截断标记（唯一一次）。
 *
 * 宽度参与 {@link composeTargetDescription} 的预算计算，因此必须在这里集中定义，
 * 不能在调用点内联——内联的那个副本一旦漏算就会让结果超出 `maxChars`。
 */
const TRUNCATION_MARKER = '…（已截断）';
/**
 * 把四段正文拼成带【标题】的整体文本，并把总长度限制在 `maxChars` 内。
 *
 * 截断策略（保证截断标记最多出现一次）：按详细信息→需求分析→数据结构→需求配置的顺序逐段放入，
 * 剩余预算放不下完整下一段时，截断该段并追加一次截断标记，其后各段舍弃。
 *
 * 被舍弃的段**一定会留痕**：即使预算小到连标记都放不下，也会写出"【标题】…（已截断）"，
 * 宁可略微超出 `maxChars` 几个字符，也不让截断在界面上完全不可见。
 *
 * @param target - 目标需求。
 * @param maxChars - 总字符上限（>0）。
 * @returns 拼接文本；四段全空时返回空串。
 */
export function composeTargetDescription(target, maxChars = TARGET_TEXT_LIMIT) {
    const sections = targetSections(target);
    if (sections.length === 0)
        return '';
    const parts = [];
    let used = 0;
    for (let i = 0; i < sections.length; i += 1) {
        const section = sections[i];
        if (!section)
            continue;
        const { heading, text } = section;
        const header = `【${heading}】\n`;
        const isLast = i === sections.length - 1;
        const separator = isLast ? '' : '\n\n';
        if (used + header.length + text.length + separator.length <= maxChars) {
            parts.push(`${header}${text}`);
            used += header.length + text.length + separator.length;
            continue;
        }
        // 剩余预算放不下整段：截断本段一次，后续段舍弃（截断标记只出现这一次）。
        //
        // 标记本身也占预算：不算进去的话，非末段的实际产出是
        // `已用 + 标题 + 正文 + 分隔 + 标记`，比 maxChars 多出一个分隔符 + 标记宽度。
        const budget = maxChars - used - header.length - separator.length - TRUNCATION_MARKER.length;
        if (budget > 0) {
            parts.push(`${header}${sliceTextByCodePoint(text, budget)}${TRUNCATION_MARKER}`);
        }
        else {
            // 连标记都挤不下时仍要如实标注"后面还有内容被舍弃"。原来这里直接 return，
            // 整段无声消失、界面上没有任何痕迹，用户会以为那就是全部需求正文。
            // 此处允许略微超出 maxChars：宁可多几个字符，也不能让截断变得不可见。
            parts.push(`${header}${TRUNCATION_MARKER}`);
        }
        return parts.join('\n\n');
    }
    return parts.join('\n\n');
}
/**
 * 按当前执行目标生成表单填充值（US3，问题 11 扩展为四段）。
 *
 * **只在"目标变更"这一离散时机调用**，不在每次渲染时调用——否则会覆盖用户已手工编辑的内容
 * （`ExecutionPanel` 里已有同类教训：异步目录到达后写回 state 会顶掉用户选择）。
 *
 * @param target - 当前目标（未选目标时为 undefined）。
 * @returns 填充值；未选目标时返回 undefined（表单保持空白，不报错、不乱填）。
 */
export function buildTargetFill(target) {
    if (!target)
        return undefined;
    const title = (target.title ?? '').trim();
    const body = composeTargetDescription(target, TARGET_TEXT_LIMIT);
    const description = body.length > 0 ? body : EMPTY_DESCRIPTION_HINT;
    // `execPrompt` 是**真正发给模型**的字段（`description` 只用于面板展示），因此它必须与
    // `description` 取同一份正文：先前它把已拼好的 body 再整体截一次，于是"标题 + 提示前缀"
    // 先吃掉了预算，四段正文的尾部（需求配置/数据结构）在模型侧被丢掉了，而用户看到的
    // `description` 里还在——同一份内容，界面有的段落模型看不到。这里按前缀实际长度扣预算，
    // 让两者的段落取舍完全一致。
    const prefix = `请完成以下需求：\n${title}`;
    const execPrompt = body.length > 0
        ? `${prefix}\n\n${composeTargetDescription(target, Math.max(1, TARGET_TEXT_LIMIT - prefix.length - 2))}`
        : prefix;
    // 工作目录与需求级提示词随目标带出（2026-11-03 问题 3/1）：
    // 需求上没有时落空串（= 不覆盖表单已有的值语义由调用方决定，见 ExecutionPanel 的填充 effect）。
    const workspace = (target.workspace ?? '').trim();
    const reqPrompt = (target.prompt ?? '').trim();
    return { title, description, execPrompt, workspace, reqPrompt };
}
/**
 * 判断一次「选为目标」事件是否应把目标正文填入执行表单（spec 008 US4）。
 *
 * 旧实现用"目标键"去重（同一需求只填一次），导致同一需求第二次点「选为目标」
 * （典型路径：第一次填入 → 发起执行后表单被清空 → 再点同一目标想恢复正文）被静默跳过。
 * 现改为以**显式选择序号 nonce** 为信号：
 *
 * - 必须有目标（`hasTarget`）；
 * - nonce 为正（0 = 尚未发生过任何显式选择，面板初始挂载不填）；
 * - nonce 与上次已处理序号不同（每次点击 +1；后台轮询刷新不产生新序号，不会顶掉手工编辑）。
 *
 * @param nonce - 本次渲染携带的选择序号（`ExecutionPanelData.targetFillNonce`）。
 * @param lastFilledNonce - 本面板实例已处理过的序号（useRef 持有）。
 * @param hasTarget - 当前是否存在目标需求。
 * @returns 是否应执行填充。
 */
export function shouldFillTarget(nonce, lastFilledNonce, hasTarget) {
    return hasTarget && nonce > 0 && nonce !== lastFilledNonce;
}
//# sourceMappingURL=pool.js.map
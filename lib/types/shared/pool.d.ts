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
 * @module @deepseek-ai/dsh-tfs-requirment/shared/pool
 */
import type { RequirementQueryOptions, RequirementSummary } from './contracts.js';
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
export declare function requirementKey(id: number | string, collection: string): string;
/** 从需求摘要取去重键（列表渲染时的行键兼已入池判定键）。 */
export declare function summaryKey(r: Pick<RequirementSummary, 'id' | 'collection'>): string;
/**
 * 已领取需求的去重键集合（US2 行内标记的数据源）。
 *
 * 数据源是本地池快照 `BoardSnapshotView.requirements`——它已经在客户端手上
 * （`Workbench` 每次 `reloadBoard` 都会取），因此判定"某行是否已入池"**不需要新增任何接口**。
 *
 * @param requirements - 本地池中的已领取需求。
 * @returns 去重键数组（去重、顺序稳定 = 输入顺序）。
 */
export declare function claimedKeysOf(requirements: Array<Pick<RequirementSummary, 'id' | 'collection'>>): string[];
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
export declare function shouldCacheQueryOptions(options: RequirementQueryOptions | null | undefined): boolean;
/** 目标正文的填充上限（防止超长正文撑爆面板，同时不把 MB 级内容塞进表单）。 */
export declare const TARGET_TEXT_LIMIT = 4000;
/** 无正文时的明确说明（空框会让用户以为功能坏了）。 */
export declare const EMPTY_DESCRIPTION_HINT = "\uFF08\u8BE5\u9700\u6C42\u5728 TFS \u4E0A\u65E0\u6B63\u6587\uFF1A\u8BE6\u7EC6\u4FE1\u606F/\u9700\u6C42\u5206\u6790/\u6570\u636E\u7ED3\u6784/\u9700\u6C42\u914D\u7F6E\u5747\u4E3A\u7A7A\uFF09";
/** 目标 → 表单的填充结果。 */
export interface TargetFill {
    title: string;
    description: string;
    execPrompt: string;
    /**
     * 工作目录（2026-11-03 问题 3）：任务中心配置的目录随「选为目标」带入执行配置。
     * 空串 = 目标上未配置（执行配置保持"跟随任务/需求"语义，不乱填）。
     */
    workspace: string;
    /**
     * 需求级提示词（2026-11-03 问题 1/3）：领取入池或任务中心「编辑」填的提示词，
     * 随「选为目标」带入执行配置独立展示（**不**拼进 execPrompt：宿主派发时会把
     * 需求级提示词自动拼在任务提示词之前，复制进去会发两份）。
     */
    reqPrompt: string;
}
/**
 * 需求四段正文（问题 11）。
 *
 * 字段引用名为 2026-09-20 探针对「需求」工作项类型实测所得：
 * 详细信息=`System.Description`、需求分析=`Winning.Demand.Analysis`、
 * 数据结构=`Winning.Data.Design`、需求配置=`Winning.Demand.Config`。
 * 顺序即目标填充中的拼接顺序（详细信息优先，超长时从末段开始舍弃）。
 */
export declare const TARGET_SECTIONS: ReadonlyArray<{
    heading: string;
    key: keyof RequirementSummary;
}>;
/**
 * 取出目标需求的非空正文分段（已 trim，空段跳过）。
 * @param target - 目标需求。
 * @returns 非空分段数组。
 */
export declare function targetSections(target: RequirementSummary | undefined | null): Array<{
    heading: string;
    text: string;
}>;
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
export declare function composeTargetDescription(target: RequirementSummary | undefined | null, maxChars?: number): string;
/**
 * 按当前执行目标生成表单填充值（US3，问题 11 扩展为四段）。
 *
 * **只在"目标变更"这一离散时机调用**，不在每次渲染时调用——否则会覆盖用户已手工编辑的内容
 * （`ExecutionPanel` 里已有同类教训：异步目录到达后写回 state 会顶掉用户选择）。
 *
 * @param target - 当前目标（未选目标时为 undefined）。
 * @returns 填充值；未选目标时返回 undefined（表单保持空白，不报错、不乱填）。
 */
export declare function buildTargetFill(target: RequirementSummary | undefined | null): TargetFill | undefined;
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
export declare function shouldFillTarget(nonce: number, lastFilledNonce: number, hasTarget: boolean): boolean;
//# sourceMappingURL=pool.d.ts.map
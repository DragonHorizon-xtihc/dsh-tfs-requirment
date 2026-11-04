/**
 * 文本处理纯函数（宿主半与客户端半共享，无 DOM 依赖）。
 *
 * ## 为什么放在 `src/shared`
 *
 * TFS 的工作项正文（`System.Description`）是 **HTML**（TFS 富文本编辑器产出）。把它直接塞进
 * `<textarea>` 或列表单元格，用户看到的会是一整段 `<div>&nbsp;…</div>` 原始标记——这就是
 * 「选为目标」想带出需求内容却带不出可读内容的第一道障碍。
 *
 * 转换是纯字符串逻辑，但必须被两端消费：
 *   - **宿主半**在归一化工作项时就转好（`normalizeWorkItem`），使 `board.json` 与 HTTP 下发
 *     的都已是干净文本，客户端不必自己解析 HTML；
 *   - **客户端半**只负责展示，不引入任何 HTML 解析依赖。
 *
 * 放 `src/shared` 还带来一个硬性收益：客户端半**没有 React 测试库**（`tests/` 全为 `.ts`），
 * 逻辑留在组件里就等于不可测；下沉后可由单测直接覆盖（项目纪律：可测逻辑不留组件内）。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/shared/text
 */
/**
 * 归一化阶段保留的正文上限（字符）。
 *
 * **为什么需要上限**：TFS 的 `System.Description` 没有长度约束，富文本历史项可达几十 KB。
 * 归一化后它会进入两条有界性要求的通道——HTTP 列表响应，以及作为权威状态的 `board.json`
 * （宪法 Principle VI）。不限长会让这两者随正文体积线性膨胀，而列表请求一次可能带回几十条。
 *
 * **为什么取 20000 而不是面板上限 4000**：这里截的是"持久化/传输"，面板填充另有
 * `TARGET_TEXT_LIMIT`（`pool.ts`，4000）。两级取值不同，是为了让截断标记只出现一次——
 * 若此处也截到 4000，面板那一级会把"…（已截断）"再截一遍，用户看到叠了两个标记。
 */
export const MAX_DESCRIPTION_CHARS = 20000;
/** 解不开的实体按原样保留，不做"看起来合理"的编造（宪法 Principle I）。 */
const NAMED_ENTITIES = {
    nbsp: ' ',
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
};
/**
 * HTML → 可读纯文本。
 *
 * 刻意**不引入**任何 HTML 解析库（无新依赖）：TFS 正文是富文本编辑器产出的有限标记集，
 * 用一组确定性替换即可覆盖；引入解析器反而带来体积与不确定行为。
 *
 * 处理顺序（顺序有意义，不可随意调换）：
 *   1. 去掉 `script` / `style` 整段（它们的内容不是"正文"）；
 *   2. 块级/换行标记 → `\n`（`<br>`、`</p>`、`</div>`、`</tr>`、`</h*>`）；
 *   3. `<li>` → `\n- `（**刻意**不在第 2 步处理 `</li>`：开头标记已自带换行，
 *      两处都吐会让列表项之间多出一个空行）；
 *   4. 其余标记一律删除；
 *   5. 解码实体（命名实体 + 十进制/十六进制数字实体）；
 *   6. 折叠空白：行首尾空格清掉、3 个以上连续空行压成 2 个、整体 trim。
 *
 * @param html - 原始 HTML 字符串（非字符串输入按空串处理）。
 * @returns 纯文本。
 */
export function htmlToPlainText(html) {
    if (typeof html !== 'string' || html.length === 0)
        return '';
    let text = html;
    // 1) 丢弃整段 script/style（含内容）。
    text = text.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '');
    // 2) 换行标记 → \n（先于"删全部标签"，否则换行信息丢失）。
    text = text.replace(/<br\s*\/?>/gi, '\n');
    //    `li` 不在此列：`<li>` 的换行由第 3 步给出，这里再补会变成空行。
    text = text.replace(/<\/(p|div|tr|h[1-6]|table|ul|ol|blockquote)\s*>/gi, '\n');
    // 3) 列表项 → `- ` 前缀（自带前导换行）。
    text = text.replace(/<li\b[^>]*>/gi, '\n- ');
    // 3) 其余标签删除。
    text = text.replace(/<[^>]*>/g, '');
    // 4) 实体解码。
    text = text.replace(/&([a-zA-Z]+);/g, (m, name) => NAMED_ENTITIES[name.toLowerCase()] ?? m);
    text = text.replace(/&#(\d+);/g, (_m, dec) => safeCodePoint(Number(dec)));
    text = text.replace(/&#[xX]([0-9a-fA-F]+);/g, (_m, hex) => safeCodePoint(parseInt(hex, 16)));
    // 5) 空白折叠：先按行清理行尾空白，再压连续空行，最后 trim。
    text = text.replace(/\u00a0/g, ' ');
    text = text
        .split('\n')
        .map(line => line.replace(/[ \t]+$/g, '').replace(/^[ \t]+/g, ''))
        .join('\n');
    text = text.replace(/\n{3,}/g, '\n\n');
    return text.trim();
}
/** 数字实体 → 字符；越界或控制字符原样返回片段（不静默吞掉信息）。 */
function safeCodePoint(code) {
    if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff)
        return '';
    if (code < 0x20 && code !== 0x09 && code !== 0x0a && code !== 0x0d)
        return '';
    try {
        return String.fromCodePoint(code);
    }
    catch {
        return '';
    }
}
/**
 * 按字符（码点）切前 `max` 个字，**不劈开代理对**。
 *
 * `String.prototype.slice` 按 UTF-16 码元计数，切点落在代理对中间时会留下一个
 * 孤立的高代理（U+D800–U+DBFF）：它在界面上渲染成 `�`，写进 `board.json` 后
 * 就固化成 U+FFFD。星标、emoji、中文扩展字都在代理对上，所以这不是理论问题。
 *
 * @param text - 原文。
 * @param max - 保留的码元上限（<=0 表示不保留）。
 * @returns 最多 `max` 个码元、且不以半个代理对结尾的前缀。
 */
export function sliceTextByCodePoint(text, max) {
    if (max <= 0)
        return '';
    if (text.length <= max)
        return text;
    const cut = text.charCodeAt(max - 1);
    // 末位落在高代理区间 ⇒ 它的低代理被切掉了，退一个字。
    return cut >= 0xd800 && cut <= 0xdbff ? text.slice(0, max - 1) : text.slice(0, max);
}
/**
 * 截断到指定长度并附省略标记。
 *
 * `max` 约束的是**保留下来的正文**；`…（已截断，共 N 字）` 标记是在正文之外附加的，
 * 因此结果长度是 `max + 标记宽度`（约 13–20 字符，随 N 的位数变化）。调用方若要一个
 * 硬上限，应按"标记宽度再加一点"预留余量。
 *
 * 切点按码点回退，绝不留下半个代理对（见 {@link sliceTextByCodePoint}）。
 *
 * @param text - 原文。
 * @param max - 正文上限（<=0 表示不截断）。
 * @returns 截断后的文本。
 */
export function truncateText(text, max) {
    if (typeof text !== 'string')
        return '';
    if (!Number.isFinite(max) || max <= 0)
        return text;
    if (text.length <= max)
        return text;
    return `${sliceTextByCodePoint(text, max)}…（已截断，共 ${text.length} 字）`;
}
//# sourceMappingURL=text.js.map
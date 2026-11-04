/**
 * Markdown 看板渲染（Principle VI：JSON 权威 → 渲染只读视图）。
 *
 * 输出 `.ai-board/计划看板.md`，顶部标注「自动生成请勿手改」。
 *
 * @module dsh-tfs-requirment/persistence/markdown
 */
import type { BoardState } from '../core/board/board.js';
import type { TaskSnapshot } from '../core/board/task.js';
/**
 * 渲染看板为 Markdown。
 * @param board - 看板快照。
 * @returns Markdown 文本。
 */
export declare function renderBoardMarkdown(board: BoardState): string;
/** 便捷：判断某快照是否含任务（供调用方在不引入类型时复用）。 */
export declare function hasTasks(board: BoardState): boolean;
/** 便捷类型再导出。 */
export type { TaskSnapshot };
//# sourceMappingURL=markdown.d.ts.map
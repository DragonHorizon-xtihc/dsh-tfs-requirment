# Contract: 回写 dry-run 预览（FR-015 / S-05）

> 所有 TFS 写操作第一道门禁：变更前后 diff 预览，供 ExecutionPanel 渲染 + 显式确认。

## 数据流
1. 业务层构造 `WriteOp`（targetWorkItem / opType / before / after）
2. `write-guard/dryrun.ts` 生成 `DryRunPreview`（字段级 diff，before vs after）
3. ExecutionPanel 渲染 `DryRunPreview` 为内联卡片 + 「确认回写」按钮（US4 T047）
4. 用户确认 → 进入幂等键校验 → 发出调用 → 写审计（SC-006/SC-008）

## DryRunPreview 形态
```ts
interface DryRunPreview {
  tool: string                 // 目标 mcp__tfs-mcp__* 工具
  opType: 'state' | 'comment' | 'link' | 'tag'
  target: string               // 工作项 dedupKey
  diff: FieldDiff[]            // 字段级前后对比
  idempotencyKey: string       // 幂等键（S-08）
}
interface FieldDiff { field: string; before: unknown; after: unknown }
```

## 契约要点
- dry-run 预览缺失即判写调用失败（SC-008：审计条目==写调用==1 对齐）
- 预览内容不得含凭据（Principle III）
- revision 冲突：检测到目标已被修改时中止并要求重新 dry-run（FR-017 / T052），禁自动覆盖

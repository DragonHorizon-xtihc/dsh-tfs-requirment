# Contract: 设置区注册（FR-021 / FR-022）

> 宿主无现成 TFS/MCP 设置 UI，需自建。经 `@deepseek-ai/dsh-settings` 的 `installSection` 注册。

## 宿主 API（已核实）
- 入口：`packages/settings/settings/src/index.ts:472` `installSection(owner, ns, schema, entry, { validate?, setSource, onChange })`
- 等价于旧 `installSettingsSection`；本插件加载的是 `lib/index.js`，须用 `ctx.settings.installSection(ctx, ...)`
- `setSource` 接收 getter `() => value`；`onChange` 必备
- 命名空间用字面量小写连字符串（如 `'tfs-requirment'`），不再需要 `settingsNamespace()`

## 本插件注册的两个区
1. **连接配置区**（US1 T028）：集合 URL、PAT（输入即掩码）、测试连接按钮、多集合/多项目、多 profile
2. **MCP 管理子区**（US1 T028b / FR-022）：列出/添加/移除 `tfs-mcp` server 实例（宿主无现成 MCP 设置 UI，自建）

## 契约要点
- PAT 字段类型 = password/掩码；检索全仓（含日志与临时文件）无明文（CHK002/CHK003，T033）
- 保存前调用 `validateConfig`（src/config.ts）确保 pollIntervalMinutes≥1 / maxConcurrentRequirements≥1 / defaultLabel 非空
- schema 变更须向后兼容（配置落 gitignored profile，不进版本控制）

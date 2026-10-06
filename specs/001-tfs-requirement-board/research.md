# Research: 宿主 API 与 tfs-mcp 实测结论汇总

> 证据基线：宪法 v1.1.0 Section 2.D（宿主事实）+ Section 2.E（TFS 实测）+ 本会话对宿主
> `node_modules/@deepseek-ai/*` 与 `tfs-mcp` 工具目录的二次核实。无法核实的一律标 `[NEEDS CLARIFICATION]`。

## 1. 宿主仓库布局（实测纠正）
- 宪法 2.D 引用的 `packages/...` 路径，在本机实际为 `apps/`（cli / desktop / desktop-host / web）
  与 `node_modules/@deepseek-ai/*`。`packages/...` 是**已发布 npm 包名**的代称，解析自
  `node_modules`，非源码目录。插件经 `.d.ts` 面做类型检查（沿用 dsh-optimized-prompt 约定）。
- 插件不在 pnpm workspace（`pnpm-workspace.yaml` 仅收 `packages/*/*`），以 npm 包 + bundle patch 接入。

## 2. 已核实宿主服务包名（node_modules 实测）
| 能力 | npm 包 | 服务属性 | 用途 |
|---|---|---|---|
| cordis 上下文 | `@deepseek-ai/cordis` | `ctx` | 插件框架 |
| 配置 schema | `@deepseek-ai/schemastery` | — | Config |
| 设置区 | `@deepseek-ai/dsh-settings` | `ctx.settings` | installSection（FR-022） |
| 角色/智能体 | `@deepseek-ai/dsh-subagent` | `ctx.subagents` | start 编排（FR-011） |
| MCP client | `@deepseek-ai/dsh-mcp-client` | `ctx.tools` 暴露 `mcp__*` | tfs-mcp 调用 |
| 工作流 | `@deepseek-ai/dsh-workflow` | `ctx.workflow` | 多步编排 |
| 会话 | `@deepseek-ai/dsh-session` | `ctx.session` | 每需求独立 session（FR-030） |
| 客户端槽位 | `@deepseek-ai/dsh-client-ui-slots` | `ctx.slots` | 面板挂载（FR-028） |
| 客户端原语 | `@deepseek-ai/dsh-client-ui-primitives` | — | UI 组件 |
| 客户端 store | `@deepseek-ai/dsh-client-store` | — | 客户端状态 |
| 角色预设 | `@deepseek-ai/dsh-agent-presets` | — | 角色→preset 映射（FR-027） |
| 实验看板模型 | `@deepseek-ai/dsh-experimental-agent-team` | — | 仅参考类型，不依赖 |

## 3. 宿主接入机制（file:line，宪法 2.D）
- 设置区注册：`packages/settings/settings/src/index.ts:472` `installSection`
- UI 槽位：`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:81`
- 执行发起：`packages/subagent/tool-subagent/src/index.ts:530,544,563` + `packages/workflow/*`
- MCP 工具名：`packages/mcp/mcp-client/src/index.ts:31`，serverName 重复报错 `:169-172`
- 插件接入：`packages/boot/app-boot/src/profile.ts:879` 读 `bundleManifest.dsh.bundle.patch`

## 4. TFS 环境实测（只读，宪法 2.E）
- TFS **2018 本地部署**，默认集合 `WN_HIS`：`http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS`
- 可见集合 4 个：`WN_HIS` / `WINNING-6.0` / `WN_TECH` / `WN_TJ`；共 48 个项目（含 `WN_TJ/PEIS`）
- 身份 `zhangbo3(张波)`；tfs-mcp 多数工具带可选 `collection` 参数 → 必须支持多集合切换

## 5. tfs-mcp 工具目录实测（本会话）
- 完整清单见 `contracts/tfs-mcp.md`
- **关键结论**：shelveset 专用工具（list/get/create）在目录中**不存在** → 确认 FR-026/T051 降级
  （shelveset 缺失时仅关联 changeset/branch 链接，不阻塞主回写链路）
- TFVC changeset/branch/item/download 工具齐备 → v1 进 changeset/branch 关联

## 6. 仍待澄清（实施期用 sampling.ts 补全）
- TFS 2018 工作项字段名与状态流转的具体值（不猜测，由 `tfs/sampling.ts` T013 在目标项目实测采样）
- `tfs_set_collection` 与逐调用 `collection` 参数的取舍（以实测工具签名为准）
- subagent/workflow 在 web profile 的具体 provider 名与 preset 名（FR-027，实施期枚举宿主预设）

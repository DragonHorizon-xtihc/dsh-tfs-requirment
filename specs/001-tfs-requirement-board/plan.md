# Implementation Plan: dsh-tfs-requirment —— TFS 需求驱动的 DSH 任务看板插件

**Branch**: 随宿主仓库 `deepseek-harness` 开发（不启用 git hooks，无独立分支）
**Date**: 2026-09-17 | **Spec**: `specs/001-tfs-requirement-board/spec.md`
**Input**: spec.md（含 5 项已裁决澄清）+ 宪法 v1.1.0（含 Section 2.D 宿主事实、2.E TFS 实测）

---

## Summary

构建一个 DSH 插件，把 TFS 需求拉进 DSH、拆解成任务、指派角色智能体执行、再把状态/评论/标签/关联回写 TFS。
全部代码为 **TypeScript 单运行时**（ADR-000 = B）；不引入 Python/CrewAI、不依赖 `dsh-cli-agents` 的 CLI 编排；
多智能体编排用 DSH 原生 `subagents` / `workflow` 能力。UI 与 DSH 现有形态一致（React 18 + CSS Modules、slots 挂载），
看板引擎**借鉴** `agent-team` 的 `TeamTaskBoard` 数据模型（四态 + DAG + CAS 乐观锁）**自实现并落 JSON**（不硬依赖 experimental 宿主插件）。
TFS 接入**全部经 `tfs-mcp`**；凭据经 profile 安全存储；所有写操作过四道门禁。

---

## Technical Context

**Language/Version**: TypeScript（宿主 Node 22.x 运行时；插件以 `tsup`/`tsdown` 构建 `lib/`）
**Primary Dependencies**: `@deepseek-ai/*`（cordis、schemastery、session、subagents、workflow、settings、mcp-client）、
`tfs-mcp`（外部 MCP server，经宿主 mcp-client 调用，不在依赖树内）、`zod`（schema 复用宿主 schemastery 约定）
**Storage**: 插件本地 JSON 主数据（`board.json`）+ JSONL 事件日志（`events.jsonl`）+ 自动渲染 Markdown；
**不**依赖主机 session 投影作为权威（仅作可选 UI 镜像）
**Testing**: `vitest`（unit）+ 面向 tfs-mcp 的契约测试（实施期用真实只读调用 + 沙盘写调用）；
须过宪法 Principle VII 测试门禁（tasks 阶段细化）
**Target Platform**: 用户本机 Windows（`pnpm` 安装、DSH web profile 加载；UI 平台 `web`）
**Project Type**: DSH 插件（server 半 + client 半），包名 `@deepseek-ai/dsh-tfs-requirment`
**Performance Goals**: 定时轮询默认间隔 ≥ 5 分钟、增量拉取；单用户；无高并发要求
**Constraints**: TFS **2018 本地部署** REST API 版本限制；MCP 工具名规则 `mcp__<serverName>__<rawName>`；
`plugins/` 不在 pnpm workspace，需 `cordis.patch.yml` 接入（宪法 2.D）
**Scale/Scope**: v1 单用户；目标集合/项目可配多个默认 `WN_HIS`；TFVC changeset/branch/download 进 v1

---

## Constitution Check（GATE — 逐条对照 v1.1.0）

| 原则 | 本计划落点 | 判定 |
|---|---|---|
| I 证据优先禁止臆造 | 所有外部事实带来源（file:line 见 2.D/2.E）；工作项字段经 `sampling.ts` 实测，不假设 | ✅ |
| II TFS 写操作门禁 | `src/write-guard/` 四件套：dryrun→confirm→idempotency→audit；写路径唯一出口 | ✅ |
| III PAT 隔离 | `src/profile/store.ts` 落 gitignored profile；界面掩码；审计日志剔除凭据 | ✅ |
| IV tfs-mcp 单一出口 | `src/tfs/adapter.ts` 封装全部 tfs-mcp 调用；业务层不直连 REST | ✅ |
| V dsh 标签幂等+失败保留 | 打标签在入队时、幂等键去重、失败保留；逻辑置于 adapter + write-guard | ✅ |
| VI 状态外置文件即真相 | `src/persistence/` JSON 主数据 + JSONL；崩溃保留原文件 | ✅ |
| VII 模块化+验证先于完成 | 分层清晰（适配/编排/写门禁/持久化/UI）；每任务带测试门禁 | ✅ |

**无违反**；无可辩护理由的复杂度，故 Complexity Tracking 留空。

---

## Project Structure

```text
plugins/dsh-tfs-requirment/
├── package.json              # @deepseek-ai/*、main、exports(. / ./client / ./cordis.patch.yml)、dsh.bundle.patch、dsh.client.platform:'web'
├── cordis.patch.yml          # - insert: - id: tfs-requirment / name / config（启用插件 + tfs-mcp server 实例）
├── tsconfig.host.json
├── tsconfig.client.json
├── .gitignore                # 追加 .env.* / board.json 用户数据（PAT 文件与本地看板数据不进版本控制）
├── src/
│   ├── index.ts              # 宿主入口：export const name='tfs-requirment'; inject=扁平数组; export const Config; apply(ctx,config)
│   ├── config.ts             # Config schema（schemastery/zod）：默认集合、轮询间隔、默认标签、目标项目清单
│   ├── tfs/
│   │   ├── adapter.ts        # 【Principle IV 单一出口】封装 tfs-mcp 调用，注入 profile+collection
│   │   ├── types.ts          # Requirement / WorkItem / WriteOp 领域类型
│   │   └── sampling.ts       # 实施期一次性脚本：对目标项目实测采样字段/状态流，输出 docs 供校验
│   ├── profile/
│   │   └── store.ts          # 【Principle III】PAT/profile 读写，gitignored；掩码导出
│   ├── core/board/
│   │   ├── task.ts           # TaskSnapshot（四态 pending/in_progress/completed/deleted + blockedBy[] + revision）
│   │   ├── board.ts          # 看板引擎：领取/拆解/指派/状态机/依赖求解（借鉴 TeamTaskBoard 模型，自实现）
│   │   └── decompose.ts       # 需求 → 任务拆解辅助（调用 workflow 或本地启发式）
│   ├── orchestration/
│   │   ├── dispatch.ts       # 【FR-011】发起执行：ctx.subagents.start / workflow（非 CLI 适配器）
│   │   └── roles.ts          # 【FR-027】角色 → 宿主 provider / agent preset 映射
│   ├── write-guard/
│   │   ├── dryrun.ts         # 变更前后 diff 预览
│   │   ├── idempotency.ts    # 幂等键生成/查重（标签、回写）
│   │   └── audit.ts          # 结构化审计日志（无凭据）
│   ├── persistence/
│   │   ├── json-store.ts     # board.json 读写 + revision 乐观锁
│   │   ├── events.ts         # events.jsonl 追加写
│   │   └── markdown.ts       # 渲染 .ai-board/计划看板.md（标注勿手改）
│   ├── client/
│   │   ├── index.ts          # client 半入口（export 供 dsh.client 扫描）
│   │   ├── slots.ts          # 看板面板/侧栏挂载（参考 slot-catalog.ts:81 契约）
│   │   ├── settings.ts        # 【FR-022】installSection 注册配置区 + 自建 MCP 管理子区
│   │   └── components/
│   │       ├── RequirementPool.tsx    # 需求池：列表/筛选/分页/详情/领取
│   │       ├── TaskCenter.tsx         # 任务中心：拆解/指派/启动/暂停/重试/取消
│   │       ├── ExecutionPanel.tsx     # 执行面板：MCP/技能/模型/角色 + dry-run 预览 + 确认
│   │       ├── RoleSettings.tsx       # 角色智能体 CRUD（映射到 preset/provider）
│   │       └── McpManager.tsx         # MCP 服务器管理（宿主无现成 UI，自建）
│   └── test/                 # vitest unit + contract 套件
└── tests/                    # 集成/契约（跨 TFS/MCP/DSH 边界）
```

---

## 数据流与集成点

**读取链路**：UI 组件 → `core/board`（本地状态）→ `tfs/adapter`（注入 profile+collection）→ 宿主 `mcp-client`
→ `tfs-mcp` 工具 → TFS REST。

**执行链路**：
1. 用户在 `ExecutionPanel` 指定 MCP/技能/模型/角色 → `orchestration/dispatch` 经 `ctx.subagents`
   （`packages/subagent/tool-subagent/src/index.ts:530+`）或 `packages/workflow` 发起**单个** agent 执行；
   多任务并行 = 多次 `start` + `blockedBy` 依赖求解（不在 agent-team 内）。
2. 入队瞬间 → `write-guard` 给目标工作项打 `dsh` 标签（幂等、失败保留，Principle V）。
3. 执行完成 → 按 config 触发回写：经 `write-guard`（dry-run→confirm→幂等→audit）→ `tfs/adapter` → `tfs-mcp`。

**集成点（已核实宿主 API）**：
- 设置区：`packages/settings/settings/src/index.ts:472` `installSection`；
- UI 挂载：slots（`packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:81`，浮层 `shell.overlay`）；
- 执行：`packages/subagent/tool-subagent/src/index.ts:530,544,563` + `packages/workflow/*`；
- MCP：`packages/mcp/mcp-client/src/index.ts:31`，在 `cordis.patch.yml` 声明 `tfs-mcp` server 实例
  （serverName 唯一；重复会报错 `:169-172`）；
- 插件接入：`packages/boot/app-boot/src/profile.ts:879` 读取 `bundleManifest.dsh.bundle.patch`。

**双写边界（解决 Principle VI 与宿主惯例差异）**：JSON `board.json` 为权威；DSH session 投影仅在
需要跨 agent 会话可见时作为**只读镜像**生成，反向不写回 JSON。冲突以 JSON 为准。

---

## 关键设计决策与风险

1. **借鉴而非依赖 `TeamTaskBoard`**：`packages/experimental/agent-team` 是 experimental 宿主插件（多智能体运行时），
   本插件仅取其 `TeamTaskSnapshot` 数据模型（四态 + `blockedBy` + `revision`，`types.ts:71-83`）自实现，
   **不把 `agent-team` 列为依赖**。若宿主升级打破该模型，本插件内部模型可控。
2. **shelveset 工具风险**：实测 `tfs-mcp` 提供 TFVC `items/changesets/branches/download/get_item`
   （已验证），但**未见 shelveset 专用工具**（list/get/create 精确匹配未命中）。应对：FR-026 已写明"以实际工具为准"；
   v1 shelveset 若缺则降级为只读（如存在 list）或推迟创建能力，不阻塞 changeset 关联主链路。
3. **TFS 2018 REST 限制**：工作项字段与状态流转**不猜测**，由 `tfs/sampling.ts` 在目标项目实测采样输出校验文档。
4. **PAT 不进 `mcp.json`**：profile 凭据经 `src/profile/store.ts` 落 gitignored 文件；`cordis.patch.yml` 只声明 server 形态，
   凭据由插件运行时注入，绝不写死。
5. **标签幂等键**：`<workItemId>:<label>` 去重；目标工作项已有同名（规范化后）标签则跳过；失败任务不打标签清除。

---

## 子文档产出（Phase 0/1，本计划后续细化）

- `specs/001-tfs-requirement-board/research.md`：宿主 API 与 tfs-mcp 工具最终清单（含只读实测结果）。
- `specs/001-tfs-requirement-board/data-model.md`：Requirement / DsTask / RoleAgent / WriteOp / AuditEvent / BoardState 字段定义。
- `specs/001-tfs-requirement-board/quickstart.md`：本地 pnpm 安装、profile 配置、mcp 实例声明、DSH web profile 加载验证步骤。
- `specs/001-tfs-requirement-board/contracts/`：tfs-mcp 工具契约（入参/出参）、宿主 `installSection`/slots 契约、回写 dry-run 契约。

---

## Complexity Tracking

无违反。若后续为支持多用户或远端部署引入服务端，须在此登记并说明理由。

---

## 已确认实施决策（clarify 后，2026-09-17 用户裁决）

1. **看板挂载 slot** = `conversation.panel`（常驻侧栏），参考 `packages/extensions/cordis-client-runner/src/client/slot-catalog.ts:81` 契约；`src/client/slots.ts` 据此实现。
2. **`board.json` 存储位置** = 插件私有数据目录（不污染项目根）；`src/persistence/` 路径可配，默认取宿主插件数据目录约定。
3. **定时轮询默认间隔 = 5 分钟，可配**（见 FR-024 / `config.ts` 的 `pollIntervalMinutes`）。
4. **同时执行需求数上限可配，默认 3**（FR-029）；超限排队。`orchestration/dispatch.ts` 维护信号量。
5. **每需求独立对话/会话界面**（FR-030）：发起执行时创建/绑定一个 DSH session，用户可进入查看执行过程；
   该 session 用于呈现该需求下所有子任务的日志与状态。

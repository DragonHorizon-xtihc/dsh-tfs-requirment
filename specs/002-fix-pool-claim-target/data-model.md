# Data Model: 需求池三项交互修复

**Feature**: `002-fix-pool-claim-target` | **Date**: 2026-09-20

## 变更总览

本特性**不新增存储文件**。它扩展既有契约的三个字段/结构，并新增一份只存在于进程内的缓存。

| 位置 | 变更 | 是否落盘 |
|---|---|---|
| `RequirementSummary`（`src/shared/contracts.ts:429`） | + `description?: string` | 经 `board.json` 间接落盘 |
| `Requirement`（`src/tfs/types.ts:13`） | + `description?: string` | 是（`board.json`） |
| `ExecutionPanelData`（`src/shared/contracts.ts:219`） | + `target?: RequirementSummary` | 否（每次 HTTP 下发） |
| 可选项缓存 | 新增 `Map<collection, RequirementQueryOptions>` + inflight `Map` | 否（进程内） |

## 实体

### 1. RequirementSummary（客户端 ⇄ 宿主共享）

| 字段 | 类型 | 说明 |
|---|---|---|
| `id` / `collection` | `number` / `string` | 不变；去重键 = `id@collection` |
| `title` | `string` | 不变 |
| `description` | `string?` | **新增**。TFS `System.Description` 经 HTML→纯文本后的正文，宿主半转换 |

- **为何可选**：TFS 上正文可为空；旧 `board.json`（无该字段）仍要能读（`requirementToSummary` 输出 undefined 时省略键，保持与既有文件兼容）。
- **为何在宿主半转换**：客户端半编译范围不含 `src/tfs`，且不引入 HTML 解析依赖；转换是纯字符串逻辑。

### 2. Requirement（领域，落 `board.json`）

| 字段 | 类型 | 说明 |
|---|---|---|
| `description` | `string?` | **新增**。由 `summaryToRequirement` 从摘要带入，`requirementToSummary` 原样带出 |

- 落盘后果：`board.json` 体积随正文增大（单条通常 < 10KB）。原则 VI 的 JSON 权威不受影响；
  解析失败仍保留原文件（`src/host/board-service.ts:178-191`）。
- 收益：服务重启后"选为目标"仍能带出正文，无需再打 TFS。

### 3. ExecutionPanelData.target（新增，非落盘）

| 字段 | 类型 | 说明 |
|---|---|---|
| `target` | `RequirementSummary?` | 当前执行目标的完整摘要；缺省表示"未选目标"（表单保持空白） |

- 承载"目标 → 表单"的填充数据源；未选目标时不出现，UI 不报错、不乱填（边界用例 2）。

### 4. 可选项缓存（进程内，不落盘）

```
cache:    Map<collection, RequirementQueryOptions>   // 仅当「项目或类型非空」时写入
inflight: Map<collection, Promise<RequirementQueryOptions>>  // 并发共享一次真实采集
```

**状态迁移**：

1. `getQueryOptions(col)` → 命中 `cache` ⇒ 直接返回（不采集）。
2. 未命中但 `inflight` 有该集合 ⇒ 复用同一个 Promise（并发只采一次）。
3. 都无 ⇒ 发起真实采集，采完按"非空判据"决定写不写 `cache`。
4. `refreshQueryOptions(col)` ⇒ **绕过** `cache` 与 `inflight` 直接重采，并覆盖 `cache`。
5. 集合切换 ⇒ 键不同，自然 miss（不同集合项目清单完全不同）。
6. 服务重启 ⇒ `Map` 随进程消失，回到状态 3。

## 校验规则

- 缓存写入判据：`projects.length > 0 || types.length > 0`。
- 去重键 `id@collection` 与既有 `requirementDedupKey`（`src/tfs/types.ts:61`）保持一致；
  客户端侧用共享纯函数生成，**不** import 宿主半模块。
- 正文填充长度上限（防面板被撑爆）：截断到 4000 字符并附省略标记。

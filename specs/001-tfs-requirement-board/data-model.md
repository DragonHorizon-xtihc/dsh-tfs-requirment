# Data Model: dsh-tfs-requirment

> 来源：`plan.md` §数据模型 + `spec.md` §Key Entities + 宪法 v1.1.0。
> 本文件是**实现层字段定义**，代码以本文件为准（非宿主 `agent-team` 类型）。

## 状态枚举

```ts
// 看板任务四态（借鉴 agent-team TeamTaskSnapshot，自实现落 JSON）
type TaskState = 'pending' | 'in_progress' | 'completed' | 'deleted'
// DSH 子任务执行附加态（执行链路内部用）
type ExecState = 'queued' | 'running' | 'success' | 'failed' | 'cancelled'
```

## 实体

### 1. TfsProfile（连接凭据与目标定位）
| 字段 | 类型 | 说明 |
|---|---|---|
| profileName | string | 多 profile 标识（S-12） |
| collectionUrl | string | 集合 URL（如 `http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS`） |
| patRef | string | PAT **密文引用**（绝不存明文，Principle III） |
| targetProjects | string[] | 目标项目清单 |
| targetCollections | string[] | 目标集合清单（FR-025） |
| defaultQuery | Partial<WiqlFilter> | 默认查询条件 |

### 2. Requirement（来自 TFS 的工作项）
| 字段 | 类型 | 说明 |
|---|---|---|
| workItemId | number | TFS 工作项 ID |
| collection | string | 所属集合（去重键左半 `workItemId@collection`，S-01） |
| project | string | 所属项目 |
| title | string | 标题 |
| state | string | TFS 状态 |
| assignedTo | string | 指派给 |
| priority | string | 优先级 |
| iteration | string | 迭代 |
| tags | string[] | 当前标签集合 |
| createdAt / updatedAt | string(ISO) | 创建/更新时间 |
| revision | number | 当前 revision（revision 冲突检测，FR-017） |
| dedupKey | string | `workItemId@collection` 派生，索引用 |

### 3. DsTask（本地可执行单元）
| 字段 | 类型 | 说明 |
|---|---|---|
| taskId | string | 本地任务 ID |
| requirementId | string | 所属需求 dedupKey |
| idempotencyKey | string | 回写/打标签幂等键（S-08） |
| title / description | string | 任务内容 |
| roleAgent | string | 指派角色（引用 RoleAgent.name） |
| frozenConfig | { mcp; skills; model } | 创建时冻结的配置快照 |
| state | TaskState | 四态 |
| execState | ExecState | 执行链路态 |
| blockedBy | string[] | DAG 依赖（DAG 求解，US3 T045） |
| revision | number | 乐观锁版本号 |
| attempts | AttemptRecord[] | 尝试历史（含重试，S-07） |
| artifactPaths | string[] | 产物路径 |

### 4. RoleAgent（角色定义）
| 字段 | 类型 | 说明 |
|---|---|---|
| name | string | 角色名 |
| provider | string | 宿主 provider 引用（FR-027） |
| preset | string | agent preset 引用（FR-027） |
| systemPrompt | string | 系统提示词 |
| defaultMcp / defaultSkills / defaultModel | 各项 | 默认 MCP/技能/模型 |
| autoExecute | boolean | 是否自动执行（S-13） |
| tagStrategy | { defaultLabel: string } | 默认标签策略 |

### 5. WriteOp（回写意图）
| 字段 | 类型 | 说明 |
|---|---|---|
| targetWorkItem | string | 目标工作项 dedupKey |
| opType | 'state' \| 'comment' \| 'link' \| 'tag' | 操作类型 |
| before / after | Json | 变更前后 diff（dry-run 预览源，S-05） |
| idempotencyKey | string | 幂等键 |
| dryRun | DryRunPreview | dry-run 结果 |
| confirmed | boolean | 是否经确认 |
| result | Json | 最终 result |

### 6. AuditEvent（不可变审计记录）
| 字段 | 类型 | 说明 |
|---|---|---|
| ts | string(ISO) | 时间 |
| actor | string | 操作者 |
| profile | string | profile 名（**不含凭据**） |
| tool | string | 工具名（如 `mcp__tfs-mcp__tfs_update_workitem`） |
| inputDigest | string | 入参摘要（**剔除 PAT**，Principle III） |
| result | 'ok' \| 'fail' | 结果 |
| idempotencyKey | string | 幂等键（用于对账，SC-008） |
| retentionUntil | string(ISO) | 滚动 90 天删除标记（S-03） |

### 7. BoardState（权威快照）
| 字段 | 类型 | 说明 |
|---|---|---|
| version | number | 快照版本 |
| tasks | Record<string, DsTask> | 全部 DsTask |
| requirements | Record<string, Requirement> | 全部 Requirement |
| updatedAt | string(ISO) | 更新时间 |
| markdownViewPath | string | 渲染出的 Markdown 看板路径 |

## 持久化映射（Principle VI）
- `board.json`：BoardState 权威（单文件、按 collection 命名空间，S-02）
- `events.jsonl`：AuditEvent + 状态变更事件，append-only
- `.ai-board/计划看板.md`：渲染只读视图（顶部标注「自动生成请勿手改」）
- 崩溃保留：解析失败保留原文件，不静默重建（FR-020 / T062）

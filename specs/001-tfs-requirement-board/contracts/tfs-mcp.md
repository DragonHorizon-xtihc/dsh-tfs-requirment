# Contract: tfs-mcp 工具契约（Principle IV 唯一出口）

> 全部 TFS 访问经 `tfs-mcp`，业务层不直连 REST。工具由宿主 `mcp-client` 暴露为
> `mcp__<serverName>__<rawName>`（serverName = `tfs-mcp`，见 `cordis.patch.yml`）。

## 命名规则
- 工具全名：`mcp__tfs-mcp__<rawName>`（例如 `mcp__tfs-mcp__tfs_get_work_items`）
- `adapter.ts` 持有 `(rawName) => 'mcp__tfs-mcp__' + rawName` 映射，注入 profile + collection
- 切换集合：调用 `tfs_set_collection({ collection })` 或每次调用携带 `collection` 参数（以实测工具签名为准，见 `sampling.ts` T013）

## 已核实可用工具（本会话 tfs-mcp 工具目录实测）
**身份/集合/项目**
- `tfs_whoami` / `tfs_get_current_collection` / `tfs_list_collections` / `tfs_set_collection`
- `tfs_get_projects` / `tfs_get_my_tasks`

**工作项读取**
- `tfs_get_work_items`（按状态/指派/迭代/关键字筛选、分页）
- `tfs_get_workitem` / `tfs_query_wiql` / `tfs_search_work_items` / `tfs_run_saved_query`
- `tfs_get_work_items_by_customer` / `tfs_get_recent_resolved` / `tfs_custom_query`

**工作项写（受四道门禁约束，FR-015）**
- `tfs_create_workitem` / `tfs_update_workitem` / `tfs_change_state` / `tfs_assign`
- `tfs_add_comment` / `tfs_add_tags` / `tfs_add_pr_comment`
- `tfs_upload_attachment` / `tfs_download_attachments` / `tfs_get_attachments`
- `tfs_get_relations` / `tfs_get_work_item_commits` / `tfs_check_commit_work_items`

**PR / 提交**
- `tfs_create_pr` / `tfs_get_pr` / `tfs_list_prs` / `tfs_get_pr_commits` / `tfs_get_pr_diffs` / `tfs_get_pr_workitems`
- `tfs_get_commits` / `tfs_get_branch` / `tfs_get_branch_diffs` / `tfs_list_branches` / `tfs_list_repos`

**TFVC（changeset/branch 进 v1；shelveset 缺失→降级，FR-026/T051）**
- `tfs_get_tfvc_changeset` / `tfs_get_tfvc_changeset_changes` / `tfs_list_tfvc_changesets`
- `tfs_get_tfvc_item` / `tfs_get_tfvc_items` / `tfs_list_tfvc_items`
- `tfs_get_tfvc_file` / `tfs_download_tfvc_files` / `tfs_get_branch` / `tfs_list_tfvc_branches`
- **shelveset 工具（list/get/create）：目录中未出现 → 确认为缺失，触发 FR-026/T051 降级**

## 实测可用性矩阵（2026-09-17 复探，逐条真实调用，非推断）

> 复探动机：上一轮把列表标为"受阻"是**沿用旧结论**，本轮全部重新实测。结果**改变了出口选择**。

| 工具 | 调用 | 结果 | 采纳 |
|---|---|---|---|
| `tfs_whoami` | `{}` | `zhangbo3(张波)` | ✅ 自检 |
| `tfs_custom_query` | `{top:2}`（**不传 fields**） | `The expand parameter can not be used with the fields parameter.` | ❌ 恒失败，已弃用（服务端内部固定同时发 expand+fields） |
| `tfs_get_work_items` | `{ids:[2]}` | 同上 `expand+fields` 冲突 | ❌ 不可用（schema 无 fields 参数也照样冲突） |
| `tfs_search_work_items` | `{keyword:'体检'}` | `Failed request: (414)` | ❌ |
| `tfs_query_wiql` | `WHERE [System.Id] = 2` | 正常返回，**≈4KB** | ✅ **列表主出口** |
| `tfs_query_wiql` | `WHERE [System.Id] = 1` | 返回但 **3,492,287 字节** | ⚠️ 体积离群（7316 条 relations）⇒ 需熔断护栏 |
| `tfs_query_wiql` | 0 命中的 WHERE | `items is not iterable (cannot read property null)` | ⚠️ 伪错误 ⇒ 需归一化为空结果 |
| `tfs_get_work_items_by_customer` | `{customerName:'人民', outputDir:...}` | `{totalCount:0, file:...}`（CSV 落盘，响应体极小） | ✅ 轻量旁路（非通用列表） |
| `tfs_get_recent_resolved` | `{days:1}` / `{days:7}` | `[]` | ✅ 可用，数据面窄 |

**由此确定的实现约束**（已在 `src/tfs/adapter.ts` 落地，并由 `tests/tfs-list-contract.spec.ts` 锁定）：
1. 列表只用 `tfs_query_wiql`；`project` 走独立参数，`state`/`assignedTo`/`keyword` 进 WHERE。
2. WIQL **无视 SELECT**，一律返回全字段 + 全 relations ⇒ 归一化**必须丢弃 relations**，且加 2MB 熔断。
3. 0 命中错误串必须归一化为空列表，不得上报为故障。

## 调用约束
- 只读调用（T027 契约测试）：`tfs_whoami` / `tfs_get_current_collection` / `tfs_get_projects` 不写 TFS
- 写调用必须经 `write-guard` 四道门禁（dry-run→确认→幂等→审计）后再发出
- PAT 绝不出现在调用日志/审计 inputDigest（Principle III）

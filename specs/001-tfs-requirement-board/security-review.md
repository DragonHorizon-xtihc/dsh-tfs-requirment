# 安全评审（T066 / CHK 系列）

> 本评审只写**可核实的事实**：每条结论都给出源码位置、实测输出或测试用例名。
> 凡不能核实的，一律标 `[待核实]`，不含推测。

评审范围：本插件（宿主半 + 客户端半 + cordis patch）。外部依赖 `tfs-mcp` 与宿主
`@deepseek-ai/dsh-*` 视为信任边界之外，其行为按"实测/源码"记录，不代为背书。

---

## 1. 写操作四道门禁：是否全覆盖

**门禁实现**（`src/write-guard/index.ts:58-86`）：

| 门 | 判据 | 不通过的后果 |
|---|---|---|
| 1 dry-run 预览 | `preview(op)` 纯函数，始终可生成（`index.ts:60`） | 不阻断，提供预览 |
| 2 用户确认 | `ctx.confirmed !== true` → 拒绝（`index.ts:63-65`） | 不发写调用 |
| 3 幂等 | 从审计重放取已应用 `idempotencyKey`，命中即拒（`index.ts:68-75`） | 不发重复写调用 |
| 4 审计 | 落盘前 `stripCredentials` 递归剔除凭据字段（`audit.ts:76-83`） | 凭据不进审计文件 |

**写路径唯一入口核查**：`grep -n "this.executeWrite(" src/tfs/adapter.ts` → **5 处**调用，
对应全部 5 个写方法（`addTags` / `changeState` / `addComment` / +2 个建单与关联）。
`executeWrite` 第一件事就是 `this.writeGuard.gate(op, { confirmed })`，`ok=false` 立即返回
（`src/tfs/adapter.ts:286-296`）。**结论：不存在绕过门禁的写路径。**

**`confirmed` 的传入点**（`grep` 实测）：`src/host/api.ts:248/256/265`（UI 确认回写，硬编码 `true`，
语义是"用户在面板上点了确认"）、`src/host/board-service.ts:274`（领取需求时的打标签）。

> ⚠️ **需人工知悉的设计取舍（非缺陷，但必须写明）**：`board-service` 的打标签调用直接传
> `confirmed: true`，即"用户点领取"这一动作本身构成确认，不再弹二次确认。
> 这是 FR-013/T048「进入队列即打标签」的直接实现；代价是**一次领取会在 TFS 上产生一次写**。
> 若部署方要求"打标签也需二次确认"，需改成由 UI 显式传 `tag: false` 后再单独确认（契约已支持）。

---

## 2. PAT 全链路不回显

**防线设计（类型层）**：存储层 `TfsProfile` 含明文 `pat`（`src/profile/store.ts:19-30`，
宿主半内部类型）；所有跨端/跨接口的对外形状一律用 **`ProfileView`（无 `pat` 字段）**
（`src/shared/contracts.ts`）。客户端半**无法** import `TfsProfile`（那是宿主半模块），
因此"响应体带 PAT"在类型层无法编译通过。

**明文读取点核查**：`grep -rn "getCredential" src/` → 仅 2 处调用，均在 `ProfileService`：

| 位置 | 用途 | 是否回响应体 |
|---|---|---|
| `profile-service.ts:155` | 更新档案时"沿用原 PAT" | 否（只写回存储） |
| `profile-service.ts:255` | 写出环境文件 | 否（只写文件；返回 `{ok,path,bytes,hardened}`） |

**测试断言**（`tests/profile-service.spec.ts`）：对 `save` 返回值、`list()`、`get()`、
`envTemplate()`、`writeEnvFile()` 返回值逐个做 `JSON.stringify(...).not.toContain(PAT)`；
并断言 `Object.keys(list[0]).sort() === ['collection','id','name','url']`。
路由层另有回归断言：`tests/host-route.spec.ts` → `expect(res.ended).not.toContain('pat')`。

**存储与会话隔离**：
- 落盘位置：插件数据目录（`dataDir`），**不进** `.env`、不进 `board.json`、不进 `events.jsonl`、不进 `audit.jsonl`；
- `delete()` 先随机字节覆写（`store.ts:44-51`，3 次 pass 调用点 `store.ts:125`）再移除记录，
  测试断言删除后 `profiles.json` 不再含明文（`profile-service.spec.ts` → "删除后记录消失，且原文件被随机字节覆写"）。

---

## 3. 凭据不进日志 / 不进 UI

**两处已知泄漏面及其处理**：

1. **tfs-mcp / TFS 报错会回显请求 URL**（可能带 `?token=` / `?pat=`）。处理：
   - 写路径：`src/tfs/adapter.ts:303-306` → `scrubCredentials(...)`；
   - 读路径（列表查询）：同样经 `scrubCredentials`（`adapter.listRequirements` 失败分支）；
   - 实现只有一份：`src/shared/redact.ts#scrubCredentials`（纯函数，覆盖 Authorization 头、
     Basic/Bearer、URL 查询串 token/pat/password、裸 base64、长十六进制）；
   - `src/host/health.ts` 改为再导出同一实现（避免两份漂移）。
   - 测试：`tests/health.spec.ts`（四类擦除）、`tests/e2e.spec.ts`（写失败原因不含凭据）。

2. **插件日志**：`log()` 只写固定文案 + 集合名/数量等非敏感值（`src/index.ts:58-61` 与其调用点）；
   未发现把 profile 或凭据对象传入日志的路径。

---

## 4. 审计日志完整性

- **append-only**：`AuditLog` 只提供 `append` / `replay` / `rollOver`，
  源码中**不存在**删除或改写审计条目的方法（`grep` 无 `unlink`/`truncate`/`writeFileSync` 于 `audit.ts`）。
- **凭据剔除**：`stripCredentials` 递归 + 数组递归（`audit.ts:47-60`），
  测试 `tests/audit-archive.spec.ts` → "归档内容与 live 条目一致（含 append 阶段已剔除凭据）"
  直接构造 `{pat, nested.password}` 并断言序列化结果不含明文。
- **90 天滚动归档（T063）**：本轮新接线。归档**只读** live 日志、把过期条目写进
  `audit-archive-YYYYMMDD.jsonl`；测试断言归档前后 `audit.jsonl` **逐字节相同**。
  跨文件去重（live 从不截断 → 次日不得重复归档同一批），测试覆盖。
- **审计文件损坏**不静默成功：`inspect()` / `archive()` 均返回 `ok:false + reason`（测试覆盖）。

---

## 5. 已知残余风险（诚实清单）

| # | 风险 | 现状 | 建议 |
|---|---|---|---|
| R1 | `profiles.json` 与 `tfs-mcp.env` 明文存 PAT | 环境文件在支持 `chmodSync` 的文件系统上收紧为 `0600`；不支持时面板如实显示 `hardened: false`（测试断言 memfs 下为 `false`） | 部署层限制数据目录 ACL；或改用 OS 凭据库（宿主未提供该 API，需另议） |
| R2 | 凭据经**环境变量**传给子进程 | patch 的 `env` 显式声明（依据 `dsh-mcp-client/src/transport.ts:21-23`）；`!!js` 在配置解析期求值 → 插件**无法**运行期注入 | 用插件生成的 env 文件；接受"切 profile 需重启"这一限制 |
| R3 | 打标签写操作不二次确认 | 见 §1 说明 | 如需收紧，改由 UI 传 `tag:false` |
| R4 | 审计归档每次全量读取既有归档文件做去重 | O(归档总量)；归档文件量级远小于 live | 归档文件数增长后按月份分片或加索引 |
| R5 | 宿主**不支持**运行期增删 MCP server 实例 | 面板明确标注不支持并给出声明式接入指引（依据 `dsh-mcp-client/src/index.ts:34` + README） | 无（宿主能力边界，不绕过） |
| R6 | 会话投影中的看板状态未做密码学签名 | JSON 为权威、Markdown 为派生物，本地单机插件 | 无（威胁模型内） |

---

## 6. 门禁运行记录（本轮）

| 门禁 | 命令 | 结果 |
|---|---|---|
| 类型 | `npm run typecheck`（host + client + tests） | **EXIT 0** |
| 测试 | `npm test`（vitest v4.1.8） | **19 文件 / 229 例全绿** |
| 构建 | `npm run build` | **EXIT 0**，`lib/client.js` 116.87 kB |

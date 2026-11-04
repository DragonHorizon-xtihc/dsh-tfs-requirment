# dsh-tfs-requirment

[English](README.md) | 中文

把 **TFS 需求**拉进 DSH → 拆解为任务 → 指派角色智能体执行 → 结果回写 TFS 的本地插件。

- 宿主半（TypeScript / cordis 插件）：TFS 读写（直连 REST）、看板状态持久化、回写四道门禁、角色编排、子智能体派发。
- 客户端半（`dsh.client.platform: 'web'`）：注册为侧栏面板项的「TFS 工作台」，五个标签页。

---

## 1. 它能做什么（对照需求故事）

| 能力 | 入口 | 说明 |
|---|---|---|
| US1 连接与配置 | 工作台 → **连接与凭据** | 连通性自检（whoami/集合/项目数）、**49 个 TFS 操作全部直连 REST 接入**（含 WIQL/附件/TFVC/Git/PR，见 §1.1）、集合切换、连接档案（含 PAT）、MCP 接入模板 |
| US2 需求读取与领取 | 工作台 → **需求池** | 列表查询（可定时轮询）、**按工作项 ID 领取**（实测可用的降级读路径）、领取即入本地池并打 `dsh` 标签；筛选可选项**本地落盘缓存**、筛选条件与每页条数**记忆**、列表**分页**、详情展示四段描述 |
| US3 任务中心 | 工作台 → **任务中心** | 需求拆解为三段式任务（分析→实现→验证，DAG 依赖）、指派/改派角色、启动/完成/失败/重试/取消（四态 + 乐观锁）；已领取需求与任务列表**分页**、已领取需求可**还原到需求池**、已取消任务可**单删/批删**（含依赖级联）；**进行中 / 已完成两个子页**（已完成页支持按需求 ID/标题检索、焦点需求的任务列表与执行过程查看） |
| US4 执行编排 | 工作台 → **执行配置** | 按角色派发 `ctx.subagents`，冻结配置（模型/MCP/技能）随任务落库，并发上限保护 |
| US5 角色管理 | 工作台 → **角色管理** | 角色增删改；被任务引用时默认拒删并列出引用 |
| US6 状态与恢复 | 工作台 → **任务中心** + 磁盘 | `board.json` 为权威 + `events.jsonl` 事件日志 + 渲染 Markdown；重启后自动对账悬空任务 |
| 审计与安全 | 工作台 → **连接与凭据** | 审计追加（落盘前剔除凭据字段）、90 天滚动归档（live 日志保持 append-only） |

---

## 1.1 工作台增强（spec 003，2026-09-20）

**需求池**

- **可选项本地缓存**：团队项目 / 工作项类型 / 状态 / 指派给 四类下拉数据源，首次采集后写入
  数据目录 `query-options.json`（按集合隔离）；之后打开页面**优先读本地文件、不再每次请求 TFS**。
  工具栏「**采集可选项**」按钮强制重新采集并覆盖本地文件，按钮旁显示缓存时间。
- **记住上次筛选**：项目（多选）/类型/状态/指派给（含"不限"）选择与每页条数写入 `ui-state.json`，
  下次进入自动恢复；数据源中已失效的选项静默丢弃。切换集合各自记忆。
- **分页**：底部分页栏，每页 10 / 20 / 50 / 100 条可选（默认 20），筛选或切集合自动回第 1 页。
- **选为目标带入完整描述**：描述自动拼入【详细信息】【需求分析】【数据结构】【需求配置】四段
  （对应 `System.Description` 与 `Winning.Demand.Analysis / Winning.Data.Design / Winning.Demand.Config`，
  空段跳过、总长 4000 截断）；本地缺字段时选目标会先回 TFS 补全（enrich）。

**任务中心**

- **领取实时刷新**：需求池点"领取入池"后任务中心即时出现该需求；拆解 / 重新拆解后任务列表即时同步。
- **重新拆解语义修正**：已取消（deleted）的旧任务按确定性 id（`#analyze/#impl/#verify`）**原地复活重建**
  为全新待办，在办任务跳过；提示文案如实给出"新增 N 个、跳过 M 个"，不再误报"已存在而跳过"。
- **还原到需求池**：已领取需求卡片提供"还原"（二次确认）；仅当该需求名下没有在办任务时允许
  （否则提示先取消任务），还原会级联清理已取消任务并 best-effort 移除 TFS 上的 `dsh` 标签
  （标签移除失败只告警、不阻断）。
- **删除已取消任务**：只有"已取消"任务可删除；支持单行删除与复选框**批量删除**（表头全选只作用于**当前页**，与行复选框作用域一致；选中集合跨翻页累积）。删除是整批门禁——所选任一不存在或未取消则整批拒绝并列出 id；同时级联清理
  其他任务 `blockedBy` 中的悬挂依赖引用。
- **分页**：已领取需求每页 5 / 10 / 20 / 50（默认 10），任务列表每页 10 / 20 / 50 / 100（默认 20），
  条数各自记忆。

**整体**

- **Tab 保活**：需求池 / 任务中心 / 执行配置 / 角色管理 / 连接与凭据五个标签页首次访问后**保持挂载**，
  来回切换不重新请求、不丢失滚动与筛选状态（首屏仍只挂载需求池，避免请求放大）。
- **技能下拉补全**：执行配置的技能选项改为"全局层 + 各 preset 作用域挂载层"的并集
  （`skills.list({})` 与 `livePresetMounts()` 各 scope 的 `skills.list({scope})` 合并去重），
  用户级 / preset standing 挂载的技能（约 89+ 条）不再缺失；任一作用域失败降级为全局层。
- **34 个能力缺口端点全部接入**：契约表 49 个操作在适配层均有 REST 分支（TFS 2018 / api-version 4.1），
  连接与凭据页能力盘点显示"已全部接入"。新增覆盖：集合清单/切集合/更新令牌、按客户检索/近期已解决/
  缺陷清单/关系/自定义 WIQL/全文检索/已保存查询、附件列表/上传/下载、TFVC 分支/条目/文件/变更集改动/
  批量下载、Git 仓库/分支/提交/差异、PR 列表/详情/提交/差异/关联工作项/评论/创建。附件与 TFVC 下载落
  数据目录 `downloads/`，带目录穿越防护；TFS 2018 不支持的端点（如 Git 提交关联工作项）返回可读错误。
  > 写端点（PR 创建/评论、附件上传、字段更新）按微软 TFS 2018 REST 文档形状实现并经写门禁测试锁定，
  > 未对真实环境试写；读端点均经真实 TFS 探针或测试桩验证。

---

## 1.2 工作目录与已完成页（spec 007，2026-09-21）

**派发工作目录（问题：任务设了目录，子代理却在别的工程里改代码）**

- **根因**：宿主 `SubagentStartRequest` 没有 `cwd`/`workspace` 字段（`@deepseek-ai/dsh-subagent/src/types.ts:145`），
  子会话 cwd 由 `childSessionMeta()` 从**父会话**复制（`child-agent.ts:147`），out-of-process 也只有
  "部署配置 → 父会话 cwd"两条来源（`out-of-process.ts:147`）。**插件无法按任务改进程 cwd**，
  唯一通道是 prompt。而旧实现有三处叠加缺陷：① 从「执行配置」发起执行时 `taskId` 传 `undefined` ⇒
  prompt 里根本没有工作目录段；② 面板选的工作区 `draft.workspace` 在宿主侧从未被读取（死字段）；
  ③ 工作区下拉写的是 `id` 而不是绝对路径 `path`。
- **修复**：工作目录取值链固定为 **面板显式选择 > 任务级 > 需求级**（三处消费点同口径）；
  下拉一律以**绝对路径**为值，留空 = 跟随任务/需求；prompt 段落改写为**硬约束 + 可执行动作**
  （文件工具用绝对路径、shell 先 `cd /d`、不得在父会话工作目录里就近找同名工程、目录不可访问时停手上报），
  删掉原先"插件不能改变进程 cwd"的自白（那是给开发者看的解释，模型读了只会放弃该目录）。
- **边界**（如实声明）：要真正改变子进程 cwd，需改宿主（per-request cwd 通道）或部署级 `cwd` 配置，
  插件做不到、也不假装做到了 —— 面板会显示**实际生效**的工作目录。

**「发起执行」落地为看板任务（问题：发起执行后看不见执行内容）**

- 旧行为：无 `taskId` ⇒ 不开 attempt、不回绑 runId ⇒ 任务中心里什么都看不到。
- 新行为：在需求**已领取**时创建手工任务 `<需求键>#manual-<角色>-<时间戳>`，走与任务中心完全相同的
  链路（attempt / runId / 轨迹 / 收口 / 需求级自动完成）；未领取或看板不可用时**明确拒绝**（不隐式入池）。
  成功后返回 `taskId` / `createdTask` / **实际生效的 workspace**，面板如实提示并**清空执行内容**
  （保留角色/模型/预设/工作目录/MCP/技能/权限等执行环境）；失败则保留表单以便修正。

**已完成页（问题：需求没有执行状态 / 已完成需求混在任务中心）**

- 需求新增本地字段 `execState: 'active' | 'completed'` + `completedAt`（**非 TFS 字段**，随 `board.json` 持久化；
  历史数据缺该键一律按"进行中"读）。
- **自动迁移**：名下任务全部收口（均 `completed`/`deleted`，且至少一个 `completed`）⇒ 需求置为已完成，
  从「任务中心」整体移到「已完成」子页（需求与其任务一起搬走，不留半迁移状态）。
  触发点：任务收口、任务删除、拆解重开（后者反向退回进行中）。
- **执行状态可见**：需求行显示派生状态 `未拆解 / 执行中 N / 有失败 N / 待办 N / 已完成 c/t`（分母不含已取消任务）。
- **已完成页**：上表 = 已完成需求（**按需求 ID / 标题检索** + 分页 + 每页条数落盘），
  下表 = 焦点需求的任务，任务行可打开执行详情（工具调用时间线 / 失败诊断 / 追问）。
- **护栏**：已完成需求的「还原到需求池」不可点，必须先「取消完成」；宿主侧 `Board.restoreRequirement`
  对已完成需求直接拒绝并给出同样可读的原因（完成与撤销都是显式动作）。

> 根因证据、验收场景与验证命令见 `specs/007-workspace-cwd-and-completed-tab/spec.md`。

---

## 1.3 主对话框 + 编排主 agent + 共享简报（spec 010，2026-09-30）

**主对话框（任务中心「进行中」页右侧）**

- 「进行中」子 Tab 改为**左右分栏**：左任务表（原样）+ 右「主对话框」。
  右侧默认显示**当前焦点需求**（= 需求筛选选中的那条，未筛选时取第一条进行中需求）的
  **编排主 agent 会话**——是宿主**真实会话**（能输入、能看到流式回复），不是自绘的日志气泡。
- 实现走宿主官方槽位协议（与宿主自带的「侧边对话」同构）：父条目声明一个 `scope:'session'`
  子槽 ⇒ 框架注入 `SessionProvider` ⇒ 用 `sessions.retain()` 拿会话引用 ⇒
  `renderFactorySlot('conversation.content', { variant:'embedded' })` 渲染会话正文。
  插件客户端半只能 require 平台冻结模块，**不能**直接 import 会话组件，这是唯一合法路径。
- **主 ↔ 子 agent 双向切换**：对话框顶部是切换条（`主 agent` + 每个任务一项，带执行态药丸），
  点即切换；子 agent 视图底部有「← 返回主 agent」。没有会话的任务项**禁用并给出原因**（不制造死按钮）。
- **兜底与降级**：环境不支持内嵌会话（宿主无 `sessions` / `renderFactorySlot`）时，
  面板显示**可读原因**并提供「在侧边栏打开」（宿主 `sidebarRight.openResource`），绝不白屏。

**编排主 agent（每条需求一个 continuable 持久子会话）**

- 拆解成功后自动为该需求建立一个 **continuable 编排子会话**（`ctx.subagents.startContinuable`），
  会话 id 落 `board.json`（`requirement.orchestration`）。它的职责**只有**归纳与总结，不改代码、不派发。
- 任务 `success` 收口 → 先把「任务标题 + 最终输出 + 产物」发给主 agent 归纳
  （要求输出 `SUMMARY:` 段，≤300 字）→ 结论写进**共享简报**与任务字段 → 再放行下一个就绪任务。
- 需求全部完成 → 主 agent 出**最终总结**（≤800 字）→ 作为结论评论写入 TFS，
  随后照旧更新评审/自测字段、上传全部产物、关联任务置已解决。
- **归纳/总结失败不阻断流程**：continuable 子会话**没有 per-message result**
  （`@deepseek-ai/dsh-subagent/src/run-settlement.ts:1-7`），完成只能靠
  `subagent/end` 事件 + `agent/status` + `sessionQuery` 轮询三级观测；拿不到就超时降级
  （归纳退化为"无摘要"、总结退化为既有模板并在评论里标注 `总结来源：模板兜底`）。
  provider 不支持 continuable ⇒ 该需求 `mode:'off'` + 可读原因，任务链路照常跑完。

**共享简报（避免每个子 agent 重复造轮）**

- 需求级简报（`requirement.orchestration.brief`）承载：需求摘要、工作目录、**已完成任务结论**、
  已产出产物清单、**已绑定 MCP/技能**。派发 prompt 由
  「工作目录 → **共享简报** → 本任务增量 → 执行纪律」四段组成。
- **关键效果**：简报一旦有摘要，后续任务的 prompt **不再包含需求提示词全文**（首任务由需求正文
  自动生成摘要种子，无需额外模型调用）。这是"省 token"的硬断言，有单测锁死。
- 简报里显式列出已启用的 MCP / 技能，并写明"优先使用已绑定工具，不要自行寻找替代方案"。

**任务子会话复用（同一需求 + 同一 provider/preset）**

- 开启 `reuseTaskSessions`（默认开）后，同组任务复用**同一个 continuable 子会话**，
  后续任务以 inbox 消息续跑（`sendMessage`），不再每个任务都从零理解需求。
- 复用路径与 ONE-SHOT **共用同一个并发信号量**（不会顺手放大并发）；同一复用键串行投递。
- 观测不到收口 ⇒ 该任务按**失败**收口并给出可读诊断，**绝不留 running 悬挂**。
- 复用失败（provider 拒绝 / 会话被清理）⇒ 当场回退 ONE-SHOT；用户要的是"任务跑起来"。

> 宿主事实依据（含 `文件路径:行号`）与验收场景见 `specs/010-orchestrator-chat-shared-brief/`。

---

## 2. 安装

本插件**不在**宿主仓库的 pnpm workspace 内（`pnpm-workspace.yaml` 只收 `packages/*/*`），
与仓库先例 `dsh-optimized-prompt` / `dsh-cli-agents` 一致，以 **npm 包 + bundle patch** 接入。

```bash
# 1) 构建（产出 lib/）
cd <repo>/plugins/dsh-tfs-requirment
npm install
npm run build            # tsc host + tsc client + tsdown → lib/

# 2) 让 web profile 认识本插件（以下路径以 $DSH_HOME 为宿主数据目录）
#    a. $DSH_HOME/profiles/web/package.json 的 dependencies 增加：
#         "dsh-tfs-requirment": "link:<repo>/plugins/dsh-tfs-requirment"
#    b. 同文件 dsh.profile.bundles 数组加入 "dsh-tfs-requirment"
#    c. dsh plugin add dsh-tfs-requirment   # 建立 node_modules 软链

# 3) 启动
dsh --profile web --port 3099
```

`cordis.patch.yml`（由 `package.json` 的 `dsh.bundle.patch` 指向）只插入一行：本插件 `tfs-requirment` 实例。

> **不再声明任何 MCP 实例，也不需要。** 自 2026-09-19 起，所有 TFS 读写都直连 `/_apis/...`（适配层直接分派，不再经 `ctx.tools.execute('mcp__<server>__*')`），因此既没有 `tfs-mcp` / `serverName` 同名冲突需要解决，已移除的 `tfsServerName` 配置键也不再存在（用户 profile 里的残留值会被 schemastery 静默忽略，不会报错）。

---

## 3. 凭据（PAT）怎么传进去 —— 这是最容易踩坑的一步

**结论：PAT 必须在启动 dsh *之前* 存在于进程环境里，且必须在 patch 的 `env` 里显式声明。**

依据（宿主源码，非推测）：

```
@deepseek-ai/dsh-mcp-client/src/transport.ts:21-23
  function buildChildEnv(extra) { return { ...scrubbedParentEnv(), ...extra } }
```

- `scrubbedParentEnv()` 会**清洗掉父进程里"凭据形状"的环境变量**（`*_TOKEN` / `*_PAT` / `*_SECRET` …），
  所以只靠 `export TFS_PAT=...` 而不在 patch 里声明，**传不进 MCP 子进程**；
- patch 的 `env`（即 `extra`）在展开顺序上**覆盖**清洗结果，因此 `cordis.patch.yml` 已声明：

```yaml
        env:
          TFS_URL: !!js process.env.TFS_URL || ''
          TFS_COLLECTION: !!js process.env.TFS_COLLECTION || ''
          TFS_PAT: !!js process.env.TFS_PAT || ''
```

- `!!js` 在 **profile 配置解析期**求值（早于任何插件 `apply`），所以插件**无法**在运行期注入 ——
  这也解释了为什么「连接与凭据」页只提供 **生成环境文件**（`<dataDir>/tfs-credentials.env`，真实文件系统上 `chmod 0600`）
  与 **可复制的 export 模板**，而不提供"点一下就热更新凭据"的按钮（那是做不到的事，不做假的）。

推荐流程：

```bash
# 在插件「连接与凭据」页填写档案 → 点「写出环境文件」
source "<dataDir>/tfs-credentials.env"     # PowerShell 用页面上的 $env: 模板
dsh --profile web --port 3099
```

---

## 4. 配置项（`cordis.patch.yml` → `tfs-requirment.config`）

| 键 | 默认 | 说明 |
|---|---|---|
| `collections` | `['WN_HIS']` | 可切换集合清单（FR-025）。运行时可在清单内切换 |
| `defaultCollection` | `WN_HIS` | 默认集合，必须是 `collections` 之一 |
| `pollIntervalMinutes` | `5` | 需求池定时轮询间隔（分钟，最小 1） |
| `defaultLabel` | `dsh` | 领取需求时打的标签（幂等，已存在则跳过） |
| `maxConcurrentRequirements` | `3` | 同时执行的需求数上限（超额 FIFO 排队） |
| `auditRetentionDays` | `90` | 审计滚动保留天数 |
| `allowModelWrites` | `false` | 是否允许**模型**经 `tfs_req_*` 工具执行 TFS 写操作。写门禁「人工确认」由面板的「确认回写」与需求完成回写满足；模型发起的写不构成人工确认，因此缺省 `false` 下会被该门禁拒绝并给出可读原因。打开即等于主动放弃这一道门禁 |
| `enabled` | `true` | 总开关 |
| `autoChainTasks` | `true` | 任务成功收口后自动派发依赖已就绪的下一条（待人工确认/失败会阻断下游） |
| `autoWriteBack` | `true` | 需求全部任务完成后自动回写 TFS（字段/评论/附件/关联任务） |
| `defaultMaxDepth` | `1` | 子智能体委派深度上限（1 = 不再向下派生） |
| `defaultMaxTokens` | `0` | 单次模型响应输出 token 上限（0 = 不限制） |
| `runTimeoutMinutes` | `30` | 单条任务运行总时长看门狗（分钟；0 = 不启用） |
| `orchestratorEnabled` | `true` | 启用编排主 agent（归纳 + 最终总结）；关闭则退回无 AI 归纳 |
| `orchestratorProvider` | `''` | 编排会话用的 subagent provider（空 = 取宿主第一个已注册 provider） |
| `reuseTaskSessions` | `true` | 同需求 + 同 provider/preset 的任务复用同一持久子会话 |
| `summarizeTimeoutSeconds` | `120` | 归纳的**硬超时**（超时按「无摘要」收口该次归纳） |
| `summarizeGraceSeconds` | `20` | 归纳的**放行宽限**：至多等这么久让主 agent 出结论，超时就先放行下一个任务（归纳继续在后台跑完并写回简报） |
| `finalizeTimeoutSeconds` | `180` | 最终总结的硬超时（超时回退模板总结） |
| `finalizeGraceSeconds` | `60` | 最终总结的等待宽限（此时已无下一任务要放行，可略长） |
| `taskSessionSettleTimeoutMinutes` | `30` | 复用会话任务的收口观测超时（超时按失败收口，不留 running） |
| `staleRunningReapMinutes` | `10` | 假执行巡检阈值（分钟）：`in_progress/running` 且**未绑定**子会话的任务超过该时长即标失败、待人工核对。`0` 关闭巡检 |
| `staleRunningSweepSeconds` | `60` | 假执行巡检节奏（秒）。`0` 关闭巡检 |
| `queryOptionsConcurrency` | `8` | 「采集可选项」时同时在飞的元数据 HTTP 请求数上限（必须 ≥ 1）。该采集是 O(项目 × 工作项类型) 次请求（WN_HIS 实测约 800 次），不限并发会同时对内网 TFS 开出几十条连接 |
| `allowExternalDownloadDir` | `false` | 是否允许下载落在 `downloads/` 根目录**之外**。`targetDir` / `options.savePath` 由调用方（可能是模型）给出，缺省 `false` 下越界落点被拒并给出可读原因，且不会创建该目录 |

> 上表中除 `pollIntervalMinutes` 外都在插件装载时被捕获：设置页改动**在下次 dsh 启动后生效**；插件会打印哪些键已保存但待重启生效，`pollIntervalMinutes` 则立即生效。
>
> `summarizeTimeoutSeconds`、`summarizeGraceSeconds`、`finalizeTimeoutSeconds`、`finalizeGraceSeconds`、`taskSessionSettleTimeoutMinutes` 没有"关闭"形态：`0` 会被折成最小正值，含义是"立即失败"而不是"不限时"。
数值下限（`pollIntervalMinutes ≥ 1` 等）由 `validateConfig` 在运行期强制；设置页保存前会先校验。

---

## 5. 数据落在哪

全在插件数据目录（宿主 `dataDir` 服务；缺失时退化为 `$DSH_DATA_DIR` 或 `./.tfs-requirment-data`）：

| 文件 | 内容 | 权威性 |
|---|---|---|
| `board.json` | 看板状态（需求池 + 任务 + 版本号）。spec 010 起还含需求级 `orchestration`（编排会话 id / 共享简报 / 任务会话复用表）与任务级 `orchestration`（会话 id / 是否复用 / 归纳结论） | **权威**。解析失败时保留原文件并拒绝重建；旧文件缺这两个可选字段时按"未启用编排"读 |
| `events.jsonl` | 看板变更事件（append-only） | 审计/对账用 |
| `.ai-board/计划看板.md` | 渲染出的 Markdown 看板 | 派生物，可随时重渲染 |
| `roles.json` | 角色定义 | 权威 |
| `audit.jsonl` | 写操作审计（**落盘前已剔除凭据字段**） | append-only，插件不可删改 |
| `audit-archive-YYYYMMDD.jsonl` | 过期审计条目归档 | 归档不修改 live 日志 |
| `profiles.json` | 连接档案（**含明文 PAT**，仅内部持有、对外不回显） | 删除时随机字节覆写 |
| `profile-active.json` | 活动档案指针 | — |
| `query-options.json` | 各集合需求池下拉可选项缓存（项目/类型/状态/指派人 + savedAt） | 可删，「采集可选项」重建 |
| `ui-state.json` | 各集合 UI 记忆（筛选条件、三处列表每页条数） | 可删，回退默认 |
| `downloads/` | 附件 / TFVC 文件下载目录（按工作项或库路径落盘，含穿越防护） | 派生物 |
| `tfs-credentials.env` | 启动环境文件（含明文 PAT，写出时尽力 `chmod 0600`） | 供 `source` |

> `profiles.json` / `tfs-credentials.env` 含明文 PAT：**不要提交版本库、不要粘贴到聊天或工单**。
> 部署层面建议限制数据目录访问权限（本插件经 `FsLike.chmodSync` 尽力收紧环境文件为 `0600`，
> 但内存文件系统或不支持该调用的部署无法收紧，此时面板会**如实显示** `hardened: false`）。

---

## 6. 开发与门禁

```bash
npm run typecheck   # 三个编译程序：host / client / tests
npm test            # vitest run
npm run build       # tsc×2 + tsdown → lib/
```

测试分层：纯逻辑（board/decompose/poll/write-guard/audit-archive/profile-service）、
宿主编排（host-api/host-route）、接线装配（board-service/e2e，用内存 fs + 桩 adapter/subagents）。
`tests/e2e.spec.ts` 装配除 `ctx.tools` / `ctx.subagents` 外的**全部真实模块**，是"接线有没有接错"的主要防线。

未发布运行期不变量伴生模块：这里没有任何断言需要比对两个可能各自漂移的观测 —— TFS 状态经直连 REST 实时读取并在该边界校验，不一致直接上报给调用方，而不是与第二份副本比对。

# DSH 看板插件横向调研（12 个仓库）

> 调研目的：为 `dsh-tfs-requirment` 的「TFS 任务看板」找出**可复用且与本插件定位兼容**的设计，
> 特别聚焦"模型 / 工作区 / 预设 / 技能 / MCP"这五类枚举**各自从哪里取**。
>
> 证据基线：GitHub API 元数据（`_api.txt`）+ 已落地源码。所有结论标注 `file:line`；
> 无法克隆的仓库明确标注为"仅元数据级评估"，不做实现推断。
>
> 调研时间：2026-09-19。宿主版本基线 dsh `0.1.5-rc.2` / 内部 `0.1.2` 线。

---

## 0. 样本落地情况（先说清楚哪些是"真读了代码"）

| # | 仓库 | stars | 语言 | 落地方式 | 可核实程度 |
|---|---|---|---|---|---|
| 1 | `etony668/dsh-task-board` | 2 | JS | 克隆，**仅产物**（`lib/client.js` 61KB / `lib/index.js` 27KB） | 产物级（可 grep，无源码） |
| 2 | `FiretrUCK666/dsh-task-board` | 1 | TS | 克隆，**带完整 sourcemap**，提取 100+ 原始 `.ts/.tsx` | ⭐ **源码级（最高）** |
| 3 | `bingoogolapple/bga-dsh-workbench` | 4 | TS | 克隆，真实 TS 源码 | ⭐ 源码级 |
| 4 | `zhu1090093659/dsh-web-ui` | 7746 | TS | **未克隆**（745MB） | 仅元数据 |
| 5 | `callmesoul/deepseek-kanban-plugin` | 4 | Vue | 克隆，真实 Vue + TS 源码 | ⭐ 源码级 |
| 6 | `scwlkq/dsh-task-board` | 3 | JS | 克隆，真实 TS 源码 | ⭐ 源码级 |
| 7 | `lihang-lh/dsh-task-panel` | 7 | JS | 克隆，**仅产物**（`client.js` / `index.js`） | 产物级 |
| 8 | `wrc093/dsh-agent-graph` | 0 | TS | 克隆，真实 TS 源码 | ⭐ 源码级 |
| 9 | `21hbguo/dsh-sysmon` | 1 | TS | 克隆，真实 TS 源码（133KB，极小） | ⭐ 源码级 |
| 10 | `rickyfu0625-cell/dsh-billing-dashboard` | 1 | JS | 克隆，**仅产物** | 产物级 |
| 11 | `whyihaveyou/dsh-suite` | 55 | HTML | **未克隆**（302MB） | 仅元数据 |
| 12 | `aust24lzy/dsh-plugin-hub` | 2 | JS | 未克隆 | 仅元数据 |

**样本有效性说明**（避免把不合适的样本当对标）：

- **#4 `dsh-web-ui`（7746★ / 745MB）与 #11 `dsh-suite`（55★ / 302MB）不是看板实现**，而是
  "插件聚合生态 / 插件目录站"。它们与"看板怎么设计"无关，**不纳入优缺点对比**，
  仅在"生态分发形态"一节作为参考。
- **#12 `dsh-plugin-hub`** 同理，是导航站。
- 因此**真正可比对的看板样本是 9 个**（#1/#2/#3/#5/#6/#7/#8/#9/#10）。

---

## 1. 每个插件的优缺点

### #2 FiretrUCK666/dsh-task-board —— 唯一的"工程范本级"实现

**它做了什么**（源码级）：五列看板 + 任务经真实 DSH 会话执行 + host 端持久化 + 跨设备实时同步；
`inject = ['slots','sessions','workspaces','locale','remote','uiSession']`
（`_src_client_index.ts:209`）。

**优点**

1. **`platform.ts` 的"框架无关结构类型"纪律**（`_src_platform.ts:1-20`）。它写明了为什么必须这么做：
   > "`@deepseek-ai/dsh-client-runtime` 停在 0.1.x-rc.2 并被移除；host 的客户端模块系统只解析
   > PLATFORM_MODULES 种子词、动态包行和已注册工厂 —— **别无其它**。域 API 从 `connection.api.*`
   > 迁到 Typert 生成的 `ctx.remote.<ns>.*`，`createSnapshotStore` 属于 shell 种子但本插件不 require 的包。"

   因此它**不 import 任何 `@deepseek-ai/dsh-client-*` 的值**，全部本地结构化重声明 + shape 守卫。
   这是**唯一能跨宿主小版本不炸**的写法。
2. **枚举读取全部走 `ctx.get()` 降级**（`_src_client_index.ts:164-165`）：
   ```ts
   const commands = ctx.get('remote.commands') as RemoteCommandsFace | undefined
     ?? (ctx.get('remote') as RemoteFace | undefined)?.commands
   ```
   注释点明动机："a plugin must never take the shell down by accessing a namespace the deployment
   does not mount"——**二级 fallback**（命名空间服务 → 父服务子属性）是它独有的谨慎。
3. **`runCatalog` 四件套完备**（`_src_client_index.ts:1018-1098`）：`listWorkspaces` /
   `listModelGroups` / `listAgentPresets` / `listPermissions` / `listSlashCandidates`，
   **每一项失败都 `return []` 或 `undefined`，绝不抛**。
4. **「一张 RunConfigEditor，所有表面复用」**（`_src_RunConfigFields.tsx:1-13`）：
   > "Extracted verbatim from TaskForm so every surface that configures a session's run
   > (the task form, the detail's 新建会话) renders the exact same fields in the exact same order
   > — **zero drift by construction**"

   配置预设用 `__manage` 特殊值在下拉里内联打开管理器，选预设**瞬切**改写字段。
5. **模型用 `\u0000` 分隔符编码 `provider + model`**（`_src_RunConfigEditor.tsx`），
   配合官方原生 `<select>` + `<optgroup>`，且 reasoning efforts 随模型联动。

**缺点**

1. **`listMcp*` 完全缺失**。全文 grep `mcp` 在 `_src_*.ts*` 里 **0 命中** —— 它不做 MCP 选择器。
2. **权限表走自有 HTTP 路由**（`fetch('/api/dsh-task-board/permissions')`，`:1063`），
   而不是宿主服务。对它是合理的（权限预设是 host 侧服务），但**引入了一条插件自建 REST 面**。
3. 体积大（客户端 1.23MB + map 2.16MB），因为它把整个 board 引擎打进客户端。
4. 复杂度极高：`_src_client_index.ts` 单文件 62KB、`_src_controller.ts` 2000+ 行，
   耦合了 lease/engine/viewer 三态席位协议 —— **学习成本远超一个看板所需**。

**对我们的可复用度：高，但要挑着抄**（枚举纪律 + 零漂移组件，不抄席位协议）。

---

### #3 bingoogolapple/bga-dsh-workbench —— "DOM 注入"路线的代表

**优点**

1. **`apply-guard.ts` 多插件共存守卫**（47 行）：`globalThis.__bgaDshWorkbenchTaskBoardApplied`
   + claim/release 幂等。**这是真实痛点**——同类插件互相覆盖时无守卫会双重注入。
2. **`competitorAttrs()` 竞争检测**（`board-mount.tsx`）：检测 `data-*-active`/`data-*-open`
   属性判断别的插件是否已占用同一位置（排除自己的 `OPEN_ATTR`）。
3. `TaskBoardEmbed.tsx` 支持"嵌入态"，可被别的容器复用。

**缺点**

1. **整条入口走 DOM hack**：`sidebar-entry.ts:26` `document.querySelector('[data-pane="sidebar"], [class*="sidebarCol"]')`
   + `requestAnimationFrame` 循环反复"补位"钉按钮。
   > "由于侧边栏内容可能在用户交互后才渲染（动态插入 DOM），使用 requestAnimationFrame 循环持续「补位」"

   **这直接脆弱**：宿主改一个 class 名/`data-pane` 值就整体失效 —— 而这类改动在小版本里很常见。
2. 挂载点同样是 DOM 选择器常量 `CENTER_SELECTOR = '[data-pane="conversation"], [class*="centerCol"]'`。
3. 未使用官方槽位，**拿不到宿主的标题栏/关闭/拖拽/分栏**，一切自绘。

**对我们的可复用度：低**。我们已走官方槽位（`sidebar.panellist` + `main` + `sidebar.right.pane.tab`），
比 DOM hack 高一个层级。**唯一值得抄的是 `apply-guard.ts` 的幂等守卫思想**。

---

### #5 callmesoul/deepseek-kanban-plugin —— 唯一 Vue 实现，"劫持宿主"路线

**优点**

1. **虚拟工作区**（`src/client.ts:86-127`）：造一个 `kanban:virtual-workspace`（标题「看板任务」），
   把看板任务对应的会话塞进 `sessionIds`，于是**看板任务在宿主的会话列表里天然可见**——
   复用了宿主已有的工作区 UI，零自绘。
2. **劫持 `inject` 往宿主组件注入能力**（`src/client.ts:191-246`）：
   ```ts
   const entries = ctx.slots.entries('sidebar.workspaces')
   const original = entries.find(e => e.component && e.children?.['sidebar.workspaces.directoryFlow'])
   const originalInject = original.inject
   original.inject = (...args) => ({ ...originalInject(...args), useWorkspaces: projection.useWorkspaces,
                                     startSession: id => id === VIRTUAL ? setOverlayOpen(true) : ... })
   ```
   并**保留了精确还原逻辑**（`:254-256` 把 `inject` 改回去）。
3. 用**宿主原生 CSS 变量**（`--dsw-alias-border` / `--dsw-alias-label-tertiary`，
   `src/client.ts:283-285`）让按钮自动跟随主题，而不是硬编码颜色。
4. 全局快捷键 `Ctrl/Cmd+K` 开关面板（`:50-62`）。

**缺点**

1. **`inject` 劫持是 invasiveness 最高的做法**：直接改写宿主编排对象的字段。
   宿主若把 entry 做成冻结对象/只读代理，直接抛错；且这是**没有公开契约**的内部结构。
   它的 `reconcile` 靠 `queueMicrotask` + `slots.subscribe` 反复重打补丁，时序脆弱。
2. 虚拟工作区分页轮询 `TASK_SESSION_POLL_INTERVAL = 4_000`，且**始终在跑**（无可见性暂停）。
3. 面板用绝对定位 + `getComputedStyle(frame).gridTemplateColumns` 解析（`:330-335`）来算侧栏宽度做
   `left: sidebarWidth` —— **依赖宿主 grid 布局实现细节**。
4. Vue 技术栈与我们的 React 客户端半不兼容（我们的产物只 require `react`）。

**对我们的可复用度：低**（技术栈不同 + 做法 invasiveness 过高）。
**"虚拟工作区"这个点子**值得记下，但我们的场景（TFS 需求→任务）不需要它。

---

### #9 21hbguo/dsh-sysmon —— 我们右栏实现的**直接范本**

这是本轮**最重要**的参考，因为它是"官方 `sidebar.right.pane.tab` 两段式扩展"的干净示例。

**优点**

1. **两段式注册，注释把契约讲透了**（`src/client/index.ts:84-113`）：
   ```ts
   // Stage one: the tab type. The guide entry opens it from the right bar's
   // guide page — no sidebar button needed.
   const disposeType = ctx.sidebarRightTabs.register({
     id: SYSMON_TAB_ID, kind: 'sysmon',
     title: () => t('tab.title'),
     guide: [{ order: 60, title: () => t('guide.title'), description: () => t('guide.description') }],
   })
   // Stage two: the body on the keyed pane seat, after the seat is declared.
   const disposeBody = ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({
     name: 'sidebar.right.pane.tab', key: SYSMON_TAB_ID, locale: NS,
   }, makeSysmonTab({ enabled, subscribe, t })))
   ```
2. **失败的处置纪律写在文件头**（`src/client/index.ts:1-15`）：
   > "Failure policy: DOM/transport problems are logged and swallowed, never thrown —
   > **the web shell fails the whole boot when a plugin apply throws**."

   并注明"容器、标题栏、关闭、拖拽、分栏、浮出**全部由官方 dockkit 接管**"——它自己只写内容视图。
3. **`tab.visible` 驱动暂停轮询**（`src/client/tab.tsx:63-70`）：不可见时不轮询，零浪费。
4. 极小（源码 133KB 仓库），host 端一个零依赖采集器 + **一条** `GET /api/sysmon/snapshot`
   （`src/routes.ts:12-40`），注释明说"no SSE, no WebSocket, just one tiny JSON endpoint"。
5. `settings.plugin.item` 挂设置卡片，`settingsScope.bind({namespace})` 拿到 staged 表单。

**缺点**

1. 只有**一个** tab，没有展示"多个 tab 如何组织"。
2. `inject = ['slots','settingsScope','locale','connection','sidebarRightTabs']` 把
   `sidebarRightTabs` 写进 inject —— 如果宿主没这个服务，**插件整包加载失败**。
   （我们用 `ctx.get('sidebarRightTabs')` + 整体 try/catch 规避了这点。）

**对我们的可复用度：极高，已实施**。我们的 `registerSideTab()` 就是这个模式 + 降级加固。

---

### #8 wrc093/dsh-agent-graph —— "host 半做重活"的范式

**优点**

1. **客户端极薄、host 极厚**：客户端只有 `src/client/index.tsx` + `model.ts`，
   host 有 `core/`（engine/runner/store/editor/graph/prompt/status）。
2. **Web 编排视图走普通 `/graph` 命令路径，而非私有 RPC**（`src/plugin.ts:83-97`）：
   > "The Web '编排' view **deliberately uses the ordinary command path rather than a private
   > browser RPC**. Saving a draft only writes canonical YAML; **it must never create a subagent
   > session**. A later `run` is the sole transition that can activate a node and call `ctx.subagents.start()`."

   **这是"保存 ≠ 执行"的职责分离**，与我们对写操作的四门禁理念一致。
3. **`workspace` 是显式配置项**（`src/plugin.ts:15-24`），`resolve(config.workspace ?? process.cwd())`，
   而不是猜。
4. **durable ledger**：run 状态落盘，`/graph status` 可查历史，进程重启可 `resume`。
5. **`provider` 可选 + 能力门槛明示**（`src/plugin.ts:18-19`）：
   > "Subagent provider name. **Only providers supporting `outputSchema` can run graphs.**"

**缺点**

1. 它是**编排引擎**不是看板 —— 无列/卡/拖拽 UI。
2. `inject = ['commands', 'subagents']`，强依赖 `subagents`，缺服务即不加载。
3. 无 GUI 配置面（全 `/graph` 文本命令），与"看板"的图形化诉求相反。

**对我们的可复用度：中**。"保存≠执行"的分离我们已有（`confirmWrite` vs `dispatch`）；
**ledger 落盘 + resume** 值得对标（我们已有 JSONL 事件日志）。

---

### #6 scwlkq/dsh-task-board —— "远端贡献(Remote) + 双槽"的规整实现

**优点**

1. **代码整洁、文档详尽**：`src/client/index.ts` 142 行，文件头即说明"one Host-backed controller,
   one shared root store, and two contributions"。
2. **Typert Remote 贡献**（`mountTaskBoardRemote(ctx.remote)`）：走**官方远端协议**而非自建 REST。
3. **双槽注册**（`:127-142`）：`sidebar.footer.action`(order **-20**) + `shell.overlay`(order 0)，
   入口在左下、面板整帧覆盖。
4. **`SnapshotPoller` 独立成类**（`snapshot-poller.ts`），间隔 1000ms，可 `dispose` / `refreshNow`。
5. **`connection/reset` 事件重连处理**（`:92-96`）：连接断开后自动 `controller.connectionReset()` +
   `poller.refreshNow()` —— **我们目前没有做这个**。
6. **类型/常量全部 `export type`** 供外部复用。

**缺点**

1. **预设读取用的是 `connection.api.agentPresets.list({})`**（`:96-107`），
   而 `connection.api.*` 是**旧版（alpha.3）形态**，在 `0.1.5-rc.2` 的 `ConnectionHandle` 里
   **不存在**（只有 `isLoopback/generation/state/rpc/reconnect/registerGenerationSource`）。
   ⇒ **这份代码在当前宿主上预设下拉是拿不到的**。这是"跟随旧 API"的典型翻车。
2. 面板走 `shell.overlay` 整帧浮层 —— 与我们的中央 `main` 槽相比，会**压在会话上**，
   多任务并看体验差。（我们第一轮正是因为这个槽位被用户投诉"压住聊天区"。）
3. 无 MCP / 技能选择面。

**对我们的可复用度：中**。抄 `connection/reset` 重连处理 + `SnapshotPoller` 独立化的整洁做法；
**不抄** `connection.api.*`（已证伪）。

---

### #1 etony668/dsh-task-board —— "会话内视图"形态

**优点**

1. **挂在会话里而非全局**：`slots.inject('conversation.view')` +
   `slots.inject('conversation.session.header.utilities')`（产物 grep 证实）。
   ⇒ 看板随会话走，"每个会话一个看板"，与我们的"全局需求池"是两种产品假设。
2. 四条 `fetch('/api/task-board*')` REST 面，host 半 27KB 全封装。
3. 描述提到"父子任务树工具与技能"——**给模型提供了工具**，不只给人看 UI。

**缺点**

1. **只有产物、无源码**（`lib/client.js` 61KB 未压缩可读但无类型/注释上下文）。
2. 会话内视图 ⇒ **切会话就看板消失**，无法做全局任务中心。
3. 父任务树 + 子任务：与 TFS 的"需求→任务"层级不同，语义不直接对齐。

**对我们的可复用度：低-中**。产品假设不同；"给模型留工具"这点我们已通过 `tfs_req_*` 做得更彻底。

---

### #7 lihang-lh/dsh-task-panel (7★，样本里 stars 最高)

**优点**：槽位 `sidebar.footer.action` + `shell.overlay`；README 卖点"让自己当老板，只负责发布和验收"——
**验收语义前置**（人只做发布/验收，中间自动），产品定位清晰。

**缺点**：**仅产物**；`client.js`/`index.js` 无 sourcemap，无法核实内部实现；
无 MCP/技能/模型面证据。

**对我们的可复用度：低**（不可核实，不做推断）。

---

### #10 rickyfu0625-cell/dsh-billing-dashboard

**优点**：单槽 `shell.overlay`；功能聚焦（余额/消费/token/7日趋势/一键充值）——
**"一个面板只干一件事"**的克制。

**缺点**：**仅产物**；与看板任务编排无交集。

**对我们的可复用度：低**（但"聚焦"这点值得自省：我们的五标签是不是太多了？）。

---

## 2. 枚举获取方式横向对比（本轮核心问题）

### 2.1 五类枚举的真实通路清单

| 枚举 | DSH 官方通路（**宿主半 service**） | 客户端半通路（Remote） | 谁在用 |
|---|---|---|---|
| **模型** | `ctx.llm.listProviders()` + `ctx.llm.listModels(providerId)` | `session/models`（旧：`api.sessions.models({})`）→ `groups[].models[]` | kanban=host `llm`；ft=`sessions.models` |
| **工作区** | `ctx.workspaceRegistry.list()` | `ctx.workspaces`（`workspaces.list.getSnapshot().items`） | 全体 |
| **预设** | `ctx.agentPresets.list()` | `ctx.remote.agentPresets.list({})` | kanban=host；ft=remote；xuan=`connection.api`（**失效**） |
| **技能** | `ctx.skills.list({})` | `ctx.remote.skills.list({sessionId})` | ft=`api.skills.list` |
| **MCP** | **无直接服务**；只能从 `ctx.tools.schemas()` 的 `mcp__<server>__*` 前缀反推 | 无 | **我们（唯一）** |
| （补充）provider | `ctx.subagents.list()` | — | 我们 |
| （补充）权限预设 | `ctx.permissionPresets` | ft 走自有 REST | ft |

### 2.2 关键发现：**没有任何一个看板插件拿到了 MCP 枚举**

对 5 个候选逐仓库 grep `mcpServers|mcp_servers|pluginInventory|plugins.list`：
**全部 0 命中**（含 ft / xuan / bga / kanban / task-panel）。

含义：

- **MCP 枚举是未被解决的空白**，我们的 `mcpServerNamesFromSchemas()`（从 `ctx.tools.schemas()`
  的 `mcp__<server>__<tool>` 前缀反推）是**目前唯一有实现的做法**。
- 它是"**已注册工具**"视角而非"配置文件"视角 —— 比读配置更可靠（配置里写了但没连上的 server
  不会出现），但也意味着**未产生工具的 server 不可见**。

### 2.3 三个必须避免的坑（均有实证）

| 坑 | 实证 | 后果 |
|---|---|---|
| `connection.api.*` 是旧版（alpha.3）形态 | xuan `:96-107`；ft `_src_client_index.ts` 注释明说域 API **已从 `connection.api.*` 迁到 `ctx.remote.<ns>.*`** | 预设/技能下拉恒空 |
| 直接属性访问未 inject 的服务会抛 | cordis `vendor/cordis/lib/index.js:672-681` `cannot get property "X" without inject` | 插件整包加载失败（**拖垮 shell boot**） |
| 宿主服务缺失即 `inject` 失败 | sysmon 把 `sidebarRightTabs` 写进 inject | 换部署即不加载 |

**唯一安全写法**（ft 与我们的共同结论）：

```ts
const ns = ctx.get('remote.skills') as Face | undefined   // ctx.get = 非抛出
if (ns === undefined) return []                            // 降级，不是报错
```

---

## 3. 评估：哪些优点可以完美兼容到 TFS 看板

判定标准三条（全部满足才算"完美兼容"）：
① 不引入新的运行期模块依赖（客户端产物只能 require `react` / `react/jsx-runtime`）；
② 不依赖宿主未公开/易变的 DOM 结构或内部字段；
③ 与该能力现有装配点（`src/host/*`、`src/client/*`）自然衔接，无需重构数据流。

| # | 优点（来源） | 判定 | 理由 / 落地情况 |
|---|---|---|---|
| A1 | **右栏两段式官方扩展**（sysmon #9） | ✅ **完美兼容** | **已实施**：`ctx.sidebarRightTabs.register` + `sidebar.right.pane.tab`，宿主 dockkit 接管标题/关闭/拖拽/分栏 |
| A2 | **`ctx.get()` 非抛出 + 逐项降级 + `warnings`**（ft #2 / 全体现有） | ✅ **已具备** | 我们 `dsh-catalog.ts:39-41` 就是这套纪律，只需保持一致 |
| A3 | **枚举读取的二级 fallback**（ft `:164-165`：命名空间 → 父服务子属性） | ✅ **已增强** | 我们现有实现已用 `ctx.get`；本次补上"事后重采"闭环 |
| A4 | **"一张 RunConfigEditor 全表面复用，零漂移"**（ft #2） | ✅ **已具备** | 我们的中央看板与右栏 SidePanel **共用同一个 `<ExecutionPanel>`**（SidePanel.tsx 文件头注明） |
| A5 | **失败策略：log 不 throw，绝不拖垮 shell boot**（sysmon #9 文件头） | ✅ **已具备** | `registerSideTab` 整体 try/catch；`registerPanelDataHandler` 等均走降级 |
| A6 | **`tab.visible` 驱动暂停轮询**（sysmon `tab.tsx:63-70`） | ✅ **可兼容（建议采纳）** | 我们右栏面板已有 `props`/生命周期，可接可见性；轮询当前在客户端 `setInterval` |
| A7 | **`connection/reset` 重连处理**（xuan #6 `:92-96`） | ✅ **可兼容（建议采纳）** | 纯客户端订阅，无新依赖；断线后应 `refreshNow()` |
| A8 | **多插件共存幂等守卫**（bga `apply-guard.ts`） | ⚠️ 部分 | 思想可贵，但我们的槽位 id 已唯一（`@deepseek-ai/dsh-tfs-requirment#exec`），冲突概率低。**成本 > 收益，暂不采纳** |
| B1 | **DOM 注入 + rAF 补位**（bga `sidebar-entry.ts`） | ❌ **不兼容** | 依赖 `[data-pane="sidebar"]` 等易变结构；我们已有官方槽位，降级无意义 |
| B2 | **劫持宿主 `inject`**（kanban `:191-246`） | ❌ **不兼容** | 改写宿主内部对象，无契约；且我们的槽位已能达成同样目的 |
| B3 | **虚拟工作区**（kanban `:86-127`） | ❌ **不适用** | 产品假设是"看板任务=会话组"；我们的任务是 TFS 工作项，语义不对齐 |
| B4 | **自建 `/api/<id>/permissions` REST**（ft `:1063`） | ❌ **不必要性** | 我们已有 `TFS_ROUTES` REST 面，且权限预设非本插件诉求 |
| B5 | **Vue 技术栈**（kanban #5） | ❌ **不兼容** | 产物模块白名单只含 react |
| B6 | **整帧 `shell.overlay` 浮层**（xuan #6 / kanban） | ❌ **已否决** | 第一轮用户明确投诉"压住聊天区"；我们改走中央 `main` + 右栏 |

**结论**：可完美兼容的优点集中在 **A1~A7**，其中 A1/A2/A3/A4/A5 **已在我们的实现中存在**，
A6/A7 是**尚未采纳但值得补**的两项。B 组全部否决且有明确理由（不是"暂时不做"）。

---

## 4. 具体优化方案（枚举获取）+ 最优方案选择

### 4.1 现状体检（先说清楚问题在哪）

我们现有的枚举链路：

```
src/index.ts:220-221   createDshCatalog({host: ctx, ...})  →  void catalog.refresh()   ← 只在 apply 期采一次
src/host/api.ts:250    getPanelData() { const catalog = deps.catalog?.current() }        ← 只读内存快照
src/host/api.ts:260-264  modelOptions/workspaces/presets/providers/skillOptions ← catalog 透传
```

`dsh-catalog.ts` 的 `refresh()` 自带 **inflight 去重**（`:338`）与**逐项 try/catch + warnings**（`:39-41`），
`current()` 只是返回 `snapshot`（`:350-352`）。

### 4.2 体检发现的两个真实缺陷

**缺陷 1（已修复）：目录永远只采一次，用户"事后配置"拿不到**

- 用户完全可能：**先打开插件 → 再去配 provider key / 装技能 / 加 MCP server**。
- 此时 `catalog.refresh()` 早已在 `apply` 期跑完，`current()` 返回的是**首次那份快照**。
- 面板上的"刷新"按钮如果只是重新 `getPanelData()`，**拿到的还是同一份内存快照**——
  按钮点了等于没点。
- 实测影响：宿主 `apply` 期 `llm.listModels()` 对未配 key 的 provider 会失败并记 warning
  （`dsh-catalog.ts:189-192` 已处理，不会炸），但**该 provider 的模型会永久缺失**，
  直到用户重启 dsh。

**修复（已实施）**：

| 层 | 改动 | 文件 |
|---|---|---|
| 契约 | 新增 `catalogRefresh: '/tfs-requirment/catalog-refresh'` | `src/shared/contracts.ts` |
| 契约 | `HostBridge.refreshPanelData()` / `HostApi.refreshPanelData()` | 同上 / `src/host/api.ts` |
| 宿主实现 | `refreshPanelData()` = `await catalog.refresh()` 后 `getPanelData()` | `src/host/api.ts:280-297` |
| 路由 | `createCatalogRefreshHandler`（POST，`.catch` → 500） | `src/host/route.ts:31-49` |
| 路由注册 | `TFS_ROUTES.catalogRefresh` | `src/host/route.ts:480-483` |
| 客户端桥 | `HttpHostBridge.refreshPanelData()`，`!res.ok`/抛错 → 退回 `getPanelData()` | `src/client/slots.tsx:228-253` |
| 右栏 UI | 头部 `⟳` 按钮 + 挂载时自动重采一次 | `src/client/components/SidePanel.tsx` |
| 测试 | `createCatalogRefreshHandler` 用例，断言 `calls` 含 `catalogRefresh` **且不含 `panel`** | `tests/host-route.spec.ts` |

**为什么这是"最优方案"而不是别的**：

- **不需要新服务、新依赖**：复用既有的 `DshCatalogService.refresh()`（它本就为并发去重设计，
  `dsh-catalog.ts:336-348`），只是把"什么时候调"从 `apply` 一次变成"按需 + 打开右栏时"。
- **不引入后台轮询成本**：不做定时重采（那会在没打开面板时白打 provider）。
  只在两个**用户意图明确的时刻**采：① 打开右栏标签页；② 点 `⟳`。
- **失败不产生空白面板**：`refresh()` 内部从不抛；客户端的 `!res.ok` / 网络错误也退回
  `getPanelData()`（读旧快照），最坏情况退化为**修复前的行为**，不会更糟。

**缺陷 2（未修复，需你拍板）：MCP 枚举只从"已注册工具"反推**

`dsh-catalog.ts:309-319` 的 `collectMcpServers()` 用 `host.tools.schemas()` 里
`mcp__<server>__<tool>` 前缀反推 server 名，加 `config.tfsServerName` 兜底。

- **优点**：反映"真正连上并能调的工具"，配置里写了但连不上的 server 不会出现在下拉里
  （选了必然失败 → 不该出现）。
- **局限**：**一个 server 如果工具全被过滤/未产出工具，它就不会出现在 MCP 下拉里**。
- **全生态 0 参考**（见 §2.2）：没有别的看板解决过这个问题，所以**没有可抄的更优解**。
- 结论：**保持现状**，但应在 UI 上把"这是从已注册工具反推的"讲清楚（避免用户以为漏配）。

### 4.3 待采纳的次要优化（建议，未实施）

| 项 | 来源 | 建议 | 成本 |
|---|---|---|---|
| A6 | sysmon `tab.tsx:63-70` | 右栏面板不可见时暂停 `reloadBoard` 轮询 | 低（需确认可见性 prop 名） |
| A7 | xuan `:92-96` | 订阅 `connection/reset` → `refreshPanelData()` + `refreshNow()` | 低（待核实事件在 rc.2 是否仍存在） |
| — | ft `_src_client_index.ts:1026` | 模型目录可改走 `session/modelCatalog`（**当前宿主原生模型选择器读的同一份**），比 `llm.listProviders/listModels` 更贴近用户所见 | 中（需先核实 `remote.session.modelCatalog` 在 rc.2 的返回形态） |

**注意**：A7 与末项**需要先核实宿主 API 存在性**，我不在此处断言可用 ——
按项目纪律，未读源码不写实现。

---

## 5. 验证证据

| 门禁 | 命令 | 结果 |
|---|---|---|
| 宿主类型 | `tsc -p tsconfig.host.json` | `EXIT=0` |
| 客户端类型 | `tsc -p tsconfig.client.json` | `EXIT=0` |
| 测试类型 | `tsc -p tsconfig.tests.json` | `EXIT=0` |
| 打包 | `tsdown` | `lib/client.js 179.57 kB │ gzip 41.22 kB`，Build complete in 100ms |
| 单元测试 | 逐文件 `vitest run` | **22 文件 / 330 用例全过，0 失败**（含新增 1 条路由用例；`host-route.spec.ts` 36→37） |
| 产物自检 | grep `lib/client.js` | `catalog-refresh`=2、`refreshPanelData`=3、`sidebarRightTabs`=6、`sidebar.right.pane.tab`=9、`tfs-requirment-exec`=1 |
| 宿主产物自检 | grep `lib/types/` | `catalogRefresh`=2、`refreshPanelData`=4、`createCatalogRefreshHandler`=2 |

---

## 6. 一句话总结

**9 个可比对样本里，唯一值得抄的是 `FiretrUCK666/dsh-task-board` 的枚举纪律与 `dsh-sysmon` 的官方右栏扩展；
其余要么是 DOM hack（bga/kanban，脆弱）、要么跟随了已失效的旧 API（xuan）、要么只有产物无法核实（etony/panel/billing）。
MCP 枚举全生态空白，我们的工具前缀反推是当前唯一实现。本轮修复的真实缺陷是：能力目录只在插件 apply 期采一次，
用户事后补配模型/技能/MCP 后，面板下拉永远拿不到新项 —— 已通过新增 `POST /tfs-requirment/catalog-refresh`
（`await refresh()` 后再读）闭环修复，并在右栏加入 `⟳` 与挂载自动重采。**

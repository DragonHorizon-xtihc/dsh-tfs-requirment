# Research: 需求池三项交互修复

**Feature**: `002-fix-pool-claim-target` | **Date**: 2026-09-20

> 本项目的证据规则（宪法 Principle I）：每条外部事实必须有 `文件路径:行号` 或实测输出支撑。
> 以下根因均为**源码级事实**，不是推断。

## 决策 1：可选项缓存在宿主半做，客户端只做"避免重复往返"

**Decision**：权威缓存放在宿主半 `createHostApi`（进程内 Map，键 = 集合名），并带 inflight 去重；
客户端半另有一份模块级缓存，仅用于"切页签不发第二次 HTTP"，不承载新鲜度语义。

**Rationale**：
- 用户要求"每次重启服务才需要重新加载" ⇒ 只有**进程内**缓存才能精确对上"服务重启即失效"的语义
  （`localStorage` / 磁盘持久化会让陈旧数据在重启后复活，与诉求相反）。
- 采集的真实成本在宿主侧：`src/tfs/adapter.ts:684` `getQueryOptions()` 每次都跑
  whoami + `GET /_apis/projects` + **逐项目** `listWorkItemTypes`（`:822-831`）
  + **逐项目前 12 个类型** `listStates`（`:837-848`）。62 个项目即 62 + 最多 744 次 REST 调用。
  缓存必须挡在**这一层之前**，只缓存 HTTP 响应挡不住重复采集。
- 客户端缓存的必要性来自挂载模型：切页签会让 `RequirementPool` 卸载重挂载
  （`src/client/slots.tsx:722-745` 的 `body()` 按 tab 重新构造组件），
  其 effect 依赖 `props.collection`（`src/client/components/RequirementPool.tsx:237-256`）→ 每次挂载都发一次 GET。

**Alternatives considered**：
- (a) 只做客户端缓存（localStorage / 模块变量）：挡得住往返，挡不住"服务重启后要重采"与并发放大，❌。
- (b) 只做宿主缓存：能挡采集，但切页签仍有一次 HTTP 往返（开销小但仍有空窗），⚠️ 不彻底。
- (c) 缓存落盘到插件数据目录：重启后仍生效，与"重启就该重采"的诉求冲突，❌。

## 决策 2：空结果不入缓存

**Decision**：四项全空（采集全项降级）的结果**不写入**缓存，下次请求仍会重试。

**Rationale**：`getQueryOptions` 逐项 try/catch，任何一项失败只进 `reason`
（`src/tfs/adapter.ts:744-746, 770-772, 860-866`）。若把"全空"当有效缓存，一次网络抖动会把
空下拉锁死到服务重启为止——比现在的"慢"更糟。
判据用「项目清单或类型清单任一非空」，比"四项都非空"宽松（状态/指派人降级不该阻止复用）。

## 决策 3：已入池判定以本地池快照为准，不新增读取

**Decision**：`Workbench` 把已领取需求的去重键集合传给需求池，行内据此渲染"已入池"标记。

**Rationale**：`BoardService.claimRequirement` 已经真实落盘（`src/host/board-service.ts:251-311`，
末尾 `this.persist('claim', …)` 写 `board.json`）。**数据是对的，UI 没反映**——
`src/client/slots.tsx:728` 的 `onClaim` 只把结果交给 `RequirementPool` 的一次性 `claimMsg`，
既没有 `reloadBoard()`（任务中心角标不变，`slots.tsx:834` 的 `board.tasks.length` 与
`board.requirements` 都不更新），也没有任何持久标记。
已入池所需的数据**已在** `BoardSnapshotView.requirements`（`src/shared/contracts.ts:581`）里，无需新接口。

## 决策 4：需求正文取自 `System.Description`，在宿主半转纯文本后下发

**Decision**：`normalizeWorkItem` 增加映射 `System.Description → description`，
经共享纯函数 `htmlToPlainText` 转成可读文本；领域 `Requirement` 与 `board.json` 同步带该字段。

**Rationale**：
- 现状：`RequirementSummary` **根本没有描述字段**（`src/shared/contracts.ts:429-464`），
  `normalizeWorkItem`（`src/tfs/adapter.ts:1520-1543`）也未取 `System.Description`。
  所以"带出需求内容"不是 UI 没接，而是**数据链路缺字段**。
- `ExecutionPanel` 的表单初值恒为 `DEFAULT_STATE`（`src/client/components/ExecutionPanel.tsx:52,105`），
  `slots.tsx:782-785` 只把 `targetWorkItem` 换成了 `id@collection` ⇒ 表单必然空白。
- TFS 的描述字段是 HTML，直接塞进 `<textarea>` 会显示原始标记；转换是纯字符串逻辑，
  放在 `src/shared/` 才能被客户端半与单测同时消费（客户端半编译范围仅 `src/client` + `src/shared`）。

**Alternatives considered**：
- (a) 选目标时现拉一次工作项详情：多一次 TFS 往返，且列表响应已含该字段（WIQL 返回全字段，
  见 `src/tfs/adapter.ts:902` 注释），❌ 增加配额消耗无收益。
- (b) 客户端自己 strip HTML：逻辑无处安放且不可单测（客户端半无测试框架，见"测试门禁"），❌。

## 决策 5：自动填充的时机绑定"目标变更"，不做每次渲染覆盖

**Decision**：`ExecutionPanel` 监听目标键（`id@集合`）变化，只在它**变化时**填充表单一次。

**Rationale**：宪法 FR-011 与既有教训——`ExecutionPanel.tsx:122-134` 明确写过
"异步数据到达后用 effect 写回 state 会覆盖用户已做的选择"，本项目已因该模式踩过坑。
目标键（`id@collection`）是**离散事件**，不是连续数据流，故安全。

## 测试门禁约束（实测）

`tests/` 下 32 个用例**全部为 `.ts`，无 `.tsx`**（无 React 测试库，见 `tests/` 文件清单）。
⇒ 组件内部逻辑无法直接单测，故本特性把三处可测逻辑下沉到 `src/shared/`：
① 可选项缓存判定（是否命中/是否可缓存）；② 已入池键集合；③ 目标 → 表单的填充与 HTML 转文本。
客户端组件只调用这些纯函数，与 `src/shared/poll.ts` 已有的先例一致。

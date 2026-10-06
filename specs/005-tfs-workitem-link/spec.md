# Spec 005：需求池 / 任务中心标题可点击直达 TFS 需求页

日期：2026-09-20
状态：实现中
前置：001（REST 化）、002、003、004（编辑与批量派发）

## 0. 需求

需求池与任务中心里点击**标题**，直接打开 TFS 需求编辑页：

```
{地址}/{集合}/{团队项目}/_workitems?id={需求号}&_a=edit
```

用户给的样例：

```
http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/体检管理/_workitems?id=1997179&_a=edit
```

## 1. 现状与根因

**现状（代码事实）**：两处的标题都只是**纯文本**，没有任何链接。

- 需求池 `src/client/components/RequirementPool.tsx:554-556`
  ```tsx
  <td style={{ ...cellStyle, maxWidth: 320 }}>
    <span title={it.title}>{it.title}</span>
  </td>
  ```
  同一行的 **ID** 才是可点的（`RequirementPool.tsx:544-553`），但它点开的是**本地详情弹窗**，不是 TFS。
- 任务中心「已领取需求」表 `src/client/components/TaskCenter.tsx:401-411`：标题同样是 `<span>`/文本。

**为什么一直没做**：`RequirementSummary` 里其实**早就带着**构造这个 URL 所需的全部信息 ——
只是没人把它们拼起来。

## 2. 实测数据（2026-09-20，真实 TFS 2018）

从真实落盘的 `.tfs-requirment-data/board.json`（以及 `tests/fixtures/tfs-workitem-1997179-real.json`）读到：

| 字段 | 真实值 |
|---|---|
| `id` | `1997179` |
| `collection` | `WN_HIS` |
| `project` | `体检管理` |
| `url` | `http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/1997179` |

来源链路（已核实 file:line）：
- `url` 由 `normalizeWorkItem` 原样取 TFS 响应的 `url` 字段：`src/tfs/adapter.ts:2546` `url: str(o['url'])`；
- `project` 取 `System.TeamProject`：`src/tfs/adapter.ts:2534`；
- `collection` 取响应 `collection` 或兜底：`src/tfs/adapter.ts:2533`。

⇒ **`url` 里 `/_apis/` 之前的部分正好就是「地址 + 集合」**，所以目标 URL 可以由
**客户端半纯函数**从 `RequirementSummary` 直接算出，**不需要新增宿主路由或 TFS 调用**。

## 3. 需求（FR）

- **FR-501** 需求池「标题」渲染为链接，指向该需求的 TFS 编辑页（`...&_a=edit`），新标签页打开。
- **FR-502** 任务中心「已领取需求」表「标题」同样渲染为链接。
- **FR-503** 任务中心任务表的「需求」列（形如 `1997179@WN_HIS`）也渲染为链接，
  指向所属需求的 TFS 页（**任务本身在 TFS 上没有对应工作项**，故只能指向需求）。
- **FR-504** 需求池详情弹窗里提供「在 TFS 中打开」入口。
- **FR-505** 链接构造必须是**纯函数**并单测覆盖：
  - `url` 含 `/_apis/` 时取其前缀作为「地址 + 集合」；
  - `url` 缺失时回落「活动档案 url + 集合」（`ExecutionPanelData.tfsBaseUrl`）；
  - 缺项目名 / 缺集合 / id 非正整数 → **返回 undefined**（渲染成纯文本，**绝不产出半截或假链接**）；
  - 团队项目名走 `encodeURIComponent`（中文项目名必须能打开）；
  - 只接受 `http/https` —— 数据来自外部系统，`javascript:` 之类的 scheme 必须挡住。
- **FR-506** 无可用链接时**保持现有纯文本渲染**，不报错、不留空 `href`。

## 4. 非目标

- 不在 TFS 侧做任何写操作。
- 不改 `board.json` 的数据形状（不新增字段；`url`/`project` 本来就在）。

## 5. 设计决策

| 决策 | 理由 |
|---|---|
| URL 构造下沉 `src/shared/workitem-url.ts`（纯函数导出） | 客户端半**没有 React 测试库**（项目既有纪律），纯函数才能被 vitest 覆盖 |
| 不给任务标题加链接，只给「需求」列加 | 任务（`#analyze/#impl/#verify`）是本插件**本地**产物，TFS 上没有对应工作项；给任务标题挂一个指向父需求的链接会造成"点了却跳到别处"的误解 |
| 兜底用「活动档案 url」而非硬编码 | 部署地址随档案变化；硬编码等于换个环境就错 |

## 6. 变更清单

| 文件 | 变更 |
|---|---|
| `src/shared/workitem-url.ts`（新） | `buildWorkItemUrl` / `isHttpUrl` |
| `src/shared/contracts.ts` | `ExecutionPanelData.tfsBaseUrl?: string` |
| `src/host/api.ts` | `getPanelData` 透出活动档案 url（不含 PAT） |
| `src/client/components/RequirementPool.tsx` | 标题 → 链接；详情弹窗加「在 TFS 中打开」 |
| `src/client/components/TaskCenter.tsx` | 已领取需求标题 → 链接；任务表需求列 → 链接 |
| `src/client/slots.tsx` | 透传 `tfsBaseUrl` |
| `tests/workitem-url.spec.ts`（新） | 纯函数覆盖（含真实样例的逐字符断言） |
| `scripts/e2e-005.ts`（新） | 用**真实 TFS 载荷**断言拼出的 URL == 用户给的样例 |

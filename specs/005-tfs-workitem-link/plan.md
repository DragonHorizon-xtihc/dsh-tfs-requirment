# Plan 005：标题直达 TFS 需求页

前置：`spec.md`（需求与实测数据）。本文件只讲**怎么改、改哪里、验到哪里**。

## 1. 为什么不需要宿主改动（关键结论）

`RequirementSummary` 里**已经有**构造目标 URL 的全部信息：

| URL 段 | 字段 | 真实值 | 来源 |
|---|---|---|---|
| 地址 + 集合 | `url` 中 `/_apis/` 之前的部分 | `http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS` | `src/tfs/adapter.ts:2546` `url: str(o['url'])` |
| 团队项目 | `project` | `体检管理` | `src/tfs/adapter.ts:2534` `System.TeamProject` |
| 需求号 | `id` | `1997179` | `System.Id` |

⇒ 拼接是**客户端半纯函数**即可完成，**不新增路由、不发 TFS 请求、不改数据形状**。

唯一补的一处：历史 `board.json` 条目可能没有 `url`，故用**活动档案的 url** 作兜底
（只含地址，绝不含 PAT，见 §3）。

## 2. 变更清单

| 文件 | 变更 |
|---|---|
| `src/shared/workitem-url.ts`（新） | `buildWorkItemUrl` / `baseFromRestUrl` / `isHttpUrl` |
| `src/shared/contracts.ts` | `ExecutionPanelData.tfsBaseUrl?: string`（兜底地址） |
| `src/host/api.ts` | `getPanelData` 经 `profiles.activeId() → get(id).url` 透出；**每次调用现取**（`deps` 是值捕获，缓存会拿旧地址） |
| `src/client/components/RequirementPool.tsx` | 标题 → `<a>`；详情弹窗加「在 TFS 中打开」；新增 `tfsBaseUrl` prop |
| `src/client/components/TaskCenter.tsx` | 已领取需求「标题」→ `<a>`；任务表「需求」列 → `<a>`；新增 `tfsBaseUrl` prop |
| `src/client/slots.tsx` | 透传 `tfsBaseUrl` |
| `tests/workitem-url.spec.ts`（新） | 纯函数覆盖：真实样例逐字符、兜底、四类失败口径、scheme 校验、编码形态 |
| `scripts/e2e-005.ts`（新） | 真实载荷（fixture + 真实 board.json）断言拼出的地址 == 目标样例 |

## 3. 实现要点

### 3.1 失败口径：宁可不显示，也不显示打不开的链接

`buildWorkItemUrl` 在任何一段缺失时返回 `undefined`，调用方渲染回退纯文本。
一个 `<a href>` 打不开比一段纯文本更糟：它把"数据缺失"伪装成"功能正常"。

### 3.2 只接受 http/https

`url` / `baseUrl` 都来自外部系统（TFS 响应 / 用户配的档案），会被塞进 `href`。
`javascript:`、`data:` 之类的 scheme 必须挡掉 —— 这是**唯一**一处必须自己做的输入校验。

### 3.3 团队项目名走 encodeURIComponent

实测项目名是中文（`体检管理`）。`href` 里放百分号编码形式最稳；
`?id=…&_a=edit` 是查询串，保持原样（不能整条 encode，否则 `?`/`&` 被吃掉）。

### 3.4 任务表不给「任务标题」加链接

任务（`#analyze/#impl/#verify`）是**本插件本地**产物，TFS 上**没有**对应工作项。
给任务标题挂一个指向父需求的链接会造成"点了却跳到别处"的误解，
故只给「需求」列（形如 `1997179@WN_HIS`）加链接。

### 3.5 凭据绝不随面板下发

兜底地址取自 `ProfileView.url`；`ProfileView`（`src/shared/contracts.ts`）结构上**没有 `pat` 字段**，
所以类型系统本身就是防线。运行期再在实机 E2E 里复核一次（无 pat 键、地址无 userinfo/查询串）。

## 4. 测试策略

| 层 | 覆盖 |
|---|---|
| 纯函数 `tests/workitem-url.spec.ts` | 真实样例逐字符、编码形态、兜底路径、四类失败口径、scheme 白名单 |
| E2E `scripts/e2e-005.ts` | 真实 fixture 经**真实 `normalizeWorkItem`**；真实 `board.json` 经 `Requirement → RequirementSummary` 转换 |
| 实机 `scripts/e2e-004-live.mjs` | `tfsBaseUrl` 下发、形态正确、无凭据 |

## 5. 验证记录（回填）

见文末。

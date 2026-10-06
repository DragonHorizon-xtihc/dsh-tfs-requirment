# 实机验证报告：`dsh-tfs-requirment` 装入真实 `dsh web` profile

- **日期**：2026-09-18
- **验证人**：实施会话（AI 助手），操作经用户逐项确认
- **目标**：把插件装进用户**真实** DSH web profile，并在真实 TFS 上端到端验证可用
- **结论**：**通过**。宿主半 / 路由 / 客户端 UI / 真实 TFS 数据四条链路全部实测可用，TFS 写调用 0。

---

## 1. 安装落点

| 项 | 值 |
|---|---|
| 真实 DSH_HOME | `E:\UserAgentData\.dsh` |
| `C:\Users\user\.dsh` | 指向上面路径的**符号链接**（`fs.realpathSync.native` 实测，非第二个安装点） |
| 插件链接位置 | `<DSH_HOME>\profiles\web\node_modules\@deepseek-ai\dsh-tfs-requirment` |
| bundle/completion patch | `<DSH_HOME>\profiles\web\cordis.patch.yml`（6262 B） |
| tfs-mcp 实例声明 | 同上，凭据运行时注入 |

> 注意：live 实例启动日志打印的 `homeDir` 是 `C:\Users\user\.dsh`，与 `E:\UserAgentData\.dsh`
> 是同一实体，属正常，不是装错路径。

## 2. 环境与前置

- 原实例（PID **39344**，监听 3081）是**安装之前**启动的，进程内存中没有本插件 ⇒ 必须重启。
- 用户确认由助手重启；旧进程已终止。
- 新实例 PID **42416**，监听 `127.0.0.1:3080` + `0.0.0.0:3081`，以受管后台任务方式常驻
  （`Start-Process` 起的子进程会随父 PowerShell 退出被回收，实测 4 个 PID 均如此，不可用）。
- 宿主版本：`0.1.5-rc.2`（`dsh-auto-update` 提示可升 `0.1.6-alpha.2`，本次**未**升级）。

## 3. 证据 A：宿主路由 + 真实 TFS（HTTP 探活）

鉴权方式见第 5 节。带合法 cookie：

| 请求 | 结果 |
|---|---|
| `GET /tfs-requirment/health` | **200** `ok=true, identity=zhangbo3(张波) <zhangbo3>, collection=WN_HIS, projectCount=48`；`tools.available` 48 项，`missing=[]` |
| `POST /tfs-requirment/requirements {keyword:"MEMORY",top:5}` | **200** `ok=true, total=201`，真实工作项 `#1 / #2019042 / #2013692 / #2019084 / #2013202` |
| `GET /tfs-requirment/profiles` | **200** `{ok:true, profiles:[]}`（尚无自定义 TFS profile，属预期初值） |
| `GET /tfs-requirment/mcp-instance` | **200**，如实回报宿主 `dsh-mcp-client` 为「一实例一 server」命名空间插件、`runtimeAddSupported=false`，并附带 `serverName` 命名约束与重名风险说明 |
| `GET /tfs-requirment/roles` | **200** 3 个内置角色（架构师/开发工程师/测试工程师） |
| `GET /tfs-requirment/board` | **200** `version=0`，空看板（未领取任何需求，属预期初值） |
| `GET /tfs-requirment/panel-data` | **200** |
| `GET /`（带 cookie） | **200** `text/html`，首页可服务 |
| `GET /tfs-requirment/health`（不带 cookie，对照组） | **401** —— 证明 200 是「真通过鉴权」，不是路由漏挂鉴权 |

TFS 写调用：**0**。

## 4. 证据 B：客户端 UI（真实浏览器）

在真实 Chromium 中以干净隔离上下文打开 `http://127.0.0.1:3080/`：

- 页面标题由 `dsh web authentication required; …` 变为 **`DeepSeek Harness`**（注入合法 cookie 后重新加载）。
- `shell.overlay` 槽位中渲染出插件面板，标签页：**需求池 / 任务中心(0) / 执行配置 / 角色管理 / 连接与凭据**。
- 面板从真实 TFS 读回并显示 `目标集合：WN_HIS`、`目标：未选择 ｜ 集合：WN_HIS`。
- 在「标题关键字」输入 `MEMORY` → 点击「拉取需求」→ 面板表格渲染出真实工作项：
  - `#1 MEMORY.md consolidation - 2026-04-29`（产品或项目计划 / 已关闭 / ysh（杨善辉））
  - `#2019042 支持单：市医保费用自动上传…Out of memory…`（需求 / 已验证 / mayl（马永丽））
  - `#2013692 CIS住院医生站…System.OutOfMemoryException…`（任务 / 已关闭 / wlw（王林旺））
  - `#2019084 子任务-【开发】【安徽省第二人民医院】…`（任务 / 已关闭 / z_wy（赵伟业））
  - 每行带「领取入池」「选为目标」操作按钮；页脚显示「上次刷新：15:54:37」。
- 网络面板：`POST /tfs-requirment/requirements → 200`（该次点击触发），
  另有 `GET /tfs-requirment/panel-data → 200`、`GET /tfs-requirment/board → 200`。
- 控制台：仅 1 条与本插件无关的 warn（`[git-graph] auto-isolation disabled`）与
  4 次 `404 /api/pet/pets`、`404 /api/pet/diagnostics`（**pet 插件**，非本插件）。

⇒ 「浏览器 UI → 宿主路由 → tfs-mcp → 真实 TFS」全链路打通。

## 5. 关键排查：为什么 `dsh web:` 的 URL 一行都不打印

**这不是竞态，也不是配置问题。**

`@deepseek-ai/dsh-web-app/lib/index.js:202-225`：

```js
const settled = connectionCtx.get('loader')?.await();
if (settled === void 0) announceReady();
else settled.then(() => {
  if (connectionCtx.get('webServer') !== void 0 && connectionCtx.get('connection') !== void 0) announceReady();
}, () => {});
```

`announceReady()`（唯一打印 `dsh web: <url?token=…>` 的地方）**只在插件加载器 settle 之后**被调用。
本机 profile 中：

- `codegraph-sse-bridge` 输出 `FATAL: SSE error connect ECONNREFUSED 127.0.0.1:3748`；
- `chrome-devtools-mcp` 在 banner 之后没有下文；

⇒ 加载器**始终没有 settle**，于是**端口在听、路由全 200，但 URL 永不打印**。
`printUrl` 默认已是 `true`（`dsh-web-app` Config），`--dump-config` 也看不出任何异常。

**判据**：端口被监听 = 服务可用 ≠ URL 会打印。不要把「没有 URL」当成启动失败。

### 无 URL 时的鉴权办法（本次实际采用）

- launch token 存在进程内 `WeakMap`（`dsh-client-connection/lib/index.js:204,217-223`），随机 32 B，
  **磁盘无副本，读不到**。
- 但签名 secret **持久化**在 `<DSH_HOME>/.credentials.yaml`
  → `records["client-connection/browser-session"].payload.secret`（base64url，43 字符 = 32 B）。
- `isAuthenticated()`（`:408-418`）只校验三件事：cookie 签名、`authority`、时间窗。故可自签：

  ```
  name  = "dsh-auth-" + base64url(sha256("<host>:<port>"))
  value = "v1." + base64url(JSON payload) + "." + base64url(HMAC-SHA256(secretBytes, body))
  payload = { version: 1, authority, issuedAt, expiresAt }   // expiresAt-issuedAt ≤ cookieMaxAgeDays(默认 30)
  ```
  HMAC key 是 secret **解码后的字节**，不是字符串。

- **对用户最有用的一条推论**：secret 与 authority 跨重启都不变 ⇒ **服务重启后，浏览器里旧的
  `dsh-auth-*` cookie 仍然有效**。重启 live 实例后无需 token，**直接刷新原标签页或打开
  `http://127.0.0.1:3080/` 即可**。

## 6. 本次实机暴露的问题（待处理）

| # | 现象 | 性质 | 建议 |
|---|---|---|---|
| 1 | `shell.overlay` 面板**压住**聊天区与输入框，右上角 `⚡ Agents 1/1` 悬浮控件与面板表头（`目标：…｜集合：…`）**重叠** | 视觉缺陷（客户端半） | 给面板留出顶/底安全边距，或改用非 `overlay` 的锚定槽位；需要现场量 `Agents` 控件的占位尺寸后再定 |
| 2 | `dsh web` 不打印鉴权 URL | 宿主环境问题（**非本插件**） | 排查/停用挂住加载器的插件（`codegraph-sse-bridge`、`chrome-devtools-mcp`）；本插件无需改动 |
| 3 | `GET /tfs-requirment/profiles` 返回空、`board` 为空 | 初值正常 | 首次使用时由用户建 profile / 领取需求，非缺陷 |

## 7. 复现步骤（简版）

1. 确认实例是**安装之后**启动的（否则重启）。
2. 取 `secret`：`<DSH_HOME>/.credentials.yaml` → `client-connection/browser-session`。
3. 按第 5 节公式自签 cookie（authority 取你实际访问的 `host:port`）。
4. `GET /?token=…` 不可用时，直接带该 cookie 打 `/tfs-requirment/health`。
5. 浏览器侧：DevTools 控制台 `document.cookie = "<自签 cookie>; path=/"` 后重新加载
   （该 cookie 非 HttpOnly 也可被服务端接受），F5 即进入 UI。

## 8. 遗留

- **T073 查询收窄**未做：`project` 单独下推会让 tfs-mcp 生成无 `WHERE` 查询并 `-32001` 超时；
  需先取到「返回非空」的窄查询真实样本再动手（详见 `acceptance-inventory.md` 与当日 memory）。
- 未验证「领取入池 → 拆解 → 派发子代理 → 回写 TFS」的**写路径**（本次刻意只做只读验证，
  TFS 写调用保持 0）。写路径需用户明确授权后再验，且会真实改动 TFS 工作项。

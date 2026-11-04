# Quickstart: 本地安装、配置与加载验证

> 适配本机：Windows + pnpm + DSH web profile。其余平台参照 dsh-optimized-prompt 先例微调。

## 1. 前置
- Node 22.x（宿主运行时），pnpm
- 宿主仓库 `deepseek-harness` 已 `pnpm install` 且 `@deepseek-ai/*` 在根 `node_modules`
- tfs-mcp 已在某处可启动（本插件 `cordis.patch.yml` 经 `TFS_MCP_COMMAND` 指向其入口；若 profile 已存在同名实例，须改名或复用）

## 2. 安装本插件到 web profile
与仓库先例 `@deepseek-ai/dsh-optimized-prompt` 一致：
```bash
# 1) 在 $DSH_HOME/profiles/web/package.json 的 dependencies 加：
#    "dsh-tfs-requirment": "link:<本插件绝对路径>"
# 2) 同文件 dsh.profile.bundles 数组加入 "dsh-tfs-requirment"
# 3) 建立软链（dsh plugin add 会代劳，或手动 link）
pnpm --filter <web-profile> install
```

## 3. 构建
```bash
cd plugins/dsh-tfs-requirment
pnpm install          # 安装 devDeps（react / tsdown 等）
pnpm build            # tsc host + tsc client + tsdown 打 client bundle
pnpm typecheck        # 三程序类型检查
pnpm test             # vitest 单测（Principle VII）
```

## 4. DSH web profile 加载验证
```bash
dsh --profile web --port 3099 --no-open
# 打开浏览器 → 设置页应出现「TFS 需求看板」配置区（US1 T028）
# 看板面板应可挂载到 conversation.panel（US3 T040，后续阶段）
```
- 若插件未出现：检查 `dsh web` 启动日志（插件加载失败只打日志不阻断，见装配纪律）
- 验证 PAT 不回显：`grep -R "PAT明文" $DSH_HOME` 应无命中（CHK002/CHK003，T033）

## 5. tfs-mcp 实例校验（契约测试 T027）
```bash
pnpm test:integration   # 经 tfs-mcp 对真实 TFS 只读调用 tfs_whoami / tfs_get_current_collection / tfs_get_projects
```
- 写调用（T054）仅对**沙盘/测试工作项**执行，且必经 dry-run 预览，谨慎使用。

## 6. 常见坑
- 插件不在 pnpm workspace：依赖解析走宿主根 `node_modules`，勿在插件内重装 `@deepseek-ai/*`
- serverName 重复：profile 已配 `tfs-mcp` 时，本 patch 的 `tfs-mcp` 实例会报硬错误（`:169-172`）
- shelveset 缺失：属预期降级，非 bug（FR-026 / T051）

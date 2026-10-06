# Tasks 005

图例：`[x]` 完成 / `[ ]` 未做（附原因）。

## 实现

- [x] T501 `src/shared/workitem-url.ts`：`buildWorkItemUrl` / `baseFromRestUrl` / `isHttpUrl`（纯函数）
- [x] T502 `ExecutionPanelData.tfsBaseUrl?`（contracts）
- [x] T503 `api.getPanelData` 透出活动档案 url（**每次现取**，不含 PAT）
- [x] T504 `RequirementPool`：标题 → 链接；详情弹窗「在 TFS 中打开」；`tfsBaseUrl` prop
- [x] T505 `TaskCenter`：已领取需求标题 → 链接；任务表需求列 → 链接；`tfsBaseUrl` prop
- [x] T506 `slots.tsx` 透传 `tfsBaseUrl`（两处面板）

## 验证

- [x] T-V1 三道 tsc（host / client / tests）全 0
- [x] T-V2 `vitest --reporter=json`：`numFailedTests === 0`（634 用例 / 196 suites）
- [x] T-V3 `tsc + tsdown` 通过；产物含 `_workitems?id=`、`tfsBaseUrl`
- [x] T-V4 `tests/workitem-url.spec.ts`：真实样例逐字符、编码形态、兜底、四类失败口径、scheme 白名单
- [x] T-V5 `npm run e2e:tfs-link`（`scripts/e2e-005.ts`）：真实 fixture 经真实 `normalizeWorkItem`
      + 真实 `board.json`，两条来源拼出的地址均 == 目标样例
- [x] T-V6 `npm run e2e:live`：真实 dsh web 下发 `tfsBaseUrl`、形态正确、无凭据
- [x] T-V7 回填 `plan.md` 验证记录 + 写工作记忆

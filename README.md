# dsh-tfs-requirment

English | [中文](README.zh.md)

A local plugin that pulls **TFS requirements** into DSH → breaks them down into tasks → dispatches role agents to execute them → writes the results back to TFS.

- Host side (TypeScript / Cordis plugin): TFS reads and writes over direct REST, board state persistence, the four write-back gates, role orchestration, subagent dispatch.
- Client side (`dsh.client.platform: 'web'`): the **TFS workbench** sidebar panel entry, with five tabs.

---

## 1. What it does (mapped to the requirement stories)

| Capability | Entry point | Description |
|---|---|---|
| US1 Connection and configuration | Workbench → **Connections & credentials** | Connectivity self-check (whoami/collection/project count), **all 49 TFS operations connected over direct REST** (including WIQL/attachments/TFVC/Git/PR, see §1.1), collection switching, connection profiles (with PAT), MCP access templates |
| US2 Reading and claiming requirements | Workbench → **Requirement pool** | List queries (with optional scheduled polling), **claim by work item ID** (a degraded read path proven usable in practice), claiming puts the item into the local pool and tags it `dsh`; filter options are **cached on disk locally**, filter conditions and page size are **remembered**, the list is **paginated**, and the detail view shows the four description sections |
| US3 Task center | Workbench → **Task center** | Requirements decompose into three-part tasks (analyze → implement → verify, with DAG dependencies), assign/reassign roles, start/finish/fail/retry/cancel (four states plus optimistic locking); claimed requirements and the task list are **paginated**, a claimed requirement can be **restored to the requirement pool**, cancelled tasks support **single and batch deletion** (with dependency cascade); **two sub-tabs: In progress / Completed** (the Completed tab supports search by requirement ID or title, plus viewing the focused requirement's task list and its execution process) |
| US4 Execution orchestration | Workbench → **Execution config** | Dispatches `ctx.subagents` per role, freezes the configuration (model/MCP/skills) and persists it with the task, concurrency cap protection |
| US5 Role management | Workbench → **Role management** | Create, delete, and edit roles; deletion is refused by default when a task references the role, and the references are listed |
| US6 State and recovery | Workbench → **Task center** + disk | `board.json` is authoritative, plus the `events.jsonl` event log and the rendered Markdown; after a restart, dangling tasks are reconciled automatically |
| Auditing and security | Workbench → **Connections & credentials** | Append-only audit trail (credential fields stripped before writing to disk), 90-day rolling archive (the live log stays append-only) |

---

## 1.1 Workbench enhancements (spec 003, 2026-09-20)

**Requirement pool**

- **Filter options cached locally**: the four dropdown data sources (team project / work item type / state / assigned to) are written to the data directory file `query-options.json` (isolated per collection) on first collection; opening the page afterwards **reads the local file first and no longer requests TFS every time**. The toolbar **Collect options** button forces a re-collection and overwrites the local file, and the cache time is shown next to the button.
- **Remember the last filters**: the selections for project (multi-select) / type / state / assigned to (including "Any") and the page size are written to `ui-state.json` and restored automatically on the next visit; options that have gone stale in the data source are dropped silently. Each collection remembers its own state.
- **Pagination**: a pagination bar at the bottom offering 10 / 20 / 50 / 100 items per page (default 20); changing the filters or switching collections returns to page 1 automatically.
- **Selecting a target brings in the full description**: the description is assembled from four sections — [Details] [Requirement analysis] [Data design] [Requirement configuration] — corresponding to `System.Description` and `Winning.Demand.Analysis / Winning.Data.Design / Winning.Demand.Config`; empty sections are skipped and the total length is truncated at 4000. When a field is missing locally, selecting a target first goes back to TFS to enrich it.

**Task center**

- **Live refresh after claiming**: once "Claim into pool" is clicked in the requirement pool, the requirement appears in the task center immediately; the task list syncs right after a decompose / re-decompose.
- **Re-decompose semantics corrected**: old cancelled (deleted) tasks are **revived in place** as brand-new todos by deterministic id (`#analyze/#impl/#verify`), while in-flight tasks are skipped; the message now reports "N added, M skipped" honestly instead of falsely reporting "skipped because it already exists".
- **Restore to the requirement pool**: the claimed requirement card offers "Restore" (with a second confirmation), allowed only when the requirement has no in-flight tasks (otherwise it prompts you to cancel them first). Restoring cascades to clean up cancelled tasks and makes a best-effort removal of the `dsh` tag on TFS (a failed tag removal only warns and never blocks).
- **Deleting cancelled tasks**: only "cancelled" tasks can be deleted; both single-row deletion and checkbox **batch deletion** are supported (the header select-all applies to the **current page** only, matching the row checkboxes' scope; the selection set accumulates across page changes). Deletion is a whole-batch gate — if any selected task does not exist or is not cancelled, the entire batch is rejected and the ids are listed; it also cascades to clean up dangling dependency references in other tasks' `blockedBy`.
- **Pagination**: claimed requirements offer 5 / 10 / 20 / 50 per page (default 10) and the task list offers 10 / 20 / 50 / 100 (default 20); each remembers its own page size.

**Overall**

- **Tab keep-alive**: the five tabs — requirement pool / task center / execution config / role management / connections & credentials — **stay mounted** after their first visit, so switching back and forth issues no new requests and loses neither scroll position nor filter state (the first screen still mounts only the requirement pool, to avoid request amplification).
- **Skill dropdown completion**: the skill options in execution config are now the union of "global layer + the mount layer of each preset scope" (merging and deduplicating `skills.list({})` with `skills.list({scope})` for every scope from `livePresetMounts()`), so skills mounted at the user level or standing-mounted by a preset (about 89+) no longer go missing; if any scope fails, it degrades to the global layer.
- **All 34 capability-gap endpoints connected**: every one of the 49 operations in the contract table has a REST branch in the adapter layer (TFS 2018 / api-version 4.1), and the capability inventory on the connections & credentials page reports "all connected". Newly covered: list collections / switch collection / update token, search by customer / recently resolved / bug list / relations / custom WIQL / full-text search / saved queries, attachment list / upload / download, TFVC branches / items / files / changeset changes / bulk download, Git repositories / branches / commits / diffs, PR list / details / commits / diffs / associated work items / comments / create. Attachment and TFVC downloads land in the data directory `downloads/`, with directory-traversal protection; endpoints TFS 2018 does not support (such as associating work items with Git commits) return a readable error.
> Write endpoints (PR creation/comments, attachment upload, field update) are implemented to the shape of Microsoft's TFS 2018 REST documentation and locked down by write-gate tests; they have not been test-written against a real environment. Read endpoints are all verified by real TFS probes or test stubs.

---

## 1.2 Working directory and the Completed tab (spec 007, 2026-09-21)

**Dispatch working directory (problem: the task has a directory set, but the subagent edits code in a different project)**

- **Root cause**: the host's `SubagentStartRequest` has no `cwd`/`workspace` field (`@deepseek-ai/dsh-subagent/src/types.ts:145`), the sub-session cwd is copied from the **parent session** by `childSessionMeta()` (`child-agent.ts:147`), and out-of-process has only the two sources "deployment config → parent session cwd" (`out-of-process.ts:147`). **The plugin cannot change the process cwd per task**; the only channel is the prompt. The old implementation had three compounding defects: ① starting execution from Execution config passed `taskId` as `undefined` ⇒ the prompt contained no working-directory section at all; ② the workspace selected in the panel, `draft.workspace`, was never read on the host side (a dead field); ③ the workspace dropdown wrote the `id` instead of the absolute path `path`.
- **Fix**: the working-directory resolution chain is fixed as **explicit panel selection > task level > requirement level** (all three consumption points use the same rule); dropdowns always use the **absolute path** as the value, and leaving it empty means follow the task/requirement; the prompt section was rewritten as **hard constraints plus executable actions** (file tools use absolute paths, shell runs `cd /d` first, do not look for a same-named project next to the parent session's working directory, stop and report when the directory is inaccessible), and the old confession that "the plugin cannot change the process cwd" was deleted (that was an explanation for developers, and a model reading it would only give up on the directory).
- **Limits (stated honestly)**: genuinely changing the child process cwd requires changing the host (a per-request cwd channel) or a deployment-level `cwd` configuration. The plugin cannot do it and does not pretend otherwise — the panel shows the working directory that is **actually in effect**.

**"Start execution" lands as a board task (problem: after starting execution, the executed content is invisible)**

- Old behavior: no `taskId` ⇒ no attempt opened and no runId bound back ⇒ nothing is visible in the task center.
- New behavior: when the requirement is **claimed**, a manual task `<requirement key>#manual-<role>-<timestamp>` is created and follows exactly the same path as the task center (attempt / runId / trajectory / close-out / requirement-level auto-completion); when the requirement is unclaimed or the board is unavailable it is **explicitly rejected** (no implicit pool entry). On success it returns `taskId` / `createdTask` / the **workspace actually in effect**, the panel reports this honestly and **clears the executed content** (keeping the role / model / preset / working directory / MCP / skills / permissions and the rest of the execution environment); on failure the form is kept so it can be corrected.

**Completed tab (problem: requirements have no execution state / completed requirements are mixed into the task center)**

- Requirements gain the local fields `execState: 'active' | 'completed'` and `completedAt` (**not TFS fields**; persisted with `board.json`; historical data missing the key is always read as "in progress").
- **Automatic migration**: once every task under the requirement is closed out (all `completed`/`deleted`, with at least one `completed`) ⇒ the requirement is marked completed and moves as a whole from the Task center to the Completed sub-tab (the requirement travels together with its tasks; no half-migrated state is left behind). Triggers: task close-out, task deletion, and re-decompose (the last one moves it back to in progress).
- **Execution state visible**: the requirement row shows the derived status `未拆解 / 执行中 N / 有失败 N / 待办 N / 已完成 c/t` (the denominator excludes cancelled tasks).
- **Completed tab**: the upper table = completed requirements (**search by requirement ID / title** + pagination, with the page size persisted); the lower table = the focused requirement's tasks, and a task row opens the execution details (tool call timeline / failure diagnosis / follow-up questions).
- **Guardrails**: for a completed requirement, "Restore to the requirement pool" is not clickable — you must "Cancel completion" first; on the host side `Board.restoreRequirement` rejects completed requirements outright and gives the same readable reason (completing and undoing are both explicit actions).

> Root-cause evidence, acceptance scenarios, and verification commands are in `specs/007-workspace-cwd-and-completed-tab/spec.md`.

---

## 1.3 Main chat panel + orchestrator agent + shared brief (spec 010, 2026-09-30)

**Main chat panel (right side of the In-progress task list)**

- The In-progress sub-tab becomes a **two-pane layout**: the task table on the left (unchanged) and the
  **main chat panel** on the right. It shows the **orchestrator agent session** of the focused
  requirement — a **real host session** (you can type, you see streamed replies), not a hand-drawn log.
- It uses the host's official slot protocol (same shape as the built-in sidebar chat): the parent entry
  declares a `scope:'session'` child slot ⇒ the framework injects `SessionProvider` ⇒
  `sessions.retain()` yields the session reference ⇒
  `renderFactorySlot('conversation.content', { variant:'embedded' })` renders the transcript.
  The client half can only `require` frozen platform modules, so this is the only legitimate path.
- **Two-way switching**: a switcher row on top (`Main agent` + one entry per task, with exec-state
  pills); clicking switches, and a child view has a "← Back to main agent" button. Tasks without a
  session are **disabled with a reason** instead of being a dead button.
- **Fallback**: when inline sessions are unsupported (no `sessions` / `renderFactorySlot`), the panel
  shows a **readable reason** plus "Open in sidebar" (`sidebarRight.openResource`). It never blanks out.

**Orchestrator agent (one continuable session per requirement)**

- After decomposition succeeds, a **continuable orchestrator child session** is created
  (`ctx.subagents.startContinuable`) and its id is persisted in `board.json`
  (`requirement.orchestration`). It only summarizes — it never edits code or dispatches tasks.
- On every `success` settlement the task's title, final output and artifacts are sent to it for a
  **≤300-char conclusion** (a `SUMMARY:` section); the conclusion goes into the **shared brief** and the
  task record, and only then is the next ready task released.
- When all tasks finish, it produces the **final summary** (≤800 chars), which becomes the TFS
  conclusion comment; field updates, artifact uploads and linked-task resolution follow as before.
- **Summarization failures never block the chain**: continuable children have **no per-message result**
  (`@deepseek-ai/dsh-subagent/src/run-settlement.ts:1-7`), so completion is observed via
  `subagent/end` + `agent/status` + `sessionQuery` polling, with timeout degradation
  (no summary; final comment falls back to the template and says `总结来源：模板兜底`).
  A provider without continuable support marks the requirement `mode:'off'` with a readable reason.

**Shared brief (stop every subagent from re-deriving the same context)**

- The requirement-level brief holds the requirement digest, workspace, **conclusions of finished tasks**,
  produced artifacts and the **bound MCP/skills**. Dispatch prompts are composed as
  "workspace → **shared brief** → task delta → execution discipline".
- **Key effect**: once the brief has a digest, later tasks' prompts **no longer contain the full
  requirement prompt** (the first task seeds the digest from the requirement body itself, no extra model
  call). This is the hard "saves tokens" assertion, locked by a unit test.
- The brief explicitly lists enabled MCP servers/skills and tells the child to prefer them.

**Task session reuse (same requirement + same provider/preset)**

- With `reuseTaskSessions` (on by default), tasks in the same group reuse **one continuable child
  session**; later tasks are delivered as inbox messages (`sendMessage`).
- The reuse path shares the **same concurrency semaphore** as one-shot dispatch (no accidental fan-out),
  and deliveries for one reuse key are serialized.
- If settlement cannot be observed, the task settles as **failed** with a readable diagnostic — a task is
  **never** left running.
- If reuse fails (provider refuses / session gone), it immediately falls back to one-shot.

> Host facts (with `path:line`) and acceptance scenarios are in `specs/010-orchestrator-chat-shared-brief/`.

---

## 2. Installation

This plugin is **not** part of the host repository's pnpm workspace (`pnpm-workspace.yaml` only takes `packages/*/*`); following the repository precedent of `dsh-optimized-prompt` / `dsh-cli-agents`, it is integrated as an **npm package + bundle patch**.

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

`cordis.patch.yml` (pointed at by `package.json`'s `dsh.bundle.patch`) inserts a single line: this plugin's `tfs-requirment` instance.

> **No MCP instance is declared, and none is needed.** Since 2026-09-19 every TFS read and write goes straight to `/_apis/...` over REST; the adapter dispatches directly instead of calling `ctx.tools.execute('mcp__…')`. So there is no `tfs-mcp` / `serverName` conflict to resolve, and the removed `tfsServerName` config key no longer exists — leftover values in a user profile are ignored by schemastery without error.

---

## 3. How to pass credentials (PAT) in — the step most likely to trip you up

**Conclusion: the PAT must exist in the process environment *before* dsh starts, and it must be declared explicitly in the patch's `env`.**

Evidence (host source code, not speculation):

```
@deepseek-ai/dsh-mcp-client/src/transport.ts:21-23
  function buildChildEnv(extra) { return { ...scrubbedParentEnv(), ...extra } }
```

- `scrubbedParentEnv()` **scrubs credential-shaped environment variables** from the parent process (`*_TOKEN` / `*_PAT` / `*_SECRET` …), so relying only on `export TFS_PAT=...` without declaring it in the patch **does not reach the MCP child process**;
- the patch's `env` (that is, `extra`) **overrides** the scrubbing result in spread order, which is why `cordis.patch.yml` already declares:

```yaml
        env:
          TFS_URL: !!js process.env.TFS_URL || ''
          TFS_COLLECTION: !!js process.env.TFS_COLLECTION || ''
          TFS_PAT: !!js process.env.TFS_PAT || ''
```

- `!!js` is evaluated at **profile configuration parse time** (earlier than any plugin's `apply`), so the plugin **cannot** inject at runtime — which is also why the Connections & credentials page only offers **writing an environment file** (`<dataDir>/tfs-credentials.env`, with `chmod 0600` on a real filesystem) and a **copyable export template**, rather than a button that hot-updates credentials on one click (that is impossible, so we do not fake it).

Recommended flow:

```bash
# 在插件「连接与凭据」页填写档案 → 点「写出环境文件」
source "<dataDir>/tfs-credentials.env"     # PowerShell 用页面上的 $env: 模板
dsh --profile web --port 3099
```

---

## 4. Configuration keys (`cordis.patch.yml` → `tfs-requirment.config`)

| Key | Default | Description |
|---|---|---|
| `collections` | `['WN_HIS']` | Switchable collection list (FR-025). Collections can be switched within this list at runtime |
| `defaultCollection` | `WN_HIS` | Default collection; must be one of `collections` |
| `pollIntervalMinutes` | `5` | Scheduled polling interval for the requirement pool (minutes, minimum 1) |
| `defaultLabel` | `dsh` | Tag applied when claiming a requirement (idempotent; skipped if already present) |
| `maxConcurrentRequirements` | `3` | Maximum number of requirements executing at once (excess queues FIFO) |
| `auditRetentionDays` | `90` | Rolling retention days for audit entries |
| `enabled` | `true` | Master switch |
| `allowModelWrites` | `false` | Allow the **model** to perform TFS writes through the `tfs_req_*` tools. The write gate "user confirmation" counts as satisfied by the panel's **Confirm write-back** and by requirement completion write-back; a model-issued write is not a human confirmation, so with the default `false` it is refused by that gate with a readable reason. Turning it on means deliberately giving up this gate |
| `autoChainTasks` | `true` | Auto-dispatch the next ready task after a success settlement |
| `autoWriteBack` | `true` | Auto write-back to TFS once every task is done |
| `defaultMaxDepth` | `1` | Delegation depth limit for child agents (1 = no grandchildren) |
| `defaultMaxTokens` | `0` | Per-response output token cap (0 = unlimited) |
| `runTimeoutMinutes` | `30` | Per-task total runtime watchdog in minutes (0 = disabled) |
| `orchestratorEnabled` | `true` | Enable the orchestrator agent (summaries); off = no AI summarization |
| `orchestratorProvider` | `''` | Provider used for the orchestrator session (empty = first registered provider) |
| `reuseTaskSessions` | `true` | Reuse one persistent child session per requirement + provider/preset |
| `summarizeTimeoutSeconds` | `120` | Hard timeout for summarization (degrades to "no summary") |
| `summarizeGraceSeconds` | `20` | Grace period before releasing the next task; summarization keeps running in the background and still writes back to the brief |
| `finalizeTimeoutSeconds` | `180` | Hard timeout for the final summary (falls back to the template comment) |
| `finalizeGraceSeconds` | `60` | Grace period for the final summary (no next task is waiting) |
| `taskSessionSettleTimeoutMinutes` | `30` | Settlement observation timeout for reused sessions (settles as failed). `0` is not "disabled": it is folded to 1 millisecond, so **every** reused task fails with "no settlement observed". Must be positive |
| `staleRunningReapMinutes` | `10` | Fake-execution sweep threshold (minutes): a task that has been `in_progress/running` for longer than this **without** a bound sub-session is marked failed and awaits manual review. `0` disables the sweep |
| `staleRunningSweepSeconds` | `60` | Fake-execution sweep cadence (seconds). `0` disables the sweep |
| `queryOptionsConcurrency` | `8` | Maximum number of in-flight metadata HTTP requests while **Collect options** runs (must be ≥ 1). This collection is O(projects × work-item types) — roughly 800 requests on WN_HIS — so an unbounded fan-out opens dozens of simultaneous connections against an on-prem TFS |
| `allowExternalDownloadDir` | `false` | Allow downloads to land **outside** the `downloads/` root. `targetDir` / `options.savePath` are supplied by the caller (possibly the model), so with the default `false` an out-of-root landing spot is refused with a readable reason, and no directory is created. Turn it on only when a deployment genuinely needs another location |

> All of the above except `pollIntervalMinutes` are captured when the plugin loads: changing them in the settings page takes effect **on the next dsh start**. The plugin logs exactly which changed keys are waiting for a restart; `pollIntervalMinutes` applies immediately.
>
> `summarizeTimeoutSeconds`, `summarizeGraceSeconds`, `finalizeTimeoutSeconds`, `finalizeGraceSeconds` and `taskSessionSettleTimeoutMinutes` have no "disabled" form: `0` is folded to the smallest positive value and therefore means "fail immediately", not "unlimited".

Numeric lower bounds (such as `pollIntervalMinutes ≥ 1`) are enforced at runtime by `validateConfig`; the settings page validates before saving.

---

## 5. Where the data lands

Everything lives in the plugin data directory (the host `dataDir` service; when it is missing this falls back to `$DSH_DATA_DIR` or `./.tfs-requirment-data`):

| File | Contents | Authority |
|---|---|---|
| `board.json` | Board state (requirement pool + tasks + version number). Since spec 010 it also carries requirement-level `orchestration` (orchestrator session id / shared brief / task-session reuse table) and task-level `orchestration` (session id / reused or not / summarized conclusion) | **Authoritative**. On a parse failure the original file is kept and reconstruction is refused; an old file missing these two optional fields is read as "orchestration off" |
| `events.jsonl` | Board change events (append-only) | For auditing and reconciliation |
| `.ai-board/计划看板.md` | The rendered Markdown board | Derived; can be re-rendered at any time |
| `roles.json` | Role definitions | Authoritative |
| `audit.jsonl` | Write-operation audit (**credential fields stripped before writing to disk**) | append-only; the plugin cannot delete or modify it |
| `audit-archive-YYYYMMDD.jsonl` | Archive of expired audit entries | Archiving does not modify the live log |
| `profiles.json` | Connection profiles (**contains the plaintext PAT**, held internally only and never echoed back out) | Overwritten with random bytes on deletion |
| `profile-active.json` | Active profile pointer | — |
| `query-options.json` | Cache of the requirement-pool dropdown options per collection (project/type/state/assignee + savedAt) | Deletable; rebuilt by **Collect options** |
| `ui-state.json` | Per-collection UI memory (filter conditions, page size of the three lists) | Deletable; falls back to the defaults |
| `downloads/` | Download directory for attachments / TFVC files (written per work item or repository path, with traversal protection) | Derived |
| `tfs-credentials.env` | Startup environment file (contains the plaintext PAT; `chmod 0600` is applied on a best-effort basis when written) | For `source` |

> `profiles.json` / `tfs-credentials.env` contain the plaintext PAT: **do not commit them to the repository and do not paste them into chats or tickets.** At the deployment level, restrict access to the data directory (this plugin does its best to tighten the environment file to `0600` through `FsLike.chmodSync`, but an in-memory filesystem or a deployment that does not support that call cannot be tightened; in that case the panel **honestly displays** `hardened: false`).

---

## 6. Development and gates

```bash
npm run typecheck   # 三个编译程序：host / client / tests
npm test            # vitest run
npm run build       # tsc×2 + tsdown → lib/
```

Test layers: pure logic (board/decompose/poll/write-guard/audit-archive/profile-service), host orchestration (host-api/host-route), and wiring assembly (board-service/e2e, using an in-memory fs plus a stubbed adapter/subagents). `tests/e2e.spec.ts` assembles **all the real modules** except `ctx.tools` / `ctx.subagents` and is the main line of defense against wiring mistakes.

No runtime invariant companion is published because no assertion here compares two observations that could drift apart: TFS state is read from the live REST API and validated at that boundary, so a mismatch is reported to the caller rather than checked against a second copy.

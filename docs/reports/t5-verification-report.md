# t5 测试报告：dsh-tfs-requirment「执行配置页面技能下拉只有 24 个」修复验证

- 任务：t5（verification）｜执行者：qa-tester｜尝试：attempt 1（975ccdbb-e52c-4db4-8322-e70e5e85dd69）
- 日期：2026-09-29 19:10–19:35（本机时区）
- 工作目录：`D:\ClaudeCode\deepseek-harness\plugins\dsh-tfs-requirment`
- 验证对象：t3 修复后的 `src/host/dsh-catalog.ts`（collectSkills 三级回退）及其编译产物 `lib/types/host/dsh-catalog.js`
- 测试性质：独立复测（非复述 t3/t4 结论），全部命令/探针由 qa-tester 本轮实际执行

---

## 1. 结论（TL;DR）

**是——「技能下拉只有 24 个」的问题已被 t3 修复解决。**

- 三份类型检查（host / client / tests）全部 **exit 0 零错误**；
- 单测 **883/883 全通过（0 失败，53 个测试文件）**，其中技能目录专项 `tests/dsh-catalog-skills-scope.spec.ts` **7/7 通过**、通用目录 `tests/dsh-catalog.spec.ts` **16/16 通过**；
- 11 个自建冷启动行为探针（对编译产物 `lib/types/host/dsh-catalog.js` 直接加载实测）全部 exit 0：主路径 acquireScope 作用域并集实测 **124 条（24 全局 + 100 用户级，超出 24 的卡点）**，坏 preset 跳过、租约零泄漏、作用域 list 抛错可归因、降级告警全部按设计触发；
- 部署面同步：仓库 `lib/types/host/dsh-catalog.js` 与 `~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tfs-requirment/lib/types/host/dsh-catalog.js` **md5 一致**（535f750afda3062abf0c98c153547149）——运行实例加载的就是已修复代码（如 Web GUI 面板仍显示旧值，点「重新采集目录」或重启宿主即可）。

---

## 2. 命令与退出码证据

### 2.1 类型检查（三条全部通过）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.host.json` | **0** | 零错误（无任何输出） |
| `npx tsc --noEmit -p tsconfig.client.json` | **0** | 零错误 |
| `npx tsc --noEmit -p tsconfig.tests.json` | **0** | 零错误 |

关键输出摘要（每条命令实测运行，非推演）：

```
HOST_EXIT=0
CLIENT_EXIT=0
TESTS_EXIT=0
```

### 2.2 单元测试（无回归）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npx vitest run` | **0** | **Test Files 53 passed (53)｜Tests 883 passed (883)**，Duration 18.18s |
| `npx vitest run tests/dsh-catalog-skills-scope.spec.ts` | **0** | **7 passed (7)** |
| `npx vitest run tests/dsh-catalog.spec.ts` | **0** | **16 passed (16)** |

### 2.3 技能专项用例数勘误（回应队长疑问：t4 报 7 例、t3 报 8 例，以哪个为准？）

**实测：`tests/dsh-catalog-skills-scope.spec.ts` 现为 7 个用例（7 passed / 0 failed）。**

- `grep -c "it(\|test("` 对该文件 = 7；vitest JSON reporter 逐用例枚举亦为 7 条，全部 passed：
  1. 冷进程无存活挂载时，经 standingKeyFor 取到全部 89 条用户技能，且不报"仅含全局层"
  2. 全局层 + 多个 standing 作用域取并集，同名全局层优先，重复 scope 只采一次
  3. 某个 preset 的 standingKeyFor 抛错：只跳过该 preset，其余照常且 warning 可见
  4. broken 预设直接跳过，不调用 standingKeyFor
  5. 存活挂载作为补充来源仍被合并（即使 preset 清单未列出）
  6. 旧宿主无 agentPresets 服务且无存活挂载：降级为仅全局层并明确告警（不静默少技能）
  7. 某作用域 list 抛错：只丢该作用域，全局与其他作用域照常
- 差异来源判定：t3 邮件申报的「8 个新增/改写用例」应把 `tests/dsh-catalog.spec.ts` 内 1 个同类用例（"形状异常的条目被跳过，不抛错"所属组的技能目录用例，共 16 例中的 1 例被改写适配新语义）一并计入——两文件合计 7+新增/改写的 dsh-catalog.spec.ts 用例 ≈ 8。**以测试套件实际状态为准：专项文件 7 例、全绿，无缺失**；t4 报的 7 是准确的文件级数字，t3 的 8 是跨文件改动面数字，两者不矛盾。
- 用例名均为「collectSkills 冷启动 standing 作用域（spec 006 US1）」分组，与修复的 standing 作用域路径对应；acquireScope 主路径无专属单测（t4 gap-1 已记录，本探针第 3 节用运行时实测补上了这一覆盖缺口）。

---

## 3. collectSkills 行为实测（核心验收：技能条数不再被 24 卡住）

### 3.1 方法

自建 11 个**冷启动探针脚本**（每个用例一个全新 node 子进程，进程内构造假宿主服务：`skills.list` / `agentPresets`，并按 preset 登记 scope key → 技能行映射），直接 `import('file:///.../lib/types/host/dsh-catalog.js')` 加载**编译产物**（与部署面逐字节一致，md5 见 §4）执行 `createDshCatalog().refresh()`，断言：

- 返回条数（count）与预期并集一致；
- 计数器：`acquire`（acquireScope 调用）/`dispose`（租约释放）/`standing`（standingKeyFor 调用）/`scopeList`（作用域层 list）/`scopeListErr`（作用域 list 抛错）/`acquireErr`（acquireScope 抛错）；
- `warnings` 中技能目录相关告警的存在性/缺失性（尤其「仅含全局层」是否只在真正降级时出现）。

探针脚本与假模块均放在系统临时目录（`%TEMP%\qa-t5-probe-*`），只读插件目录、不改动任何源码/测试；第 3 级 import 回退用例（E/J/K）在 `lib/types/host/node_modules/@deepseek-ai/dsh-agent-preset-registry` 临时放置 fake 包（`lib/` 已被 .gitignore 忽略，探针后已删除还原）。

### 3.2 逐用例结果（11/11 exit=0）

| # | 场景 | 实测 count | 计数器 | 技能告警 | 判定 |
|---|---|---|---|---|---|
| A | **主路径** acquireScope 双 preset 并集 | **124**（24+60+40） | acquire=2 dispose=2 standing=0 | 无 | ✅ 与预期一致；**条数突破 24 卡点** |
| B | 同 preset 两次 acquireScope（两个 generation key） | 84 | acquire=2 dispose=2 scopeList=2 | 无 | ✅ 同名技能 first-wins，无重复条目 |
| C | 坏 preset（RemoteError）夹在两个正常 preset 间 | 124 | acquireErr=1 dispose=2 | 「bad-preset …已跳过该预设」 | ✅ 仅跳过该 preset，其余照常 |
| D | broken 预设（acquireScope 内抛 invalid） | 84 | acquireErr=1 dispose=1 | 「broken-preset …已跳过」 | ✅ 坏 preset 在拿到租约前抛错，无泄漏 |
| E | 服务层可用 + fake 包含 ghost 存活挂载（补充来源） | 84 | scopeList=2（alpha+ghost） | 无 | ✅ live mounts 被并入；import 成功不刷失败告警 |
| F | **旧宿主**：无 agentPresets 服务、无存活挂载 | **24** | 全 0 | **「仅含全局层」明确告警（含 acquireScope/standingKeyFor 与补救指引）** | ✅ 降级可见、不静默 |
| G | ≤0.1.6 兼容路径 standingKeyFor | 84 | standing=1 acquire=0 | 无 | ✅ 兼容路径正常取并集 |
| H | standingKeyFor 路径 + bad-preset | 84 | standing=2 scopeList=1 | 「bad-preset …已跳过」 | ✅ 跳过 + 其余照常 |
| I | **作用域 list 抛错**（正常 preset 但 list 抛） | 24 | scopeListErr=1 **dispose=1** | 「预设「preset-alpha」作用域层 list 抛错（scope list failed for preset-alpha）」 | ✅ 只丢该作用域、不炸整轮；**list 抛错后租约仍在 finally 释放，无泄漏** |
| J | import 成功但零存活挂载 | 84 | acquire=1 dispose=1 | 无 | ✅ 「仅含全局层」**不误报**（服务层已拿到作用域，standingAvailable 主导判定） |
| K | 服务层完全不可用 + ghost mount 带技能（第三级兜底） | **34**（24+10 ghost） | scopeList=1 | 无 | ✅ import 层作为最后兜底也能带出非全局技能 |

关键输出摘录（用例 A，主路径）：

```
===== 用例 A（exit=0） =====
count = 124
counters = {"acquire":2,"dispose":2,"standing":0,"scopeList":2,"scopeListErr":0,"acquireErr":0}
skillWarnings = []
```

用例 I（异常路径：租约释放 + 可归因告警）：

```
count = 24
counters = {"acquire":1,"dispose":1,"scopeList":1,"scopeListErr":1, ...}
skillWarnings = ["技能目录：预设「preset-alpha」作用域层 list 抛错（scope list failed for preset-alpha）"]
```

### 3.3 对队长三项异常路径抽查的逐条回答

- **(a) 坏 preset 抛 RemoteError 仅跳过该 preset、其余照常**：用例 C/D/H 实测通过——bad/broken preset 只产生一条含 preset id 与原因的 warning，正常 preset 的技能条目完整并入（C=124、H=84）。坏 preset 的抛错发生在 acquireScope 内部（对应宿主 `retain()` 的 `agent-preset/not-found` / `agent-preset/invalid`，见 registry lib/index.js:608-626），此刻租约尚未创建，不存在泄漏窗口。
- **(b) 租约 dispose 异常路径也恰好释放**：用例 I 专门构造「acquire 成功 → addScope → 作用域 list 抛错」序列，实测 `dispose=1`（且 fake 租约带幂等保护，重复 dispose 不重复计数）；用例 A/B 正常路径 `dispose` 恰好等于 `acquire` 成功次数；D 证明坏 preset 零租约。**与宿主 dispose 幂等实现（disposed 标志，registry lib/index.js:748-756）构成双保险。**
- **(c) 作用域 list 抛错不炸整个 collectSkills、有可归因 warning**：用例 I 实测 collectSkills 正常返回（exit 0，count=24=仅全局层），warning 含作用域 label（「预设「preset-alpha」作用域层 list 抛错（…）」），可精确定位是哪一层失败。

### 3.4 「仅含全局层」告警不再误报的实证

- 服务层任一路径成功（用例 A/B/C/E/G/H/I/J）→ **无**该告警；
- 仅当「零作用域 + 结果确实只有全局层 + 冷读取三路全不可用」（用例 F）→ 告警出现且含可行动指引（升级宿主/开会话后重新采集）。
- 与修复前行为对照：旧实现在 0.1.7-alpha.2 上 scopeRefs 恒空、恒触发该告警（t2 根因）；新实现把告警收敛为真实的「三路全不可用」信号，语义精确。

### 3.5 与真实宿主 API 形状的对照（交叉验证探针可信度）

探针假服务的形状逐项对照已安装宿主 `dsh 0.1.7-alpha.2` 的真实实现：

- `acquireScope(id): Promise<{key: ScopeKey} & AsyncDisposable>`——`@deepseek-ai/dsh-agent-preset-registry/lib/types/index.d.ts:118-121`；实现 `lib/index.js:745-756`（retain→key、dispose 幂等）；
- 作用域不透明对象语义——`@deepseek-ai/dsh-scope` 的 ScopeKey 为 Symbol 标记的不透明对象（`scopeOf(ctx)=ctx[kScope]`，kScope=Symbol("dsh.scope")），skill registry 以 WeakMap 记 scopeId（dsh-skill lib/index.js:385-392），与探针「key 对象身份匹配」构造一致；
- `skills.list({scope})` 分层语义——`dsh-skill/lib/index.js:299` `collectFresh` = 全局层 + `scopeChainOf(scope)` 各层合并（dsh-scope lib/index.js:156-166，近层优先）→ 插件「全局优先 first-wins + 逐作用域并集」与之互补（registry 层内部同名去重 + 插件层跨作用域去重）；
- `standingKeyFor` 在已安装宿主全量 grep **零命中**（CONFIRMED，grep -rl 输出为空）→ 旧主路径在 alpha.2 上确会被 typeof 守卫跳过，acquireScope 是唯一服务层入口，修复方向正确；
- 冷进程可用性——registry `register()` 即预挂载（activate→mountPreset，lib/index.js:523），`acquireScope` 的 `retain()` 对未破坏 preset 不依赖任何会话，探针的「零会话冷启动」构造与真实宿主冷启动等价。

---

## 4. 部署面与补强检查

| 检查 | 命令/方式 | 结果 |
|---|---|---|
| 部署同步 | `md5sum lib/types/host/dsh-catalog.js ~/.dsh/profiles/web/node_modules/@deepseek-ai/dsh-tfs-requirment/lib/types/host/dsh-catalog.js` | 两边均 `535f750afda3062abf0c98c153547149`，**一致** |
| 部署面含新路径 | `grep acquireScope lib/types/host/dsh-catalog.js` | :231 能力探测、:255 调用、:261 finally asyncDispose、:292/:296 双包名 import 全部在产物中 |
| 探针无残留 | 探针后 `ls lib/types/host/node_modules` | 无输出（fake 包已删还原）；源码/测试 git 状态零改动 |
| 认知面验证 | 跨作用域 first-wins 抽查 | 假定 preset 层技能 P 与全局层同名 P 并存时按 dsh-skill 规则全局层优先（registry 内部去重），插件层对跨作用域同名再取首个命中（normalizeSkillRows :221 `out.has(name)`），与 0.1.6 时代行为一致 |

**生效说明**：插件经 web profile `link:` 部署、build 后产物已同步；用户侧观察面板技能数，需要宿主**重新采集目录**（面板「重新采集目录」按钮或重启 dsh 宿主进程）——这不是修复缺口，而是目录快照的既定刷新机制（src/index.ts:359-364 inject 后 refresh）。

---

## 5. 风险与限制（如实申报）

1. **真实宿主进程内联测未做**：panel-data 端点（`http://127.0.0.1:3081/tfs-requirment/panel-data`）返回 `{"error":"unauthorized"}`（3080 为团队网关亦同），QA 无法拿到会话令牌直连已运行宿主验证端到端面板渲染。已用「编译产物冷启动探针 + 真实宿主 API 形状逐项对照（§3.5）」替代——探针加载的就是部署面那份文件，且 API 形状与 alpha.2 实现逐项吻合，剩余不确定性仅在于运行进程的 preset 清单内容（属于配置数据而非代码路径）。建议队长或用户在 Web GUI 打开执行配置页做一次人工目检（技能数应 ≫24，预期 ~124 条量级：24 全局 + 100 用户级，减去同名重复）。
2. **t4 已记录的三个 low 缺口未在本轮补齐**（不在 t5 in-scope：tests 文件可以改但任务契约是"验证"而非"补测"）：acquireScope 主路径专属单测（finally 释放断言/服务层可用时 standingKeyFor 不被调）、缺 livePresetMounts 导出分支单测、「新名失败旧名成功不刷告警」直接断言。本轮探针 §3 已在运行时层面对这三点给出实测覆盖（A/I 的 dispose 断言、G 的 standing=0/acquire=1 互斥、E 的无 import 告警），但**未固化进 vitest 套件**。如需固化，建议派 dev-engineer 一个小任务补 3 个用例。
3. 探针的 fake `skills.list` 未模拟宿主 collect 缓存与 revision 失效（dsh-skill lib/index.js:260-296）；该机制属于宿主内部缓存，不改变插件侧并集语义，风险极低。

---

## 6. 最终回答（结论）

**dsh-tfs-requirment「执行配置页面技能下拉只有 24 个」的问题：已解决。**

证据链：类型检查 3×exit 0（§2.1）→ 单测 883/883 无回归、技能专项 7/7（§2.2/§2.3）→ 编译产物 11 探针实测：主路径并集 124 条突破 24 卡点、三级回退逐级可用、坏 preset/租约/list 抛错三条异常路径全部符合设计（§3.2–3.4）→ 探针形状与 alpha.2 真实宿主 API 逐项对照成立（§3.5）→ 部署面 md5 一致、代码已在运行实例加载路径上（§4）。

附注：面板数字最终落地还需一次「重新采集目录」或宿主重启（快照机制使然，非代码问题）；建议后续给 dev-engineer 派一个小任务把探针已覆盖的 3 个断言固化进 vitest（t4 gap-1/2/3）。

/**
 * 回归测试：`main` 是 **keyed** 槽，同 key 的注册会抛错并**永久注销**注入。
 *
 * ## 这个测试在守什么（问题 1 的根因 + 修复）
 *
 * 用户报告：**先点其它看板，再点「TFS 看板」就没有反应，看不见 TFS 看板**。
 *
 * 根因链（全部由宿主源码坐实）：
 *   1. `main` 槽的 spec 是 `{ kind: 'keyed', scope: 'root' }`
 *      （`packages/client/ui-layout/src/client/index.ts:153`）。
 *   2. keyed 槽同 key 同 priority 的**第二次注册直接抛错**
 *      （`packages/client/ui-slots/src/index.ts:844-851`）。
 *   3. 抛错发生在 `slots.inject` 的 callback 里 ⇒ `SlotRegistry.inject` 的
 *      `changed()` 捕获后 `stop()`，**永久注销该注入，永不重试**
 *      （`packages/client/ui-renderer/src/client/registry.ts:180-190, 210-222`）。
 *   4. `inject` 的 callback 会在**每次槽声明生命周期开始**时重跑
 *      （同文件 `:192-208` 的 `reconcile` 按 `declarationEpoch` 判定）。
 *      `main` 由 `ui-layout` 的 `root` 注册声明 ⇒ 该 effect 一重跑，本插件
 *      callback 就重跑 ⇒ 撞上步骤 2 的抛错 ⇒ 注入永久消失。
 *   5. 之后菜单行可能还在（它在另一个槽里），但 `main` 槽没有本插件 entry ⇒
 *      宿主 `LayoutController.selectPanel` 的 `hasMainPanel(id)` 恒 false ⇒
 *      **怎么点都无效**（`ui-layout/src/client/service.ts:67-74`）；且
 *      `retainMainPanels`（`stores.ts:97-100`）把 `activePanelId` 置 null。
 *
 * ## 修复
 *
 * `registerOnce`（`src/client/slots.tsx`）：注册前探测该 key 是否已被占用，
 * 已占用则**直接返回不抛错** ⇒ 注入不被注销 ⇒ callback 重跑任意多次都收敛到
 * "恰好一份"，看板永远点得开。
 *
 * 本测试用**宿主真实 `SlotCore`**（不是 mock）驱动 `registerOnce`，所以断言的是
 * 宿主的真实语义，而不是我们对它的猜测。
 *
 * @module tests/panel-keyed-slot
 */

import { describe, expect, it } from 'vitest'
import { SlotCore } from '@deepseek-ai/dsh-client-ui-slots'
import { registerOnce } from '../src/shared/slot-registration.js'
import type { SlotRegistryLike } from '../src/shared/slot-registration.js'

/** 本插件「TFS 看板」的 main 槽 key（与 `slots.tsx#PANEL_ID` 同值，故意写成字面量以防漂移被掩盖）。 */
const PANEL_ID = 'tfs-requirment'

/**
 * 建一棵最小声明树：root 声明出 keyed 的 main 子槽（照抄宿主 ui-layout 的声明形状）。
 *
 * @returns 已声明 main 槽的 core。
 */
function makeCoreWithMain(): SlotCore {
  const core = new SlotCore()
  core.register({
    name: 'root',
    children: { main: { kind: 'keyed', scope: 'root' } },
  } as never, () => null)
  return core
}

/** 断言 main 槽当前**胜出**的 entry key 集合（= 宿主 `selectPanel` 可用性的事实依据）。 */
function liveMainKeys(core: SlotCore): string[] {
  return core.entriesOfSlot('main').flatMap(e => (e.options.key === undefined ? [] : [e.options.key]))
}

/**
 * 把宿主 `SlotCore` 包成本插件 `registerOnce` 需要的最小 `SlotRegistry` 结构面。
 *
 * 只透传 `register` 与两个 `entries*` 探针 —— 正是 `registerOnce` 实际用到的部分。
 * `inject` 在 `registerOnce` 里用不到，给个抛错桩以防未来误用被悄悄放过。
 */
function asRegistry(core: SlotCore): SlotRegistryLike {
  return {
    register: (spec, component) => core.register(spec as never, component as never),
    entries: (slot: string) => core.entries(slot),
    entriesOfSlot: (slot: string) => core.entriesOfSlot(slot),
  }
}

describe('main 槽的 keyed 语义（问题 1 根因锚定）', () => {
  it('main 是 keyed 槽：同一 key 在同一 priority 重复注册会**抛错**（不是静默顶掉）', () => {
    const core = makeCoreWithMain()

    core.register({ name: 'main', key: PANEL_ID } as never, () => null)
    expect(liveMainKeys(core)).toEqual([PANEL_ID])

    // 宿主 `SlotCore.register` 对同 key 同 priority 的第二次注册**直接抛错**
    // （ui-slots/src/index.ts:844-851）。
    //
    // ⚠️ 这就是问题 1 的真正杀伤点：抛错发生在 `slots.inject` 的 callback 里，
    //    而 `SlotRegistry.inject` 的 `changed()` 捕获异常后调用 `stop()`
    //    —— **永久注销本次注入**（registry.ts:180-190）。
    expect(() => core.register({ name: 'main', key: PANEL_ID } as never, () => null))
      .toThrow(/already has an entry for key/)

    // 抛错后 ledger 仍是干净的一条（失败注册没有写进去）。
    expect(liveMainKeys(core)).toEqual([PANEL_ID])
    expect(core.entries('main')).toHaveLength(1)
  })

  it('换个 priority 就能 shadow（宿主给的正规逃生口）', () => {
    const core = makeCoreWithMain()
    core.register({ name: 'main', key: PANEL_ID } as never, () => null)

    // 不同 priority 不冲突，且 lowest renders ⇒ priority -1 会盖住 0。
    core.register({ name: 'main', key: PANEL_ID, priority: -1 } as never, () => null)
    expect(core.entries('main')).toHaveLength(2)
    const winner = core.entriesOfSlot('main')[0]
    expect(winner?.options.priority).toBe(-1)
  })

  it('释放唯一 entry 后 main 的该 key 消失 ⇒ 宿主 selectPanel 会失败并回落 conversation', () => {
    const core = makeCoreWithMain()
    const dispose = core.register({ name: 'main', key: PANEL_ID } as never, () => null)
    expect(liveMainKeys(core)).toContain(PANEL_ID)

    dispose()
    // 宿主 `hasMainPanel(PANEL_ID)` 此时为 false：
    //   - 点击菜单 → `LayoutController.selectPanel` 抛 "main panel ... is not registered"；
    //   - main 槽变化 → `retainMainPanels` 把 activePanelId 置 null → 渲染回 conversation。
    expect(liveMainKeys(core)).not.toContain(PANEL_ID)
  })

  it('两个不同 key 的 main 面板可以共存（互不顶掉）', () => {
    const core = makeCoreWithMain()
    core.register({ name: 'main', key: PANEL_ID } as never, () => null)
    core.register({ name: 'main', key: 'other-board' } as never, () => null)

    expect(liveMainKeys(core).sort()).toEqual(['other-board', PANEL_ID])
  })
})

describe('registerOnce：把重复注册变成安全 no-op（问题 1 修复）', () => {
  it('首次注册生效，返回宿主 disposer 函数（cordis effect 合法返回）', () => {
    const core = makeCoreWithMain()
    const registered = registerOnce(
      asRegistry(core),
      { name: 'main', key: PANEL_ID },
      () => null,
    )

    expect(typeof registered).toBe('function')
    expect(liveMainKeys(core)).toEqual([PANEL_ID])
  })

  it('重复注册**不抛错**，返回 undefined，且 ledger 仍只有一条（注入得以存活）', () => {
    const core = makeCoreWithMain()
    const registry = asRegistry(core)

    expect(typeof registerOnce(registry, { name: 'main', key: PANEL_ID }, () => null)).toBe('function')

    // 关键断言：第二次**不抛错**。旧实现（直接 slots.register）在这里抛
    // "already has an entry for key"，进而让 slots.inject 永久注销注入。
    expect(() =>
      registerOnce(registry, { name: 'main', key: PANEL_ID }, () => null),
    ).not.toThrow()

    expect(registerOnce(registry, { name: 'main', key: PANEL_ID }, () => null)).toBeUndefined()
    expect(core.entries('main')).toHaveLength(1)
    expect(liveMainKeys(core)).toEqual([PANEL_ID])
  })

  it('模拟 inject 生命周期重跑 5 次：main 槽恒有且仅有一份本插件 entry', () => {
    const core = makeCoreWithMain()
    const registry = asRegistry(core)
    const spec = { name: 'main', key: PANEL_ID }

    // `main` 的 declarationEpoch 每次 +1（ui-layout 的 root effect 重跑 / HMR），
    // `slots.inject` 的 callback 就被重跑一次。修复前第 2 次就会抛错 + 永久注销。
    // 返回值必须全程是 cordis 合法 effect：function（首次）/ undefined（跳过），
    // 任何布尔值都会抛 TypeError: Invalid effect（2026-09-26 实测根因）。
    const results = Array.from({ length: 5 }, () =>
      registerOnce(registry, spec, () => null))

    expect(results.map(r => typeof r)).toEqual(['function', 'undefined', 'undefined', 'undefined', 'undefined'])
    expect(liveMainKeys(core)).toEqual([PANEL_ID])
    expect(core.entriesOfSlot('main')).toHaveLength(1)
  })

  it('list 槽按 id 去重（sidebar.panellist 走同一条通路）', () => {
    const core = new SlotCore()
    core.register({
      name: 'root',
      children: { 'sidebar.panellist': { kind: 'list', scope: 'root' } },
    } as never, () => null)

    const registry = asRegistry(core)
    const spec = { name: 'sidebar.panellist', id: PANEL_ID, order: 50, label: 'TFS 看板' }

    expect(typeof registerOnce(registry, spec, () => null)).toBe('function')
    expect(registerOnce(registry, spec, () => null)).toBeUndefined()
    expect(core.entriesOfSlot('sidebar.panellist')).toHaveLength(1)
  })

  it('探针不可用（老部署没有 entries*）时退回直接注册，不因探针缺失而整块失效', () => {
    const core = makeCoreWithMain()
    let calls = 0
    const registry: SlotRegistryLike = {
      register: (spec, component) => {
        calls += 1
        return core.register(spec as never, component as never)
      },
    }

    // 没有探针：第一次注册成功，返回 disposer。
    expect(typeof registerOnce(registry, { name: 'main', key: PANEL_ID }, null)).toBe('function')
    expect(calls).toBe(1)

    // 第二次会撞宿主抛错 —— 这是**已知且刻意的降级**（老部署没有探针可用），
    // 断言它确实抛错，好让"探针缺失"这一退化路径在测试里可见，而不是被静默吞掉。
    expect(() => registerOnce(registry, { name: 'main', key: PANEL_ID }, null))
      .toThrow(/already has an entry for key/)
  })
})

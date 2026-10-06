// @vitest-environment jsdom
/**
 * 问题 1（B1）修复的回归网：DOM 接管型面板（任务看板/SSH）驱逐协议。
 *
 * 锁定 `src/client/takeover.ts` 的三条对外承诺：
 *  1. `<html>` 上存在接管属性时，派发对方约定的 `dsh-panel-activate` 兄弟名事件，
 *     并**兜底移除属性**（事件无人消费时 CSS 隐藏规则同样失效）；
 *  2. capture 点击监听：点在本插件面板行内（钩子在 svg 上，真实点击 target 可能是
 *     svg、span 或按钮本身）都必须触发驱逐；点面板外不得触发；
 *  3. dispose 后监听解绑（不泄漏到插件卸载后的文档）。
 *
 * @module tests/takeover
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  bindPanelRowEviction,
  evictTakeoverPanels,
  PANEL_ROW_HOOK,
} from '../src/client/takeover.js'

const TB_ATTR = 'data-dsh-taskboard-active'
const SSH_ATTR = 'data-dsh-ssh-active'
const EVENT = 'dsh-panel-activate'

/** 收集 document 上收到的激活事件 detail。 */
function watchActivations(): string[] {
  const seen: string[] = []
  document.addEventListener(EVENT, (e) => seen.push((e as CustomEvent).detail as string))
  return seen
}

beforeEach(() => {
  document.documentElement.removeAttribute(TB_ATTR)
  document.documentElement.removeAttribute(SSH_ATTR)
  document.body.innerHTML = ''
})

afterEach(() => {
  document.documentElement.removeAttribute(TB_ATTR)
  document.documentElement.removeAttribute(SSH_ATTR)
})

describe('evictTakeoverPanels（挂载/激活时驱逐）', () => {
  it('任务看板接管中：派发 ssh 兄弟事件并移除接管属性', () => {
    const seen = watchActivations()
    document.documentElement.setAttribute(TB_ATTR, '')
    evictTakeoverPanels()
    expect(seen).toContain('ssh')
    expect(document.documentElement.hasAttribute(TB_ATTR)).toBe(false)
  })

  it('SSH 接管中：派发 taskboard 兄弟事件并移除接管属性', () => {
    const seen = watchActivations()
    document.documentElement.setAttribute(SSH_ATTR, '')
    evictTakeoverPanels()
    expect(seen).toContain('taskboard')
    expect(document.documentElement.hasAttribute(SSH_ATTR)).toBe(false)
  })

  it('无接管时只广播自身激活，不派发兄弟事件', () => {
    const seen = watchActivations()
    evictTakeoverPanels()
    expect(seen).toEqual(['tfs-requirment'])
  })

  it('broadcast=false 时不广播自身激活（挂载+点击同帧去重场景）', () => {
    const seen = watchActivations()
    evictTakeoverPanels(false)
    expect(seen).toEqual([])
  })

  it('内部异常被收敛为 warn，不向调用方抛出（壳层兼容不能拖垮 GUI）', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const orig = CustomEvent
    ;(window as unknown as { CustomEvent: unknown }).CustomEvent = () => {
      throw new Error('boom')
    }
    expect(() => evictTakeoverPanels()).not.toThrow()
    ;(window as unknown as { CustomEvent: typeof CustomEvent }).CustomEvent = orig
    spy.mockRestore()
  })
})

describe('bindPanelRowEviction（行点击链路）', () => {
  it('点击钩子 svg 本身触发驱逐（接管属性被清掉）', () => {
    document.body.innerHTML = `<button aria-label="TFS 看板"><span><svg ${PANEL_ROW_HOOK}=""></svg></span></button>`
    const dispose = bindPanelRowEviction()
    document.documentElement.setAttribute(TB_ATTR, '')
    document.querySelector('svg')!.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    expect(document.documentElement.hasAttribute(TB_ATTR)).toBe(false)
    dispose()
  })

  it('合成 click 以 button 为 target（点到按钮 padding）也触发驱逐', () => {
    document.body.innerHTML = `<button aria-label="TFS 看板"><span><svg ${PANEL_ROW_HOOK}=""></svg></span></button>`
    const dispose = bindPanelRowEviction()
    document.documentElement.setAttribute(TB_ATTR, '')
    // 与宿主 SidebarRoot 行点击 / 自动化 .click() 一致：target=button，钩子在其内部
    document.querySelector('button')!.click()
    expect(document.documentElement.hasAttribute(TB_ATTR)).toBe(false)
    dispose()
  })

  it('点击不含钩子的其他行不触发（不能误伤任务看板/SSH/会话行）', () => {
    document.body.innerHTML = `<button aria-label="任务看板"><svg></svg></button>`
    const dispose = bindPanelRowEviction()
    document.documentElement.setAttribute(TB_ATTR, '')
    document.querySelector('button')!.click()
    // 任务看板自己的行：属性应原样保留
    expect(document.documentElement.hasAttribute(TB_ATTR)).toBe(true)
    dispose()
  })

  it('dispose 后再点行不再触发（随插件 fiber 卸载，无悬挂监听）', () => {
    document.body.innerHTML = `<button aria-label="TFS 看板"><svg ${PANEL_ROW_HOOK}=""></svg></button>`
    const dispose = bindPanelRowEviction()
    dispose()
    document.documentElement.setAttribute(TB_ATTR, '')
    document.querySelector('button')!.click()
    expect(document.documentElement.hasAttribute(TB_ATTR)).toBe(true)
  })
})

/**
 * PanelOpenControl（旧 / 精简宿主上连接 footer.action 入口与 shell.overlay 面板的
 * 开关控制器）的可执行单元测试。
 *
 * 该控制器是「TFS 看板」入口按钮能在无 main 槽宿主上打开全屏面板的关键，
 * API 对齐 React useSyncExternalStore（subscribe / getSnapshot）。
 */

import { describe, expect, it } from 'vitest'
import { PanelOpenControl } from '../src/shared/panel-open-control.js'

describe('PanelOpenControl', () => {
  it('初始为关闭', () => {
    const c = new PanelOpenControl()
    expect(c.getSnapshot()).toBe(false)
  })

  it('show 后打开并通知订阅者', () => {
    const c = new PanelOpenControl()
    const seen: boolean[] = []
    c.subscribe(() => seen.push(c.getSnapshot()))
    c.show()
    expect(c.getSnapshot()).toBe(true)
    expect(seen).toEqual([true])
  })

  it('hide 后关闭并通知订阅者', () => {
    const c = new PanelOpenControl()
    c.show()
    const seen: boolean[] = []
    c.subscribe(() => seen.push(c.getSnapshot()))
    c.hide()
    expect(c.getSnapshot()).toBe(false)
    expect(seen).toEqual([false])
  })

  it('已打开时再 show 为 no-op，不产生多余通知', () => {
    const c = new PanelOpenControl()
    let calls = 0
    c.subscribe(() => calls++)
    c.show()
    c.show()
    expect(c.getSnapshot()).toBe(true)
    expect(calls).toBe(1)
  })

  it('已关闭时再 hide 为 no-op', () => {
    const c = new PanelOpenControl()
    let calls = 0
    c.subscribe(() => calls++)
    c.hide()
    expect(c.getSnapshot()).toBe(false)
    expect(calls).toBe(0)
  })

  it('退订后不再收到通知，且退订幂等', () => {
    const c = new PanelOpenControl()
    let calls = 0
    const unsub = c.subscribe(() => calls++)
    unsub()
    unsub()
    c.show()
    expect(calls).toBe(0)
  })

  it('多个订阅者都被通知', () => {
    const c = new PanelOpenControl()
    let a = 0
    let b = 0
    c.subscribe(() => a++)
    c.subscribe(() => b++)
    c.show()
    expect(a).toBe(1)
    expect(b).toBe(1)
  })

  it('在通知回调中退订不影响本次其余订阅者被通知', () => {
    const c = new PanelOpenControl()
    const order: string[] = []
    const unsubA = c.subscribe(() => {
      order.push('a')
      unsubA()
    })
    c.subscribe(() => order.push('b'))
    c.show()
    expect(order).toEqual(['a', 'b'])
  })
})

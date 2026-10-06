import { describe, expect, it } from 'vitest'
import { SUBAGENT_CHAT_ADDRESS, buildChatAddress, parseChatAddress } from '../src/shared/chat-address.js'

/**
 * 子会话对话地址编解码（US4）。
 *
 * 格式锚定宿主 `ui-subagent` 的侧边对话实现，插件客户端半不能 import 宿主客户端包
 * （只能 require PLATFORM_MODULES），故自实现并在此锁死格式。
 */

describe('buildChatAddress', () => {
  it('产出与宿主同形的地址', () => {
    const a = buildChatAddress({
      childSessionId: 'child-1',
      parentSessionId: 'parent-1',
      mode: 'continuable',
    })
    expect(a).toBe(`${SUBAGENT_CHAT_ADDRESS}child-1?parent=parent-1&mode=continuable`)
  })

  it('子会话 id 里的特殊字符被编码', () => {
    const a = buildChatAddress({
      childSessionId: 'a/b c?d',
      parentSessionId: 'p',
      mode: 'one-shot',
    })
    expect(a.startsWith(SUBAGENT_CHAT_ADDRESS)).toBe(true)
    expect(parseChatAddress(a)?.childSessionId).toBe('a/b c?d')
  })

  it('缺父会话或子会话时返回空串（不造坏地址）', () => {
    expect(buildChatAddress({ childSessionId: 'c', parentSessionId: '', mode: 'continuable' })).toBe('')
    expect(buildChatAddress({ childSessionId: '', parentSessionId: 'p', mode: 'continuable' })).toBe('')
  })
})

describe('parseChatAddress', () => {
  it('往返一致（三种 mode）', () => {
    for (const mode of ['one-shot', 'continuable', 'unknown'] as const) {
      const addr = buildChatAddress({ childSessionId: 'c1', parentSessionId: 'p1', mode })
      expect(parseChatAddress(addr)).toEqual({ childSessionId: 'c1', parentSessionId: 'p1', mode })
    }
  })

  it('非本协议的资源地址一律拒绝（不抢宿主的其它 resource）', () => {
    expect(parseChatAddress('dsh-resource://other/session/c1?parent=p&mode=continuable')).toBeUndefined()
    expect(parseChatAddress('https://example.com/session/c1?parent=p&mode=continuable')).toBeUndefined()
  })

  it('路径段数不对 / 缺参 / mode 非法一律拒绝', () => {
    expect(parseChatAddress(`${SUBAGENT_CHAT_ADDRESS}c1`)).toBeUndefined()
    expect(parseChatAddress('dsh-resource://subagentchat/session/c1?mode=continuable')).toBeUndefined()
    expect(parseChatAddress('dsh-resource://subagentchat/session/c1?parent=p')).toBeUndefined()
    expect(parseChatAddress('dsh-resource://subagentchat/session/c1?parent=p&mode=weird')).toBeUndefined()
    expect(parseChatAddress('dsh-resource://subagentchat/other/c1?parent=p&mode=continuable')).toBeUndefined()
  })

  it('空值 / 非法 URL 不抛错', () => {
    expect(parseChatAddress('')).toBeUndefined()
    expect(parseChatAddress('not a url')).toBeUndefined()
  })
})

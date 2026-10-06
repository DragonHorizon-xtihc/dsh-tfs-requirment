import { beforeEach, describe, expect, it } from 'vitest'
import { EventLog } from '../src/persistence/events.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

// 每个用例独立内存 fs，避免跨用例状态污染（共享实例会残留上一用例的写入）。
let memFs: MemFs
beforeEach(() => {
  memFs = createMemFs()
})

describe('EventLog', () => {
  it('追加后可重放且顺序一致', () => {
    const log = new EventLog('/mem/events', 'events.jsonl', memFs)
    log.append({ kind: 'a' })
    log.append({ kind: 'b' })
    const all = log.replay()
    expect(all).toHaveLength(2)
    expect(all[0]!.kind).toBe('a')
    expect(all[1]!.kind).toBe('b')
    // 每条自带 ts
    expect(typeof all[0]!.ts).toBe('string')
  })

  it('空日志重放返回 []', () => {
    const log = new EventLog('/mem/events', 'events.jsonl', memFs)
    expect(log.replay()).toEqual([])
  })

  it('追加不修改已有行（append-only）', () => {
    const log = new EventLog('/mem/events', 'events.jsonl', memFs)
    log.append({ v: 1 })
    log.append({ v: 2 })
    const first = log.replay()[0]!
    // 再次追加不应改变第一条
    log.append({ v: 3 })
    expect(log.replay()[0]).toEqual(first)
  })
})

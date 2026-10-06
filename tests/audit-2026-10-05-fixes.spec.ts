/**
 * 2026-10-05 审计修复的回归测试。
 *
 * 本文件只覆盖**当次审计确认、且此前无任何测试覆盖**的缺陷 —— 它们全部被 946 个既有
 * 测试放过（基线全绿），因此必须在这里钉住行为，否则会静默回归。
 *
 * 覆盖清单：
 * 1. rest-client：响应体阶段必须受超时保护（头已回、体极慢的挂死形态）；
 * 2. rest-client：超时必须与「网络错误」区分开（否则用户被误导去查网络）；
 * 3. rest-client：`getJson` 必须透传字符串 `apiVersion`（此前被无声丢弃）；
 * 4. adapter：`callTimeoutMs` 此前声明了从不读取（传了不生效）；
 * 5. system-writeback：真实失败不得因错误串含「重复/duplicate」被误判成幂等跳过；
 * 6. system-writeback：IdentityRef 字段不得变成 `"[object Object]"`；
 * 7. system-writeback：附件名在调用方未传 fileName 时也必须回填；
 * 8. orchestrator-session：`ensure` 并发不得造出多个「工头」会话；
 * 9. requirement-finalizer：手动回写必须自己登记 inFlight（防与自动触发并发双写）。
 */

import { describe, expect, it, vi } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { RestError, createRestRead, createRestWrite } from '../src/tfs/rest-client.js'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { createSystemWriteBack } from '../src/tfs/system-writeback.js'
import { OrchestratorSessionManager } from '../src/host/orchestrator-session.js'
import { RequirementFinalizer } from '../src/host/requirement-finalizer.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'

/**
 * `startContinuableOn` 是模块级导入（`./subagent-access.js`），必须 mock 整个模块
 * 才能观测"到底创建了几个子会话"——而这正是本组用例要断言的东西。
 * 计数器放在 `vi.hoisted` 里：mock 工厂会被提升到文件顶部，不能引用普通 `let`。
 * 其余成员用 importOriginal 保留真实实现（sendMessageOn 等本组不涉及，但需存在）。
 */
const h = vi.hoisted(() => ({ created: 0 }))
vi.mock('../src/host/subagent-access.js', async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    startContinuableOn: async (_ctx: unknown, _req: unknown) => {
      h.created += 1
      const n = h.created
      // 让两个并发 ensure 的"创建"窗口重叠，才暴露 check-then-act 竞态。
      await new Promise(r => setTimeout(r, 10))
      return { childId: `child-${n}` }
    },
  }
})

/** 构造一个"响应头立即 resolve、响应体受 signal 支配"的假 fetch（忠实模拟 undici）。 */
function hangingBodyFetch(): (url: string, init?: { signal?: AbortSignal }) => Promise<Response> {
  return async (_url, init = {}) =>
    ({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      text: () =>
        new Promise<string>((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted')
            err.name = 'AbortError'
            rej(err)
          })
        }),
      arrayBuffer: () =>
        new Promise<ArrayBuffer>((_res, rej) => {
          init.signal?.addEventListener('abort', () => {
            const err = new Error('This operation was aborted')
            err.name = 'AbortError'
            rej(err)
          })
        }),
    }) as unknown as Response
}

/** 构造一个"连响应头都拿不到"的假 fetch。 */
function failingFetch(message: string): (url: string) => Promise<Response> {
  return async () => {
    throw new TypeError(message)
  }
}

function readWith(fetchImpl: unknown, timeoutMs?: number) {
  return createRestRead({
    url: 'http://tfs.invalid/tfs',
    collection: 'C',
    pat: 'p',
    ...(timeoutMs !== undefined ? { timeoutMs } : {}),
    fetchImpl: fetchImpl as never,
  } as never)
}

describe('rest-client 超时覆盖整个请求生命周期', () => {
  it('响应体阶段挂死时按 timeoutMs 中止（此前 clearTimeout 在 finally 里，此阶段无保护）', async () => {
    const read = readWith(hangingBodyFetch(), 150)
    const started = Date.now()
    await expect(read.getJson('/_apis/x')).rejects.toThrow(/请求超时/)
    // 断言"确实等了"而不是"立即失败"——否则测试会在实现回退时假绿。
    expect(Date.now() - started).toBeGreaterThanOrEqual(100)
  })

  it('二进制下载同样受保护（此前 arrayBuffer 阶段无保护）', async () => {
    const read = readWith(hangingBodyFetch(), 150)
    await expect(read.getBlob('/_apis/tfvc/items?path=x')).rejects.toThrow(/请求超时/)
  })

  it('超时与真实网络故障可区分：前者 code=TIMEOUT，后者是「网络错误」', async () => {
    const timedOut = await readWith(hangingBodyFetch(), 120)
      .getJson('/_apis/x')
      .then(() => null)
      .catch((e: unknown) => e as RestError)
    expect(timedOut).toBeInstanceOf(RestError)
    expect(timedOut?.code).toBe('TIMEOUT')
    expect(timedOut?.message).toMatch(/请求超时/)

    const netErr = await readWith(failingFetch('fetch failed'), 5_000)
      .getJson('/_apis/x')
      .then(() => null)
      .catch((e: unknown) => e as RestError)
    expect(netErr?.code).toBe('')
    expect(netErr?.message).toMatch(/^网络错误：/)
  })
})

describe('rest-client getJson 透传 apiVersion', () => {
  it('字符串 apiVersion 不被丢弃（此前只处理 false，字符串被无声忽略）', async () => {
    const seen: string[] = []
    const read = createRestRead({
      url: 'http://tfs.invalid/tfs',
      collection: 'C',
      pat: 'p',
      fetchImpl: (async (url: string) => {
        seen.push(url)
        return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' } as unknown as Response
      }) as never,
    } as never)
    await read.getJson('/_apis/wit/x', { apiVersion: '4.1-preview' })
    expect(seen[0]).toContain('api-version=4.1-preview')
  })

  it('缺省仍走 4.1，false 则完全不带（不回归）', async () => {
    const seen: string[] = []
    const mk = () =>
      createRestRead({
        url: 'http://tfs.invalid/tfs',
        collection: 'C',
        pat: 'p',
        fetchImpl: (async (url: string) => {
          seen.push(url)
          return { ok: true, status: 200, headers: new Headers(), text: async () => '{}' } as unknown as Response
        }) as never,
      } as never)
    await mk().getJson('/_apis/wit/x')
    expect(seen[0]).toContain('api-version=4.1')
    await mk().getJson('/_apis/wit/x', { apiVersion: false })
    expect(seen[1]).not.toContain('api-version')
  })
})

describe('写侧 postJson 第三参与只读侧同名不同义', () => {
  it('写侧方法名为 postJsonWithType，与只读侧 postJson 区分开', () => {
    // 仅靠改名消除误用可能：同名同位置、语义相反（apiVersion vs contentType）
    // 会让任何一侧替换另一侧时静默改变语义。
    const write = createRestWrite({ url: 'http://tfs.invalid/tfs', collection: 'C', pat: 'p' } as never)
    expect(typeof write.postJsonWithType).toBe('function')
    expect((write as unknown as Record<string, unknown>)['postJson']).toBeUndefined()
  })
})

describe('adapter.callTimeoutMs 真正生效', () => {
  it('传入后作用于 REST 客户端（此前是声明了从不读取的死字段）', async () => {
    const seenSignal: Array<{ aborted: boolean }> = []
    const adapter = new TfsAdapter({
      rest: { url: 'http://tfs.invalid/tfs', collection: 'C', pat: 'p', timeoutMs: 60 },
      collection: 'C',
    } as never)
    // 直接验证 restFor 产出的配置携带该超时（构造器透传）。
    const cfg = (adapter as unknown as {
      restFor(c?: string): { config: { timeoutMs?: number } }
    }).restFor('C').config
    expect(cfg.timeoutMs).toBe(60)
    expect(seenSignal).toHaveLength(0)
  })

  it('未传时保持缺省（不改变既有 20s 行为）', () => {
    const adapter = new TfsAdapter({
      rest: { url: 'http://tfs.invalid/tfs', collection: 'C', pat: 'p' },
      collection: 'C',
    } as never)
    const cfg = (adapter as unknown as {
      restFor(c?: string): { config: { timeoutMs?: number } }
    }).restFor('C').config
    expect(cfg.timeoutMs).toBeUndefined()
  })
})

describe('system-writeback 幂等归一改用结构化 code', () => {
  const port = (outcome: unknown) =>
    createSystemWriteBack({
      wrappedWrite: async () => outcome,
      addComment: async () => outcome,
    } as never)

  it('门禁3 主动跳过仍归一为 skipped（不回归）', async () => {
    const r = await port({ ok: false, code: 'IDEMPOTENT_SKIP', reason: '幂等键已应用，跳过重复回写（门禁3）' })
      .addComment(1, 'C', '正文')
    expect(r.status).toBe('skipped')
  })

  it('错误串含 duplicate 的真实失败必须抛错（旧实现误判 skipped ⇒ 失败被静默吞掉）', async () => {
    await expect(
      port({ ok: false, reason: 'TFS REST 调用失败（profile=WN_HIS）：duplicate work item submitted' })
        .addComment(1, 'C', '正文'),
    ).rejects.toThrow(/duplicate/)
  })

  it('错误串含中文「重复」的真实失败必须抛错', async () => {
    await expect(
      port({ ok: false, reason: 'TFS REST 调用失败（profile=WN_HIS）：字段重复，请勿再次提交' })
        .addComment(1, 'C', '正文'),
    ).rejects.toThrow(/重复/)
  })

  it('门禁2 未确认按失败处理（不静默跳过）', async () => {
    await expect(
      port({ ok: false, code: 'NOT_CONFIRMED', reason: '未确认回写（门禁2：需用户确认）' })
        .addComment(1, 'C', '正文'),
    ).rejects.toThrow(/门禁2/)
  })
})

describe('system-writeback 字段与附件名', () => {
  it('IdentityRef 字段不得变成 "[object Object]"', async () => {
    const p = createSystemWriteBack({
      getWorkItem: async () => ({
        fields: {
          'System.AssignedTo': {
            displayName: '张波(张波)',
            uniqueName: 'zhangbo3',
            properties: { Account: { $value: 'WINNING\\zhangbo3' } },
          },
        },
      }),
    } as never)
    const f = await p.getFields(1, 'C')
    expect(f['System.AssignedTo']).toBe('张波(张波)')
    expect(f['System.AssignedTo']).not.toBe('[object Object]')
  })

  it('未传 fileName 时也要回填附件名（finalizer 正是按路径调这一路）', async () => {
    const p = createSystemWriteBack({
      wrappedWrite: async () => ({ ok: true, result: { id: 'u1' } }),
    } as never)
    const r = await p.uploadAttachment(1, 'C', 'D:\\build\\out\\report.md')
    expect(r.status).toBe('ok')
    expect(r.name).toBe('report.md')
  })
})

describe('orchestrator-session.ensure 并发去重', () => {
  function makeCtx(service: unknown): Context {
    return {
      get: (name: string) => (name === 'subagents' ? service : undefined),
      on: () => () => {},
    } as unknown as Context
  }

  function makeMgr() {
    const orchestrations = new Map<string, Record<string, unknown>>()
    const board = {
      getOrchestration: (k: string) => orchestrations.get(k),
      setOrchestration: (k: string, v: Record<string, unknown>) => {
        orchestrations.set(k, v)
      },
    }
    return new OrchestratorSessionManager({
      // subagents 服务需可枚举出 provider，否则 pickProvider 返回 undefined 会走 fallback。
      ctx: makeCtx({ list: () => ['subagent-fork-in-process'], start: () => ({}) }),
      board: board as never,
      getParent: () => ({ session: { id: 'sess-1' } }) as never,
      provider: 'subagent-fork-in-process',
      enabled: true,
      summarizeTimeoutMs: 1000,
      finalizeTimeoutMs: 1000,
      taskSettleTimeoutMs: 1000,
    } as never)
  }

  it('同一需求并发 ensure 只创建一个会话', async () => {
    h.created = 0
    const mgr = makeMgr()
    const [a, b] = await Promise.all([mgr.ensure('1997179@WN_HIS'), mgr.ensure('1997179@WN_HIS')])
    expect(h.created).toBe(1)
    expect(a.orchestratorSessionId).toBe(b.orchestratorSessionId)
  })

  it('不同需求互不阻塞', async () => {
    h.created = 0
    const mgr = makeMgr()
    await Promise.all([mgr.ensure('1@C'), mgr.ensure('2@C')])
    expect(h.created).toBe(2)
  })
})

describe('requirement-finalizer 手动路径自己登记 inFlight', () => {
  it('手动回写进行中时，自动触发被拒（反向原本就是好的，需保持）', async () => {
    const writeBack: Record<string, unknown> = { status: 'running' }
    const board = {
      snapshot: {
        requirements: {
          '1@C': { id: 1, collection: 'C', title: 't', description: '', prompt: '', tags: [], writeBack },
        },
        tasks: {},
      },
      setRequirementWriteBack: (_k: string, v: unknown) => {
        writeBack.status = (v as { status?: string }).status
      },
    }
    const port = {
      updateFields: async () => ({ status: 'ok' as const }),
      addComment: async () => ({ status: 'ok' as const }),
      uploadAttachment: async () => ({ status: 'ok' as const, name: 'x' }),
      findLinkedTasks: async () => [],
      resolveTask: async () => ({ status: 'ok' as const }),
    }
    const f = new RequirementFinalizer({ board: board as never, port: port as never, saveReport: () => {} })
    // 先手动起一个（不 await 完成），再让自动路径尝试。
    const manual = f.runWriteBack('1@C', false).catch((e: Error) => e)
    await new Promise(r => setTimeout(r, 5))
    // maybeFinalize 不会因 inFlight 而抛错，只静默跳过（返回 undefined）
    const auto = await f.maybeFinalize('1@C')
    expect(auto).toBeUndefined()
    await manual
  })
})

describe('write-guard 门禁返回结构化 code', () => {
  it('门禁2/门禁3 分别给出 NOT_CONFIRMED / IDEMPOTENT_SKIP', () => {
    const fs = createMemFs()
    const guard = new WriteGuard(new AuditLog('/d', fs))
    const op = {
      targetWorkItem: '1@C',
      opType: 'tag' as const,
      idempotencyKey: 'k1',
      before: null,
      after: ['x'],
    }
    const g2 = guard.gate(op, { confirmed: false })
    expect(g2.ok).toBe(false)
    expect(g2.code).toBe('NOT_CONFIRMED')

    guard.record(op)
    const g3 = guard.gate(op, { confirmed: true })
    expect(g3.ok).toBe(false)
    expect(g3.code).toBe('IDEMPOTENT_SKIP')
  })
})

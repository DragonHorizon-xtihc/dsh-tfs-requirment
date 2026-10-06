/**
 * R1 修复（动态 REST 凭据）的回归网。
 *
 * 背景：装配期 `new TfsAdapter({rest})` 会冻结 url/PAT；插件启动时若无活动档案，
 * 旧实现后续即使用户在「连接与凭据」页激活了档案，类型/状态元数据仍打向占位配置，
 * 表现为"项目清单有值（走 liveProjects 动态旁路）、工作类型/状态下拉为空"。
 *
 * 本文件锁定：
 *  1. `restConfigProvider` 在**每次调用时**给出的配置优先于装配期快照；
 *  2. 运行时切换提供者返回值（=激活/修改档案）无需重建 adapter 即生效；
 *  3. 两条通路都没有配置时，抛可执行诊断而非 `Cannot read properties of undefined`。
 *
 * @module tests/adapter-rest-dynamic
 */
import { describe, expect, it } from 'vitest'
import { TfsAdapter } from '../src/tfs/adapter.js'
import { WriteGuard } from '../src/write-guard/index.js'
import { AuditLog } from '../src/write-guard/audit.js'
import { createMemFs } from './helpers/memfs.js'
import type { RestConfig } from '../src/tfs/rest-client.js'

function recordingRest(url: string, pat = 'PAT-X') {
  const calls: string[] = []
  const impl = (async (u: string | URL) => {
    calls.push(String(u))
    // connectionData 形状（whoami 用）
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          authorizedUser: {
            providerDisplayName: 'zhangbo3(张波)',
            properties: { Account: { $value: 'zhangbo3' } },
          },
        }),
    } as Response
  }) as typeof fetch
  const config: RestConfig = { url, collection: 'WN_HIS', pat, fetchImpl: impl }
  return { config, calls }
}

function makeAdapter(rest: RestConfig | undefined, provider: () => RestConfig | undefined): TfsAdapter {
  const guard = new WriteGuard(new AuditLog('/mem/audit', createMemFs()))
  return new TfsAdapter({
    ...(rest ? { rest } : {}),
    writeGuard: guard,
    collection: 'WN_HIS',
    profileLabel: 'WN_HIS',
    restConfigProvider: provider,
  })
}

describe('restConfigProvider 动态凭据', () => {
  it('提供者返回的配置优先于装配期快照（首调即走活动档案）', async () => {
    const boot = recordingRest('http://boot.invalid/tfs')
    const live = recordingRest('http://tfs2018-web.winning.com.cn:8080/tfs')
    const adapter = makeAdapter(boot.config, () => live.config)
    await adapter.whoami()
    expect(boot.calls.length).toBe(0)
    expect(live.calls.length).toBe(1)
    expect(live.calls[0]).toContain('http://tfs2018-web.winning.com.cn:8080/tfs')
  })

  it('运行时提供者切换到新档案（url 变化）后，后续调用立即走新配置，无需重建 adapter', async () => {
    const first = recordingRest('http://tfs-a.example/tfs', 'PAT-A')
    const second = recordingRest('http://tfs-b.example/tfs', 'PAT-B-LONGER')
    let current = first.config
    const adapter = makeAdapter(first.config, () => current)
    await adapter.whoami()
    current = second.config
    await adapter.whoami()
    expect(first.calls.length).toBe(1)
    expect(second.calls.length).toBe(1)
    expect(second.calls[0]).toContain('http://tfs-b.example/tfs')
  })

  it('装配期无 rest 且提供者暂时为空：抛可执行诊断；提供者随后给值即可正常调用', async () => {
    const live = recordingRest('http://tfs2018-web.winning.com.cn:8080/tfs')
    let current: RestConfig | undefined
    const adapter = makeAdapter(undefined, () => current)
    await expect(adapter.whoami()).rejects.toThrow(/连接与凭据/)
    current = live.config
    const r = await adapter.whoami()
    expect(r).toBeTruthy()
    expect(live.calls.length).toBe(1)
  })

  it('提供者抛错时回落装配期快照，不把整次调用打崩', async () => {
    const boot = recordingRest('http://tfs2018-web.winning.com.cn:8080/tfs')
    const adapter = makeAdapter(boot.config, () => {
      throw new Error('profiles.json locked')
    })
    await adapter.whoami()
    expect(boot.calls.length).toBe(1)
  })
})

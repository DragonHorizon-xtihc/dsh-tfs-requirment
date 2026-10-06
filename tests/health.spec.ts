import { describe, expect, it } from 'vitest'
import {
  classifyTfsError,
  runHealthCheck,
  scrubCredentials,
  EXPECTED_TFS_TOOLS,
  type HealthProbePort,
} from '../src/host/health.js'

/**
 * 连通性自检单测（T029 测试连接 + T033 凭据不外泄 + T028b 工具盘点）。
 *
 * 两组契约必须被锁定：
 *  1. **凭据零外泄**（T033/CHK002）：tfs-mcp 的报错可能回显 URL 里的 `?token=` 或 Basic 头，
 *     自检结果必须把它们擦成 `[REDACTED]`，否则面板/日志会泄漏 PAT。
 *  2. **失败可归类**（T029）：认证 / 权限 / 地址 / 未知，四类，让用户知道改什么。
 */

function port(over: Partial<HealthProbePort> = {}): HealthProbePort {
  return {
    whoami: async () => ({ displayName: 'zhangbo3(张波)', uniqueName: 'WINNING\\zhangbo3' }),
    getCurrentCollection: async () => ({ name: 'WN_HIS', url: 'http://tfs/tfs/WN_HIS' }),
    getProjects: async () => [{ id: '1' }, { id: '2' }],
    ...over,
  }
}

describe('scrubCredentials（T033 凭据零外泄）', () => {
  it('擦除 Authorization 头与 Basic/Bearer 令牌', () => {
    const s = scrubCredentials('Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ== failed')
    expect(s).not.toContain('QWxhZGRpbjpvcGVuIHNlc2FtZQ==')
    expect(s).toContain('[REDACTED]')
    expect(scrubCredentials('bearer abcdefghijklmnopqrstuvwxyz')).not.toContain('abcdefghijklmnopqrstuvwxyz')
  })

  it('擦除 URL 查询串里的 token/pat/password', () => {
    const s = scrubCredentials('GET http://tfs/_apis/wit/workitems?token=SECRET123&x=1 failed')
    expect(s).not.toContain('SECRET123')
    expect(s).toContain('token=[REDACTED]')
  })

  it('擦除长 base64 / 长十六进制令牌串', () => {
    const b64 = 'QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVphYmNkZWY='
    expect(scrubCredentials(`x ${b64} y`)).not.toContain(b64)
    const hex = 'a'.repeat(40)
    expect(scrubCredentials(`x ${hex} y`)).not.toContain(hex)
  })

  it('不误伤普通文本', () => {
    const s = scrubCredentials('Failed request: (414) for collection WN_HIS')
    expect(s).toBe('Failed request: (414) for collection WN_HIS')
  })
})

describe('classifyTfsError（T029 失败归类）', () => {
  it('401/未授权 → auth', () => {
    expect(classifyTfsError('Failed request: (401) Unauthorized').kind).toBe('auth')
    expect(classifyTfsError('invalid token').kind).toBe('auth')
  })

  it('403/被拒 → permission', () => {
    expect(classifyTfsError('TF401019 forbidden').kind).toBe('permission')
  })

  it('解析/连接/414/404 → address', () => {
    expect(classifyTfsError('getaddrinfo ENOTFOUND tfs2018-web').kind).toBe('address')
    expect(classifyTfsError('Failed request: (414)').kind).toBe('address')
    expect(classifyTfsError('ECONNREFUSED 10.0.0.1:8080').kind).toBe('address')
  })

  it('其它 → unknown，且原因里也不含凭据', () => {
    const r = classifyTfsError('boom token=ABC123XYZ')
    expect(r.kind).toBe('unknown')
    expect(r.reason).not.toContain('ABC123XYZ')
  })

  it('归类结果带上可操作建议', () => {
    expect(classifyTfsError('(401)').reason).toContain('PAT')
    expect(classifyTfsError('(403)').reason).toContain('管理员')
    expect(classifyTfsError('ENOTFOUND').reason).toContain('连通性')
  })
})

describe('runHealthCheck（T029 + T028b）', () => {
  it('全部通过 → ok:true 并汇总身份/集合/项目数', async () => {
    const r = await runHealthCheck(port())
    expect(r.ok).toBe(true)
    expect(r.identity).toContain('张波')
    expect(r.collection).toBe('WN_HIS')
    expect(r.projectCount).toBe(2)
  })

  it('whoami 失败 → ok:false 且带归类，不再探测其余端点', async () => {
    let collectionCalled = false
    const r = await runHealthCheck(
      port({
        whoami: async () => {
          throw new Error('Failed request: (401) Unauthorized token=SECRET')
        },
        getCurrentCollection: async () => {
          collectionCalled = true
          return {}
        },
      }),
    )
    expect(r.ok).toBe(false)
    expect(r.kind).toBe('auth')
    expect(r.reason).not.toContain('SECRET')
    expect(collectionCalled).toBe(false)
  })

  it('附加端点失败不改变连通性结论（whoami 通过即连通）', async () => {
    const r = await runHealthCheck(
      port({
        getCurrentCollection: async () => {
          throw new Error('nope')
        },
        getProjects: async () => {
          throw new Error('nope')
        },
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.collection).toBeUndefined()
    expect(r.projectCount).toBeUndefined()
  })

  it('工具盘点：区分可用与缺失（T028b 能力降级可见）', async () => {
    const r = await runHealthCheck(port(), ['tfs_whoami', 'tfs_add_tags'])
    expect(r.tools?.available).toEqual(['tfs_add_tags', 'tfs_whoami'])
    // 列表出口已改为 WIQL（custom_query 实测恒失败，不再作为依赖），TFVC 关联工具已纳入依赖。
    expect(r.tools?.missing).toContain('tfs_query_wiql')
    expect(r.tools?.missing).toContain('tfs_get_tfvc_changeset')
    expect(r.tools!.available.length + r.tools!.missing.length).toBe(EXPECTED_TFS_TOOLS.length)
  })

  it('未提供工具清单时不返回 tools 字段', async () => {
    const r = await runHealthCheck(port())
    expect(r.tools).toBeUndefined()
  })

  it('身份/集合/项目形状未知时也不抛（尽力取值）', async () => {
    const r = await runHealthCheck(
      port({
        whoami: async () => 'zhangbo3',
        getCurrentCollection: async () => 'WN_HIS',
        getProjects: async () => ({ value: [1, 2, 3] }),
      }),
    )
    expect(r.ok).toBe(true)
    expect(r.identity).toBe('zhangbo3')
    expect(r.collection).toBe('WN_HIS')
    expect(r.projectCount).toBe(3)
  })
})

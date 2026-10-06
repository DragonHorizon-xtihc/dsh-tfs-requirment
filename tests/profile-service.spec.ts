import { describe, expect, it } from 'vitest'
import { join } from 'node:path'
import { ProfileService, ENV_FILE_NAME, TFS_ENV_KEYS } from '../src/host/profile-service.js'
import { ProfileStore } from '../src/profile/store.js'
import { createMemFs, type MemFs } from './helpers/memfs.js'

/**
 * 连接档案服务单测（T031 / FR-002 / FR-031 / S-12）+ MCP 实例诊断（T028b）。
 *
 * 本文件的核心是**安全契约的回归防线**：类型层已经用 `ProfileView`（无 pat 字段）排除了
 * "响应体带凭据"，但类型层挡不住"某处把存储对象直接 stringify"。故这里对每个查询/操作路径
 * 都做一次 `JSON.stringify` 断言，确保明文 PAT 只出现在两处：存储文件、环境文件。
 */

interface Subject {
  fs: MemFs
  store: ProfileStore
  svc: ProfileService
}

function setup(): Subject {
  const baseDir = '/data'
  const fs = createMemFs()
  const store = new ProfileStore(baseDir, fs)
  const svc = new ProfileService({ baseDir, store, fs })
  return { fs, store, svc }
}

const PAT = 'p@t-明文-9f3a'

describe('ProfileService.save / list（PAT 不回显）', () => {
  it('新建档案：服务端生成 id；list 返回摘要且**不含 PAT**', () => {
    const { svc, store } = setup()
    const res = svc.save({ name: '生产', url: 'http://tfs2018-web.winning.com.cn:8080/tfs', collection: 'WN_HIS', pat: PAT })
    expect(res.ok).toBe(true)
    expect(res.profile?.id).toBeTruthy()
    expect(res.profile?.collection).toBe('WN_HIS')
    // 返回值与 list 都不得出现 pat 字段或明文。
    expect(JSON.stringify(res)).not.toContain(PAT)
    expect(JSON.stringify(res)).not.toContain('"pat"')
    const list = svc.list()
    expect(list).toHaveLength(1)
    expect(JSON.stringify(list)).not.toContain(PAT)
    expect(Object.keys(list[0] as object).sort()).toEqual(['collection', 'id', 'name', 'url'])
    // 明文只在存储里可被显式取出（供写环境文件），不是"丢了"。
    expect(store.getCredential(res.profile!.id)).toBe(PAT)
  })

  it('校验：name/url/collection 非法 → 拒绝；新建缺 pat → 拒绝且提示原因', () => {
    const { svc } = setup()
    expect(svc.save({ name: '  ', url: 'http://x', collection: 'WN_HIS', pat: PAT }).ok).toBe(false)
    expect(svc.save({ name: 'a', url: 'tfs2018:8080/tfs', collection: 'WN_HIS', pat: PAT }).ok).toBe(false)
    expect(svc.save({ name: 'a', url: 'http://x', collection: ' ', pat: PAT }).ok).toBe(false)
    const noPat = svc.save({ name: 'a', url: 'http://x', collection: 'WN_HIS' })
    expect(noPat.ok).toBe(false)
    expect(noPat.reason).toContain('pat')
    expect(svc.list()).toHaveLength(0)
  })

  it('更新既有档案时 pat 可省略（沿用原 PAT，避免为改名被迫重贴 PAT）', () => {
    const { svc, store } = setup()
    const created = svc.save({ name: '生产', url: 'http://x/tfs', collection: 'WN_HIS', pat: PAT })
    const id = created.profile!.id
    const updated = svc.save({ id, name: '生产（改名）', url: 'http://x/tfs', collection: 'WN_TECH' })
    expect(updated.ok).toBe(true)
    expect(updated.profile?.name).toBe('生产（改名）')
    expect(updated.profile?.collection).toBe('WN_TECH')
    expect(store.getCredential(id)).toBe(PAT)
    expect(JSON.stringify(updated)).not.toContain(PAT)
  })
})

describe('ProfileService.remove（S-12 擦除）', () => {
  it('删除后记录消失，且原文件被随机字节覆写（明文不再可恢复）', () => {
    const { svc, fs } = setup()
    const created = svc.save({ name: 'a', url: 'http://x', collection: 'WN_HIS', pat: PAT })
    const id = created.profile!.id
    expect(fs.readFileSync('/data/profiles.json', 'utf8')).toContain(PAT)

    expect(svc.remove(id).ok).toBe(true)
    expect(svc.list()).toHaveLength(0)
    expect(fs.readFileSync('/data/profiles.json', 'utf8')).not.toContain(PAT)
  })

  it('删除不存在的档案 → ok:false', () => {
    const { svc } = setup()
    expect(svc.remove('nope').ok).toBe(false)
  })

  it('删除活动档案会清空活动指针', () => {
    const { svc } = setup()
    const created = svc.save({ name: 'a', url: 'http://x', collection: 'WN_HIS', pat: PAT })
    const id = created.profile!.id
    expect(svc.activate(id).ok).toBe(true)
    expect(svc.activeId()).toBe(id)
    svc.remove(id)
    expect(svc.activeId()).toBeUndefined()
  })
})

describe('ProfileService.activate（跨重启持久化）', () => {
  it('活动档案指针落盘，新实例可读取（模拟重启）', () => {
    const baseDir = '/data'
    const fs = createMemFs()
    const store = new ProfileStore(baseDir, fs)
    const svc = new ProfileService({ baseDir, store, fs })
    const created = svc.save({ name: 'a', url: 'http://x', collection: 'WN_HIS', pat: PAT })
    const id = created.profile!.id
    svc.activate(id)

    const svc2 = new ProfileService({ baseDir, store: new ProfileStore(baseDir, fs), fs })
    expect(svc2.activeId()).toBe(id)
    expect(JSON.stringify(svc2.envTemplate())).not.toContain(PAT)
  })

  it('设为不存在的档案 → ok:false', () => {
    const { svc } = setup()
    expect(svc.activate('nope').ok).toBe(false)
  })
})

describe('ProfileService.envTemplate（凭据导出模板，占位符，无明文）', () => {
  it('返回 POSIX / PowerShell 两套行，PAT 为占位符', () => {
    const { svc } = setup()
    const created = svc.save({ name: 'a', url: 'http://x/tfs', collection: 'WN_HIS', pat: PAT })
    svc.activate(created.profile!.id)
    const t = svc.envTemplate()
    expect(t.ok).toBe(true)
    expect(t.profileId).toBe(created.profile!.id)
    expect(t.posixLines.join('\n')).toContain(`export ${TFS_ENV_KEYS.url}='http://x/tfs'`)
    expect(t.posixLines.join('\n')).toContain(`export ${TFS_ENV_KEYS.collection}='WN_HIS'`)
    expect(t.powershellLines.join('\n')).toContain(`$env:${TFS_ENV_KEYS.url} = 'http://x/tfs'`)
    // 关键：模板绝不含明文 PAT。
    expect(JSON.stringify(t)).not.toContain(PAT)
    // REST 化后模板讲的是"备份/迁移"，不再要求启动前 export（凭据从档案实时读取）。
    expect(t.note).toContain('直连 TFS REST')
  })

  it('不再报告 MCP 实例名的合法性（REST 化后无此概念）', () => {
    const t = setup().svc.envTemplate()
    expect(t.serverName).toBe('')
    expect(t.serverNameValid).toBe(true)
  })

  it('无档案时给出占位路径与空集合占位（不抛错）', () => {
    const { svc } = setup()
    const t = svc.envTemplate()
    expect(t.ok).toBe(true)
    expect(t.profileId).toBeUndefined()
    expect(t.posixLines.join('\n')).toContain('TFS_URL')
  })
})

describe('ProfileService.writeEnvFile（明文只进文件）', () => {
  it('写出文件：文件含 PAT（子进程要用），返回值不含 PAT', () => {
    const { svc, fs } = setup()
    const created = svc.save({ name: 'a', url: 'http://x/tfs', collection: 'WN_TECH', pat: PAT })
    svc.activate(created.profile!.id)

    const res = svc.writeEnvFile()
    expect(res.ok).toBe(true)
    // 用 path.join 而非硬编码 '/'：Windows 上 join 产出反斜杠，硬编码会在本机假失败。
    expect(res.path).toBe(join('/data', ENV_FILE_NAME))
    expect(res.bytes).toBeGreaterThan(0)
    expect(JSON.stringify(res)).not.toContain(PAT)

    const content = fs.readFileSync(res.path as string, 'utf8')
    expect(content).toContain(`export ${TFS_ENV_KEYS.pat}='${PAT}'`)
    expect(content).toContain(`export ${TFS_ENV_KEYS.collection}='WN_TECH'`)
    // 内存文件系统无权限概念 → hardened 必须如实为 false（不谎报已收紧）。
    expect(res.hardened).toBe(false)
  })

  it('无活动档案 → ok:false + 可读原因，且不创建文件', () => {
    const { svc, fs } = setup()
    const res = svc.writeEnvFile()
    expect(res.ok).toBe(false)
    expect(res.reason).toBeTruthy()
    expect(fs.dump()['/data/tfs-mcp.env']).toBeUndefined()
  })

  it('档案存在但凭据缺失 → ok:false（不写半截文件）', () => {
    const { svc, fs } = setup()
    const created = svc.save({ name: 'a', url: 'http://x', collection: 'WN_HIS', pat: PAT })
    const id = created.profile!.id
    // 手工把 pat 抹掉，模拟存储损坏。
    fs.writeFileSync('/data/profiles.json', JSON.stringify([{ id, name: 'a', url: 'http://x', collection: 'WN_HIS', pat: '' }]), 'utf8')
    const res = svc.writeEnvFile(id)
    expect(res.ok).toBe(false)
    expect(fs.dump()['/data/tfs-mcp.env']).toBeUndefined()
  })
})

describe('ProfileService.instance（连接诊断，REST 化后重定义）', () => {
  it('标记为"可运行期变更"，并说明凭据来自活动档案', () => {
    const { svc } = setup()
    const created = svc.save({ name: '生产', url: 'http://x/tfs', collection: 'WN_HIS', pat: PAT })
    svc.activate(created.profile!.id)
    const info = svc.instance()
    // REST 直连 ⇒ 改 PAT/档案当场生效，无需重启（与旧 MCP 设计相反）。
    expect(info.runtimeAddSupported).toBe(true)
    expect(info.runtimeAddReason).toContain('下一次调用立即生效')
    // serverName 概念已消失：恒空且恒合法，不再有"实例名撞车导致加载失败"的风险。
    expect(info.serverName).toBe('')
    expect(info.serverNameValid).toBe(true)
    expect(info.serverNameConstraint).toContain('不适用')
    // 当前活动档案应被如实回显（排障时最需要的信息）。
    expect(info.duplicateRisk).toContain('生产')
    expect(info.duplicateRisk).toContain('WN_HIS')
    // 凭据来源必须讲清楚（且不含明文）。
    expect(info.credentialPath).toContain('restConfigProvider')
    expect(JSON.stringify(info)).not.toContain(PAT)
  })

  it('无活动档案时给出可执行的指引（而不是静默）', () => {
    const { svc } = setup()
    const info = svc.instance()
    expect(info.duplicateRisk).toContain('无活动档案')
  })
})

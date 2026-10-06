import { describe, expect, it } from 'vitest'
import { baseFromRestUrl, buildWorkItemUrl, isHttpUrl } from '../src/shared/workitem-url.js'

/**
 * TFS 工作项网页地址构造（需求池/任务中心标题直达 TFS）。
 *
 * 真实数据（2026-09-20 实测，TFS 2018，`~/.tfs-requirment-data/board.json` 与
 * `tests/fixtures/tfs-workitem-1997179-real.json` 双向核对）：
 *   - id = 1997179
 *   - collection = WN_HIS
 *   - project = 体检管理
 *   - url = http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/1997179
 *
 * 用户要求的产出：
 *   http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/体检管理/_workitems?id=1997179&_a=edit
 */
const REAL = {
  id: 1997179,
  collection: 'WN_HIS',
  project: '体检管理',
  url: 'http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/1997179',
}
const EXPECTED =
  'http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/体检管理/_workitems?id=1997179&_a=edit'
const BASE_URL = 'http://tfs2018-web.winning.com.cn:8080/tfs'

describe('buildWorkItemUrl · 真实样例（逐字符断言）', () => {
  it('真实需求 → 与用户给的样例完全一致（解码后逐字符相同）', () => {
    const got = buildWorkItemUrl({ id: REAL.id, restUrl: REAL.url, project: REAL.project })
    expect(got).toBeDefined()
    // 项目名走 encodeURIComponent（中文项目名必须能打开），解码后即为样例原文。
    expect(decodeURIComponent(got!)).toBe(EXPECTED)
  })

  it('编码形态：项目名被百分号编码，`?id=&_a=edit` 段保持原样', () => {
    const got = buildWorkItemUrl({ id: REAL.id, restUrl: REAL.url, project: REAL.project })
    expect(got).toContain('/%E4%BD%93%E6%A3%80%E7%AE%A1%E7%90%86/_workitems?id=1997179&_a=edit')
    expect(got!.startsWith('http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/')).toBe(true)
  })

  it('无 REST url → 用「档案 url + 集合」兜底，产出同一个地址', () => {
    const got = buildWorkItemUrl({
      id: REAL.id,
      project: REAL.project,
      baseUrl: BASE_URL,
      collection: REAL.collection,
    })
    expect(decodeURIComponent(got!)).toBe(EXPECTED)
  })
})

describe('buildWorkItemUrl · 失败口径（绝不产出半截或假链接）', () => {
  it('id 非正整数 → undefined', () => {
    for (const id of [0, -1, 1.5, Number.NaN]) {
      expect(buildWorkItemUrl({ id, restUrl: REAL.url, project: REAL.project })).toBeUndefined()
    }
  })

  it('缺项目名 → undefined（不产出没有项目段的半截地址）', () => {
    expect(buildWorkItemUrl({ id: REAL.id, restUrl: REAL.url })).toBeUndefined()
    expect(buildWorkItemUrl({ id: REAL.id, restUrl: REAL.url, project: '   ' })).toBeUndefined()
  })

  it('既无 REST url 也无兜底地址 → undefined', () => {
    expect(buildWorkItemUrl({ id: REAL.id, project: REAL.project })).toBeUndefined()
    expect(buildWorkItemUrl({ id: REAL.id, project: REAL.project, collection: REAL.collection })).toBeUndefined()
    expect(buildWorkItemUrl({ id: REAL.id, project: REAL.project, baseUrl: BASE_URL })).toBeUndefined()
  })

  it('REST url 非 http/https → 拒绝（外部数据不能带进 href）', () => {
    expect(
      buildWorkItemUrl({ id: REAL.id, restUrl: 'javascript:alert(1)/_apis/x', project: REAL.project }),
    ).toBeUndefined()
  })

  it('兜底地址非 http/https → 拒绝', () => {
    expect(
      buildWorkItemUrl({ id: REAL.id, project: REAL.project, baseUrl: 'file:///c:/', collection: 'WN_HIS' }),
    ).toBeUndefined()
  })
})

describe('baseFromRestUrl（从 REST url 解出「地址 + 集合」）', () => {
  it('取 /_apis/ 之前的部分并去掉尾部斜杠', () => {
    expect(baseFromRestUrl(REAL.url)).toBe('http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS')
    expect(baseFromRestUrl('https://tfs.example.com/tfs/C/' + '_apis/wit/workItems/1')).toBe(
      'https://tfs.example.com/tfs/C',
    )
  })

  it('大小写不敏感（/_APIS/ 也能识别）', () => {
    expect(baseFromRestUrl('http://h/tfs/C/_APIS/wit/workItems/9')).toBe('http://h/tfs/C')
  })

  it('不含 /_apis/、空串、非法 scheme → undefined', () => {
    expect(baseFromRestUrl('http://h/tfs/C/')).toBeUndefined()
    expect(baseFromRestUrl('')).toBeUndefined()
    expect(baseFromRestUrl(undefined)).toBeUndefined()
    expect(baseFromRestUrl('/_apis/wit/1')).toBeUndefined()
  })
})

describe('isHttpUrl', () => {
  it('只接受 http/https', () => {
    expect(isHttpUrl('http://a')).toBe(true)
    expect(isHttpUrl('HTTPS://a')).toBe(true)
    expect(isHttpUrl('javascript:alert(1)')).toBe(false)
    expect(isHttpUrl('data:text/html,x')).toBe(false)
    expect(isHttpUrl('//a')).toBe(false)
  })
})

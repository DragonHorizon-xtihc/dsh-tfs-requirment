/**
 * 真实 TFS 响应样本（T039 契约测试的**事实来源**）。
 *
 * 采集方式：2026-09-17 经 `mcp__tfs-mcp__tfs_query_wiql` 对 `WN_HIS` 集合实测，
 * 非构造、非推断。样本用于把"字段映射"锁死在真实形状上，防止后续改动漂移。
 *
 * 实测要点（已验证，见注释）：
 *   1. WIQL **无视 SELECT**：即使 `SELECT [System.Id]`，仍返回全字段 + 全 relations；
 *   2. 字段为**扁平结构**（`title`/`type`/`state`/`assignedTo`…），不是 `{id, fields:{...}}`；
 *   3. `tags` 为**分号拼接字符串**（`''` 表示无标签；`'test-tag; 计划'` 表示两个标签）；
 *   4. `assignedTo` 为**显示串**：`xbp（徐保平) <WINNING\xbp>`（注意括号全半角混用）；
 *   5. `relations` 为数组，元素为 `{rel, url, attributes}`；
 *   6. **体积离群**：id=2（任务）响应约 4KB；id=1（根计划项）含 **7316 条 relations**，
 *      单条响应达 3.4MB —— 这是插件必须做体积熔断的直接依据。
 */

/** 实测 id=2（类型「任务」）的完整响应对象——典型体积样本，逐字采集。 */
export const REAL_WIQL_ITEM_2 = {
  id: 2,
  title: '基础框架搭建',
  type: '任务',
  state: '已关闭',
  reason: '评审/测试通过',
  priority: 1,
  severity: '',
  requirementType: '',
  discipline: '开发',
  moduleName: '',
  devLeader: '',
  testLeader: '',
  prodLeader: '',
  assignedTo: 'xbp（徐保平) <WINNING\\xbp>',
  createdDate: '2018-09-27T07:25:42.847Z',
  changedDate: '2026-08-13T08:44:30.84Z',
  project: 'EDIS',
  areaPath: 'EDIS',
  description: '急诊产品基础框架搭建',
  demandAnalysis: '',
  tags: '',
  iterationPath: 'EDIS',
  url: 'http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/2',
  relations: [
    {
      rel: 'System.LinkTypes.Hierarchy-Reverse',
      url: 'http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/108',
      attributes: { isLocked: false },
    },
    {
      rel: 'ArtifactLink',
      url: 'vstfs:///Git/Commit/8b959d05-77f1-44d6-90e5-0d2dba1bec75%2f8b2d1352-daeb-4728-9944-cccffd7d20b7%2fde2adadb8f5b38d4d3623ff1cb381a445d75a1c5',
      attributes: {
        authorizedDate: '2022-09-29T11:54:22.497Z',
        id: 939345,
        resourceCreatedDate: '2022-09-29T11:54:22.497Z',
        resourceModifiedDate: '2022-09-29T11:54:22.497Z',
        revisedDate: '9999-01-01T00:00:00Z',
        name: 'Fixed in Commit',
      },
    },
    {
      rel: 'ArtifactLink',
      url: 'vstfs:///Git/Commit/3f0c4117-5fe5-47b6-9dd5-309018315585%2f0f8becc8-8f7a-44a5-ab90-436dd5bda367%2fc13739eee85204b10cd1da7d90946b30aa7c020c',
      attributes: {
        authorizedDate: '2026-05-25T02:20:49.627Z',
        id: 2142425,
        resourceCreatedDate: '2026-05-25T02:20:49.627Z',
        resourceModifiedDate: '2026-05-25T02:20:49.627Z',
        revisedDate: '9999-01-01T00:00:00Z',
        name: 'Fixed in Commit',
      },
    },
  ],
} as const

/**
 * 实测 id=1（类型「产品或项目计划」）的**头部字段**——体积离群样本。
 *
 * ⚠️ `relations` 在此被**截断为 0 条**：原始响应含 **7316 条** relations
 * （种类：`ArtifactLink` / `System.LinkTypes.Hierarchy-Forward`），
 * 序列化后 3,492,287 字节（≈3.4MB），无法内联进 fixture。
 * 需要大体积时用下方 `makeMegaParent()` 生成等价形状。
 */
export const REAL_WIQL_ITEM_1_META = {
  id: 1,
  title: 'MEMORY.md consolidation - 2026-04-29',
  type: '产品或项目计划',
  state: '已关闭',
  assignedTo: 'ysh（杨善辉） <WINNING\\ysh>',
  project: 'EDIS',
  tags: 'test-tag; 计划',
  url: 'http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/1',
  /** 实测 relations 条数（已截断，不参与归一化）。 */
  relationsCount: 7316,
  /** 实测单条响应序列化字节数。 */
  measuredBytes: 3492287,
} as const

/**
 * 生成"巨型父工作项"样本（模拟 id=1 的 7316 条 relations）。
 *
 * 用于验证：归一化**必须丢弃 relations**，否则单条需求就会把 MB 级数组带进下游。
 *
 * @param relationsCount - relations 条数（实测离群值 7316）。
 * @returns 与真实形状同构的工作项对象。
 */
export function makeMegaParent(relationsCount: number): Record<string, unknown> {
  const relations = Array.from({ length: relationsCount }, (_unused, i) => ({
    rel: i % 2 === 0 ? 'ArtifactLink' : 'System.LinkTypes.Hierarchy-Forward',
    url: `http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/${1000 + i}`,
    attributes: { isLocked: false, id: 900000 + i },
  }))
  return {
    id: 1,
    title: 'MEMORY.md consolidation - 2026-04-29',
    type: '产品或项目计划',
    state: '已关闭',
    assignedTo: 'ysh（杨善辉） <WINNING\\ysh>',
    project: 'EDIS',
    tags: 'test-tag; 计划',
    iterationPath: 'EDIS',
    changedDate: '2026-09-17T07:45:39.597Z',
    url: 'http://tfs2018-web.winning.com.cn:8080/tfs/WN_HIS/_apis/wit/workItems/1',
    relations,
  }
}

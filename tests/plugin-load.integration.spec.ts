import { describe, expect, it } from 'vitest'
import * as plugin from '../src/index.js'
import { Config } from '../src/index.js'

/**
 * 插件本体装载（集成）。
 *
 * 单元测试逐个 import 子模块，`src/index.ts` 自身的 import 图与导出面从未被运行过：
 * 这里 import 一遍，任何接线文件的 import 失败、导出改名或环形依赖都会在此暴露。
 *
 * 不构造真实 `Context`：装配副作用（`ctx.effect`/定时器/REST 客户端）需要 DSH home
 * 与真实宿主，超出本配置的边界；这里只固定"能装载 + 导出面形状"。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/tests/plugin-load.integration
 */
describe('插件本体装载', () => {
  it('src/index.ts 可被运行时加载', () => {
    expect(plugin).toBeDefined()
  })

  it('导出插件面：name / inject / apply / Config', () => {
    expect(plugin.name).toBe('tfs-requirment')
    expect(plugin.inject).toEqual([])
    expect(typeof plugin.apply).toBe('function')
    expect(Config).toBeDefined()
  })

  it('Config 随插件一起导出且是可调用的 schemastery schema', () => {
    expect(typeof Config).toBe('function')
    expect(Config.type).toBe('object')
  })
})

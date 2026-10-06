/**
 * 集成测试配置：**真实模块装载**准绳。
 *
 * 与 `vitest.config.ts`（纯逻辑、宿主接线、合成事件）互补：这里的 spec 必须把
 * `src/index.ts` 插件本体真正 import 一遍，让它的**完整 import 图**（cordis、
 * 全部 host/tfs/orchestration 模块、客户端编译面之外的宿主依赖）在测试里跑一次——
 * 单元测试只逐个 import 子模块，任何"接线文件自身 import 失败/导出改名"都不会被发现。
 *
 * 排除规则在 `vitest.config.ts` 一侧（其 `include` 不匹配 integration spec），所以本配置
 * 与单元配置的用例集合互不重叠：`npm test` 跑纯逻辑，`npm run test:integration` 跑装载。
 *
 * 约束：不启动真实 GUI、不读写真实 TFS、不碰 DSH home；文件持久化一律用
 * `tests/helpers/memfs.ts` 的内存 fs。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/vitest.integration
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.integration.spec.ts'],
    exclude: ['**/node_modules/**'],
    globals: false,
    isolate: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

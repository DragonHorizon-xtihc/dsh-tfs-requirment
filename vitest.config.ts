/**
 * 隔离测试配置（**单元套件**）。
 *
 * 纪律要求：测试不得触碰真实会话数据或用户的 DSH home。为此
 * - 全部测试跑在 node 环境，不加载浏览器与真实 GUI；
 * - 宿主依赖一律以假实现注入，测试不发起真实 TFS/MCP/模型调用；
 * - 涉及文件的持久化用例**注入内存 fs**（tests/helpers/memfs.ts），
 *   不触碰真实磁盘，规避沙盒/杀软对临时目录的实时扫描导致 rmSync 超时。
 *
 * 集成用例（真实 cordis 上下文装载插件）见 vitest.integration.config.ts。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/vitest
 */

import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.spec.ts'],
    exclude: ['**/node_modules/**', '**/*.integration.spec.ts'],
    globals: false,
    isolate: true,
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
})

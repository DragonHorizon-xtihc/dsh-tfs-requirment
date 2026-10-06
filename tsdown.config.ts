/**
 * 客户端半的 tsdown 配置（T047 / Phase 3）。
 *
 * 本插件位于 `plugins/` 而非 `packages/`，仓库共享的 `clientBundle` 预设够不到，
 * 因此直接复刻它的产物形态：一个 `window.__ModuleLoader__.load({ id, factory })` 闭包工厂
 * （对齐 dsh-optimized-prompt/tsdown.config.ts 的实测做法）。
 *
 * **为什么必须有这个文件**：package.json 的 `build`/`build:client` 脚本调用
 * `tsdown --config-loader tsx`。缺少本配置时 tsdown 找不到入口与产物横幅，`npm run build`
 * 直接失败，`lib/client.js`（package.json exports `./client`）永不产出——客户端面板在浏览器侧
 * 静默消失。这是本次排查出的一处**构建期运行时阻断**，故补齐。
 *
 * 外部表（保持为模块表行的 specifier）取自 harness `packages/client/web/src/platform.ts`
 * 的 `PLATFORM_MODULES` 基线。本插件的客户端半仅运行期请求 `react` 与 `react/jsx-runtime`；
 * 其余为类型引用，列出无害。基线外的一切都内联，避免运行期请求模块表里不存在的行。
 *
 * @module @deepseek-ai/dsh-tfs-requirment/tsdown
 */

import type { UserConfig } from 'tsdown'

/** 保持为模块表行的 specifier（与 platform.ts 的 PLATFORM_MODULES 基线一致）。 */
const PLATFORM_BASELINE = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

/** 插件 id（与 package.json name 一致，作为 __ModuleLoader__ 的行 id）。 */
const PLUGIN_ID = '@deepseek-ai/dsh-tfs-requirment'

export default {
  name: `${PLUGIN_ID}/client`,
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2024',
  // 类型由 tsconfig.client.json 检查；此处开 dts 会把 banner/footer 包进 .d.cts 导致解析失败。
  dts: false,
  sourcemap: true,
  clean: false,
  deps: {
    neverBundle: (specifier: string) => PLATFORM_BASELINE.has(specifier),
    alwaysBundle: (specifier: string) => !PLATFORM_BASELINE.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify('production'),
    'import.meta.env.MODE': JSON.stringify('production'),
    'import.meta.env': JSON.stringify({ MODE: 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: "${PLUGIN_ID}", factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
} satisfies UserConfig

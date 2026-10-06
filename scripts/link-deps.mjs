// 链接宿主 @deepseek-ai/* 依赖到本插件 node_modules，供本地 tsc/vitest 解析。
//
// 本插件位于 deepseek-harness/plugins/，tsc 会沿目录向上在宿主根 node_modules 解析
// @deepseek-ai/*，通常无需手动链接；此脚本保留以兼容 build 流程（prebuild 调用）。
import { existsSync, mkdirSync } from 'node:fs'

if (!existsSync('node_modules')) {
  mkdirSync('node_modules', { recursive: true })
}
console.info('[tfs-requirment] link-deps: 依赖解析依赖宿主根 node_modules（无需手动链接）')

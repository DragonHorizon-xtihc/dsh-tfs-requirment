/**
 * 插件自挂路由的信任边界（Phase 3 实测复核 dsh-optimized-prompt/web-guard.ts）。
 *
 * 背景：宿主 `connection` 服务的 Host/Origin 栅栏与浏览器鉴权只作用于它自己的 `/api`
 * RPC 通道。插件通过 `webServer.register(...)` 直接挂的路由完全绕过该栅栏——任何网页都可
 * 向 `127.0.0.1` 发跨源 fetch，pocket 绑到 `0.0.0.0` 时局域网内任意主机亦可访问。
 *
 * 本插件的路由会直连 TFS REST（写 TFS / 派发 subagent），属于有权限的动作，必须设防：
 * 未鉴权请求直接拒（401/403/503），绝不因为"取不到门禁"就放行。
 *
 * 该门禁封装不是宿主对外 API（无包导出），故按参考插件做法在宿主半本地实现一份，
 * 不 import `@deepseek-ai/dsh-client-connection`，避免装配顺序变化导致模块缺失而失败。
 *
 * @module dsh-tfs-requirment/host/web-guard
 */

import type { IncomingMessage, ServerResponse } from 'node:http'

import { scrubCredentials } from '../shared/redact.js'

/**
 * 把一次失败的异步调用回成 500 + JSON。
 *
 * 部分 handler 是「发起异步调用后立刻返回」的写法（`void Promise.resolve(…).then(…)`），
 * 这类 promise 的 rejection **不会**被 {@link guardedWebServer} 的 try/catch 看到——handler
 * 已经返回了。这类调用必须自己带上拒绝分支，否则既不回响应又产生 unhandled rejection。
 * 已经写过头/已 `end()` 的响应不补写。
 *
 * @param res - 响应对象。
 * @param error - 捕获到的异常。
 */
export function sendRouteError(res: ServerResponse, error: unknown): void {
  if (res.writableEnded) return
  res.writeHead(500, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify({ error: describeRouteError('TFS 工作台路由', error) }))
}

/**
 * 把 handler 抛出的异常整理成可回给客户端的一句话。
 *
 * 必须经 {@link scrubCredentials}：本插件的很多 handler 会把适配层/宿主错误原样带出，
 * 而 TFS 与 fetch 的报错文本里常见 `?token=`、`Authorization: Basic …` 等形态；
 * 错误文本是要进浏览器面板与日志的，不能顺手把凭据也送出去（T033/CHK002/SC-008）。
 *
 * @param path - 命中的路由路径（用户据此知道是哪个动作失败）。
 * @param error - 捕获到的异常。
 * @returns 单行中文原因（已限长、已擦除凭据）。
 */
export function describeRouteError(path: string, error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  const reason = scrubCredentials(raw).replace(/\s+/g, ' ').trim()
  const capped = reason.length > 500 ? `${reason.slice(0, 500)}…` : reason
  return `请求处理失败（${path}）：${capped || '未知错误'}`
}

/** 宿主 Connection 服务中本插件用到的结构切片（结构类型，不 import 具体包）。 */
export interface BrowserRequestGate {
  /** 请求可信且已鉴权时返回 undefined，否则返回拒绝状态码（401/403）。 */
  requestRejection(req: IncomingMessage): number | undefined
}

/** 单条可挂路由。 */
export interface GuardableRoute {
  readonly kind: 'exact' | 'prefix'
  readonly path: string
  readonly handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
}

/** 注册后的路由宿主最小面。 */
export interface GuardedRouteHost {
  register(route: GuardableRoute): () => void
}

/** 原始 webServer 最小面。 */
export interface RawRouteHost {
  register(route: GuardableRoute): () => void
}

/**
 * 把原始 webServer 包一层，使经它注册的每条路由都先过鉴权栅栏。
 * @param server - 宿主原始 webServer。
 * @param getGate - 读取当前 Connection 服务；未装配时返回 undefined。
 * @returns 所有路由都被门禁保护的路由宿主。
 */
export function guardedWebServer(
  server: RawRouteHost,
  getGate: () => BrowserRequestGate | undefined,
): GuardedRouteHost {
  return {
    register(route: GuardableRoute): () => void {
      const guarded = async (req: IncomingMessage, res: ServerResponse): Promise<void> => {
        // 失败关闭：取不到门禁属于装配问题，绝不能因此放行未鉴权请求。
        const gate = getGate()
        const rejection = gate === undefined ? 503 : gate.requestRejection(req)
        if (rejection !== undefined) {
          if (res.writableEnded) return
          res.writeHead(rejection, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({
            error: rejection === 503
              ? 'authentication unavailable'
              : rejection === 401
                ? 'unauthorized'
                : 'untrusted request origin',
          }))
          return
        }
        /**
         * 兜底错误边界。
         *
         * 本文件是**每一条**插件路由的唯一公共出口，因此错误边界放在这里最省事也最可靠：
         * `registerTfsRoutes` 注册的 40 余条路由全经 `guardedWebServer`，任何一条 handler
         * 抛出的异常（同步 throw 或 await 失败）都会在此被拦住。此前这里是裸
         * `await route.handler(req, res)`，异常直接逃到宿主 web server，客户端拿到的
         * 只是一个一直挂着的请求（连状态码都没有），同时宿主报一条 unhandled rejection；
         * 可触发的例子很多——`roles.json` / `profiles.json` 解析失败、
         * `refreshQueryOptions` 显式抛错、`trace-mapper` 遇脏事件等。
         *
         * 处理原则：
         * - 已经写过头/已 `end()` 的响应不再补写（handler 可能已自己回过错误）；
         * - 否则一律 500 + JSON，并带上经 {@link describeRouteError} 擦除凭据的原因；
         * - 异常一律吞掉：请求已经以 500 结束，再抛出去只会变成 unhandled rejection。
         */
        try {
          await route.handler(req, res)
        } catch (error) {
          if (res.writableEnded) return
          res.writeHead(500, {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          })
          res.end(JSON.stringify({ error: describeRouteError(route.path, error) }))
        }
      }
      return server.register({ ...route, handler: guarded })
    },
  }
}

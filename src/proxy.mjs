/**
 * 出口代理。
 *
 * ★ 这是「登录未完成：The socket connection was closed unexpectedly」的根因修复。
 *
 * 背景：magpie 的插件宿主（host.js）启动时把 magpie 的全局代理放进 MAGPIE_*_PROXY，
 * 但**插件自己发起的 fetch 只有在 magpie 显式传了 proxy 时才会走代理**：
 *
 *   · host.js 的 proxyOf(input)：own = via.getStore()（本次请求所属 provider 的代理）
 *     优先；own 为空才回落到 globalProxy（宿主启动时的 MAGPIE_*_PROXY）。
 *   · 登录时 via 存的是 **provider 在 providers.json 里的 proxy**，
 *     也就是 `magpie provider set <id> proxy=...` 设的那个。
 *   · 插件的 authorize() 里自己发起的 fetch（换 token、签票、读目录）如果
 *     provider 在 providers.json 里**没有条目**，via 存的就是空串 → 走 globalProxy；
 *     而宿主是在没有全局代理的环境里起来的（"host starts with no proxy"），
 *     于是直连华为 → 一台没有直连出口的机器上就是
 *     "The socket connection was closed unexpectedly"。
 *
 * 修法（两道保险）：
 *   ① 宿主那条路：在 providers.json 里给这个 provider 补一条带 proxy 的条目
 *      （magpie 侧的配置，插件管不了，已在部署脚本里做）。
 *   ② 插件这条自己兜住：显式给每一次 fetch 带上代理 —— 从环境变量读
 *      MAGPIE_HTTPS_PROXY / MAGPIE_HTTP_PROXY / MAGPIE_ALL_PROXY（宿主给的就是这些），
 *      拿不到再回落到 HTTPS_PROXY / HTTP_PROXY / ALL_PROXY。
 *
 * ★ Bun 的 fetch 只吃 http:// 和 https:// 代理，socks5:// 会报
 *   "UnsupportedProxyProtocol"。宿主（host.js）把 socks5 桥接成 loopback 上的
 *   http:// 代理再给 Bun；插件拿不到那个桥，所以自己把 socks5:// 换成同端口的
 *   http://（sing-box 这类 mixed 入站同时听两种协议，实测 1081 端口两者都通）。
 */

import { URL } from 'node:url'

/** 从环境里取代理地址（宿主给的是 MAGPIE_*_PROXY，其次是常见的 *_PROXY） */
export function proxyFromEnv(env = process.env) {
  const pick = (...keys) => {
    for (const k of keys) {
      const v = env[k]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
    return ''
  }
  return (
    pick('MAGPIE_HTTPS_PROXY', 'MAGPIE_HTTP_PROXY', 'MAGPIE_ALL_PROXY') ||
    pick('HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY') ||
    ''
  )
}

/**
 * Bun 的 fetch 要 http(s) 代理；socks5:// 的换成同 host:port 的 http://。
 * 宿主（netproxy.ForBun）也是这么桥的：它起一个 loopback 上的 http 代理
 * 转发给 SOCKS5。插件拿不到那个桥，但 sing-box 这类 mixed 入站端口
 * 同时听 http 和 socks5，直接换协议即可。
 */
export function toBunProxy(proxy) {
  const p = String(proxy || '').trim()
  if (!p) return ''
  if (!/^socks5h?:\/\//i.test(p)) return p
  try {
    const u = new URL(p)
    const port = u.port || (u.protocol === 'socks5:' ? '1080' : '1080')
    const auth = u.username ? `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password)}@` : ''
    return `http://${auth}${u.hostname}:${port}`
  } catch {
    return p
  }
}

/**
 * 给 fetch 的 init 加上代理（没有代理就原样返回）。
 * 只对 https/http 的上游加；loopback 不加。
 */
export function withProxy(init, proxy) {
  const p = toBunProxy(proxy)
  if (!p) return init
  if (init && typeof init === 'object' && init.proxy) return init
  return { ...(init || {}), proxy: p }
}

/** 一次带代理的 fetch：代理来自环境。 */
export async function proxyFetch(url, init = {}) {
  const proxy = proxyFromEnv()
  const opts = withProxy(init, proxy)
  return fetch(url, opts)
}

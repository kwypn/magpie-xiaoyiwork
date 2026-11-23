/**
 * 登录方式：华为账号 OAuth（PKCE）+ 本机登录态导入。
 *
 * 两条路的边界要说清楚：
 *   · OAuth：不需要装小艺Work。PKCE → 浏览器授权 → 本地回调 127.0.0.1:17355/auth/callback
 *     → /oauth2/v3/token 换 accessToken + refreshToken → business-credential/create 签 7 天票。
 *     ⚠ 登录要占 17355 端口接回调，小艺Work 常驻会抢这个端口 → 登录前必须完全退出它。
 *   · 本机导入：Windows 专属，读注册表 + DPAPI + AES-256-GCM 解出 businessCredential。
 *     前提是这台机器上小艺Work 登录过一次（deviceId 必须是已登记设备）。
 *
 * authorize() 必须立刻返回 —— 真正等用户的是 callback()，在 authorize 里死等会和 magpie 死锁。
 */

import crypto from 'node:crypto'
import http from 'node:http'

import { ENDPOINTS, OAUTH } from './context.mjs'
import { b64url, readJsonSafe } from './gateway.mjs'
import { createCredential, deviceIdFor, readLocalCredential } from './credential.mjs'
import { proxyFetch } from './proxy.mjs'

export function buildAuthorizeUrl(challenge, state) {
  const q = new URLSearchParams({
    response_type: 'code',
    access_type: OAUTH.accessType,
    client_id: OAUTH.clientId,
    redirect_uri: OAUTH.redirectUri,
    scope: OAUTH.scope,
    code_challenge: challenge,
    code_challenge_method: 'S256',
    state,
    display: 'page',
  })
  return `${ENDPOINTS.authorize}?${q.toString()}`
}

/**
 * 本地回调服务器。
 * ⚠ 不能等 server.close(cb) 才继续 —— Chrome/Edge 往 127.0.0.1:17355 会做空闲预连接，
 *   那条空闲连接会让 close 的回调不触发，流程卡死。先 resolve，再 closeAllConnections()。
 */
export function startCallbackServer(expectedState, signal) {
  let settle
  const codePromise = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || '/', `http://127.0.0.1:${OAUTH.callbackPort}`)
    if (url.pathname !== OAUTH.callbackPath) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
      return
    }
    const code = url.searchParams.get('code')
    const gotState = url.searchParams.get('state')
    const error = url.searchParams.get('error')
    const html = (body) =>
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', connection: 'close' }).end(
        `<!doctype html><meta charset="utf-8"><body style="font:16px/1.7 system-ui;margin:48px">${body}</body>`,
      )
    if (error || !code) {
      html('<h2>授权失败</h2><p>回到 magpie 看错误信息。</p>')
      settle.reject(new Error(`授权回调失败：${error || '缺少 code'} ${url.searchParams.get('error_description') || ''}`))
      return
    }
    if (gotState !== expectedState) {
      html('<h2>state 不匹配</h2><p>请重新登录。</p>')
      settle.reject(new Error('回调 state 不匹配（可能是过期的授权链接）'))
      return
    }
    html('<h2>登录成功 ✅</h2><p>可以关闭这个页面了。</p>')
    settle.resolve(code)
  })
  const timer = setTimeout(() => settle.reject(new Error('授权超时（5 分钟）')), OAUTH.codeTtlMs)

  const close = () => {
    clearTimeout(timer)
    try {
      server.closeAllConnections?.()
      server.close()
    } catch {
      /* ignore */
    }
  }
  signal?.addEventListener?.('abort', () => settle.reject(new Error('登录已取消')))
  codePromise.catch(() => {}).finally(close)

  const listening = new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(OAUTH.callbackPort, '127.0.0.1', resolve)
  })

  return { codePromise, listening, close }
}

export async function exchangeCode(code, verifier) {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    client_id: OAUTH.clientId,
    code_verifier: verifier,
    redirect_uri: OAUTH.redirectUri,
  })
  // ★ 走代理：华为的 OAuth 端点在直连不通的机器上就是
  //   "The socket connection was closed unexpectedly"。
  const res = await proxyFetch(ENDPOINTS.token, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body,
  })
  const text = await res.text()
  const json = readJsonSafe(text) ?? {}
  if (!res.ok || !json.access_token) {
    throw new Error(`换 token 失败（HTTP ${res.status}）：${json.error_description || text.slice(0, 200)}`)
  }
  const claims = readJsonSafe(Buffer.from(String(json.id_token || '').split('.')[1] || '', 'base64url').toString('utf8')) ?? {}
  return {
    accessToken: json.access_token,
    refreshToken: json.refresh_token || null,
    idToken: json.id_token || '',
    scope: json.scope || OAUTH.scope,
    expiresIn: Number(json.expires_in) || 3600,
    user: {
      uid: claims.uid,
      openid: claims.openid,
      unionId: claims.sub,
      aud: claims.aud,
      displayName: claims.display_name || claims.nickname,
    },
  }
}

/** 探测 17355 端口是否被占（小艺Work 常驻会抢） */
export async function probeCallbackPort() {
  if (process.platform !== 'win32') return null
  const probe = http.createServer()
  try {
    await new Promise((resolve, reject) => {
      probe.once('error', reject)
      probe.listen(OAUTH.callbackPort, '127.0.0.1', resolve)
    })
    return null
  } catch {
    return `端口 ${OAUTH.callbackPort} 被占用：登录需要它接回调，请先完全退出小艺Work再重试`
  } finally {
    try {
      probe.close()
    } catch {
      /* ignore */
    }
  }
}

/** 发起 OAuth 登录：返回 magpie 的 {url, instructions, method, callback} 形状 */
export async function startBrowserLogin(guardDuplicate) {
  const busy = await probeCallbackPort()
  if (busy) return { type: 'failed', error: busy }

  const verifier = b64url(crypto.randomBytes(32))
  const challenge = b64url(crypto.createHash('sha256').update(verifier).digest())
  const state = crypto.randomBytes(12).toString('hex')
  const server = startCallbackServer(state, null)
  try {
    await server.listening
  } catch (err) {
    return { type: 'failed', error: `回调服务启动失败：${err.message}` }
  }

  return {
    url: buildAuthorizeUrl(challenge, state),
    instructions: '用华为账号登录。注意：小艺Work 若开着会占用 17355 端口，请先退出它。',
    method: 'auto',
    async callback() {
      try {
        const code = await server.codePromise
        const session = await exchangeCode(code, verifier)
        const uid = session.user?.uid
        if (!uid) return { type: 'failed', error: '华为账号信息里没有 uid' }
        const dup = guardDuplicate?.(uid)
        if (dup) return { type: 'failed', error: dup }
        const deviceId = deviceIdFor(uid)
        const created = await createCredential(session.accessToken, uid, deviceId)
        if (!created.ok) return { type: 'failed', error: `签发 businessCredential 失败：${created.message}` }
        return {
          type: 'success',
          key: created.credential,
          accountId: uid,
          uid,
          deviceId,
          metadata: {
            uid,
            deviceId,
            expires: created.validTimeSec * 1000,
            refreshToken: session.refreshToken || undefined,
          },
        }
      } catch (err) {
        return { type: 'failed', error: err?.message || String(err) }
      }
    },
  }
}

/** 导入本机登录态（Windows 专属） */
export function startLocalImport(guardDuplicate) {
  if (process.platform !== 'win32') {
    return { type: 'failed', error: '这种方式只支持 Windows（读注册表凭据）。请改用浏览器登录。' }
  }
  try {
    const local = readLocalCredential()
    const dup = guardDuplicate?.(local.uid)
    if (dup) return { type: 'failed', error: dup }
    return {
      type: 'success',
      key: local.credential,
      accountId: local.uid,
      uid: local.uid,
      deviceId: local.deviceId,
      metadata: {
        uid: local.uid,
        deviceId: local.deviceId,
        expires: local.validTimeSec ? local.validTimeSec * 1000 : undefined,
        refreshToken: local.refreshToken || undefined,
        fromLocal: true,
      },
    }
  } catch (err) {
    return { type: 'failed', error: err?.message || String(err) }
  }
}

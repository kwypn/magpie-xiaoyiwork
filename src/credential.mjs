/**
 * 凭据层：登录态归一化、签票、网关代刷续期。
 *
 * 凭据形态：businessCredential（7 天）+ x-uid + x-device-id（已登记设备校验）。
 * 续期是两步紧挨着的动作：
 *   businessCredential ──网关代刷──> accessToken(1h) ──立刻签票──> 新 businessCredential
 * accessToken 有「新鲜度」窗口（几分钟），所以刷新和签票必须背靠背，不能缓存复用。
 */

import crypto from 'node:crypto'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

import { ENDPOINTS, OAUTH } from './context.mjs'
import { hagHeaders, postJson, readJsonSafe, traceId } from './gateway.mjs'

/* ------------------------------------------------------------------ 设备标识 */

let cachedMachineId = null

/** Windows 的 MachineGuid；非 Windows 退化成 hostname|username 的哈希 */
function machineGuid() {
  if (process.platform !== 'win32') return null
  for (const key of [
    'HKLM\\SOFTWARE\\Microsoft\\Cryptography',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Cryptography',
  ]) {
    try {
      const out = execFileSync('reg.exe', ['query', key, '/v', 'MachineGuid'], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 8000,
      })
      const m = out.match(/MachineGuid\s+REG_SZ\s+(.*)/)
      if (m?.[1]) return m[1].trim()
    } catch {
      /* 下一个 */
    }
  }
  return null
}

/**
 * deviceId 是「已登记设备」校验，不是随便算的：
 * 真实值 = sha256(MachineGuid).hex(小写) + "_" + uid
 * 伪造值即使 token 新鲜也报 clientId is invalid（错误信息骗人，其实是设备校验）。
 */
export function machineId() {
  if (cachedMachineId) return cachedMachineId
  const guid = machineGuid()
  if (guid) cachedMachineId = crypto.createHash('sha256').update(guid).digest('hex').toLowerCase()
  else cachedMachineId = crypto.createHash('sha256').update(`${os.hostname()}|${os.userInfo().username}`).digest('hex').toLowerCase()
  return cachedMachineId
}

export function deviceIdFor(uid) {
  return `${machineId()}_${uid}`
}

/* ---------------------------------------------------------------- 登录态归一 */

export function normalizeAuth(auth) {
  if (!auth || typeof auth !== 'object') return null
  const credential = auth.access || auth.key || null
  const uid = auth.uid || auth.metadata?.uid || null
  if (!credential || !uid) return null
  const expiresMs = auth.metadata?.expires ?? (auth.expires ? Number(auth.expires) : null)
  return {
    credential,
    uid,
    deviceId: auth.deviceId || auth.metadata?.deviceId || deviceIdFor(uid),
    refreshToken: auth.refresh || auth.metadata?.refreshToken || null,
    validTimeSec:
      typeof expiresMs === 'number' && Number.isFinite(expiresMs)
        ? Math.floor(expiresMs / 1000)
        : auth.validTimeSec ?? null,
    fromLocal: auth.metadata?.fromLocal === true,
  }
}

/* ------------------------------------------------------------------ 签票/代刷 */

function credentialExtras(json) {
  const credential =
    json?.credentialResult?.businessCredential ||
    json?.credentialResult?.credential ||
    json?.data?.businessCredential ||
    json?.data?.credential ||
    json?.businessCredential ||
    json?.credential ||
    null
  const validTimeSec =
    (typeof json?.credentialResult?.validTime === 'number' && json.credentialResult.validTime) ||
    (typeof json?.data?.validTime === 'number' && json.data.validTime) ||
    (typeof json?.validTime === 'number' && json.validTime) ||
    null
  return { credential, validTimeSec }
}

/** 用 accessToken 签一张 7 天的 businessCredential */
export async function createCredential(uat, uid, deviceId) {
  const res = await postJson(ENDPOINTS.credential, {
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${uat}`,
      'x-uid': uid,
      'x-client-version': '1.0.0',
      'x-hag-trace-id': traceId(),
    },
    body: { deviceId, uid, clientId: OAUTH.clientId, sysVer: '5.0.0', version: '1.0.0', ts: String(Date.now()) },
  })
  const { credential, validTimeSec } = credentialExtras(res.json)
  if (!res.ok || !credential) {
    const message = res.json?.desc || res.json?.message || res.text.slice(0, 200) || `HTTP ${res.status}`
    return { ok: false, status: res.status, message: `${message}（HTTP ${res.status}）`, raw: res.json }
  }
  return {
    ok: true,
    credential,
    validTimeSec: validTimeSec ?? Math.floor(Date.now() / 1000) + 7 * 86400,
    raw: res.json,
  }
}

/**
 * 网关代刷：把 refreshToken 交给 HAG 换新 accessToken。
 * App 是机密客户端、client_secret 在服务端，所以 OAuth 的 refresh_token 走不通
 * （400 missing required parameter: client_secret），只能走这里。
 */
export async function gatewayRefreshToken({ credential, uid, deviceId, refreshToken }) {
  const res = await postJson(ENDPOINTS.refresh, {
    headers: hagHeaders({ credential, uid, deviceId, sse: false }),
    body: { refreshToken },
  })
  const token = typeof res.json?.token === 'string' ? res.json.token.trim() : ''
  if (!res.ok || !token) {
    const message = res.json?.desc || res.json?.message || res.text.slice(0, 200) || `HTTP ${res.status}`
    return { ok: false, status: res.status, message: `${message}（HTTP ${res.status}）` }
  }
  return { ok: true, token }
}

/** 完整续期：代刷 → 立刻签票。两步必须紧挨着。 */
export async function renewCredential(state) {
  const { credential, refreshToken, uid, deviceId } = state
  if (!refreshToken) return { ok: false, message: '没有 refreshToken，请重新登录' }
  const refreshed = await gatewayRefreshToken({ credential, uid, deviceId, refreshToken })
  if (!refreshed.ok) return { ok: false, message: `网关代刷失败：${refreshed.message}` }
  const created = await createCredential(refreshed.token, uid, deviceId)
  if (!created.ok) return { ok: false, message: `签票失败：${created.message}` }
  return { ok: true, credential: created.credential, validTimeSec: created.validTimeSec, accessToken: refreshed.token }
}

/** 幂等续期：快到期才续，续成功就更新 state */
export async function ensureFreshState(state) {
  if (!state) return state
  const remaining = state.validTimeSec ? state.validTimeSec * 1000 - Date.now() : Infinity
  if (remaining > 12 * 3600_000) return state
  const renewed = await renewCredential(state).catch(() => null)
  if (renewed?.ok) {
    state.credential = renewed.credential
    state.validTimeSec = renewed.validTimeSec
  }
  return state
}

/* ------------------------------------------ 本机登录态（Windows 注册表 + DPAPI） */

const KEYCHAIN = 'HKCU\\Software\\ClawDesktop\\keychain'
const USER_DATA_NAMES = ['xiaoyiWork', 'xiaoyiwork']

function regQuery(path, name) {
  if (process.platform !== 'win32') return null
  try {
    const out = execFileSync('reg.exe', ['query', path, '/v', name], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 8000,
    })
    const m = out.match(/REG_SZ\s+(.*)/)
    return m?.[1]?.trim() || null
  } catch {
    return null
  }
}

/** PowerShell 调 DPAPI 解出 Chromium os_crypt 主密钥（base64） */
function dpapiUnprotect(blob) {
  const script = `$b=[System.Convert]::FromBase64String('${Buffer.from(blob).toString('base64')}');$s=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);[System.Convert]::ToBase64String($s)`
  const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', utf16le(script)], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000,
  })
  return Buffer.from(out.trim(), 'base64')
}

function utf16le(text) {
  return Buffer.from(text, 'utf16le').toString('base64')
}

/**
 * 读取本机小艺Work 登录态：
 *   %APPDATA%\xiaoyiWork\Local State → os_crypt.encrypted_key（DPAPI 保护）
 *   HKCU\Software\ClawDesktop\keychain\{business-credential,auth-session}（OSCrypt v10 信封）
 * 明文只在内存里，不落盘。
 */
export function readLocalCredential() {
  if (process.platform !== 'win32') throw new Error('读取本机凭据仅支持 Windows')
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  let stateFile = null
  for (const name of USER_DATA_NAMES) {
    const candidate = path.join(appData, name, 'Local State')
    if (fs.existsSync(candidate)) {
      stateFile = candidate
      break
    }
  }
  if (!stateFile) throw new Error(`找不到小艺Work 数据目录（${path.join(appData, 'xiaoyiWork')}）`)

  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8'))
  const encKey = state?.os_crypt?.encrypted_key
  if (!encKey) throw new Error('Local State 缺少 os_crypt.encrypted_key')
  const raw = Buffer.from(encKey, 'base64')
  if (raw.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('不支持的 os_crypt 加密方案（并非 DPAPI）')
  const masterKey = dpapiUnprotect(raw.subarray(5))

  const decrypt = (blobB64) => {
    const blob = Buffer.from(blobB64, 'base64')
    if (blob.subarray(0, 3).toString('latin1') !== 'v10') throw new Error('无法识别的密文前缀')
    const nonce = blob.subarray(3, 15)
    const tag = blob.subarray(blob.length - 16)
    const ct = blob.subarray(15, blob.length - 16)
    const d = crypto.createDecipheriv('aes-256-gcm', masterKey, nonce)
    d.setAuthTag(tag)
    return JSON.parse(Buffer.concat([d.update(ct), d.final()]).toString('utf8'))
  }
  const readSecret = (service, account) => {
    const value = regQuery(`${KEYCHAIN}\\${service}`, Buffer.from(account).toString('base64url'))
    if (!value) return null
    try {
      return decrypt(value).v
    } catch {
      return null
    }
  }

  const credRaw = readSecret('business-credential', 'default')
  const cred = readJsonSafe(credRaw)
  if (!cred?.credential || !cred?.uid) throw new Error('本机没有 businessCredential：先打开小艺Work 登录一次')
  const sessionRaw = readSecret('auth-session', 'default')
  const session = readJsonSafe(sessionRaw)
  return {
    credential: cred.credential,
    uid: cred.uid,
    deviceId: `${machineId()}_${cred.uid}`,
    validTimeSec: cred.validTimeSec ?? null,
    refreshToken: session?.refreshToken ?? null,
  }
}

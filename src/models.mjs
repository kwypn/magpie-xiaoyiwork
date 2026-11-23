/**
 * 模型目录与额度观测。
 *
 * 模型目录：POST /user-ability-gallery/v1/agent/user/query
 *   ⚠ 必须带 x-prd-pkg-name: com.huawei.hmos.vassistant，否则回 400
 *     「Parameter is not valid. Parameter is [x-prd-pkg-name]」，
 *     目录/倍率全丢（静默回退到静态表，很难发现）。
 *   返回字段：modelValue(id) / modelName / modelDescription / modelImage / gray /
 *            aiPointConsumptionRatio（如「消耗13x」）。
 *
 * 额度：POST /ability-billing/v1/agent-purchases-client/privilege/query
 *   两个互不相干的桶：
 *     ① 会员积分 pool（agentId=1 的 celiaPremiumPrivilege.aiPoints）
 *        freePoints / purchasedPoints / giftPoints / compstPoints / totalPoints
 *        —— 上游不给任何重置日期或有效期字段（aiPointDetailDisplay:false）
 *     ② 权益包（平台 agentId 的 privilegeList）
 *        privilegeDetail 里带「剩余积分：N」，expireTime 是作废时间（不是按月重置）
 */

import fs from 'node:fs'
import path from 'node:path'

import { CELIA_PREMIUM_AGENT_ID, ENDPOINTS, PLATFORM_AGENT_ID, PRD_PKG_NAME } from './context.mjs'
import { hagHeaders, normalizeRate, postJson, readJsonSafe } from './gateway.mjs'

const num = (v) => {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

/** 上游时间是紧凑格式 yyyyMMddHHmmssSSS（北京时间） */
export function parseCompactTime(value) {
  if (typeof value !== 'string') return null
  const m = value.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{1,3})?$/)
  if (!m) return null
  const [, y, mo, d, h, mi, s, ms = '0'] = m
  const time = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h) - 8, Number(mi), Number(s), Number(ms.padEnd(3, '0')))
  return { iso: new Date(time).toISOString(), epoch: time }
}

/** 拉真实模型目录（含倍率、灰度标记） */
export async function queryCatalog(state) {
  const res = await postJson(ENDPOINTS.gallery, {
    headers: {
      ...hagHeaders({ ...state, sse: false }),
      // 缺这个头网关直接 400，目录/倍率就全丢了
      'x-prd-pkg-name': PRD_PKG_NAME,
    },
    body: {
      type: 'CELIA_CLAW_USER_MODEL_QUERY',
      terminalInfo: {
        agentId: PLATFORM_AGENT_ID,
        brand: 'HUAWEI',
        countryCode: 'CN',
        deviceType: 'PC',
        language: 'zh_CN',
        locale: 'zh-CN',
        manufacturer: 'HUAWEI',
        osType: 'Hap',
        prdVer: '11.6.5.414',
        privacyOption: {},
        sysVer: 'OpenHarmony-6.1.1.35(Beta1)',
        ohosApiVersion: 24,
      },
      pagination: { limit: 500, start: '0' },
    },
  })
  if (!res.ok) return null
  const list = []
  for (const content of res.json?.contents ?? []) {
    for (const item of content.modelList ?? []) {
      const id = String(item.modelValue || '').trim()
      if (!id) continue
      list.push({
        id,
        name: String(item.modelName || id).trim(),
        description: String(item.modelDescription || '').trim(),
        rate: normalizeRate(item.aiPointConsumptionRatio),
        gray: item.gray === true,
      })
    }
  }
  return list.length ? list : null
}

/** 查某个 agentId 的权益（agentId=1 那个接口偶发 408，多试几次） */
export async function queryBilling(agentId, state) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const res = await postJson(ENDPOINTS.billing, {
      headers: hagHeaders({ ...state, sse: false }),
      body: {
        accountType: 'HW_UID',
        agentId,
        endpoint: {
          device: { brand: 'HUAWEI', deviceId: state.deviceId },
          eduMode: 'NONEDU',
          foregroundPkgName: '',
          isXiaoyiAPP: false,
          language: 'zh_CN',
          languageMode: 'MANDARIN',
          locale: 'default',
        },
      },
    }).catch(() => null)
    if (res?.ok) return res.json
    if (attempt < 2) await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
  }
  return null
}

/* ------------------------------------------------- 额度状态（观测最大值当分母） */

/*
 * 上游没有发放总量字段：
 *   · 会员积分池只有余额分解（freePoints/purchasedPoints/... 之和 = totalPoints）
 *   · 权益包只有 privilegeDetail 里的「剩余积分：N」，没有「发了多少」
 * 所以「总计」只能取「装本插件之后观测到的最大值」当分母 —— 首次读取时剩余即总计，
 * 之后随消耗呈现 剩余/总计。状态写在 magpie 配置目录里，按 uid + 额度名分别记。
 */

export const POINTS_STATE_FILE = 'xiaoyi-points-state.json'

export function readPointsState(configDir) {
  if (!configDir) return {}
  try {
    return JSON.parse(fs.readFileSync(path.join(configDir, POINTS_STATE_FILE), 'utf8')) ?? {}
  } catch {
    return {}
  }
}

export function writePointsState(configDir, state) {
  if (!configDir) return
  try {
    fs.writeFileSync(path.join(configDir, POINTS_STATE_FILE), JSON.stringify(state, null, 2))
  } catch {
    /* 只读目录之类，忽略 */
  }
}

/** 记录并返回某个额度桶观测到的最大余额（= 总计） */
export function observeMax(bucket, key, amount) {
  const prev = num(bucket[key])
  const next = Math.max(prev, num(amount))
  if (next !== prev) bucket[key] = next
  return next
}

/**
 * 组装 magpie 的 usage 结果。
 * 返回 { plan, user, balance, windows, until, renew, error }
 * magpie 的约定：windows[].amount = 已用，limit = 总量（反过来会把账号判成额度耗尽）。
 */
export async function buildUsage(state, configDir) {
  const [premium, platform] = await Promise.all([
    queryBilling(CELIA_PREMIUM_AGENT_ID, state),
    queryBilling(PLATFORM_AGENT_ID, state),
  ])

  const celia = premium?.celiaPremiumPrivilege ?? null
  const points = celia?.aiPoints ?? {}
  const membership = celia?.membership ?? {}
  const subscription = celia?.subscription ?? null
  const privileges = Array.isArray(platform?.privilegeList) ? platform.privilegeList : []

  const fmtDate = (ms) =>
    new Date(ms).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false }).replace(/:\d{2}$/, '')

  const windows = []
  const totalPoints = num(points.totalPoints)
  const stateFile = readPointsState(configDir)
  const bucket = (stateFile[state.uid] ??= {})

  if (celia) {
    const breakdown = [
      points.freePoints != null ? `免费 ${num(points.freePoints)}` : null,
      num(points.purchasedPoints) ? `购买 ${num(points.purchasedPoints)}` : null,
      num(points.giftPoints) ? `赠送 ${num(points.giftPoints)}` : null,
      num(points.compstPoints) ? `补偿 ${num(points.compstPoints)}` : null,
    ].filter(Boolean)
    const total = observeMax(bucket, 'membership', totalPoints)
    windows.push({
      name: `会员积分（${membership.skuGroupName || '小艺'}）`,
      display: `剩余 ${totalPoints} / 总计 ${total} 点${breakdown.length ? '（' + breakdown.join(' / ') + '）' : ''}`,
      amount: Math.max(0, total - totalPoints),
      limit: total,
      unit: '点',
    })
  }

  const expiries = []
  for (const p of privileges) {
    const detail = Array.isArray(p.privilegeDetail) ? p.privilegeDetail.join(' ') : String(p.privilegeDetail ?? '')
    const remain = num(detail.match(/(\d+(?:\.\d+)?)/)?.[1])
    const expire = parseCompactTime(p.expireTime)
    if (expire) expiries.push(expire.epoch)
    const label = p.privilegeName || '权益包'
    const bucketKey = `priv:${p.privilegeId || label}`
    const total = observeMax(bucket, bucketKey, remain)
    windows.push({
      name: expire ? `${label}（${fmtDate(expire.epoch)} 到期）` : label,
      display: `剩余 ${remain} / 总计 ${total} 点${expire ? ` · ${fmtDate(expire.epoch)} 到期` : ''}`,
      ...(total ? { amount: Math.max(0, total - remain), limit: total, unit: '点' } : {}),
      ...(expire ? { runsOutAt: expire.iso } : {}),
      aside: false,
    })
  }

  writePointsState(configDir, stateFile)

  const subExpire = parseCompactTime(subscription?.expireTime)
  const error =
    !celia && !privileges.length
      ? '两类查询都没拿到数据，可能是凭据过期或网络问题'
      : [premium ? null : '会员/积分查询失败', platform ? null : '权益包查询失败'].filter(Boolean).join('；')

  const result = {
    plan: membership.skuGroupName || undefined,
    user: state.uid,
    balance: totalPoints ? `${totalPoints} 点` : undefined,
    ...(subExpire ? { until: subExpire.iso } : {}),
    renew: subscription?.autoRenew === true ? 'auto' : subscription ? 'off' : undefined,
    windows,
    ...(error ? { error } : {}),
  }

  // 上游额度接口偶发 408/超时。一次都没拿到窗口时回落到上次成功的结果，
  // 否则 magpie 会把供应商判成 kind:"balance" 并清空窗口，看起来像「没有额度」。
  if (windows.length) {
    bucket.lastGood = { at: new Date().toISOString(), plan: result.plan, windows: result.windows, until: result.until }
    writePointsState(configDir, stateFile)
    return result
  }
  writePointsState(configDir, stateFile)
  if (bucket.lastGood?.windows?.length) {
    return {
      ...bucket.lastGood,
      user: state.uid,
      error: `${error || '上游暂时没返回额度'}；显示的是 ${bucket.lastGood.at} 读到的上一次结果`,
    }
  }
  return result
}

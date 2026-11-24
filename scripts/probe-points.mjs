#!/usr/bin/env node
/**
 * 实测「小艺Work 的 Kimi K3.1 Pro 是否真的不扣 AI 点」。
 *
 * 方法（a 机实测用）：
 *   1. 读调用前的余额：POST /ability-billing/v1/agent-purchases-client/privilege/query
 *      agentId=1 → celiaPremiumPrivilege.aiPoints.totalPoints
 *   2. 打一次指定模型的对话：POST /celia/v1/sse-api/chat/completions
 *   3. 再读一次余额，比较 totalPoints 掉了多少
 *   4. 判据：掉点 = 0 → 真的是「不扣」（无限）；
 *      掉点 ≈ 倍率 × token 量 → 正常计费，没有无限这回事。
 *
 * 用法：
 *   node scripts/probe-points.mjs                 # 默认测 Kimi_K3.1_Pro_VE
 *   node scripts/probe-points.mjs Kimi_K3         # 测别的模型
 *   node scripts/probe-points.mjs Kimi_K3.1_Pro_VE 3   # 连打 3 次看累计
 *
 * 凭据从 magpie 的 plugin-auth.json 读（不打印明文）。
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { CELIA_PREMIUM_AGENT_ID, CHAT_PATH, ENDPOINTS, SSE_BASE } from '../src/context.mjs'
import { hagHeaders, postJson } from '../src/gateway.mjs'
import { normalizeAuth } from '../src/credential.mjs'
import { proxyFromEnv, withProxy } from '../src/proxy.mjs'

const MAGPIE_DIR = process.env.MAGPIE_DIR || path.join(os.homedir(), '.config', 'magpie')
const AUTH_FILE = path.join(MAGPIE_DIR, 'plugin-auth.json')

const model = process.argv[2] || 'Kimi_K3.1_Pro_VE'
const rounds = Number(process.argv[3] || 1)
const PROMPT = process.argv[4] || '用一句话回答：什么是 AI 点？'

/** 从 magpie 的 plugin-auth.json 取这个 provider 的凭据 */
function loadAuth() {
  const all = JSON.parse(fs.readFileSync(AUTH_FILE, 'utf8'))
  const slot = Object.keys(all).find((k) => k === 'xiaoyiwork' || k.startsWith('xiaoyiwork#'))
  if (!slot) throw new Error('plugin-auth.json 里没有 xiaoyiwork 的账号')
  const v = all[slot]
  const md = v.metadata || {}
  const auth = {
    access: v.access || v.key,
    uid: md.uid,
    deviceId: md.deviceId,
    refresh: md.refreshToken,
    metadata: md,
  }
  const state = normalizeAuth(auth)
  if (!state) throw new Error('凭据不完整（缺 credential 或 uid）')
  return { slot, state }
}

/** 读一次余额（只取会员积分 pool 的 totalPoints 与各分项） */
async function readPoints(state) {
  const res = await postJson(ENDPOINTS.billing, {
    headers: hagHeaders({ ...state, sse: false }),
    body: {
      accountType: 'HW_UID',
      agentId: CELIA_PREMIUM_AGENT_ID,
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
  })
  if (!res.ok) return { error: `HTTP ${res.status}: ${res.text.slice(0, 200)}` }
  const celia = res.json?.celiaPremiumPrivilege ?? null
  const points = celia?.aiPoints ?? {}
  return {
    total: Number(points.totalPoints ?? 0),
    free: Number(points.freePoints ?? 0),
    purchased: Number(points.purchasedPoints ?? 0),
    gift: Number(points.giftPoints ?? 0),
    compst: Number(points.compstPoints ?? 0),
    membership: celia?.membership?.skuGroupName || '',
  }
}

/** 打一次对话，返回 usage 与是否成功 */
async function chat(state, modelId, prompt) {
  // ★ 走代理：a 机没有直连出口，Bun 的 fetch 直连华为会被断连。
  //   withProxy 会把 socks5:// 换成同端口 http://（Bun 不吃 socks5）。
  const res = await fetch(
    `${SSE_BASE}${CHAT_PATH}`,
    withProxy(
      {
        method: 'POST',
        headers: hagHeaders({ ...state, sse: true }),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: prompt }],
          stream: true,
        }),
      },
      proxyFromEnv(),
    ),
  )
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: t.slice(0, 300) }
  }
  const text = await res.text()
  let content = ''
  let reasoning = ''
  let usage = null
  for (const block of text.split(/\n\n/)) {
    const data = block
      .split('\n')
      .filter((l) => l.startsWith('data:'))
      .map((l) => l.slice(5).trim())
      .join('')
    if (!data || data === '[DONE]') continue
    let f
    try {
      f = JSON.parse(data)
    } catch {
      continue
    }
    if (f.usage) usage = f.usage
    const c = f.choices?.[0]?.delta ?? f.choices?.[0]?.message
    if (typeof c?.content === 'string') content += c.content
    if (typeof c?.reasoning_content === 'string') reasoning += c.reasoning_content
  }
  return { ok: true, content, reasoning, usage, bytes: text.length }
}

const { slot, state } = loadAuth()
console.log(`账号槽位: ${slot}   uid: ${state.uid}`)
console.log(`模型: ${model}   轮次: ${rounds}\n`)

const before = await readPoints(state)
if (before.error) {
  console.error('读余额失败:', before.error)
  process.exit(1)
}
console.log(`调用前余额: 总计 ${before.total} 点（免费 ${before.free} / 购买 ${before.purchased} / 赠送 ${before.gift} / 补偿 ${before.compst}）  会员档: ${before.membership}\n`)

for (let i = 1; i <= rounds; i++) {
  const t0 = Date.now()
  const r = await chat(state, model, PROMPT)
  const ms = Date.now() - t0
  if (!r.ok) {
    console.log(`第 ${i} 次: 失败 HTTP ${r.status} — ${r.error}`)
    continue
  }
  const after = await readPoints(state)
  const drop = before.total - after.total
  const u = r.usage || {}
  console.log(
    `第 ${i} 次: ${ms}ms  tokens in=${u.prompt_tokens ?? '?'} out=${u.completion_tokens ?? '?'}  ` +
      `余额 ${after.total} 点  本次掉点=${drop}` +
      (r.content ? `  回复="${r.content.slice(0, 40).replace(/\n/g, ' ')}"` : `  (content 空, reasoning ${r.reasoning.length} 字)`),
  )
  if (drop !== 0) before.total = after.total
}

const after = await readPoints(state)
console.log(`\n最终余额: ${after.total} 点`)
console.log(`判据：掉点=0 → 真的不扣；掉点≈倍率×token → 正常计费`)

#!/usr/bin/env node
/**
 * 判定「小艺Work 是不是真的无限用」——加压测试。
 *
 * 思路：免费额度只有 200 点，Kimi 是 13x（最贵）。
 * 如果按倍率扣，几次就该见底 → 会出现「点数不足」类的错误，或余额明显下降。
 * 一直打、把余额和上游的 occupyResource 标志一起盯着：
 *   · 余额一直 200 且从不报错 → 这个账号上确实是「用不完」
 *   · 余额下降 → 正常计费，「无限」不成立
 *   · 报点数不足 → 额度有限，只是还没到临界
 *
 * 用法：node scripts/soak.mjs <model> <轮数> [每轮间隔秒]
 */

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

import { CELIA_PREMIUM_AGENT_ID, CHAT_PATH, ENDPOINTS, PLATFORM_AGENT_ID, SSE_BASE } from '../src/context.mjs'
import { hagHeaders, postJson } from '../src/gateway.mjs'
import { normalizeAuth } from '../src/credential.mjs'
import { proxyFromEnv, withProxy } from '../src/proxy.mjs'

const MAGPIE_DIR = process.env.MAGPIE_DIR || path.join(os.homedir(), '.config', 'magpie')
const model = process.argv[2] || 'Kimi_K3.1_Pro_VE'
const rounds = Number(process.argv[3] || 20)
const pause = Number(process.argv[4] || 1)

const A = JSON.parse(fs.readFileSync(path.join(MAGPIE_DIR, 'plugin-auth.json'), 'utf8'))
const slot = Object.keys(A).find((k) => k === 'xiaoyiwork' || k.startsWith('xiaoyiwork#'))
const v = A[slot]
const md = v.metadata || {}
const st = normalizeAuth({
  access: v.access || v.key,
  uid: md.uid,
  deviceId: md.deviceId,
  refresh: md.refreshToken,
  metadata: md,
})
if (!st) throw new Error('凭据不完整')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

/** 余额 + 上游的占用标志 */
async function readState() {
  const body = (agentId) => ({
    accountType: 'HW_UID',
    agentId,
    endpoint: {
      device: { brand: 'HUAWEI', deviceId: st.deviceId },
      eduMode: 'NONEDU',
      foregroundPkgName: '',
      isXiaoyiAPP: false,
      language: 'zh_CN',
      languageMode: 'MANDARIN',
      locale: 'default',
    },
  })
  const prem = await postJson(ENDPOINTS.billing, {
    headers: hagHeaders({ ...st, sse: false }),
    body: body(CELIA_PREMIUM_AGENT_ID),
  })
  const plat = await postJson(ENDPOINTS.billing, {
    headers: hagHeaders({ ...st, sse: false }),
    body: body(PLATFORM_AGENT_ID),
  })
  const p = prem.json?.celiaPremiumPrivilege?.aiPoints ?? {}
  return {
    total: Number(p.totalPoints ?? 0),
    free: Number(p.freePoints ?? 0),
    occupy: plat.json?.occupyResource,
    available: plat.json?.hasAvailableResource,
    privileges: (plat.json?.privilegeList ?? []).length,
  }
}

/** 打一次对话，返回 usage */
async function chat(modelId) {
  const res = await fetch(
    `${SSE_BASE}${CHAT_PATH}`,
    withProxy(
      {
        method: 'POST',
        headers: hagHeaders({ ...st, sse: true }),
        body: JSON.stringify({
          model: modelId,
          messages: [{ role: 'user', content: '回复一个词：好' }],
          stream: true,
          max_tokens: 64,
        }),
      },
      proxyFromEnv(),
    ),
  )
  if (!res.ok) {
    const t = await res.text().catch(() => '')
    return { ok: false, status: res.status, error: t.slice(0, 400) }
  }
  const text = await res.text()
  let usage = null
  let content = ''
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
    if (f.usage && Object.keys(f.usage).length) usage = f.usage
    const c = f.choices?.[0]?.delta
    if (typeof c?.content === 'string') content += c.content
  }
  return { ok: true, usage, content, bytes: text.length }
}

const first = await readState()
console.log(`账号 ${slot}  uid=${st.uid}`)
console.log(`模型 ${model}  轮数 ${rounds}`)
console.log(`起始: ${first.total} 点（免费 ${first.free}）  occupyResource=${first.occupy}  hasAvailableResource=${first.available}  权益包 ${first.privileges}\n`)

let totalTokens = 0
let errors = 0
let last = first.total
for (let i = 1; i <= rounds; i++) {
  const t0 = Date.now()
  const r = await chat(model)
  const ms = Date.now() - t0
  if (!r.ok) {
    errors += 1
    console.log(`#${String(i).padStart(3)} ${String(ms).padStart(6)}ms  ✗ HTTP ${r.status}  ${r.error.replace(/\n/g, ' ').slice(0, 260)}`)
    if (errors >= 3) {
      console.log('\n连续 3 次失败，停止。')
      break
    }
  } else {
    const u = r.usage || {}
    totalTokens += u.total_tokens || 0
    if (i % 5 === 0 || i === 1) {
      const s = await readState()
      const drop = last - s.total
      console.log(
        `#${String(i).padStart(3)} ${String(ms).padStart(6)}ms  tokens=${u.total_tokens ?? '?'}  余额=${s.total}  ` +
          `掉点=${drop}  occupy=${s.occupy}  available=${s.available}`,
      )
      last = s.total
    }
  }
  if (pause > 0) await sleep(pause * 1000)
}

const end = await readState()
console.log(`\n=== 结论 ===`)
console.log(`共 ${rounds} 轮，失败 ${errors} 次，累计 tokens ≈ ${totalTokens}`)
console.log(`起始余额 ${first.total} → 结束余额 ${end.total}   掉点 ${first.total - end.total}`)
console.log(`occupyResource: ${first.occupy} → ${end.occupy}`)
if (first.total - end.total === 0 && errors === 0) {
  console.log('⇒ 余额一分未掉、全程无额度错误：这个账号上「用不完」。')
  console.log('   （但要分清是「无限」还是「这个免费体验账号本来就不计费」—— 见报告）')
} else if (errors > 0) {
  console.log('⇒ 有额度/上游错误发生：额度是有限的。')
} else {
  console.log(`⇒ 掉了 ${first.total - end.total} 点：正常计费，「无限」不成立。`)
}

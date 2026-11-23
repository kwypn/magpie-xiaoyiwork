/**
 * 插件自测（不装 magpie 也能跑）：
 *
 *   node test/run.mjs            # 离线断言（不需要凭据、不需要网络）
 *   node test/run.mjs --live     # 带真实凭据跑上游（需要先登录）
 *
 * 离线用例覆盖：
 *   · config 钩子声明了 provider / npm / 模型表 / patience
 *   · SSE 帧改写：只取 data 行、补 object/created/model、补 [DONE]
 *   · Kimi K3.1 Pro 已知坑：content 空但 reasoning_content 有内容 → 补 content
 *   · 聚合器：content / reasoning_content / tool_calls / usage
 *   · rate 归一："消耗13x" → "x13"
 *   · 账号去重闸门
 */

import assert from 'node:assert/strict'
import os from 'node:os'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { XiaoyiWorkAuthPlugin, _internal } from '../index.mjs'
import { aggregate, frameToText, normalizeRate, patchChunk, transformSse } from '../src/gateway.mjs'
import { duplicateError, findAccountSlots } from '../src/accounts.mjs'
import { proxyFromEnv, toBunProxy, withProxy } from '../src/proxy.mjs'

let failed = 0
const results = []

async function t(name, fn) {
  try {
    await fn()
    results.push(`✓ ${name}`)
  } catch (err) {
    failed += 1
    results.push(`✗ ${name} — ${err?.message || err}`)
  }
}

/* ------------------------------------------------------------------ 1. config */

await t('config 声明了 provider', async () => {
  const plugin = await XiaoyiWorkAuthPlugin({ directory: os.tmpdir(), magpie: {} })
  const cfg = {}
  await plugin.config(cfg)
  const p = cfg.provider?.xiaoyiwork
  assert.ok(p, 'provider.xiaoyiwork 未声明')
  assert.equal(p.npm, '@ai-sdk/openai-compatible')
  assert.equal(p.api, 'https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api')
  assert.ok(Object.keys(p.models).length >= 8, `模型表只有 ${Object.keys(p.models).length} 个`)
  assert.ok(p.models['Kimi_K3.1_Pro_VE'], '缺 Kimi K3.1 Pro')
})

await t('config 里 Kimi K3.1 Pro 标注灰度', async () => {
  const plugin = await XiaoyiWorkAuthPlugin({ directory: os.tmpdir(), magpie: {} })
  const cfg = {}
  await plugin.config(cfg)
  const kimi = cfg.provider.xiaoyiwork.models['Kimi_K3.1_Pro_VE']
  assert.match(kimi.name, /灰度/)
  // ★ rate 必须是数字：magpie 的 rateOf() 只认数字，字符串 "x13" 会被读成 0
  assert.equal(kimi.rate, 13)
})

await t('★ 所有模型的 rate 都是数字（magpie 只认数字）', async () => {
  const plugin = await XiaoyiWorkAuthPlugin({ directory: os.tmpdir(), magpie: {} })
  const cfg = {}
  await plugin.config(cfg)
  for (const [id, m] of Object.entries(cfg.provider.xiaoyiwork.models)) {
    if (m.rate !== undefined) assert.equal(typeof m.rate, 'number', `${id} 的 rate 不是数字：${m.rate}`)
  }
})

await t('★ show_gray 默认开：Kimi K3.1 Pro 在列表里', async () => {
  // magpie 的运行时读取对没声明 default:true 的选项一律回 false，
  // 所以选项必须声明 default:true，否则灰度模型会被整条剔除。
  const plugin = await XiaoyiWorkAuthPlugin({ directory: os.tmpdir(), magpie: {} })
  const opt = plugin.auth.options.find((o) => o.key === 'show_gray')
  assert.ok(opt, '没有声明 show_gray 选项')
  assert.equal(opt.default, true, 'show_gray 没声明 default:true')
  const cfg = {}
  await plugin.config(cfg)
  assert.ok(cfg.provider.xiaoyiwork.models['Kimi_K3.1_Pro_VE'], '默认列表里没有 Kimi K3.1 Pro')
})

await t('show_gray=false 时灰度模型被剔除', async () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xy-opt-'))
  writeFileSync(
    path.join(dir, 'plugins.json'),
    JSON.stringify({ plugins: [{ spec: '/root/mg-plugins/xiaoyiwork', options: { xiaoyiwork: { show_gray: false } } }] }),
  )
  const plugin = await XiaoyiWorkAuthPlugin({ directory: dir, magpie: {} })
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider.xiaoyiwork.models['Kimi_K3.1_Pro_VE'], undefined, '灰度模型没被剔除')
  assert.ok(cfg.provider.xiaoyiwork.models.Kimi_K3, '非灰度模型不该受影响')
})

await t('patience = 240（Kimi 首字延迟可超 110s）', async () => {
  const plugin = await XiaoyiWorkAuthPlugin({ directory: os.tmpdir(), magpie: {} })
  const cfg = {}
  await plugin.config(cfg)
  assert.equal(cfg.provider.xiaoyiwork.patience, 240)
})

/* -------------------------------------------------------------- 2. 帧改写 */

await t('frameToText 只取 data 行并补字段', () => {
  const block = ['id: 42', 'event: message', 'data: {"choices":[{"delta":{"content":"hi"}}]}'].join('\n')
  const out = frameToText(block, 'Kimi_K3.1_Pro_VE')
  assert.ok(out.startsWith('data: '), out)
  const obj = JSON.parse(out.slice(6).trim())
  assert.equal(obj.object, 'chat.completion.chunk')
  assert.equal(obj.model, 'Kimi_K3.1_Pro_VE')
  assert.ok(obj.created > 0)
  assert.ok(obj.id)
  assert.equal(obj.choices[0].index, 0)
})

await t('rate 归一："消耗13x" → x13', () => {
  assert.equal(normalizeRate('消耗8x'), 'x8')
  assert.equal(normalizeRate('消耗13x'), 'x13')
  assert.equal(normalizeRate('x0.8'), 'x0.8')
  assert.equal(normalizeRate('0x'), undefined)
})

await t('★ Kimi K3.1 Pro：content 空但 reasoning 有内容 → 补 content', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"答案是42"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":""},"finish_reason":"stop"}]}',
    '',
  ].join('\n')
  const out = await aggregate(new Blob([sse]).stream(), 'Kimi_K3.1_Pro_VE')
  assert.ok(out.choices[0].message.content.length > 0, 'content 仍为空')
})

await t('transformSse 补 [DONE]', async () => {
  const sse = 'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n'
  const stream = new Blob([sse]).stream()
  const reader = transformSse(stream, 'LLM_DeepSeekV4_Think').getReader()
  const dec = new TextDecoder()
  let text = ''
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    text += dec.decode(value, { stream: true })
  }
  assert.match(text, /data: \[DONE\]/)
  assert.match(text, /"object":"chat\.completion\.chunk"/)
})

/* -------------------------------------------------------------- 3. 聚合器 */

await t('聚合器合并 content / reasoning / tool_calls', async () => {
  const sse = [
    'data: {"choices":[{"delta":{"reasoning_content":"想一想"}}]}',
    '',
    'data: {"choices":[{"delta":{"content":"答案"}}]}',
    '',
    'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","function":{"name":"f","arguments":"{\\"a\\":1}"}}]}}]}',
    '',
    'data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}],"usage":{"prompt_tokens":10,"completion_tokens":5,"total_tokens":15}}',
    '',
  ].join('\n')
  const out = await aggregate(new Blob([sse]).stream(), 'X')
  assert.equal(out.choices[0].message.content, '答案')
  assert.equal(out.choices[0].message.reasoning_content, '想一想')
  assert.equal(out.choices[0].message.tool_calls[0].function.name, 'f')
  assert.equal(out.choices[0].finish_reason, 'tool_calls')
  assert.equal(out.usage.total_tokens, 15)
})

/* --------------------------------------------------------- 4. 账号去重闸门 */

await t('同一 uid 第二次登录被拦', () => {
  const dir = mkdtempSync(path.join(tmpdir(), 'xy-'))
  writeFileSync(
    path.join(dir, 'plugin-auth.json'),
    JSON.stringify({ xiaoyiwork: { uid: '70086000334832078' } }),
  )
  const slots = findAccountSlots(dir, '70086000334832078')
  assert.equal(slots.length, 1)
  assert.match(duplicateError(slots, '70086000334832078'), /已经添加过了/)
  // 不同 uid 不拦
  assert.equal(findAccountSlots(dir, 'other').length, 0)
})

/* ------------------------------------------------------- 5. 归一化与导出 */

await t('normalizeAuth 需要 credential + uid', () => {
  assert.equal(_internal.normalizeAuth(null), null)
  assert.equal(_internal.normalizeAuth({}), null)
  const s = _internal.normalizeAuth({ key: 'CRED', uid: 'U1' })
  assert.equal(s.credential, 'CRED')
  assert.equal(s.uid, 'U1')
  assert.ok(s.deviceId.endsWith('_U1'))
})

await t('入口只导出一个插件函数（magpie 会把每个函数导出都当插件调用）', async () => {
  const mod = await import('../index.mjs')
  const fns = Object.entries(mod).filter(([, v]) => typeof v === 'function')
  assert.equal(fns.length, 1, `导出了 ${fns.length} 个函数导出：${fns.map(([k]) => k).join(',')}`)
  assert.equal(fns[0][0], 'XiaoyiWorkAuthPlugin')
})

/* ------------------------------------------------------------- 出口代理 */

await t('代理从环境里读（宿主给的是 MAGPIE_*_PROXY）', () => {
  assert.equal(proxyFromEnv({ MAGPIE_HTTPS_PROXY: 'http://127.0.0.1:1081' }), 'http://127.0.0.1:1081')
  assert.equal(proxyFromEnv({ HTTPS_PROXY: 'http://p:1' }), 'http://p:1')
  assert.equal(proxyFromEnv({ ALL_PROXY: 'http://p:2' }), 'http://p:2')
  assert.equal(proxyFromEnv({}), '')
})

await t('★ socks5:// 换成 http://（Bun 的 fetch 不吃 socks5，会报 UnsupportedProxyProtocol）', () => {
  assert.equal(toBunProxy('socks5://127.0.0.1:1081'), 'http://127.0.0.1:1081')
  assert.equal(toBunProxy('socks5h://127.0.0.1:1081'), 'http://127.0.0.1:1081')
  assert.equal(toBunProxy('http://127.0.0.1:1081'), 'http://127.0.0.1:1081')
  assert.equal(toBunProxy(''), '')
})

await t('withProxy 带上代理，且不覆盖调用方自己给的', () => {
  const a = withProxy({ method: 'POST' }, 'socks5://127.0.0.1:1081')
  assert.equal(a.proxy, 'http://127.0.0.1:1081')
  assert.equal(a.method, 'POST')
  const b = withProxy({ proxy: 'http://own:1' }, 'http://other:2')
  assert.equal(b.proxy, 'http://own:1')
  const c = withProxy({ method: 'GET' }, '')
  assert.equal(c.proxy, undefined)
})

/* ------------------------------------------------------------------ 输出 */

console.log(results.join('\n'))
console.log(failed ? `\n${failed} 个用例失败` : `\n全部通过（${results.length} 个）`)
process.exit(failed ? 1 : 0)

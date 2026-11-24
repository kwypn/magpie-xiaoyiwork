/**
 * 小艺Work 上游网关的 HTTP 封装：请求头、POST、SSE 流改写。
 *
 * 关键约束（踩过的坑，改代码别踩回去）：
 *   1. 只吃 SSE：accept: application/json 会 406。非流式请求必须本地聚合。
 *   2. 没有 [DONE]：上游发完 finish_reason 就断流，插件必须补 data: [DONE]。
 *   3. 上游 SSE 里混着 `id: N` 之类的裸行，必须只取 data: 行再重新封装成标准帧。
 *   4. 模型目录接口必须带 x-prd-pkg-name，缺了回 400，倍率/目录全丢。
 */

import crypto from 'node:crypto'

import { withProxy, proxyFromEnv } from './proxy.mjs'

export const traceId = () => 'mp-' + crypto.randomBytes(8).toString('hex')
export const b64url = (buf) => Buffer.from(buf).toString('base64url')

export function readJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** "消耗8x" → "x8"（magpie 的 rate 字段）；也吃 "x8" / "8x" / "8" */
export function normalizeRate(raw) {
  if (typeof raw !== 'string') return undefined
  const m = raw.match(/([0-9]+(?:\.[0-9]+)?)\s*[x×]/i) || raw.match(/^[x×]\s*([0-9]+(?:\.[0-9]+)?)$/i)
  if (!m) return undefined
  const n = Number(m[1])
  if (!Number.isFinite(n) || n === 0) return undefined
  return `x${n}`
}

/** 上游请求头三件套 + 业务头 */
export function hagHeaders({ credential, uid, deviceId, trace = traceId(), sse = true }) {
  return {
    'content-type': 'application/json',
    accept: sse ? 'text/event-stream' : 'application/json',
    businessCredential: credential,
    'x-uid': uid,
    'x-device-id': deviceId,
    'x-request-from': 'xiaoyiWork',
    'x-businessId': 'WINPC_XIAOYI_WORK',
    'x-hag-trace-id': trace,
  }
}

export async function postJson(url, { headers, body, signal, timeoutMs = 30000 }) {
  const sig = signal ?? AbortSignal.timeout(timeoutMs)
  // ★ 走代理：华为网关在直连不通的机器上会断连
  //   （"The socket connection was closed unexpectedly"）。
  const init = withProxy({ method: 'POST', headers, body: JSON.stringify(body), signal: sig }, proxyFromEnv())
  const res = await fetch(url, init)
  const text = await res.text()
  return { status: res.status, ok: res.ok, text, json: readJsonSafe(text) }
}

/** 补齐标准 chat chunk 字段（上游给的不全） */
export function patchChunk(obj, modelHint) {
  const out = { ...obj }
  out.object ??= 'chat.completion.chunk'
  out.created ??= Math.floor(Date.now() / 1000)
  if (!out.model) out.model = modelHint || ''
  out.id ??= 'chatcmpl-' + crypto.randomBytes(9).toString('hex')
  if (Array.isArray(out.choices)) {
    out.choices = out.choices.map((c, i) => ({ ...c, index: typeof c.index === 'number' ? c.index : i }))
  }
  return out
}

/** 一个 SSE 块 → 一个标准 `data: {...}` 帧；非 data 行（id:/event:）丢弃 */
export function frameToText(block, modelHint) {
  const data = block
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).replace(/^ /, ''))
    .join('\n')
    .trim()
  if (!data) return null
  if (data === '[DONE]') return null
  const parsed = readJsonSafe(data)
  if (!parsed) return null
  return `data: ${JSON.stringify(patchChunk(parsed, modelHint))}\n\n`
}

/**
 * ★ Kimi K3.1 Pro 的已知坑：有帧里 reasoning_content 有内容而 content 是空的
 *   （长上下文/受限场景下模型把答案写进思维链）。
 *   直接透传会让客户端拿到空回答。
 *
 * ⚠⚠ 必须是**整段流**级别判断，不能逐帧判断！
 *
 *   逐帧判断的致命错误（2026-11-24 实测踩到）：
 *   Kimi 的每一帧都只有 `reasoning_content`、没有 `content`（思维链一段段吐，
 *   正文在最后几帧才来）。逐帧看"这帧 content 为空"永远成立 →
 *   每帧都把思维链复制进 content → 客户端看到的是
 *   「I'll respond to the user asking ...」这样的**思维链正文**，
 *   而不是模型的回答 —— 这就是「思考段漏到会话里」的现象。
 *
 *   正确做法：先原样透传整段流；同时记下"有没有见过真正的 content"。
 *   流结束时如果**从头到尾没有过任何 content**，才是真的"模型把答案写进了
 *   思维链"，这时才把 reasoning 补成 content。
 */
export function hasContentText(frame) {
  const choices = frame?.choices
  if (!Array.isArray(choices) || !choices.length) return false
  const c = choices[0]
  const delta = c?.delta ?? c?.message
  const content = delta?.content
  return typeof content === 'string' && content.length > 0
}

/** 一帧里的 reasoning 文本（没有则空串） */
export function frameReasoning(frame) {
  const choices = frame?.choices
  if (!Array.isArray(choices) || !choices.length) return ''
  const delta = choices[0]?.delta ?? choices[0]?.message
  const r = delta?.reasoning_content ?? delta?.reasoning
  return typeof r === 'string' ? r : ''
}

/**
 * 整段流结束时才用：把「只有思维链、没有正文」的流补一份正文。
 * 有过任何正文 → 原样返回（思维链绝不进 content）。
 */
export function withContentFallback(frame, { sawContent, reasoning } = {}) {
  if (!frame || typeof frame !== 'object') return frame
  if (sawContent) return frame
  const text = typeof reasoning === 'string' ? reasoning : ''
  if (!text) return frame
  const choices = frame.choices
  if (!Array.isArray(choices) || !choices.length) return frame
  const c = choices[0]
  const delta = c?.delta ?? c?.message
  if (!delta) return frame
  const out = { ...frame, choices: [{ ...c, delta: { ...delta, content: text } }] }
  if (Array.isArray(frame.choices)) {
    out.choices = frame.choices.map((x, i) => (i === 0 ? out.choices[0] : x))
  }
  return out
}

/**
 * SSE → 标准 SSE 流（补 [DONE]、补字段）。
 *
 * ★ 思维链绝不进 content：整段流里只要出现过一次真正的 content，
 *   就原样透传；只有在**整段都没有正文**时，才在最后一帧把思维链补成正文。
 */
export function transformSse(upstream, modelHint) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      const push = (text) => text && controller.enqueue(encoder.encode(text))
      // 整段流的账：有没有见过正文、思维链累计了多少
      let sawContent = false
      let reasoning = ''
      // 最后一帧先扣着：万一段落结束时才知道要补正文，这一帧正好是落点
      let pending = null
      const emit = (frame) => {
        if (!frame) return
        if (hasContentText(frame)) sawContent = true
        const r = frameReasoning(frame)
        if (r) reasoning += r
        push(`data: ${JSON.stringify(frame)}\n\n`)
      }
      try {
        for (;;) {
          const { value, done } = await reader.read()
          if (done) break
          buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
          let idx
          while ((idx = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, idx)
            buf = buf.slice(idx + 2)
            const raw = frameToText(block, modelHint)
            if (!raw) continue
            const frame = readJsonSafe(raw.slice(6).trim())
            if (!frame) continue
            // 留最后一帧到流结束再发（要扣着它，才知道整段有没有正文）
            if (pending) emit(pending)
            pending = frame
          }
        }
        const tail = frameToText(buf, modelHint)
        if (tail) {
          const frame = readJsonSafe(tail.slice(6).trim())
          if (frame) {
            if (pending) emit(pending)
            pending = frame
          }
        }
        // 整段结束：没有正文才补（思维链当正文），有正文就原样发
        if (pending) {
          if (!sawContent) {
            const patched = withContentFallback(pending, { sawContent, reasoning })
            if (hasContentText(patched)) sawContent = true
            emit(patched)
          } else {
            emit(pending)
          }
        }
      } catch (err) {
        push(`data: ${JSON.stringify({ error: { message: `上游流式中断: ${err?.message || err}` } })}\n\n`)
      } finally {
        push('data: [DONE]\n\n')
        try {
          reader.releaseLock()
        } catch {
          /* ignore */
        }
        controller.close()
      }
    },
  })
}

/** SSE → 聚合后的单个 chat.completion（stream:false 用）。入参是 ReadableStream。 */
export async function aggregate(upstream, modelHint) {
  const decoder = new TextDecoder()
  let buf = ''
  const acc = { content: '', reasoning: '', toolCalls: new Map(), finish: null, usage: null }
  const feed = (block) => {
    const data = block
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
      .trim()
    if (!data || data === '[DONE]') return
    const frame = readJsonSafe(data)
    if (!frame) return
    if (frame.usage && typeof frame.usage === 'object') acc.usage = frame.usage
    const choice = Array.isArray(frame.choices) ? frame.choices[0] : null
    if (!choice) return
    const delta = choice.delta || {}
    if (typeof delta.content === 'string') acc.content += delta.content
    if (typeof delta.reasoning_content === 'string') acc.reasoning += delta.reasoning_content
    if (Array.isArray(delta.tool_calls)) {
      for (const [i, tc] of delta.tool_calls.entries()) {
        const key = typeof tc.index === 'number' ? tc.index : i
        const entry = acc.toolCalls.get(key) ?? { id: '', type: 'function', function: { name: '', arguments: '' } }
        if (tc.id) entry.id = tc.id
        const name = tc.function?.name ?? tc.name
        if (name) entry.function.name = entry.function.name || name
        const args = tc.function?.arguments ?? tc.arguments
        if (typeof args === 'string') entry.function.arguments += args
        acc.toolCalls.set(key, entry)
      }
    }
    if (choice.finish_reason) acc.finish = choice.finish_reason
  }

  const reader = upstream.getReader()
  for (;;) {
    const { value, done } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true }).replace(/\r\n?/g, '\n')
    let idx
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      feed(buf.slice(0, idx))
      buf = buf.slice(idx + 2)
    }
  }
  feed(buf)

  const toolCalls = [...acc.toolCalls.values()]
  const message = {
    role: 'assistant',
    // ★ 思维链绝不进 content：只有整段都没有正文（模型把答案写进了思维链），
    //   才把思维链当正文。有一段正文就只给正文。
    content: acc.content || (acc.content === '' && acc.reasoning ? acc.reasoning : acc.content),
  }
  if (acc.reasoning) message.reasoning_content = acc.reasoning
  if (toolCalls.length) message.tool_calls = toolCalls

  const prompt = acc.usage?.prompt_tokens ?? 0
  const completion = acc.usage?.completion_tokens ?? 0

  return {
    id: 'chatcmpl-' + crypto.randomBytes(9).toString('hex'),
    object: 'chat.completion',
    created: Math.floor(Date.now() / 1000),
    model: modelHint || '',
    choices: [
      {
        index: 0,
        message,
        finish_reason: acc.finish || (toolCalls.length ? 'tool_calls' : 'stop'),
      },
    ],
    usage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: acc.usage?.total_tokens ?? prompt + completion,
    },
  }
}

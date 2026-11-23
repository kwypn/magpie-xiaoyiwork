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

export const traceId = () => 'mp-' + crypto.randomBytes(8).toString('hex')
export const b64url = (buf) => Buffer.from(buf).toString('base64url')

export function readJsonSafe(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/** "消耗8x" → "x8"（magpie 的 rate 字段） */
export function normalizeRate(raw) {
  if (typeof raw !== 'string') return undefined
  const m = raw.match(/(\d+(?:\.\d+)?)\s*[x×]/i)
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
  const res = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body), signal: sig })
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
 *   直接透传会让客户端拿到空回答。→ 空 content 且有 reasoning 时，补一份 content。
 */
export function withContentFallback(frame) {
  if (!frame || typeof frame !== 'object') return frame
  const choices = frame.choices
  if (!Array.isArray(choices) || !choices.length) return frame
  const c = choices[0]
  const delta = c?.delta ?? c?.message
  if (!delta) return frame
  const hasContent = typeof delta.content === 'string' && delta.content.length > 0
  const hasReasoning =
    (typeof delta.reasoning_content === 'string' && delta.reasoning_content.length > 0) ||
    (typeof delta.reasoning === 'string' && delta.reasoning.length > 0)
  if (hasContent || !hasReasoning) return frame
  const reasoning = delta.reasoning_content ?? delta.reasoning
  const out = { ...frame, choices: [{ ...c, delta: { ...delta, content: reasoning } }] }
  if (Array.isArray(frame.choices)) {
    out.choices = frame.choices.map((x, i) => (i === 0 ? out.choices[0] : x))
  }
  return out
}

/** SSE → 标准 SSE 流（补 [DONE]、补字段、空 content 兜底） */
export function transformSse(upstream, modelHint) {
  const decoder = new TextDecoder()
  const encoder = new TextEncoder()
  let buf = ''
  return new ReadableStream({
    async start(controller) {
      const reader = upstream.getReader()
      const push = (text) => text && controller.enqueue(encoder.encode(text))
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
            const patched = withContentFallback(readJsonSafe(raw.slice(6).trim()))
            push(`data: ${JSON.stringify(patched)}\n\n`)
          }
        }
        const tail = frameToText(buf, modelHint)
        if (tail) push(tail)
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

/** SSE → 聚合后的单个 chat.completion（stream:false 用） */
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

  for (;;) {
    const { value, done } = await upstream.read()
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

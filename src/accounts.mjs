/**
 * 账号槽位去重闸门。
 *
 * magpie 只对 oauth 账号按 accountId/uid 覆盖，api 账号基本只比 key ——
 * 两种登录方式给出的 credential 每次都不一样，所以「先本机导入、再浏览器登录」
 * 会变成两个同 uid 的账号。这里自己把关。
 *
 * 做法：直接读 magpie 自己的 plugin-auth.json，看这个 uid 是否已经占了槽位
 * （xiaoyiwork 或 xiaoyiwork#xxxxxx）。好处是用户在 magpie 里把账号删掉后，
 * 判断立刻失效，不会留下永久黑名单。
 */

import fs from 'node:fs'
import path from 'node:path'

import { PROVIDER } from './context.mjs'
import { readJsonSafe } from './gateway.mjs'

export function readPluginAuth(directory) {
  if (!directory) return null
  try {
    return readJsonSafe(fs.readFileSync(path.join(directory, 'plugin-auth.json'), 'utf8'))
  } catch {
    return null
  }
}

/** 返回该 uid 已经占用的账号槽位（xiaoyiwork / xiaoyiwork#xxxxxx） */
export function findAccountSlots(directory, uid) {
  if (!uid) return []
  const all = readPluginAuth(directory)
  if (!all) return []
  const hits = []
  for (const [slot, value] of Object.entries(all)) {
    if (slot !== PROVIDER && !slot.startsWith(PROVIDER + '#')) continue
    const owner = value?.uid ?? value?.accountId ?? value?.metadata?.uid
    if (owner && String(owner) === String(uid)) hits.push(slot)
  }
  return hits
}

export function duplicateError(slots, uid) {
  const slot = slots[0]
  const how = slot.includes('#') ? `（槽位 ${slot}）` : ''
  return (
    `账号 ${uid} 已经添加过了${how}，同一个账号只允许一个。` +
    '要换登录方式（比如从“读取本机登录态”换成“浏览器登录”），' +
    '先在 magpie 的插件页把旧账号删掉再回来添加；' +
    '若确实需要并存，给插件开 allowDuplicate 选项。'
  )
}

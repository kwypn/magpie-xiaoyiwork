/**
 * magpie / OpenCode 供应商插件：小艺Work（华为小艺 Celia）
 *
 * 把小艺Work 的模型接进 magpie：DeepSeek-V4、DeepSeek-V4.1、GLM-5.3、GLM-5.3-Flash、
 * Kimi K3.1 Pro、Kimi K3、MiniMax M3.1、openPangu-2.1、Auto-Model。
 *
 * 钩子清单：
 *   ① config(cfg)                    声明 provider + 模型表 + patience
 *   ② auth.methods[].authorize()     登录（华为 OAuth / 本机登录态导入）
 *   ③ auth.refresh(auth)             凭据 7 天到期前续期（代刷 + 签票）
 *   ④ auth.loader(getAuth)           请求接管（转给 HAG 网关 + 补 [DONE]）
 *   ⑤ auth.usage(getAuth)            AI 点额度 → 卡片进度条
 *   ⑥ provider.models(provider,{auth}) 每账号目录（真实目录 + 静态兜底）
 *
 * 三条铁律：
 *   1. config.models 必须有内容 —— 未登录也要有，否则显示 "0 models"
 *   2. authorize() 立刻返回 —— 真正等用户的是 callback()，否则和 magpie 死锁
 *   3. refresh 返回的是合并 —— client.auth.set 是整体替换，两者不同
 */

import fs from 'node:fs'
import path from 'node:path'

import {
  DEFAULT_MODELS,
  GRAY_MODELS,
  KIMI_K31_PRO,
  NPM,
  PROVIDER,
  PROVIDER_NAME,
  SSE_BASE,
  CHAT_PATH,
  rateNumber,
} from './src/context.mjs'
import { aggregate, hagHeaders, patchChunk, readJsonSafe, transformSse } from './src/gateway.mjs'
import { proxyFromEnv, withProxy } from './src/proxy.mjs'
import {
  deviceIdFor,
  ensureFreshState,
  normalizeAuth,
  renewCredential,
} from './src/credential.mjs'
import { startBrowserLogin, startLocalImport } from './src/login.mjs'
import { buildUsage, queryCatalog } from './src/models.mjs'
import { duplicateError, findAccountSlots } from './src/accounts.mjs'

/** 供应商图标：从 package.json 的 magpie.icon 读回来（换图标只改一处） */
const PLUGIN_ICON = (() => {
  try {
    const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url), 'utf8'))
    const icon = pkg?.magpie?.icon
    return typeof icon === 'string' ? icon : ''
  } catch {
    return ''
  }
})()

export async function XiaoyiWorkAuthPlugin(input = {}) {
  const configDir = input?.directory || null
  const magpieCtx = input?.magpie ?? {}
  const optionBag = magpieCtx.options && typeof magpieCtx.options === 'object' ? magpieCtx.options : null

  /* ----------------------------------------------------------- 插件选项读取 */
  /*
   * magpie 有两种运行时形状：
   *   · `magpie.option(providerId, key)` —— 函数
   *   · `magpie.options = { key: value }` —— 对象
   * 而且 0.1.3313 上运行时读取会给出过期的 false/空对象（实测踩过），
   * 所以第一优先读 magpie 配置目录下的 plugins.json（编辑页和 CLI 写的就是它）。
   * ★ 值必须用到时再读，不能在工厂里存成常量（工厂那一刻选项还没灌进来）。
   */
  const readOptionFromConfig = (...keys) => {
    if (!configDir) return undefined
    try {
      const j = JSON.parse(fs.readFileSync(path.join(configDir, 'plugins.json'), 'utf8'))
      for (const entry of j.plugins ?? []) {
        const bag = entry?.options
        if (!bag || typeof bag !== 'object') continue
        for (const key of keys) {
          const perProvider = bag[PROVIDER]
          if (perProvider && typeof perProvider === 'object' && perProvider[key] !== undefined) return perProvider[key]
          if (bag[key] !== undefined && bag[key] !== null) return bag[key]
        }
      }
    } catch {
      /* plugins.json 还没写或读不到 */
    }
    return undefined
  }

  const readOptionRuntime = (...keys) => {
    for (const key of keys) {
      if (typeof magpieCtx.option === 'function') {
        try {
          const v = magpieCtx.option(PROVIDER, key)
          if (v !== undefined && v !== null) return v
        } catch {
          /* 旧版 magpie 没有函数式读取 */
        }
      }
      if (optionBag && optionBag[key] !== undefined && optionBag[key] !== null) return optionBag[key]
      if (magpieCtx.option && typeof magpieCtx.option === 'object' && magpieCtx.option[key] !== undefined) {
        return magpieCtx.option[key]
      }
    }
    return undefined
  }

  const readOption = (...keys) => {
    const fromConfig = readOptionFromConfig(...keys)
    return fromConfig !== undefined ? fromConfig : readOptionRuntime(...keys)
  }

  const truthy = (...keys) => {
    const v = readOption(...keys)
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
  }

  const allowDuplicate = () => truthy('allow_duplicate', 'allowDuplicate')
  /**
   * 灰度模型（小艺Work 官方标 gray:true、选择器里是禁用态）：
   *   默认**列出** Kimi K3.1 Pro —— 用户明确要这个模型，
   *   但要标「灰度」并把倍率（上游 13x，最贵）显示出来，别让人以为免费。
   *   开关 show_gray=false 时才隐藏。
   *
   * ⚠ 默认值不能靠 `!== false` 判断：magpie 的运行时读取
   *   （magpie.option(provider,key)）对**没声明 default:true** 的选项一律回 false
   *   （optionValue = optionValues(provider)[key] === true，optionValues 用 o.default 兜底），
   *   所以「没设置」和「显式关掉」在运行时是同一个 false，读不出区别。
   *   → 选项声明里写 default: true，运行时读到的就是 true；读不到（undefined）时按默认开。
   */
  const showGray = () => {
    const v = readOption('show_gray', 'showGray')
    if (v === undefined || v === null) return true
    return v === true || v === 'true' || v === 1 || v === '1' || v === 'on'
  }

  /** 同一账号只允许一个：返回 null 表示可以继续，否则返回要报给用户的错误 */
  const guardDuplicate = (uid) => {
    if (allowDuplicate() || !uid) return null
    const slots = findAccountSlots(configDir, uid)
    return slots.length ? duplicateError(slots, uid) : null
  }

  /**
   * 灰度模型标注：名字后缀只加一次。
   * （config 钩子已经标过的，models 钩子再标就成「Kimi K3.1 Pro（灰度）（灰度）」）
   */
  const decorate = (id, model) => {
    if (!GRAY_MODELS.has(id)) return model
    const name = String(model.name ?? id)
    if (name.includes('（灰度）')) return model
    return { ...model, name: `${name}（灰度）` }
  }

  /**
   * ★ rate 必须是**数字**，而且要由 models 钩子带上去。
   *
   * magpie 读 config 钩子给的模型表时，只搬 name/api/cost/limit/options/headers/
   * capabilities/variants 这些字段，**不搬 rate**；rate 只从 models 钩子的返回值里
   * 取（provider 列表里的 rate: rateOf(m.rate)，rateOf 只认 number）。
   * 所以：config 钩子里的 rate 只是备份，真正生效的是 models 钩子返回的那份，
   * 两边都得是数字。
   */
  const withRate = (model, fallback) => {
    const rate = rateNumber(model?.rate) ?? rateNumber(fallback?.rate)
    const out = { ...model }
    if (rate) out.rate = rate
    else delete out.rate
    return out
  }

  const visibleModels = (models) => {
    const out = {}
    for (const [id, model] of Object.entries(models ?? {})) {
      if (GRAY_MODELS.has(id)) {
        if (!showGray()) continue
        out[id] = decorate(id, withRate(model, DEFAULT_MODELS[id]))
        continue
      }
      out[id] = withRate(model, DEFAULT_MODELS[id])
    }
    return out
  }

  /**
   * 静态兜底表也要把 rate 归一成**数字**：
   * magpie 的 rateOf() 只认数字（typeof v === "number"），字符串 "x13" 会读成 0。
   */
  const staticModels = () => {
    const out = {}
    for (const [id, model] of Object.entries(DEFAULT_MODELS)) {
      out[id] = withRate(model)
    }
    return out
  }

  /* --------------------------------------------------------------- 请求接管 */

  const makeFetch = (state) => {
    const holder = { ...state }
    return async (input0, init = {}) => {
      const url = typeof input0 === 'string' ? input0 : input0?.url ?? String(input0)
      const target = url.includes('/chat/completions') ? url : `${SSE_BASE}${CHAT_PATH}`

      const headers = new Headers(init.headers)
      // 上游用 businessCredential，不要 AI SDK 的 Bearer
      headers.delete('authorization')
      headers.delete('x-api-key')
      headers.delete('content-length')
      for (const [k, v] of Object.entries(hagHeaders({ ...holder }))) headers.set(k, v)

      let bodyObj = null
      let bodyText = null
      if (typeof init.body === 'string') {
        bodyObj = readJsonSafe(init.body)
        bodyText = init.body
      } else if (init.body instanceof Uint8Array) {
        bodyText = new TextDecoder().decode(init.body)
        bodyObj = readJsonSafe(bodyText)
      }
      const wantStream = Boolean(bodyObj?.stream)
      if (bodyObj && typeof bodyObj === 'object') {
        bodyObj.stream = true // 上游只吃 SSE，非流式由本地聚合
        bodyText = JSON.stringify(bodyObj)
      }

      let res = await fetch(
        target,
        withProxy(
          {
            method: init.method || 'POST',
            headers,
            body: bodyText,
            signal: init.signal,
          },
          // ★ 走代理：宿主给 loader 的 fetch 的代理是「provider 在 providers.json 里的
          //   proxy」，插件自己这层再兜一次（环境里的全局代理），两边都拿不到时直连。
          proxyFromEnv(),
        ),
      )

      // 凭据过期：本机模式静默重读一次
      if ((res.status === 401 || res.status === 403) && holder.fromLocal) {
        try {
          const fresh = await import('./src/credential.mjs').then((m) => m.readLocalCredential())
          if (fresh.credential !== holder.credential) {
            Object.assign(holder, fresh, { fromLocal: true })
            for (const [k, v] of Object.entries(hagHeaders({ ...holder }))) headers.set(k, v)
            res = await fetch(
              target,
              withProxy(
                { method: init.method || 'POST', headers, body: bodyText, signal: init.signal },
                proxyFromEnv(),
              ),
            )
          }
        } catch {
          /* 保持原样 */
        }
      }

      if (!res.ok) {
        let text = ''
        try {
          text = await res.text()
        } catch {
          /* ignore */
        }
        const authFailed = res.status === 401 || res.status === 403
        const payload =
          text ||
          JSON.stringify({
            error: {
              message: `小艺Work 上游 ${res.status}`,
              type: authFailed ? 'authentication_error' : 'upstream_error',
            },
          })
        const out = new Response(payload, {
          status: res.status,
          headers: { 'content-type': res.headers.get('content-type') || 'application/json' },
        })
        if (authFailed) out.headers.set('X-Magpie-Sign-In', 'expired')
        return out
      }

      const modelHint = bodyObj?.model
      if (wantStream || !bodyObj) {
        return new Response(transformSse(res.body, modelHint), {
          status: 200,
          headers: { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-cache, no-transform' },
        })
      }
      const full = await aggregate(res.body, modelHint)
      return new Response(JSON.stringify(full), {
        status: 200,
        headers: { 'content-type': 'application/json; charset=utf-8' },
      })
    }
  }

  /* ------------------------------------------------------------------ 插件 */

  return {
    /* ---------------- 供应商与默认模型 ---------------- */
    config: async (cfg) => {
      cfg.provider ??= {}
      cfg.provider[PROVIDER] ??= {
        name: PROVIDER_NAME,
        npm: NPM,
        api: SSE_BASE,
        // Kimi K3.1 Pro 等慢思考模型对大提示词的首字延迟可超 110s，
        // magpie 默认 60s 会把「上游失联」判成 502。240s 是 magpie 的上限。
        patience: 240,
        models: visibleModels(staticModels()),
      }
    },

    /* ---------------- 登录 + 请求 ---------------- */
    auth: {
      provider: PROVIDER,
      ...(PLUGIN_ICON ? { icon: PLUGIN_ICON } : {}),

      /** 凭据 7 天，提前 12 小时续；续的动作是「代刷 + 立刻签票」 */
      refreshLead: 12 * 60 * 60 * 1000,

      /** 编辑页「插件选项」里的开关 */
      options: [
        {
          key: 'show_gray',
          label: 'Show grey (beta) models',
          // ★ default 必须写 true：magpie 的运行时读取对没声明 default:true 的选项
          //   一律回 false（optionValue === true），「没设置」与「显式关掉」读不出区别。
          //   不写这一行，Kimi K3.1 Pro 在运行时会被当成「关」而整条消失。
          default: true,
          description:
            "Also list the models XiaoyiWork marks grey (Kimi K3.1 Pro). XiaoyiWork's own model picker keeps them disabled as \"in grey testing, not selectable yet\", so they are unofficial here — they work, but they are billed at the highest rate the upstream quotes (13x AI points).",
          labels: { zh: '显示灰度测试模型', 'zh-TW': '顯示灰度測試模型' },
          descriptions: {
            zh: '把小艺Work 标为灰度的模型（Kimi K3.1 Pro）也列出来。官方选择器里它们是禁用态「灰度中，暂不可选」，插件里能用但属未开放，且按上游标的最高倍率扣 AI 点（13x）。',
            'zh-TW': '把小藝Work 標為灰度的模型（Kimi K3.1 Pro）也列出來。官方選擇器裡它們是停用態「灰度中，暫不可選」，插件裡能用但屬未開放，且按上游標的最高倍率扣 AI 點（13x）。',
          },
          filtersModels: true,
        },
        {
          key: 'allow_duplicate',
          label: 'Allow the same account twice',
          description:
            'By default one XiaoyiWork account can be added once, whichever sign-in you use; a second attempt is refused with the name of the existing slot. Turn this on only if you really want two slots for the same uid.',
          labels: { zh: '允许同一账号重复添加', 'zh-TW': '允許同一帳號重複新增' },
          descriptions: {
            zh: '默认同一个华为账号只能加一次（不论用本机导入还是浏览器登录），再登会提示已存在的槽位名。只有确实想让同一个 uid 占两个槽位时才打开。',
            'zh-TW': '預設同一個華為帳號只能加一次（不論用本機匯入還是瀏覽器登入），再登會提示已存在的槽位名。只有確實想讓同一個 uid 佔兩個槽位時才打開。',
          },
        },
      ],

      methods: [
        {
          type: 'oauth',
          label: '华为账号登录（浏览器）',
          async authorize() {
            return startBrowserLogin(guardDuplicate)
          },
        },
        {
          type: 'api',
          label: '读取本机小艺Work 登录态（免输入；下一格随意填）',
          placeholder: '直接回车或随便填 —— 插件自己读本机注册表',
          async authorize() {
            return startLocalImport(guardDuplicate)
          },
        },
      ],

      async refresh(auth) {
        const state = normalizeAuth(auth)
        if (!state) throw Object.assign(new Error('登录信息不完整，请重新登录'), { signIn: 'expired' })
        const renewed = await renewCredential(state)
        if (!renewed.ok) {
          throw Object.assign(new Error(`续期失败：${renewed.message}`), { signIn: 'expired' })
        }
        return {
          access: renewed.credential,
          refresh: auth.refresh ?? auth.metadata?.refreshToken,
          expires: renewed.validTimeSec * 1000,
          uid: state.uid,
          deviceId: state.deviceId,
          metadata: {
            ...(auth.metadata || {}),
            uid: state.uid,
            deviceId: state.deviceId,
            expires: renewed.validTimeSec * 1000,
          },
        }
      },

      async loader(getAuth) {
        const auth = await getAuth()
        const state = normalizeAuth(auth)
        if (!state) return {}
        return {
          baseURL: SSE_BASE,
          headers: { 'x-request-from': 'xiaoyiWork', 'x-businessId': 'WINPC_XIAOYI_WORK' },
          fetch: makeFetch(state),
        }
      },

      async usage(getAuth) {
        const auth = await getAuth()
        try {
          const base = normalizeAuth(auth)
          if (!base) return { error: '未登录', windows: [] }
          const state = await ensureFreshState(base).catch(() => base)
          return await buildUsage(state, configDir)
        } catch (err) {
          // 任何异常都别把 magpie 的空结果抛上去（那会被判成「没有额度端点」）
          console.log(`[xiaoyiwork] usage threw: ${err?.message || err}`)
          return { error: `读取额度失败：${err?.message || err}`, windows: [] }
        }
      },
    },

    /* ---------------- 每个账号的模型 ---------------- */
    provider: {
      id: PROVIDER,
      async models(provider, { auth } = {}) {
        const state = normalizeAuth(auth)
        if (!state) return visibleModels(provider.models)
        const catalog = await queryCatalog(state).catch(() => null)
        if (!catalog) return visibleModels(provider.models)
        const out = {}
        for (const item of catalog) {
          const gray = item.gray === true || GRAY_MODELS.has(item.id)
          if (gray && !showGray()) continue
          const base = provider.models[item.id] ?? DEFAULT_MODELS[item.id] ?? {
            name: item.name,
            tool_call: true,
            reasoning: true,
            limit: { context: 1000000, output: 32000 },
          }
          const { status, ...rest } = base
          out[item.id] = decorate(item.id, {
            ...rest,
            name: item.name || base.name,
            // ★ rate 必须是**数字**：magpie 的 rateOf() 只认 number，
            //   字符串 "x13" 会被读成 0（倍率显示不出来）。
            //   上游目录给的是 "消耗13x" 这种文本，先归一成 13；
            //   目录没给就沿用静态表里的倍率。
            rate: rateNumber(item.rate) ?? rateNumber(base.rate),
          })
        }
        // 兜底：目录没列出的默认模型仍然保留
        for (const [id, model] of Object.entries(visibleModels(provider.models))) if (!out[id]) out[id] = model
        return out
      },
    },
  }
}

/**
 * 只导出这一个函数作为插件 —— magpie 会把入口导出的每个「函数」都当插件调用，
 * 多导出一个 default 就会被装配两次。_internal 是对象，不会被当插件。
 */
export const _internal = {
  PROVIDER,
  KIMI_K31_PRO,
  DEFAULT_MODELS,
  GRAY_MODELS,
  normalizeAuth,
  deviceIdFor,
  queryCatalog,
  buildUsage,
  patchChunk,
  aggregate,
  transformSse,
}

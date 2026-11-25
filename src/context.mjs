/**
 * 小艺Work（华为小艺 Celia）magpie 插件 —— 常量与模型表
 *
 * 上游（逆向自官方小艺Work 桌面端，非官方实现，随时可能变）：
 *   · 对话网关  POST https://hag-drcn.op.dbankcloud.com/celia/v1/sse-api/chat/completions
 *     只吃 accept: text/event-stream；OpenAI chat 格式；工具调用是原生 tool_calls。
 *   · 鉴权三件套：businessCredential（7 天）+ x-uid + x-device-id
 *     x-device-id = sha256(MachineGuid).hex(小写) + "_" + uid —— 必须是已登记设备。
 *   · 续期闭环：businessCredential ──网关代刷──> accessToken(1h) ──立刻签票──> 新票
 *     accessToken 有「新鲜度」窗口（几分钟），刷新和签票必须背靠背。
 */

export const PROVIDER = 'xiaoyiwork'
export const PROVIDER_NAME = '小艺Work（华为小艺）'
export const NPM = '@ai-sdk/openai-compatible'

export const HAG = 'https://hag-drcn.op.dbankcloud.com'
export const SSE_BASE = `${HAG}/celia/v1/sse-api`
export const CHAT_PATH = '/chat/completions'

export const ENDPOINTS = {
  authorize: 'https://oauth-login.cloud.huawei.com/oauth2/v3/authorize',
  token: 'https://oauth-login.cloud.huawei.com/oauth2/v3/token',
  gallery: `${HAG}/user-ability-gallery/v1/agent/user/query`,
  billing: `${HAG}/ability-billing/v1/agent-purchases-client/privilege/query`,
  credential: `${HAG}/user-credential/v1/business-credential/create`,
  refresh: `${HAG}/user-credential/v1/xiaoyiwork/refresh-token`,
}

export const OAUTH = {
  clientId: '6917612679526496902',
  redirectUri: 'http://127.0.0.1:17355/auth/callback',
  callbackPort: 17355,
  callbackPath: '/auth/callback',
  scope: 'openid profile https://www.huawei.com/auth/drive https://www.huawei.com/auth/drive.xiaoyiwork',
  accessType: 'offline',
  codeTtlMs: 5 * 60 * 1000,
}

/** 平台 agentId（权益包）与会员 agentId（AI 点积分池） */
export const PLATFORM_AGENT_ID = 'agent208b6760552b4fa0b395e5165d0d771e'
export const CELIA_PREMIUM_AGENT_ID = '1'

/** 模型目录接口必须带这个头，缺了上游回 400（Parameter is not valid），倍率/目录全丢 */
export const PRD_PKG_NAME = 'com.huawei.hmos.vassistant'

/**
 * 上游标灰的模型：小艺Work 自己的模型选择器对 gray===true 给的是
 * `disabled: true` + title「灰度中，暂不可选」——官方口径就是不让选。
 * 插件默认仍然列出（用户明确要 Kimi K3.1 Pro），但标注「灰度」并把倍率显示出来。
 */
export const GRAY_MODELS = new Set(['Kimi_K3.1_Pro_VE'])

/**
 * Kimi K3.1 Pro 的已知上游行为（插件必须兜住的坑）：
 *   ① 每一帧都只有 reasoning_content、content 是空的，思维链一段段吐、正文最后才来。
 *      → 兜底必须**整段流**级别做（src/gateway.mjs 的 transformSse/aggregate），
 *        逐帧兜底会把思维链复制进 content，客户端看到的是思考段（2026-11-24 实测踩到）。
 *   ② 首字延迟可超 110s（慢思考 + 大提示词）—— magpie 默认 60s 会判 502。
 *      → 见 index.mjs 的 provider.patience = 240。
 */
export const KIMI_K31_PRO = 'Kimi_K3.1_Pro_VE'

/**
 * 静态兜底模型表；真实目录由 provider.models 按账号拉取（带倍率）。
 * rate 是上游 aiPointConsumptionRatio 的静态副本，目录拉不到时也能显示倍率。
 * modalities.input.image 是实测出来的：只有带 _VE 的模型真能读图。
 */
export const DEFAULT_MODELS = {
  'LLM_DeepSeekV4_Think': {
    name: 'DeepSeek-V4-Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
  'DeepSeek_V4.1_Flash_VE': {
    name: 'DeepSeek-V4.1-Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
  'LLM_GLM5.3': {
    name: 'GLM-5.3',
    reasoning: true,
    tool_call: true,
    rate: 'x8',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'GLM_5.3_FLASH_VE': {
    name: 'GLM-5.3-Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x0.8',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'MiniMax_M3.1_Flash': {
    name: 'MiniMax M3.1 Flash',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'LLM_DeepSeekV4_Pro_Think': {
    name: 'DeepSeek-V4-Pro',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
  'Kimi_K3.1_Pro_VE': {
    name: 'Kimi K3.1 Pro',
    reasoning: true,
    tool_call: true,
    rate: 'x13',
    modalities: { input: ['text', 'image'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'Kimi_K3': {
    name: 'Kimi K3',
    reasoning: true,
    tool_call: true,
    rate: 'x1.6',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32768 },
  },
  'OpenPanguV2-Pro': {
    name: 'openPangu-2.1-Pro',
    reasoning: true,
    tool_call: true,
    rate: 'x1',
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
  'Auto-Model': {
    name: 'Auto-Model',
    tool_call: true,
    modalities: { input: ['text'], output: ['text'] },
    limit: { context: 1000000, output: 32000 },
  },
}

/** magpie 的 rate 是独立字段（数字），拼进 name 会污染模型选择器的筛选 */
export function rateNumber(rate) {
  if (typeof rate === 'number') return Number.isFinite(rate) && rate > 0 ? rate : undefined
  const text = String(rate ?? '').replace(/[~≈～〜∼]/g, '').replace(/\s+/g, '').toLowerCase()
  const m = /^x?([0-9]*\.?[0-9]+)x?$/.exec(text)
  if (!m) return undefined
  const n = Number(m[1])
  return Number.isFinite(n) && n > 0 ? n : undefined
}

# magpie-xiaoyiwork

在 **magpie**（以及 OpenCode）里使用你**自己的**小艺Work（华为小艺 Celia）账号的模型：
DeepSeek-V4、DeepSeek-V4.1、GLM-5.3、GLM-5.3-Flash、**Kimi K3.1 Pro**、Kimi K3、MiniMax M3.1、openPangu-2.1、Auto-Model。

- 两种登录方式：**免输入读取本机小艺Work 登录态**，或**浏览器华为账号登录**（不需要装 App）
- 凭据 7 天自动续期（网关代刷 + 重新签票），不需要小艺Work 常驻
- 同一账号只允许一个，两种方式混用也不会重复添加
- 支持流式、工具调用（function calling）、思维链（`reasoning_content`）、图片输入、AI 点额度展示

```
$ magpie plugin add github:kwypn/magpie-xiaoyiwork
$ magpie plugin login xiaoyiwork
$ magpie provider test xiaoyiwork
  ✓ chat       450 ms · LLM_DeepSeekV4_Think
$ magpie quota
  xiaoyiwork · 小艺体验版 · AI 点 200 · 首月权益包 剩余 1000（12-16 到期）
```

之后任何 agent 都能用 `xiaoyiwork/LLM_DeepSeekV4_Think` 这样的模型 id。

---

## 安装

magpie 应用里：**插件 → 添加插件**，填 `github:kwypn/magpie-xiaoyiwork`。

终端：

```bash
magpie plugin add github:kwypn/magpie-xiaoyiwork
magpie plugin login xiaoyiwork      # 选 1 或 2
magpie provider test xiaoyiwork
```

OpenCode 也能直接用（它只认 `config` / `auth` / `provider`，本插件用到的都是这些）：

```jsonc
// opencode.jsonc
{ "plugin": ["magpie-xiaoyiwork"] }
```

---

## 登录

### ★ 前提：这台机器要能出网

小艺Work 的网关（`hag-drcn.op.dbankcloud.com`）和华为 OAuth
（`oauth-login.cloud.huawei.com`）在部分网络里**必须走代理**才能访问。
插件自己的每一次请求（换 token、签票、读目录、聊天）都会读环境里的代理：

```
MAGPIE_HTTPS_PROXY / MAGPIE_HTTP_PROXY / MAGPIE_ALL_PROXY   ← magpie 插件宿主给的
HTTPS_PROXY / HTTP_PROXY / ALL_PROXY                          ← 兜底
```

> ⚠ **Bun 的 fetch 不吃 `socks5://`**（会报 `UnsupportedProxyProtocol`）。
> 插件会把 `socks5://host:port` 换成同端口的 `http://host:port` ——
> sing-box 这类 **mixed 入站**端口同时听 http 和 socks5，实测两者都通。

magpie 侧要做的两件事：

```bash
# ① 全局代理（插件宿主启动时带上它，否则插件的 fetch 直连 → 断连）
magpie settings set proxy http://127.0.0.1:1081

# ② 给这个 provider 补一条带代理的条目（magpie 登录时按 provider 取代理）
#    没有这条，登录页能打开但回调换 token 时直连失败：
#    "The socket connection was closed unexpectedly"
magpie provider set xiaoyiwork proxy=socks5://127.0.0.1:1081
```

改完全局代理后**要重启插件宿主**（kill 掉 `plugin-host` 进程，magpie 会自动重拉）：

```bash
pkill -f plugin-host
```

### 方式 1：浏览器华为账号登录

不需要安装小艺Work。走标准 OAuth PKCE：

```
PKCE(S256) → 浏览器授权 → 本地回调 127.0.0.1:17355/auth/callback
           → /oauth2/v3/token 换 accessToken + refreshToken
           → business-credential/create 签 7 天凭据
```

⚠ 登录要占用 **17355** 端口接回调，所以登录时**小艺Work 必须完全退出**（它会抢这个端口）。
插件在开浏览器前会先探测端口，占用了会直接告诉你。

> **手机登录**：magpie 在服务器上时，手机浏览器回调不到服务器的 `127.0.0.1:17355`。
> magpie 会识别这种情况（`pasteCallback: true`），
> **把浏览器最后停在的那个地址整段复制回 magpie** 即可完成登录。
> 这一步由 magpie 完成，插件不用管。

### 方式 2：读取本机小艺Work 登录态（Windows，免输入）

零输入：读注册表 `HKCU\Software\ClawDesktop\keychain` 里小艺Work 存的凭据，
用 `DPAPI` 解出 Chromium `os_crypt` 主密钥、再 `AES-256-GCM` 解开密文，拿到
`businessCredential` + `refreshToken` + `uid`，顺带算出 `deviceId`。

前提：这台机器上小艺Work 登录过一次。

### 同一账号只能有一个

两种方式拿到的 `businessCredential` 每次都不一样，magpie 只对 oauth 账号按 uid 覆盖，
所以插件自己把关：登录时直接读 magpie 的 `plugin-auth.json`，看这个 `uid` 是否已占了槽位
（`xiaoyiwork` 或 `xiaoyiwork#xxxxxx`）。

```
magpie: the sign-in failed: 账号 70086000334832078 已经添加过了，同一个账号只允许一个。
要换登录方式（比如从"读取本机登录态"换成"浏览器登录"），先在 magpie 的插件页把旧账号删掉再回来添加；
若确实需要并存，给插件开 allowDuplicate 选项。
```

删掉旧账号后判断自动失效，不会留下永久黑名单。真要并存：

```bash
magpie plugin options magpie-xiaoyiwork '{"allow_duplicate": true}'
```

---

## 模型

上游真实目录按账号拉取（`provider.models` 钩子），下面是不返回时的兜底：

| 模型 id | 显示名 | 倍率 | 图片输入 | 说明 |
|---|---|---|---|---|
| `LLM_DeepSeekV4_Think` | DeepSeek-V4-Flash | 1x | ❌ | 默认，带思维链 |
| `DeepSeek_V4.1_Flash_VE` | DeepSeek-V4.1-Flash | 1x | ✅ | 复杂任务 |
| `LLM_DeepSeekV4_Pro_Think` | DeepSeek-V4-Pro | 1x | ❌ | 深度推理 |
| `LLM_GLM5.3` | GLM-5.3 | 8x | ❌ | 编程旗舰，**很贵** |
| `GLM_5.3_FLASH_VE` | GLM-5.3-Flash | 0.8x | ✅ | 便宜 + 能读图，性价比最高 |
| `MiniMax_M3.1_Flash` | MiniMax M3.1 Flash | 1x | ✅ | 速度/成本均衡 |
| `Kimi_K3.1_Pro_VE` | Kimi K3.1 Pro | 13x | ✅ | **灰度**，见下 |
| `Kimi_K3` | Kimi K3 | 1.6x | ❌ | 上代旗舰 |
| `OpenPanguV2-Pro` | openPangu-2.1-Pro | 1x | ❌ | 鸿蒙任务增强 |
| `Auto-Model` | Auto-Model | — | ❌ | 由服务端按任务选 |

倍率 `rate` 直接来自上游模型目录的 `aiPointConsumptionRatio`（`"消耗8x"` → `x8`），
magpie 的模型选择器、`magpie quota`、额度卡片都会显示。

### ★ Kimi K3.1 Pro（灰度）

上游给这个模型打的是 `gray: true`，小艺Work 自己的模型选择器里是**禁用态**
「灰度中，暂不可选」。也就是说官方口径是未开放。

但**接口层面它能跑**：实测能正常出结果、也能读图。所以本插件**默认把它列出来**
（名字带「（灰度）」后缀），并把上游标的 13x 倍率显示出来 —— 它是上游最贵的一档，
别误以为免费。要藏起来：

```bash
magpie plugin options magpie-xiaoyiwork '{"show_gray": false}'
```

Kimi K3.1 Pro 有两个插件已经兜住的坑：

1. **内容写进思维链** —— 某些上下文/受限场景下上游只填 `reasoning_content`、
   `content` 是空的。插件会把 reasoning 补成 content，客户端不会拿到空回答。
2. **首字延迟超 110s** —— 慢思考 + 大提示词。插件把 provider 的 `patience` 设成 240
   （magpie 默认 60s 会直接判 502）。

### 插件选项

| 开关 | 默认 | 作用 |
|---|---|---|
| 显示灰度测试模型 | 开 | 把上游标灰的模型（Kimi K3.1 Pro）也列出来 |
| 允许同一账号重复添加 | 关 | 默认一个账号只让加一次 |

命令行等价写法（值是 **provider 嵌套**的，这是 magpie 认的形状）：

```bash
magpie plugin options magpie-xiaoyiwork '{"xiaoyiwork":{"show_gray":false}}'
magpie plugin options magpie-xiaoyiwork off     # 复位所有开关
```

> ⚠ **改完开关，模型列表最长要等一分钟左右才变。** 这是 magpie 自己的模型缓存周期，
> 不是插件慢。想立刻看到就点编辑页的「重新获取模型」，或命令行强制拉一次：
>
> ```bash
> magpie provider models xiaoyiwork     # 输出 "✓ N models … · fetched just now"
> ```

---

## 对话通路

| 步骤 | 请求 | 说明 |
|---|---|---|
| 1 | `POST /celia/v1/sse-api/chat/completions` | OpenAI chat 格式，只吃 SSE |

- 请求头三件套：`businessCredential` + `x-uid` + `x-device-id`，
  外加 `x-request-from: xiaoyiWork`、`x-businessId: WINPC_XIAOYI_WORK`。
- 响应帧：`data:{"choices":[{"delta":{"content","reasoning_content","tool_calls"}}]}`，
  **没有 `[DONE]`** —— 插件补发，否则不少客户端会一直挂着等。

---

## 额度

`GET /ability-billing/v1/agent-purchases-client/privilege/query` 分两个互不相干的桶：

- **会员积分 pool**：免费 / 购买 / 赠送 / 补偿 四部分之和。上游**不给**重置日期或有效期。
- **权益包**：`privilegeDetail` 里带「剩余积分：N」，`expireTime` 是**作废**时间（不是按月重置）。

上游没有发放总量字段，所以「总计」取插件观测到的最大值当分母，首次读取时剩余即总计。

```bash
magpie quota xiaoyiwork --json      # 指定 provider
magpie quota                        # 全部
```

---

## 逆向要点（自己维护时看这里）

踩过的坑，改代码别踩回去：

1. **只吃 SSE**。`accept: application/json` 会 `406`，非流式请求必须在插件里自己聚合成一个 `chat.completion`。
2. **没有 `[DONE]`**。上游发完 `finish_reason` 就断流，插件必须补 `data: [DONE]`。
   同时把上游的 `id: N` SSE 行去掉、补 `object`/`created`/`model`。
3. **accessToken 有"新鲜度"窗口**（实测 0 分钟可用、5 分钟就 `400 clientId is invalid`）。
   所以「代刷」和「签票」不能拆开做，也不能缓存 token 复用。
4. **签票会作废旧票**。每次 `business-credential/create` 成功，上一张立刻变废票（`401`）。
5. **`deviceId` 是"已登记设备"校验**，不是随便算的：真实值 =
   `sha256(MachineGuid).hex(小写) + "_" + uid`（小艺Work 首次登录时登记的）。
   伪造值即使 token 新鲜也报 `clientId is invalid`（错误信息骗人，其实是设备校验）。
   → 这就是**方式 2 只能在 Windows、且本机 App 得登录过**的原因。
6. **OAuth 的 `refresh_token` 走不通**：`400 missing required parameter: client_secret`。
   App 是机密客户端、密钥在服务端，所以只能走网关代刷。
7. **模型目录必须带 `x-prd-pkg-name: com.huawei.hmos.vassistant`**，缺了就 400，
   倍率/真实模型表全丢（会静默回退到静态表，很难发现）。
8. **图片输入要按模型声明**：接口接受任何模型的 `image_url`，但只有带 `_VE` 的模型真能读图，
   其余会回"没看到图片"。谎报 `modalities` 只会让 agent 白花点数。
9. **`gray: true` = 官方禁用**，不是"能用但标灰"：渲染层就是 `disabled: true` +
   「灰度中，暂不可选」。插件用名称后缀「（灰度）」和 `rate` 倍率如实标注，
   不假装它是正式开放的模型。
10. **入口只能导出一个函数**。magpie 会把入口导出的每个「函数」都当插件调用，
    多导一个 `default` 就会被装配两次。
11. **自己的 fetch 必须显式带代理**。magpie 宿主只在 `via` 里存了**该 provider 在
    providers.json 里的 proxy**；没有这条，插件的 fetch 走 `globalProxy`
    （宿主启动时的 `MAGPIE_*_PROXY`），而宿主常常是「no proxy」起的
    → 直连华为 → "The socket connection was closed unexpectedly"。
    插件自己再兜一层：从环境读代理（见 README「前提：这台机器要能出网」）。
12. **`rate` 必须是数字**。magpie 的 `rateOf()` 只认 `number`，字符串 `"x13"` 会被读成 0，
    倍率就显示不出来。而且 magpie 读 config 钩子的模型表时**不搬 rate** ——
    rate 只从 models 钩子的返回值里取，所以两处都得给数字。
13. **选项要声明 `default: true`**。magpie 的运行时读取
    （`optionValue = optionValues(provider)[key] === true`）对没声明 default 的选项一律回 false，
    「没设置」与「显式关掉」读不出区别 —— 不写这一行，默认该开的开关会被当成关着。

---

## 开发

```bash
node test/run.mjs        # 11 条离线断言（不需要凭据/网络）
node scripts/check.mjs   # 发布前自检（语法/package/图标/导出形状/端点一致）
```

代码结构：

```
index.mjs            插件装配（config / auth / loader / usage / provider.models）
src/context.mjs      常量：provider id、上游端点、OAuth 参数、模型表
src/gateway.mjs      HTTP 头、SSE 帧改写、聚合器
src/credential.mjs   设备标识、登录态归一、签票/代刷续期、本机凭据读取
src/login.mjs        华为 OAuth PKCE、本机登录态导入
src/models.mjs       模型目录（带 x-prd-pkg-name）、额度观测
src/accounts.mjs     同 uid 账号槽位去重闸门
```

---

## 限制

- **方式 2 仅 Windows**（要读注册表 + DPAPI）。其它平台用方式 1。
- 模型额度走**你账号的 AI 点**，插件不代付。GLM-5.3（8x）/ Kimi K3.1 Pro（13x）很贵，注意看倍率。
- 单账号并发建议低（默认 `maxConcurrency: 2`），上游对同一账号并发敏感。
- `context`/`output` 是估值（窗口 ≈ 1M tokens，实测值见 `docs/context-length.md`）。
- 这是**非官方**插件，接口随时可能变；坏了按上面「逆向要点」重抓一次即可。

## 隐私

- 插件只把请求发往 `hag-drcn.op.dbankcloud.com`（华为小艺自己的网关），不经过任何第三方。
- 凭据保存在 magpie 自己的 `plugin-auth.json`（权限 600），插件不写日志、不外传。
- 方式 2 读取的是当前 Windows 用户自己的注册表项，需要同用户上下文（不需要管理员）。

## 许可

MIT

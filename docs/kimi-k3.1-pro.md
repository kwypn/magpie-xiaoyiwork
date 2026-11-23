# Kimi K3.1 Pro：小艺Work 侧的三个坑 + 「无限用」说法的归属

> 结论先写：**「小艺Work 的 Kimi K3.1 Pro 可以无限用 / 不扣 AI 点」这个说法，查不到小艺Work 的任何来源。**
> 所有「白嫖 Kimi K3.1 Pro 跑一整晚」类报道说的是**腾讯 WorkBuddy**（copilot.tencent.com / workbuddy.ai，
> 积分制），跟华为小艺Work（AI 点制）是两个产品、��套账号体系。小艺Work 官方口径里 Kimi K3.1 Pro
> 是「最贵的一档（13x）+ 灰度未开放」，没有「无限」这回事。

下面分三部分：① 已确认并已在插件里修掉的三个坑；② 「无限」说法的归属与证据；
③ 想自己验证「这次调用扣了几个点」怎么做。

---

## ① 已确认并修掉的三个坑

### 坑 1：官方禁用，接口却能跑（灰度模型）

上游模型目录接口返回：

```json
{ "modelValue": "Kimi_K3.1_Pro_VE", "gray": true, "aiPointConsumptionRatio": "消耗13x" }
```

小艺Work 自己的模型选择器对 `gray === true` 渲染成：

```js
title: m.gray ? m.disabledReason || "灰度中，暂不可选" : …
disabled: m.gray === true
```

也就是**官方口径是「不让选」**。但上游的对话接口对这个模型 id 是能跑的：
实测能正常出结果、也能读图（拿一张写着编号的图逐个模型问，只有 `_VE` 结尾的模型答得出来）。

→ 本插件的处理：**默认把它列出来**，名字加「（灰度）」后缀，并如实显示 13x 倍率 ——
既不假装它是正式开放的模型，也不白藏一个能用的模型。要藏：
`magpie plugin options magpie-xiaoyiwork '{"xiaoyiwork":{"show_gray":false}}'`。

### 坑 2：内容写进思维链 → 客户端拿到空回答

上游某些上下文/受限场景下只填 `reasoning_content`，`content` 是空的。
直接透传，客户端看到的就是「模型什么都没说」。

→ 已修：`src/gateway.mjs` 的 `withContentFallback()` —— 流式与聚合两条路都会把
reasoning 补成 content。测试用例 `test/run.mjs` 里有一条专门盯这个。

### 坑 3：首字延迟超 110s → magpie 判 502

慢思考 + 大提示词，首字延迟实测可超 110s。magpie 默认 60s patience 会把
「上游失联」判成 502，于是慢模型看起来像挂了。

→ 已修：`index.mjs` 的 `config` 里给 provider 设 `patience: 240`（magpie 的上限）。

### 附：同代产品的 Kimi 工具调用 bug（不是小艺Work，但同一个模型）

腾讯 WorkBuddy 的插件源码里记着一条实测（`@magpie-community/opencode-workbuddy-auth`
的 `index.mjs` 与 README 第 265 行）：

> `kimi-k3.1-pro`（和 `-highspeed`）对一个「只有 tool_calls、content 为 null」的 assistant 回合
> 回 400 "Invalid request parameters"。而这正是所有 OpenAI 客户端记录「只调工具不说话」的回合的形状
> —— 所以 agent 从第一次工具调用起就挂。同一模型在 QwenWork 上拒 null 和 `""`、接受一个空格；
> DeepSeek / GLM / Qwen 走的是空回合。
> 修法：给这种回合的 content 填一个空格（`CALL_TEXT = " "`）。

这条是 Kimi K3.1 Pro **模型侧**的真实 bug，跟小艺Work 无关，但如果你在别家
（QwenWork / WorkBuddy / Kimi 官方 API）用同一个模型，工具调用第二轮起就会 400。
小艺Work 这条通路上没复现过（上游给的是原生 `tool_calls`），插件暂未加这个补丁。

---

## ② 「无限用 / 不扣点」说法的归属

### 检索到的全部「白嫖 Kimi K3.1 Pro」报道 —— 指向的都是腾讯 WorkBuddy

| 出处 | 关键原文 | 归属 |
|---|---|---|
| 知乎专栏《在 WorkBuddy 白嫖 Kimi K3.1 Pro 跑了一整晚》 | 「这两天，平时秒开的 WorkBuddy 打开时常有延迟。我打开模型源一看，好家伙，原来是号称国内最强、足足有 3 万亿参数的 Kimi K3.1 Pro 空降接入了」 | **腾讯 WorkBuddy** |
| 今日头条《Kimi K3.1 Pro 接入 WorkBuddy，3D 建模能力直接拉满》 | 「最近 Kimi K3.1 Pro 发布……对普通人、设计师、创客最友好的」 | **腾讯 WorkBuddy** |
| B 站《WorkBuddy 接入任意本地 AI 大模型，无限 Token 随便用！》《WorkBuddy 无限白嫖额度 一键签到4000积分》 | 「多账户一键白嫖积分」「无限白嫖额度 一键签到 4000 积分」 | **腾讯 WorkBuddy**（积分制） |
| 牛学 niuxue《Kimi K3.1 Pro 来了：能不能免费用，额度怎么扣》 | 讲的是 **Kimi 官网/会员**：10-26 官方为「限流及不必要的额度消耗」道歉，补偿会员月度总额 25% | **Kimi 官方会员**（不是小艺Work） |

**「小艺Work 的 Kimi 免费/无限」：检索无果。** 小艺Work 的官方叙事里，Kimi 的位置是
「贵、需要付费、灰度未全量」——没有任何「无限」表述。

### 为什么「无限」会被安到小艺Work 头上（三个可能的来源）

1. **第三方中转站套壳**：以 OpenAI 兼容 API 形式提供「Kimi 不限量」，背后是账号池或自有 Kimi 额度，
   跟小艺Work 官方无关。这类端点不吃小艺Work 的 13x 点数扣减，自然宣称无限。
2. **语义误传**：「官方选择器禁用 + 官方说贵」被二次传播成「能白嫖」。
3. **`Auto-Model` 自动路由**：上游 `Auto-Model` 由服务端按任务选路，可能落到 Kimi，
   用户看不到自己按 13x 扣了点，就以为「随便用」。

### 候选机制评估

| 机制假设 | 评估 | 依据 |
|---|---|---|
| 灰度模型走不计费分支 | **未证实** | 上游目录只给 `gray:true` 与倍率，没有任何「免费」标记字段 |
| 目录倍率（13x）与实际扣费不同源 | **未证实** | 需要登录态实测对比调用前后余额才能定 |
| 赠送点数/体验版权益期内不扣点 | **未证实** | 权益包有 `expireTime`，但没写「期内免费」 |
| 模型 id 别名绕过倍率校验 | **未证实** | 上游只认精确的 `modelValue` |
| 官方有意灰度免费放量 | **最不像** | 官方口径是「灰度中，暂不可选」，是禁用不是免费 |

**结论：小艺Work 的 Kimi K3.1 Pro 没有「无限」这个特性。** 它是**最贵的一档（13x）**。

---

## ③ 想自己验证「这次调用扣了几个点」

### 读余额

```bash
magpie quota xiaoyiwork --json
```

插件内部走的是：

```
POST https://hag-drcn.op.dbankcloud.com/ability-billing/v1/agent-purchases-client/privilege/query
body: { accountType:"HW_UID", agentId, endpoint:{ device:{brand:"HUAWEI",deviceId}, eduMode:"NONEDU", ... } }
```

两个互不相干的桶：
- **会员积分 pool**（`agentId=1` → `celiaPremiumPrivilege.aiPoints`）：
  `freePoints` / `purchasedPoints` / `giftPoints` / `compstPoints` / `totalPoints`。
  上游**不给**重置日期或有效期字段（`aiPointDetailDisplay:false`）。
- **权益包**（平台 `agentId` → `privilegeList`）：`privilegeDetail` 里带「剩余积分：N」，
  `expireTime` 是**作废**时间（不是按月重置）。

⚠ `agentId=1` 那个接口偶发 408，插件会重试 3 次；一次都没拿到窗口时回落到上次成功的结果
（存在 magpie 配置目录的 `xiaoyi-points-state.json`）。

### 手动对比

```bash
# 1. 记下调用前的余额
magpie quota xiaoyiwork --json > /tmp/before.json

# 2. 打一次 Kimi K3.1 Pro（走 magpie 网关）
curl -s http://127.0.0.1:3425/v1/chat/completions \
  -H "Content-Type: application/json" -H "Authorization: Bearer $GWKEY" \
  -d '{"model":"xiaoyiwork/Kimi_K3.1_Pro_VE","messages":[{"role":"user","content":"说一句话"}],"max_tokens":64}'

# 3. 再读一次余额，对比 totalPoints 掉了多少
magpie quota xiaoyiwork --json > /tmp/after.json
```

**判据**：`totalPoints` 的差值 ÷ 倍率 = 实际消耗的点数。若差值明显小于「倍率 × token 量」，
那才是真有 bug；若倍率 13x 明显生效，就是正常计费。

### 上游还有没有「用量明细」接口？

已知的三个端点里没有明细接口。目录接口（`user-ability-gallery`）只给模型元数据，
额度接口（`ability-billing`）只给余额。没有找到「逐笔明细」路径 ——
**这一条未证实**，别当成有。

---

## 附：与小艺Work 无关的 Kimi 侧事实（2026-10-24/26 官方）

- K3.1 Pro：3 万亿级参数、100 万上下文、始终开启思考模式。
- API 定价相比 K3：输入与命中缓存便宜 35%，输出便宜 32%；高速版价格 2 倍。
- 2026-10-26 官方就「K3.1 Pro 造成的**限流及不必要的额度消耗**」公开道歉，
  给所有有效期内的会员补回月度总额的 25%（用掉不足 25% 的直接归零）。
  官方**没有**说过调低额度，也没公布单次扣减口径。

这两条说明「额度掉得快」是 Kimi 官方承认过的真实问题，但它跟「能不能无限用」不是一回事。

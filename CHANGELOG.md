# Changelog

## 0.4.0 — 2026-11-24

重写为模块化实现，并新增 **Kimi K3.1 Pro** 支持（上游灰度模型，13x 倍率）。

### 新增
- **Kimi K3.1 Pro**（`Kimi_K3.1_Pro_VE`）：上游标 `gray:true`、倍率 13x。
  默认**列出**并标注「（灰度）」，不再像上游那样完全隐藏 —— 接口层面能跑、也能读图。
- `Kimi_K3`（Kimi K3，1.6x）、`LLM_DeepSeekV4_Pro_Think`（DeepSeek-V4-Pro）进静态兜底表。
- `src/` 分层：`context` / `gateway` / `credential` / `login` / `models` / `accounts`。
- `scripts/check.mjs` 发布前自检；`test/run.mjs` 11 条离线断言。
- `docs/context-length.md`：上下文窗口实测记录。

### 修复
- ★ **Kimi K3.1 Pro 内容写进思维链**：上游只填 `reasoning_content`、`content` 为空时，
  客户端会拿到空回答。现在把 reasoning 补成 content（流式与聚合两条路都补）。
- ★ **Kimi 首字延迟超 110s 被判 502**：provider 的 `patience` 设为 240
  （magpie 默认 60s 就把慢模型判成「上游失联」）。
- **入口多导 `default` 导致插件被装配两次**：magpie 会把入口导出的每个函数都当插件调用，
  现在只导出一个 `XiaoyiWorkAuthPlugin`。
- **SSE 帧解析**：上游 SSE 里混着 `id: N` / `event:` 裸行，现在只取 `data:` 行再重新封装。
- **`rate` 归一**：`"消耗8x"` / `"x8"` / `"8x"` / `"8"` 都能归一成 `x8`。
- **额度窗口回落**：上游额度接口偶发 408，一次都没拿到窗口时回落到上次成功的结果，
  不再被 magpie 判成「没有额度端点」。

### 变更
- 包名 `opencode-xiaoyiwork-auth` → `magpie-xiaoyiwork`，版本 0.3.2 → 0.4.0。
- 灰度模型开关语义反转：`show_gray` 默认**开**（列出来），设为 `false` 才隐藏。
- 删掉旧的单文件 `test.mjs`（由 `test/run.mjs` 取代）。

### 已知边界
- 上游没有发放总量字段，额度「总计」取插件观测到的最大值当分母。
- 方式 2（读本机登录态）仅 Windows；其它平台用华为账号浏览器登录。

### 0.4.1 — 2026-11-24

修掉 a 机上的**登录失败**（"The socket connection was closed unexpectedly"）和模型列表的三个问题。

#### 修复
- ★ **登录失败 = 插件自己的 fetch 没走代理**。magpie 宿主只在 `via` 里存了该 provider 在
  `providers.json` 里的 proxy；没有这条，插件的 fetch 回落到 `globalProxy`（宿主启动时的
  `MAGPIE_*_PROXY`），而宿主常常是「no proxy」起的 → 直连华为 → 断连。
  新增 `src/proxy.mjs`：从 `MAGPIE_*_PROXY` / `*_PROXY` 取代理；
  Bun 的 fetch 不吃 `socks5://`（`UnsupportedProxyProtocol`），
  把 `socks5://host:port` 换成同端口 `http://`（mixed 入站两种都听）。
  换 token、签票/代刷、聊天请求与重试全部带上。
  实测：同一请求 direct → `socket closed unexpectedly`；带代理 → `HTTP 400 invalid code`（到了华为）。
- **倍率显示不出来**：`rate` 必须是数字（magpie 的 `rateOf()` 只认 number），
  且 magpie 读 config 钩子的模型表时**不搬 rate** —— rate 只从 models 钩子取，两处都给数字。
- **Kimi K3.1 Pro 在模型列表里消失**：选项 `show_gray` 必须声明 `default: true`
  （magpie 的运行时读取对没声明 default 的选项一律回 false，「没设置」与「显式关掉」读不出区别）。
- **名字成「Kimi K3.1 Pro（灰度）（灰度）」**：config 钩子标过一次，models 钩子又标一次。

#### 文档
- README 加「前提：这台机器要能出网」一节：`magpie settings set proxy`、
  `magpie provider set xiaoyiwork proxy=`、改完全局代理要 `pkill -f plugin-host`。

## 0.4.2 — 2026-11-24

修掉**思维链侧漏到会话正文**。

### 修复
- ★ **客户端看到的是思维链而不是回答**。现象：问「你是什么模型」，会话里出现
  `I'll respond to the user asking "你是什么模型" ...` 这样的思维链正文。
  根因：`withContentFallback` 是**逐帧**判断「这帧 content 为空吗 → 有 reasoning 就补」，
  而 Kimi 的每一帧都只有 `reasoning_content`、content 是空的（思维链一段段吐、正文最后才来）
  → 逐帧判断永远成立 → 每帧都把思维链复制进 content。
  修法：兜底改成**整段流级别** —— 留最后一帧到流结束才发，全程记「有没有见过真正的 content」；
  出现过正文就原样透传；整段都没有正文（模型真把答案写进思维链）时才把思维链补成正文。
  `aggregate`（非流式）本来就是整段结束时才判，逻辑已对、未改。

### 实测（a 机，真 Kimi 流）
```
修复前 client content = "I need respond in Chinese user asks what model I should say Kimi我是 Kimi..."
修复后 client content = "我是 Kimi，由 Moonshot AI（月之暗面）开发的大语言模型。..."
reasoning_content 826 字完整保留在思维链字段里，不进正文
```
DeepSeek-V4 / GLM-5.3-Flash / MiniMax-M3.1 / Kimi-K3 四个模型同样验过，流式与聚合都干净。
经 magpie 网关的真实客户端链路复验：无侧漏。

### 测试
新增 3 条回归用例，已验证「回退修复后新用例立刻失败」（能抓住这个 bug），测试 22/22。

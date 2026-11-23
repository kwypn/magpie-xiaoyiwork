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

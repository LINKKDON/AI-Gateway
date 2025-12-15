# 🌐 Universal AI Gateway (Dual Engine)

> **专为沉浸式翻译 (Immersive Translate) 与高并发场景优化的 Serverless AI 网关。**

本项目提供两个针对不同平台特性深度优化的版本，旨在解决免费 API (如 Cerebras, Groq, DeepSeek) 的限流问题，同时提供隐私保护和 IP 伪装能力。

---

## ⚖️ 版本选型指南 (Decision Guide)

本项目包含两个核心分支，请根据你的具体资源和需求选择：

| 特性 | **🚀 Cloudflare Workers 版 (v5.9.8)** | **🦕 Deno Deploy 版 (v5.9.9)** |
| :--- | :--- | :--- |
| **代号** | **Stable Failover (极速故障转移)** | **Stealth Queue (隐匿队列)** |
| **核心机制** | **多 Key 轮转 + 暴力切号** | **全局真队列 + 严格限流** |
| **并发策略** | 0ms 延迟直连，遇到 429 立即换 Key 重试 | 强制排队，按设定间隔 (如 250ms) 逐个放行 |
| **IP 质量** | **极优** (Anycast 全球海量原生 IP) | 一般 (固定数据中心 IP) |
| **适用人群** | **多 Key 玩家 (推荐)**<br>拥有 3+ 个免费 Key，追求极致翻译速度，无法忍受排队等待。 | **单 Key / 保号玩家**<br>Key 很少或很贵，必须严格控制 QPS，宁慢勿炸。 |
| **最佳场景** | Cerebras (4 Key+), Groq, OpenAI, Claude | 付费 API, 严格 QPS 限制的公益 API |

---

## 🚀 1. Cloudflare Workers 版 (v5.9.8)

**原理：** 利用 Cloudflare 的高并发与优质 IP，配合 "Body-Hash" 锁定算法，确保请求在失败时能迅速切换到下一个不同的 Key，实现毫秒级容错。

### 部署步骤

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，创建一个新的 Worker。
2.  将 `worker.js` (v5.9.8) 的代码完整复制进去。
3.  **配置环境变量 (Settings -> Variables)**：
    * `ACCESS_PASSWORD`: (必填) 设置你的访问密码，防止被他人盗用。
    * `CEREBRAS_API_KEYS`: (推荐) 填入你的 Key，用英文逗号 `,` 分隔。建议 4 个以上。
    * *(可选支持)*: `GROQ_API_KEYS`, `DEEPSEEK_API_KEYS`, `OPENAI_API_KEYS` 等。
4.  点击 **Deploy**。

### ⚡️ 客户端建议设置
* **沉浸式翻译 - 每秒最大请求数：** 建议设置为 `5` ~ `8`。
* 此版本追求速度，通过快速重试掩盖错误。

---

## 🦕 2. Deno Deploy 版 (v5.9.9)

**原理：** 利用 Deno 单实例内存共享特性，实现真实的全局队列 (Global Queue)。无论客户端并发多大，网关都会像红绿灯一样，匀速地将请求转发给上游。

### 部署步骤

1.  登录 [Deno Deploy](https://dash.deno.com/)，新建一个 Playground 或连接 GitHub。
2.  将 `main.ts` (v5.9.9) 的代码复制进去。
3.  **代码微调**：
    * 找到代码中的 `SERVICES_CONFIG`。
    * 根据你的 Key 数量修改 `rateLimit`。公式：`1000 / Key数量 = rateLimit`。
    * *例：你有 4 个 Key，设置 `rateLimit: 250` (即每 250ms 发一个请求)。*
4.  **配置环境变量**：
    * `ACCESS_PASSWORD`: (必填) 访问密码。
    * `CEREBRAS_API_KEYS`: (必填) API Key 列表。
5.  点击 **Save & Deploy**。

### ⚡️ 客户端建议设置
* **沉浸式翻译 - 每秒最大请求数：** 建议设置为 `3`。
* 此版本追求稳定，让网关在云端帮你排队。

---

## 🔐 隐私与安全警示 (Privacy First)

**⚠️ 严禁使用不可信的公共网关！**

由于翻译请求通常包含大量敏感信息（隐私文档、公司合同、个人邮件等），且网关拥有者在技术上可以轻易截获明文内容。

1.  **坚持自建：** 请务必部署在自己的 Cloudflare/Deno 账号下。
2.  **密码保护：** 务必设置复杂的 `ACCESS_PASSWORD`。
3.  **防盗用：** 代码已内置 Nginx 伪装页面，直接访问根路径不会暴露 API 信息，有效防止扫描。

---

## 🛠️ API 接入示例

**基本 URL 格式：** `https://你的域名/服务商/v1/chat/completions`

### 支持的服务商路由
* `/cerebras` -> Cerebras
* `/groq` -> Groq
* `/deepseek` -> DeepSeek
* `/openai` -> OpenAI
* `/claude` -> Anthropic
* `/gemini` -> Google Gemini

### 沉浸式翻译配置示例
* **API 服务：** OpenAI
* **API Key：** `你的ACCESS_PASSWORD`
* **模型：** `llama3.1-70b` (视服务商而定)
* **自定义 API 地址：** `https://your-worker.workers.dev/cerebras/v1/chat/completions`

---

## 📄 License

MIT License. 仅供学习交流与个人使用，请勿用于非法用途。

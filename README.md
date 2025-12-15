# 🌐 Universal AI Gateway

**一个轻量级、高性能的 Serverless AI 网关，专为沉浸式翻译 (Immersive Translate)、LobeChat 等高并发场景优化。**

本项目旨在解决 AI 服务（如 OpenAI, Anthropic, Cerebras, Groq 等）的区域限制、并发限流（Rate Limit）及 IP 风控问题，同时提供统一的接口管理和隐私保护。

---

## ✨ 核心特性

- **多平台支持**：提供 Cloudflare Workers (追求极速) 和 Deno Deploy (追求稳定) 双引擎版本。
- **统一接口**：将不同厂商的 API 统一为 OpenAI 格式 (`/v1/chat/completions`)。
- **隐私安全**：代码开源，支持自建，完全掌控数据隐私；内置 Nginx 伪装页面防止扫描。
- **高可用设计**：
  - **故障转移 (Failover)**：当某个 API Key 耗尽或报错时，自动无缝切换。
  * **智能重试**：内置指数退避与随机抖动 (Jitter) 策略，防止二次雪崩。
  * **负载均衡**：支持多 Key 轮询，最大化利用免费/付费额度。

---

## ⚖️ 版本选型指南 (Decision Guide)

根据你的使用场景和拥有的 Key 数量，选择合适的版本部署：

| 特性 | **🚀 Cloudflare Workers 版** | **🦕 Deno Deploy 版** |
| :--- | :--- | :--- |
| **架构代号** | **Failover Edition (故障转移版)** | **Queue Edition (队列版)** |
| **核心机制** | **多 Key 轮转 + 极速重试** | **全局真队列 + 严格限流** |
| **并发策略** | 0ms 延迟直连，遇到 429 错误立即切号重试 | 强制排队，按设定间隔 (Rate Limit) 逐个请求 |
| **IP 优势** | **极优** (Cloudflare 全球 Anycast 原生 IP) | 一般 (固定数据中心 IP) |
| **适用人群** | **多 Key 用户 (推荐)**<br>拥有多个 API Key，追求极致响应速度，不仅限 QPS。 | **单 Key / 保号用户**<br>Key 数量少或价格昂贵，必须严格控制请求频率。 |
| **推荐场景** | 沉浸式翻译、网页浏览、高并发公共服务 | 严格限流的 API、后台批量任务 |

---

## 🚀 部署指南 1：Cloudflare Workers 版

> **适用文件：** `worker.js` (v5.9.8)

利用 Cloudflare 的全球边缘网络，提供低延迟的 API 转发。

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)，进入 **Workers & Pages**。
2.  点击 **Create Application** -> **Create Worker**。
3.  将 `worker.js` 的代码完整粘贴到编辑器中。
4.  **配置环境变量 (Settings -> Variables)**：
    * `ACCESS_PASSWORD`: **(必填)** 设置网关访问密码。
    * `OPENAI_API_KEYS`: (可选) OpenAI Key，多个 Key 用英文逗号 `,` 分隔。
    * `CEREBRAS_API_KEYS`: (可选) Cerebras Key 列表。
    * *支持所有在代码 `servicesConfig` 中定义的服务商。*
5.  点击 **Deploy**。

---

## 🦕 部署指南 2：Deno Deploy 版

> **适用文件：** `main.ts` (v5.9.9)

利用 Deno 的单实例内存共享特性，实现精确的全局队列控制。

1.  登录 [Deno Deploy](https://dash.deno.com/)。
2.  创建一个新的 **Playground** 或从 GitHub 导入。
3.  将 `main.ts` 的代码粘贴进去。
4.  **代码配置 (可选)**：
    * 在代码中找到 `SERVICES_CONFIG` 对象。
    * 根据你的 Key 数量调整 `rateLimit` (单位：毫秒)。
    * *建议公式：* `1000 / Key数量 = rateLimit`。
5.  **配置环境变量**：
    * `ACCESS_PASSWORD`: **(必填)** 设置网关访问密码。
    * `XXX_API_KEYS`: 配置对应的 API Key 列表。
6.  点击 **Save & Deploy**。

---

## 🛠️ 客户端配置示例

以 **沉浸式翻译 (Immersive Translate)** 插件为例：

1.  **翻译服务**：选择 **OpenAI** (因本项目兼容 OpenAI 接口格式)。
2.  **API Key**：填写你在环境变量中设置的 `ACCESS_PASSWORD`。
3.  **自定义 API 地址**：
    * 格式：`https://你的网关域名/服务商标识/v1/chat/completions`
    * 例如 (调用 Cerebras)：`https://ai-gateway.your-domain.com/cerebras/v1/chat/completions`
    * 例如 (调用 DeepSeek)：`https://ai-gateway.your-domain.com/deepseek/v1/chat/completions`
4.  **每秒最大请求数**：
    * **CF 版**：建议设置为 `5` ~ `8`。
    * **Deno 版**：建议设置为 `3` ~ `5`。

### 支持的服务商路由表
| 路由前缀 | 目标服务商 | 环境变量名示例 |
| :--- | :--- | :--- |
| `/cerebras` | Cerebras | `CEREBRAS_API_KEYS` |
| `/groq` | Groq | `GROQ_API_KEYS` |
| `/deepseek` | DeepSeek | `DEEPSEEK_API_KEYS` |
| `/openai` | OpenAI | `OPENAI_API_KEYS` |
| `/claude` | Anthropic Claude | `CLAUDE_API_KEYS` |
| `/gemini` | Google Gemini | `GEMINI_API_KEYS` |
| `/siliconflow`| SiliconFlow | `SILICONFLOW_API_KEYS` |

*(更多服务商请查看代码中的 `servicesConfig` 配置)*

---

## ⚠️ 免责声明与安全警告

1.  **数据隐私**：本项目仅作为 API 转发工具，不存储任何用户数据。但建议**务必自建网关**，不要使用不可信的第三方公开网关，以防中间人攻击导致隐私泄露。
2.  **合法使用**：请遵守各 AI 服务商的使用条款（ToS）。本项目仅供技术研究与个人学习使用，请勿用于非法用途或大规模滥用免费资源。
3.  **访问控制**：请务必设置高强度的 `ACCESS_PASSWORD`，防止网关被他人扫描和盗用。

---

## License

[MIT](LICENSE)

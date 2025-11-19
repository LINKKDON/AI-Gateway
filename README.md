# 🚀 Universal AI Gateway (High-Performance Edition)

[![Deploy to Deno Deploy](https://shield.deno.dev/deploy/badge)](https://dash.deno.com/new)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

一个基于 Deno 的高性能、轻量级 AI 聚合网关。专为**高并发翻译**、**多账号负载均衡**和**API 稳定性**设计。

它不仅是一个转发器，更是一个具备**流水线并发 (Pipeline)**、**自动故障转移 (Failover)** 和 **智能路径补全** 的增强型代理。

---

## ✨ 核心特性 (Key Features)

*   **⚡️ 流水线并发 (Pipeline Concurrency)**
    *   采用 "Fire-and-Forget" 非阻塞队列机制。
    *   支持高并发请求（如沉浸式翻译同时发送 20+ 段落），网关会自动排队并以最优速率（如 300ms/次）发送，防止触发上游 429 限流。
*   **🔄 多 Key 负载均衡 (Multi-Key Round-Robin)**
    *   支持配置多个 API Key（如 5 个 Cerebras Key）。
    *   自动轮询使用，成倍增加并发额度，极大降低单账号封号风险。
*   **🛡️ 自动故障转移 (Auto-Retry)**
    *   当上游服务返回 `500 Internal Error` 或 `429 Too Many Requests` 时，自动切换下一个 Key 重试。
    *   用户端无感知，极大提升稳定性。
*   **🧠 智能路径修正 (Smart Routing)**
    *   自动补全路径（如将 `/cerebras` 自动补全为 `/v1/chat/completions`）。
    *   自动修正 Gemini 的特殊路径 (`/v1beta/openai/...`)。
    *   自动清洗 URL（去除双斜杠、尾部斜杠），彻底解决 405 Method Not Allowed 问题。
*   **🎭 混合双模 (Dual Mode)**
    *   **托管模式**：使用服务器配置的 Key 池，享受队列保护和轮询加速（客户端填写 `ACCESS_PASSWORD`）。
    *   **透明模式**：客户端自带 Key，直接透传转发，速度最快。

---

## 🔌 支持的服务 (Supported Services)

| 服务路径 | 目标 API | 推荐配置 | 特性 |
| :--- | :--- | :--- | :--- |
| `/cerebras` | Cerebras Inference | 300ms / 500ms | 极速推理，适合翻译 |
| `/groq` | Groq Cloud | 200ms | 天下武功，唯快不破 |
| `/siliconflow` | SiliconCloud (硅基流动) | 500ms | Qwen 2.5 / DeepSeek 最佳平台 |
| `/gemini` | Google Gemini | 200ms | 自动修正 OpenAI 兼容路径 |
| `/openrouter` | OpenRouter | 100ms | 聚合平台，支持自动重试 |
| `/xai` | xAI (Grok) | 200ms | Grok 模型托管支持 |
| `/openai` | OpenAI | 100ms | 官方 API |
| `/claude` | Anthropic Claude | 500ms | 官方 API |

---

## 🛠️ 部署指南 (Deployment)

本项目专为 **Deno Deploy** 优化，完全免费且无需服务器。

1.  **准备代码**：复制 `main.ts` (v5.0) 的完整代码。
2.  **创建项目**：登录 [Deno Deploy](https://dash.deno.com)，创建一个新的 Playground 或连接 GitHub 仓库。
3.  **粘贴代码**：将代码粘贴到编辑器中并保存。
4.  **配置变量**：在 Settings -> Environment Variables 中添加环境变量。

### 环境变量配置

| 变量名 | 示例值 | 说明 |
| :--- | :--- | :--- |
| `ACCESS_PASSWORD` | `123456` | **必填**。这是你的网关密码，用于触发托管模式。 |
| `CEREBRAS_API_KEYS` | `sk-a...,sk-b...,sk-c...` | 多个 Key 用英文逗号分隔。 |
| `GROQ_API_KEYS` | `gsk-x...,gsk-y...` | Groq 的 Key 池。 |
| `SILICONFLOW_API_KEYS`| `sk-sf-...` | 硅基流动 Key，用于 Qwen/DeepSeek。 |
| `GEMINI_API_KEYS` | `AIza...` | Google Gemini Key。 |

*(其他服务如 `OPENAI_API_KEYS` 等同理，未配置的服务将仅支持透明转发模式)*

---

## 📖 客户端使用方法

### 场景 A：沉浸式翻译 (Immersive Translate) - 推荐配置

这是本网关优化的重点场景，可实现网页**秒级全屏翻译**。

*   **服务商**：选择 **OpenAI (自定义)**
*   **API Key**：填写你的 `ACCESS_PASSWORD` (如 `123456`)
*   **模型**：
    *   Groq: `llama-3.1-70b-versatile`
    *   SiliconFlow: `Qwen/Qwen2.5-72B-Instruct`
    *   Cerebras: `llama3.1-70b`
*   **接口地址 (URL)**：
    *   `https://你的域名.deno.dev/groq` (或 `/cerebras`, `/siliconflow`)
    *   *(程序会自动补全后缀，无需手动填写 /v1/...)*

**🔥 最佳高级设置 (Advanced Settings):**
*   每秒最大请求数 (Max Requests/Sec): **5 ~ 10**
*   每次请求最大段落数 (Max Paragraphs): **35** (关键优化！打包发送)
*   每次请求最大文本长度: **5000**

### 场景 B：NextChat / OneAPI / NewAPI

*   **接口地址**: `https://你的域名.deno.dev/siliconflow` (或者其他服务)
*   **API Key**: `123456` (托管模式) 或 `sk-your-real-key` (直连模式)

---

## ⚙️ 高级调整 (Tuning)

你可以在代码顶部的 `services` 对象中调整每个服务的 `rateLimit` (毫秒)，以平衡速度和风控风险。

```javascript
const services = {
  '/cerebras': { 
    // ...
    // 如果你有 5 个 Key，可以设为 150 (极速)
    // 如果你有 3 个 Key，建议设为 300 (稳健)
    rateLimit: 300 
  },
  // ...
};
```

---

## 🔒 安全说明

1.  **User-Agent 伪装**：网关会自动伪装成 Chrome 浏览器，防止被 Cerebras 等 WAF 拦截 (403 Forbidden)。
2.  **内存保护**：内置 `MAX_QUEUE_SIZE = 100` 限制，防止恶意请求导致服务器内存溢出。
3.  **异步兜底**：完善的 Error Handling，防止单个请求崩溃导致整个服务重启。

---

## License

MIT License. Feel free to use and modify.

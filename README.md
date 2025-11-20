这份 README 文档旨在清晰地介绍该项目的特性、部署方法以及针对“沉浸式翻译”的特别优化。你可以将其保存为 `README.md` 文件。

---

# 🌐 Universal AI Gateway (通用 AI 网关)

一个高性能、隐身、抗高并发的 AI 聚合网关。支持多厂商负载均衡、密钥轮询、自动重试与防封保护。

专为 **沉浸式翻译 (Immersive Translate)**、**LobeChat**、**ChatGPT-Next-Web** 等高并发场景优化。

![Version](https://img.shields.io/badge/Version-v5.7-blue) ![Platform](https://img.shields.io/badge/Platform-Cloudflare%20%7C%20Deno%20%7C%20Docker-orange) ![License](https://img.shields.io/badge/License-MIT-green)

## ✨ 核心特性

*   **🕵️ 隐身模式 (Stealth Mode)**：根路径 `/` 返回 `404 Not Found`，彻底隐藏网关身份，防止扫描。
*   **🛡️ 全链路去头 (No-Trace)**：严格过滤 `cf-ray`, `x-forwarded-for` 等特征头，上游无法探测你的真实 IP 或 Cloudflare 痕迹。
*   **🚀 高并发队列 (Pipeline)**：内置非阻塞任务队列（深度 200+），完美承接沉浸式翻译瞬间爆发的几十个请求，防止 429 错误。
*   **🎲 智能抖动 (Smart Jitter)**：在请求间加入 20ms~100ms 的微小随机延迟，模拟人类网络波动，规避“脚本特征”检测。
*   **🔄 自动重试与轮询**：支持多 Key 轮询，遇到 429 或 5xx 错误自动指数退避重试。
*   **🔗 路径修正**：完美修复 Gemini `/v1/` 路由问题，兼容 OpenRouter 伪装头，支持 DeepSeek。

---

## 🏗️ 部署指南

本项目提供两个版本，请根据你的需求选择。

### 🅰️ Cloudflare Workers 版 (推荐 🌟)
> **适用场景**：个人使用、沉浸式翻译、追求极致速度、无服务器维护成本。

1.  登录 [Cloudflare Dashboard](https://dash.cloudflare.com/)。
2.  创建一个新的 **Worker**。
3.  复制 `v5.6.1 (Stealth Edition)` 的完整代码粘贴进去。
4.  在 **Settings -> Variables** 中添加环境变量（见下表）。
5.  点击 **Deploy**。

### 🅱️ Deno / Docker 版
> **适用场景**：企业内网、需要固定 IP、VPS 自建、Docker 容器化部署。

**Deno Deploy 部署：**
1.  创建一个新的 Deno 项目。
2.  将 `v5.7.1 (Deno Stealth Edition)` 代码部署为 `main.ts`。
3.  在后台配置环境变量。

**Docker / VPS 部署：**
```bash
# 确保安装了 Deno
deno run --allow-net --allow-env --watch main.ts
# 或者使用 Dockerfile (自行构建环境)
```

---

## 🔑 环境变量配置 (Environment Variables)

支持配置多个 Key，使用 **英文逗号** `,` 或 **换行符** 分隔。

| 变量名 | 说明 | 示例 |
| :--- | :--- | :--- |
| `ACCESS_PASSWORD` | (可选) 网关访问密码，若设置则客户端需在 Key 处填写此密码 | `my_secret_pwd` |
| `OPENAI_API_KEYS` | OpenAI 官方 Key | `sk-xx1,sk-xx2` |
| `CLAUDE_API_KEYS` | Anthropic Claude Key | `sk-ant-xx1` |
| `GEMINI_API_KEYS` | Google Gemini Key | `AIzaS...` |
| `DEEPSEEK_API_KEYS` | DeepSeek 官方 Key | `sk-ds...` |
| `GROQ_API_KEYS` | Groq 加速 Key | `gsk_...` |
| `OPENROUTER_API_KEYS` | OpenRouter 聚合 Key | `sk-or...` |
| `SILICONFLOW_API_KEYS`| 硅基流动 Key | `sk-sf...` |

---

## 🛤️ 路由映射表

网关通过 URL 前缀将请求分发给不同的上游服务。

| 服务商 | 网关路径前缀 | 目标上游 API | 备注 |
| :--- | :--- | :--- | :--- |
| **OpenAI** | `/openai` | `api.openai.com` | 标准接口 |
| **Claude** | `/claude` | `api.anthropic.com` | 自动注入 `x-api-key` |
| **Gemini** | `/gemini` | `generativelanguage.googleapis.com` | 自动修正 `/v1` 为 `/v1beta` |
| **DeepSeek** | `/deepseek`| `api.deepseek.com` | **新增** |
| **Groq** | `/groq` | `api.groq.com/openai` | 兼容 OpenAI 格式 |
| **OpenRouter**| `/openrouter`| `openrouter.ai/api` | 自动注入 Referer/Title |

---

## 📖 客户端设置示例

### 1. 沉浸式翻译 (Immersive Translate) - 最佳实践
此网关针对沉浸式翻译的高并发做了特别优化。

*   **服务商选择**：OpenAI (或你实际使用的模型厂商)
*   **API Key**：
    *   如果设置了 `ACCESS_PASSWORD`，填写该密码。
    *   如果没设置密码，填写你在该厂商的真实 Key (网关会透传)。
    *   *推荐：在 Worker 环境变量配置 Key，此处填写密码，安全且速度快。*
*   **自定义接口地址 (Base URL)**：
    *   OpenAI 模型：`https://你的域名.workers.dev/openai/v1/chat/completions`
    *   DeepSeek 模型：`https://你的域名.workers.dev/deepseek/v1/chat/completions`
    *   Claude 模型：`https://你的域名.workers.dev/claude/v1/messages`
*   **模型 (Model)**：手动输入模型名称（如 `deepseek-chat`, `gpt-4o-mini`）。
*   **并发数设置**：建议设置为 `10` ~ `20` (得益于网关的队列机制，可适当调高)。

### 2. LobeChat / NextWeb
*   **接口代理地址**：`https://你的域名.workers.dev/openai` (注意不带 `/v1`)
*   **API Key**：同上。

---

## ❓ 常见问题

**Q: 访问首页显示 404 Not Found？**
A: 正常的。这是**隐身模式**。为了防止被扫描器识别为 API 网关，根路径故意返回 404。请访问 `/health` 查看存活状态（返回 JSON）。

**Q: 为什么 Deno 版也有 Jitter (抖动)？**
A: 即使 Deno 性能很强，为了防止固定 IP 在直连模式下瞬间发起大量请求被上游封禁，网关刻意加入了 20ms~100ms 的微小延迟。这能显著提高 IP 的存活率。

**Q: 托管模式 vs 直连模式？**
*   **托管模式**：你在环境变量存 Key。客户端只需填密码。支持多 Key 轮询、队列保护、重试。**(推荐)**
*   **直连模式**：你在客户端填真实 Key。网关仅作为隐身管道，透传流量。

---

**Disclaimer**: This project is for educational and research purposes only. Please comply with the terms of service of the upstream API providers.

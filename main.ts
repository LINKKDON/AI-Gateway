/**
 * Universal AI Gateway v5.0 (Final Production Ready)
 * 状态：已通过最终审查
 * 特性：全服务托管、流水线并发、自动重试、智能路径、内存保护
 */

import { serve } from "https://deno.land/std/http/server.ts";

// ================= 1. 全局配置 =================

const ACCESS_PASSWORD = Deno.env.get("ACCESS_PASSWORD") || "";

// 限制配置
const MAX_RETRIES = 2;       // 失败重试次数
const MAX_QUEUE_SIZE = 100;  // 最大排队数 (防止内存溢出)

// 伪装 UA (解决 WAF 拦截，模拟 Chrome)
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// 服务配置表
const services = {
  // --- 🚀 托管并发区 (需配置 Key) ---
  '/cerebras': { target: 'https://api.cerebras.ai', envKey: 'CEREBRAS_API_KEYS', rateLimit: 300 },
  '/groq': { target: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEYS', rateLimit: 200 },
  '/xai': { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS', rateLimit: 200 },

  // --- 🌐 聚合器 ---
  '/openrouter': { target: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEYS', rateLimit: 100 },

  // --- 🇨🇳 硅基流动 (SiliconFlow) ---
  '/siliconflow': {
    target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS', rateLimit: 500 // 普通并发，建议 500ms
  },

  // --- 🤖 主流模型 ---
  '/openai': { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS', rateLimit: 100 },
  '/claude': { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS', rateLimit: 500 },
  '/gemini': { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS', rateLimit: 200 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// ================= 2. 服务管理器 =================

interface QueueTask {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  resolve: (res: Response) => void;
  retryCount: number;
}

class ServiceManager {
  prefix: string;
  config: any;
  keys: string[] = [];
  keyIndex = 0;
  queue: QueueTask[] = [];
  isProcessing = false;

  constructor(prefix: string, config: any) {
    this.prefix = prefix;
    this.config = config;
    // 初始化 Key 池
    if (config.envKey) {
      const envStr = Deno.env.get(config.envKey);
      if (envStr) {
        this.keys = envStr.split(',').map(k => k.trim()).filter(k => k);
        console.log(`[Init] ${prefix}: Loaded ${this.keys.length} keys.`);
      }
    }
  }

  // 核心调度器 (流水线模式)
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift()!;

      // 🛡️ 异步发射异常兜底 (防止个别请求崩溃卡死队列)
      this.runFetchWithRetry(task).catch(err => {
        console.error(`[Fatal Async Error] ${this.prefix}:`, err);
      });

      // 冷却等待 (Rate Limit)
      if (this.queue.length > 0 && this.config.rateLimit > 0) {
        await new Promise(r => setTimeout(r, this.config.rateLimit));
      }
    }
    this.isProcessing = false;
  }

  getNextKey(): string {
    if (this.keys.length === 0) return "";
    const key = this.keys[this.keyIndex];
    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    return key;
  }

  async runFetchWithRetry(task: QueueTask) {
    const apiKey = this.getNextKey();

    try {
      const headers = new Headers(task.headers);
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", BROWSER_UA);

      // OpenRouter 特殊 Header (提升兼容性)
      if (this.prefix === '/openrouter') {
        headers.set("HTTP-Referer", "https://deno-gateway.com");
        headers.set("X-Title", "AI Gateway");
      }

      const res = await fetch(task.url, {
        method: task.method,
        headers: headers,
        body: task.body,
      });

      // ♻️ 自动重试逻辑 (针对 5xx 服务器错误 或 429 限流)
      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        console.warn(`[Retry] ${this.prefix} ${res.status}. Retrying... (${task.retryCount + 1}/${MAX_RETRIES})`);
        task.retryCount++;
        await new Promise(r => setTimeout(r, 200)); // 避让 200ms
        return this.runFetchWithRetry(task); // 递归重试
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      task.resolve(new Response(res.body, { status: res.status, headers: newHeaders }));

    } catch (e) {
      // 网络层面错误 (如连接超时) 也可以重试
      if (task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 200));
        return this.runFetchWithRetry(task);
      }
      console.error(`[Error] ${this.prefix}:`, e);
      task.resolve(new Response(JSON.stringify({ error: `Proxy Error: ${e.message}` }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }));
    }
  }
}

const managers: Record<string, ServiceManager> = {};
for (const [k, v] of Object.entries(services)) {
  managers[k] = new ServiceManager(k, v);
}

// ================= 3. 请求处理主入口 =================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  // CORS 预检
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
  // 首页状态检查
  if (url.pathname === "/" || url.pathname === "/index.html") return new Response("AI Gateway v5.0 Running.", { headers: CORS_HEADERS });

  // 路由匹配
  const prefix = Object.keys(managers).find(p => url.pathname.startsWith(p));
  if (!prefix) return new Response("Not Found: Unknown Service Prefix", { status: 404, headers: CORS_HEADERS });

  const manager = managers[prefix];
  let upstreamPath = url.pathname.substring(prefix.length);

  // ✅ 1. 智能路径补全 (针对只填 Base URL 的情况)
  if (upstreamPath === "" || upstreamPath === "/") {
    if (prefix === '/claude') upstreamPath = "/v1/messages";
    else if (prefix === '/gemini') upstreamPath = "/v1beta/openai/chat/completions";
    else upstreamPath = "/v1/chat/completions"; // 默认 OpenAI 格式
  }

  // ✅ 2. Gemini 专属路径修正
  if (prefix === '/gemini' && upstreamPath.startsWith('/v1/')) {
    upstreamPath = upstreamPath.replace('/v1/', '/v1beta/openai/');
  }

  // ✅ 3. URL 深度清洗 (关键修复)
  // 去除多余双斜杠 (// -> /)
  upstreamPath = upstreamPath.replace(/\/+/g, "/");
  // 去除尾部斜杠 (cerebras/ -> cerebras)，防止 405 错误
  if (upstreamPath.length > 1 && upstreamPath.endsWith('/')) {
    upstreamPath = upstreamPath.slice(0, -1);
  }

  // 拼接最终 URL
  const targetUrl = manager.config.target + upstreamPath + url.search;

  // 提取 Header
  const clientHeaders = new Headers();
  let clientToken = "";
  const denied = ["host", "referer", "cf-", "forwarded", "user-agent"];
  for (const [k, v] of req.headers.entries()) {
    if (!denied.some(d => k.toLowerCase().includes(d))) clientHeaders.set(k, v);
    if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
  }

  // 判断是否启用托管模式
  const hasKeys = manager.keys.length > 0;
  const isAuth = !ACCESS_PASSWORD || clientToken === ACCESS_PASSWORD;

  if (hasKeys && isAuth) {
    // === 托管模式 (使用服务器 Key + 队列) ===
    if (req.method === "POST") {
      // 🛡️ 内存保护
      if (manager.queue.length >= MAX_QUEUE_SIZE) {
        return new Response(JSON.stringify({ error: "Server Busy (Queue Full)" }), { status: 503, headers: CORS_HEADERS });
      }

      try {
        const bodyText = await req.text();
        return new Promise((resolve) => {
          manager.queue.push({
            url: targetUrl,
            method: "POST",
            headers: clientHeaders,
            body: bodyText,
            resolve,
            retryCount: 0
          });
          manager.processQueue();
        });
      } catch (e) {
        return new Response("Body Read Error", { status: 400 });
      }
    } else {
      // GET 请求 (如 models 列表)，直接换 Key 转发
      const apiKey = manager.getNextKey();
      clientHeaders.set("Authorization", `Bearer ${apiKey}`);
    }
  }

  // === 透明模式 / 直连 ===
  try {
    clientHeaders.set("User-Agent", BROWSER_UA);
    // 透明模式也加上 OpenRouter 优化
    if (prefix === '/openrouter') {
      clientHeaders.set("HTTP-Referer", "https://deno-gateway.com");
      clientHeaders.set("X-Title", "AI Gateway");
    }

    const res = await fetch(targetUrl, { method: req.method, headers: clientHeaders, body: req.body });
    const newHeaders = new Headers(res.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
    return new Response(res.body, { status: res.status, headers: newHeaders });
  } catch (e) {
    return new Response(`Upstream Error: ${e.message}`, { status: 502, headers: CORS_HEADERS });
  }
}

if (typeof Deno.serve === "function") Deno.serve(handleRequest);
else serve(handleRequest);

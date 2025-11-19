/**
 * Universal AI Gateway v5.2 (Cloudflare Final Edition)
 * 平台：Cloudflare Workers
 * 特性：全局随机抖动(Global Jitter)、智能退避、流水线并发、全服务支持
 */

// ================= 1. 全局配置 =================

const MAX_RETRIES = 2;       // 自动重试次数
const MAX_QUEUE_SIZE = 100;  // 队列保护
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// 服务配置表
const servicesConfig = {
  // 🚀 托管并发区
  '/cerebras':   { target: 'https://api.cerebras.ai', envKey: 'CEREBRAS_API_KEYS', rateLimit: 300 },
  '/groq':       { target: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEYS', rateLimit: 200 },
  '/xai':        { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS', rateLimit: 200 },
  
  // 🌐 聚合器
  '/openrouter': { target: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEYS', rateLimit: 100 },
  '/siliconflow':{ target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS', rateLimit: 500 },

  // 🤖 主流模型
  '/openai':     { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS', rateLimit: 100 },
  '/claude':     { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS', rateLimit: 500 },
  '/gemini':     { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS', rateLimit: 200 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// ================= 2. 服务逻辑 =================

// 全局状态 (在热启动的 Worker 中保持，用于简单的队列管理)
const GLOBAL_STATE = { managers: {} };

class ServiceManager {
  constructor(prefix, config) {
    this.prefix = prefix;
    this.config = config;
    this.keys = [];
    this.keyIndex = 0;
    this.queue = [];
    this.isProcessing = false;
    this.initialized = false;
  }

  // 懒加载 Key
  initKeys(env) {
    if (this.initialized) return;
    if (this.config.envKey && env[this.config.envKey]) {
      this.keys = env[this.config.envKey].split(',').map(k => k.trim()).filter(k => k);
    }
    this.initialized = true;
  }

  getNextKey() {
    if (this.keys.length === 0) return "";
    const key = this.keys[this.keyIndex];
    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    return key;
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      // 异步发射，错误兜底
      this.runFetchWithRetry(task).catch(err => console.error(err));

      // 速率限制 (平滑单个 Worker 的流量)
      if (this.queue.length > 0 && this.config.rateLimit > 0) {
        await new Promise(r => setTimeout(r, this.config.rateLimit));
      }
    }
    this.isProcessing = false;
  }

  async runFetchWithRetry(task) {
    const apiKey = this.getNextKey();
    
    try {
      // 🛡️ Jitter: 随机抖动 50ms ~ 300ms
      // 核心防封逻辑：防止 CF 多实例并发瞬间击穿上游限流
      const jitter = Math.floor(Math.random() * 250) + 50;
      await new Promise(r => setTimeout(r, jitter));

      const headers = new Headers(task.headers);
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", BROWSER_UA);

      // OpenRouter 兼容头
      if (this.prefix === '/openrouter') {
        headers.set("HTTP-Referer", "https://cf-gateway.com");
        headers.set("X-Title", "AI Gateway");
      }

      const res = await fetch(task.url, {
        method: task.method,
        headers: headers,
        body: task.body,
      });

      // ♻️ 智能退避重试 (针对 429/5xx)
      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        // 第一次失败等 1秒，第二次等 2秒
        const waitTime = 1000 * task.retryCount; 
        console.log(`[Retry] ${this.prefix} hit ${res.status}, waiting ${waitTime}ms`);
        await new Promise(r => setTimeout(r, waitTime));
        return this.runFetchWithRetry(task);
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      task.resolve(new Response(res.body, { status: res.status, headers: newHeaders }));

    } catch (e) {
      if (task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 1000));
        return this.runFetchWithRetry(task);
      }
      task.resolve(new Response(JSON.stringify({ error: `Proxy Error: ${e.message}` }), { 
        status: 502, 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      }));
    }
  }
}

// 单例模式获取 Manager
function getManager(prefix) {
  if (!GLOBAL_STATE.managers[prefix]) {
    GLOBAL_STATE.managers[prefix] = new ServiceManager(prefix, servicesConfig[prefix]);
  }
  return GLOBAL_STATE.managers[prefix];
}

// ================= 3. Worker 入口 =================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS 预检
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });
    // 首页
    if (url.pathname === "/" || url.pathname === "/index.html") return new Response("CF AI Gateway v5.2 Running.", { headers: CORS_HEADERS });

    // 路由匹配
    const prefix = Object.keys(servicesConfig).find(p => url.pathname.startsWith(p));
    if (!prefix) return new Response("Not Found: Unknown Service", { status: 404, headers: CORS_HEADERS });

    const manager = getManager(prefix);
    manager.initKeys(env);

    // 路径处理
    let upstreamPath = url.pathname.substring(prefix.length);
    // 1. 智能补全
    if (upstreamPath === "" || upstreamPath === "/") {
      if (prefix === '/claude') upstreamPath = "/v1/messages";
      else if (prefix === '/gemini') upstreamPath = "/v1beta/openai/chat/completions";
      else upstreamPath = "/v1/chat/completions";
    }
    // 2. Gemini 修正
    if (prefix === '/gemini' && upstreamPath.startsWith('/v1/')) upstreamPath = upstreamPath.replace('/v1/', '/v1beta/openai/');
    // 3. 清洗双斜杠和尾部斜杠
    upstreamPath = upstreamPath.replace(/\/+/g, "/");
    if (upstreamPath.length > 1 && upstreamPath.endsWith('/')) upstreamPath = upstreamPath.slice(0, -1);

    const targetUrl = manager.config.target + upstreamPath + url.search;

    // Header 提取
    const clientHeaders = new Headers();
    let clientToken = "";
    const denied = ["host", "referer", "cf-", "forwarded", "user-agent", "x-forwarded-proto"];
    for (const [k, v] of request.headers.entries()) {
      if (!denied.some(d => k.toLowerCase().includes(d))) clientHeaders.set(k, v);
      if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
    }

    const ACCESS_PASSWORD = env.ACCESS_PASSWORD || "";
    const hasKeys = manager.keys.length > 0;
    const isAuth = !ACCESS_PASSWORD || clientToken === ACCESS_PASSWORD;

    // === 托管模式 ===
    if (hasKeys && isAuth) {
      if (request.method === "POST") {
        if (manager.queue.length >= MAX_QUEUE_SIZE) {
          return new Response(JSON.stringify({ error: "Server Busy" }), { status: 503, headers: CORS_HEADERS });
        }
        try {
          const bodyText = await request.text();
          return new Promise((resolve) => {
            manager.queue.push({
              url: targetUrl,
              method: "POST",
              headers: clientHeaders,
              body: bodyText,
              resolve,
              retryCount: 0
            });
            // 触发处理
            manager.processQueue();
          });
        } catch (e) {
          return new Response("Body Read Error", { status: 400 });
        }
      } else {
        // GET 轮询
        const apiKey = manager.getNextKey();
        clientHeaders.set("Authorization", `Bearer ${apiKey}`);
      }
    }

    // === 透明/直连模式 ===
    try {
      // 🛡️ 直连模式也要加 Jitter！保护用户私有 Key
      const jitter = Math.floor(Math.random() * 200) + 20;
      await new Promise(r => setTimeout(r, jitter));

      clientHeaders.set("User-Agent", BROWSER_UA);
      if (prefix === '/openrouter') {
        clientHeaders.set("HTTP-Referer", "https://cf-gateway.com");
        clientHeaders.set("X-Title", "AI Gateway");
      }
      
      const res = await fetch(targetUrl, {
        method: request.method,
        headers: clientHeaders,
        body: request.body
      });
      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      return new Response(res.body, { status: res.status, headers: newHeaders });
    } catch (e) {
      return new Response(`Upstream Error: ${e.message}`, { status: 502, headers: CORS_HEADERS });
    }
  }
};

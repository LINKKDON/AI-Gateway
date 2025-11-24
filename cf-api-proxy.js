/**
 * Universal AI Gateway v5.6.2 (Nginx Stealth Edition)
 * 平台：Cloudflare Workers
 * 适配：沉浸式翻译 (Immersive Translate) / LobeChat / NextWeb
 * 更新：根路径伪装成Nginx、DeepSeek支持、Gemini修复
 */

// ================= 1. 全局配置 =================

const MAX_RETRIES = 2;        // 故障重试次数
const MAX_QUEUE_SIZE = 200;   // 队列缓冲大小
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// 服务配置表
const servicesConfig = {
  // 🚀 托管并发区
  '/cerebras':   { target: 'https://api.cerebras.ai', envKey: 'CEREBRAS_API_KEYS', rateLimit: 200 },
  '/groq':       { target: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEYS', rateLimit: 200 },
  '/xai':        { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS', rateLimit: 200 },
  '/deepseek':   { target: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEYS', rateLimit: 200 },

  // 🌐 聚合器
  '/openrouter': { target: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEYS', rateLimit: 200 },
  '/siliconflow':{ target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS', rateLimit: 500 },
  '/ollama':     { target: 'https://ollama.com', envKey: 'OLLAMA_API_KEYS', rateLimit: 200 },

  // 🤖 主流模型
  '/openai':     { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS', rateLimit: 100 },
  '/claude':     { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS', rateLimit: 500 },
  '/gemini':     { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS', rateLimit: 200 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// ================= 2. 核心服务逻辑 =================

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

  initKeys(env) {
    if (this.initialized) return;
    if (this.config.envKey && env[this.config.envKey]) {
      this.keys = env[this.config.envKey].split(/[\n,]+/).map(k => k.trim()).filter(k => k);
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
      this.runFetchWithRetry(task).catch(err => console.error(`[Task Error] ${err}`));
      if (this.queue.length > 0 && this.config.rateLimit > 0) {
        await new Promise(r => setTimeout(r, this.config.rateLimit));
      }
    }
    this.isProcessing = false;
  }

  async runFetchWithRetry(task) {
    const apiKey = this.getNextKey();
    try {
      const jitter = Math.floor(Math.random() * 100) + 20;
      await new Promise(r => setTimeout(r, jitter));

      const headers = new Headers(task.headers);
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", BROWSER_UA);

      if (this.prefix === '/openrouter') {
        headers.set("HTTP-Referer", "https://github.com"); 
        headers.set("X-Title", "AI-Gateway");
      }

      const res = await fetch(task.url, {
        method: task.method,
        headers: headers,
        body: task.body,
      });

      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        const waitTime = 1000 * Math.pow(2, task.retryCount - 1);
        await new Promise(r => setTimeout(r, waitTime));
        return this.runFetchWithRetry(task);
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");
      task.resolve(new Response(res.body, { status: res.status, headers: newHeaders }));
    } catch (e) {
      if (task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 1000));
        return this.runFetchWithRetry(task);
      }
      task.resolve(new Response(JSON.stringify({ error: { message: `Gateway Error: ${e.message}` } }), { 
        status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      }));
    }
  }
}

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

    // 1. 预检
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    // 2. 🕵️ 隐身模式：伪装成 Nginx 默认欢迎页 (Status 200)
    if (url.pathname === "/") {
      const nginxHtml = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
html { color-scheme: light dark; }
body { width: 35em; margin: 0 auto;
font-family: Tahoma, Verdana, Arial, sans-serif; }
</style>
</head>
<body>
<h1>Welcome to nginx!</h1>
<p>If you see this page, the nginx web server is successfully installed and
working. Further configuration is required.</p>
<p>For online documentation and support please refer to
<a href="http://nginx.org/">nginx.org</a>.<br/>
Commercial support is available at
<a href="http://nginx.com/">nginx.com</a>.</p>
<p><em>Thank you for using nginx.</em></p>
</body>
</html>`;
      return new Response(nginxHtml, { 
        status: 200, 
        headers: { "Content-Type": "text/html; charset=UTF-8" } 
      });
    }

    // 健康检查 (低调版)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "alive", region: request.cf?.colo }), { 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      });
    }

    // 3. 路由匹配
    const sortedPrefixes = Object.keys(servicesConfig).sort((a, b) => b.length - a.length);
    const prefix = sortedPrefixes.find(p => url.pathname.startsWith(p));
    if (!prefix) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: CORS_HEADERS });

    const manager = getManager(prefix);
    manager.initKeys(env);

    // 4. 路径处理
    let upstreamPath = url.pathname.substring(prefix.length);
    if (upstreamPath === "" || upstreamPath === "/") {
      if (prefix === '/claude') upstreamPath = "/v1/messages";
      else if (prefix === '/gemini') upstreamPath = "/v1beta/openai/chat/completions";
      else upstreamPath = "/v1/chat/completions";
    }
    upstreamPath = upstreamPath.replace(/\/+/g, "/");
    if (upstreamPath.length > 1 && upstreamPath.endsWith('/')) upstreamPath = upstreamPath.slice(0, -1);

    if (prefix === '/gemini') {
      if (upstreamPath.startsWith('/v1/')) upstreamPath = upstreamPath.replace('/v1/', '/v1beta/openai/');
      else if (upstreamPath.startsWith('/chat/completions')) upstreamPath = '/v1beta/openai' + upstreamPath;
    }

    const safeTarget = manager.config.target.replace(/\/+$/, "");
    const targetUrl = safeTarget + upstreamPath + url.search;

    // 5. Header 清洗
    const clientHeaders = new Headers();
    const deniedHeaders = ["host", "origin", "referer", "cf-", "x-forwarded-proto", "forwarded", "via"];
    let clientToken = "";
    for (const [k, v] of request.headers.entries()) {
      if (!deniedHeaders.some(d => k.toLowerCase().includes(d))) clientHeaders.set(k, v);
      if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
    }

    // 6. 鉴权与处理
    const ACCESS_PASSWORD = env.ACCESS_PASSWORD || "";
    const hasKeys = manager.keys.length > 0;
    const isAuth = !ACCESS_PASSWORD || clientToken === ACCESS_PASSWORD;

    if (hasKeys && isAuth) {
      if (request.method === "POST") {
        if (manager.queue.length >= MAX_QUEUE_SIZE) return new Response(JSON.stringify({ error: "Gateway Overloaded" }), { status: 429, headers: CORS_HEADERS });
        try {
          const bodyText = await request.text();
          return new Promise((resolve) => {
            manager.queue.push({ url: targetUrl, method: "POST", headers: clientHeaders, body: bodyText, resolve, retryCount: 0 });
            manager.processQueue();
          });
        } catch (e) { return new Response("Request Body Error", { status: 400, headers: CORS_HEADERS }); }
      } else {
        const apiKey = manager.getNextKey();
        clientHeaders.set("Authorization", `Bearer ${apiKey}`);
      }
    }

    try {
      const jitter = Math.floor(Math.random() * 100) + 20;
      await new Promise(r => setTimeout(r, jitter));
      clientHeaders.set("User-Agent", BROWSER_UA);
      if (prefix === '/openrouter') {
        if (!clientHeaders.has("HTTP-Referer")) clientHeaders.set("HTTP-Referer", "https://github.com");
        if (!clientHeaders.has("X-Title")) clientHeaders.set("X-Title", "AI-Gateway");
      }
      const res = await fetch(targetUrl, { method: request.method, headers: clientHeaders, body: request.body });
      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");
      return new Response(res.body, { status: res.status, headers: newHeaders });
    } catch (e) {
      return new Response(JSON.stringify({ error: `Upstream Error: ${e.message}` }), { status: 502, headers: CORS_HEADERS });
    }
  }
};

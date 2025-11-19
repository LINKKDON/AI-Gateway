/**
 * Universal AI Gateway v5.0 (Cloudflare Workers Edition)
 * 适配平台：Cloudflare Workers
 * 特性：全服务托管、流水线并发、自动重试、智能路径、内存保护
 */

// 全局配置常量
const MAX_RETRIES = 2;
const MAX_QUEUE_SIZE = 100;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// 服务配置
const servicesConfig = {
  '/cerebras': { target: 'https://api.cerebras.ai', envKey: 'CEREBRAS_API_KEYS', rateLimit: 300 },
  '/groq':     { target: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEYS', rateLimit: 200 },
  '/xai':      { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS', rateLimit: 200 },
  '/openrouter': { target: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEYS', rateLimit: 100 },
  '/siliconflow': { target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS', rateLimit: 500 },
  '/openai':   { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS', rateLimit: 100 },
  '/claude':   { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS', rateLimit: 500 },
  '/gemini':   { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS', rateLimit: 200 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
};

// ================= 核心逻辑 =================

// 全局状态存储 (在 Worker 热活期间保留)
// 注意：CF Worker 可能会随时重置全局变量，这对于队列来说是可以接受的（最坏情况是丢失少量排队请求或重置轮询顺序）
const GLOBAL_STATE = {
  managers: {} 
};

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

  // 懒加载 Key (因为 CF 只有在请求进来时才能读取 env)
  initKeys(env) {
    if (this.initialized) return;
    if (this.config.envKey && env[this.config.envKey]) {
      this.keys = env[this.config.envKey].split(',').map(k => k.trim()).filter(k => k);
      // console.log(`[Init] ${this.prefix}: Loaded ${this.keys.length} keys.`);
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

      // Rate Limit 等待
      if (this.queue.length > 0 && this.config.rateLimit > 0) {
        await new Promise(r => setTimeout(r, this.config.rateLimit));
      }
    }
    this.isProcessing = false;
  }

  async runFetchWithRetry(task) {
    const apiKey = this.getNextKey();
    
    try {
      const headers = new Headers(task.headers);
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", BROWSER_UA);

      if (this.prefix === '/openrouter') {
        headers.set("HTTP-Referer", "https://cf-gateway.com");
        headers.set("X-Title", "AI Gateway");
      }

      const res = await fetch(task.url, {
        method: task.method,
        headers: headers,
        body: task.body,
      });

      // 自动重试
      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 200));
        return this.runFetchWithRetry(task);
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      task.resolve(new Response(res.body, { status: res.status, headers: newHeaders }));

    } catch (e) {
      if (task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 200));
        return this.runFetchWithRetry(task);
      }
      task.resolve(new Response(JSON.stringify({ error: `Proxy Error: ${e.message}` }), { 
        status: 502, 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      }));
    }
  }
}

// 初始化 Managers (单例模式)
function getManager(prefix) {
  if (!GLOBAL_STATE.managers[prefix]) {
    GLOBAL_STATE.managers[prefix] = new ServiceManager(prefix, servicesConfig[prefix]);
  }
  return GLOBAL_STATE.managers[prefix];
}

// ================= Cloudflare Worker 入口 =================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // CORS Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // Home
    if (url.pathname === "/" || url.pathname === "/index.html") {
      return new Response("Cloudflare AI Gateway v5.0 Running.", { headers: CORS_HEADERS });
    }

    // 路由匹配
    const prefix = Object.keys(servicesConfig).find(p => url.pathname.startsWith(p));
    if (!prefix) {
      return new Response("Not Found: Unknown Service Prefix", { status: 404, headers: CORS_HEADERS });
    }

    // 获取 Manager 并初始化 Key (传入 env)
    const manager = getManager(prefix);
    manager.initKeys(env);

    // 路径处理
    let upstreamPath = url.pathname.substring(prefix.length);
    if (upstreamPath === "" || upstreamPath === "/") {
      if (prefix === '/claude') upstreamPath = "/v1/messages";
      else if (prefix === '/gemini') upstreamPath = "/v1beta/openai/chat/completions";
      else upstreamPath = "/v1/chat/completions";
    }
    if (prefix === '/gemini' && upstreamPath.startsWith('/v1/')) {
      upstreamPath = upstreamPath.replace('/v1/', '/v1beta/openai/');
    }
    upstreamPath = upstreamPath.replace(/\/+/g, "/");
    if (upstreamPath.length > 1 && upstreamPath.endsWith('/')) {
      upstreamPath = upstreamPath.slice(0, -1);
    }

    const targetUrl = manager.config.target + upstreamPath + url.search;

    // Header 处理
    const clientHeaders = new Headers();
    let clientToken = "";
    const denied = ["host", "referer", "cf-", "forwarded", "user-agent", "x-forwarded-proto"];
    for (const [k, v] of request.headers.entries()) {
      if (!denied.some(d => k.toLowerCase().includes(d))) clientHeaders.set(k, v);
      if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
    }

    // 鉴权与模式选择
    const ACCESS_PASSWORD = env.ACCESS_PASSWORD || "";
    const hasKeys = manager.keys.length > 0;
    const isAuth = !ACCESS_PASSWORD || clientToken === ACCESS_PASSWORD;

    if (hasKeys && isAuth) {
      // 托管模式
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
            // 触发处理 (不使用 await，让 Worker 继续运行)
            // 注意：在 CF 中，最好使用 ctx.waitUntil 来保证异步任务完成，
            // 但这里的逻辑是基于 Promise resolve 的，主线程会等待 response 返回，所以没问题。
            manager.processQueue();
          });
        } catch (e) {
          return new Response("Body Error", { status: 400 });
        }
      } else {
        // GET
        const apiKey = manager.getNextKey();
        clientHeaders.set("Authorization", `Bearer ${apiKey}`);
      }
    }

    // 直连模式
    try {
      clientHeaders.set("User-Agent", BROWSER_UA);
      if (prefix === '/openrouter') {
        clientHeaders.set("HTTP-Referer", "https://cf-gateway.com");
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

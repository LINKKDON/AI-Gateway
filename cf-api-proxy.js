/**
 * Universal AI Gateway v5.9.5 (CF Workers Strict Fixed Edition)
 * 平台：Cloudflare Workers
 * 修复：解决 "ReadableStream is disturbed" 错误
 * 原理：将 Body 转存为 ArrayBuffer 以支持失败重试
 */

// ================= 1. 全局配置 =================

const MAX_RETRIES = 2;       
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// Nginx 伪装页面
const NGINX_HTML = `<!DOCTYPE html>
<html>
<head>
<title>Welcome to nginx!</title>
<style>
    body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }
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

// 服务配置表
const servicesConfig = {
  '/cerebras':   { target: 'https://api.cerebras.ai', envKey: 'CEREBRAS_API_KEYS' },
  '/groq':       { target: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEYS' },
  '/xai':        { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS' },
  '/deepseek':   { target: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEYS' },
  '/openrouter': { target: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEYS' },
  '/siliconflow':{ target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS' },
  '/ollama':     { target: 'https://ollama.com', envKey: 'OLLAMA_API_KEYS' },
  '/openai':     { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS' },
  '/claude':     { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS' },
  '/gemini':     { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS' },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// ================= 2. 核心服务逻辑 =================

const GLOBAL_CACHE = { managers: {} };

class ServiceManager {
  constructor(prefix, config) {
    this.prefix = prefix;
    this.config = config;
    this.keys = [];
    this.initialized = false;
  }

  initKeys(env) {
    if (this.initialized) return;
    if (this.config.envKey && env[this.config.envKey]) {
      this.keys = env[this.config.envKey].split(/[\n,]+/).map(k => k.trim()).filter(k => k);
    }
    this.initialized = true;
  }

  getKey() {
    if (this.keys.length === 0) return null;
    return this.keys[Math.floor(Math.random() * this.keys.length)];
  }

  async fetchWithRetry(url, method, headers, body, retryCount = 0) {
    const apiKey = this.getKey();
    const reqHeaders = new Headers(headers);
    
    // 保护 Multipart Boundary
    if (!reqHeaders.has("Content-Type")) {
        reqHeaders.set("Content-Type", "application/json");
    }
    
    reqHeaders.set("User-Agent", BROWSER_UA);

    if (apiKey) {
        if (this.prefix === '/claude') {
            reqHeaders.set("x-api-key", apiKey);
            reqHeaders.set("anthropic-version", "2023-06-01");
        } else {
            reqHeaders.set("Authorization", `Bearer ${apiKey}`);
        }
    }

    if (this.prefix === '/openrouter') {
      reqHeaders.set("HTTP-Referer", "https://github.com"); 
      reqHeaders.set("X-Title", "Universal-Gateway");
    }

    try {
      const jitter = Math.floor(Math.random() * 50) + 10;
      if (retryCount > 0) await new Promise(r => setTimeout(r, jitter));

      const res = await fetch(url, {
        method: method,
        headers: reqHeaders,
        body: body, // 这里现在传入的是 ArrayBuffer，可以重复使用
      });

      if ((res.status === 429 || res.status >= 500) && retryCount < MAX_RETRIES) {
        const nextRetry = retryCount + 1;
        const waitTime = 1000 * Math.pow(2, nextRetry - 1);
        await new Promise(r => setTimeout(r, waitTime));
        return this.fetchWithRetry(url, method, headers, body, nextRetry);
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");

      return new Response(res.body, { status: res.status, headers: newHeaders });

    } catch (e) {
      if (retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 1000));
        return this.fetchWithRetry(url, method, headers, body, retryCount + 1);
      }
      return new Response(JSON.stringify({ 
        error: { message: `Gateway Error: ${e.message}`, type: "gateway_error", code: 502 } 
      }), { 
        status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      });
    }
  }
}

function getManager(prefix) {
  if (!GLOBAL_CACHE.managers[prefix]) {
    GLOBAL_CACHE.managers[prefix] = new ServiceManager(prefix, servicesConfig[prefix]);
  }
  return GLOBAL_CACHE.managers[prefix];
}

// ================= 3. Worker 主入口 =================

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 1. 预检
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    // 2. 伪装
    if (url.pathname === "/" || request.method === "GET") {
      return new Response(NGINX_HTML, { 
        status: 200, 
        headers: { 
            "Content-Type": "text/html; charset=UTF-8",
            "Server": "nginx/1.18.0",
            "Connection": "keep-alive"
        } 
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
      if (k.toLowerCase() === "x-api-key" && !clientToken) clientToken = v.trim(); 
    }

    // 6. 鉴权
    const ACCESS_PASSWORD = env.ACCESS_PASSWORD || "linus"; 
    const isAuth = clientToken === ACCESS_PASSWORD;
    if (!isAuth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS_HEADERS });

    // 7. 配置检查
    if (manager.keys.length === 0) {
        return new Response(JSON.stringify({ error: `Service Not Configured: No keys found for ${prefix}` }), { 
          status: 501, 
          headers: CORS_HEADERS 
        });
    }

    // 8. ✅ 关键修改：读取为 ArrayBuffer，解决流不可复用问题
    let body = null;
    if (request.method === "POST" || request.method === "PUT") {
        try {
            // 将流转换为内存中的 Buffer，这样 fetchWithRetry 可以多次使用它
            body = await request.arrayBuffer();
        } catch (e) {
            return new Response("Error reading request body", { status: 400 });
        }
    }

    // 9. 转发请求
    return manager.fetchWithRetry(targetUrl, request.method, clientHeaders, body);
  }
};

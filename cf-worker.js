/**
 * Universal AI Gateway v5.9.18 (CF Workers Transparency Edition)
 * 平台：Cloudflare Workers
 * 策略：Hash 锁定 + 极速切号
 * 修复：
 * 1. 协议修复：不再删除 content-encoding，防止解压失败
 * 2. 主动喊话：请求时带上 Accept-Encoding: identity
 */

// ================= 1. 全局配置 =================

const MAX_RETRIES = 3; 
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

const NGINX_HTML = `<!DOCTYPE html><html><head><title>Welcome to nginx!</title><style>body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }</style></head><body><h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p><p>For online documentation and support please refer to<a href="http://nginx.org/">nginx.org</a>.<br/>Commercial support is available at<a href="http://nginx.com/">nginx.com</a>.</p><p><em>Thank you for using nginx.</em></p></body></html>`;

// ✅ 你的 Cloudflare Gateway 地址
const servicesConfig = {
  '/cerebras':   { target: 'https://gateway.ai.cloudflare.com/v1/00750af78aa126346f99afa4c68a4329/gpt-load/cerebras', envKey: 'CEREBRAS_API_KEYS' },
  '/groq':       { target: 'https://gateway.ai.cloudflare.com/v1/00750af78aa126346f99afa4c68a4329/gpt-load/groq', envKey: 'GROQ_API_KEYS' },
  '/openrouter': { target: 'https://gateway.ai.cloudflare.com/v1/00750af78aa126346f99afa4c68a4329/gpt-load/openrouter', envKey: 'OPENROUTER_API_KEYS' },
  
  // 其他服务
  '/deepseek':   { target: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEYS' },
  '/claude':     { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS' },
  '/openai':     { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS' },
  '/ollama':     { target: 'https://ollama.com', envKey: 'OLLAMA_API_KEYS' },
  '/gemini':     { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS' },
  '/siliconflow':{ target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS' },
  '/xai':        { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS' },
  '/nvidia':     { target: 'https://integrate.api.nvidia.com', envKey: 'NVIDIA_API_KEYS' },
  '/pollinations': { target: 'https://gen.pollinations.ai', envKey: 'POLLINATIONS_API_KEYS' },
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

  getKey(bodyBuffer, retryCount = 0) {
    if (this.keys.length === 0) return null;
    
    let baseIndex = 0;
    if (bodyBuffer && bodyBuffer.byteLength > 0) {
        const firstByte = new Uint8Array(bodyBuffer)[0] || 0;
        baseIndex = bodyBuffer.byteLength + firstByte;
    } else {
        baseIndex = Date.now();
    }

    const finalIndex = (baseIndex + retryCount) % this.keys.length;
    return this.keys[finalIndex];
  }

  async fetchWithRetry(url, method, headers, body, retryCount = 0) {
    const apiKey = this.getKey(body, retryCount);
    
    const reqHeaders = new Headers(headers);
    if (!reqHeaders.has("Content-Type")) reqHeaders.set("Content-Type", "application/json");
    reqHeaders.set("User-Agent", BROWSER_UA);
    
    // ✅ 主动喊话：尝试要明文，减少编解码开销
    reqHeaders.set("Accept-Encoding", "identity");

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
      const res = await fetch(url, {
        method: method,
        headers: reqHeaders,
        body: body,
      });

      if ((res.status === 429 || res.status >= 500) && retryCount < MAX_RETRIES) {
        // 资源回收
        if (res.body) {
            try { await res.body.cancel(); } catch (e) {}
        }
        
        const safeDelay = 100 + Math.floor(Math.random() * 200); 
        await new Promise(r => setTimeout(r, safeDelay));

        return this.fetchWithRetry(url, method, headers, body, retryCount + 1);
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      
      // 🛑 修正：保留 Content-Encoding，防止客户端解析失败
      // newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");

      return new Response(res.body, { status: res.status, headers: newHeaders });

    } catch (e) {
      if (retryCount < MAX_RETRIES) {
        await new Promise(r => setTimeout(r, 300));
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

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

    if (url.pathname === "/") {
      return new Response(NGINX_HTML, { 
        status: 200, 
        headers: { "Content-Type": "text/html; charset=UTF-8", "Server": "nginx/1.18.0", "Connection": "keep-alive" } 
      });
    }

    const sortedPrefixes = Object.keys(servicesConfig).sort((a, b) => b.length - a.length);
    const prefix = sortedPrefixes.find(p => url.pathname.startsWith(p));
    if (!prefix) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: CORS_HEADERS });

    const manager = getManager(prefix);
    manager.initKeys(env); 

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

    const clientHeaders = new Headers();
    const deniedHeaders = ["host", "origin", "referer", "cf-", "x-forwarded-proto", "forwarded", "via"];
    let clientToken = "";

    for (const [k, v] of request.headers.entries()) {
      if (!deniedHeaders.some(d => k.toLowerCase().includes(d))) clientHeaders.set(k, v);
      if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
      if (k.toLowerCase() === "x-api-key" && !clientToken) clientToken = v.trim(); 
    }

    const ACCESS_PASSWORD = env.ACCESS_PASSWORD || "linus"; 
    const isAuth = clientToken === ACCESS_PASSWORD;
    if (!isAuth) return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS_HEADERS });

    if (manager.keys.length === 0) {
        return new Response(JSON.stringify({ error: `Service Not Configured: No keys found for ${prefix}` }), { status: 501, headers: CORS_HEADERS });
    }

    let body = null;
    if (request.method !== "GET" && request.method !== "HEAD") {
        try {
            body = await request.arrayBuffer();
        } catch (e) {
            return new Response("Error reading request body", { status: 400 });
        }
    }

    return manager.fetchWithRetry(targetUrl, request.method, clientHeaders, body);
  }
};

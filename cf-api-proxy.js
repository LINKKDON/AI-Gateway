/**
 * Universal AI Gateway v5.9.8 (Stable Failover Edition)
 * 平台：Cloudflare Workers
 * 修复：
 * 1. getKey 严格轮转 (基于 Body 锁定序列，重试必换 Key)
 * 2. 429 重试增加微量 Jitter (100-300ms) 防爆冲
 */

// ================= 1. 全局配置 =================

const MAX_RETRIES = 3; 
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

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

  /**
   * 🔑 修复后的 getKey 逻辑：严格轮转
   * 使用 bodyBuffer 生成一个固定的种子 (Seed)。
   * 公式：(Seed + retryCount) % Key总数
   * * 效果：
   * 假设 Seed=0, Keys=4。
   * Retry 0 -> Key[0]
   * Retry 1 -> Key[1] (绝对是下一个)
   * Retry 2 -> Key[2]
   */
  getKey(bodyBuffer, retryCount = 0) {
    if (this.keys.length === 0) return null;
    
    let baseIndex = 0;
    
    // 如果有 Body，用 Body 长度作为固定的随机种子
    // 这样对于同一个请求，baseIndex 永远不变
    if (bodyBuffer && bodyBuffer.byteLength > 0) {
        // 为了防止长度完全一样导致 Hash 碰撞过多，加上第一位字节的值
        const firstByte = new Uint8Array(bodyBuffer)[0] || 0;
        baseIndex = bodyBuffer.byteLength + firstByte;
    } else {
        // 没有 Body (GET请求)，用时间戳
        baseIndex = Date.now();
    }

    // 关键：retryCount 驱动指针移动
    const finalIndex = (baseIndex + retryCount) % this.keys.length;
    return this.keys[finalIndex];
  }

  async fetchWithRetry(url, method, headers, body, retryCount = 0) {
    // 传入 retryCount，保证拿到的是序列中的下一个 Key
    const apiKey = this.getKey(body, retryCount);
    
    const reqHeaders = new Headers(headers);
    if (!reqHeaders.has("Content-Type")) reqHeaders.set("Content-Type", "application/json");
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
      // 🚀 起步：0延迟，直接冲，追求首字速度
      // 仅在极个别情况（如网络层报错重试）可以给一点点缓冲，但正常情况直接发
      
      const res = await fetch(url, {
        method: method,
        headers: reqHeaders,
        body: body,
      });

      // 遇到 429 限流 或 5xx 服务器错误
      if ((res.status === 429 || res.status >= 500) && retryCount < MAX_RETRIES) {
        
        // 🛑 优化：安全缓冲 (Safety Buffer)
        // 既然这个 Key 炸了，我们要换下一个 Key。
        // 但为了防止 4 个 Key 在 10ms 内瞬间全部打死，我们强制睡 100ms ~ 300ms。
        // 这个时间对用户体感影响很小，但对 API 来说是很好的“限流”信号。
        const safeDelay = 100 + Math.floor(Math.random() * 200); 
        await new Promise(r => setTimeout(r, safeDelay));

        // 递归重试：retryCount + 1 会自动触发 getKey 里的切号逻辑
        return this.fetchWithRetry(url, method, headers, body, retryCount + 1);
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");

      return new Response(res.body, { status: res.status, headers: newHeaders });

    } catch (e) {
      // 网络层面的错误（DNS, 连接中断），稍微多等一下 (300ms)
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

    if (url.pathname === "/" || request.method === "GET") {
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

    // 必须读取 Body 为 Buffer 才能支持重试和 Hash 计算
    let body = null;
    if (request.method === "POST" || request.method === "PUT") {
        try {
            body = await request.arrayBuffer();
        } catch (e) {
            return new Response("Error reading request body", { status: 400 });
        }
    }

    return manager.fetchWithRetry(targetUrl, request.method, clientHeaders, body);
  }
};

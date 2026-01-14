/**
 * Universal AI Gateway v5.9.19 (Transparent Headers Edition)
 * 平台：Deno Deploy
 * 核心修复：
 * 1. 响应头透传：不再删除 content-encoding，防止上游强行压缩导致客户端解码失败
 * 2. 依然保留 Accept-Encoding: identity 尝试请求明文
 * 3. 包含之前所有的高并发与保号优化
 */

// ================= 1. 全局配置 =================

const SERVICES_CONFIG: Record<string, any> = {
  // 🚀 Cerebras
  '/cerebras': {
    target: 'https://gateway.ai.cloudflare.com/v1/00750af78aa126346f99afa4c68a4329/gpt-load/cerebras',
    envKey: 'CEREBRAS_API_KEYS',
    rps: 4, burst: 8, maxConn: 6
  },

  // 🐢 Groq
  '/groq': {
    target: 'https://gateway.ai.cloudflare.com/v1/00750af78aa126346f99afa4c68a4329/gpt-load/groq',
    envKey: 'GROQ_API_KEYS',
    rps: 1, burst: 3, maxConn: 2
  },

  // ❄️ Claude
  '/claude': {
    target: 'https://api.anthropic.com',
    envKey: 'CLAUDE_API_KEYS',
    rps: 2, burst: 2, maxConn: 1
  },

  // 🟢 Nvidia
  '/nvidia': {
    target: 'https://integrate.api.nvidia.com',
    envKey: 'NVIDIA_API_KEYS',
    rps: 3, burst: 6, maxConn: 5
  },

  // ⚡️ 通用高并发服务
  '/deepseek': { target: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEYS', rps: 10, burst: 20, maxConn: 10 },
  '/openai': { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS', rps: 10, burst: 20, maxConn: 10 },
  '/openrouter': { target: 'https://gateway.ai.cloudflare.com/v1/00750af78aa126346f99afa4c68a4329/gpt-load/openrouter', envKey: 'OPENROUTER_API_KEYS', rps: 5, burst: 10, maxConn: 8 },
  '/siliconflow': { target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS', rps: 5, burst: 10, maxConn: 10 },
  '/ollama': { target: 'https://ollama.com', envKey: 'OLLAMA_API_KEYS', rps: 10, burst: 10, maxConn: 5 },
  '/gemini': { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS', rps: 3, burst: 5, maxConn: 3 },
  '/xai': { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS', rps: 2, burst: 5, maxConn: 3 },
  '/pollinations': { target: 'https://gen.pollinations.ai', envKey: 'POLLINATIONS_API_KEYS', rps: 5, burst: 10, maxConn: 5 },
};

const MAX_RETRIES = 2;
const MAX_QUEUE_SIZE = 200;
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";
const NGINX_HTML = `<!DOCTYPE html><html><head><title>Welcome to nginx!</title><style>body { width: 35em; margin: 0 auto; font-family: Tahoma, Verdana, Arial, sans-serif; }</style></head><body><h1>Welcome to nginx!</h1><p>If you see this page, the nginx web server is successfully installed and working. Further configuration is required.</p><p>For online documentation and support please refer to<a href="http://nginx.org/">nginx.org</a>.<br/>Commercial support is available at<a href="http://nginx.com/">nginx.com</a>.</p><p><em>Thank you for using nginx.</em></p></body></html>`;
const CORS_HEADERS = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "*", "Access-Control-Allow-Headers": "*", "Access-Control-Max-Age": "86400" };

// ================= 2. 核心逻辑 =================

interface QueueTask {
  url: string;
  method: string;
  headers: Headers;
  body: ArrayBuffer | null;
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

  tokens: number;
  lastRefill: number;
  activeRequests: number = 0;

  constructor(prefix: string, config: any) {
    this.prefix = prefix;
    this.config = config;
    this.tokens = config.burst || 1;
    this.lastRefill = Date.now();
  }

  initKeys() {
    if (this.keys.length > 0) return;
    if (this.config.envKey) {
      const envStr = Deno.env.get(this.config.envKey);
      if (envStr) {
        this.keys = envStr.split(/[\n,]+/).map(k => k.trim()).filter(k => k);
      }
    }
  }

  getNextKey(): string {
    this.initKeys();
    if (this.keys.length === 0) return "";
    const key = this.keys[this.keyIndex];
    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    return key;
  }

  refillTokens() {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    const rps = this.config.rps || 1;
    const burst = this.config.burst || 1;
    const newTokens = elapsed * (rps / 1000);
    if (newTokens > 0) {
      this.tokens = Math.min(burst, this.tokens + newTokens);
      this.lastRefill = now;
    }
  }

  async processQueue() {
    if (this.isProcessing) return;
    this.isProcessing = true;

    try {
      while (this.queue.length > 0) {
        this.refillTokens();
        const maxConn = this.config.maxConn || 10;

        if (this.activeRequests >= maxConn) {
          break; // 并发满，暂停，等待唤醒
        }

        if (this.tokens >= 1) {
          this.tokens -= 1;
          this.activeRequests += 1;

          const task = this.queue.shift();
          if (task) {
            this.runFetchWithRetry(task).catch(err => console.error(err));
          }
        } else {
          // 缺令牌，计算精确等待时间
          const rps = this.config.rps || 1;
          const waitTime = (1 - this.tokens) / (rps / 1000);
          if (waitTime > 0) await new Promise(r => setTimeout(r, waitTime));
        }
      }
    } finally {
      this.isProcessing = false;
    }
  }

  async runFetchWithRetry(task: QueueTask) {
    const apiKey = this.getNextKey();

    try {
      const jitter = Math.floor(Math.random() * 20) + 5;
      await new Promise(r => setTimeout(r, jitter));

      const headers = new Headers(task.headers);
      if (!headers.has("Content-Type")) headers.set("Content-Type", "application/json");
      headers.set("User-Agent", BROWSER_UA);

      // ✅ 策略：请求时尝试要明文 (省资源)，但如果上游不给也没关系
      headers.set("Accept-Encoding", "identity");

      if (apiKey) {
        if (this.prefix === '/claude') {
          headers.set("x-api-key", apiKey);
          headers.set("anthropic-version", "2023-06-01");
        } else {
          headers.set("Authorization", `Bearer ${apiKey}`);
        }
      }

      if (this.prefix === '/openrouter') {
        headers.set("HTTP-Referer", "https://github.com");
        headers.set("X-Title", "Universal Gateway");
      }

      const res = await fetch(task.url, {
        method: task.method,
        headers: headers,
        body: task.body,
      });

      // 429/5xx 重试分支
      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        // 资源回收：显式 Cancel Body，立即释放连接
        if (res.body) {
          try { await res.body.cancel(); } catch (e) { }
        }

        task.retryCount++;
        const delay = 500 * Math.pow(2, task.retryCount - 1);
        await new Promise(r => setTimeout(r, delay));

        this.queue.unshift(task); // 优先重试
        return;
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));

      // 🛑 修正：不再删除 content-encoding
      // 保持透传：如果上游返回 gzip，就让客户端自己解压
      // newHeaders.delete("content-encoding"); 
      newHeaders.delete("transfer-encoding");

      task.resolve(new Response(res.body, { status: res.status, headers: newHeaders }));

    } catch (e: any) {
      if (task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 500));
        this.queue.unshift(task);
        return;
      }
      task.resolve(new Response(JSON.stringify({ error: { message: `Gateway Error: ${e.message}` } }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }));
    } finally {
      // ✅ 唤醒机制优化：
      // 1. 释放并发槽位
      this.activeRequests = Math.max(0, this.activeRequests - 1);

      // 2. 高效唤醒：仅当有任务且未运行时，通过微任务唤醒
      // 避免了 setTimeout(0) 带来的宏任务开销和 Timer Storm
      if (this.queue.length > 0 && !this.isProcessing) {
        queueMicrotask(() => this.processQueue());
      }
    }
  }
}

// 初始化管理器
const managers: Record<string, ServiceManager> = {};
for (const [k, v] of Object.entries(SERVICES_CONFIG)) {
  managers[k] = new ServiceManager(k, v);
}

// ================= 3. 主入口 =================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // ✅ 1. Nginx 伪装：仅拦截根路径
  if (url.pathname === "/") {
    return new Response(NGINX_HTML, { status: 200, headers: { "Content-Type": "text/html; charset=UTF-8", "Server": "nginx/1.18.0 (Ubuntu)", "Connection": "keep-alive" } });
  }

  // 2. 路由匹配
  const sortedPrefixes = Object.keys(managers).sort((a, b) => b.length - a.length);
  const prefix = sortedPrefixes.find(p => url.pathname.startsWith(p));
  if (!prefix) return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: CORS_HEADERS });

  const manager = managers[prefix];

  // 3. 路径重写
  let upstreamPath = url.pathname.substring(prefix.length);
  // 智能默认路径逻辑
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

  // 4. Header 处理
  const clientHeaders = new Headers();
  let clientToken = "";
  const deniedHeaders = ["host", "origin", "referer", "cf-", "x-forwarded-proto", "forwarded", "via", "authorization", "content-length"];
  for (const [k, v] of req.headers.entries()) {
    if (!deniedHeaders.some(d => k.toLowerCase().includes(d))) clientHeaders.set(k, v);
    if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
    if (k.toLowerCase() === "x-api-key" && !clientToken) clientToken = v.trim();
  }

  // 5. 鉴权
  const ACCESS_PASSWORD = Deno.env.get("ACCESS_PASSWORD") || "linus";
  if (ACCESS_PASSWORD && clientToken !== ACCESS_PASSWORD) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401, headers: CORS_HEADERS });
  }

  manager.initKeys();
  if (manager.keys.length === 0) {
    return new Response(JSON.stringify({ error: `Service Not Configured: No keys found for ${prefix}` }), { status: 501, headers: CORS_HEADERS });
  }

  // 6. 统一入队处理 (支持 GET/POST/PUT/DELETE)
  // ✅ 允许所有 Method 入队，确保 SDK 的 GET /v1/models 也能被正确转发
  if (manager.queue.length >= MAX_QUEUE_SIZE) {
    return new Response(JSON.stringify({ error: "Gateway Overloaded" }), { status: 429, headers: CORS_HEADERS });
  }

  try {
    // ✅ 优化 Body 读取：GET/HEAD 没有 Body，强行 read 会导致 Deno 挂起或报错
    let bodyBuffer = null;
    if (req.method !== "GET" && req.method !== "HEAD") {
      try { bodyBuffer = await req.arrayBuffer(); } catch (e) { }
    }

    return new Promise((resolve) => {
      manager.queue.push({
        url: targetUrl,
        method: req.method,
        headers: clientHeaders,
        body: bodyBuffer,
        resolve,
        retryCount: 0
      });
      // 触发处理
      manager.processQueue();
    });
  } catch (e) {
    return new Response("Internal Error", { status: 500 });
  }
}

Deno.serve(handleRequest);

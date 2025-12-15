/**
 * Universal AI Gateway v5.9.9 (Deno Stealth Edition)
 * 平台：Deno Deploy
 * 特性：
 * 1. Jitter 回归：增加随机延迟，打破机械特征
 * 2. 零依赖：使用原生 API，杜绝 500 错误
 * 3. 严格鉴权 + Nginx 伪装
 */

// ================= 1. 全局配置 =================

// 🛡️ 保号配置：RateLimit 150ms + Jitter，主打一个稳
const SERVICES_CONFIG: Record<string, any> = {
  '/cerebras':   { target: 'https://api.cerebras.ai', envKey: 'CEREBRAS_API_KEYS', rateLimit: 200 },
  '/groq':       { target: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEYS', rateLimit: 200 },
  '/xai':        { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS', rateLimit: 200 },
  '/deepseek':   { target: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEYS', rateLimit: 200 },
  '/openrouter': { target: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEYS', rateLimit: 200 },
  '/ollama':     { target: 'https://ollama.com', envKey: 'OLLAMA_API_KEYS', rateLimit: 200 },
  '/siliconflow':{ target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS', rateLimit: 200 },
  '/openai':     { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS', rateLimit: 200 },
  '/claude':     { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS', rateLimit: 500 },
  '/gemini':     { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS', rateLimit: 200 },
};

const MAX_RETRIES = 2;
const MAX_QUEUE_SIZE = 200;
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

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "*",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

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

  constructor(prefix: string, config: any) {
    this.prefix = prefix;
    this.config = config;
  }

  // 懒加载 Key
  initKeys() {
    if (this.keys.length > 0) return;
    if (this.config.envKey) {
      const envStr = Deno.env.get(this.config.envKey);
      if (envStr) {
        this.keys = envStr.split(/[\n,]+/).map(k => k.trim()).filter(k => k);
      }
    }
  }

  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      this.runFetchWithRetry(task).catch(err => console.error(err));

      if (this.queue.length > 0 && this.config.rateLimit > 0) {
        await new Promise(r => setTimeout(r, this.config.rateLimit));
      }
    }
    this.isProcessing = false;
  }

  getNextKey(): string {
    this.initKeys();
    if (this.keys.length === 0) return "";
    const key = this.keys[this.keyIndex];
    this.keyIndex = (this.keyIndex + 1) % this.keys.length;
    return key;
  }

  async runFetchWithRetry(task: QueueTask) {
    const apiKey = this.getNextKey();

    try {
      // ✅ Jitter (随机延迟): 20ms ~ 120ms
      // 作用：打破机械规律，防止被判定为脚本
      const jitter = Math.floor(Math.random() * 80) + 9;
      await new Promise(r => setTimeout(r, jitter));

      const headers = new Headers(task.headers);
      if (!headers.has("Content-Type")) {
         headers.set("Content-Type", "application/json");
      }
      headers.set("User-Agent", BROWSER_UA);

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

      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        const delay = 500 * Math.pow(2, task.retryCount - 1);
        await new Promise(r => setTimeout(r, delay));
        return this.runFetchWithRetry(task);
      }

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");

      task.resolve(new Response(res.body, { status: res.status, headers: newHeaders }));

    } catch (e: any) {
      if (task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 500));
        return this.runFetchWithRetry(task);
      }
      task.resolve(new Response(JSON.stringify({ error: { message: `Gateway Error: ${e.message}` } }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }));
    }
  }
}

// 初始化管理器
const managers: Record<string, ServiceManager> = {};
for (const [k, v] of Object.entries(SERVICES_CONFIG)) {
  managers[k] = new ServiceManager(k, v);
}

// ================= 3. 主处理逻辑 =================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // 1. 🕵️ 伪装
  if (url.pathname === "/" || req.method === "GET") {
    return new Response(NGINX_HTML, {
      status: 200,
      headers: {
        "Content-Type": "text/html; charset=UTF-8",
        "Server": "nginx/1.18.0 (Ubuntu)",
        "Connection": "keep-alive"
      }
    });
  }

  // 2. 路由
  const sortedPrefixes = Object.keys(managers).sort((a, b) => b.length - a.length);
  const prefix = sortedPrefixes.find(p => url.pathname.startsWith(p));

  if (!prefix) {
    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: CORS_HEADERS });
  }

  const manager = managers[prefix];

  // 3. 路径
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

  // 4. Header
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

  // 6. 配置检查
  manager.initKeys();
  if (manager.keys.length === 0) {
     return new Response(JSON.stringify({ error: `Service Not Configured: No keys found for ${prefix}` }), { 
       status: 501, 
       headers: CORS_HEADERS 
     });
  }

  // 7. 处理请求
  if (req.method === "POST" || req.method === "PUT") {
    if (manager.queue.length >= MAX_QUEUE_SIZE) {
      return new Response(JSON.stringify({ error: "Gateway Overloaded" }), { status: 429, headers: CORS_HEADERS });
    }
    try {
      const bodyBuffer = await req.arrayBuffer(); 
      return new Promise((resolve) => {
        manager.queue.push({
          url: targetUrl,
          method: req.method,
          headers: clientHeaders,
          body: bodyBuffer,
          resolve,
          retryCount: 0
        });
        manager.processQueue();
      });
    } catch (e) {
      return new Response("Request Body Error", { status: 400 });
    }
  }

  return new Response(JSON.stringify({ error: "Method Not Allowed" }), { status: 405, headers: CORS_HEADERS });
}

// 启动服务
Deno.serve(handleRequest);

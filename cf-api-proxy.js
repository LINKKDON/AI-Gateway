/**
 * Universal AI Gateway v5.6.1 (Stealth Edition)
 * 平台：Cloudflare Workers
 * 适配：沉浸式翻译 (Immersive Translate) / LobeChat / NextWeb
 * 更新：根路径隐身、DeepSeek支持、Gemini路由修复、抗并发队列优化
 */

// ================= 1. 全局配置 =================

const MAX_RETRIES = 2;        // 故障重试次数
const MAX_QUEUE_SIZE = 200;   // [优化] 队列缓冲区调大，适配网页翻译瞬间高并发
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// 服务配置表 (Target 结尾勿带斜杠)
const servicesConfig = {
  // 🚀 托管并发区 (需在后台配置环境变量)
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
      // 支持 换行符 或 逗号 分隔 Key
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
      
      // 非阻塞执行，实现流水线并发
      this.runFetchWithRetry(task).catch(err => console.error(`[Task Error] ${err}`));

      // 速率平滑控制
      if (this.queue.length > 0 && this.config.rateLimit > 0) {
        await new Promise(r => setTimeout(r, this.config.rateLimit));
      }
    }
    this.isProcessing = false;
  }

  async runFetchWithRetry(task) {
    const apiKey = this.getNextKey();
    
    try {
      // [优化] Jitter: 20~120ms 随机延迟，兼顾防封与翻译速度
      const jitter = Math.floor(Math.random() * 100) + 20;
      await new Promise(r => setTimeout(r, jitter));

      const headers = new Headers(task.headers);
      if (apiKey) headers.set("Authorization", `Bearer ${apiKey}`);
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", BROWSER_UA);

      // 托管模式 OpenRouter 特殊头
      if (this.prefix === '/openrouter') {
        headers.set("HTTP-Referer", "https://github.com"); 
        headers.set("X-Title", "AI-Gateway");
      }

      const res = await fetch(task.url, {
        method: task.method,
        headers: headers,
        body: task.body,
      });

      // 错误重试 (429 限流 或 5xx 服务端错误)
      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        const waitTime = 1000 * Math.pow(2, task.retryCount - 1); // 指数退避: 1s, 2s
        console.log(`[Retry ${task.retryCount}] ${this.prefix} status ${res.status}, wait ${waitTime}ms`);
        await new Promise(r => setTimeout(r, waitTime));
        return this.runFetchWithRetry(task);
      }

      // 响应头处理
      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      // 核心：移除压缩编码头，防止 Cloudflare 二次解压导致乱码
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

    // 1. 预检请求
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    // 2. 🕵️ 隐身模式：根路径返回 404
    if (url.pathname === "/") {
      return new Response("404 Not Found", { status: 404 });
    }

    // 健康检查 (保留但低调，不暴露网关名称)
    if (url.pathname === "/health") {
      return new Response(JSON.stringify({ status: "alive", region: request.cf?.colo }), { 
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      });
    }

    // 3. 路由匹配 (按长度降序，防止前缀覆盖)
    const sortedPrefixes = Object.keys(servicesConfig).sort((a, b) => b.length - a.length);
    const prefix = sortedPrefixes.find(p => url.pathname.startsWith(p));

    if (!prefix) {
      // 找不到服务也返回 404，不解释
      return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: CORS_HEADERS });
    }

    const manager = getManager(prefix);
    manager.initKeys(env);

    // 4. 路径清洗与重构
    let upstreamPath = url.pathname.substring(prefix.length);
    
    // 4.1 智能补全默认路径
    if (upstreamPath === "" || upstreamPath === "/") {
      if (prefix === '/claude') upstreamPath = "/v1/messages";
      else if (prefix === '/gemini') upstreamPath = "/v1beta/openai/chat/completions";
      else upstreamPath = "/v1/chat/completions";
    }

    // 4.2 规范化斜杠 (移除重复，移除尾部)
    upstreamPath = upstreamPath.replace(/\/+/g, "/");
    if (upstreamPath.length > 1 && upstreamPath.endsWith('/')) {
      upstreamPath = upstreamPath.slice(0, -1);
    }

    // 4.3 Gemini 路由深度修正
    if (prefix === '/gemini') {
      if (upstreamPath.startsWith('/v1/')) {
        upstreamPath = upstreamPath.replace('/v1/', '/v1beta/openai/');
      } else if (upstreamPath.startsWith('/chat/completions')) {
        upstreamPath = '/v1beta/openai' + upstreamPath;
      }
    }

    // 4.4 安全拼接 URL
    const safeTarget = manager.config.target.replace(/\/+$/, "");
    const targetUrl = safeTarget + upstreamPath + url.search;

    // 5. Header 严格清洗 (去 CF 痕迹)
    const clientHeaders = new Headers();
    // 🚫 严格黑名单
    const deniedHeaders = ["host", "origin", "referer", "cf-", "x-forwarded-proto", "forwarded", "via"];
    let clientToken = "";

    for (const [k, v] of request.headers.entries()) {
      // 过滤掉所有包含 denied 关键词的 Header
      if (!deniedHeaders.some(d => k.toLowerCase().includes(d))) {
        clientHeaders.set(k, v);
      }
      if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
    }

    // 6. 鉴权与模式选择
    const ACCESS_PASSWORD = env.ACCESS_PASSWORD || "";
    const hasKeys = manager.keys.length > 0;
    const isAuth = !ACCESS_PASSWORD || clientToken === ACCESS_PASSWORD;

    // [模式 A] 托管模式 (Server Keys)
    if (hasKeys && isAuth) {
      // 如果是 POST (对话)，进入队列保护
      if (request.method === "POST") {
        if (manager.queue.length >= MAX_QUEUE_SIZE) {
          return new Response(JSON.stringify({ error: "Gateway Overloaded" }), { status: 429, headers: CORS_HEADERS });
        }
        try {
          const bodyText = await request.text(); // 托管模式下读取 Body
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
          return new Response("Request Body Error", { status: 400, headers: CORS_HEADERS });
        }
      } 
      // 如果是 GET (如列表)，直接放行但注入 Key
      else {
        const apiKey = manager.getNextKey();
        clientHeaders.set("Authorization", `Bearer ${apiKey}`);
      }
    }

    // [模式 B] 透明直连模式 (Client Key / 托管 GET)
    try {
      // 微小抖动 (20~120ms)，防止被判定为脚本，同时保持高速
      const jitter = Math.floor(Math.random() * 100) + 20;
      await new Promise(r => setTimeout(r, jitter));

      clientHeaders.set("User-Agent", BROWSER_UA);

      // 补全 OpenRouter 要求的头 (如果客户端没传)
      if (prefix === '/openrouter') {
        if (!clientHeaders.has("HTTP-Referer")) clientHeaders.set("HTTP-Referer", "https://github.com");
        if (!clientHeaders.has("X-Title")) clientHeaders.set("X-Title", "AI-Gateway");
      }

      const res = await fetch(targetUrl, {
        method: request.method,
        headers: clientHeaders,
        body: request.body // 直连模式支持流式上传
      });

      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");

      return new Response(res.body, { status: res.status, headers: newHeaders });

    } catch (e) {
      return new Response(JSON.stringify({ error: `Upstream Error: ${e.message}` }), { 
        status: 502, headers: { ...CORS_HEADERS, "Content-Type": "application/json" } 
      });
    }
  }
};

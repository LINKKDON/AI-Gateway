/**
 * Universal AI Gateway v5.7.1 (Deno Stealth Edition)
 * 平台：Deno Deploy / Docker / VPS
 * 更新：根路径隐身、沉浸式翻译并发优化、端口自适应
 */

// 尝试导入标准库作为后备 (针对旧版 Deno)
import { serve } from "https://deno.land/std@0.224.0/http/server.ts";

// ================= 1. 全局配置 =================

const ACCESS_PASSWORD = Deno.env.get("ACCESS_PASSWORD") || "";

// 限制配置
const MAX_RETRIES = 2;       // 失败重试次数
const MAX_QUEUE_SIZE = 200;  // [优化] 队列缓冲区调大，适配网页翻译瞬间高并发

// 伪装 UA
const BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36";

// 服务配置表
// 💡 提示: 环境变量 Key 支持逗号分隔多个 Key
const services: Record<string, any> = {
  // --- 🚀 托管并发区 ---
  '/cerebras': { target: 'https://api.cerebras.ai', envKey: 'CEREBRAS_API_KEYS', rateLimit: 200 },
  '/groq': { target: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEYS', rateLimit: 200 },
  '/xai': { target: 'https://api.x.ai', envKey: 'XAI_API_KEYS', rateLimit: 200 },
  '/deepseek': { target: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEYS', rateLimit: 200 }, // ✅ DeepSeek

  // --- 🌐 聚合器 ---
  '/openrouter': { target: 'https://openrouter.ai/api', envKey: 'OPENROUTER_API_KEYS', rateLimit: 200 },
  '/ollama': { target: 'https://ollama.com', envKey: 'OLLAMA_API_KEYS', rateLimit: 200 },
  '/siliconflow': { target: 'https://api.siliconflow.cn', envKey: 'SILICONFLOW_API_KEYS', rateLimit: 300 },

  // --- 🤖 主流模型 ---
  '/openai': { target: 'https://api.openai.com', envKey: 'OPENAI_API_KEYS', rateLimit: 100 },
  '/claude': { target: 'https://api.anthropic.com', envKey: 'CLAUDE_API_KEYS', rateLimit: 500 },
  '/gemini': { target: 'https://generativelanguage.googleapis.com', envKey: 'GEMINI_API_KEYS', rateLimit: 200 },
};

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "*",
  "Access-Control-Max-Age": "86400",
};

// ================= 2. 服务管理器 =================

interface QueueTask {
  url: string;
  method: string;
  headers: Headers;
  body: RequestInit["body"]; // 支持 string 或 ReadableStream
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
    if (config.envKey) {
      const envStr = Deno.env.get(config.envKey);
      if (envStr) {
        // 支持换行或逗号分隔
        this.keys = envStr.split(/[\n,]+/).map(k => k.trim()).filter(k => k);
        console.log(`[Init] ${prefix}: Loaded ${this.keys.length} keys.`);
      }
    }
  }

  // 核心调度器 (非阻塞流水线模式)
  async processQueue() {
    if (this.isProcessing || this.queue.length === 0) return;
    this.isProcessing = true;

    while (this.queue.length > 0) {
      const task = this.queue.shift();
      if (!task) break;

      // ⚡️ 异步发射，不等待结果，实现高并发
      this.runFetchWithRetry(task).catch(err => {
        console.error(`[Fatal Error] ${this.prefix}:`, err);
      });

      // 速率控制 (仅控制发射频率)
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
      // [优化] Jitter: 20~120ms 随机延迟，针对翻译场景调快响应
      const jitter = Math.floor(Math.random() * 100) + 20;
      await new Promise(r => setTimeout(r, jitter));

      const headers = new Headers(task.headers);
      headers.set("Content-Type", "application/json");
      headers.set("User-Agent", BROWSER_UA);

      // 🔑 厂商鉴权逻辑
      if (apiKey) {
        if (this.prefix === '/claude') {
          headers.set("x-api-key", apiKey);
          headers.set("anthropic-version", "2023-06-01");
        } else {
          headers.set("Authorization", `Bearer ${apiKey}`);
        }
      }

      // OpenRouter 伪装
      if (this.prefix === '/openrouter') {
        headers.set("HTTP-Referer", "https://github.com");
        headers.set("X-Title", "Universal Gateway");
      }

      const res = await fetch(task.url, {
        method: task.method,
        headers: headers,
        body: task.body,
      });

      // ♻️ 重试逻辑 (429, 5xx)
      if ((res.status >= 500 || res.status === 429) && task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        const delay = 1000 * Math.pow(2, task.retryCount - 1); // 1s, 2s...
        console.warn(`[Retry ${task.retryCount}] ${this.prefix} status ${res.status}, wait ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
        return this.runFetchWithRetry(task);
      }

      // 响应处理
      const newHeaders = new Headers(res.headers);
      Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
      // 移除压缩头 (Deno fetch 会自动解压，透传会导致客户端乱码)
      newHeaders.delete("content-encoding");
      newHeaders.delete("transfer-encoding");

      task.resolve(new Response(res.body, { status: res.status, headers: newHeaders }));

    } catch (e: any) {
      if (task.retryCount < MAX_RETRIES) {
        task.retryCount++;
        await new Promise(r => setTimeout(r, 1000));
        return this.runFetchWithRetry(task);
      }
      console.error(`[Error] ${this.prefix}:`, e);
      task.resolve(new Response(JSON.stringify({ error: { message: `Gateway Error: ${e.message}` } }), {
        status: 502,
        headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
      }));
    }
  }
}

// 初始化管理器
const managers: Record<string, ServiceManager> = {};
for (const [k, v] of Object.entries(services)) {
  managers[k] = new ServiceManager(k, v);
}

// ================= 3. 请求处理主入口 =================

async function handleRequest(req: Request): Promise<Response> {
  const url = new URL(req.url);

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS_HEADERS });

  // 2. 🕵️ 隐身模式：根路径返回 404
  if (url.pathname === "/") {
    return new Response("404 Not Found", { status: 404 });
  }

  // 健康检查 (低调版)
  if (url.pathname === "/health") {
    return new Response(JSON.stringify({ status: "alive" }), {
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }

  // 路由匹配 (按长度排序)
  const sortedPrefixes = Object.keys(managers).sort((a, b) => b.length - a.length);
  const prefix = sortedPrefixes.find(p => url.pathname.startsWith(p));

  if (!prefix) {
    // 找不到服务也返回 404
    return new Response(JSON.stringify({ error: "Not Found" }), { status: 404, headers: CORS_HEADERS });
  }

  const manager = managers[prefix];

  // --- 路径处理 (Sync with v5.6) ---
  let upstreamPath = url.pathname.substring(prefix.length);

  // 1. 默认路径补全
  if (upstreamPath === "" || upstreamPath === "/") {
    if (prefix === '/claude') upstreamPath = "/v1/messages";
    else if (prefix === '/gemini') upstreamPath = "/v1beta/openai/chat/completions";
    else upstreamPath = "/v1/chat/completions";
  }

  // 2. 斜杠清洗
  upstreamPath = upstreamPath.replace(/\/+/g, "/");
  if (upstreamPath.length > 1 && upstreamPath.endsWith('/')) {
    upstreamPath = upstreamPath.slice(0, -1);
  }

  // 3. Gemini 深度修正
  if (prefix === '/gemini') {
    if (upstreamPath.startsWith('/v1/')) {
      upstreamPath = upstreamPath.replace('/v1/', '/v1beta/openai/');
    } else if (upstreamPath.startsWith('/chat/completions')) {
      upstreamPath = '/v1beta/openai' + upstreamPath;
    }
  }

  // 4. URL 安全拼接
  const safeTarget = manager.config.target.replace(/\/+$/, "");
  const targetUrl = safeTarget + upstreamPath + url.search;

  // --- Header 清洗 ---
  const clientHeaders = new Headers();
  let clientToken = "";
  // 🚫 严格去头列表
  const deniedHeaders = ["host", "origin", "referer", "cf-", "x-forwarded-proto", "forwarded", "via", "authorization", "content-length"];

  for (const [k, v] of req.headers.entries()) {
    // includes 比 startsWith 更彻底
    if (!deniedHeaders.some(d => k.toLowerCase().includes(d))) {
      clientHeaders.set(k, v);
    }
    if (k.toLowerCase() === "authorization") clientToken = v.replace("Bearer ", "").trim();
    if (k.toLowerCase() === "x-api-key" && !clientToken) clientToken = v.trim(); // 兼容 Claude 客户端传参
  }

  const hasKeys = manager.keys.length > 0;
  const isAuth = !ACCESS_PASSWORD || clientToken === ACCESS_PASSWORD;

  // === 分支 A: 托管模式 (Server Keys) ===
  if (hasKeys && isAuth) {
    if (req.method === "POST") {
      if (manager.queue.length >= MAX_QUEUE_SIZE) {
        return new Response(JSON.stringify({ error: "Gateway Overloaded" }), { status: 429, headers: CORS_HEADERS });
      }
      try {
        // Deno 中大 Body 需注意，但 Chat 请求通常不大
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
        return new Response("Request Body Error", { status: 400 });
      }
    }
    else {
      // GET 请求 (Direct + Key Injection)
      const apiKey = manager.getNextKey();
      if (prefix === '/claude') clientHeaders.set("x-api-key", apiKey);
      else clientHeaders.set("Authorization", `Bearer ${apiKey}`);
    }
  }
  // === 分支 B: 透明直连 / 鉴权失败 fallback ===
  else {
    // 如果是直连，恢复用户的 Key
    if (clientToken) {
      if (prefix === '/claude') clientHeaders.set("x-api-key", clientToken);
      else clientHeaders.set("Authorization", `Bearer ${clientToken}`);
    }
  }

  // --- 执行直连 (Shared Logic) ---
  try {
    // 即使是直连也微小抖动
    const jitter = Math.floor(Math.random() * 100) + 20;
    await new Promise(r => setTimeout(r, jitter));

    clientHeaders.set("User-Agent", BROWSER_UA);
    // 补全 OpenRouter
    if (prefix === '/openrouter') {
      if (!clientHeaders.has("HTTP-Referer")) clientHeaders.set("HTTP-Referer", "https://github.com");
      if (!clientHeaders.has("X-Title")) clientHeaders.set("X-Title", "Universal Gateway");
    }

    const res = await fetch(targetUrl, {
      method: req.method,
      headers: clientHeaders,
      body: req.body // Deno 支持直接透传 ReadableStream，无需 await text()
    });

    const newHeaders = new Headers(res.headers);
    Object.entries(CORS_HEADERS).forEach(([k, v]) => newHeaders.set(k, v));
    newHeaders.delete("content-encoding");
    newHeaders.delete("transfer-encoding");

    return new Response(res.body, { status: res.status, headers: newHeaders });

  } catch (e: any) {
    return new Response(JSON.stringify({ error: `Upstream Error: ${e.message}` }), {
      status: 502,
      headers: { ...CORS_HEADERS, "Content-Type": "application/json" }
    });
  }
}

// 启动服务 (自适应端口)
const PORT = Number(Deno.env.get("PORT")) || 8000;

if (typeof Deno.serve === "function") {
  // @ts-ignore Deno 2.0 api
  Deno.serve({ port: PORT }, handleRequest);
} else {
  console.log(`Legacy Deno detected. Listening on ${PORT}`);
  serve(handleRequest, { port: PORT });
}

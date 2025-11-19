/**
 * Cerebras High-Performance Proxy (Pipeline Mode)
 * 专为翻译场景优化：支持多 Key 并发，非阻塞队列
 */

// Cerebras API 的接口地址
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// 速率限制 (ms)：每个请求发射的最小间隔
// 如果你有 3 个 Key，建议设置为 150 或 200；如果只有 1 个 Key，建议 500 以上
const RATE_LIMIT_MS = 300;

// 访问密码：客户端需要在 API Key 字段填写此密码（留空则不验证）
const ACCESS_PASSWORD = Deno.env.get("ACCESS_PASSWORD") || "";

// CORS 跨域请求头配置
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

// 请求队列定义
interface QueueItem {
  body: any;
  resolve: (response: Response) => void;
}

const requestQueue: QueueItem[] = [];
let isProcessing = false;
let apiKeys: string[] = [];
let currentKeyIndex = 0;

/**
 * 初始化 API 密钥
 */
function initializeKeys() {
  const keysString = Deno.env.get("CEREBRAS_API_KEYS");
  if (keysString) {
    apiKeys = keysString.split(',').map(key => key.trim()).filter(key => key);
    console.log(`Initialized with ${apiKeys.length} API keys.`);
  } else {
    console.error("CEREBRAS_API_KEYS environment variable not set!");
  }
}

/**
 * 核心优化：流水线处理队列
 * 只等待发射间隔，不等待请求完成
 */
async function processQueue() {
  // 状态检查：如果正在调度、队列为空或无 Key，则退出
  if (isProcessing || requestQueue.length === 0 || apiKeys.length === 0) {
    return;
  }

  isProcessing = true;

  while (requestQueue.length > 0) {
    // 1. 取出请求
    const item = requestQueue.shift()!;

    // 2. 轮询 Key
    const apiKey = apiKeys[currentKeyIndex];
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;

    console.log(`[Pipeline] Dispatching request using Key #${currentKeyIndex}`);

    // 3. 定义异步任务 (闭包)
    // 这里封装了具体的请求逻辑，但不会阻塞主循环
    const dispatchTask = async () => {
      try {
        const apiResponse = await fetch(CEREBRAS_API_URL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${apiKey}`,
          },
          body: JSON.stringify(item.body),
        });

        // 处理 CORS 和响应
        const responseHeaders = new Headers(apiResponse.headers);
        Object.entries(CORS_HEADERS).forEach(([key, value]) => {
          responseHeaders.set(key, value);
        });

        // 返回结果 (可能是流式响应，直接透传)
        item.resolve(new Response(apiResponse.body, {
          status: apiResponse.status,
          statusText: apiResponse.statusText,
          headers: responseHeaders,
        }));

      } catch (error) {
        console.error("Proxy Request Error:", error);
        item.resolve(new Response(JSON.stringify({ error: `Proxy error: ${error.message}` }), {
          status: 502,
          headers: { 'Content-Type': 'application/json', ...CORS_HEADERS }
        }));
      }
    };

    // 4. 【关键点】立即发射任务，不使用 await 等待结果！
    // 这样可以让多个 Key 同时在后台工作
    dispatchTask();

    // 5. 仅等待速率限制间隔 (冷却时间)
    // 只要队列里还有东西，就稍微等一下再发下一个，防止瞬间并发过大触发 429
    if (requestQueue.length > 0) {
      await new Promise(r => setTimeout(r, RATE_LIMIT_MS));
    }
  }

  isProcessing = false;
}

/**
 * HTTP 请求处理器
 */
async function handler(req: Request): Promise<Response> {
  // 处理 CORS 预检
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  if (req.method !== 'POST') {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  // 密码验证
  if (ACCESS_PASSWORD) {
    const authHeader = req.headers.get('Authorization');
    const clientPassword = authHeader?.replace('Bearer ', '').trim();
    if (clientPassword !== ACCESS_PASSWORD) {
      return new Response("Unauthorized", { status: 401, headers: CORS_HEADERS });
    }
  }

  // 检查配置
  if (apiKeys.length === 0) {
    return new Response("Server Error: No API keys configured.", { status: 500, headers: CORS_HEADERS });
  }

  try {
    // 解析请求体
    // 注意：这里需要完全读取 Body 才能存入队列，所以会消耗一点内存
    // 对于翻译文本来说，这通常很小，没问题
    const requestBody = await req.json();

    // 创建 Promise，入队
    return new Promise<Response>((resolve) => {
      requestQueue.push({ body: requestBody, resolve });

      // 触发队列消费者 (非阻塞)
      processQueue();
    });

  } catch (error) {
    return new Response(`Invalid JSON: ${error.message}`, { status: 400, headers: CORS_HEADERS });
  }
}

// 初始化与启动
initializeKeys();

console.log(`🚀 High-Performance Cerebras Proxy Started`);
console.log(`- Mode: Pipeline (Non-blocking)`);
console.log(`- Rate Interval: ${RATE_LIMIT_MS}ms`);
console.log(`- Keys Loaded: ${apiKeys.length}`);

Deno.serve(handler);

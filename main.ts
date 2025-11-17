// Cerebras API 的接口地址
const CEREBRAS_API_URL = 'https://api.cerebras.ai/v1/chat/completions';

// 速率限制：每个请求之间的最小间隔时间（毫秒）
const RATE_LIMIT_MS = 200; 

// CORS 跨域请求头配置，允许前端直接调用
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',        // 允许所有来源
  'Access-Control-Allow-Methods': 'POST, OPTIONS',  // 允许的 HTTP 方法
  'Access-Control-Allow-Headers': 'Content-Type',   // 允许的请求头
};

// 请求队列：存储待处理的请求和对应的 Promise resolve 函数
const requestQueue: { body: any; resolve: (response: Response) => void }[] = [];

// 处理锁：防止多个处理循环同时运行
let isProcessing = false;

// API 密钥数组：从环境变量读取，支持多个密钥轮询
let apiKeys: string[] = [];

// 当前使用的密钥索引：用于轮询切换密钥
let currentKeyIndex = 0;

/**
 * 初始化 API 密钥
 * 从环境变量 CEREBRAS_API_KEYS 读取多个密钥（逗号分隔）
 */
function initializeKeys() {
  const keysString = Deno.env.get("CEREBRAS_API_KEYS");
  if (keysString) {
    // 分割、去空格、过滤空值
    apiKeys = keysString.split(',').map(key => key.trim()).filter(key => key);
    console.log(`Initialized with ${apiKeys.length} API keys.`);
  } else {
    console.error("CEREBRAS_API_KEYS environment variable not set!");
  }
}

/**
 * 处理请求队列
 * 采用请求驱动模式：当有新请求时触发，批量处理所有待处理请求
 * 使用 isProcessing 锁防止并发处理导致的竞态条件
 */
async function processQueue() {
  // 如果正在处理、队列为空、或没有配置密钥，则直接返回
  if (isProcessing || requestQueue.length === 0 || apiKeys.length === 0) {
    return;
  }

  // 加锁：标记开始处理
  isProcessing = true;

  // 循环处理队列中的所有请求
  while (requestQueue.length > 0) {
    // 从队列头部取出一个请求
    const { body, resolve } = requestQueue.shift()!;

    // 轮询获取当前使用的 API 密钥
    const apiKey = apiKeys[currentKeyIndex];
    // 切换到下一个密钥（循环轮询）
    currentKeyIndex = (currentKeyIndex + 1) % apiKeys.length;
    
    console.log(`Processing request with key index: ${currentKeyIndex}`);

    try {
      // 转发请求到 Cerebras API
      const apiResponse = await fetch(CEREBRAS_API_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${apiKey}`,  // 使用当前轮询到的密钥
        },
        body: JSON.stringify(body),
      });

      // 复制 API 响应的 headers 并添加 CORS 头
      const responseHeaders = new Headers(apiResponse.headers);
      Object.entries(CORS_HEADERS).forEach(([key, value]) => {
        responseHeaders.set(key, value);
      });

      // 解析 Promise，返回响应给客户端
      resolve(new Response(apiResponse.body, {
        status: apiResponse.status,
        statusText: apiResponse.statusText,
        headers: responseHeaders,
      }));

    } catch (error) {
      // 处理请求错误
      console.error("Error forwarding request to Cerebras:", error);
      resolve(new Response(`Proxy error: ${error.message}`, { status: 502, headers: CORS_HEADERS }));
    }

    // 速率限制：如果队列中还有请求，等待指定时间再处理下一个
    // 最后一个请求处理完不需要等待
    if (requestQueue.length > 0) {
      await new Promise(resolve => setTimeout(resolve, RATE_LIMIT_MS));
    }
  }

  // 解锁：标记处理完成
  isProcessing = false;
}

/**
 * HTTP 请求处理器
 * 处理客户端发来的请求，将其加入队列并返回 Promise
 */
async function handler(req: Request): Promise<Response> {
  // 处理 CORS 预检请求
  if (req.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // 只允许 POST 请求
  if (req.method !== 'POST') {
    return new Response("Method Not Allowed", { status: 405, headers: CORS_HEADERS });
  }

  // 检查是否配置了 API 密钥
  if (apiKeys.length === 0) {
     return new Response("Server configuration error: No API keys configured.", { status: 500, headers: CORS_HEADERS });
  }

  try {
    // 解析请求体
    const requestBody = await req.json();

    // 创建 Promise 并加入队列
    // 注意：这里立即返回 Promise，不会阻塞并发请求
    const responsePromise = new Promise<Response>((resolve) => {
      requestQueue.push({ body: requestBody, resolve });
    });

    // 立即触发队列处理（如果没有正在处理，会立即开始）
    processQueue();

    // 返回 Promise，等待队列处理完成后解析
    return responsePromise;

  } catch (error) {
    // 处理 JSON 解析错误
    return new Response(`Invalid JSON body: ${error.message}`, { status: 400, headers: CORS_HEADERS });
  }
}

// 初始化：读取环境变量中的 API 密钥
initializeKeys();

// 打印启动信息
console.log(`Cerebras smart proxy started.`);
console.log(`- Rate limiting delay: ${RATE_LIMIT_MS}ms between requests`);
console.log(`- Max requests per second (approx): ${1000 / RATE_LIMIT_MS}`);

// 启动 HTTP 服务器
Deno.serve(handler);

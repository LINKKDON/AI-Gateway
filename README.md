# 🚀 Cerebras Smart Proxy

一个基于 **Deno** 的轻量级 Cerebras ChatCompletions 代理服务，提供：

- 多 API Key **轮询负载均衡**
- 每 200ms 一次请求的 **全局限流**
- 统一的 **CORS 支持（允许浏览器直接访问）**
- 原样 **流式透传** Cerebras 的响应（适配 SSE）

适用于前端或 Apps 直接安全调用 Cerebras API，而无需暴露后端秘钥。

---

# ✨ 功能特性

- 🔁 **多 Key 轮询**  
  自动多 key 轮换，防止单 key 触发限频。

- 🛡 **安全**  
  前端永远看不到你的 `CEREBRAS_API_KEYS`。

- 📡 **支持 SSE / 流式输出**  
  上游返回什么，代理原样流式透传。

- 🌍 **CORS 已启用**  
  任何前端都能直接调用（`Access-Control-Allow-Origin: *`）。

- 🧰 **可部署到 Deno Deploy / Docker / VPS**

---

# 📦 文件结构

你的代码只需要一个文件：

```
main.ts
```

---

# ⚙️ 环境变量

代理使用多个 Cerebras API Key（可选：1 个或多个）。  
在运行时通过以下环境变量提供：

```
CEREBRAS_API_KEYS=key1,key2,key3
```

注意：

- 使用英文逗号分隔
- 不要带空格
- 可只填一个 key

---

# 🛠 本地运行方式（可用于调试）

确保安装 Deno：

```sh
deno --version
```

启动命令：

```sh
CEREBRAS_API_KEYS=sk-xxxx1,sk-xxxx2 \
deno run --allow-net --allow-env main.ts
```

看到：

```
Initialized with 2 API keys.
Listening on http://localhost:8000/
Cerebras smart proxy started.
```

说明启动成功 🎉

---

# 🚀 部署到 Deno Deploy（推荐）

### 1. 推到 GitHub

```sh
git add main.ts
git commit -m "init"
git push
```

---

### 2. 打开 Deno Deploy

👉 https://deno.com/deploy

---

### 3. New Project → Import from GitHub

选择你的仓库，例如：

```
cerebras-proxy
```

---

### 4. 配置入口文件

在 “Entry File” 输入：

```
main.ts
```

---

### 5. 配置环境变量

进入：

```
Settings → Environment Variables
```

新增变量：

| Name | Value |
|------|--------|
| `CEREBRAS_API_KEYS` | `sk-xxx1,sk-xxx2` |

保存即可。

---

### 6. 部署完成

页面会出现：

```
Production URL
https://<your-app>.deno.dev
```

前端即可直接使用：

```
POST https://<your-app>.deno.dev
```

---

# 🧪 测试示例

### cURL

```sh
curl -X POST "https://<your-app>.deno.dev" \
  -H "Content-Type: application/json" \
  -d '{
    "model": "llama3.1-8b",
    "messages": [
      { "role": "user", "content": "Hello proxy" }
    ]
  }'
```

---

### 前端 JS 示例

```js
const res = await fetch("https://<your-app>.deno.dev", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({
    model: "llama3.1-8b",
    messages: [{ role: "user", content: "Hello!" }]
  })
});

const data = await res.json();
console.log(data);
```

---

# 🔧 常见问题（FAQ）

### ❓ Warm Up (Failed) 是什么？

Deno Deploy 会用 GET `/` 预热，但你的服务只接受 POST，因此返回 405 ⇒ 标记 failed。  
这 **不影响正常 POST 请求**。

如需修复，可在 `handler` 中添加：

```ts
if (req.method === "GET") {
  return new Response("OK", { status: 200 });
}
```

---

### ❓ 请求很多时队列会塞满吗？

是的。

当前设计每 200ms 只处理一个请求（≈ 5 req/s），如果你收到更高流量，将会排队。你可以：

- 增加 key 数量（但仍然是 5 req/s）
- 或让我帮你改造成 **每个 key 独立限流（N 倍扩容）**

---

### ❓ 支持流式响应吗？

✔ 完全支持。  
使用 `apiResponse.body` 进行透传，不破坏 SSE。

---

# 📄 License

MIT

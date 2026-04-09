# summarize-mcp-worker

一个用于网页抓取、正文清洗抽取、元数据提取、轻量摘要的 Cloudflare Worker MCP 服务。

## 功能

- `fetch_url`：抓取 URL，返回响应信息与清洗后的预览文本
- `extract_clean`：提取网页可读正文、标题层级、段落内容
- `summarize`：对 URL 或原始文本做轻量抽取式摘要，不依赖外部大模型
- `extract_metadata`：提取标题、描述、canonical、作者线索、语言、封面图、发布时间等
- MCP JSON-RPC 接口位于 `/mcp`
- 纯 Worker 实现，无额外运行时依赖

## 项目结构

```text
summarize-mcp-worker/
├── package.json
├── wrangler.toml
├── README.md
├── README.zh-CN.md
└── src/
    └── index.js
```

## 本地开发

```bash
cd summarize-mcp-worker
npm install
npm run dev
```

健康检查：

```bash
curl http://127.0.0.1:8787/
```

## 部署

```bash
npm run deploy
```

该项目可以直接作为标准 Cloudflare Worker 部署。当前 `wrangler.toml` **没有** 绑定自定义 route，因此默认会部署到 Worker / workers.dev。若你要挂自己的域名，再补充 route 配置即可。

## MCP 用法

接口：

```text
POST /mcp
```

### 初始化

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
```

### 列出工具

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

### 示例：摘要调用

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "method": "tools/call",
  "params": {
    "name": "summarize",
    "arguments": {
      "url": "https://example.com",
      "sentence_count": 4
    }
  }
}
```

## 说明

- 抽取逻辑是启发式的，适合大多数文章、博客、新闻页。
- `summarize` 是轻量抽取式摘要，不是生成式模型总结。
- 对强依赖前端渲染的页面，如果 HTML 本身没有正文，抽取效果会有限。

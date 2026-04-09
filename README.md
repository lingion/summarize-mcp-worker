# summarize-mcp-worker

Cloudflare Worker MCP server for lightweight web fetching, clean extraction, metadata extraction, and extractive summaries.

## Features

- `fetch_url` — fetch a URL and return response metadata + cleaned preview text
- `extract_clean` — extract readable main text, headings, and paragraphs from a web page
- `summarize` — lightweight extractive summary from a URL or raw text, no external LLM dependency
- `extract_metadata` — extract title, description, canonical URL, author hints, language, image, and publish timestamps
- MCP-compatible JSON-RPC endpoint at `/mcp`
- Simple Worker-only implementation, no external npm runtime dependencies

## Project structure

```text
summarize-mcp-worker/
├── package.json
├── wrangler.toml
├── README.md
├── README.zh-CN.md
└── src/
    └── index.js
```

## Local development

```bash
cd summarize-mcp-worker
npm install
npm run dev
```

Health endpoint:

```bash
curl http://127.0.0.1:8787/
```

## Deploy

```bash
npm run deploy
```

This project can be deployed directly as a standard Worker. `wrangler.toml` currently does **not** bind a custom route, so deploy will go to the default Worker / workers.dev target unless you add your own route settings.

## MCP usage

Endpoint:

```text
POST /mcp
```

### Initialize

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test","version":"0.1.0"}}}
```

### List tools

```json
{"jsonrpc":"2.0","id":2,"method":"tools/list"}
```

### Example tool call

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

## Notes

- Extraction is heuristic, aimed at general article/blog/news pages.
- Summary is extractive and lightweight, not a generative model summary.
- Some JS-heavy websites may return weak results if their content is not present in server-rendered HTML.

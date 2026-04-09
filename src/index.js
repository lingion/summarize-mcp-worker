const SERVER_NAME = 'summarize-mcp-worker';
const SERVER_VERSION = '0.1.0';
const DEFAULT_MAX_CHARS = 12000;

const TOOLS = [
  {
    name: 'fetch_url',
    description: 'Fetch a URL and return raw response metadata plus a cleaned text preview.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'integer', default: 4000 },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_clean',
    description: 'Fetch a web page and extract cleaned main text, title, headings, and readable paragraphs.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        max_chars: { type: 'integer', default: 12000 },
        include_headings: { type: 'boolean', default: true },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'summarize',
    description: 'Generate a lightweight extractive summary from a URL or provided text without external model dependencies.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
        text: { type: 'string' },
        max_chars: { type: 'integer', default: 12000 },
        sentence_count: { type: 'integer', default: 5 },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'extract_metadata',
    description: 'Extract page metadata such as title, description, canonical URL, byline hints, site name, language, and published time.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string' },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

function corsHeaders(extra = {}) {
  return {
    'content-type': 'application/json; charset=utf-8',
    'access-control-allow-origin': '*',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
    'access-control-allow-headers': 'content-type, mcp-session-id',
    ...extra,
  };
}

function jsonRpc(id, result) {
  return Response.json({ jsonrpc: '2.0', id, result }, { headers: corsHeaders() });
}

function jsonRpcError(id, code, message, data) {
  return Response.json({ jsonrpc: '2.0', id, error: { code, message, data } }, { headers: corsHeaders() });
}

function toolText(result) {
  return {
    content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ''), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function normalizeUrl(input) {
  const raw = String(input || '').trim();
  if (!raw) throw new Error('missing_url');
  const withScheme = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  const parsed = new URL(withScheme);
  if (!/^https?:$/i.test(parsed.protocol)) throw new Error('unsupported_protocol');
  return parsed.toString();
}

function decodeHtml(str = '') {
  return String(str)
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#x27;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(html = '') {
  return decodeHtml(String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim());
}

function absoluteUrl(href, base) {
  try {
    return new URL(href, base).toString();
  } catch {
    return href || null;
  }
}

function extractMeta(html, baseUrl) {
  const meta = {};
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '';
  meta.title = stripTags(title) || null;

  const metaTagPattern = /<meta\s+([^>]*?)>/gi;
  for (const match of html.matchAll(metaTagPattern)) {
    const attrs = match[1] || '';
    const name = attrs.match(/\b(?:name|property|itemprop)=['"]([^'"]+)['"]/i)?.[1]?.toLowerCase();
    const content = attrs.match(/\bcontent=['"]([\s\S]*?)['"]/i)?.[1];
    if (!name || content == null) continue;
    meta[name] = decodeHtml(content.trim());
  }

  const canonicalHref = html.match(/<link[^>]+rel=['"]canonical['"][^>]+href=['"]([^'"]+)['"]/i)?.[1]
    || html.match(/<link[^>]+href=['"]([^'"]+)['"][^>]+rel=['"]canonical['"]/i)?.[1]
    || null;

  return {
    url: baseUrl,
    title: meta.title,
    description: meta['description'] || meta['og:description'] || meta['twitter:description'] || null,
    site_name: meta['og:site_name'] || null,
    author: meta['author'] || meta['article:author'] || null,
    published_time: meta['article:published_time'] || meta['og:published_time'] || meta['published_time'] || null,
    modified_time: meta['article:modified_time'] || meta['og:modified_time'] || null,
    language: html.match(/<html[^>]+lang=['"]([^'"]+)['"]/i)?.[1] || meta['og:locale'] || null,
    canonical_url: canonicalHref ? absoluteUrl(canonicalHref, baseUrl) : null,
    image: meta['og:image'] || meta['twitter:image'] || null,
    keywords: meta['keywords'] ? meta['keywords'].split(',').map(s => s.trim()).filter(Boolean) : [],
  };
}

function cleanHtmlForExtraction(html) {
  return String(html)
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<iframe[\s\S]*?<\/iframe>/gi, ' ')
    .replace(/<footer[\s\S]*?<\/footer>/gi, ' ')
    .replace(/<nav[\s\S]*?<\/nav>/gi, ' ')
    .replace(/<form[\s\S]*?<\/form>/gi, ' ');
}

function pickMainHtml(html) {
  const preferred = [
    /<article\b[^>]*>([\s\S]*?)<\/article>/i,
    /<main\b[^>]*>([\s\S]*?)<\/main>/i,
    /<section\b[^>]*class=['"][^'"]*(?:article|content|post-body|entry-content|markdown-body)[^'"]*['"][^>]*>([\s\S]*?)<\/section>/i,
    /<div\b[^>]*class=['"][^'"]*(?:article|content|post-body|entry-content|markdown-body)[^'"]*['"][^>]*>([\s\S]*?)<\/div>/i,
  ];
  for (const re of preferred) {
    const found = html.match(re)?.[1];
    if (found && stripTags(found).length > 300) return found;
  }
  return html;
}

function extractHeadings(html) {
  const headings = [];
  for (const match of html.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
    const text = stripTags(match[2]);
    if (!text || text.length < 2) continue;
    headings.push({ level: Number(match[1]), text });
    if (headings.length >= 40) break;
  }
  return headings;
}

function extractParagraphs(html) {
  const blocks = [];
  const patterns = [
    /<p\b[^>]*>([\s\S]*?)<\/p>/gi,
    /<li\b[^>]*>([\s\S]*?)<\/li>/gi,
    /<blockquote\b[^>]*>([\s\S]*?)<\/blockquote>/gi,
  ];
  for (const pattern of patterns) {
    for (const match of html.matchAll(pattern)) {
      const text = stripTags(match[1]);
      if (!text) continue;
      if (text.length < 40) continue;
      if (/^(cookie|accept|sign in|log in|subscribe|advertisement|all rights reserved)/i.test(text)) continue;
      blocks.push(text);
    }
  }
  if (blocks.length === 0) {
    const fallback = stripTags(html)
      .split(/(?<=[。！？.!?])\s+|\n{2,}/)
      .map(s => s.trim())
      .filter(s => s.length >= 60);
    return fallback.slice(0, 50);
  }
  return blocks.slice(0, 80);
}

function truncateText(text, maxChars) {
  const s = String(text || '').trim();
  if (s.length <= maxChars) return s;
  return `${s.slice(0, maxChars)}…`;
}

function extractReadableDocument(html, baseUrl, options = {}) {
  const includeHeadings = options.includeHeadings !== false;
  const cleaned = cleanHtmlForExtraction(html);
  const mainHtml = pickMainHtml(cleaned);
  const metadata = extractMeta(html, baseUrl);
  const headings = includeHeadings ? extractHeadings(mainHtml) : [];
  const paragraphs = extractParagraphs(mainHtml);
  const joined = paragraphs.join('\n\n');
  const text = truncateText(joined, clampInt(options.maxChars, 500, 50000, DEFAULT_MAX_CHARS));
  return {
    url: baseUrl,
    metadata,
    headings,
    paragraphs: paragraphs.slice(0, 20),
    text,
    char_count: text.length,
    paragraph_count: paragraphs.length,
  };
}

function splitSentences(text) {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .split(/(?<=[。！？.!?])\s+/)
    .map(s => s.trim())
    .filter(s => s.length >= 30);
}

function tokenize(text) {
  return (String(text || '').toLowerCase().match(/[a-z0-9]{2,}|[\u4e00-\u9fff]{1,2}/g) || [])
    .filter(t => t.length > 1 || /[\u4e00-\u9fff]/.test(t));
}

function stopwords() {
  return new Set([
    'the','and','for','that','with','this','from','are','was','were','have','has','had','but','not','you','your','about','into','their','they','them','will','would','there','here','than','then','what','when','where','while','which','also','can','could','should','may','might','been','being','over','under','after','before','because','such','more','most','some','many','much','very','just','able','like','using','used','use',
    '我们','你们','他们','以及','一个','一些','已经','可以','如果','因为','所以','这个','那个','这些','那些','进行','通过','需要','其中','并且','不是','没有','自己','可能','为了','相关','更多','非常','对于','然后','但是','还是','一个'
  ]);
}

function summarizeText(text, sentenceCount = 5) {
  const clean = String(text || '').trim();
  if (!clean) throw new Error('missing_text');

  const sentences = splitSentences(clean);
  if (sentences.length === 0) {
    const short = truncateText(clean, 600);
    return { summary: short, bullets: [short], sentence_count: 1, method: 'fallback_truncate' };
  }

  const freq = new Map();
  const deny = stopwords();
  for (const token of tokenize(clean)) {
    if (deny.has(token)) continue;
    freq.set(token, (freq.get(token) || 0) + 1);
  }

  const scored = sentences.map((sentence, index) => {
    const tokens = tokenize(sentence);
    let score = 0;
    for (const token of tokens) score += freq.get(token) || 0;
    if (index === 0) score += 3;
    if (sentence.length > 220) score -= 2;
    return { index, sentence, score };
  });

  const top = scored
    .sort((a, b) => b.score - a.score)
    .slice(0, clampInt(sentenceCount, 1, 10, 5))
    .sort((a, b) => a.index - b.index);

  const bullets = top.map(item => item.sentence);
  return {
    summary: bullets.join(' '),
    bullets,
    sentence_count: bullets.length,
    method: 'extractive_frequency_summary',
  };
}

async function fetchPage(url) {
  const normalized = normalizeUrl(url);
  const res = await fetch(normalized, {
    headers: {
      'user-agent': 'Mozilla/5.0 OpenClaw Summarize MCP',
      'accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5',
    },
    redirect: 'follow',
  });
  const text = await res.text();
  return {
    ok: res.ok,
    status: res.status,
    url: normalized,
    final_url: res.url,
    content_type: res.headers.get('content-type') || null,
    html: text,
  };
}

async function fetchUrlTool(url, maxChars) {
  const page = await fetchPage(url);
  const metadata = extractMeta(page.html, page.final_url);
  const preview = extractReadableDocument(page.html, page.final_url, { maxChars: clampInt(maxChars, 500, 10000, 4000), includeHeadings: false });
  return {
    ok: page.ok,
    status: page.status,
    url: page.url,
    final_url: page.final_url,
    content_type: page.content_type,
    metadata,
    preview_text: preview.text,
    preview_char_count: preview.text.length,
  };
}

async function extractCleanTool(url, maxChars, includeHeadings) {
  const page = await fetchPage(url);
  const readable = extractReadableDocument(page.html, page.final_url, { maxChars, includeHeadings });
  return {
    ok: page.ok,
    status: page.status,
    content_type: page.content_type,
    ...readable,
  };
}

async function summarizeTool(args) {
  const count = clampInt(args?.sentence_count, 1, 10, 5);
  if (args?.text) {
    const summary = summarizeText(String(args.text), count);
    return {
      ok: true,
      source: 'text',
      input_char_count: String(args.text).length,
      ...summary,
    };
  }
  if (args?.url) {
    const extracted = await extractCleanTool(args.url, clampInt(args?.max_chars, 500, 50000, DEFAULT_MAX_CHARS), true);
    const summary = summarizeText(extracted.text, count);
    return {
      ok: extracted.ok,
      status: extracted.status,
      source: 'url',
      url: extracted.url,
      metadata: extracted.metadata,
      ...summary,
    };
  }
  throw new Error('missing_url_or_text');
}

async function metadataTool(url) {
  const page = await fetchPage(url);
  const metadata = extractMeta(page.html, page.final_url);
  return {
    ok: page.ok,
    status: page.status,
    url: page.url,
    final_url: page.final_url,
    content_type: page.content_type,
    metadata,
  };
}

async function handleToolCall(name, args) {
  switch (name) {
    case 'fetch_url':
      return await fetchUrlTool(args?.url, args?.max_chars);
    case 'extract_clean':
      return await extractCleanTool(args?.url, clampInt(args?.max_chars, 500, 50000, DEFAULT_MAX_CHARS), args?.include_headings !== false);
    case 'summarize':
      return await summarizeTool(args || {});
    case 'extract_metadata':
      return await metadataTool(args?.url);
    default:
      throw new Error(`unknown_tool:${name}`);
  }
}

export default {
  async fetch(req) {
    const url = new URL(req.url);

    if (req.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/healthz')) {
      return Response.json({
        ok: true,
        name: SERVER_NAME,
        version: SERVER_VERSION,
        mcp_endpoint: `${url.origin}/mcp`,
        tools: TOOLS.map((t) => t.name),
      }, { headers: corsHeaders() });
    }

    if (req.method !== 'POST' || url.pathname !== '/mcp') {
      return Response.json({ ok: false, error: 'not_found' }, { status: 404, headers: corsHeaders() });
    }

    let body;
    try {
      body = await req.json();
    } catch {
      return jsonRpcError(null, -32700, 'Parse error');
    }

    const id = body?.id ?? null;
    const method = body?.method;
    const params = body?.params || {};

    try {
      if (method === 'initialize') {
        return jsonRpc(id, {
          protocolVersion: '2025-03-26',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        });
      }

      if (method === 'notifications/initialized') {
        return new Response(null, { status: 202, headers: corsHeaders() });
      }

      if (method === 'tools/list') {
        return jsonRpc(id, { tools: TOOLS });
      }

      if (method === 'tools/call') {
        const result = await handleToolCall(params?.name, params?.arguments || {});
        return jsonRpc(id, toolText(result));
      }

      return jsonRpcError(id, -32601, `Method not found: ${method}`);
    } catch (e) {
      return jsonRpcError(id, -32000, 'Tool execution failed', { message: String(e?.message || e) });
    }
  },
};

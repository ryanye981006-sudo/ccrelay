// HTTP 服务：路由、请求转发、SSE 流处理

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { anthropicToOpenAI } = require('./request');
const { openaiToAnthropic } = require('./response');
const { StreamTransformer } = require('./stream');

// 构造 Anthropic 格式的错误响应
function errorResponse(type, message, statusCode) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      type: 'error',
      error: { type, message },
    }),
  };
}

// 从请求头提取 API key（Anthropic 风格：x-api-key 或 Bearer token）
function extractApiKey(req) {
  const xApiKey = req.headers['x-api-key'];
  if (xApiKey) return xApiKey;
  const auth = req.headers['authorization'];
  if (auth && auth.startsWith('Bearer ')) return auth.slice(7);
  return null;
}

// 读取请求体
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', chunk => { data += chunk; });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('invalid_json'));
      }
    });
    req.on('error', reject);
  });
}

// 简易 token 计数（字符级估算，Claude Code 上下文管理用）
function estimateTokens(text) {
  if (!text || text === '') return 0;
  let tokens = 0;
  for (const ch of text) {
    // CJK 字符约 1 字符/1 token，ASCII 约 4 字符/1 token
    if (/[一-鿿㐀-䶿豈-﫿]/.test(ch)) {
      tokens += 1;
    } else if (/[\x00-\x7f]/.test(ch)) {
      tokens += 0.25;
    } else {
      tokens += 0.5;
    }
  }
  return Math.ceil(tokens);
}

function countTokens(body) {
  let total = 0;

  // system 字段
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : body.system.filter(b => b.type === 'text').map(b => b.text).join('\n');
    total += estimateTokens(sysText);
  }

  // messages
  if (body.messages) {
    for (const msg of body.messages) {
      const content = msg.content;
      if (typeof content === 'string') {
        total += estimateTokens(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') {
            total += estimateTokens(block.text);
          } else if (block.type === 'tool_use') {
            total += estimateTokens(JSON.stringify(block.input)) + 5; // +5 for id/name overhead
          } else if (block.type === 'tool_result') {
            const trContent = typeof block.content === 'string'
              ? block.content
              : (Array.isArray(block.content) ? block.content.map(b => b.text || '').join('') : '');
            total += estimateTokens(trContent) + 2;
          }
        }
      }
    }
  }

  // tools
  if (body.tools) {
    for (const tool of body.tools) {
      total += estimateTokens(JSON.stringify(tool));
    }
  }

  return total;
}

// 发送非流式请求到 OpenCode 后端
function fetchOpenAI(config, openaiBody, apiKey) {
  const url = new URL(config.backend.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const body = JSON.stringify(openaiBody);

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${config.backend.apiKey}`,
    },
    timeout: config.timeout || 120000,
  };

  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        try {
          resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: JSON.parse(data) });
        } catch {
          resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: data });
        }
      });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => {
      proxyReq.destroy();
      reject(new Error('timeout'));
    });
    proxyReq.write(body);
    proxyReq.end();
  });
}

// 流式转发：OpenAI SSE → Anthropic SSE
function streamFetchOpenAI(config, openaiBody, res, req) {
  const url = new URL(config.backend.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;

  const body = JSON.stringify(openaiBody);

  const options = {
    hostname: url.hostname,
    port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(body),
      'Authorization': `Bearer ${config.backend.apiKey}`,
      'Accept': 'text/event-stream',
    },
    timeout: config.timeout || 120000,
  };

  // 设置 Anthropic SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no',
  });

  const transformer = new StreamTransformer(openaiBody.model);
  let buffer = '';

  const proxyReq = transport.request(options, (proxyRes) => {
    if (proxyRes.statusCode !== 200) {
      // 后端返回错误
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        const errBody = JSON.stringify({
          type: 'error',
          error: { type: 'api_error', message: `后端返回 ${proxyRes.statusCode}: ${data}` },
        });
        res.write(`event: error\ndata: ${errBody}\n\n`);
        res.end();
      });
      return;
    }

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();

      // 按行解析 SSE
      const lines = buffer.split('\n');
      // 最后一个可能不完整，保留在 buffer
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;

        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          // OpenAI 流结束标记 — 如果 transformer 还没 finished，强制结束
          const events = transformer.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          for (const evt of events) {
            res.write(evt);
          }
          continue;
        }

        try {
          const parsed = JSON.parse(dataStr);
          const events = transformer.processChunk(parsed);
          for (const evt of events) {
            res.write(evt);
          }
        } catch {
          // 忽略无法解析的行
        }
      }
    });

    proxyRes.on('end', () => {
      // 处理残余 buffer
      if (buffer.trim()) {
        const trimmed = buffer.trim();
        if (trimmed.startsWith('data:') && trimmed.slice(5).trim() !== '[DONE]') {
          try {
            const parsed = JSON.parse(trimmed.slice(5).trim());
            const events = transformer.processChunk(parsed);
            for (const evt of events) {
              res.write(evt);
            }
          } catch { /* ignore */ }
        }
      }
      res.end();
    });

    proxyRes.on('error', () => {
      res.end();
    });
  });

  proxyReq.on('error', (err) => {
    const errData = JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: `后端连接失败: ${err.message}` },
    });
    res.write(`event: error\ndata: ${errData}\n\n`);
    res.end();
  });

  proxyReq.on('timeout', () => {
    proxyReq.destroy();
    const errData = JSON.stringify({
      type: 'error',
      error: { type: 'api_error', message: '后端请求超时' },
    });
    res.write(`event: error\ndata: ${errData}\n\n`);
    res.end();
  });

  proxyReq.write(body);
  proxyReq.end();
}

// 创建 HTTP 服务
function createServer(config) {
  const server = http.createServer(async (req, res) => {
    // CORS 头（方便调试）
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    // 记录所有请求
    console.log(`[ccrelay] ${req.method} ${req.url} ← ${req.headers['user-agent']?.substring(0, 50) || '-'}`);

    // 路由分发（剥离查询参数）
    const reqPath = req.url.split('?')[0];

    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', backend: config.backend.url }));
      return;
    }

    if (req.method === 'GET' && reqPath === '/v1/models') {
      // 返回 Anthropic 格式的模型列表（从配置读取）
      const modelIds = config.models || [];
      const models = modelIds.map(id => ({
        id,
        display_name: id,
        type: 'model',
        created_at: '2025-01-01T00:00:00Z',
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: models,
        has_more: false,
        first_id: models[0]?.id || '',
        last_id: models[models.length - 1]?.id || '',
      }));
      return;
    }

    if (req.method === 'POST' && reqPath === '/v1/messages/count_tokens') {
      try {
        const body = await readBody(req);
        const inputTokens = countTokens(body);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: inputTokens }));
      } catch (e) {
        if (e.message === 'invalid_json') {
          const err = errorResponse('invalid_request_error', '请求体 JSON 解析失败', 400);
          res.writeHead(err.statusCode, err.headers);
          res.end(err.body);
        } else {
          const err = errorResponse('api_error', e.message, 500);
          res.writeHead(err.statusCode, err.headers);
          res.end(err.body);
        }
      }
      return;
    }

    if (req.method === 'POST' && reqPath === '/v1/messages') {
      try {
        const anthropicBody = await readBody(req);

        console.log(`[ccrelay] ← ${anthropicBody.model} stream=${anthropicBody.stream}`);

        // 提取模型名
        const apiKey = extractApiKey(req);

        // 翻译请求
        const openaiBody = anthropicToOpenAI(anthropicBody);

        // 根据是否流式选择处理方式
        if (anthropicBody.stream) {
          await streamFetchOpenAI(config, openaiBody, res, req);
        } else {
          const result = await fetchOpenAI(config, openaiBody, apiKey);
          if (result.status === 200) {
            const anthropicResponse = openaiToAnthropic(result.body);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(anthropicResponse));
          } else {
            const errMsg = typeof result.body === 'object' && result.body.error
              ? result.body.error.message
              : `后端返回 ${result.status}`;
            const err = errorResponse('api_error', errMsg, 502);
            res.writeHead(err.statusCode, err.headers);
            res.end(err.body);
          }
        }
      } catch (e) {
        if (e.message === 'invalid_json') {
          const err = errorResponse('invalid_request_error', '请求体 JSON 解析失败', 400);
          res.writeHead(err.statusCode, err.headers);
          res.end(err.body);
        } else {
          console.error(`[ccrelay] 错误: ${e.message}`);
          const err = errorResponse('api_error', e.message, 500);
          res.writeHead(err.statusCode, err.headers);
          res.end(err.body);
        }
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `未知路径: ${reqPath}` } }));
  });

  return server;
}

module.exports = { createServer, estimateTokens, countTokens };

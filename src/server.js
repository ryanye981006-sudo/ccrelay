// HTTP 服务：路由、请求转发、SSE 流处理

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { anthropicToOpenAI } = require('./request');
const { openaiToAnthropic } = require('./response');
const { StreamTransformer } = require('./stream');
const { responsesToChat } = require('./responses');
const { chatToResponses } = require('./responses-response');
const { ResponsesStreamTransformer } = require('./responses-stream');

// 构造错误响应
function errorResponse(type, message, statusCode) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'error', error: { type, message } }),
  };
}

// 从请求头提取 API key
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
      try { resolve(JSON.parse(data)); } catch (e) { reject(new Error('invalid_json')); }
    });
    req.on('error', reject);
  });
}

// 简易 token 计数（字符级估算）
function estimateTokens(text) {
  if (!text || text === '') return 0;
  let tokens = 0;
  for (const ch of text) {
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
  if (body.system) {
    const sysText = typeof body.system === 'string'
      ? body.system
      : body.system.filter(b => b.type === 'text').map(b => b.text).join('\n');
    total += estimateTokens(sysText);
  }
  if (body.messages) {
    for (const msg of body.messages) {
      const content = msg.content;
      if (typeof content === 'string') {
        total += estimateTokens(content);
      } else if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'text') total += estimateTokens(block.text);
          else if (block.type === 'tool_use') total += estimateTokens(JSON.stringify(block.input)) + 5;
          else if (block.type === 'tool_result') {
            const tr = typeof block.content === 'string' ? block.content
              : (Array.isArray(block.content) ? block.content.map(b => b.text || '').join('') : '');
            total += estimateTokens(tr) + 2;
          }
        }
      }
    }
  }
  if (body.tools) {
    for (const tool of body.tools) total += estimateTokens(JSON.stringify(tool));
  }
  return total;
}

// 发送非流式请求到 OpenCode 后端
function fetchOpenAI(config, openaiBody) {
  const url = new URL(config.backend.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const body = JSON.stringify(openaiBody);
  const tlsOpts = isHttps ? { rejectUnauthorized: config.backend.tls?.rejectUnauthorized ?? true } : {};
  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${config.backend.apiKey}` },
    timeout: config.timeout || 120000,
    ...tlsOpts,
  };
  console.log(`[backend] → POST ${url.origin}${options.path} model=${openaiBody.model} stream=${openaiBody.stream} messages=${openaiBody.messages?.length || 0}`);
  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.log(`[backend] ← ${proxyRes.statusCode} (${data.length} bytes)`);
        try { resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: data }); }
      });
    });
    proxyReq.on('error', (err) => { console.error(`[backend] 连接失败: ${err.message}`); reject(err); });
    proxyReq.on('timeout', () => { console.error('[backend] 请求超时'); proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(body);
    proxyReq.end();
  });
}

// 通用流式转发（transformer 工厂模式）
function streamFetchOpenAI(config, openaiBody, res, createTransformer) {
  const url = new URL(config.backend.url);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const body = JSON.stringify(openaiBody);
  const tlsOpts = isHttps ? { rejectUnauthorized: config.backend.tls?.rejectUnauthorized ?? true } : {};
  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${config.backend.apiKey}`, 'Accept': 'text/event-stream' },
    timeout: 0,  // 流式请求不设超时，由心跳保活
    ...tlsOpts,
  };
  console.log(`[backend] → STREAM ${url.origin}${options.path} model=${openaiBody.model} messages=${openaiBody.messages?.length || 0}`);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });

  const transformer = createTransformer();
  let buffer = '';
  let streamEnded = false;

  // SSE 心跳：每 15 秒发送注释行，防止中间代理/负载均衡因空闲超时断开连接
  const heartbeat = setInterval(() => {
    if (!streamEnded) {
      try { res.write(': heartbeat\n\n'); } catch { /* 客户端已断开 */ }
    }
  }, 15000);

  // 安全结束流：确保无论如何都触发 transformer 完成事件
  const endStream = (incomplete) => {
    if (streamEnded) return;
    streamEnded = true;
    clearInterval(heartbeat);
    // 如果 transformer 未完成（后端没发 [DONE] 就关闭了连接），强制触发完成
    if (!transformer.finished) {
      try {
        const events = transformer.processChunk({ choices: [{ delta: {}, finish_reason: incomplete ? 'error' : 'stop' }] });
        for (const evt of events) res.write(evt);
      } catch { /* 忽略 */ }
    }
    try { res.end(); } catch { /* 客户端可能已断开 */ }
  };

  // 客户端断开 → 中止上游请求
  res.on('close', () => {
    if (!streamEnded) {
      try { proxyReq.destroy(); } catch {}
      endStream(true);
    }
  });

  const proxyReq = transport.request(options, (proxyRes) => {
    console.log(`[backend] ← STREAM ${proxyRes.statusCode}`);
    // TCP keep-alive：防止上游连接被路由器/防火墙因空闲断开
    if (proxyReq.socket) {
      proxyReq.socket.setKeepAlive(true, 60000);
    }

    if (proxyRes.statusCode !== 200) {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.error(`[backend] ← STREAM 错误响应: ${data.substring(0, 500)}`);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端返回 ${proxyRes.statusCode}: ${data}` } })}\n\n`);
        endStream(true);
      });
      return;
    }

    proxyRes.on('data', (chunk) => {
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          const events = transformer.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          for (const evt of events) res.write(evt);
          // 立即结束流，确保 response.completed / message_stop 事件被刷新到 socket
          endStream(false);
          continue;
        }
        try {
          const parsed = JSON.parse(dataStr);
          const events = transformer.processChunk(parsed);
          for (const evt of events) res.write(evt);
        } catch { /* ignore */ }
      }
    });

    proxyRes.on('end', () => {
      // 处理残留 buffer（后端可能未发送 [DONE] 就关闭连接）
      if (buffer.trim() && !buffer.trim().includes('[DONE]')) {
        try {
          const dataStr = buffer.trim().slice(5).trim();
          if (dataStr) {
            const parsed = JSON.parse(dataStr);
            const events = transformer.processChunk(parsed);
            for (const evt of events) res.write(evt);
          }
        } catch { /* ignore */ }
      }
      // 强制完成：确保 response.completed / message_stop 一定被发出
      endStream(!transformer.finished && !buffer.includes('[DONE]'));
    });

    proxyRes.on('error', (err) => {
      console.error(`[backend] ← STREAM 后端错误: ${err.message}`);
      endStream(true);
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`[backend] ← STREAM 连接失败: ${err.message}`);
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端连接失败: ${err.message}` } })}\n\n`);
      endStream(true);
    }
  });
  proxyReq.on('timeout', () => {
    console.error('[backend] ← STREAM 超时');
    proxyReq.destroy();
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '后端请求超时' } })}\n\n`);
      endStream(true);
    }
  });
  proxyReq.write(body);
  proxyReq.end();
}

// 创建 HTTP 服务（type: 'claude' | 'codex'）
function createServer(config, serverType, serverConfig) {
  const label = serverType === 'codex' ? 'codex' : 'claude';
  const models = serverConfig.models || [];

  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    console.log(`[${label}] ${req.method} ${req.url} ← ${req.headers['user-agent']?.substring(0, 50) || '-'}`);
    const reqPath = req.url.split('?')[0];

    // 健康检查
    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', type: serverType, backend: config.backend.url }));
      return;
    }

    // 根路径（Codex 会探测 / 确认服务可用）
    if ((req.method === 'GET' || req.method === 'HEAD') && reqPath === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 模型列表 — Claude 用 Anthropic 格式，Codex 用 OpenAI 格式
    if (req.method === 'GET' && (reqPath === '/v1/models' || reqPath === '/models')) {
      const modelData = models.map(id => ({ id, display_name: id, type: 'model', created_at: '2025-01-01T00:00:00Z' }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      if (serverType === 'codex') {
        // OpenAI 格式
        res.end(JSON.stringify({ object: 'list', data: modelData.map(m => ({ id: m.id, object: 'model', created: 1, owned_by: 'clauderelay' })) }));
      } else {
        // Anthropic 格式
        res.end(JSON.stringify({ data: modelData, has_more: false, first_id: modelData[0]?.id || '', last_id: modelData[modelData.length - 1]?.id || '' }));
      }
      return;
    }

    // --- Claude Code 独有路由 ---
    if (serverType === 'claude') {
      if (req.method === 'POST' && reqPath === '/v1/messages/count_tokens') {
        try {
          const body = await readBody(req);
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: countTokens(body) }));
        } catch (e) {
          const err = errorResponse(e.message === 'invalid_json' ? 'invalid_request_error' : 'api_error', e.message, e.message === 'invalid_json' ? 400 : 500);
          res.writeHead(err.statusCode, err.headers); res.end(err.body);
        }
        return;
      }

      if (req.method === 'POST' && reqPath === '/v1/messages') {
        try {
          const anthropicBody = await readBody(req);
          console.log(`[claude] ← ${anthropicBody.model} stream=${anthropicBody.stream}`);
          const openaiBody = anthropicToOpenAI(anthropicBody);
          if (anthropicBody.stream) {
            const inputTokens = countTokens(anthropicBody);
            await streamFetchOpenAI(config, openaiBody, res, () => new StreamTransformer(openaiBody.model, inputTokens));
          } else {
            const result = await fetchOpenAI(config, openaiBody);
            if (result.status === 200) {
              const anthropicResponse = openaiToAnthropic(result.body);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(anthropicResponse));
            } else {
              const errMsg = typeof result.body === 'object' && result.body.error ? result.body.error.message : `后端返回 ${result.status}`;
              const err = errorResponse('api_error', errMsg, 502);
              res.writeHead(err.statusCode, err.headers); res.end(err.body);
            }
          }
        } catch (e) {
          const err = errorResponse(e.message === 'invalid_json' ? 'invalid_request_error' : 'api_error', e.message, e.message === 'invalid_json' ? 400 : 500);
          res.writeHead(err.statusCode, err.headers); res.end(err.body);
        }
        return;
      }
    }

    // --- Codex 独有路由 ---
    if (serverType === 'codex') {
      // Codex 可能请求 /v1/responses、/responses、/v1/chat/completions
      if (req.method === 'POST' && (reqPath === '/v1/responses' || reqPath === '/responses' || reqPath === '/v1/chat/completions')) {
        try {
          const responsesBody = await readBody(req);
          const isResponses = responsesBody.input !== undefined || responsesBody.instructions !== undefined;
          console.log(`[codex] ← ${isResponses ? 'Responses' : 'Chat'} model=${responsesBody.model} stream=${responsesBody.stream}`);
          let openaiBody;
          if (isResponses) {
            openaiBody = responsesToChat(responsesBody);
            // 调试：打印每条消息是否有 reasoning_content
            for (const [idx, msg] of openaiBody.messages.entries()) {
              if (msg.role === 'assistant') {
                console.log(`[codex] msg[${idx}] role=assistant reasoning=${!!msg.reasoning_content} content=${typeof msg.content === 'string' ? msg.content.substring(0, 80) : JSON.stringify(msg.content).substring(0, 80)} tool_calls=${msg.tool_calls?.length || 0}`);
              }
            }
            // 调试：打印原始 input 中的 reasoning 条目
            if (Array.isArray(responsesBody.input)) {
              const reasoningEntries = responsesBody.input.filter(e => (e.type || e.role) === 'reasoning');
              if (reasoningEntries.length > 0) {
                console.log(`[codex] input 中 reasoning 条目: ${reasoningEntries.length} 个`);
              }
            }
          } else {
            openaiBody = responsesBody;
          }
          if (responsesBody.stream || openaiBody.stream) {
            await streamFetchOpenAI(config, openaiBody, res, () => new ResponsesStreamTransformer(openaiBody.model));
          } else {
            const result = await fetchOpenAI(config, openaiBody);
            if (result.status === 200) {
              const responsesResponse = chatToResponses(result.body);
              res.writeHead(200, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify(responsesResponse));
            } else {
              const errMsg = typeof result.body === 'object' && result.body.error ? result.body.error.message : `后端返回 ${result.status}`;
              const err = errorResponse('api_error', errMsg, 502);
              res.writeHead(err.statusCode, err.headers); res.end(err.body);
            }
          }
        } catch (e) {
          const err = errorResponse(e.message === 'invalid_json' ? 'invalid_request_error' : 'api_error', e.message, e.message === 'invalid_json' ? 400 : 500);
          res.writeHead(err.statusCode, err.headers); res.end(err.body);
        }
        return;
      }
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `未知路径: ${reqPath}` } }));
  });

  return server;
}

module.exports = { createServer, estimateTokens, countTokens };

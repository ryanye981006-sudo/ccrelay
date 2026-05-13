// 代理引擎：基于 ClaudeRelay 源码，按 model 名前缀路由到不同后端

const http = require('http');
const https = require('https');
const { URL } = require('url');
const { anthropicToOpenAI } = require('../../src/request');
const { openaiToAnthropic } = require('../../src/response');
const { StreamTransformer } = require('../../src/stream');
const { responsesToChat } = require('../../src/responses');
const { chatToResponses } = require('../../src/responses-response');
const { ResponsesStreamTransformer } = require('../../src/responses-stream');
const { estimateTokens, countTokens } = require('../../src/server');
const { resolveRoutingKey, getCategoryRoutingKeys, findProviderByName, getModels, buildApiUrl, logUsage } = require('./data-store');

// 当前代理面向的分类（codex / claude）
let currentCategory = 'codex';

function setCategory(cat) {
  currentCategory = cat;
}

// ====== 工具函数 ======

function errorResponse(type, message, statusCode) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ type: 'error', error: { type, message } }),
  };
}

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

// 解析请求中的 model 名：providerName/modelName → { provider, model }
function resolveBackend(modelRoutingKey) {
  if (!modelRoutingKey) return null;
  const resolved = resolveRoutingKey(modelRoutingKey, currentCategory);
  if (!resolved) return null;
  return {
    apiBaseUrl: resolved.provider.apiBaseUrl,
    apiKey: resolved.provider.apiKey,
    modelName: resolved.model.name,
    protocol: resolved.provider.protocol || 'openai',
  };
}

// ====== 后端请求 ======

function fetchBackend(backend, openaiBody) {
  const endpointPath = backend.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const chatUrl = buildApiUrl(backend.apiBaseUrl, endpointPath);
  const url = new URL(chatUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const bodyToSend = { ...openaiBody, model: backend.modelName };
  const body = JSON.stringify(bodyToSend);
  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${backend.apiKey}` },
    timeout: 120000,
    rejectUnauthorized: false,
  };
  console.log(`[proxy] → POST ${url.hostname}${options.path} model=${backend.modelName}`);

  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.log(`[proxy] ← ${proxyRes.statusCode} (${data.length} bytes)`);
        try { resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: JSON.parse(data) }); }
        catch { resolve({ status: proxyRes.statusCode, headers: proxyRes.headers, body: data }); }
      });
    });
    proxyReq.on('error', reject);
    proxyReq.on('timeout', () => { proxyReq.destroy(); reject(new Error('timeout')); });
    proxyReq.write(body);
    proxyReq.end();
  });
}

function streamFetchBackend(backend, openaiBody, res, createTransformer, routingKey) {
  const endpointPath = backend.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions';
  const chatUrl = buildApiUrl(backend.apiBaseUrl, endpointPath);
  const url = new URL(chatUrl);
  const isHttps = url.protocol === 'https:';
  const transport = isHttps ? https : http;
  const bodyToSend = { ...openaiBody, model: backend.modelName };
  const body = JSON.stringify(bodyToSend);
  const options = {
    hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
    path: url.pathname + url.search, method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), 'Authorization': `Bearer ${backend.apiKey}`, 'Accept': 'text/event-stream' },
    timeout: 120000,
    rejectUnauthorized: false,
  };
  console.log(`[proxy] → STREAM ${url.hostname}${options.path} model=${backend.modelName}`);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });

  const transformer = createTransformer();
  const modelKey = routingKey || backend.modelName;
  let buffer = '';
  let clientDisconnected = false;

  // 监听客户端断开
  res.on('close', () => {
    clientDisconnected = true;
  });

  const proxyReq = transport.request(options, (proxyRes) => {
    console.log(`[proxy] ← STREAM ${proxyRes.statusCode}`);
    if (proxyRes.statusCode !== 200) {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        console.error(`[proxy] ← STREAM 错误: ${data.substring(0, 300)}`);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端返回 ${proxyRes.statusCode}` } })}\n\n`);
        res.end();
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
      if (buffer.trim() && !buffer.trim().includes('[DONE]')) {
        try {
          const dataStr = buffer.trim().slice(5).trim();
          const parsed = JSON.parse(dataStr);
          const events = transformer.processChunk(parsed);
          for (const evt of events) res.write(evt);
        } catch { /* ignore */ }
      }
      // 记录用量（流式正常完成）
      const stats = transformer.getStats();
      if (stats && (stats.inputTokens > 0 || stats.outputTokens > 0)) {
        logUsage({
          model: modelKey,
          category: currentCategory,
          inputTokens: stats.inputTokens,
          cachedInputTokens: stats.cachedInputTokens || 0,
          outputTokens: stats.outputTokens,
          incomplete: clientDisconnected
        });
      }
      res.end();
    });

    proxyRes.on('error', () => {
      // 后端连接错误：尝试记录已累积的 token
      const stats = transformer.getStats();
      if (stats && (stats.inputTokens > 0 || stats.outputTokens > 0)) {
        logUsage({
          model: modelKey,
          category: currentCategory,
          inputTokens: stats.inputTokens,
          cachedInputTokens: stats.cachedInputTokens || 0,
          outputTokens: stats.outputTokens,
          incomplete: true
        });
      }
      res.end();
    });
  });

  proxyReq.on('error', (err) => {
    console.error(`[proxy] ← STREAM 连接失败: ${err.message}`);
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端连接失败: ${err.message}` } })}\n\n`);
    res.end();
  });
  proxyReq.on('timeout', () => {
    console.error('[proxy] ← STREAM 超时');
    proxyReq.destroy();
    res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '后端请求超时' } })}\n\n`);
    res.end();
  });
  proxyReq.write(body);
  proxyReq.end();
}

// ====== 创建代理服务 ======

function createCodexServer(port) {
  setCategory('codex');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    console.log(`[codex] ${req.method} ${req.url}`);
    const reqPath = req.url.split('?')[0];

    // 健康检查
    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', type: 'codex' }));
      return;
    }

    // 根路径探测
    if ((req.method === 'GET' || req.method === 'HEAD') && reqPath === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 模型列表 — 返回路由键格式：providerName/modelName
    if (req.method === 'GET' && (reqPath === '/v1/models' || reqPath === '/models')) {
      const routingKeys = getCategoryRoutingKeys('codex');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: routingKeys.map(id => ({ id, object: 'model', created: 1, owned_by: 'clauderelay' })),
      }));
      return;
    }

    // Codex 路由：/v1/responses、/responses、/v1/chat/completions
    if (req.method === 'POST' && (reqPath === '/v1/responses' || reqPath === '/responses' || reqPath === '/v1/chat/completions')) {
      try {
        const responsesBody = await readBody(req);

        // 按 model 名前缀路由到对应后端
        const backend = resolveBackend(responsesBody.model);
        if (!backend) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `未知模型: ${responsesBody.model}，可用模型见 /v1/models` } }));
          return;
        }

        const isResponses = responsesBody.input !== undefined || responsesBody.instructions !== undefined;
        console.log(`[codex] ← ${isResponses ? 'Responses' : 'Chat'} routing=${responsesBody.model} → ${backend.apiBaseUrl} model=${backend.modelName} stream=${responsesBody.stream}`);

        let openaiBody;
        if (isResponses) {
          openaiBody = responsesToChat(responsesBody);
        } else {
          openaiBody = responsesBody;
        }

        if (responsesBody.stream || openaiBody.stream) {
          await streamFetchBackend(backend, openaiBody, res, () => new ResponsesStreamTransformer(openaiBody.model), responsesBody.model);
        } else {
          const result = await fetchBackend(backend, openaiBody);
          if (result.status === 200) {
            if (result.body && result.body.usage) {
              logUsage({
                model: responsesBody.model,
                category: 'codex',
                inputTokens: result.body.usage.prompt_tokens || 0,
                cachedInputTokens: result.body.usage.prompt_tokens_details?.cached_tokens || result.body.usage.prompt_cache_hit_tokens || 0,
                outputTokens: result.body.usage.completion_tokens || 0
              });
            }
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

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `未知路径: ${reqPath}` } }));
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[codex] 代理已启动 → http://127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ====== CC 代理服务（Anthropic Messages → Chat Completions） ======

function createCCServer(port) {
  setCategory('claude');
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    console.log(`[claude] ${req.method} ${req.url}`);
    const reqPath = req.url.split('?')[0];

    // 健康检查
    if (req.method === 'GET' && reqPath === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', type: 'claude' }));
      return;
    }

    // 根路径探测
    if ((req.method === 'GET' || req.method === 'HEAD') && reqPath === '/') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    // 模型列表
    if (req.method === 'GET' && (reqPath === '/v1/models' || reqPath === '/models')) {
      const routingKeys = getCategoryRoutingKeys('claude');
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        object: 'list',
        data: routingKeys.map(id => ({ id, object: 'model', created: 1, owned_by: 'clauderelay' })),
      }));
      return;
    }

    // Token 计数
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

    // Anthropic Messages → Chat Completions
    if (req.method === 'POST' && reqPath === '/v1/messages') {
      try {
        const anthropicBody = await readBody(req);

        // 按 model 名前缀路由
        const backend = resolveBackend(anthropicBody.model);
        if (!backend) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `未知模型: ${anthropicBody.model}，可用模型见 /v1/models` } }));
          return;
        }

        console.log(`[claude] ← Anthropic routing=${anthropicBody.model} → ${backend.apiBaseUrl} model=${backend.modelName} stream=${anthropicBody.stream}`);

        const openaiBody = anthropicToOpenAI(anthropicBody);

        if (anthropicBody.stream) {
          const inputTokens = countTokens(anthropicBody);
          await streamFetchBackend(backend, openaiBody, res, () => new StreamTransformer(openaiBody.model, inputTokens), anthropicBody.model);
        } else {
          const result = await fetchBackend(backend, openaiBody);
          if (result.status === 200) {
            if (result.body && result.body.usage) {
              logUsage({
                model: anthropicBody.model,
                category: 'claude',
                inputTokens: result.body.usage.prompt_tokens || 0,
                cachedInputTokens: result.body.usage.prompt_tokens_details?.cached_tokens || result.body.usage.prompt_cache_hit_tokens || 0,
                outputTokens: result.body.usage.completion_tokens || 0
              });
            }
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

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `未知路径: ${reqPath}` } }));
  });

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      console.log(`[claude] 代理已启动 → http://127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

function stopServer(server) {
  return new Promise((resolve) => {
    server.close(() => resolve());
  });
}

module.exports = { createCodexServer, createCCServer, stopServer };

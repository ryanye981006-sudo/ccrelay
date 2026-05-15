// 代理引擎：基于 ClaudeRelay 源码，按 model 名前缀路由到不同后端

const os = require('os');
const path = require('path');
const fs = require('fs');
const http = require('http');
const https = require('https');
const { URL } = require('url');

// 打包兼容：优先使用 src-shared（打包后），回退到项目根 src（开发模式）
function resolveSrc(moduleName) {
  const packagedPath = path.join(__dirname, '..', 'src-shared', moduleName);
  try { return require.resolve(packagedPath); } catch {}
  return require.resolve(path.join(__dirname, '..', '..', 'src', moduleName));
}

const { anthropicToOpenAI } = require(resolveSrc('request'));
const { openaiToAnthropic } = require(resolveSrc('response'));
const { StreamTransformer } = require(resolveSrc('stream'));
const { responsesToChat } = require(resolveSrc('responses'));
const { chatToResponses } = require(resolveSrc('responses-response'));
const { ResponsesStreamTransformer } = require(resolveSrc('responses-stream'));
const { estimateTokens, countTokens } = require(resolveSrc('server'));
const { resolveRoutingKey, getCategoryRoutingKeys, findProviderByName, getModels, buildApiUrl, logUsage } = require('./data-store');

// ====== 文件日志（写入 ~/.ccrelay-desktop/proxy.log） ======
const LOG_DIR = path.join(os.homedir(), '.ccrelay-desktop');
const LOG_FILE = path.join(LOG_DIR, 'proxy.log');
const MAX_LOG_SIZE = 512 * 1024; // 512KB 轮转

function initLogDir() {
  if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
}
function ts() {
  return new Date().toISOString().replace('T', ' ').replace('Z', '');
}
function proxyLog(msg) {
  initLogDir();
  const line = `[${ts()}] ${msg}`;
  try {
    // 轮转
    if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > MAX_LOG_SIZE) {
      const old = LOG_FILE + '.old';
      try { fs.unlinkSync(old); } catch {}
      fs.renameSync(LOG_FILE, old);
    }
    fs.appendFileSync(LOG_FILE, line + '\n', 'utf-8');
  } catch {}
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
function resolveBackend(modelRoutingKey, category) {
  if (!modelRoutingKey) return null;
  const resolved = resolveRoutingKey(modelRoutingKey, category);
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
  proxyLog(`[proxy] → POST ${url.hostname}${options.path} model=${backend.modelName}`);

  return new Promise((resolve, reject) => {
    const proxyReq = transport.request(options, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        proxyLog(`[proxy] ← ${proxyRes.statusCode} (${data.length} bytes)`);
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

function streamFetchBackend(backend, openaiBody, res, createTransformer, routingKey, category) {
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
    timeout: 0,  // 流式请求不设超时，由心跳保活
    rejectUnauthorized: false,
  };
  const streamId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
  proxyLog(`[stream ${streamId}] 开始 model=${backend.modelName}`);

  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive', 'X-Accel-Buffering': 'no' });

  const transformer = createTransformer();
  const modelKey = routingKey || backend.modelName;
  let buffer = '';
  let clientDisconnected = false;
  let streamEnded = false;
  let firstDataTime = 0;

  // SSE 心跳：发送标准 ping 事件，确保所有 SSE 解析器都能识别
  const heartbeat = setInterval(() => {
    if (!streamEnded) {
      try { res.write('event: ping\ndata: {}\n\n'); } catch { /* 客户端已断开 */ }
    }
  }, 15000);

  // 安全结束流：确保无论如何都触发 transformer 完成事件（response.completed / message_stop）
  const endStream = (reason, incomplete) => {
    if (streamEnded) {
      proxyLog(`[stream ${streamId}] endStream 重复调用, reason=${reason}, ignored`);
      return;
    }
    streamEnded = true;
    clearInterval(heartbeat);
    proxyLog(`[stream ${streamId}] endStream reason=${reason} incomplete=${incomplete} finished=${transformer.finished} started=${transformer.started} firstData=${firstDataTime > 0 ? (Date.now() - firstDataTime) + 'ms ago' : 'never'}`);
    // 如果 transformer 未完成（后端没发 [DONE] 就关闭了连接），强制触发完成
    if (!transformer.finished) {
      proxyLog(`[stream ${streamId}] 强制完成, 注入 finish_reason=${incomplete ? 'error' : 'stop'}`);
      try {
        const events = transformer.processChunk({ choices: [{ delta: {}, finish_reason: incomplete ? 'error' : 'stop' }] });
        proxyLog(`[stream ${streamId}] 强制完成产生 ${events.length} 个事件`);
        for (const evt of events) res.write(evt);
      } catch (e) { proxyLog(`[stream ${streamId}] 强制完成异常: ${e.message}`); }
    }
    // 记录用量
    const stats = transformer.getStats();
    if (stats && (stats.inputTokens > 0 || stats.outputTokens > 0)) {
      logUsage({
        model: modelKey,
        category: category,
        inputTokens: stats.inputTokens,
        cachedInputTokens: stats.cachedInputTokens || 0,
        outputTokens: stats.outputTokens,
        incomplete: !!(incomplete || clientDisconnected)
      });
    }
    try { res.end(); } catch { /* 客户端可能已断开 */ }
    proxyLog(`[stream ${streamId}] 流结束`);
  };

  // 客户端断开 → 中止上游请求
  res.on('close', () => {
    clientDisconnected = true;
    proxyLog(`[stream ${streamId}] 客户端关闭连接, streamEnded=${streamEnded}`);
    if (!streamEnded) {
      try { proxyReq.destroy(); } catch {}
      endStream('client-close', true);
    }
  });

  const proxyReq = transport.request(options, (proxyRes) => {
    proxyLog(`[stream ${streamId}] 后端响应 status=${proxyRes.statusCode}`);
    // TCP keep-alive：防止上游连接被路由器/防火墙因空闲断开
    if (proxyReq.socket) {
      proxyReq.socket.setKeepAlive(true, 60000);
    }

    if (proxyRes.statusCode !== 200) {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        proxyLog(`[stream ${streamId}] 后端错误响应: ${data.substring(0, 300)}`);
        res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端返回 ${proxyRes.statusCode}` } })}\n\n`);
        endStream('backend-non200', true);
      });
      return;
    }

    proxyRes.on('data', (chunk) => {
      if (firstDataTime === 0) {
        firstDataTime = Date.now();
        proxyLog(`[stream ${streamId}] 首个数据块 (${chunk.length} bytes)`);
      }
      buffer += chunk.toString();
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || !trimmed.startsWith('data:')) continue;
        const dataStr = trimmed.slice(5).trim();
        if (dataStr === '[DONE]') {
          proxyLog(`[stream ${streamId}] 收到 [DONE]`);
          const events = transformer.processChunk({ choices: [{ delta: {}, finish_reason: 'stop' }] });
          for (const evt of events) res.write(evt);
          // 立即结束流，确保 response.completed 事件被刷新到 socket
          // 不等 proxyRes.on('end')，避免客户端先断开导致事件丢失
          endStream('done-received', false);
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
      proxyLog(`[stream ${streamId}] 后端流结束 (proxyRes.end) bufferLen=${buffer.length} hasDone=${buffer.includes('[DONE]')} finished=${transformer.finished}`);
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
      endStream('backend-end', !transformer.finished && !buffer.includes('[DONE]'));
    });

    proxyRes.on('error', (err) => {
      proxyLog(`[stream ${streamId}] 后端流错误: ${err.message}`);
      endStream('backend-error', true);
    });
  });

  proxyReq.on('error', (err) => {
    proxyLog(`[stream ${streamId}] 上游连接失败: ${err.message}`);
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: `后端连接失败: ${err.message}` } })}\n\n`);
      endStream('upstream-error', true);
    }
  });
  proxyReq.on('timeout', () => {
    proxyLog(`[stream ${streamId}] 上游超时`);
    proxyReq.destroy();
    if (!streamEnded) {
      res.write(`event: error\ndata: ${JSON.stringify({ type: 'error', error: { type: 'api_error', message: '后端请求超时' } })}\n\n`);
      endStream('upstream-timeout', true);
    }
  });
  proxyReq.write(body);
  proxyReq.end();
}

// ====== 创建代理服务 ======

function createCodexServer(port) {
  const category = 'codex';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const reqId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    proxyLog(`[codex ${reqId}] ${req.method} ${req.url}`);
    // 追踪客户端连接何时关闭
    req.on('close', () => { proxyLog(`[codex ${reqId}] 客户端连接关闭`); });
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
        const backend = resolveBackend(responsesBody.model, category);
        if (!backend) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `未知模型: ${responsesBody.model}，可用模型见 /v1/models` } }));
          return;
        }

        const isResponses = responsesBody.input !== undefined || responsesBody.instructions !== undefined;
        proxyLog(`[codex] ← ${isResponses ? 'Responses' : 'Chat'} routing=${responsesBody.model} → ${backend.apiBaseUrl} model=${backend.modelName} stream=${responsesBody.stream}`);

        let openaiBody;
        if (isResponses) {
          openaiBody = responsesToChat(responsesBody);
          // 诊断：打印转换后的消息结构到 proxy.log
          const msgDump = openaiBody.messages.map((m, idx) => {
            const tc = m.tool_calls ? ` tool_calls=[${m.tool_calls.map(t => t.id).join(',')}]` : '';
            const rc = m.reasoning_content ? ` reasoning=${m.reasoning_content.length}chars` : '';
            const ct = m.content ? ` content=${typeof m.content === 'string' ? m.content.substring(0, 60) : JSON.stringify(m.content).substring(0, 60)}` : '';
            return `[${idx}] ${m.role}${tc}${rc}${ct}`;
          });
          proxyLog(`[codex] 转换后消息 (${openaiBody.messages.length}): ${msgDump.join(' | ')}`);
        } else {
          openaiBody = responsesBody;
        }

        if (responsesBody.stream || openaiBody.stream) {
          await streamFetchBackend(backend, openaiBody, res, () => new ResponsesStreamTransformer(openaiBody.model), responsesBody.model, category);
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
            proxyLog(`[codex] 非流式后端错误 status=${result.status} body=${JSON.stringify(result.body).substring(0, 300)}`);
            const err = errorResponse('api_error', errMsg, 502);
            res.writeHead(err.statusCode, err.headers); res.end(err.body);
          }
        }
      } catch (e) {
        proxyLog(`[codex] 请求异常: ${e.message}`);
        const err = errorResponse(e.message === 'invalid_json' ? 'invalid_request_error' : 'api_error', e.message, e.message === 'invalid_json' ? 400 : 500);
        res.writeHead(err.statusCode, err.headers); res.end(err.body);
      }
      return;
    }

    // 404
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found', message: `未知路径: ${reqPath}` } }));
  });

  // 禁用 server 超时：SSE 长连接不能因空闲被断开
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      proxyLog(`[codex] 代理已启动 → http://127.0.0.1:${port}`);
      resolve(server);
    });
    server.on('error', reject);
  });
}

// ====== CC 代理服务（Anthropic Messages → Chat Completions） ======

function createCCServer(port) {
  const category = 'claude';
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Api-Key');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    proxyLog(`[claude] ${req.method} ${req.url}`);
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

    // 模型列表 — 返回 Anthropic 格式（CC 需要 context_window 等信息才能追踪上下文用量）
    if (req.method === 'GET' && (reqPath === '/v1/models' || reqPath === '/models')) {
      const routingKeys = getCategoryRoutingKeys('claude');
      const models = routingKeys.map(m => ({
        id: m,
        display_name: m,
        type: 'model',
        created_at: '2025-01-01T00:00:00Z',
        context_window: 950000,  // DeepSeek V4 支持 1000K，预留余量
        max_output_tokens: 8192,
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

    // Token 计数
    if (req.method === 'POST' && reqPath === '/v1/messages/count_tokens') {
      try {
        const body = await readBody(req);
        const count = countTokens(body);
        proxyLog(`[claude] count_tokens → ${count}`);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ input_tokens: count }));
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
        const backend = resolveBackend(anthropicBody.model, category);
        if (!backend) {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: `未知模型: ${anthropicBody.model}，可用模型见 /v1/models` } }));
          return;
        }

        proxyLog(`[claude] ← Anthropic routing=${anthropicBody.model} → ${backend.apiBaseUrl} model=${backend.modelName} stream=${anthropicBody.stream}`);

        const openaiBody = anthropicToOpenAI(anthropicBody);

        // 诊断：打印转换后的消息结构（重点检查 reasoning_content）
        const msgDump = openaiBody.messages.map((m, idx) => {
          const tc = m.tool_calls ? ` tool_calls=[${m.tool_calls.map(t => t.id).join(',')}]` : '';
          const rc = m.reasoning_content ? ` reasoning=${m.reasoning_content.length}chars` : ' reasoning=MISSING';
          const ct = m.content ? ` content=${typeof m.content === 'string' ? m.content.substring(0, 80) : JSON.stringify(m.content).substring(0, 80)}` : ' content=null';
          return `[${idx}] ${m.role}${tc}${rc}${ct}`;
        });
        proxyLog(`[claude] 转换后消息 (${openaiBody.messages.length}): ${msgDump.join(' | ')}`);

        if (anthropicBody.stream) {
          const inputTokens = countTokens(anthropicBody);
          await streamFetchBackend(backend, openaiBody, res, () => new StreamTransformer(openaiBody.model, inputTokens), anthropicBody.model, category);
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

  // 禁用 server 超时：SSE 长连接不能因空闲被断开
  server.timeout = 0;
  server.keepAliveTimeout = 0;

  return new Promise((resolve, reject) => {
    server.listen(port, '127.0.0.1', () => {
      proxyLog(`[claude] 代理已启动 → http://127.0.0.1:${port}`);
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

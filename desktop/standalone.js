// CCRelay Desktop — 独立服务器模式（免 Electron）
// 启动代理引擎 + Web 管理界面

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const {
  getProviders, addProvider, updateProvider, deleteProvider,
  getModels, addModel, deleteModel,
  addConfig, deleteConfig, renameConfig,
  addModelToConfig, removeModelFromConfig,
  setActiveConfig, getConfigs, getActiveConfig,
  buildApiUrl, getUsage, getUsageDetail,
} = require('./src-electron/data-store');
const { writeCodexConfig, ensureConfigFile } = require('./src-electron/config-writer');
const { writeCCConfig, ensureCCConfigFile } = require('./src-electron/cc-config-writer');
const { createCodexServer, createCCServer, stopServer } = require('./src-electron/proxy-engine');

const CODEX_PORT = 18889;
const CC_PORT = 18888;
const UI_PORT = 18900;
const REQUEST_TIMEOUT = 15000; // 15 秒超时

// 发起 HTTP 请求（带手动超时兜底，防 DNS/TCP/TLS 阶段卡死）
function safeRequest(options, body, timeoutMs) {
  const isHttps = options.url.startsWith('https:');
  const transport = isHttps ? https : http;

  return new Promise((resolve) => {
    const done = (result) => { clearTimeout(timer); resolve(result); };
    const timer = setTimeout(() => {
      req.destroy();
      done({ error: options.timeoutMsg || '请求超时', status: 504 });
    }, timeoutMs);

    // 直接传 URL 字符串，避免 URL 解析导致的 308 重定向问题
    const req = transport.request(options.url, {
      method: options.method || 'POST',
      headers: options.headers || {},
      rejectUnauthorized: false,
    }, (proxyRes) => {
      let data = '';
      proxyRes.on('data', chunk => { data += chunk; });
      proxyRes.on('end', () => {
        try {
          done({ status: proxyRes.statusCode, body: JSON.parse(data), raw: data });
        } catch {
          done({ status: proxyRes.statusCode, body: data, raw: data });
        }
      });
    });
    req.on('error', (err) => done({ error: err.message, status: 502 }));
    if (body) {
      req.write(typeof body === 'string' ? body : JSON.stringify(body));
    }
    req.end();
  });
}

// ====== REST API 路由 ======
function apiRouter(req, res, url, method, body) {
  const pathname = url.pathname;

  // Provider CRUD
  if (method === 'GET' && pathname === '/api/providers') {
    return { data: getProviders() };
  }
  if (method === 'POST' && pathname === '/api/providers') {
    const p = addProvider(body);
    return { data: p };
  }
  if (method === 'PUT' && pathname.startsWith('/api/providers/')) {
    const id = pathname.split('/').pop();
    const p = updateProvider(id, body);
    return { data: p };
  }
  if (method === 'DELETE' && pathname.startsWith('/api/providers/')) {
    const id = pathname.split('/').pop();
    deleteProvider(id);
    return { data: { ok: true } };
  }

  // Model CRUD
  if (method === 'GET' && pathname.startsWith('/api/models/')) {
    const providerId = pathname.split('/').pop();
    return { data: getModels(providerId) };
  }
  if (method === 'POST' && pathname === '/api/models') {
    const m = addModel(body.providerId, body.name);
    return { data: m };
  }
  if (method === 'DELETE' && pathname.startsWith('/api/models/')) {
    const id = pathname.split('/').pop();
    deleteModel(id);
    return { data: { ok: true } };
  }

  // ====== 配置 CRUD（新） ======

  if (method === 'GET' && pathname.startsWith('/api/config/')) {
    const category = pathname.split('/').pop();
    return { data: getConfigs(category) };
  }
  if (method === 'POST' && pathname === '/api/config/add') {
    const cfg = addConfig(body.category, body.name);
    if (body.category === 'codex') {
      ensureConfigFile();
    } else if (body.category === 'claude') {
      ensureCCConfigFile();
    }
    return { data: cfg };
  }
  if (method === 'POST' && pathname === '/api/config/delete') {
    deleteConfig(body.category, body.configId);
    return { data: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/config/rename') {
    const cfg = renameConfig(body.category, body.configId, body.name);
    return { data: cfg };
  }
  if (method === 'POST' && pathname === '/api/config/add-model') {
    const slotIndex = body.slotIndex;
    addModelToConfig(body.category, body.configId, body.modelId, slotIndex);
    // Codex / CC：新增/替换模型时，若当前配置已激活则同步写入配置文件
    if (body.category === 'codex') {
      const activeCfg = getActiveConfig('codex');
      if (activeCfg && activeCfg.id === body.configId && activeCfg.models.length > 0) {
        const { modelRoutingKey } = require('./src-electron/data-store');
        writeCodexConfig(modelRoutingKey(activeCfg.models[0]), CODEX_PORT);
      }
    } else if (body.category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg && activeCfg.id === body.configId) {
        const { modelRoutingKey, getModelWithProvider } = require('./src-electron/data-store');
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) writeCCConfig(routingKeys, CC_PORT);
      }
    }
    return { data: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/config/remove-model') {
    removeModelFromConfig(body.category, body.configId, body.modelId, body.slotIndex);
    return { data: { ok: true } };
  }
  if (method === 'POST' && pathname === '/api/config/set-active') {
    setActiveConfig(body.category, body.configId);
    if (body.category === 'codex') {
      const activeCfg = getActiveConfig('codex');
      if (activeCfg && activeCfg.models.length > 0) {
        const { modelRoutingKey } = require('./src-electron/data-store');
        writeCodexConfig(modelRoutingKey(activeCfg.models[0]), CODEX_PORT);
      }
    } else if (body.category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg) {
        const { modelRoutingKey, getModelWithProvider } = require('./src-electron/data-store');
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) writeCCConfig(routingKeys, CC_PORT);
      }
    }
    return { data: { ok: true } };
  }

  // ====== 模型获取/验证 ======

  if (method === 'POST' && pathname === '/api/fetch-models') {
    const providers = getProviders();
    const provider = providers.find(p => p.id === body.providerId);
    if (!provider) return { error: 'API 源不存在', status: 404 };
    if (provider.protocol === 'anthropic') {
      return { data: { models: [], hint: 'Anthropic 协议不支持获取模型列表，请手动输入模型名验证' } };
    }

    const modelsUrl = buildApiUrl(provider.apiBaseUrl, '/v1/models');
    console.log(`[api] 获取模型列表: GET ${modelsUrl}`);

    return (async () => {
      const result = await safeRequest({
        url: modelsUrl, method: 'GET',
        headers: { 'Authorization': `Bearer ${provider.apiKey}` },
        timeoutMsg: '获取模型列表超时 (15s)',
      }, null, REQUEST_TIMEOUT);

      if (result.error) return result;
      try {
        const models = (result.body.data || []).map(m => m.id);
        return { data: { models } };
      } catch {
        return { error: '解析模型列表失败', status: 502 };
      }
    })();
  }

  if (method === 'POST' && pathname === '/api/verify-model') {
    const providers = getProviders();
    const provider = providers.find(p => p.id === body.providerId);
    if (!provider) return { error: 'API 源不存在', status: 404 };

    const chatUrl = buildApiUrl(provider.apiBaseUrl,
      provider.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    const verifyBody = {
      model: body.modelName, max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    };
    console.log(`[api] 验证模型: POST ${chatUrl} model=${body.modelName}`);

    return (async () => {
      const result = await safeRequest({
        url: chatUrl, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
        timeoutMsg: '验证请求超时 (15s)',
      }, verifyBody, REQUEST_TIMEOUT);

      if (result.error) return { data: { ok: false, error: `验证请求失败: ${result.error}` } };
      if (result.status === 200) return { data: { ok: true } };
      let errMsg = `模型 "${body.modelName}" 不存在或不可用 (HTTP ${result.status})`;
      if (result.body?.error?.message) errMsg = result.body.error.message;
      return { data: { ok: false, error: errMsg } };
    })();
  }

  // 代理状态
  if (method === 'GET' && pathname === '/api/proxy-status') {
    return { data: { running: true, codexPort: CODEX_PORT, ccPort: CC_PORT } };
  }

  // ====== 用量统计 ======

  // GET /api/usage?range=today|7d|30d — 按模型聚合
  if (method === 'GET' && pathname === '/api/usage') {
    const range = url.searchParams.get('range') || 'today';
    const records = getUsage(range);
    // 按 model 聚合
    const modelMap = {};
    for (const r of records) {
      if (!modelMap[r.model]) {
        modelMap[r.model] = {
          model: r.model,
          callCount: 0,
          totalTokens: 0,
          inputTokens: 0,
          cachedInputTokens: 0,
          outputTokens: 0
        };
      }
      modelMap[r.model].callCount++;
      modelMap[r.model].inputTokens += r.inputTokens;
      modelMap[r.model].cachedInputTokens += r.cachedInputTokens || 0;
      modelMap[r.model].outputTokens += r.outputTokens;
      modelMap[r.model].totalTokens += r.inputTokens + r.outputTokens;
    }
    return { data: { models: Object.values(modelMap) } };
  }

  // GET /api/usage/:modelKey?range=&page=&pageSize= — 模型详细记录（分页）
  if (method === 'GET' && pathname.startsWith('/api/usage/')) {
    const modelKey = decodeURIComponent(pathname.replace('/api/usage/', ''));
    const range = url.searchParams.get('range') || 'today';
    const page = parseInt(url.searchParams.get('page')) || 1;
    const pageSize = parseInt(url.searchParams.get('pageSize')) || 100;
    return { data: getUsageDetail(modelKey, range, page, pageSize) };
  }

  // ====== 测试连接 ======
  if (method === 'POST' && pathname === '/api/test-connection') {
    const providers = getProviders();
    const provider = providers.find(p => p.id === body.providerId);
    if (!provider) return { error: 'API 源不存在', status: 404 };

    const chatUrl = buildApiUrl(provider.apiBaseUrl,
      provider.protocol === 'anthropic' ? '/v1/messages' : '/v1/chat/completions');
    const testBody = {
      model: 'test', max_tokens: 1,
      messages: [{ role: 'user', content: 'hi' }],
    };
    console.log(`[api] 测试连接: POST ${chatUrl}`);

    return (async () => {
      const result = await safeRequest({
        url: chatUrl, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
        timeoutMsg: '连接超时 (15s)',
      }, testBody, REQUEST_TIMEOUT);

      if (result.error) return { data: { ok: false, error: result.error } };
      // 2xx/3xx/400/401/403 都说明服务可达（400 通常是"模型不存在"，说明 API 在工作）
      const ok = (result.status >= 200 && result.status < 500);
      return { data: { ok, status: result.status, detail: ok ? 'API 服务可达' : '无法连接' } };
    })();
  }

  return null;
}

// ====== 静态文件服务 ======
function serveStatic(req, res, url) {
  const distDir = path.join(__dirname, 'dist-renderer');
  let filePath = path.join(distDir, url.pathname === '/' ? 'index.html' : url.pathname);
  if (!fs.existsSync(filePath)) filePath = path.join(distDir, 'index.html');

  const ext = path.extname(filePath);
  const mimeTypes = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'application/javascript',
    '.css': 'text/css',
    '.json': 'application/json',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
  };

  try {
    const content = fs.readFileSync(filePath);
    res.writeHead(200, { 'Content-Type': mimeTypes[ext] || 'text/plain' });
    res.end(content);
  } catch (e) {
    res.writeHead(404);
    res.end('Not found');
  }
}

// ====== 创建 UI 服务器 ======
function createUIServer() {
  const server = http.createServer(async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

    const url = new URL(req.url, `http://localhost:${UI_PORT}`);

    if (url.pathname.startsWith('/api/')) {
      let body = null;
      if (req.method === 'POST' || req.method === 'PUT') {
        try {
          body = await new Promise((resolve, reject) => {
            let data = '';
            req.on('data', chunk => { data += chunk; });
            req.on('end', () => { try { resolve(JSON.parse(data)); } catch (e) { resolve({}); } });
            req.on('error', reject);
          });
        } catch (e) { body = {}; }
      }

      let result;
      try {
        result = await apiRouter(req, res, url, req.method, body);
      } catch (e) {
        result = { error: e.message, status: 400 };
      }
      if (result) {
        if (result.error) {
          res.writeHead(result.status || 400, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: result.error }));
        } else {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify(result.data));
        }
      } else {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'API 不存在' }));
      }
      return;
    }

    serveStatic(req, res, url);
  });

  return server;
}

// ====== 启动 ======
async function main() {
  console.log('[ui] 构建前端...');
  try {
    fs.statSync(path.join(__dirname, 'dist-renderer', 'index.html'));
    console.log('[ui] 前端已构建，跳过');
  } catch {
    console.log('[ui] 请先运行: npx vite build --config vite.config.js');
    process.exit(1);
  }

  const codexServer = await createCodexServer(CODEX_PORT);
  const ccServer = await createCCServer(CC_PORT);

  const uiServer = createUIServer();
  await new Promise((resolve) => uiServer.listen(UI_PORT, '127.0.0.1', resolve));
  console.log(`[ui] 管理界面 → http://127.0.0.1:${UI_PORT}`);

  console.log('\n=== CCRelay Desktop (独立版) ===');
  console.log(`CC 代理:    http://127.0.0.1:${CC_PORT}`);
  console.log(`Codex 代理: http://127.0.0.1:${CODEX_PORT}`);
  console.log(`管理界面:  http://127.0.0.1:${UI_PORT}`);
  console.log('按 Ctrl+C 退出\n');

  function shutdown() {
    console.log('\n[ccrelay] 正在关闭...');
    uiServer.close();
    Promise.all([stopServer(codexServer), stopServer(ccServer)]).then(() => {
      console.log('[ccrelay] 已退出');
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });

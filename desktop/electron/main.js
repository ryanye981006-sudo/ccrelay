// Electron 主进程入口

const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const http = require('http');
const {
  getProviders, addProvider, updateProvider, deleteProvider,
  getModels, addModel, deleteModel,
  getConfigs, addConfig, deleteConfig, renameConfig,
  addModelToConfig, removeModelFromConfig, setActiveConfig, getActiveConfig,
  getCategoryModels, addModelToCategory, removeModelFromCategory, setActiveModel, getActiveModel,
  modelRoutingKey,
} = require('../src-electron/data-store');
const { writeCodexConfig, ensureConfigFile } = require('../src-electron/config-writer');
const { writeCCConfig, ensureCCConfigFile } = require('../src-electron/cc-config-writer');
const { createCodexServer, createCCServer, stopServer } = require('../src-electron/proxy-engine');

const CODEX_PORT = 18889;
const CC_PORT = 18888;

let mainWindow = null;
let codexServer = null;
let ccServer = null;

// 代理引擎已改为前缀路由模式：无需注册 Provider 解析器
// 每次请求到来时，engine 根据 model 名前缀自动查找对应的 Provider

// 启动代理
async function startProxies() {
  try {
    codexServer = await createCodexServer(CODEX_PORT);
    console.log(`[main] Codex 代理已启动 :${CODEX_PORT}`);
  } catch (e) {
    console.error(`[main] Codex 代理启动失败: ${e.message}`);
  }
  try {
    ccServer = await createCCServer(CC_PORT);
    console.log(`[main] CC 代理已启动 :${CC_PORT}`);
  } catch (e) {
    console.error(`[main] CC 代理启动失败: ${e.message}`);
  }
}

// 注册所有 IPC 处理器
function registerIpcHandlers() {
  // Provider CRUD
  ipcMain.handle('get-providers', () => getProviders());
  ipcMain.handle('add-provider', (_, data) => addProvider(data));
  ipcMain.handle('update-provider', (_, id, data) => updateProvider(id, data));
  ipcMain.handle('delete-provider', (_, id) => { deleteProvider(id); });

  // Model CRUD
  ipcMain.handle('get-models', (_, providerId) => getModels(providerId));
  ipcMain.handle('add-model', (_, providerId, name) => addModel(providerId, name));
  ipcMain.handle('delete-model', (_, id) => { deleteModel(id); });

  // Config CRUD
  ipcMain.handle('get-configs', (_, category) => getConfigs(category));
  ipcMain.handle('add-config', (_, category, name) => {
    const cfg = addConfig(category, name);
    if (category === 'codex') ensureConfigFile();
    else if (category === 'claude') ensureCCConfigFile();
    return cfg;
  });
  ipcMain.handle('delete-config', (_, category, configId) => deleteConfig(category, configId));
  ipcMain.handle('rename-config', (_, category, configId, name) => renameConfig(category, configId, name));
  ipcMain.handle('add-model-to-config', (_, category, configId, modelId, slotIndex) => {
    addModelToConfig(category, configId, modelId, slotIndex);
    if (category === 'codex') {
      const activeCfg = getActiveConfig('codex');
      if (activeCfg && activeCfg.id === configId && activeCfg.models.length > 0) {
        writeCodexConfig(modelRoutingKey(activeCfg.models[0]), CODEX_PORT);
      }
    } else if (category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg && activeCfg.id === configId) {
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const { getModelWithProvider } = require('../src-electron/data-store');
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) writeCCConfig(routingKeys, CC_PORT);
      }
    }
  });
  ipcMain.handle('remove-model-from-config', (_, category, configId, modelId, slotIndex) => removeModelFromConfig(category, configId, modelId, slotIndex));
  ipcMain.handle('set-active-config', (_, category, configId) => {
    setActiveConfig(category, configId);
    if (category === 'codex') {
      const activeCfg = getActiveConfig('codex');
      if (activeCfg && activeCfg.models.length > 0) {
        writeCodexConfig(modelRoutingKey(activeCfg.models[0]), CODEX_PORT);
      }
    } else if (category === 'claude') {
      const activeCfg = getActiveConfig('claude');
      if (activeCfg) {
        const routingKeys = (activeCfg.modelIds || []).slice(0, 4).map(mid => {
          if (!mid) return '';
          const { getModelWithProvider } = require('../src-electron/data-store');
          const m = getModelWithProvider(mid);
          return m ? modelRoutingKey(m) : '';
        });
        while (routingKeys.length < 4) routingKeys.push('');
        if (routingKeys.some(k => k)) writeCCConfig(routingKeys, CC_PORT);
      }
    }
  });

  // 配置写入
  ipcMain.handle('apply-codex-config', () => {
    const activeCfg = getActiveConfig('codex');
    if (!activeCfg || activeCfg.models.length === 0) throw new Error('Codex 分类下没有激活的配置');
    const routingKey = modelRoutingKey(activeCfg.models[0]);
    const result = writeCodexConfig(routingKey, CODEX_PORT);
    return { ...result, configName: activeCfg.name, routingKey };
  });

  // 代理状态
  ipcMain.handle('get-proxy-status', () => ({
    running: codexServer !== null || ccServer !== null,
    codexPort: CODEX_PORT,
    ccPort: CC_PORT,
  }));

  // 测试连接：发一个最小请求到 Provider
  ipcMain.handle('test-connection', async (_, providerId) => {
    const providers = getProviders();
    const provider = providers.find(p => p.id === providerId);
    if (!provider) return { ok: false, error: 'API 源不存在' };

    const url = new URL(provider.apiBaseUrl);
    const isHttps = url.protocol === 'https:';
    const transport = isHttps ? require('https') : http;
    const body = JSON.stringify({
      model: 'test',
      messages: [{ role: 'user', content: 'hi' }],
      max_tokens: 1,
    });

    return new Promise((resolve) => {
      const req = transport.request({
        hostname: url.hostname, port: url.port || (isHttps ? 443 : 80),
        path: url.pathname + url.search, method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${provider.apiKey}` },
        timeout: 10000,
        rejectUnauthorized: false,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200 || res.statusCode === 401 || res.statusCode === 403) {
            // 200 成功, 401/403 说明能连通但 key 可能不对
            resolve({ ok: true, status: res.statusCode });
          } else {
            resolve({ ok: false, error: `后端返回 ${res.statusCode}: ${data.substring(0, 200)}` });
          }
        });
      });
      req.on('error', (err) => resolve({ ok: false, error: err.message }));
      req.on('timeout', () => { req.destroy(); resolve({ ok: false, error: '连接超时' }); });
      req.write(body);
      req.end();
    });
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 900,
    height: 640,
    minWidth: 700,
    minHeight: 500,
    title: 'ClaudeRelay Desktop',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // 开发模式加载 Vite，生产模式加载打包后的文件
  const isDev = process.argv.includes('--dev') || process.env.NODE_ENV === 'development';
  if (isDev || !app.isPackaged) {
    mainWindow.loadURL('http://127.0.0.1:5173');
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
  }

  mainWindow.on('closed', () => { mainWindow = null; });
}

app.whenReady().then(async () => {
  registerIpcHandlers();
  await startProxies();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', async () => {
  if (codexServer) await stopServer(codexServer);
  if (ccServer) await stopServer(ccServer);
  if (process.platform !== 'darwin') app.quit();
});

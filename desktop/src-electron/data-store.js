// 数据存储层：读写 ~/.clauderelay-desktop/data.json（目录名保持兼容）

const fs = require('fs');
const path = require('path');
const os = require('os');

const DATA_DIR = path.join(os.homedir(), '.ccrelay-desktop');
const DATA_FILE = path.join(DATA_DIR, 'data.json');
const USAGE_FILE = path.join(DATA_DIR, 'usage.json');

// 默认数据结构 — 配置化管理
const DEFAULT_DATA = {
  providers: [],
  models: [],
  codex: { configs: [], activeConfigId: null },
  claude: { configs: [], activeConfigId: null },
  contextModelIds: []
};

// 生成简单 ID
function genId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// 确保数据目录和文件存在
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(DATA_FILE)) {
    fs.writeFileSync(DATA_FILE, JSON.stringify(DEFAULT_DATA, null, 2), 'utf-8');
  }
}

// ====== 向后兼容：旧数据迁移 ======
function migrateData(data) {
  ['codex', 'claude'].forEach(cat => {
    const c = data[cat];
    if (!c) {
      data[cat] = { configs: [], activeConfigId: null };
      return;
    }
    // 旧格式：{ activeModelId, modelIds } → 新格式：{ configs, activeConfigId }（不保留旧模型数据）
    if (c.modelIds && !c.configs) {
      data[cat] = { configs: [], activeConfigId: null };
    }
  });
  return data;
}

// 读取全部数据
function readData() {
  ensureDataFile();
  const raw = fs.readFileSync(DATA_FILE, 'utf-8');
  let data = JSON.parse(raw);
  // 检测是否需要迁移旧格式
  const needsMigration = ['codex', 'claude'].some(cat =>
    data[cat] && data[cat].modelIds !== undefined && !data[cat].configs
  );
  if (needsMigration) {
    data = migrateData(data);
    writeData(data);  // 立即持久化新格式
  }
  return data;
}

// 写入全部数据
function writeData(data) {
  ensureDataFile();
  const tmpFile = DATA_FILE + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(data, null, 2), 'utf-8');
  fs.renameSync(tmpFile, DATA_FILE);
}

// ====== URL 拼接（参考 ccswitch 的 build_url 逻辑） ======
// 端点使用标准路径 /v1/chat/completions、/v1/messages、/v1/models
// 如果 baseUrl 已有版本路径（如 /v1、/v4），自动去重避免拼接冗余
function buildApiUrl(baseUrl, endpointPath) {
  let clean = baseUrl.replace(/\/+$/, '');
  // 剥离已有端点路径（向后兼容：用户填了完整 chat 端点）
  clean = clean.replace(/\/(v\d+\/)?(chat\/completions|messages|responses)$/, '');
  // 剥离版本后缀（避免 base/v1 + /v1/chat/completions → base/v1/v1/chat/completions）
  clean = clean.replace(/\/v\d+$/, '');
  return `${clean}${endpointPath}`;
}

// ====== Provider CRUD ======

function getProviders() {
  return readData().providers;
}

function addProvider({ name, apiBaseUrl, apiKey, protocol }) {
  const data = readData();
  if (data.providers.find(p => p.name === name)) {
    throw new Error(`API 源 "${name}" 已存在`);
  }
  const provider = { id: genId('p'), name, apiBaseUrl, apiKey, protocol };
  data.providers.push(provider);
  writeData(data);
  return provider;
}

function updateProvider(id, { name, apiBaseUrl, apiKey, protocol }) {
  const data = readData();
  const idx = data.providers.findIndex(p => p.id === id);
  if (idx === -1) throw new Error(`Provider ${id} 不存在`);
  if (name !== undefined) data.providers[idx].name = name;
  if (apiBaseUrl !== undefined) data.providers[idx].apiBaseUrl = apiBaseUrl;
  if (apiKey !== undefined) data.providers[idx].apiKey = apiKey;
  if (protocol !== undefined) data.providers[idx].protocol = protocol;
  writeData(data);
  return data.providers[idx];
}

function deleteProvider(id) {
  const data = readData();
  // 删除该 Provider 下的所有模型
  const modelIdsToRemove = data.models.filter(m => m.providerId === id).map(m => m.id);
  data.models = data.models.filter(m => m.providerId !== id);
  // 从所有分类的配置中移除关联模型
  ['codex', 'claude'].forEach(cat => {
    if (!data[cat] || !data[cat].configs) return;
    data[cat].configs.forEach(cfg => {
      cfg.modelIds = cfg.modelIds.filter(mid => !modelIdsToRemove.includes(mid));
    });
  });
  data.providers = data.providers.filter(p => p.id !== id);
  writeData(data);
}

// ====== Model CRUD ======

function getModels(providerId) {
  return readData().models.filter(m => m.providerId === providerId);
}

function addModel(providerId, name) {
  const data = readData();
  if (!data.providers.find(p => p.id === providerId)) {
    throw new Error(`Provider ${providerId} 不存在`);
  }
  const model = { id: genId('m'), providerId, name };
  data.models.push(model);
  writeData(data);
  return model;
}

function deleteModel(id) {
  const data = readData();
  data.models = data.models.filter(m => m.id !== id);
  // 从所有配置中移除
  ['codex', 'claude'].forEach(cat => {
    if (!data[cat] || !data[cat].configs) return;
    data[cat].configs.forEach(cfg => {
      cfg.modelIds = cfg.modelIds.filter(mid => mid !== id);
    });
  });
  writeData(data);
}

// 根据模型 ID 获取模型信息（含关联的 Provider）
function getModelWithProvider(modelId) {
  const data = readData();
  const model = data.models.find(m => m.id === modelId);
  if (!model) return null;
  const provider = data.providers.find(p => p.id === model.providerId);
  return { ...model, provider: provider || null };
}

// 根据名称查找 Provider
function findProviderByName(name) {
  return readData().providers.find(p => p.name === name) || null;
}

function findProviderById(id) {
  return readData().providers.find(p => p.id === id) || null;
}

// 生成模型的路由键：providerName/modelName
function modelRoutingKey(model) {
  const provider = model.provider || findProviderById(model.providerId);
  return `${provider.name}/${model.name}`;
}

// ====== 1M 上下文模型管理 ======

// 获取所有 1M 上下文模型（含完整模型和 Provider 信息）
function getContextModels() {
  const data = readData();
  const ids = data.contextModelIds || [];
  return ids.map(mid => {
    const model = data.models.find(m => m.id === mid);
    if (!model) return null;
    const provider = data.providers.find(p => p.id === model.providerId);
    return { ...model, provider: provider || null };
  }).filter(Boolean);
}

// 添加模型到 1M 上下文列表
function addContextModel(modelId) {
  const data = readData();
  if (!data.models.find(m => m.id === modelId)) {
    throw new Error(`模型 ${modelId} 不存在`);
  }
  if (!data.contextModelIds) data.contextModelIds = [];
  if (!data.contextModelIds.includes(modelId)) {
    data.contextModelIds.push(modelId);
  }
  writeData(data);
}

// 从 1M 上下文列表移除模型
function removeContextModel(modelId) {
  const data = readData();
  if (!data.contextModelIds) return;
  data.contextModelIds = data.contextModelIds.filter(id => id !== modelId);
  writeData(data);
}

// 检查模型是否在 1M 上下文列表中
function isContextModel(modelId) {
  const data = readData();
  return (data.contextModelIds || []).includes(modelId);
}

// ====== 配置 CRUD ======

// 创建配置
function addConfig(category, name) {
  const data = readData();
  if (!data[category]) throw new Error(`分类 ${category} 不存在`);
  if (data[category].configs.find(c => c.name === name)) {
    throw new Error(`配置 "${name}" 已存在`);
  }
  const config = { id: genId('cfg'), name, modelIds: [], createdAt: Date.now() };
  data[category].configs.push(config);
  // 如果是第一个配置，自动激活
  if (!data[category].activeConfigId) {
    data[category].activeConfigId = config.id;
  }
  writeData(data);
  return config;
}

// 删除配置
function deleteConfig(category, configId) {
  const data = readData();
  if (!data[category]) throw new Error(`分类 ${category} 不存在`);
  data[category].configs = data[category].configs.filter(c => c.id !== configId);
  if (data[category].activeConfigId === configId) {
    data[category].activeConfigId = data[category].configs[0]?.id || null;
  }
  writeData(data);
}

// 重命名配置
function renameConfig(category, configId, name) {
  const data = readData();
  if (!data[category]) throw new Error(`分类 ${category} 不存在`);
  const cfg = data[category].configs.find(c => c.id === configId);
  if (!cfg) throw new Error(`配置 ${configId} 不存在`);
  cfg.name = name;
  writeData(data);
  return cfg;
}

// 向配置中添加模型
// codex: 单模型，直接替换
// claude: slotIndex 指定槽位（0=主模型, 1=Haiku, 2=Sonnet, 3=Opus），默认追加
function addModelToConfig(category, configId, modelId, slotIndex) {
  const data = readData();
  if (!data[category]) throw new Error(`分类 ${category} 不存在`);
  const cfg = data[category].configs.find(c => c.id === configId);
  if (!cfg) throw new Error(`配置 ${configId} 不存在`);
  if (!data.models.find(m => m.id === modelId)) throw new Error(`模型 ${modelId} 不存在`);
  if (category === 'codex') {
    cfg.modelIds = [modelId];
  } else if (category === 'claude') {
    const idx = typeof slotIndex === 'number' && slotIndex >= 0 && slotIndex < 4 ? slotIndex : null;
    if (idx !== null) {
      // 确保数组足够长
      while (cfg.modelIds.length <= idx) cfg.modelIds.push('');
      cfg.modelIds[idx] = modelId;
    } else {
      if (cfg.modelIds.length >= 4) throw new Error('CC 配置最多 4 个模型');
      if (!cfg.modelIds.includes(modelId)) {
        cfg.modelIds.push(modelId);
      }
    }
  } else {
    if (!cfg.modelIds.includes(modelId)) {
      cfg.modelIds.push(modelId);
    }
  }
  writeData(data);
}

// 从配置中移除模型
// claude: slotIndex 指定清空哪个槽位
function removeModelFromConfig(category, configId, modelId, slotIndex) {
  const data = readData();
  if (!data[category]) return;
  const cfg = data[category].configs.find(c => c.id === configId);
  if (!cfg) return;
  if (category === 'claude' && typeof slotIndex === 'number' && slotIndex >= 0 && slotIndex < cfg.modelIds.length) {
    cfg.modelIds[slotIndex] = '';
  } else {
    cfg.modelIds = cfg.modelIds.filter(mid => mid !== modelId);
  }
  writeData(data);
}

// 激活配置（仅改数据，不写文件；写文件由 standalone.js 的 set-active 端点触发）
function setActiveConfig(category, configId) {
  const data = readData();
  if (!data[category]) throw new Error(`分类 ${category} 不存在`);
  if (!data[category].configs.find(c => c.id === configId)) {
    throw new Error(`配置 ${configId} 不存在`);
  }
  data[category].activeConfigId = configId;
  writeData(data);
}

// 获取所有配置（含模型详情）
function getConfigs(category) {
  const data = readData();
  if (!data[category]) return [];
  const cat = data[category];
  return cat.configs.map(cfg => ({
    ...cfg,
    isActive: cfg.id === cat.activeConfigId,
    models: cfg.modelIds
      .map(mid => {
        const model = data.models.find(m => m.id === mid);
        if (!model) return null;
        const provider = data.providers.find(p => p.id === model.providerId);
        return { ...model, provider: provider || null };
      })
      .filter(Boolean)
  }));
}

// 获取激活的配置
function getActiveConfig(category) {
  const data = readData();
  const cat = data[category];
  if (!cat || !cat.activeConfigId) return null;
  const cfg = cat.configs.find(c => c.id === cat.activeConfigId);
  if (!cfg) return null;
  return {
    ...cfg,
    isActive: true,
    models: cfg.modelIds
      .map(mid => {
        const model = data.models.find(m => m.id === mid);
        if (!model) return null;
        const provider = data.providers.find(p => p.id === model.providerId);
        return { ...model, provider: provider || null };
      })
      .filter(Boolean)
  };
}

// ====== 路由解析（基于激活配置） ======

// 根据路由键解析 Provider 和模型（仅在激活配置的 modelIds 中查找）
function resolveRoutingKey(routingKey, category) {
  const data = readData();
  const idx = routingKey.indexOf('/');
  if (idx === -1) return null;
  const providerName = routingKey.substring(0, idx);
  const modelName = routingKey.substring(idx + 1);
  const cat = data[category];
  if (!cat || !cat.activeConfigId) return null;
  const activeCfg = cat.configs.find(c => c.id === cat.activeConfigId);
  if (!activeCfg) return null;
  // 在激活配置的 modelIds 中查找
  const matchingProviders = data.providers.filter(p => p.name === providerName);
  for (const provider of matchingProviders) {
    const model = data.models.find(m =>
      m.providerId === provider.id &&
      m.name === modelName &&
      activeCfg.modelIds.includes(m.id)
    );
    if (model) return { provider, model };
  }
  return null;
}

// 获取激活配置下所有模型的路由键列表
function getCategoryRoutingKeys(category) {
  const activeCfg = getActiveConfig(category);
  if (!activeCfg) return [];
  return activeCfg.models.map(m => modelRoutingKey(m));
}

// ====== 兼容旧 API（委托到激活配置） ======

// 返回激活配置下的模型列表（含 isActive 标记，首个模型标记为 "当前"）
function getCategoryModels(category) {
  const activeCfg = getActiveConfig(category);
  if (!activeCfg) return [];
  return activeCfg.models.map((m, i) => ({ ...m, isActive: i === 0 }));
}

// 向激活配置添加模型（需要先有激活的配置）
function addModelToCategory(category, modelId) {
  const data = readData();
  if (!data[category]) throw new Error(`分类 ${category} 不存在`);
  if (!data.models.find(m => m.id === modelId)) throw new Error(`模型 ${modelId} 不存在`);
  const activeCfg = data[category].configs.find(c => c.id === data[category].activeConfigId);
  if (!activeCfg) throw new Error(`分类 ${category} 下没有激活的配置，请先创建配置`);
  if (!activeCfg.modelIds.includes(modelId)) {
    activeCfg.modelIds.push(modelId);
  }
  writeData(data);
}

// 从激活配置移除模型
function removeModelFromCategory(category, modelId) {
  const data = readData();
  if (!data[category] || !data[category].activeConfigId) return;
  const activeCfg = data[category].configs.find(c => c.id === data[category].activeConfigId);
  if (!activeCfg) return;
  activeCfg.modelIds = activeCfg.modelIds.filter(mid => mid !== modelId);
  writeData(data);
}

// 设置激活模型（旧 API，保留但无实际操作；改为设置激活配置才有意义）
function setActiveModel(category, modelId) {
  // 旧 API 兼容：不做任何操作，配置级别的激活才有意义
}

// 获取激活模型（返回激活配置下的第一个模型）
function getActiveModel(category) {
  const models = getCategoryModels(category);
  return models[0] || null;
}

// ====== 用量统计 ======

function ensureUsageFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(USAGE_FILE)) fs.writeFileSync(USAGE_FILE, '[]', 'utf-8');
}

function logUsage(record) {
  ensureUsageFile();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
  } catch {
    data = [];
  }
  data.push({
    timestamp: record.timestamp || Date.now(),
    model: record.model,
    category: record.category,
    inputTokens: record.inputTokens || 0,
    cachedInputTokens: record.cachedInputTokens || 0,
    outputTokens: record.outputTokens || 0,
    incomplete: !!record.incomplete
  });
  // 保留最近 90 天
  const cutoff = Date.now() - 90 * 24 * 60 * 60 * 1000;
  const filtered = data.filter(r => r.timestamp >= cutoff);
  fs.writeFileSync(USAGE_FILE, JSON.stringify(filtered), 'utf-8');
}

function getUsage(range) {
  ensureUsageFile();
  let data;
  try {
    data = JSON.parse(fs.readFileSync(USAGE_FILE, 'utf-8'));
  } catch {
    data = [];
  }
  const now = Date.now();
  let cutoff;
  if (range === 'today') {
    // 当天 0:00:00 ~ 23:59:59
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    cutoff = d.getTime();
  } else {
    const rangeMs = {
      '7d': 7 * 24 * 60 * 60 * 1000,
      '30d': 30 * 24 * 60 * 60 * 1000
    }[range] || (24 * 60 * 60 * 1000);
    cutoff = now - rangeMs;
  }
  return data.filter(r => r.timestamp >= cutoff);
}

// 获取某模型的详细记录（分页），最多 1000 条，按时间由新到旧
function getUsageDetail(model, range, page, pageSize) {
  const records = getUsage(range).filter(r => r.model === model);
  records.sort((a, b) => b.timestamp - a.timestamp);
  const total = records.length;
  const maxRecords = 1000;
  const clampedTotal = Math.min(total, maxRecords);
  const ps = Math.min(pageSize || 100, 100);
  const maxPage = Math.ceil(clampedTotal / ps) || 1;
  const p = Math.min(Math.max(page || 1, 1), maxPage);
  const offset = (p - 1) * ps;
  return {
    model,
    records: records.slice(offset, offset + ps),
    total: clampedTotal,
    page: p,
    pageSize: ps,
    maxPage
  };
}

module.exports = {
  // Provider
  getProviders, addProvider, updateProvider, deleteProvider, findProviderByName,
  // Model
  getModels, addModel, deleteModel, getModelWithProvider,
  // 1M 上下文模型
  getContextModels, addContextModel, removeContextModel, isContextModel,
  // Config（新）
  addConfig, deleteConfig, renameConfig,
  addModelToConfig, removeModelFromConfig,
  setActiveConfig, getConfigs, getActiveConfig,
  // Category（兼容旧 API）
  getCategoryModels, addModelToCategory, removeModelFromCategory, setActiveModel, getActiveModel,
  // 路由键
  modelRoutingKey, resolveRoutingKey, getCategoryRoutingKeys,
  // 用量统计
  logUsage, getUsage, getUsageDetail,
  // 工具
  buildApiUrl, readData, writeData, DATA_DIR
};

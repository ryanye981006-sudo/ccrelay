// REST API 适配层：替代 Electron IPC，统一接口

const API_BASE = 'http://127.0.0.1:18900/api';

async function request(method, path, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${API_BASE}${path}`, opts);
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || res.statusText);
  }
  return res.json();
}

// Provider CRUD
export const getProviders = () => request('GET', '/providers');
export const addProvider = (data) => request('POST', '/providers', data);
export const updateProvider = (id, data) => request('PUT', `/providers/${id}`, data);
export const deleteProvider = (id) => request('DELETE', `/providers/${id}`);
export const testConnection = (providerId) => request('POST', '/test-connection', { providerId });

// Model CRUD
export const getModels = (providerId) => request('GET', `/models/${providerId}`);
export const addModel = (providerId, name) => request('POST', '/models', { providerId, name });
export const deleteModel = (id) => request('DELETE', `/models/${id}`);

// 模型获取/验证
export const fetchModels = (providerId) => request('POST', '/fetch-models', { providerId });
export const verifyModel = (providerId, modelName) => request('POST', '/verify-model', { providerId, modelName });

// 配置 CRUD
export const getConfigs = (category) => request('GET', `/config/${category}`);
export const addConfig = (category, name) => request('POST', '/config/add', { category, name });
export const deleteConfig = (category, configId) => request('POST', '/config/delete', { category, configId });
export const renameConfig = (category, configId, name) => request('POST', '/config/rename', { category, configId, name });
export const addModelToConfig = (category, configId, modelId, slotIndex) => request('POST', '/config/add-model', { category, configId, modelId, slotIndex });
export const removeModelFromConfig = (category, configId, modelId, slotIndex) => request('POST', '/config/remove-model', { category, configId, modelId, slotIndex });
export const setActiveConfig = (category, configId) => request('POST', '/config/set-active', { category, configId });

// 代理状态
export const getProxyStatus = () => request('GET', '/proxy-status');

// 1M 上下文模型管理
export const getContextModels = () => request('GET', '/context-models');
export const addContextModel = (modelId) => request('POST', '/context-models', { modelId });
export const removeContextModel = (modelId) => request('DELETE', `/context-models/${modelId}`);

// 用量统计
export const getUsage = (range) => request('GET', `/usage?range=${range}`);
export const getUsageDetail = (modelKey, range, page, pageSize) =>
  request('GET', `/usage/${encodeURIComponent(modelKey)}?range=${range}&page=${page}&pageSize=${pageSize}`);

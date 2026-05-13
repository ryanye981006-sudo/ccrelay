// 预加载脚本：通过 contextBridge 暴露 IPC 接口给渲染进程

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('ccrelay', {
  // Provider CRUD
  getProviders: () => ipcRenderer.invoke('get-providers'),
  addProvider: (data) => ipcRenderer.invoke('add-provider', data),
  updateProvider: (id, data) => ipcRenderer.invoke('update-provider', id, data),
  deleteProvider: (id) => ipcRenderer.invoke('delete-provider', id),
  testConnection: (id) => ipcRenderer.invoke('test-connection', id),

  // Model CRUD
  getModels: (providerId) => ipcRenderer.invoke('get-models', providerId),
  addModel: (providerId, name) => ipcRenderer.invoke('add-model', providerId, name),
  deleteModel: (id) => ipcRenderer.invoke('delete-model', id),

  // Category 操作
  getCategoryModels: (category) => ipcRenderer.invoke('get-category-models', category),
  addModelToCategory: (category, modelId) => ipcRenderer.invoke('add-model-to-category', category, modelId),
  removeModelFromCategory: (category, modelId) => ipcRenderer.invoke('remove-model-from-category', category, modelId),
  setActiveModel: (category, modelId) => ipcRenderer.invoke('set-active-model', category, modelId),

  // 配置写入
  applyCodexConfig: () => ipcRenderer.invoke('apply-codex-config'),

  // 代理状态
  getProxyStatus: () => ipcRenderer.invoke('get-proxy-status'),
});

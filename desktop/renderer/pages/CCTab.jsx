import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import { modelDisplayName } from '../App';

const CC_SLOTS = [
  { index: 0, label: '主模型', key: 'ANTHROPIC_MODEL' },
  { index: 1, label: 'Haiku', key: 'ANTHROPIC_DEFAULT_HAIKU_MODEL' },
  { index: 2, label: 'Sonnet', key: 'ANTHROPIC_DEFAULT_SONNET_MODEL' },
  { index: 3, label: 'Opus', key: 'ANTHROPIC_DEFAULT_OPUS_MODEL' },
];

const CATEGORY = 'claude';

const s = {
  page: { maxWidth: 720 },
  title: { fontSize: 18, fontWeight: 600, marginBottom: 16 },
  cfgCard: { background: '#1f2133', borderRadius: 8, border: '1px solid #2f3346', marginBottom: 12, overflow: 'hidden' },
  cfgCardActive: { background: '#1f2133', borderRadius: 8, border: '2px solid #7dcfff', marginBottom: 12, overflow: 'hidden' },
  cfgHeader: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 16px' },
  cfgName: { fontSize: 15, fontWeight: 600, color: '#c0caf5' },
  cfgMeta: { fontSize: 12, color: '#787c99', marginTop: 2 },
  activeBadge: { display: 'inline-block', background: '#7dcfff', color: '#1a1b26', padding: '1px 8px', borderRadius: 3, fontSize: 10, fontWeight: 600, marginLeft: 8 },
  cfgBody: { padding: '0 16px 12px 16px', borderTop: '1px solid #2f3346' },
  slotRow: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #252837' },
  slotLabel: { fontSize: 11, color: '#787c99', width: 70, flexShrink: 0 },
  slotModel: { fontSize: 13, color: '#c0caf5', flex: 1 },
  slotEmpty: { fontSize: 12, color: '#5a5f7f', flex: 1, fontStyle: 'italic' },
  btn: { padding: '6px 14px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  btnPri: { background: '#7dcfff', color: '#1a1b26' },
  btnOut: { background: 'transparent', color: '#7dcfff', border: '1px solid #7dcfff' },
  btnDgr: { background: 'transparent', color: '#f7768e', border: '1px solid #f7768e' },
  btnSm: { padding: '3px 10px', fontSize: 11, background: 'transparent', color: '#f7768e', border: '1px solid #3b3f5c', borderRadius: 3, cursor: 'pointer' },
  btnSmPri: { padding: '3px 10px', fontSize: 11, background: '#7dcfff', color: '#1a1b26', border: 'none', borderRadius: 3, cursor: 'pointer' },
  btnSmOut: { padding: '3px 10px', fontSize: 11, background: 'transparent', color: '#7dcfff', border: '1px solid #7dcfff', borderRadius: 3, cursor: 'pointer' },
  btnGroup: { display: 'flex', gap: 6 },
  hint: { fontSize: 12, color: '#787c99', marginTop: 16, fontStyle: 'italic' },
  empty: { color: '#787c99', textAlign: 'center', padding: 40 },
  modalOver: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: '#1f2133', borderRadius: 10, border: '1px solid #2f3346', padding: 24, width: 460, maxHeight: '70vh', overflow: 'auto' },
  modalTl: { fontSize: 16, fontWeight: 600, marginBottom: 16 },
  pickItem: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 12px', background: '#252837', borderRadius: 6, marginBottom: 6, cursor: 'pointer' },
  pickItemName: { fontSize: 13, color: '#c0caf5' },
  pickItemProvider: { fontSize: 11, color: '#787c99' },
  input: { width: '100%', padding: '8px 10px', background: '#16161e', border: '1px solid #2f3346', borderRadius: 4, color: '#c0caf5', fontSize: 13, marginBottom: 10, outline: 'none' },
  label: { fontSize: 12, color: '#787c99', marginBottom: 4, display: 'block' },
  portHint: { fontSize: 11, color: '#bb9af7', marginTop: 8, padding: '8px 12px', background: '#1f1a33', borderRadius: 4, border: '1px solid #2f3346' },
};

export default function CCTab() {
  const [configs, setConfigs] = useState([]);
  const [expandedId, setExpandedId] = useState(null);

  // 新建配置弹窗
  const [showNewCfg, setShowNewCfg] = useState(false);
  const [newCfgName, setNewCfgName] = useState('');

  // 选择模型弹窗（需要指定 slotIndex）
  const [showPickModel, setShowPickModel] = useState(false);
  const [pickTargetCfgId, setPickTargetCfgId] = useState(null);
  const [pickSlotIndex, setPickSlotIndex] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);

  const loadData = useCallback(async () => {
    const [cfgs] = await Promise.all([
      api.getConfigs(CATEGORY),
    ]);
    setConfigs(cfgs);
  }, []);

  useEffect(() => { loadData(); }, [loadData]);

  // 获取某个模型 ID 对应的模型详情（含 provider）
  function getModelById(cfg, modelId) {
    if (!modelId || !cfg) return null;
    return cfg.models?.find(m => m.id === modelId) || null;
  }

  // 新建配置
  const handleAddConfig = async () => {
    if (!newCfgName.trim()) return;
    try {
      await api.addConfig(CATEGORY, newCfgName.trim());
      setNewCfgName('');
      setShowNewCfg(false);
      loadData();
    } catch { /* ignore duplicate */ }
  };

  // 删除配置
  const handleDeleteConfig = async (configId) => {
    await api.deleteConfig(CATEGORY, configId);
    if (expandedId === configId) setExpandedId(null);
    loadData();
  };

  // 启用配置
  const handleActivate = async (configId) => {
    await api.setActiveConfig(CATEGORY, configId);
    loadData();
  };

  // 切换展开
  const toggleExpand = (configId) => {
    setExpandedId(expandedId === configId ? null : configId);
  };

  // 打开模型选择弹窗（指定槽位）— 所有模型均可选，允许不同槽位选同一模型
  const openPickModel = async (configId, slotIndex) => {
    setPickTargetCfgId(configId);
    setPickSlotIndex(slotIndex);

    const providers = await api.getProviders();
    const all = [];
    for (const p of providers) {
      const models = await api.getModels(p.id);
      for (const m of models) {
        all.push({ ...m, provider: p });
      }
    }
    // 去重
    const seen = new Set();
    const unique = all.filter(m => { const k = m.id; if (seen.has(k)) return false; seen.add(k); return true; });
    setAvailableModels(unique);
    setShowPickModel(true);
  };

  // 选择模型到指定槽位
  const handlePickModelForSlot = async (modelId) => {
    await api.addModelToConfig(CATEGORY, pickTargetCfgId, modelId, pickSlotIndex);
    setShowPickModel(false);
    loadData();
  };

  // 从槽位移除模型
  const handleRemoveFromSlot = async (configId, modelId, slotIndex) => {
    await api.removeModelFromConfig(CATEGORY, configId, modelId, slotIndex);
    loadData();
  };

  const activeCfg = configs.find(c => c.isActive);
  const filledSlotCount = (cfg) => (cfg?.modelIds || []).filter(Boolean).length;

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={s.title}>Claude Code 配置</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button style={{ ...s.btn, ...s.btnOut }} onClick={() => setShowNewCfg(true)}>+ 新建配置</button>
        </div>
      </div>

      {/* 当前激活配置 */}
      {activeCfg ? (
        <div style={{ ...s.cfgCardActive, padding: 12, marginBottom: 16 }}>
          <span style={s.activeBadge}>当前使用</span>
          <span style={{ fontSize: 14, color: '#c0caf5', marginLeft: 8 }}>{activeCfg.name}</span>
          <span style={{ fontSize: 12, color: '#787c99', marginLeft: 8 }}>({filledSlotCount(activeCfg)}/4 个模型)</span>
        </div>
      ) : (
        <div style={{ ...s.cfgCard, padding: 16, marginBottom: 16, textAlign: 'center' }}>
          <span style={{ color: '#787c99' }}>暂无配置，请新建配置</span>
        </div>
      )}

      {/* 配置列表 */}
      {configs.map(cfg => (
        <div key={cfg.id} style={cfg.isActive ? s.cfgCardActive : s.cfgCard}>
          <div style={s.cfgHeader}>
            <div style={{ flex: 1, cursor: 'pointer' }} onClick={() => toggleExpand(cfg.id)}>
              <div style={{ display: 'flex', alignItems: 'center' }}>
                <span style={s.cfgName}>{cfg.name}</span>
                {cfg.isActive && <span style={s.activeBadge}>使用中</span>}
              </div>
              <div style={s.cfgMeta}>{filledSlotCount(cfg)}/4 个模型</div>
            </div>
            <div style={s.btnGroup}>
              {!cfg.isActive && (
                <button style={s.btnSmPri} onClick={() => handleActivate(cfg.id)}>启用</button>
              )}
              <button style={s.btnSm} onClick={() => handleDeleteConfig(cfg.id)}>删除</button>
            </div>
          </div>

          {/* 展开：4 个模型槽位 */}
          {expandedId === cfg.id && (
            <div style={s.cfgBody}>
              {CC_SLOTS.map(slot => {
                const modelId = cfg.modelIds?.[slot.index];
                const model = modelId ? getModelById(cfg, modelId) : null;
                return (
                  <div key={slot.index} style={s.slotRow}>
                    <span style={s.slotLabel}>{slot.label}</span>
                    {model ? (
                      <>
                        <span style={s.slotModel}>{modelDisplayName(model)}</span>
                        <button style={s.btnSm} onClick={() => handleRemoveFromSlot(cfg.id, modelId, slot.index)}>移除</button>
                      </>
                    ) : (
                      <>
                        <span style={s.slotEmpty}>未选择</span>
                        <button style={s.btnSmOut} onClick={() => openPickModel(cfg.id, slot.index)}>选择</button>
                      </>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      ))}

      {configs.length === 0 && (
        <div style={s.empty}>暂无配置，点击「+ 新建配置」创建模型组合方案</div>
      )}

      <div style={s.hint}>
        提示: 新建配置 → 为 4 个槽位分别选择模型 → 点击「启用」自动写入 settings.json。重启 Claude Code 后生效。
      </div>
      <div style={s.portHint}>
        CC 代理地址: http://127.0.0.1:18888 — 启用配置后，ANTHROPIC_BASE_URL 自动指向此地址，重启 Claude Code 后生效
      </div>

      {/* 新建配置弹窗 */}
      {showNewCfg && (
        <div style={s.modalOver} onClick={(e) => { if (e.target === e.currentTarget) setShowNewCfg(false); }}>
          <div style={s.modal}>
            <div style={s.modalTl}>新建 Claude Code 配置</div>
            <label style={s.label}>配置名称</label>
            <input
              style={s.input}
              placeholder="如 日常工作、重度推理"
              value={newCfgName}
              onChange={e => setNewCfgName(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter') handleAddConfig(); }}
              autoFocus
            />
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 8 }}>
              <button style={{ ...s.btn, ...s.btnOut }} onClick={() => setShowNewCfg(false)}>取消</button>
              <button style={{ ...s.btn, ...s.btnPri }} onClick={handleAddConfig}>创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 选择模型弹窗 */}
      {showPickModel && (
        <div style={s.modalOver} onClick={(e) => { if (e.target === e.currentTarget) setShowPickModel(false); }}>
          <div style={s.modal}>
            <div style={s.modalTl}>选择模型 — {CC_SLOTS.find(s => s.index === pickSlotIndex)?.label}</div>
            {availableModels.length === 0 ? (
              <div style={{ color: '#787c99', padding: 20, textAlign: 'center' }}>
                没有可用的模型，请先在「API 源」中添加
              </div>
            ) : (
              availableModels.map(m => (
                <div key={m.id} style={s.pickItem} onClick={() => handlePickModelForSlot(m.id)}>
                  <div>
                    <div style={s.pickItemName}>{modelDisplayName(m)}</div>
                    <div style={s.pickItemProvider}>{m.provider?.apiBaseUrl}</div>
                  </div>
                  <span style={{ color: '#7dcfff', fontSize: 18 }}>+</span>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

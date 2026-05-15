import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';
import { modelDisplayName } from '../App';

const s = {
  page: { maxWidth: 720 },
  title: { fontSize: 18, fontWeight: 600, marginBottom: 16 },
  card: { background: '#1f2133', borderRadius: 8, border: '1px solid #2f3346', marginBottom: 12, overflow: 'hidden' },
  table: { width: '100%', borderCollapse: 'collapse' },
  th: { textAlign: 'left', padding: '10px 16px', fontSize: 11, color: '#787c99', borderBottom: '1px solid #2f3346', textTransform: 'uppercase', letterSpacing: 0.5 },
  td: { padding: '10px 16px', fontSize: 13, borderBottom: '1px solid #252837' },
  btn: { padding: '6px 14px', borderRadius: 4, border: 'none', cursor: 'pointer', fontSize: 12, fontWeight: 500 },
  btnPri: { background: '#7dcfff', color: '#1a1b26' },
  btnDgr: { background: 'transparent', color: '#f7768e', border: '1px solid #f7768e' },
  btnOut: { background: 'transparent', color: '#7dcfff', border: '1px solid #7dcfff' },
  btnSm: { padding: '3px 8px', fontSize: 11, background: 'transparent', color: '#f7768e', border: '1px solid #3b3f5c', borderRadius: 3, cursor: 'pointer' },
  modalOver: { position: 'fixed', top: 0, left: 0, right: 0, bottom: 0, background: 'rgba(0,0,0,0.6)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 100 },
  modal: { background: '#1f2133', borderRadius: 10, border: '1px solid #2f3346', padding: 24, width: 520, maxHeight: '80vh', overflow: 'auto' },
  modalTl: { fontSize: 16, fontWeight: 600, marginBottom: 16 },
  checkbox: { marginRight: 8, cursor: 'pointer' },
  modelRow: { display: 'flex', alignItems: 'center', padding: '8px 0', borderBottom: '1px solid #252837', cursor: 'pointer' },
  providerGroup: { marginBottom: 16 },
  providerLabel: { fontSize: 12, color: '#7dcfff', fontWeight: 600, marginBottom: 6, paddingLeft: 4 },
  hint: { fontSize: 11, color: '#787c99', marginTop: 4 },
  empty: { color: '#787c99', textAlign: 'center', padding: 40 },
};

export default function ModelsTab() {
  const [contextModels, setContextModels] = useState([]);
  const [showDialog, setShowDialog] = useState(false);
  const [allModels, setAllModels] = useState([]);
  const [selectedIds, setSelectedIds] = useState(new Set());
  const [loading, setLoading] = useState(false);

  const loadContextModels = useCallback(async () => {
    const list = await api.getContextModels();
    setContextModels(list);
  }, []);

  useEffect(() => { loadContextModels(); }, [loadContextModels]);

  // 收集所有 API 源下的模型用于选择弹窗
  const openAddDialog = async () => {
    setLoading(true);
    setShowDialog(true);
    setSelectedIds(new Set());
    try {
      const providers = await api.getProviders();
      const all = [];
      for (const p of providers) {
        const models = await api.getModels(p.id);
        for (const m of models) {
          all.push({ ...m, provider: p });
        }
      }
      setAllModels(all);
    } catch {}
    setLoading(false);
  };

  const toggleSelect = (modelId) => {
    const next = new Set(selectedIds);
    if (next.has(modelId)) next.delete(modelId);
    else next.add(modelId);
    setSelectedIds(next);
  };

  const batchAdd = async () => {
    for (const id of selectedIds) {
      try { await api.addContextModel(id); } catch {}
    }
    setShowDialog(false);
    loadContextModels();
  };

  const removeModel = async (modelId) => {
    await api.removeContextModel(modelId);
    loadContextModels();
  };

  // 按 Provider 分组
  const groupedModels = {};
  for (const m of allModels) {
    const pn = m.provider?.name || '未知';
    if (!groupedModels[pn]) groupedModels[pn] = [];
    groupedModels[pn].push(m);
  }

  return (
    <div style={s.page}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
        <div style={s.title}>模型管理</div>
        <button style={{ ...s.btn, ...s.btnPri }} onClick={openAddDialog}>+ 添加模型</button>
      </div>

      <div style={s.hint}>(1M 上下文：列表中的模型在 CC 配置中将追加 [1m] 后缀，启用 100 万 token 上下文窗口。其他模型默认 20 万。)</div>

      {contextModels.length === 0 ? (
        <div style={{ ...s.empty, marginTop: 24 }}>暂无 1M 上下文模型，点击上方按钮添加</div>
      ) : (
        <div style={s.card}>
          <table style={s.table}>
            <thead>
              <tr>
                <th style={s.th}>API 源</th>
                <th style={s.th}>模型名称</th>
                <th style={{ ...s.th, width: 80 }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {contextModels.map(m => (
                <tr key={m.id}>
                  <td style={s.td}>{m.provider?.name || '-'}</td>
                  <td style={s.td}>{m.name}</td>
                  <td style={s.td}>
                    <button style={s.btnSm} onClick={() => removeModel(m.id)}>移除</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* 添加模型弹窗 */}
      {showDialog && (
        <div style={s.modalOver} onClick={(e) => { if (e.target === e.currentTarget) setShowDialog(false); }}>
          <div style={s.modal}>
            <div style={s.modalTl}>选择 1M 上下文模型</div>
            <div style={{ ...s.hint, marginBottom: 16 }}>勾选的模型将被视为支持 1M 上下文窗口，在写入 CC 配置时追加 [1m] 后缀。</div>
            {loading ? (
              <div style={{ color: '#787c99', textAlign: 'center', padding: 30 }}>加载中...</div>
            ) : allModels.length === 0 ? (
              <div style={{ color: '#787c99', textAlign: 'center', padding: 30 }}>暂无可用模型，请先在 API 源中添加模型</div>
            ) : (
              <div style={{ maxHeight: 400, overflow: 'auto' }}>
                {Object.entries(groupedModels).map(([providerName, models]) => {
                  const contextIds = new Set(contextModels.map(m => m.id));
                  const available = models.filter(m => !contextIds.has(m.id));
                  if (available.length === 0) return null;
                  return (
                    <div key={providerName} style={s.providerGroup}>
                      <div style={s.providerLabel}>{providerName}</div>
                      {available.map(m => (
                        <div key={m.id} style={s.modelRow} onClick={() => toggleSelect(m.id)}>
                          <input type="checkbox" style={s.checkbox} checked={selectedIds.has(m.id)} onChange={() => toggleSelect(m.id)} />
                          <span style={{ fontSize: 13, flex: 1 }}>{m.name}</span>
                        </div>
                      ))}
                    </div>
                  );
                })}
              </div>
            )}
            <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
              <button style={{ ...s.btn, ...s.btnOut }} onClick={() => setShowDialog(false)}>取消</button>
              <button style={{ ...s.btn, ...s.btnPri }} onClick={batchAdd} disabled={selectedIds.size === 0}>
                添加选中 ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

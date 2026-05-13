import React, { useState, useEffect, useCallback } from 'react';
import * as api from '../api';

const RANGES = [
  { key: 'today', label: '当天' },
  { key: '7d', label: '近7天' },
  { key: '30d', label: '近30天' },
];

// Token 格式化：默认 K，>10000K → M，>10000M → B
function formatTokens(n) {
  if (!n || n === 0) return '0';
  if (n < 10000) return String(n);
  const k = n / 1000;
  if (k < 10000) return k.toFixed(1) + 'K';
  const m = k / 1000;
  if (m < 10000) return m.toFixed(2) + 'M';
  const b = m / 1000;
  return b.toFixed(2) + 'B';
}

function formatTime(ts) {
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

const s = {
  page: { maxWidth: 760 },
  title: { fontSize: 18, fontWeight: 600, marginBottom: 16 },
  // 时间范围
  rangeBar: { display: 'flex', gap: 6, marginBottom: 20 },
  rangeBtn: (active) => ({
    padding: '5px 16px', borderRadius: 4, border: active ? '2px solid #7dcfff' : '1px solid #2f3346',
    background: active ? '#1f2133' : 'transparent', color: active ? '#7dcfff' : '#787c99',
    cursor: 'pointer', fontSize: 12, fontWeight: active ? 600 : 400,
  }),
  // 模型卡片
  modelCard: {
    background: '#1f2133', borderRadius: 8, border: '1px solid #2f3346',
    padding: '14px 16px', marginBottom: 8, cursor: 'pointer',
    display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  },
  modelName: { fontSize: 14, fontWeight: 500, color: '#c0caf5' },
  modelMeta: { fontSize: 12, color: '#787c99', marginTop: 2 },
  modelTokens: { fontSize: 14, fontWeight: 600, color: '#7dcfff', textAlign: 'right' },
  modelCalls: { fontSize: 11, color: '#787c99', textAlign: 'right', marginTop: 2 },
  // 详情
  backBtn: { background: 'transparent', border: '1px solid #2f3346', color: '#7dcfff', padding: '4px 12px', borderRadius: 4, cursor: 'pointer', fontSize: 12, marginBottom: 16 },
  detailHeader: { marginBottom: 16 },
  detailTitle: { fontSize: 16, fontWeight: 600, color: '#c0caf5' },
  detailRange: { fontSize: 12, color: '#787c99', marginTop: 4 },
  // 汇总
  summary: { display: 'flex', gap: 16, marginBottom: 20, flexWrap: 'wrap' },
  summaryItem: { background: '#1f2133', borderRadius: 6, border: '1px solid #2f3346', padding: '12px 16px', minWidth: 100, flex: 1 },
  summaryLabel: { fontSize: 10, color: '#787c99', marginBottom: 4 },
  summaryVal: { fontSize: 16, fontWeight: 600, color: '#c0caf5' },
  // 表格
  table: { width: '100%', borderCollapse: 'collapse', fontSize: 12 },
  th: { textAlign: 'left', padding: '8px 10px', borderBottom: '1px solid #2f3346', color: '#787c99', fontSize: 11, fontWeight: 500 },
  td: { padding: '8px 10px', borderBottom: '1px solid #252837', color: '#c0caf5' },
  tdDim: { padding: '8px 10px', borderBottom: '1px solid #252837', color: '#787c99' },
  // 分页
  pager: { display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 6, marginTop: 16 },
  pageBtn: (active) => ({
    width: 28, height: 28, borderRadius: 4, border: active ? '1px solid #7dcfff' : '1px solid #2f3346',
    background: active ? '#1f2133' : 'transparent', color: active ? '#7dcfff' : '#787c99',
    cursor: 'pointer', fontSize: 11, display: 'flex', alignItems: 'center', justifyContent: 'center',
  }),
  pageInfo: { fontSize: 11, color: '#787c99', margin: '0 8px' },
  // 空
  empty: { color: '#787c99', textAlign: 'center', padding: 40 },
};

export default function UsageTab() {
  const [range, setRange] = useState('today');
  const [models, setModels] = useState([]);
  const [loading, setLoading] = useState(false);

  // 详情状态
  const [detailModel, setDetailModel] = useState(null);
  const [detailData, setDetailData] = useState(null);
  const [detailPage, setDetailPage] = useState(1);

  const loadModels = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.getUsage(range);
      setModels(data.models || []);
    } catch { setModels([]); }
    setLoading(false);
  }, [range]);

  useEffect(() => { loadModels(); }, [loadModels]);

  // 进入模型详情
  const openDetail = async (model) => {
    setDetailModel(model);
    setDetailPage(1);
    try {
      const data = await api.getUsageDetail(model.model, range, 1, 100);
      setDetailData(data);
    } catch { setDetailData(null); }
  };

  // 翻页
  const goPage = async (p) => {
    if (!detailModel) return;
    setDetailPage(p);
    try {
      const data = await api.getUsageDetail(detailModel.model, range, p, 100);
      setDetailData(data);
    } catch { setDetailData(null); }
  };

  const backToList = () => { setDetailModel(null); setDetailData(null); };

  // ====== 模型详情视图 ======
  if (detailModel) {
    return (
      <div style={s.page}>
        <button style={s.backBtn} onClick={backToList}>← 返回模型列表</button>
        <div style={s.detailHeader}>
          <div style={s.detailTitle}>{detailModel.model.replace('/', ' / ')}</div>
          <div style={s.detailRange}>
            {RANGES.find(r => r.key === range)?.label} &nbsp;·&nbsp;
            共 {detailData?.total || 0} 条记录
          </div>
        </div>

        {/* 汇总 */}
        <div style={s.summary}>
          <div style={s.summaryItem}>
            <div style={s.summaryLabel}>调用次数</div>
            <div style={s.summaryVal}>{detailModel.callCount}</div>
          </div>
          <div style={s.summaryItem}>
            <div style={s.summaryLabel}>输入 Tokens（含缓存）</div>
            <div style={s.summaryVal}>{formatTokens(detailModel.inputTokens)}</div>
          </div>
          <div style={s.summaryItem}>
            <div style={s.summaryLabel}>缓存输入 Tokens</div>
            <div style={s.summaryVal}>{formatTokens(detailModel.cachedInputTokens)}</div>
          </div>
          <div style={s.summaryItem}>
            <div style={s.summaryLabel}>输出 Tokens</div>
            <div style={s.summaryVal}>{formatTokens(detailModel.outputTokens)}</div>
          </div>
        </div>

        {/* 记录表格 */}
        {(!detailData || !detailData.records || detailData.records.length === 0) ? (
          <div style={s.empty}>暂无用量数据</div>
        ) : (
          <>
            <table style={s.table}>
              <thead>
                <tr>
                  <th style={s.th}>时间</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>输入 Tokens</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>缓存输入</th>
                  <th style={{ ...s.th, textAlign: 'right' }}>输出 Tokens</th>
                </tr>
              </thead>
              <tbody>
                {detailData.records.map((r, i) => (
                  <tr key={i}>
                    <td style={s.tdDim}>{formatTime(r.timestamp)}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>{formatTokens(r.inputTokens)}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>{formatTokens(r.cachedInputTokens)}</td>
                    <td style={{ ...s.td, textAlign: 'right' }}>{formatTokens(r.outputTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>

            {/* 分页 */}
            {detailData.maxPage > 1 && (
              <div style={s.pager}>
                <button style={s.pageBtn(false)} onClick={() => goPage(detailPage - 1)} disabled={detailPage <= 1}>‹</button>
                {Array.from({ length: detailData.maxPage }, (_, i) => i + 1).map(p => (
                  <button key={p} style={s.pageBtn(p === detailPage)} onClick={() => goPage(p)}>{p}</button>
                ))}
                <button style={s.pageBtn(false)} onClick={() => goPage(detailPage + 1)} disabled={detailPage >= detailData.maxPage}>›</button>
                <span style={s.pageInfo}>{detailPage} / {detailData.maxPage}</span>
              </div>
            )}
          </>
        )}
      </div>
    );
  }

  // ====== 模型列表视图 ======
  return (
    <div style={s.page}>
      <div style={s.title}>用量统计</div>

      {/* 时间范围选择器 */}
      <div style={s.rangeBar}>
        {RANGES.map(r => (
          <button
            key={r.key}
            style={s.rangeBtn(r.key === range)}
            onClick={() => setRange(r.key)}
          >{r.label}</button>
        ))}
      </div>

      {/* 模型列表 */}
      {loading ? (
        <div style={s.empty}>加载中...</div>
      ) : models.length === 0 ? (
        <div style={s.empty}>暂无用量数据</div>
      ) : (
        models.map(m => (
          <div key={m.model} style={s.modelCard} onClick={() => openDetail(m)}>
            <div>
              <div style={s.modelName}>{m.model.replace('/', ' / ')}</div>
              <div style={s.modelMeta}>调用 {m.callCount} 次</div>
            </div>
            <div>
              <div style={s.modelTokens}>{formatTokens(m.totalTokens)}</div>
              <div style={s.modelCalls}>总 tokens</div>
            </div>
          </div>
        ))
      )}
    </div>
  );
}

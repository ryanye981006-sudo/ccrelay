import React, { useState, useEffect } from 'react';
import { getProxyStatus } from './api';
import CCTab from './pages/CCTab';
import CodexTab from './pages/CodexTab';
import ProviderTab from './pages/ProviderTab';
import UsageTab from './pages/UsageTab';

const TABS = [
  { key: 'cc', label: 'CC' },
  { key: 'codex', label: 'Codex' },
  { key: 'provider', label: 'API 源' },
  { key: 'usage', label: '用量' },
];

// 模型显示名：API名称/模型名称
function modelDisplayName(model) {
  const providerName = model.provider?.name || '未知';
  return `${providerName} / ${model.name}`;
}

export { modelDisplayName };

export default function App() {
  const [activeTab, setActiveTab] = useState('cc');
  const [proxyStatus, setProxyStatus] = useState({ running: false, codexPort: 18889, ccPort: 18888 });

  useEffect(() => {
    getProxyStatus().then(setProxyStatus);
  }, []);

  const styles = {
    container: { display: 'flex', height: '100vh', flexDirection: 'column' },
    header: { height: 40, display: 'flex', alignItems: 'center', padding: '0 16px', borderBottom: '1px solid #2f3346', background: '#16161e', flexShrink: 0 },
    headerTitle: { fontSize: 14, fontWeight: 600, color: '#7dcfff' },
    body: { display: 'flex', flex: 1, overflow: 'hidden' },
    sidebar: { width: 80, background: '#16161e', borderRight: '1px solid #2f3346', display: 'flex', flexDirection: 'column', paddingTop: 8, flexShrink: 0 },
    tab: (active) => ({
      height: 44, display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 13, cursor: 'pointer', color: active ? '#7dcfff' : '#787c99',
      background: active ? '#1f2133' : 'transparent',
      borderLeft: active ? '3px solid #7dcfff' : '3px solid transparent',
      marginBottom: 2, userSelect: 'none',
    }),
    content: { flex: 1, overflow: 'auto', padding: 20 },
    statusBar: { height: 28, display: 'flex', alignItems: 'center', padding: '0 16px', borderTop: '1px solid #2f3346', background: '#16161e', fontSize: 12, color: '#787c99', gap: 16, flexShrink: 0 },
    dot: (running) => ({ width: 8, height: 8, borderRadius: '50%', background: running ? '#9ece6a' : '#f7768e', display: 'inline-block', marginRight: 6 }),
  };

  return (
    <div style={styles.container}>
      <div style={styles.header}>
        <span style={styles.headerTitle}>ClaudeRelay Desktop</span>
      </div>
      <div style={styles.body}>
        <div style={styles.sidebar}>
          {TABS.map(tab => (
            <div key={tab.key} style={styles.tab(activeTab === tab.key)} onClick={() => setActiveTab(tab.key)}>
              {tab.label}
            </div>
          ))}
        </div>
        <div style={styles.content}>
          {activeTab === 'cc' && <CCTab />}
          {activeTab === 'codex' && <CodexTab />}
          {activeTab === 'provider' && <ProviderTab />}
          {activeTab === 'usage' && <UsageTab />}
        </div>
      </div>
      <div style={styles.statusBar}>
        <span><span style={styles.dot(proxyStatus.running)}></span>代理 {proxyStatus.running ? '运行中' : '已停止'}</span>
        <span>CC: 127.0.0.1:{proxyStatus.ccPort}</span>
        <span>Codex: 127.0.0.1:{proxyStatus.codexPort}</span>
      </div>
    </div>
  );
}

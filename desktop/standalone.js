// ClaudeRelay Desktop — 独立服务器模式（免 Electron）
// 启动代理引擎 + Web 管理界面

process.env.NO_PROXY = 'localhost,127.0.0.1';

const fs = require('fs');
const path = require('path');
const { createCodexServer, createCCServer, stopServer } = require('./src-electron/proxy-engine');
const { createUIServer } = require('./src-electron/ui-server');

const CODEX_PORT = 18889;
const CC_PORT = 18888;
const UI_PORT = 18900;

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

  const uiServer = createUIServer(UI_PORT, CODEX_PORT, CC_PORT);
  await new Promise((resolve) => uiServer.listen(UI_PORT, '127.0.0.1', resolve));
  console.log(`[ui] 管理界面 → http://127.0.0.1:${UI_PORT}`);

  console.log('\n=== ClaudeRelay Desktop (独立版) ===');
  console.log(`CC 代理:    http://127.0.0.1:${CC_PORT}`);
  console.log(`Codex 代理: http://127.0.0.1:${CODEX_PORT}`);
  console.log(`管理界面:  http://127.0.0.1:${UI_PORT}`);
  console.log('按 Ctrl+C 退出\n');

  function shutdown() {
    console.log('\n[clauderelay] 正在关闭...');
    uiServer.close();
    Promise.all([stopServer(codexServer), stopServer(ccServer)]).then(() => {
      console.log('[clauderelay] 已退出');
      process.exit(0);
    });
  }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((e) => { console.error(e); process.exit(1); });

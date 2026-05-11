// CCRelay — Anthropic Messages / OpenAI Responses → Chat Completions 协议翻译代理

const fs = require('fs');
const path = require('path');
const { createServer } = require('./src/server');

// 读取配置
const configPath = path.resolve(__dirname, 'config.json');
let config;
try {
  const raw = fs.readFileSync(configPath, 'utf-8');
  config = JSON.parse(raw);
} catch (e) {
  console.error('无法读取 config.json:', e.message);
  process.exit(1);
}

// 校验必填字段
if (!config.backend?.url) {
  console.error('config.json 缺少 backend.url');
  process.exit(1);
}
if (!config.backend?.apiKey) {
  console.error('config.json 缺少 backend.apiKey');
  process.exit(1);
}

const servers = [];

// 启动 Claude Code 代理（Anthropic → Chat）
if (config.claude?.enabled) {
  const port = config.claude.port || 18888;
  const serverConfig = { models: config.claude.models || [] };
  const server = createServer(config, 'claude', serverConfig);
  server.listen(port, () => {
    console.log(`[claude] 代理已启动 → http://127.0.0.1:${port}  (Anthropic Messages → Chat)`);
  });
  servers.push(server);
}

// 启动 Codex 代理（Responses → Chat）
if (config.codex?.enabled) {
  const port = config.codex.port || 18889;
  const serverConfig = { models: config.codex.models || [] };
  const server = createServer(config, 'codex', serverConfig);
  server.listen(port, () => {
    console.log(`[codex] 代理已启动 → http://127.0.0.1:${port}  (Responses → Chat)`);
  });
  servers.push(server);
}

if (servers.length === 0) {
  console.error('配置中未启用任何代理（claude.enabled 和 codex.enabled 均为 false）');
  process.exit(1);
}

console.log(`[ccrelay] 后端 → ${config.backend.url}`);

// 优雅退出
function shutdown() {
  console.log('\n[ccrelay] 正在关闭...');
  let closed = 0;
  for (const s of servers) {
    s.close(() => { closed++; if (closed === servers.length) { console.log('[ccrelay] 已退出'); process.exit(0); } });
  }
  setTimeout(() => { console.log('[ccrelay] 强制退出'); process.exit(0); }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

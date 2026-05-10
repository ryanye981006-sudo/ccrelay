// CCRelay — Anthropic Messages ↔ OpenAI Chat Completions 协议翻译代理

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

const port = config.port || 18888;
const server = createServer(config);

server.listen(port, () => {
  console.log(`[ccrelay] 代理已启动 → http://127.0.0.1:${port}`);
  console.log(`[ccrelay] 后端 → ${config.backend.url}`);
  console.log(`[ccrelay] 端点 → POST http://127.0.0.1:${port}/v1/messages`);
});

// 优雅退出
function shutdown() {
  console.log('\n[ccrelay] 正在关闭...');
  server.close(() => {
    console.log('[ccrelay] 已退出');
    process.exit(0);
  });
  // 5 秒后强制退出
  setTimeout(() => {
    console.log('[ccrelay] 强制退出');
    process.exit(0);
  }, 5000);
}

process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

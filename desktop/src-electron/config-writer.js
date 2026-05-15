// 配置文件写入：Codex CLI 的 ~/.codex/config.toml

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// 设置 Windows 用户环境变量，确保 Codex (Go) 不通过代理连接本地地址
// Go 的 net/http 默认读取系统代理，NO_PROXY 告诉它哪些地址直连
function ensureNoProxy() {
  try {
    if (process.platform === 'win32') {
      execSync('setx NO_PROXY "localhost,127.0.0.1"', { timeout: 3000 });
    }
  } catch {
    // setx 可能因权限失败，不影响主流程
  }
}

// Codex CLI 配置文件路径
function getCodexConfigPath() {
  return path.join(os.homedir(), '.codex', 'config.toml');
}

// 默认模板（文件不存时创建）
const DEFAULT_TOML = `model_provider = "custom"
model = ""
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = false
base_url = "http://127.0.0.1:18889"
`;

function ensureConfigFile() {
  const configPath = getCodexConfigPath();
  const dir = path.dirname(configPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(configPath)) {
    fs.writeFileSync(configPath, DEFAULT_TOML, 'utf-8');
  }
  return configPath;
}

// 写入 Codex 配置：修改 model 和 base_url
// routingKey: "API源名称/模型名称"
// proxyPort: 代理端口
function writeCodexConfig(routingKey, proxyPort) {
  const configPath = ensureConfigFile();
  let content = fs.readFileSync(configPath, 'utf-8');

  // 替换 model 字段
  content = content.replace(/^model\s*=\s*".*"$/m, `model = "${routingKey}"`);

  // 替换 base_url 字段
  const baseUrl = `http://127.0.0.1:${proxyPort}`;
  content = content.replace(/^base_url\s*=\s*".*"$/m, `base_url = "${baseUrl}"`);

  // 原子写入
  const tmpFile = configPath + '.tmp';
  fs.writeFileSync(tmpFile, content, 'utf-8');
  fs.renameSync(tmpFile, configPath);

  // 设置 NO_PROXY，让本地请求绕过系统代理（Clash 等）
  ensureNoProxy();

  return { path: configPath, baseUrl, routingKey };
}

// 读取 Codex 配置
function readCodexConfig() {
  const configPath = getCodexConfigPath();
  if (!fs.existsSync(configPath)) return null;
  try {
    return fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }
}

module.exports = { writeCodexConfig, readCodexConfig, getCodexConfigPath, ensureConfigFile };

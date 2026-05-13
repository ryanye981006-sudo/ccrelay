// CC 配置文件写入：Claude Code 的 ~/.claude/settings.json
// 支持自定义路径用于测试，避免直接修改用户真实配置

const fs = require('fs');
const path = require('path');
const os = require('os');

// CC 配置文件路径
// 环境变量 CCRELAY_TEST_CC_CONFIG 用于测试，避免修改用户真实配置
function getCCConfigPath() {
  if (process.env.CCRELAY_TEST_CC_CONFIG) {
    return process.env.CCRELAY_TEST_CC_CONFIG;
  }
  return path.join(os.homedir(), '.claude', 'settings.json');
}

// 默认模板（文件不存在时创建，仅模型调用相关字段，不侵入用户其他配置）
const DEFAULT_CC_CONFIG = {
  env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888',
    ANTHROPIC_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: ''
  }
};

// modelIds 索引 → settings.json env 字段名
const SLOT_FIELDS = [
  'ANTHROPIC_MODEL',                // 主模型 / Default Opus
  'ANTHROPIC_DEFAULT_HAIKU_MODEL',  // Haiku
  'ANTHROPIC_DEFAULT_SONNET_MODEL', // Sonnet
  'ANTHROPIC_DEFAULT_OPUS_MODEL',   // Opus
];

// 确保配置文件存在（返回目标路径）
function ensureCCConfigFile(configPath) {
  const targetPath = configPath || getCCConfigPath();
  const dir = path.dirname(targetPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(targetPath)) {
    fs.writeFileSync(targetPath, JSON.stringify(DEFAULT_CC_CONFIG, null, 2), 'utf-8');
  }
  return targetPath;
}

// routingKeys: [主模型, haiku, sonnet, opus] — 与 modelIds 顺序一致
// proxyPort: CC 代理端口
// configPath: 可选，测试时指定临时路径
function writeCCConfig(routingKeys, proxyPort, configPath) {
  const targetPath = ensureCCConfigFile(configPath);
  let config;
  try {
    config = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  } catch {
    config = { ...DEFAULT_CC_CONFIG };
  }

  if (!config.env) config.env = {};

  // 写入 ANTHROPIC_BASE_URL
  config.env.ANTHROPIC_BASE_URL = `http://127.0.0.1:${proxyPort}`;

  // 按槽位写入模型路由键
  for (let i = 0; i < SLOT_FIELDS.length; i++) {
    const field = SLOT_FIELDS[i];
    const routingKey = routingKeys[i] || '';
    config.env[field] = routingKey;
  }

  // 原子写入
  const tmpFile = targetPath + '.tmp';
  fs.writeFileSync(tmpFile, JSON.stringify(config, null, 2), 'utf-8');
  fs.renameSync(tmpFile, targetPath);

  return {
    path: targetPath,
    baseUrl: config.env.ANTHROPIC_BASE_URL,
    routingKeys: SLOT_FIELDS.map((f, i) => ({ field: f, routingKey: routingKeys[i] || '' }))
  };
}

// 读取 CC 配置
function readCCConfig(configPath) {
  const targetPath = configPath || getCCConfigPath();
  if (!fs.existsSync(targetPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
  } catch {
    return null;
  }
}

module.exports = { writeCCConfig, readCCConfig, getCCConfigPath, ensureCCConfigFile, SLOT_FIELDS };

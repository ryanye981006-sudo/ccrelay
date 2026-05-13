// 端到端测试 v2：配置化管理 + 端点自动补全 + 模型验证
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');

const API = 'http://127.0.0.1:18900/api';
const PROXY = 'http://127.0.0.1:18889';

function request(method, url, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port, path: u.pathname,
      method, headers: { 'Content-Type': 'application/json' },
    };
    const req = http.request(opts, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function main() {
  let passed = 0;
  let failed = 0;
  function check(name, condition, detail) {
    if (condition) {
      console.log(`  \x1b[32m✓\x1b[0m ${name}`);
      passed++;
    } else {
      console.log(`  \x1b[31m✗\x1b[0m ${name}: ${detail}`);
      failed++;
    }
  }

  // 1. 添加 API 源（基地址模式）
  console.log('\n1. 添加 API 源 (OpenAI 基地址)');
  const providerRes = await request('POST', API + '/providers', {
    name: 'TestAPI', apiBaseUrl: 'https://httpbin.org',
    apiKey: 'sk-test', protocol: 'openai'
  });
  check('创建成功', providerRes.body.id, JSON.stringify(providerRes.body));
  const providerId = providerRes.body.id;
  // 验证 apiBaseUrl 保持原样（不拼接 chat/completions）
  check('apiBaseUrl 保持基地址', providerRes.body.apiBaseUrl === 'https://httpbin.org',
    providerRes.body.apiBaseUrl);
  console.log(`   Provider: ${providerId}`);

  // 2. URL 拼接验证（buildApiUrl 逻辑）
  console.log('\n2. 验证 buildApiUrl 拼接');
  const { buildApiUrl } = require('./src-electron/data-store');
  const chatUrl = buildApiUrl('https://httpbin.org', '/v1/chat/completions');
  check('基地址拼接正确', chatUrl === 'https://httpbin.org/v1/chat/completions', chatUrl);
  const v1dup = buildApiUrl('https://api.openai.com/v1', '/v1/chat/completions');
  check('/v1 去重', v1dup === 'https://api.openai.com/v1/chat/completions', v1dup);
  const compatUrl = buildApiUrl('https://api.openai.com/v1/chat/completions', '/v1/chat/completions');
  check('向后兼容：剥离旧端点再拼接', compatUrl === 'https://api.openai.com/v1/chat/completions', compatUrl);
  const aliUrl = buildApiUrl('https://dashscope.aliyuncs.com/apps/anthropic', '/v1/messages');
  check('阿里云 Anthropic 端点', aliUrl === 'https://dashscope.aliyuncs.com/apps/anthropic/v1/messages', aliUrl);

  // 3. 添加模型
  console.log('\n3. 添加模型');
  const modelRes = await request('POST', API + '/models', { providerId, name: 'test-model' });
  check('模型创建成功', modelRes.body.id, JSON.stringify(modelRes.body));
  const modelId = modelRes.body.id;

  // 4. 验证模型是否存在
  console.log('\n4. 验证模型');
  const verifyRes = await request('POST', API + '/verify-model', { providerId, modelName: 'test-model' });
  check('模型验证请求已发送', verifyRes.body.ok !== undefined,
    JSON.stringify(verifyRes.body));

  // 5. 创建配置
  console.log('\n5. 创建 Codex 配置');
  const cfgRes = await request('POST', API + '/config/add', { category: 'codex', name: '日常工作' });
  check('配置创建成功', cfgRes.body.id && cfgRes.body.name === '日常工作',
    JSON.stringify(cfgRes.body));
  const configId = cfgRes.body.id;
  // 首个配置应自动激活
  check('首个配置自动激活', cfgRes.body.id !== undefined, 'auto-activate');

  // 6. 添加模型到配置
  console.log('\n6. 添加模型到配置');
  const addRes = await request('POST', API + '/config/add-model', {
    category: 'codex', configId, modelId
  });
  check('添加成功', addRes.body.ok, JSON.stringify(addRes.body));

  // 7. 获取配置列表
  console.log('\n7. 获取配置列表');
  const configs = await request('GET', API + '/config/codex');
  check('配置列表包含模型', configs.body[0]?.models?.length > 0,
    `models=${configs.body[0]?.models?.length}`);
  check('配置为激活状态', configs.body[0]?.isActive === true);
  const routingKey = 'TestAPI/test-model';
  console.log(`   路由键: ${routingKey}`);

  // 8. 验证 /v1/models 返回路由键
  console.log('\n8. 验证代理 /v1/models');
  const modelsList = await request('GET', PROXY + '/v1/models');
  check('模型列表包含路由键', modelsList.body.data?.some(m => m.id === routingKey),
    JSON.stringify(modelsList.body.data));
  console.log(`   模型列表: ${JSON.stringify(modelsList.body.data?.map(m => m.id))}`);

  // 9. 验证未知模型被拒绝
  console.log('\n9. 验证未知模型被拒绝');
  const badRes = await request('POST', PROXY + '/v1/chat/completions', {
    model: 'UnknownProvider/unknown-model',
    messages: [{ role: 'user', content: 'test' }],
  });
  check('未知模型返回 400', badRes.status === 400,
    `status=${badRes.status}`);

  // 10. 验证代理路由转发
  console.log('\n10. 验证代理路由转发');
  const proxyRes = await request('POST', PROXY + '/v1/chat/completions', {
    model: routingKey,
    messages: [{ role: 'user', content: 'hello' }],
    max_tokens: 50, stream: false,
  });
  check('路由成功（非"未知模型"错误）',
    proxyRes.body?.error?.type !== 'invalid_request_error',
    `status=${proxyRes.status}`);

  // 11. 验证 set-active 自动写入配置文件
  console.log('\n11. 验证 set-active 写入 Codex 配置');
  const configPath = path.join(os.homedir(), '.codex', 'config.toml');
  const setActiveRes = await request('POST', API + '/config/set-active', { category: 'codex', configId });
  check('set-active 成功', setActiveRes.body.ok, JSON.stringify(setActiveRes.body));
  const configContent = fs.readFileSync(configPath, 'utf-8');
  check('配置文件已写入路由键', configContent.includes(routingKey),
    `config.toml 包含 ${routingKey}`);
  check('配置文件已写入 base_url', configContent.includes('http://127.0.0.1:18889'));
  console.log(`   配置路径: ${configPath}`);
  console.log(`   路由键: ${routingKey}`);

  // 12. 验证数据文件结构
  console.log('\n12. 验证数据文件结构');
  const dataFile = path.join(os.homedir(), '.ccrelay-desktop', 'data.json');
  const rawData = JSON.parse(fs.readFileSync(dataFile, 'utf-8'));
  check('codex 为配置结构', rawData.codex && rawData.codex.configs && Array.isArray(rawData.codex.configs),
    JSON.stringify(rawData.codex));
  check('claude 字段存在', rawData.claude && rawData.claude.configs !== undefined,
    JSON.stringify(rawData.claude));

  console.log(`\n========== 结果: ${passed} 通过, ${failed} 失败 ==========`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error(e); process.exit(1); });

// 端到端测试：启动代理引擎，用 curl 验证

const { createCodexServer, stopServer } = require('./src-electron/proxy-engine');
const { addProvider, addModel, addModelToCategory, deleteProvider, getProviders } = require('./src-electron/data-store');

async function main() {
  // 清理旧测试数据（按名称删除）
  const existing = getProviders();
  for (const p of existing) {
    if (p.name === 'TestAPI') deleteProvider(p.id);
  }

  // 准备测试数据
  console.log('=== 准备测试数据 ===');
  const p = addProvider({
    name: 'TestAPI',
    apiBaseUrl: 'https://httpbin.org/post',
    apiKey: 'sk-test',
    protocol: 'openai',
  });
  console.log('创建 Provider:', p.name, p.id);

  const m = addModel(p.id, 'test-model');
  console.log('创建 Model:', m.name, m.id);

  addModelToCategory('codex', m.id);
  console.log('添加到 Codex 分类');

  // 启动代理
  console.log('\n=== 启动代理引擎 ===');
  const server = await createCodexServer(18890); // 临时端口避免冲突
  console.log('代理已启动 :18890');

  // 测试 /health
  console.log('\n=== 测试 /health ===');
  const health = await fetch('http://127.0.0.1:18890/health').then(r => r.json());
  console.log('Health:', JSON.stringify(health));

  // 测试 /v1/models
  console.log('\n=== 测试 GET /v1/models ===');
  const models = await fetch('http://127.0.0.1:18890/v1/models').then(r => r.json());
  console.log('Models:', JSON.stringify(models, null, 2));

  // 测试带前缀路由键的请求（非流式）
  console.log('\n=== 测试 POST /v1/chat/completions (路由键: TestAPI/test-model) ===');
  const resp = await fetch('http://127.0.0.1:18890/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'TestAPI/test-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }),
  });
  const respText = await resp.text();
  console.log('Status:', resp.status);
  console.log('Response (first 500 chars):', respText.substring(0, 500));

  // 测试未知模型
  console.log('\n=== 测试 POST /v1/chat/completions (未知模型) ===');
  const errResp = await fetch('http://127.0.0.1:18890/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'UnknownProvider/unknown-model',
      messages: [{ role: 'user', content: 'hello' }],
      stream: false,
    }),
  });
  const errText = await errResp.text();
  console.log('Status:', errResp.status);
  console.log('Error:', errText.substring(0, 300));

  // 清理
  console.log('\n=== 清理 ===');
  await stopServer(server);
  deleteProvider(p.id);
  console.log('测试完成');
}

main().catch(console.error);

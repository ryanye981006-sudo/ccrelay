// CCRelay 单元测试 — 验证协议转换纯函数

const assert = require('assert');
const { anthropicToOpenAI } = require('../src/request');
const { openaiToAnthropic, mapFinishReason } = require('../src/response');
const { StreamTransformer } = require('../src/stream');

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}: ${e.message}`);
  }
}

// ===== request.js 测试 =====
console.log('\n📦 request.js — Anthropic → OpenAI');

test('system 字符串 → messages[0] role=system', () => {
  const result = anthropicToOpenAI({
    model: 'deepseek-v4-pro',
    system: 'You are helpful',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    max_tokens: 100,
  });
  assert.strictEqual(result.messages[0].role, 'system');
  assert.strictEqual(result.messages[0].content, 'You are helpful');
  assert.strictEqual(result.messages[1].role, 'user');
  assert.strictEqual(result.model, 'deepseek-v4-pro');
  assert.strictEqual(result.max_tokens, 100);
});

test('system 数组 → 拼接 text', () => {
  const result = anthropicToOpenAI({
    model: 'deepseek-v4-pro',
    system: [{ type: 'text', text: 'Rule 1' }, { type: 'text', text: 'Rule 2' }],
    messages: [{ role: 'user', content: 'hi' }],
  });
  assert.strictEqual(result.messages[0].content, 'Rule 1\nRule 2');
});

test('纯文本 user 消息 → 简化为 string', () => {
  const result = anthropicToOpenAI({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
  });
  assert.strictEqual(result.messages[0].role, 'user');
  assert.strictEqual(result.messages[0].content, 'hello');
});

test('tool_result → 多条 role=tool 消息', () => {
  const result = anthropicToOpenAI({
    model: 'deepseek-v4-pro',
    messages: [{
      role: 'user',
      content: [
        { type: 'tool_result', tool_use_id: 'toolu_01', content: 'result1' },
        { type: 'tool_result', tool_use_id: 'toolu_02', content: 'result2' },
      ],
    }],
  });
  assert.strictEqual(result.messages.length, 2);
  assert.strictEqual(result.messages[0].role, 'tool');
  assert.strictEqual(result.messages[0].tool_call_id, 'toolu_01');
  assert.strictEqual(result.messages[0].content, 'result1');
  assert.strictEqual(result.messages[1].role, 'tool');
  assert.strictEqual(result.messages[1].tool_call_id, 'toolu_02');
});

test('assistant 含 tool_use → tool_calls 转换', () => {
  const result = anthropicToOpenAI({
    model: 'deepseek-v4-pro',
    messages: [{
      role: 'assistant',
      content: [
        { type: 'text', text: 'Let me read that' },
        { type: 'tool_use', id: 'toolu_01', name: 'read', input: { path: '/tmp' } },
      ],
    }],
  });
  assert.strictEqual(result.messages[0].role, 'assistant');
  assert.strictEqual(result.messages[0].content, 'Let me read that');
  assert.strictEqual(result.messages[0].tool_calls.length, 1);
  assert.strictEqual(result.messages[0].tool_calls[0].id, 'toolu_01');
  assert.strictEqual(result.messages[0].tool_calls[0].function.name, 'read');
  assert.strictEqual(result.messages[0].tool_calls[0].function.arguments, '{"path":"/tmp"}');
});

test('tools input_schema → function.parameters', () => {
  const result = anthropicToOpenAI({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hi' }],
    tools: [{ name: 'read', description: 'Read file', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  });
  assert.strictEqual(result.tools.length, 1);
  assert.strictEqual(result.tools[0].type, 'function');
  assert.strictEqual(result.tools[0].function.name, 'read');
  assert.strictEqual(result.tools[0].function.parameters.type, 'object');
  assert.strictEqual(result.tool_choice, 'auto');
});

test('stream 和 stop_sequences 透传', () => {
  const result = anthropicToOpenAI({
    model: 'deepseek-v4-pro',
    messages: [{ role: 'user', content: 'hi' }],
    stream: true,
    stop_sequences: ['END', 'STOP'],
  });
  assert.strictEqual(result.stream, true);
  assert.ok(result.stream_options?.include_usage);
  assert.deepStrictEqual(result.stop, ['END', 'STOP']);
});

test('图片消息转换', () => {
  const result = anthropicToOpenAI({
    model: 'glm-5.1',
    messages: [{
      role: 'user',
      content: [
        { type: 'text', text: '描述这张图' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc123' } },
      ],
    }],
  });
  assert.strictEqual(result.messages[0].role, 'user');
  assert.strictEqual(result.messages[0].content[0].type, 'text');
  assert.strictEqual(result.messages[0].content[1].type, 'image_url');
  assert.ok(result.messages[0].content[1].image_url.url.includes('data:image/png;base64,abc123'));
});

// ===== response.js 测试 =====
console.log('\n📦 response.js — OpenAI → Anthropic');

test('纯文本响应', () => {
  const result = openaiToAnthropic({
    id: 'chatcmpl-xxx',
    model: 'deepseek-v4-pro',
    choices: [{ index: 0, message: { role: 'assistant', content: '你好' }, finish_reason: 'stop' }],
    usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
  });
  assert.strictEqual(result.type, 'message');
  assert.strictEqual(result.role, 'assistant');
  assert.strictEqual(result.content[0].type, 'text');
  assert.strictEqual(result.content[0].text, '你好');
  assert.strictEqual(result.stop_reason, 'end_turn');
  assert.strictEqual(result.usage.input_tokens, 10);
  assert.strictEqual(result.usage.output_tokens, 5);
});

test('tool_calls → tool_use 转换', () => {
  const result = openaiToAnthropic({
    id: 'chatcmpl-xxx',
    choices: [{
      index: 0,
      message: {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"/tmp"}' } }],
      },
      finish_reason: 'tool_calls',
    }],
    usage: {},
  });
  assert.strictEqual(result.content[0].type, 'tool_use');
  assert.strictEqual(result.content[0].id, 'call_1');
  assert.strictEqual(result.content[0].name, 'read');
  assert.deepStrictEqual(result.content[0].input, { path: '/tmp' });
  assert.strictEqual(result.stop_reason, 'tool_use');
});

test('reasoning_content → thinking 块', () => {
  const result = openaiToAnthropic({
    id: 'chatcmpl-xxx',
    choices: [{
      index: 0,
      message: { role: 'assistant', content: '答案是42', reasoning_content: '让我思考一下...' },
      finish_reason: 'stop',
    }],
    usage: {},
  });
  assert.strictEqual(result.content[0].type, 'thinking');
  assert.strictEqual(result.content[0].thinking, '让我思考一下...');
  assert.strictEqual(result.content[1].type, 'text');
  assert.strictEqual(result.content[1].text, '答案是42');
});

test('finish_reason 映射', () => {
  assert.strictEqual(mapFinishReason('stop'), 'end_turn');
  assert.strictEqual(mapFinishReason('length'), 'max_tokens');
  assert.strictEqual(mapFinishReason('tool_calls'), 'tool_use');
});

// ===== stream.js 测试 =====
console.log('\n📦 stream.js — OpenAI SSE → Anthropic SSE');

test('message_start 事件', () => {
  const t = new StreamTransformer('deepseek-v4-pro');
  const events = t.processChunk({
    choices: [{ index: 0, delta: { role: 'assistant', content: '你好' } }],
  });
  assert.ok(events[0].includes('message_start'));
  assert.ok(events[0].includes('deepseek-v4-pro'));
});

test('text 块 start + delta', () => {
  const t = new StreamTransformer('deepseek-v4-pro');
  // 第一个 chunk
  const e1 = t.processChunk({ choices: [{ index: 0, delta: { content: '你好' } }] });
  // 应该有 message_start + content_block_start(text)
  assert.ok(e1.some(s => s.includes('content_block_start') && s.includes('text')));

  // 后续 chunk
  const e2 = t.processChunk({ choices: [{ index: 0, delta: { content: '世界' } }] });
  assert.ok(e2.some(s => s.includes('content_block_delta') && s.includes('text_delta')));
});

test('reasoning → thinking 块', () => {
  const t = new StreamTransformer('deepseek-v4-pro');
  const e1 = t.processChunk({ choices: [{ index: 0, delta: { reasoning_content: '思考中...' } }] });
  assert.ok(e1.some(s => s.includes('content_block_start') && s.includes('thinking')));
});

test('reasoning → text 自动切换', () => {
  const t = new StreamTransformer('deepseek-v4-pro');
  t.processChunk({ choices: [{ index: 0, delta: { reasoning_content: '思考...' } }] });
  const events = t.processChunk({ choices: [{ index: 0, delta: { content: '答案是42' } }] });

  // 应该包含 thinking block 的 stop
  assert.ok(events.some(s => s.includes('content_block_stop')));
  // 应该包含 text block 的 start
  assert.ok(events.some(s => s.includes('content_block_start') && s.includes('text')));
});

test('tool_use 流式构建', () => {
  const t = new StreamTransformer('deepseek-v4-pro');
  // 第一条 tool_call
  t.processChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'read', arguments: '{"path":"' } }] },
    }],
  });
  // 追加 arguments
  const events = t.processChunk({
    choices: [{
      index: 0,
      delta: { tool_calls: [{ index: 0, function: { arguments: '/tmp"}' } }] },
    }],
  });
  assert.ok(events.some(s => s.includes('input_json_delta') && s.includes('/tmp')));
});

test('finish → message_delta + message_stop', () => {
  const t = new StreamTransformer('deepseek-v4-pro');
  t.processChunk({ choices: [{ index: 0, delta: { content: '你好' } }] });
  const events = t.processChunk({
    choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
    usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
  });
  assert.ok(events.some(s => s.includes('content_block_stop')));
  assert.ok(events.some(s => s.includes('message_delta') && s.includes('end_turn')));
  assert.ok(events.some(s => s.includes('message_stop')));
});

// ===== server.js 测试 =====
console.log('\n📦 server.js — Token 计数');

const { estimateTokens, countTokens } = require('../src/server');

test('estimateTokens 空字符串为 0', () => {
  assert.strictEqual(estimateTokens(''), 0);
  assert.strictEqual(estimateTokens(null), 0);
});

test('estimateTokens 英文估算 (~4字符/1token)', () => {
  const tokens = estimateTokens('hello world');
  assert.ok(tokens >= 2 && tokens <= 5, `英文 'hello world' 估算: ${tokens}`);
});

test('estimateTokens 中文估算 (~1字符/1token)', () => {
  const tokens = estimateTokens('你好世界');
  assert.ok(tokens >= 3 && tokens <= 6, `中文 '你好世界' 估算: ${tokens}`);
});

test('countTokens 完整请求估算', () => {
  const result = countTokens({
    model: 'deepseek-v4-pro',
    system: 'You are helpful',
    messages: [
      { role: 'user', content: '你好' },
      { role: 'assistant', content: '你好！有什么可以帮助你的？' },
    ],
  });
  assert.ok(result > 0, `总 tokens 应 > 0，实际: ${result}`);
  assert.ok(result < 100, `总 tokens 应 < 100，实际: ${result}`);
});

// ===== 结果汇总 =====
console.log(`\n${'='.repeat(40)}`);
console.log(`通过: ${passed}  失败: ${failed}`);
if (failed > 0) process.exit(1);

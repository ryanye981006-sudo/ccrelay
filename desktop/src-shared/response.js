// OpenAI Chat Completions 非流式响应 → Anthropic Messages 响应体转换

const crypto = require('crypto');

function randomHex(len) {
  return crypto.randomBytes(len / 2).toString('hex');
}

// finish_reason 映射
const FINISH_REASON_MAP = {
  stop: 'end_turn',
  length: 'max_tokens',
  tool_calls: 'tool_use',
  content_filter: 'end_turn',
};

function mapFinishReason(openaiReason) {
  return FINISH_REASON_MAP[openaiReason] || 'end_turn';
}

// 主导出函数
function openaiToAnthropic(openaiBody) {
  const choice = openaiBody.choices?.[0];
  if (!choice) {
    return {
      id: `msg_${randomHex(32)}`,
      type: 'message',
      role: 'assistant',
      model: openaiBody.model || '',
      content: [{ type: 'text', text: '' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 0, output_tokens: 0 },
    };
  }

  const message = choice.message || {};
  const content = [];

  // reasoning_content → thinking 块
  if (message.reasoning_content) {
    content.push({
      type: 'thinking',
      thinking: message.reasoning_content,
    });
  }

  // 文本内容
  if (message.content) {
    content.push({
      type: 'text',
      text: message.content,
    });
  }

  // tool_calls → tool_use 块
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      let input;
      try {
        input = JSON.parse(tc.function.arguments);
      } catch {
        input = {};
      }
      content.push({
        type: 'tool_use',
        id: tc.id,
        name: tc.function.name,
        input,
      });
    }
  }

  // usage 映射
  const usage = openaiBody.usage || {};
  const anthropicUsage = {
    input_tokens: usage.prompt_tokens || 0,
    output_tokens: usage.completion_tokens || 0,
  };

  return {
    id: `msg_${randomHex(32)}`,
    type: 'message',
    role: 'assistant',
    model: openaiBody.model || '',
    content,
    stop_reason: mapFinishReason(choice.finish_reason),
    stop_sequence: null,
    usage: anthropicUsage,
  };
}

module.exports = { openaiToAnthropic, mapFinishReason };

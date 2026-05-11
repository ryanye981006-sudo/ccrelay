// OpenAI Chat Completions 非流式响应 → OpenAI Responses API 响应体转换

const crypto = require('crypto');

function randomHex(len) {
  return crypto.randomBytes(len / 2).toString('hex');
}

function chatToResponses(chatBody) {
  const choice = chatBody.choices?.[0];
  if (!choice) {
    return {
      id: `resp_${randomHex(32)}`,
      object: 'response',
      model: chatBody.model || '',
      output: [],
      usage: { input_tokens: 0, output_tokens: 0, total_tokens: 0 },
    };
  }

  const message = choice.message || {};
  const output = [];
  const msgId = `msg_${randomHex(32)}`;

  // 文本内容
  if (message.content) {
    output.push({
      id: msgId,
      type: 'message',
      role: 'assistant',
      content: [{
        type: 'output_text',
        text: message.content,
        annotations: [],
      }],
    });
  }

  // tool_calls → function_call 输出项
  if (message.tool_calls && message.tool_calls.length > 0) {
    for (const tc of message.tool_calls) {
      output.push({
        id: tc.id,
        type: 'function_call',
        name: tc.function.name,
        arguments: tc.function.arguments,
      });
    }
  }

  // usage
  const usage = chatBody.usage || {};
  const total = (usage.prompt_tokens || 0) + (usage.completion_tokens || 0);

  return {
    id: `resp_${randomHex(32)}`,
    object: 'response',
    model: chatBody.model || '',
    output,
    usage: {
      input_tokens: usage.prompt_tokens || 0,
      output_tokens: usage.completion_tokens || 0,
      total_tokens: total || 0,
    },
  };
}

module.exports = { chatToResponses };

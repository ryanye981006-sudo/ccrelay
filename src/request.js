// Anthropic Messages 请求体 → OpenAI Chat Completions 请求体转换

const { isVisionModel } = require('./vision');

function extractText(content) {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('');
}

function convertUserMessage(msg, modelName) {
  const content = msg.content;
  if (typeof content === 'string') {
    return { role: 'user', content };
  }

  // 检查是否为 tool_result 消息
  const toolResults = content.filter(block => block.type === 'tool_result');
  if (toolResults.length > 0) {
    // 每个 tool_result 拆分为独立的 role: "tool" 消息
    return toolResults.map(tr => ({
      role: 'tool',
      tool_call_id: tr.tool_use_id,
      content: typeof tr.content === 'string' ? tr.content : extractText(tr.content),
    }));
  }

  // 普通用户消息：text + 可选的 image
  const imageBlocks = content.filter(block => block.type === 'image');

  // 非视觉模型：丢弃图片，只保留文本
  if (imageBlocks.length === 0 || !isVisionModel(modelName)) {
    return { role: 'user', content: extractText(content) };
  }

  // 多模态消息（仅视觉模型）
  const parts = [];
  for (const block of content) {
    if (block.type === 'text') {
      parts.push({ type: 'text', text: block.text });
    } else if (block.type === 'image') {
      parts.push({
        type: 'image_url',
        image_url: {
          url: `data:${block.source.media_type};base64,${block.source.data}`,
        },
      });
    }
  }
  return { role: 'user', content: parts };
}

function convertAssistantMessage(msg) {
  const content = msg.content;
  if (typeof content === 'string') {
    return { role: 'assistant', content };
  }

  const textBlocks = content.filter(block => block.type === 'text');
  const toolUseBlocks = content.filter(block => block.type === 'tool_use');
  const thinkingBlocks = content.filter(block => block.type === 'thinking');

  const openaiMsg = { role: 'assistant' };

  // 文本内容
  const textContent = textBlocks.map(b => b.text).join('');
  if (textContent) {
    openaiMsg.content = textContent;
  } else if (toolUseBlocks.length === 0 && thinkingBlocks.length === 0) {
    openaiMsg.content = '';
  }

  // 工具调用
  if (toolUseBlocks.length > 0) {
    openaiMsg.tool_calls = toolUseBlocks.map(tu => ({
      id: tu.id,
      type: 'function',
      function: {
        name: tu.name,
        arguments: JSON.stringify(tu.input),
      },
    }));
  }

  // thinking 块 → reasoning_content（DeepSeek 要求回传）
  if (thinkingBlocks.length > 0) {
    openaiMsg.reasoning_content = thinkingBlocks.map(b => b.thinking).join('\n');
  }

  return openaiMsg;
}

function convertSystemMessage(msg) {
  return { role: 'system', content: extractText(msg.content) };
}

// 主导出函数
function anthropicToOpenAI(anthropicBody) {
  const openaiMessages = [];

  // 处理顶层 system 字段 → messages[0] role=system
  if (anthropicBody.system) {
    let systemContent;
    if (typeof anthropicBody.system === 'string') {
      systemContent = anthropicBody.system;
    } else if (Array.isArray(anthropicBody.system)) {
      systemContent = anthropicBody.system
        .filter(block => block.type === 'text')
        .map(block => block.text)
        .join('\n');
    }
    if (systemContent) {
      openaiMessages.push({ role: 'system', content: systemContent });
    }
  }

  // 遍历 Anthropic messages 逐条转换
  for (const msg of anthropicBody.messages) {
    let converted;
    switch (msg.role) {
      case 'user':
        converted = convertUserMessage(msg, anthropicBody.model);
        break;
      case 'assistant':
        converted = convertAssistantMessage(msg);
        break;
      case 'system':
        converted = convertSystemMessage(msg);
        break;
      default:
        converted = { role: msg.role, content: extractText(msg.content) };
    }
    if (Array.isArray(converted)) {
      openaiMessages.push(...converted);
    } else {
      openaiMessages.push(converted);
    }
  }

  // 构建 OpenAI 请求体
  const openaiBody = {
    model: anthropicBody.model?.replace('[1m]', ''),
    messages: openaiMessages,
  };

  if (anthropicBody.max_tokens) {
    openaiBody.max_tokens = anthropicBody.max_tokens;
  }
  if (anthropicBody.stream) {
    openaiBody.stream = true;
    openaiBody.stream_options = { include_usage: true };
  }
  if (anthropicBody.stop_sequences) {
    openaiBody.stop = anthropicBody.stop_sequences;
  }
  if (anthropicBody.tools && anthropicBody.tools.length > 0) {
    openaiBody.tools = anthropicBody.tools.map(tool => ({
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.input_schema,
      },
    }));
    // 工具调用模式：Claude Code 默认 auto
    openaiBody.tool_choice = 'auto';
  }
  if (anthropicBody.temperature !== undefined) {
    openaiBody.temperature = anthropicBody.temperature;
  }
  if (anthropicBody.top_p !== undefined) {
    openaiBody.top_p = anthropicBody.top_p;
  }
  if (anthropicBody.top_k !== undefined) {
    openaiBody.top_k = anthropicBody.top_k;
  }

  return openaiBody;
}

module.exports = { anthropicToOpenAI };

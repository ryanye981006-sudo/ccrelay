// OpenAI Responses API 请求体 → OpenAI Chat Completions 请求体转换

// 递归清理 JSON Schema 中 DeepSeek 不支持的字段
function cleanSchema(obj) {
  if (!obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(cleanSchema);
  const cleaned = {};
  for (const [k, v] of Object.entries(obj)) {
    if (k === 'additionalProperties' || k === 'strict') continue;
    cleaned[k] = typeof v === 'object' ? cleanSchema(v) : v;
  }
  return cleaned;
}

// 从 reasoning 条目提取推理文本
function extractReasoningText(entry) {
  if (typeof entry.content === 'string') return entry.content;
  if (entry.summary) {
    if (typeof entry.summary === 'string') return entry.summary;
    if (Array.isArray(entry.summary)) {
      return entry.summary
        .filter(s => s.type === 'summary_text')
        .map(s => s.text || '')
        .join('');
    }
  }
  return '';
}

// 从包含 <think/> 标签的文本中提取 reasoning_content 和实际内容
function extractThinkContent(text) {
  if (!text || typeof text !== 'string' || !text.includes('<think')) return { content: text };
  const match = text.match(/^<think[^>]*>\n?([\s\S]*?)\n?<\/think>\n?([\s\S]*)$/);
  if (match) {
    return { reasoning_content: match[1], content: match[2] || '' };
  }
  return { content: text };
}

// input 条目转为 messages[]，处理 function_call / function_call_output
function convertInputEntry(entry) {
  const entryType = entry.type || entry.role || '';

  if (entryType === 'function_call') {
    return {
      role: 'assistant',
      content: null,
      tool_calls: [{
        id: entry.call_id || '',
        type: 'function',
        function: {
          name: entry.name || '',
          arguments: entry.arguments || '',
        },
      }],
    };
  }

  if (entryType === 'function_call_output') {
    return {
      role: 'tool',
      tool_call_id: entry.call_id || '',
      content: entry.output || '',
    };
  }

  // 普通 user / assistant 消息
  let role = entry.role || 'user';
  if (role === 'developer') role = 'system';
  let content = entry.content;

  if (Array.isArray(content)) {
    content = content
      .filter(part => part.type === 'input_text' || part.type === 'text' || part.type === 'output_text')
      .map(part => part.text)
      .join('');
  }

  // assistant 消息：提取 <think/> 标签为 reasoning_content
  if (role === 'assistant' && content) {
    const extracted = extractThinkContent(content);
    return { role, ...extracted };
  }

  return { role, content: content || '' };
}

// 主导出函数
function responsesToChat(body) {
  const messages = [];

  // instructions → system message
  if (body.instructions) {
    messages.push({ role: 'system', content: body.instructions });
  }

  // input[] → messages[]
  // 两趟处理：第一趟提取 reasoning，第二趟合并到 assistant 消息
  if (body.input && Array.isArray(body.input)) {
    let pendingReasoning = '';

    for (const entry of body.input) {
      const entryType = entry.type || entry.role || '';

      // reasoning 条目：提取文本，等下一个 assistant/function_call 条目来合并
      if (entryType === 'reasoning') {
        pendingReasoning = extractReasoningText(entry);
        continue;
      }

      const msg = convertInputEntry(entry);

      // 把累积的 reasoning_content 附加到 assistant 消息
      if (pendingReasoning && msg.role === 'assistant') {
        msg.reasoning_content = pendingReasoning;
        pendingReasoning = '';
      } else if (pendingReasoning && msg.role === 'tool') {
        // reasoning 后面紧跟 function_call_output，说明 function_call 之间缺少了 reasoning
        // 插入一条 assistant 消息携带 reasoning_content
        messages.push({ role: 'assistant', content: '', reasoning_content: pendingReasoning });
        pendingReasoning = '';
      } else if (pendingReasoning && msg.role !== 'assistant') {
        // reasoning 后面是 user 消息，说明模型只回了 reasoning 没有其他输出
        // 插入一条 assistant 消息携带 reasoning_content
        messages.push({ role: 'assistant', content: '', reasoning_content: pendingReasoning });
        pendingReasoning = '';
      }

      messages.push(msg);
    }

    // 末尾还有残留的 reasoning
    if (pendingReasoning) {
      messages.push({ role: 'assistant', content: '', reasoning_content: pendingReasoning });
    }

    // 消息重排：确保 tool 消息紧跟对应的 assistant tool_calls 消息
    // Codex 有时在 assistant(tool_calls) 和 tool 消息之间插入 system/developer 消息
    // DeepSeek 要求 tool 消息必须紧跟 assistant tool_calls
    const reordered = [];
    let i = 0;
    while (i < messages.length) {
      const msg = messages[i];
      if (msg.role === 'assistant' && msg.tool_calls) {
        // 收集此 assistant 消息需要的所有 tool_call_id
        const expectedIds = new Set(msg.tool_calls.map(tc => tc.id));
        const toolMsgs = [];
        const nonToolMsgs = [];
        let j = i + 1;
        while (j < messages.length && expectedIds.size > 0) {
          const nxt = messages[j];
          if (nxt.role === 'tool' && expectedIds.has(nxt.tool_call_id)) {
            expectedIds.delete(nxt.tool_call_id);
            toolMsgs.push(nxt);
          } else if (nxt.role === 'system' || (nxt.role === 'user' && !nxt.tool_call_id)) {
            // system 或 user 消息插在中间，移到 assistant 之前
            nonToolMsgs.push(nxt);
          } else {
            break;
          }
          j++;
        }
        // 先放被挤开的非 tool 消息，再放 assistant，最后放 tool 消息
        reordered.push(...nonToolMsgs);
        reordered.push(msg);
        reordered.push(...toolMsgs);
        i = j;
      } else {
        reordered.push(msg);
        i++;
      }
    }
    messages.length = 0;
    messages.push(...reordered);
  }

  const chatBody = {
    model: body.model,
    messages,
  };

  // max_output_tokens → max_tokens
  if (body.max_output_tokens) {
    chatBody.max_tokens = body.max_output_tokens;
  }

  // stream
  if (body.stream) {
    chatBody.stream = true;
    chatBody.stream_options = { include_usage: true };
  }

  // tools 转换
  if (body.tools && body.tools.length > 0) {
    const funcTools = body.tools
      .filter(t => t.type === 'function' || t.name || t.type)
      .map(tool => {
        const func = {
          name: tool.name || tool.type || '',
          description: tool.description || '',
        };
        if (tool.parameters) {
          func.parameters = cleanSchema(tool.parameters);
        }
        return { type: 'function', function: func };
      });
    if (funcTools.length > 0) {
      chatBody.tools = funcTools;

      if (body.tool_choice) {
        if (typeof body.tool_choice === 'string') {
          chatBody.tool_choice = body.tool_choice;
        } else if (body.tool_choice.type === 'function' && body.tool_choice.name) {
          chatBody.tool_choice = { type: 'function', function: { name: body.tool_choice.name } };
        } else {
          chatBody.tool_choice = body.tool_choice;
        }
      } else {
        chatBody.tool_choice = 'auto';
      }
    }
  }

  if (body.temperature !== undefined) {
    chatBody.temperature = body.temperature;
  }

  if (body.top_p !== undefined) {
    chatBody.top_p = body.top_p;
  }

  return chatBody;
}

module.exports = { responsesToChat };

// OpenAI Responses API 请求体 → Anthropic Messages 请求体转换
// 用于 Codex + Anthropic 协议后端

const { isVisionModel } = require('./vision');

// 递归清理 JSON Schema 中 Anthropic 不支持的字段
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

// 从 data URL 中解析 media_type 和 base64 数据
function parseDataUrl(url) {
  const match = (url || '').match(/^data:([^;]+);base64,(.+)$/);
  if (!match) return null;
  return { mediaType: match[1], data: match[2] };
}

function convertContentBlocks(blocks, modelName) {
  if (!Array.isArray(blocks)) return [];
  const result = [];
  for (const block of blocks) {
    if (block.type === 'input_text' || block.type === 'text' || block.type === 'output_text') {
      result.push({ type: 'text', text: block.text || '' });
    } else if (block.type === 'input_image' && isVisionModel(modelName)) {
      const parsed = parseDataUrl(block.image_url);
      if (parsed) {
        result.push({
          type: 'image',
          source: { type: 'base64', media_type: parsed.mediaType, data: parsed.data },
        });
      }
    }
    // 非视觉模型：input_image 被丢弃
  }
  return result;
}

function convertInputEntry(entry, modelName) {
  const entryType = entry.type || entry.role || '';

  if (entryType === 'function_call') {
    let input = {};
    try { input = JSON.parse(entry.arguments || '{}'); } catch {}
    return {
      role: 'assistant',
      content: [{
        type: 'tool_use',
        id: entry.call_id || '',
        name: entry.name || '',
        input,
      }],
    };
  }

  if (entryType === 'function_call_output') {
    let output = entry.output || '';
    if (typeof output !== 'string') {
      output = JSON.stringify(output);
    }
    return {
      role: 'user',
      content: [{
        type: 'tool_result',
        tool_use_id: entry.call_id || '',
        content: output,
      }],
    };
  }

  if (entryType === 'reasoning') {
    // reasoning 条目在 Anthropic 中不需要回传，跳过
    return null;
  }

  // 普通 user / assistant 消息
  let role = entry.role || 'user';
  const blocks = convertContentBlocks(entry.content, modelName);
  if (blocks.length === 0) {
    blocks.push({ type: 'text', text: '' });
  }
  return { role, content: blocks };
}

function responsesToAnthropic(body) {
  const result = {};

  // model
  if (body.model) {
    result.model = body.model.replace('[1m]', '');
  }

  // instructions → system
  if (body.instructions) {
    result.system = body.instructions;
  }

  // stream / max_tokens / temperature / top_p
  if (body.stream) result.stream = true;
  // Anthropic API 要求 max_tokens 必填，Responses 用 max_output_tokens，兜底 4096
  result.max_tokens = body.max_output_tokens || 4096;
  if (body.temperature !== undefined) result.temperature = body.temperature;
  if (body.top_p !== undefined) result.top_p = body.top_p;

  // tools
  if (body.tools && body.tools.length > 0) {
    result.tools = body.tools
      .filter(t => t.type === 'function' || t.name)
      .map(t => ({
        name: t.name || '',
        description: t.description || '',
        input_schema: cleanSchema(t.parameters || {}),
      }));
  }

  // input[] → messages[]
  const messages = [];
  if (body.input && Array.isArray(body.input)) {
    for (const entry of body.input) {
      const msg = convertInputEntry(entry, body.model);
      if (msg) messages.push(msg);
    }
  }

  // 合并连续同 role 消息（Anthropic 要求 user/assistant 严格交替）
  const merged = [];
  for (const msg of messages) {
    if (merged.length > 0) {
      const prev = merged[merged.length - 1];
      if (prev.role === msg.role) {
        prev.content = [...prev.content, ...msg.content];
        continue;
      }
    }
    merged.push(msg);
  }

  result.messages = merged;
  return result;
}

module.exports = { responsesToAnthropic };

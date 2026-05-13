// OpenAI Chat Completions SSE 流 → OpenAI Responses API SSE 事件流转换
// 对齐 OpenAI Responses API 规范，支持 reasoning（思考）事件

const crypto = require('crypto');

function randomHex(len) {
  return crypto.randomBytes(len / 2).toString('hex');
}

function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

class ResponsesStreamTransformer {
  constructor(model) {
    this.respId = `resp_${randomHex(32)}`;
    this.msgId = `msg_${randomHex(32)}`;
    this.reasoningId = `rs_${randomHex(32)}`;
    this.model = model;
    this.started = false;
    this.finished = false;
    this.inputTokens = 0;
    this.outputTokens = 0;

    // reasoning 状态
    this.reasoningStarted = false;
    this.reasoningClosed = false;
    this.fullReasoning = '';

    // think 标签剥离状态: 0=查找<think>, 1=在think内部, 2=已闭合
    this._thinkState = 0;
    this._thinkBuf = '';

    // text 状态
    this.textItemStarted = false;
    this.fullText = '';

    // function_call: index → { id, itemId, name, arguments, started }
    this.fnMap = {};
  }

  // text 项的 output_index
  get textOutIdx() {
    return this.reasoningStarted ? 1 : 0;
  }

  // function_call 项的 output_index
  fnOutIdx(idx) {
    return (this.reasoningStarted ? 1 : 0) + (this.textItemStarted ? 1 : 0) + idx;
  }

  processChunk(chunk) {
    if (this.finished) return [];

    const choice = chunk.choices?.[0];
    if (!choice) return [];

    const delta = choice.delta || {};
    const finishReason = choice.finish_reason;
    const usage = chunk.usage;
    if (usage) {
      this.inputTokens = usage.prompt_tokens || 0;
      this.outputTokens = usage.completion_tokens || 0;
    }

    // 预处理器：从 delta.content 剥离 <think> 标签，转为 delta.reasoning_content
    // 后端流式返回 <think>\n...\n</think>\n... 格式，需拆分为 reasoning + content
    if (delta.content) {
      if (this._thinkState < 2) {
        this._thinkBuf += delta.content;
        delta.content = undefined;

        // 状态 0 → 1: 检测 <think> 开始
        if (this._thinkState === 0) {
          const idx = this._thinkBuf.indexOf('<think>');
          if (idx >= 0) {
            const before = this._thinkBuf.substring(0, idx);
            this._thinkBuf = this._thinkBuf.substring(idx + 7).replace(/^\n/, '');
            this._thinkState = 1;
            if (before) delta.content = before;
          } else {
            // <think> 还没出现，继续累积（不太可能但防一下）
            delta.content = this._thinkBuf;
            this._thinkBuf = '';
          }
        }

        // 状态 1 → 2: 检测 </think> 闭合
        if (this._thinkState === 1) {
          const idx = this._thinkBuf.indexOf('</think>');
          if (idx >= 0) {
            if (idx > 0) delta.reasoning_content = this._thinkBuf.substring(0, idx);
            this._thinkBuf = this._thinkBuf.substring(idx + 8).replace(/^\n/, '');
            this._thinkState = 2;
            if (this._thinkBuf) {
              delta.content = (delta.content || '') + this._thinkBuf;
              this._thinkBuf = '';
            }
          } else {
            // 还在 think 内部，全部作为 reasoning
            delta.reasoning_content = this._thinkBuf;
            this._thinkBuf = '';
          }
        }
      }
    }

    const events = [];

    // response.created + response.in_progress（首个有意义的 chunk 触发）
    if (!this.started && (delta.role || delta.content !== undefined || delta.tool_calls || delta.reasoning_content)) {
      this.started = true;
      events.push(sse('response.created', {
        type: 'response.created',
        response: { id: this.respId, object: 'response', model: this.model, status: 'in_progress', output: [], usage: null },
      }));
      events.push(sse('response.in_progress', {
        type: 'response.in_progress',
        response: { id: this.respId, object: 'response', status: 'in_progress', model: this.model, output: [], usage: null },
      }));
    }
    if (!this.started) return events;

    // --- reasoning（思考） ---
    if (delta.reasoning_content) {
      if (!this.reasoningStarted) {
        this.reasoningStarted = true;
        this.fullReasoning = delta.reasoning_content;
        events.push(sse('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: 0,
          item: {
            id: this.reasoningId, type: 'reasoning',
            status: 'in_progress',
            summary: [],
          },
        }));
        events.push(sse('response.reasoning_summary_part.added', {
          type: 'response.reasoning_summary_part.added',
          item_id: this.reasoningId, output_index: 0, summary_index: 0,
        }));
        events.push(sse('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: this.reasoningId, output_index: 0, summary_index: 0,
          delta: delta.reasoning_content,
        }));
      } else {
        this.fullReasoning += delta.reasoning_content;
        events.push(sse('response.reasoning_summary_text.delta', {
          type: 'response.reasoning_summary_text.delta',
          item_id: this.reasoningId, output_index: 0, summary_index: 0,
          delta: delta.reasoning_content,
        }));
      }
    }

    // reasoning → text/function_call 切换时关闭 reasoning
    if ((delta.content || delta.tool_calls) && this.reasoningStarted && !this.reasoningClosed) {
      this.reasoningClosed = true;
      events.push(sse('response.reasoning_summary_text.done', {
        type: 'response.reasoning_summary_text.done',
        item_id: this.reasoningId, output_index: 0, summary_index: 0,
        text: this.fullReasoning,
      }));
      events.push(sse('response.reasoning_summary_part.done', {
        type: 'response.reasoning_summary_part.done',
        item_id: this.reasoningId, output_index: 0, summary_index: 0,
      }));
      events.push(sse('response.output_item.done', {
        type: 'response.output_item.done', output_index: 0,
        item: {
          id: this.reasoningId, type: 'reasoning', status: 'completed',
          summary: [{ type: 'summary_text', text: this.fullReasoning }],
        },
      }));
    }

    // --- 文本 ---
    if (delta.content) {
      const outIdx = this.textOutIdx;
      if (!this.textItemStarted) {
        this.textItemStarted = true;
        this.fullText = delta.content;
        events.push(sse('response.output_item.added', {
          type: 'response.output_item.added',
          output_index: outIdx,
          item: {
            id: this.msgId, type: 'message', role: 'assistant',
            status: 'in_progress',
            content: [],
          },
        }));
        events.push(sse('response.content_part.added', {
          type: 'response.content_part.added',
          item_id: this.msgId, output_index: outIdx, content_index: 0,
          part: { type: 'text', text: '' },
        }));
        events.push(sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: this.msgId, output_index: outIdx, content_index: 0,
          delta: delta.content,
        }));
      } else {
        this.fullText += delta.content;
        events.push(sse('response.output_text.delta', {
          type: 'response.output_text.delta',
          item_id: this.msgId, output_index: outIdx, content_index: 0,
          delta: delta.content,
        }));
      }
    }

    // --- 工具调用 ---
    if (delta.tool_calls) {
      for (const tc of delta.tool_calls) {
        const idx = tc.index;
        if (!this.fnMap[idx]) {
          const fnId = tc.id || `fc_${randomHex(16)}`;
          const itemId = `fc_item_${randomHex(16)}`;
          this.fnMap[idx] = { id: fnId, itemId, name: tc.function?.name || '', arguments: tc.function?.arguments || '', started: true };
          const outIdx = this.fnOutIdx(idx);
          events.push(sse('response.output_item.added', {
            type: 'response.output_item.added',
            output_index: outIdx,
            item: {
              id: itemId, type: 'function_call',
              status: 'in_progress',
              call_id: fnId, name: this.fnMap[idx].name, arguments: '',
            },
          }));
          if (this.fnMap[idx].arguments) {
            events.push(sse('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              item_id: itemId, output_index: outIdx,
              delta: this.fnMap[idx].arguments,
            }));
          }
        } else {
          const frag = tc.function?.arguments || '';
          if (frag) {
            const fn = this.fnMap[idx];
            fn.arguments += frag;
            const outIdx = this.fnOutIdx(idx);
            events.push(sse('response.function_call_arguments.delta', {
              type: 'response.function_call_arguments.delta',
              item_id: fn.itemId, output_index: outIdx,
              delta: frag,
            }));
          }
        }
      }
    }

    // --- 完成 ---
    if (finishReason) {
      this.finished = true;
      const outputItems = [];

      // 关闭 reasoning（如果还没关闭）
      if (this.reasoningStarted && !this.reasoningClosed) {
        this.reasoningClosed = true;
        events.push(sse('response.reasoning_summary_text.done', {
          type: 'response.reasoning_summary_text.done',
          item_id: this.reasoningId, output_index: 0, summary_index: 0,
          text: this.fullReasoning,
        }));
        events.push(sse('response.reasoning_summary_part.done', {
          type: 'response.reasoning_summary_part.done',
          item_id: this.reasoningId, output_index: 0, summary_index: 0,
        }));
        const reasoningItem = {
          id: this.reasoningId, type: 'reasoning', status: 'completed',
          summary: [{ type: 'summary_text', text: this.fullReasoning }],
        };
        events.push(sse('response.output_item.done', {
          type: 'response.output_item.done', output_index: 0, item: reasoningItem,
        }));
      }

      if (this.reasoningStarted) {
        outputItems.push({
          id: this.reasoningId, type: 'reasoning', status: 'completed',
          summary: [{ type: 'summary_text', text: this.fullReasoning }],
        });
      }

      // 文本完成
      if (this.textItemStarted) {
        const outIdx = this.textOutIdx;
        events.push(sse('response.output_text.done', {
          type: 'response.output_text.done',
          text: this.fullText, item_id: this.msgId,
          output_index: outIdx, content_index: 0,
        }));
        events.push(sse('response.content_part.done', {
          type: 'response.content_part.done',
          item_id: this.msgId, output_index: outIdx, content_index: 0,
          part: { type: 'text', text: this.fullText },
        }));
        const textItem = {
          id: this.msgId, type: 'message', status: 'completed',
          role: 'assistant',
          content: [{ type: 'text', text: this.fullText }],
        };
        events.push(sse('response.output_item.done', {
          type: 'response.output_item.done', output_index: outIdx, item: textItem,
        }));
        outputItems.push(textItem);
      }

      // 工具调用完成
      for (const idx of Object.keys(this.fnMap).sort()) {
        const fn = this.fnMap[idx];
        const outIdx = this.fnOutIdx(parseInt(idx));
        events.push(sse('response.function_call_arguments.done', {
          type: 'response.function_call_arguments.done',
          item_id: fn.itemId, output_index: outIdx,
          arguments: fn.arguments,
        }));
        const funcItem = {
          id: fn.itemId, type: 'function_call', status: 'completed',
          call_id: fn.id, name: fn.name, arguments: fn.arguments,
        };
        events.push(sse('response.output_item.done', {
          type: 'response.output_item.done', output_index: outIdx, item: funcItem,
        }));
        outputItems.push(funcItem);
      }

      events.push(sse('response.completed', {
        type: 'response.completed',
        response: {
          id: this.respId, object: 'response', model: this.model,
          status: 'completed',
          output: outputItems,
          usage: {
            input_tokens: this.inputTokens,
            output_tokens: this.outputTokens,
            total_tokens: this.inputTokens + this.outputTokens,
          },
        },
      }));
    }

    return events;
  }

  // 获取最终 token 统计（流结束后调用）
  getStats() {
    return { inputTokens: this.inputTokens, outputTokens: this.outputTokens };
  }
}

module.exports = { ResponsesStreamTransformer };

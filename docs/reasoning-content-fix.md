# DeepSeek V4 reasoning_content 一致性修复

## 问题

Codex 多轮对话时，DeepSeek V4 返回 400 错误：

> "The `reasoning_content` in the thinking mode must be passed back to the API."

根因：DeepSeek V4 的 thinking mode 要求——如果 conversation history 中**任意一条** assistant 消息带了 `reasoning_content`，则**所有** assistant 消息都必须带。当前 `responsesToChat` 转换在多场景下会漏掉 reasoning_content，导致违反此规则。

## 修复方向

在 `responsesToChat` 的最后、`return chatBody` 之前，加一段统一修补逻辑：

遍历 `messages` 数组：
1. 检查是否存在**任意一条** `role === 'assistant'` 的消息有 `reasoning_content`
2. 如果有，则确保**所有** assistant 消息都有 `reasoning_content`（缺失的补空字符串 `""`）

这样从根源上保证无论前面转换逻辑如何组合，发往 DeepSeek 的消息都满足一致性要求。

## 涉及文件

- `src/responses.js` — `responsesToChat` 函数
- `desktop/src-shared/responses.js` — 同步修改

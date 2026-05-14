# 修复记录 — v1.2.2

**日期**: 2026-05-14 ~ 2026-05-15

## 修复内容

### Bug 1: Codex "Reconnecting..." / SSE 断连

**现象**: Codex 发请求后反复重连 5 次然后报错：
```
stream disconnected before completion: stream closed before response.completed
```

**根因**: `responses.js` 的 `responsesToChat()` 函数在转换 Codex Responses API 请求体为 OpenAI Chat Completions 格式时，消息重排逻辑不完善，导致 DeepSeek 返回 400：
```
An assistant message with 'tool_calls' must be followed by tool messages
responding to each 'tool_call_id'.
```

具体有三个子问题：

1. **reasoning 条目覆盖** — 多个连续 reasoning 条目时，`pendingReasoning` 被覆盖而非累积
2. **连续 tool_calls 未合并** — Codex 并行工具调用产生多个连续 `function_call` 条目，转换为多个 `assistant(tool_calls)` 消息。DeepSeek 要求每个 `assistant(tool_calls)` 后紧跟对应的 `tool` 消息，连续两个 `tool_calls` 导致 400
3. **消息重排逻辑不完整** — `system`/`user`/`assistant(无 tool_calls)` 消息插入在 `tool_calls` 和 `tool` 之间时未全部处理

**修复** ([src/responses.js](../src/responses.js)):
- 连续 reasoning 累积而非覆盖 (`pendingReasoning = (pendingReasoning || '') + extractReasoningText(entry)`)
- 新增合并逻辑：连续 `assistant(tool_calls)` 消息合并为一条（合并 tool_calls 数组、reasoning_content、content）
- 重排逻辑增加对 `assistant(无 tool_calls)` 消息的处理

### Bug 2: AI 回复退出后丢失

**现象**: Codex 中正常完成的对话，退出后重新进入，之前的 AI 回复全部消失。

**根因（两层）**:

**层 1 — Codex 配置**: `C:\Users\Administrator\.codex\config.toml` 中 `disable_response_storage = true`。这是 Codex 控制是否持久化对话的开关，设为 `true` 时 Codex 不会将响应写入 SQLite 数据库。已在之前改为 `false`。

**层 2 — 代理侧时序问题**: `[DONE]` 事件到达后，代理将 `response.completed` 写入 Socket 缓冲区，但仅 2ms 后客户端就关闭了连接。`res.end()` 在客户端关闭后才被调用，导致 `response.completed` 可能未被刷新到 TCP socket。Codex 未收到此事件 → 认为响应未完成 → 不持久化。

**修复** ([desktop/src-electron/proxy-engine.js](../desktop/src-electron/proxy-engine.js) / [src/server.js](../src/server.js)):
- 收到 `[DONE]` 并写完 completion 事件后，立即调用 `endStream('done-received', false)` 触发 `res.end()` 刷新缓冲区
- 不再等待后端流的 `end` 事件

### Bug 3: 用量统计"当天"范围错误

**现象**: 统计页面"当天"显示的是最近 24 小时，而非当日 0:00 ~ 23:59。

**修复** ([desktop/src-electron/data-store.js](../desktop/src-electron/data-store.js)):
- `getUsage()` 中 `range === 'today'` 的 `cutoff` 从 `Date.now() - 86400000` 改为当日零点

### 其他改进

- **SSE 心跳**: 每 15 秒发送 ping 事件，防止中间代理/负载均衡因空闲超时断开
- **TCP keep-alive**: 上游连接启用 `setKeepAlive(true, 60000)`
- **强制完成**: 后端未发送 `[DONE]` 就断开时，注入 `finish_reason` 触发 `response.completed`
- **文件日志**: 代理日志写入 `~/.ccrelay-desktop/proxy.log`（512KB 自动轮转）
- **诊断日志**: `responsesToChat()` 转换后的消息结构写入日志，便于排查

---

## 待解决问题

### 1. 消息丢失（部分场景仍然存在）

**状态**: Codex 侧问题，代理侧已无问题。

日志确认 v1.2.2 的修复生效：
```
收到 [DONE] → endStream reason=done-received → res.end() → 客户端关闭
```

`response.completed` 事件在客户端关闭前已通过 `res.end()` 刷新。消息丢失如果仍然存在，根因在 Codex 侧：

- **可能原因 A**: Codex 的 `disable_response_storage = false` 修改后，Codex 未被完全退出重启。Codex 是 Electron 应用，关闭窗口可能只是最小化到系统托盘，进程未真正退出，config.toml 未重新加载。**解决**: 右键托盘图标 → 退出，或在任务管理器中结束 Codex 进程后重新打开。
- **可能原因 B**: Codex 本身存在存储 bug。

### 2. "找不到模型"（切换模型后出现）

**状态**: 待确认具体场景。

日志中未出现 "model not found" 错误。需要确认：
- 从哪个模型切换到哪个模型
- 完整错误信息
- 是否需要检查模型路由配置的模型列表返回逻辑

---

## 版本历史

| 版本 | 日期 | 关键变更 |
|------|------|----------|
| v1.2.2 | 2026-05-15 | 修复 400 错误（连续 tool_calls 合并）+ response.completed 时序 |
| v1.2.1 | 2026-05-14 | 修复 reasoning 回溯 + 消息重排 + 用量统计当天范围 |
| v1.2.0 | 2026-05-14 | 修复 SSE 断连 + 心跳 + 文件日志 + 强制完成 |
| v1.1.0 | 2026-05-13 | 多后端路由代理 + Web 管理界面 |
| v1.0.0 | 2026-05-13 | 初始 Electron 桌面版 |

---

## 测试建议

1. **消息持久化**: 新建会话 → 发送消息 → 完全退出 Codex（确认进程已退出）→ 重新打开 → 检查历史对话
2. **工具调用**: 发送需要工具调用的请求（如"读取当前目录"）→ 确认无 "Reconnecting..." 错误
3. **并行工具调用**: 发送需要多个工具并行执行的请求 → 确认正常完成
4. **模型切换**: 在 Codex 中切换模型 → 发送消息 → 确认无 "找不到模型" 错误
5. **用量统计**: 检查管理界面 → 用量统计 → 确认"当天"显示当日 0:00 至今的数据

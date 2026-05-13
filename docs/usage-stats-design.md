# 用量统计功能设计

## 概述

用量统计模块记录代理的每一次请求，按时间范围和模型维度聚合展示 token 消耗与调用次数。

## 数据模型

每条记录存入 `~/.ccrelay-desktop/usage.json`：

```json
{
  "timestamp": 1700000000000,
  "model": "providerName/modelName",
  "category": "claude | codex",
  "inputTokens": 1234,
  "cachedInputTokens": 0,
  "outputTokens": 567,
  "incomplete": false
}
```

- `timestamp` — 请求完成时的 Unix 毫秒时间戳
- `cachedInputTokens` — 从 OpenAI `usage.prompt_tokens_details.cached_tokens` 提取
- `incomplete` — 流式请求是否被中断（客户端断开 / 后端错误）
- 数据保留最近 90 天

## 记录策略

| 场景 | 是否记录 |
|------|---------|
| 非流式 200 + 有 usage | 记录 |
| 流式正常完成 | 记录 |
| 流式客户端断开 | 记录（标记 incomplete） |
| 流式后端错误 | 尝试记录已累积 token |
| 纯错误/拒绝路径 | 不记录 |

## API

### GET /api/usage?range=today|7d|30d
按模型聚合。默认 `today`。

### GET /api/usage/:modelKey?range=&page=&pageSize=
模型详细记录。`:modelKey` 为 URL 编码的 `providerName/modelName`。
最多 1000 条，按时间由新到旧排序，单页最多 100 条。

## UI

- 侧边栏「用量」Tab，位于「API 源」下方
- 时间范围选择：当天（默认）/ 近7天 / 近30天
- 第一层：模型卡片（模型名、调用次数、总 tokens）
- 第二层：记录列表（时间、输入、缓存输入、输出）+ 分页
- Token 格式化：默认 K，>10000K → M，>10000M → B

## 涉及文件

- `src/stream.js` — StreamTransformer.getStats()
- `src/responses-stream.js` — ResponsesStreamTransformer.getStats()
- `desktop/src-electron/data-store.js` — logUsage / getUsage / getUsageDetail
- `desktop/src-electron/proxy-engine.js` — 请求完成后记录用量
- `desktop/standalone.js` — /api/usage 端点
- `desktop/renderer/api.js` — getUsage / getUsageDetail
- `desktop/renderer/pages/UsageTab.jsx` — 用量统计 UI
- `desktop/renderer/App.jsx` — 侧边栏添加用量 Tab

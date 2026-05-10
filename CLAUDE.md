# CCRelay — Anthropic ↔ OpenAI 协议翻译代理

极简的本地代理，把 Claude Code 的 Anthropic Messages 协议翻译为 OpenCode GO Plan 的 OpenAI Chat Completions 协议。零第三方依赖，只用 Node.js 原生模块。

## 技术栈
- 语言: Node.js（≥16）
- 框架: 无，原生 http/https 模块
- 协议: Anthropic Messages API → OpenAI Chat Completions API

## 常用命令
```bash
# 按默认 config.json 启动
node index.js

# 指定配置文件启动
node index.js --config custom-config.json

# 测试非流式请求
curl -X POST http://127.0.0.1:18888/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-any" \
  -d '{"model":"deepseek-v4-pro","max_tokens":256,"stream":false,"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]}]}'

# 测试流式请求
curl -X POST http://127.0.0.1:18888/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-any" \
  -d '{"model":"deepseek-v4-pro","max_tokens":256,"stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]}]}'

# 健康检查
curl http://127.0.0.1:18888/health
```

## 项目结构
- `index.js` — 入口：读取配置，启动 HTTP 服务
- `config.json` — 配置文件（端口、后端地址、API key）
- `src/server.js` — HTTP 服务创建、路由、请求转发
- `src/request.js` — Anthropic 请求 → OpenAI 请求转换
- `src/response.js` — OpenAI 非流式响应 → Anthropic 响应转换
- `src/stream.js` — OpenAI SSE 流 → Anthropic SSE 事件流转换

## 配置示例

```json
{
  "port": 18888,
  "backend": {
    "url": "https://opencode.example.com/zen/go/v1/chat/completions",
    "apiKey": "sk-your-api-key"
  },
  "timeout": 120000
}
```

## Claude Code 接入

在 settings.json 中设置环境变量：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18888",
    "ANTHROPIC_API_KEY": "sk-any-key-will-do"
  }
}
```

## 协议覆盖范围

| 维度 | 状态 |
|------|------|
| POST /v1/messages 非流式 | ✅ |
| POST /v1/messages 流式 | ✅ |
| GET /v1/models | ✅ |
| system 指令 | ✅ |
| tool_use ↔ tool_calls | ✅ |
| reasoning_content → thinking | ✅ |
| thinking → reasoning_content（多轮回传） | ✅ |
| 图片消息 | ✅ |
| usage 映射 | ✅ |
| finish_reason 映射 | ✅ |
| 查询参数兼容（?beta=true） | ✅ |
| GET /v1/messages/count_tokens | ✅ (字符估算) |

## 注意事项
- **零依赖**：不引入任何 npm 包，只用 Node.js 内置模块
- **固定端口**：config.json 配置，不搞随机端口
- **不做路由**：模型名原样透传，不替用户做决策
- **日志即 stdout**：不写临时文件

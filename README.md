# CCRelay

极简的 Anthropic Messages → OpenAI Chat Completions 协议翻译代理。零第三方依赖，只用 Node.js 原生模块。

让 Claude Code 直连 OpenCode 平台的 DeepSeek / GLM 模型。

## 快速开始

```bash
# 1. 复制配置文件，填入真实地址和 key
cp config.example.json config.json

# 2. 编辑 config.json
#    - backend.url: OpenCode 的 chat/completions 地址
#    - backend.apiKey: 你的 API key
#    - models: 你想用的模型列表

# 3. 启动
node index.js
```

## 配置文件示例

```json
{
  "port": 18888,
  "backend": {
    "url": "https://opencode.ai/zen/go/v1/chat/completions",
    "apiKey": "sk-your-api-key-here"
  },
  "timeout": 120000,
  "models": [
    "deepseek-v4-pro",
    "deepseek-v4-flash",
    "glm-5.1"
  ]
}
```

- `config.json` 存真实凭据，已加入 `.gitignore`，不会提交到仓库
- `config.example.json` 是模板，可以安全提交

## Claude Code 接入

在 Claude Code 的 settings.json 中设置环境变量：

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18888",
    "ANTHROPIC_API_KEY": "sk-any-key-will-do"
  }
}
```

`ANTHROPIC_API_KEY` 可以填任意值，ccrelay 不校验。真正的鉴权在 `config.json` 的 `backend.apiKey` 中。

## 协议翻译范围

| 维度 | 说明 |
|------|------|
| `POST /v1/messages` 非流式 | Anthropic content blocks ↔ OpenAI message |
| `POST /v1/messages` 流式 | OpenAI SSE → Anthropic SSE 事件流 |
| `GET /v1/models` | 返回配置文件中的模型列表 |
| `POST /v1/messages/count_tokens` | 字符级 token 估算 |
| `system` 指令 | 顶层 system → messages[0] role=system |
| `tool_use` ↔ `tool_calls` | 请求 & 响应双向转换 |
| `reasoning_content` → `thinking` | 响应中推理内容映射 |
| `thinking` → `reasoning_content` | 多轮对话中回传推理上下文 |
| 图片消息 | base64 图片透传 |

## 测试

```bash
# 健康检查
curl http://127.0.0.1:18888/health

# 非流式
curl -X POST http://127.0.0.1:18888/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-any" \
  -d '{"model":"deepseek-v4-flash","max_tokens":256,"stream":false,"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]}]}'

# 流式
curl -N -X POST http://127.0.0.1:18888/v1/messages \
  -H "Content-Type: application/json" \
  -H "x-api-key: sk-any" \
  -d '{"model":"deepseek-v4-flash","max_tokens":256,"stream":true,"messages":[{"role":"user","content":[{"type":"text","text":"你好"}]}]}'

# 单元测试
node test/unit.test.js
```

## 设计原则

- **零依赖** — 只用 Node.js 内置 `http` / `https` / `fs` / `path` / `crypto`
- **固定端口** — `config.json` 配置，不搞随机端口
- **不做路由** — Claude Code 发什么模型名就转发什么，不替用户做决策
- **日志即 stdout** — 不写临时文件，`console.log` 就够了

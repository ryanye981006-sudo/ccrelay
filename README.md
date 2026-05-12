# CCRelay

Anthropic ↔ OpenAI 协议翻译代理，零第三方依赖，纯 Node.js 原生模块。支持 Claude Code 和 Codex CLI。

## 版本

| 版本 | 入口 | 适用场景 |
|------|------|----------|
| CLI 版 | `index.js` | 单后端，命令行一键启动 |
| Desktop 版 | `desktop/standalone.js` | 多后端路由 + Web 管理界面 |

## CLI 版 — 快速开始

```bash
cp config.example.json config.json
# 编辑 config.json：填写后端地址和 API key
node index.js
```

### 配置示例

```json
{
  "port": 18888,
  "backend": {
    "url": "https://api.example.com/v1/chat/completions",
    "apiKey": "sk-your-api-key"
  },
  "timeout": 120000,
  "models": ["deepseek-v4-pro", "deepseek-v4-flash", "glm-5.1"]
}
```

### Claude Code 接入

```json
{
  "env": {
    "ANTHROPIC_BASE_URL": "http://127.0.0.1:18888",
    "ANTHROPIC_API_KEY": "sk-any"
  }
}
```

## Desktop 版 — 快速开始

Desktop 版支持**多 API 源路由**：通过模型名前缀（`API源名称/模型名称`）将请求转发到不同后端。

```bash
cd desktop
npm install
npx vite build --config vite.config.js   # 构建前端
node standalone.js                        # 启动服务
```

打开 `http://127.0.0.1:18900` 进入管理界面。

### 架构

```
Codex CLI                     Web 管理界面
    │                         http://127.0.0.1:18900
    │                               │
    ▼                               ▼
┌──────────────┐    ┌──────────────────────────┐
│  代理引擎     │◄───│  REST API + 数据层         │
│  :18889      │    │  ~/.ccrelay-desktop/      │
│  协议翻译     │    │  data.json                │
│  前缀路由     │    │  config.toml 写入          │
└──────┬───────┘    └──────────────────────────┘
       │
       │  ProviderName/ModelName → 后端
       ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ API 源 A     │  │ API 源 B     │  │ API 源 C     │
│ OpenAI 协议  │  │ Anthropic    │  │ OpenAI 协议  │
└─────────────┘  └─────────────┘  └─────────────┘
```

### 使用流程

1. **添加 API 源** — 填入名称、API Base URL、API Key，选择协议（OpenAI / Anthropic）
2. **添加模型** — 支持从 API 自动获取或手动输入验证
3. **创建配置** — 每个配置包含一个模型（Codex 限制单模型），可创建多个配置
4. **启用配置** — 点击启用后自动写入 `~/.codex/config.toml`，重启 Codex CLI 生效

### 模型路由

请求中的 `model` 字段使用 `API源名称/模型名称` 格式，代理自动解析前缀并转发到对应后端：

- `model = "DeepSeek/deepseek-v4-pro"` → 转发到 DeepSeek API 源，实际请求 `model: "deepseek-v4-pro"`
- `model = "阿里云/qwen-plus"` → 转发到阿里云 API 源，实际请求 `model: "qwen-plus"`

### Codex CLI 接入

启用配置后，`~/.codex/config.toml` 自动写入：

```toml
model_provider = "custom"
model = "DeepSeek/deepseek-v4-pro"
model_reasoning_effort = "high"
disable_response_storage = true

[model_providers.custom]
name = "custom"
wire_api = "responses"
requires_openai_auth = false
base_url = "http://127.0.0.1:18889"
```

Codex CLI 会向代理发送请求，代理根据 model 前缀路由到正确的 API 源。

## 协议翻译范围

| 维度 | CLI 版 | Desktop 版 |
|------|--------|------------|
| Anthropic Messages → OpenAI Chat Completions | ✅ | ✅ |
| OpenAI Responses API → Chat Completions | ✅ | ✅ |
| 流式 (SSE) 双向转换 | ✅ | ✅ |
| 非流式双向转换 | ✅ | ✅ |
| system 指令映射 | ✅ | ✅ |
| tool_use ↔ tool_calls | ✅ | ✅ |
| reasoning_content → thinking | ✅ | ✅ |
| thinking → reasoning_content（多轮回传） | ✅ | ✅ |
| 图片消息透传 | ✅ | ✅ |
| GET /v1/models | ✅ 静态列表 | ✅ 动态路由键 |
| POST /v1/messages/count_tokens | ✅ | - |
| 多后端前缀路由 | - | ✅ |
| Web 管理界面 | - | ✅ |
| 配置文件自动写入 | - | ✅ |

## API 端点（Desktop 版管理界面）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/providers` | 获取所有 API 源 |
| POST | `/api/providers` | 添加 API 源 |
| PUT | `/api/providers/:id` | 更新 API 源 |
| DELETE | `/api/providers/:id` | 删除 API 源 |
| GET | `/api/models/:providerId` | 获取 API 源下的模型 |
| POST | `/api/models` | 手动添加模型 |
| DELETE | `/api/models/:id` | 删除模型 |
| GET | `/api/config/:category` | 获取配置列表 |
| POST | `/api/config/add` | 新建配置 |
| POST | `/api/config/delete` | 删除配置 |
| POST | `/api/config/add-model` | 向配置添加模型 |
| POST | `/api/config/remove-model` | 从配置移除模型 |
| POST | `/api/config/set-active` | 启用配置（写入配置文件） |
| POST | `/api/test-connection` | 测试 API 源连通性 |
| POST | `/api/fetch-models` | 从 API 获取模型列表 |
| POST | `/api/verify-model` | 验证模型是否可用 |

## 测试

```bash
# CLI 版单元测试
node test/unit.test.js

# Desktop 版端到端测试（需先启动服务）
cd desktop
node standalone.js &
node test-e2e.js
```

## 设计原则

- **零依赖** — 只用 Node.js 内置模块（`http`、`https`、`fs`、`path`）
- **固定端口** — 不搞随机端口，代理 `:18889`，管理界面 `:18900`
- **日志即 stdout** — 不写临时文件，`console.log` 即可
- **原子写入** — 配置文件通过临时文件 + rename 保证不损坏

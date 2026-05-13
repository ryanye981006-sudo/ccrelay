# CCRelay

Anthropic ↔ OpenAI 协议翻译代理。零第三方依赖，纯 Node.js 原生模块。支持多后端前缀路由、Web 管理界面、用量统计。

## 版本

| 版本 | 入口 | 适用场景 |
|------|------|----------|
| CLI 版 | `index.js` | 单后端，命令行一键启动 |
| Desktop 版 | `desktop/standalone.js` | 多后端路由 + Web 管理界面 + 用量统计 |

---

## Desktop 版 — 快速开始

Desktop 版支持**多 API 源路由**：通过模型名前缀（`API源名称/模型名称`）将请求转发到不同后端，提供 Web 管理界面进行可视化配置。

```bash
cd desktop
npm install
npx vite build --config vite.config.js   # 构建前端
node standalone.js                        # 启动服务
```

打开 `http://127.0.0.1:18900` 进入管理界面。

### 架构

```
Claude Code / Codex CLI          Web 管理界面
        │                        http://127.0.0.1:18900
        │                              │
        ▼                              ▼
┌──────────────────┐    ┌──────────────────────────┐
│  代理引擎         │◄───│  REST API + 数据层         │
│  CC :18888       │    │  ~/.ccrelay-desktop/      │
│  Codex :18889    │    │  data.json / usage.json   │
│  协议翻译         │    │  配置文件自动写入           │
│  前缀路由         │    │  用量统计                  │
└──────┬───────────┘    └──────────────────────────┘
       │
       │  ProviderName/ModelName → 后端
       ▼
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ API 源 A     │  │ API 源 B     │  │ API 源 C     │
│ OpenAI 协议  │  │ Anthropic    │  │ OpenAI 协议  │
└─────────────┘  └─────────────┘  └─────────────┘
```

### 使用流程

#### Claude Code（CC Tab）

1. **添加 API 源** — 填入名称、API Base URL、API Key，选择协议
2. **新建 CC 配置** — 创建配置后，为 4 个模型槽位分别选择模型
   - 主模型（`ANTHROPIC_MODEL`）
   - Haiku（`ANTHROPIC_DEFAULT_HAIKU_MODEL`）
   - Sonnet（`ANTHROPIC_DEFAULT_SONNET_MODEL`）
   - Opus（`ANTHROPIC_DEFAULT_OPUS_MODEL`）
3. **启用配置** — 自动写入 `~/.claude/settings.json`（仅修改模型相关 env 字段，不影响其他设置），重启 Claude Code 生效

代理地址：`http://127.0.0.1:18888`

#### Codex CLI（Codex Tab）

1. **新建 Codex 配置** — 每个配置添加一个模型
2. **启用配置** — 自动写入 `~/.codex/config.toml`，重启 Codex 生效

代理地址：`http://127.0.0.1:18889`

### 模型路由

请求中的 `model` 字段使用 `API源名称/模型名称` 格式，代理自动解析前缀并转发：

- `model = "ds/deepseek-v4-pro"` → 转发到 ds API 源，实际请求 `model: "deepseek-v4-pro"`
- `model = "aliyun/qwen-plus"` → 转发到 aliyun API 源，实际请求 `model: "qwen-plus"`

### 用量统计（用量 Tab）

- 按时间范围（当天 / 近7天 / 近30天）筛选
- 模型维度聚合：调用次数 + 总 tokens
- 模型详情：每条请求的输入/缓存输入/输出 tokens，分页展示
- Token 单位自动切换：K → M → B

### API 端点

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/providers` | 获取所有 API 源 |
| POST | `/api/providers` | 添加 API 源 |
| PUT | `/api/providers/:id` | 更新 API 源 |
| DELETE | `/api/providers/:id` | 删除 API 源 |
| GET | `/api/models/:providerId` | 获取 API 源下的模型 |
| POST | `/api/models` | 手动添加模型 |
| DELETE | `/api/models/:id` | 删除模型 |
| GET | `/api/config/:category` | 获取配置列表（`codex` / `claude`） |
| POST | `/api/config/add` | 新建配置 |
| POST | `/api/config/delete` | 删除配置 |
| POST | `/api/config/add-model` | 向配置添加模型（支持槽位） |
| POST | `/api/config/remove-model` | 从配置移除模型 |
| POST | `/api/config/set-active` | 启用配置（写入配置文件） |
| GET | `/api/usage` | 用量聚合（`?range=today\|7d\|30d`） |
| GET | `/api/usage/:modelKey` | 模型用量详情（分页） |
| POST | `/api/test-connection` | 测试 API 源连通性 |
| POST | `/api/fetch-models` | 从 API 获取模型列表 |
| POST | `/api/verify-model` | 验证模型是否可用 |
| GET | `/api/proxy-status` | 代理运行状态 |

---

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

---

## 协议翻译范围

| 维度 | CLI 版 | Desktop 版 |
|------|--------|------------|
| Anthropic Messages → Chat Completions | ✅ | ✅ |
| Responses API → Chat Completions | ✅ | ✅ |
| 流式 (SSE) 双向转换 | ✅ | ✅ |
| 非流式双向转换 | ✅ | ✅ |
| system 指令映射 | ✅ | ✅ |
| tool_use ↔ tool_calls | ✅ | ✅ |
| reasoning_content → thinking | ✅ | ✅ |
| thinking → reasoning_content（多轮回传） | ✅ | ✅ |
| 图片消息透传 | ✅ | ✅ |
| GET /v1/models | ✅ 静态列表 | ✅ 动态路由键 |
| POST /v1/messages/count_tokens | ✅ 字符估算 | ✅ 字符估算 |
| 多后端前缀路由 | - | ✅ |
| Web 管理界面 | - | ✅ |
| CC 4 槽位模型配置 | - | ✅ |
| Codex 配置管理 | - | ✅ |
| 配置文件自动写入 | - | ✅ |
| 用量统计 | - | ✅ |

---

## 项目结构

```
ccrelay/
├── index.js                    # CLI 版入口
├── config.example.json         # CLI 版配置模板
├── src/
│   ├── server.js               # HTTP 服务创建/路由
│   ├── request.js              # Anthropic → OpenAI 请求转换
│   ├── response.js             # OpenAI → Anthropic 响应转换
│   ├── stream.js               # OpenAI SSE → Anthropic SSE 流转换
│   ├── responses.js            # Responses API → Chat Completions 请求转换
│   ├── responses-response.js   # Chat Completions → Responses API 响应转换
│   └── responses-stream.js     # Chat SSE → Responses SSE 流转换
├── test/
│   └── unit.test.js            # CLI 版单元测试
├── docs/                       # 设计文档
└── desktop/
    ├── standalone.js           # Desktop 版入口（独立服务器）
    ├── electron/
    │   ├── main.js             # Electron 主进程
    │   └── preload.js          # 预加载脚本
    ├── src-electron/
    │   ├── data-store.js       # 数据存储层（Provider/Model/Config/Usage）
    │   ├── proxy-engine.js     # 代理引擎（CC + Codex 双端口）
    │   ├── config-writer.js    # Codex 配置写入（TOML）
    │   └── cc-config-writer.js # CC 配置写入（settings.json）
    ├── renderer/
    │   ├── App.jsx             # React 主界面 + 侧边栏
    │   ├── api.js              # REST API 适配层
    │   └── pages/
    │       ├── CCTab.jsx       # CC 4 槽位配置
    │       ├── CodexTab.jsx    # Codex 单模型配置
    │       ├── ProviderTab.jsx # API 源管理 + 模型验证
    │       └── UsageTab.jsx    # 用量统计
    ├── test-e2e.js             # Desktop 版端到端测试
    └── vite.config.js          # Vite 构建配置
```

## 设计原则

- **零依赖** — 协议翻译核心只用 Node.js 内置模块（`http`、`https`、`fs`、`path`）
- **固定端口** — CC `:18888`，Codex `:18889`，管理界面 `:18900`
- **日志即 stdout** — `console.log` 直出，不写临时文件
- **原子写入** — 配置文件通过临时文件 + rename，不损坏已有配置
- **安全写入** — CC 配置写入仅修改 5 个模型相关 env 字段，不动用户其他设置
- **前缀路由** — 模型名 `API源名称/模型名称` 决定转发目标，清晰无歧义

# CCRelay Desktop 产品方案

## 一、项目背景

### 1.1 现有 ccrelay 的局限

ccrelay 是一个极简的 Anthropic ↔ OpenAI 协议翻译代理，功能正确但配置全靠手改 JSON 文件，每次切换模型需要编辑配置文件后重启服务。

### 1.2 对标开源项目调研

| 项目 | Stars | 技术栈 | 定位 |
|---|---|---|---|
| [cc-switch](https://github.com/farion1231/cc-switch) | 68k+ | Tauri(Rust) + React/TS | 桌面客户端：管理 CC/Codex/Gemini 等多工具配置，切换 provider |
| [claude-code-router](https://github.com/musistudio/claude-code-router) | 33k+ | Node.js + TypeScript | CLI 代理 + 模型调度路由器：按场景自动路由到不同模型 |
| [ccrelay](https://github.com/ryanye981006-sudo/ccrelay) | — | Node.js 原生 | 纯协议翻译代理：Anthropic ↔ OpenAI，双端口 CC + Codex |

**核心洞察**：

- cc-switch 是「配置管理器」 — 写配置文件，不做协议翻译
- claude-code-router (ccr) 是「智能路由器」 — 按场景自动调度，用户不直接控制用哪个模型
- ccrelay 是「协议翻译器」 — 缺 GUI、缺模型管理

**产品机会**：做一个桌面客户端，把协议翻译 + 图形化管理 + 手动模型切换整合起来。

### 1.3 与 ccr 的差异化

ccr 的核心是**自动调度**——根据场景（default / background / think / longContext / webSearch）自动选模型。我们要做的恰恰相反：

| | ccr | CCRelay Desktop |
|---|---|---|
| 模型选择方式 | 自动调度（按场景路由） | **手动单选** |
| 用户心智 | "系统帮我选" | "我明确知道当前用哪个模型" |
| 切换机制 | `/model` 命令 + 自定义路由脚本 | **点击选中 → 写入配置** |
| 多工具支持 | 仅面向 CC | **CC + Codex 双分类** |
| 协议翻译 | 内置 transformers | **复用 ccrelay 协议翻译引擎** |

## 二、产品定位

在现有 ccrelay 协议翻译代理基础上，用 Electron 构建桌面客户端。用户通过 GUI 管理 API 源和模型，选择模型后自动写入 CC/Codex 配置文件，内嵌代理负责协议翻译。

**一句话**：现有 ccrelay + Electron 壳 + 模型管理 GUI + 配置写入。

## 三、核心功能

### 3.1 左侧三 Tab 布局

```
┌──────────────────────────────────────────────────────────┐
│  CCRelay Desktop                                 ─  □  ×  │
├────────┬─────────────────────────────────────────────────┤
│        │                                                  │
│  CC    │  根据选中 Tab 显示对应页面                          │
│        │                                                  │
│ Codex  │  CC Tab → Claude Code 模型选择 + 配置写入          │
│        │  Codex Tab → Codex CLI 模型选择 + 配置写入         │
│ API源  │  API源 Tab → 管理 API 接入和模型库                 │
│        │                                                  │
├────────┴─────────────────────────────────────────────────┤
│  ● 代理运行中  |  CC: :18888  |  Codex: :18889            │
└──────────────────────────────────────────────────────────┘
```

### 3.2 CC 分类 — 选择 Claude Code 使用的模型

- 展示已添加到此分类的模型列表
- 当前激活的模型有 ✓ 标记
- 点击模型设为激活态
- 点击「应用配置」→ 写入 `~/.claude/settings.json`（`ANTHROPIC_BASE_URL` 指向本地 :18888）
- 提示用户重启 Claude Code 生效

### 3.3 Codex 分类 — 选择 Codex CLI 使用的模型

- 结构和 CC 分类相同
- 操作的是 Codex 的配置文件
- 代理端口 :18889

### 3.4 API 源管理 — 接入 API 和管理模型

**API 源配置字段**：

| 字段 | 说明 |
|---|---|
| 名称 | 显示名，如 "DeepSeek API" |
| API URL | 完整的 chat/completions 端点 |
| API Key | 密钥，密文存储 |
| 协议 | OpenAI / Anthropic（决定代理如何翻译） |

**模型管理**：
- 每个 API 源下可添加多个模型（模型名）
- 支持增删模型

### 3.5 代理引擎

- 内嵌 ccrelay，启动时自动拉起 :18888 和 :18889 两个端口
- 根据 data.json 中当前激活模型的 Provider 信息（apiBaseUrl、apiKey、protocol）决定后端转发目标
- 三种协议翻译：
  - `openai`：Anthropic Messages ↔ OpenAI Chat Completions
  - `anthropic`：原样透传
  - `codex`：Anthropic Messages ↔ OpenAI Responses API

### 3.6 不做

- ❌ 模型自动调度/智能路由（和 ccr 的核心差异）
- ❌ 热切换（先做配置写入模式，切换需重启 CLI 工具）
- ❌ 用量统计和费用估算
- ❌ 转换器（transformer）
- ❌ 模型标签（thinking/image/context window）
- ❌ 自定义定价

## 四、数据模型

### 4.1 存储

单个 JSON 文件：`~/.ccrelay-desktop/data.json`

### 4.2 结构

```jsonc
{
  "providers": [
    {
      "id": "p-1715400000000",
      "name": "DeepSeek API",
      "apiBaseUrl": "https://api.deepseek.com/chat/completions",
      "apiKey": "sk-xxx",
      "protocol": "openai"
    }
  ],
  "models": [
    {
      "id": "m-1715400000001",
      "providerId": "p-1715400000000",
      "name": "deepseek-chat"
    }
  ],
  "cc": {
    "activeModelId": "m-1715400000001",
    "modelIds": ["m-1715400000001", "m-1715400000002"]
  },
  "codex": {
    "activeModelId": "m-1715400000003",
    "modelIds": ["m-1715400000003"]
  }
}
```

## 五、技术选型

| 层面 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | Electron | 直接复用现有 ccrelay Node.js 代码 |
| 前端 | React + TypeScript | 生态成熟、类型安全 |
| 代理引擎 | 复用 ccrelay `src/` 全部代码 | 协议翻译逻辑不变 |
| 数据存储 | 单个 JSON 文件 | 零依赖，和 ccrelay 风格一致 |
| 打包 | electron-builder | 跨平台安装包 |
| 开源协议 | MIT | 和现有 ccrelay 保持一致 |

## 六、用户使用流程

```
1. 打开 CCRelay Desktop
   → 代理自动启动 (:18888 + :18889)

2. 进入「API源」Tab
   → 添加 API 源（填入 URL、Key、协议）
   → 在 API 源下添加模型名
   → （可选）点击「测试连接」验证

3. 进入「CC」Tab
   → 点击「添加模型」从模型库选取
   → 选中要用的模型
   → 点击「应用配置」
   → 重启 Claude Code

4. 进入「Codex」Tab
   → 同上流程

5. CLI 工具发请求 → 本地代理 → 协议翻译 → 后端 API
```

# CCRelay Desktop 研发方案

## 一、产品概述

在现有 ccrelay 协议翻译代理之上，用 Electron 构建桌面客户端。用户通过 GUI 管理 API 源和模型，选择模型后自动写入 CC/Codex 配置文件，内嵌代理负责协议翻译。

## 二、技术选型

| 层面 | 选型 | 理由 |
|---|---|---|
| 桌面框架 | Electron | 直接复用现有 ccrelay Node.js 代码 |
| 前端 | React + TypeScript | 生态成熟、类型安全 |
| 打包 | electron-builder | Windows/macOS 安装包 |
| 数据存储 | JSON 文件 (`~/.ccrelay-desktop/data.json`) | 零依赖，和 ccrelay 风格一致 |
| 代理引擎 | 复用 ccrelay `src/` 全部代码 | 协议翻译逻辑不变 |

## 三、产品架构

```
┌─────────────────────────────────────────────────────────┐
│                 CCRelay Desktop (Electron)               │
│                                                          │
│  ┌──────────────────────┐  ┌──────────────────────────┐ │
│  │   渲染进程 (React)     │  │    主进程 (Node.js)       │ │
│  │                      │  │                          │ │
│  │  ┌────────────────┐  │  │  ┌────────────────────┐  │ │
│  │  │ CC Tab         │  │  │  │ 数据管理模块        │  │ │
│  │  │  模型列表      │  │  │  │ 读写 data.json     │  │ │
│  │  │  激活切换      │  │  │  │ 读写 CC/Codex 配置  │  │ │
│  │  └────────────────┘  │  │  └────────────────────┘  │ │
│  │  ┌────────────────┐  │  │  ┌────────────────────┐  │ │
│  │  │ Codex Tab      │  │  │  │ 代理引擎            │  │ │
│  │  │  模型列表      │  ├──│→│  │ 复用 ccrelay 代码  │  │ │
│  │  │  激活切换      │  │  │  │ :18888 / :18889    │  │ │
│  │  └────────────────┘  │  │  │ 协议翻译            │  │ │
│  │  ┌────────────────┐  │  │  └────────────────────┘  │ │
│  │  │ API 源 Tab     │  │  │                          │ │
│  │  │  Provider CRUD │  │  │                          │ │
│  │  │  模型 CRUD     │  │  │                          │ │
│  │  └────────────────┘  │  │                          │ │
│  └──────────────────────┘  └──────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

## 四、数据模型

### 4.1 存储文件

```
~/.ccrelay-desktop/
├── data.json         # 核心数据（API源、模型、分类关联）
└── settings.json     # 应用偏好（窗口大小、语言等）
```

### 4.2 data.json 结构

```jsonc
{
  "providers": [
    {
      "id": "p-1715400000000",
      "name": "DeepSeek API",
      "apiBaseUrl": "https://api.deepseek.com/chat/completions",
      "apiKey": "sk-xxx",
      "protocol": "openai"
      // 协议类型: "openai" | "anthropic" | "codex"
      // openai: Anthropic ↔ OpenAI Chat Completions 翻译
      // anthropic: 原样透传（后端已是 Anthropic 协议）
      // codex: Anthropic ↔ OpenAI Responses API 翻译
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

### 4.3 实体关系

```
Provider (API源)  1 ──── N  Model (模型)
                              │
                              │ 多对多（通过 cc.modelIds / codex.modelIds）
                              │
Category (CC / Codex) ────────┘
```

## 五、UI 设计

### 5.1 布局

```
┌──────────────────────────────────────────────────────────┐
│  CCRelay Desktop                                 ─  □  ×  │
├────────┬─────────────────────────────────────────────────┤
│        │                                                  │
│  CC    │  [根据选中 Tab 显示对应页面内容]                    │
│        │                                                  │
│ Codex  │                                                  │
│        │                                                  │
│ API源  │                                                  │
│        │                                                  │
│        │                                                  │
├────────┴─────────────────────────────────────────────────┤
│  ● 代理运行中  |  CC: localhost:18888  |  Codex: localhost:18889 │
└──────────────────────────────────────────────────────────┘
```

### 5.2 CC Tab

```
┌────────────────────────────────────────────┐
│  CC — Claude Code                          │
│                                            │
│  当前激活模型                                │
│  ┌──────────────────────────────────────┐  │
│  │ ● deepseek-v4-pro                    │  │
│  │   DeepSeek API                       │  │
│  │   协议: OpenAI                        │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  已添加的模型                               │
│  ┌──────────────────────────────────────┐  │
│  │ ● deepseek-v4-pro          ✓ 当前   │  │
│  │ ○ gpt-5                             │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  [+ 添加模型]     [应用配置]                 │
│                                            │
│  提示: 切换模型后需重启 Claude Code 生效      │
└────────────────────────────────────────────┘
```

**交互**：
- 点击模型行 → 设为激活态（本地标记，内存中生效）
- 点击「应用配置」→ 写入 CC 的 settings.json
- [+ 添加模型] → 弹出模型选择器（数据来自 API 源 Tab）

### 5.3 Codex Tab

结构同 CC Tab，操作的是 Codex 的配置文件。

### 5.4 API 源 Tab

```
┌────────────────────────────────────────────┐
│  API 源管理                                 │
│                                            │
│  ┌──────────────────────────────────────┐  │
│  │ 📡 DeepSeek API                      │  │
│  │    https://api.deepseek.com          │  │
│  │    协议: OpenAI                       │  │
│  │    模型: deepseek-chat, deepseek-...  │  │
│  │                          [编辑][删除] │  │
│  ├──────────────────────────────────────┤  │
│  │ 📡 OpenRouter                        │  │
│  │    https://openrouter.ai/api/v1      │  │
│  │    协议: OpenAI                       │  │
│  │    模型: claude-sonnet-4, gemini...   │  │
│  │                          [编辑][删除] │  │
│  └──────────────────────────────────────┘  │
│                                            │
│  [+ 添加 API 源]                            │
└────────────────────────────────────────────┘
```

**添加/编辑 API 源弹窗**：

```
┌────────────────────────────────────┐
│  添加 API 源                        │
│                                    │
│  名称:     [DeepSeek API      ]    │
│  API URL:  [https://api.deep..]    │
│  API Key:  [sk-************  ]     │
│  协议:     [OpenAI ▼]             │
│            OpenAI / Anthropic       │
│                                    │
│  模型列表:                          │
│  ┌────────────────────────────┐    │
│  │ deepseek-chat        [删除]│    │
│  │ deepseek-reasoner    [删除]│    │
│  │ [+ 添加模型]               │    │
│  └────────────────────────────┘    │
│                                    │
│            [测试连接]  [保存]       │
└────────────────────────────────────┘
```

## 六、代理引擎

### 6.1 配置文件写入（cc-switch 模式）

切换模型的核心流程：

```
用户在 UI 选择模型 → 点击「应用配置」
  │
  ├─→ 更新 data.json (cc.activeModelId)
  │
  ├─→ 写入 CC settings.json:
  │   {
  │     "env": {
  │       "ANTHROPIC_BASE_URL": "http://127.0.0.1:18888",
  │       "ANTHROPIC_API_KEY": "sk-any"
  │     }
  │   }
  │
  └─→ 提示用户重启 Claude Code
```

代理引擎启动时读取 data.json，根据当前激活模型的 Provider 信息决定后端转发目标。

### 6.2 协议翻译路由

```
请求到达 :18888 (CC 端口) / :18889 (Codex 端口)
  │
  ├─→ 查找 data.json 中对应分类的 activeModelId
  │
  ├─→ 根据 model.providerId 找到 Provider
  │
  ├─→ 根据 Provider.protocol 决定翻译策略:
  │   ├─ "anthropic" → 原样透传
  │   ├─ "openai"    → Anthropic Messages ↔ OpenAI Chat Completions
  │   └─ "codex"     → Anthropic Messages ↔ OpenAI Responses API
  │
  ├─→ 转发到 Provider.apiBaseUrl + Provider.apiKey
  │
  └─→ 翻译响应 → 返回客户端
```

### 6.3 代码复用

| 现有文件 | 用途 | 改动 |
|---|---|---|
| `src/request.js` | Anthropic 请求 → OpenAI 请求 | 不改 |
| `src/response.js` | OpenAI 响应 → Anthropic 响应 | 不改 |
| `src/stream.js` | OpenAI SSE → Anthropic SSE | 不改 |
| `src/responses.js` | Anthropic 请求 → OpenAI Responses 请求 | 不改 |
| `src/responses-response.js` | Responses 响应 → Anthropic 响应 | 不改 |
| `src/responses-stream.js` | Responses SSE → Anthropic SSE | 不改 |
| `src/server.js` | HTTP 服务 + 路由 | 改造：不从 config.json 读配置，改为从 data.json 读 |
| `index.js` | 入口 | 替换为 Electron 主进程入口 |

## 七、IPC 接口设计

渲染进程 ←→ 主进程通信接口：

```typescript
// ===== API 源管理 =====
// 获取所有 API 源
getProviders() → Provider[]

// 添加 API 源
addProvider(data: CreateProviderDTO) → Provider

// 编辑 API 源
updateProvider(id: string, data: UpdateProviderDTO) → Provider

// 删除 API 源（同时删除关联模型和分类引用）
deleteProvider(id: string) → void

// 测试连接
testProviderConnection(id: string) → { ok: boolean; error?: string }

// ===== 模型管理 =====
// 获取某 API 源下的模型列表
getModels(providerId: string) → Model[]

// 添加模型
addModel(providerId: string, name: string) → Model

// 删除模型（同时删除分类引用）
deleteModel(id: string) → void

// ===== 分类管理 =====
// 获取某分类的模型列表
getCategoryModels(category: 'cc' | 'codex') → CategoryModel[]

// 将模型加入分类
addModelToCategory(category: 'cc' | 'codex', modelId: string) → void

// 从分类移除模型
removeModelFromCategory(category: 'cc' | 'codex', modelId: string) → void

// 切换激活模型
setActiveModel(category: 'cc' | 'codex', modelId: string) → void

// 应用配置（写入 CC/Codex 配置文件）
applyConfig(category: 'cc' | 'codex') → void

// ===== 代理引擎 =====
// 获取代理状态
getProxyStatus() → { running: boolean; ccPort: number; codexPort: number }
```

## 八、项目目录结构

```
ccrelay-desktop/
├── package.json                  # 项目配置 + electron-builder 打包配置
├── tsconfig.json
├── electron/
│   ├── main.ts                   # Electron 主进程入口（原 index.js 逻辑）
│   ├── preload.ts                # contextBridge 暴露 IPC 给渲染进程
│   └── ipc/
│       ├── provider-ipc.ts       # API 源 CRUD IPC 处理
│       ├── model-ipc.ts          # 模型 CRUD IPC 处理
│       ├── category-ipc.ts       # 分类关联 + 配置写入 IPC 处理
│       └── proxy-ipc.ts          # 代理引擎启停 IPC 处理
├── src/                          # 复用现有 ccrelay 代码（不改）
│   ├── server.js
│   ├── request.js
│   ├── response.js
│   ├── stream.js
│   ├── responses.js
│   ├── responses-response.js
│   └── responses-stream.js
├── src-electron/
│   ├── data-store.ts             # data.json 读写封装
│   ├── config-writer.ts          # CC/Codex 配置文件写入
│   └── proxy-engine.ts           # 封装代理引擎启停 + 动态后端配置
├── renderer/
│   ├── index.html
│   ├── index.tsx                 # React 入口
│   ├── App.tsx                   # 路由 + 布局（3 Tab）
│   ├── pages/
│   │   ├── CcTab.tsx             # CC 分类页
│   │   ├── CodexTab.tsx          # Codex 分类页
│   │   └── ProviderTab.tsx       # API 源管理页
│   ├── components/
│   │   ├── Layout.tsx            # 左侧 Tab + 内容区 + 底部状态栏
│   │   ├── ModelList.tsx         # 模型列表（CC/Codex 页复用）
│   │   ├── ActiveModelCard.tsx   # 当前激活模型卡片
│   │   ├── ProviderList.tsx      # API 源列表
│   │   ├── ProviderForm.tsx      # API 源添加/编辑表单弹窗
│   │   ├── AddModelDialog.tsx    # 添加模型弹窗（CC/Codex 页复用）
│   │   └── StatusBar.tsx         # 底部代理状态栏
│   └── hooks/
│       └── useIpc.ts             # IPC 调用封装 hook
└── config.json                   # 默认配置（首次启动写入）
```

## 九、组件树

```
App
├── Layout
│   ├── Sidebar
│   │   ├── Tab("CC")
│   │   ├── Tab("Codex")
│   │   └── Tab("API源")
│   ├── Content (根据选中 Tab 渲染)
│   │   ├── CcTab
│   │   │   ├── ActiveModelCard
│   │   │   ├── ModelList
│   │   │   │   └── ModelItem[] (点击选中 / ✓当前)
│   │   │   ├── Button("添加模型") → AddModelDialog
│   │   │   └── Button("应用配置")
│   │   ├── CodexTab
│   │   │   ├── ActiveModelCard
│   │   │   ├── ModelList
│   │   │   │   └── ModelItem[]
│   │   │   ├── Button("添加模型") → AddModelDialog
│   │   │   └── Button("应用配置")
│   │   └── ProviderTab
│   │       ├── ProviderList
│   │       │   └── ProviderItem[] (可展开模型列表 / 编辑 / 删除)
│   │       └── Button("添加API源") → ProviderForm
│   └── StatusBar
│       ├── 代理状态指示灯
│       ├── CC 端口信息
│       └── Codex 端口信息
├── AddModelDialog (全局弹窗)
└── ProviderForm (全局弹窗)
```

## 十、数据流

```
                    ┌──────────────┐
                    │  data.json   │
                    │  (主进程)     │
                    └──────┬───────┘
                           │
          ┌────────────────┼────────────────┐
          ▼                ▼                ▼
    ┌──────────┐   ┌──────────────┐   ┌──────────┐
    │ CC Tab   │   │ Codex Tab    │   │ API源 Tab│
    │ 读: cc   │   │ 读: codex    │   │ 读/写:   │
    │ 写: cc.  │   │ 写: codex.   │   │ providers│
    │ activeId │   │ activeId     │   │ models   │
    └──────────┘   └──────────────┘   └──────────┘
         │               │
         │ 点击「应用配置」  │
         ▼               ▼
   ┌─────────────────────────────┐
   │  写入 CC / Codex 配置文件     │
   │  CC: ~/.claude/settings.json │
   │  Codex: ~/.codex/config.json │
   └─────────────────────────────┘
         │
         │ 用户重启 CLI 工具
         ▼
   ┌─────────────────────────────┐
   │  CC/Codex 请求 → 本地代理     │
   │  :18888 / :18889            │
   │  ↓                          │
   │  代理读取 data.json          │
   │  获取当前激活的 Provider      │
   │  ↓                          │
   │  协议翻译 → 转发后端          │
   └─────────────────────────────┘
```

## 十一、开发阶段

### Phase 1：Electron 骨架 + 主进程数据层

**目标**：Electron 项目搭建，数据层跑通

- 初始化 Electron + React + TypeScript 项目
- 实现 `data-store.ts`：data.json 读写（首次自动生成默认文件）
- 实现 Provider + Model 的 CRUD
- 实现 IPC 通道：`getProviders` / `addProvider` / `updateProvider` / `deleteProvider` / `getModels` / `addModel` / `deleteModel`
- 实现 IPC 通道：`getCategoryModels` / `addModelToCategory` / `removeModelFromCategory` / `setActiveModel`

### Phase 2：前端 UI 三页面

**目标**：3 个 Tab 页面完整可用

- Layout 布局（侧边栏 + 内容区 + 状态栏）
- API 源 Tab：ProviderList + ProviderForm（添加/编辑弹窗）
- CC Tab：ActiveModelCard + ModelList + 「添加模型」弹窗 + 「应用配置」
- Codex Tab：同 CC Tab

### Phase 3：代理引擎集成 + 配置文件写入

**目标**：嵌入 ccrelay，实现配置写入，验证端到端

- 实现 `proxy-engine.ts`：封装 ccrelay server 启停，从 data.json 读取当前激活的 Provider
- 实现 `config-writer.ts`：写入 CC settings.json / Codex 配置
- 「应用配置」按钮逻辑：写配置 → 提示重启
- 端到端验证：选模型 → 写配置 → CC 请求 → 代理翻译 → 后端

### Phase 4：连接测试 + 体验优化 + 打包

**目标**：打磨细节，发布安装包

- 「测试连接」按钮：发一个最小请求验证连通性
- 首次启动向导：自动写入默认 CC/Codex 配置
- 错误提示、API Key 密文显示/隐藏
- electron-builder 打包（Windows .exe / macOS .dmg）

## 十二、关键设计决策

| 决策 | 结论 | 原因 |
|---|---|---|
| 切换方式 | 写入配置文件 | 先不做热切换，降低复杂度 |
| 代理翻译 | 根据 Provider.protocol 自动选择 | 三种协议需要正确路由 |
| 数据存储 | 单个 data.json | 零依赖、易调试、和 ccrelay 风格一致 |
| 不引入转换器 | Provider 无 transformer 字段 | 用户不需要，协议类型已足够 |
| 不做用量统计 | 无 usage_logs 表 | 用户明确不需要 |
| 协议 | MIT | 和现有 ccrelay 保持一致 |

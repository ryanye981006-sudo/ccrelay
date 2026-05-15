# context_window 上下文窗口配置探索

## 问题

Claude Code 的 `/context` 命令显示 **25.3k / 200k**，而非预期的 **950k**。DeepSeek V4 支持 1000K，配置了但未生效。

## 探索路径

### 1. 最初假设：`/v1/models` 端点返回 `context_window`

**方法**：settings.json 中移除 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC`，让 CC 自由查询 `/v1/models`。

**结果**：
- proxy 的 `/v1/models` 端点正常返回 `context_window: 950000`
- 但 CC **完全不调用 `/v1/models`** — proxy.log 中没有任何 `GET /v1/models` 请求
- 移除 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` 后 CC 也只会 `POST /v1/messages` 和 `POST /v1/messages/count_tokens`，不走 models 端点

**结论**：Claude Code v2.1 根本不查模型列表。

---

### 2. 假设：`CLAUDE_CODE_MAX_CONTEXT_TOKENS` 环境变量覆盖

**方法**：在 settings.json 的 `env` 区设置 `"CLAUDE_CODE_MAX_CONTEXT_TOKENS": "950000"`。

**结果**（两次验证）：
- settings.json `env` → CC 进程环境变量传递是正常的（`ANTHROPIC_BASE_URL`、`ANTHROPIC_MODEL` 等都在 `env` 输出中）
- `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 在 `env` 输出中也出现
- 但 `/context` 仍显示 **200k**
- 用 OS 环境变量 `CLAUDE_CODE_MAX_CONTEXT_TOKENS=950000` 直接启动 claude CLI，也显示 **200k**
- 尝试替代名 `MAX_CONTEXT_TOKENS=950000` — 同样无效

**结论**：CC v2.1 不识别 `CLAUDE_CODE_MAX_CONTEXT_TOKENS` 这个变量（可能已被移除或改名）。

---

### 3. 假设：桌面应用自动写入配置 = 正解

**发现**：`desktop/src-electron/cc-config-writer.js:68` 在启动时会写入：
```js
config.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '950000';
```

**结果**：
- 这段话说明开发者认为这是 workaround
- 但 CC v2.1 根本不认这个变量，即使写入也无效
- 桌面应用的用户配置会导致 settings.json 的值被覆盖（手动改的会被 clobber）

---

### 4. 尝试二进制逆向搜索真正的变量名

**方法**：`strings claude.exe | grep context`

**结果**：二进制 226MB 可能被压缩/混淆，搜索不到任何 context 相关字符串。

---

### 5. 发现关键文件：`claude-code-settings.schema.json`

**路径**：`C:\Users\76828\.cursor\extensions\anthropic.claude-code-2.1.137-win32-x64\claude-code-settings.schema.json`

**发现**：
- 存在 `autoCompactWindow` 设置（integer，范围 100000~1000000），但这只是自动压缩窗口大小，不是上下文窗口上限
- 需要进一步搜索此文件，确认是否存在 `maxContextTokens`、`maxTokens`、`contextWindow` 等设置项
- 此文件中应有完整的 settings schema，能告诉我们正确的配置字段名

**结果**：文件约 27000 tokens，尚未读完。搜索到 `autoCompactWindow` 和 `autoCompactEnabled`，但仍需确认是否有直接设置最大上下文的字段。

---

### 6. 桌面应用的 `cc-config-writer.js` 机制

**路径**：`desktop/src-electron/cc-config-writer.js`

写入 settings.json 的内容：
```js
const DEFAULT_CC_CONFIG = {
  env: {
    ANTHROPIC_BASE_URL: 'http://127.0.0.1:18888',
    ANTHROPIC_MODEL: '',
    ANTHROPIC_DEFAULT_HAIKU_MODEL: '',
    ANTHROPIC_DEFAULT_SONNET_MODEL: '',
    ANTHROPIC_DEFAULT_OPUS_MODEL: '',
    CLAUDE_CODE_MAX_CONTEXT_TOKENS: '950000'
  }
};
```

在 line 68 又写一次：
```js
config.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '950000';
```

调用时机：`electron/main.js:109,131` 和 `ui-server.js:118,143` — 桌面应用启动 / 前端配置变更时

**问题**：此值对 CC v2.1 无效，但仍被写入 settings.json。已经是一个无效的 workaround。

---

## 已验证不可行

| 方法 | 结果 |
|------|------|
| `/v1/models` 返回 `context_window` | CC v2.1 不调此接口 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` env（settings.json） | 不生效 |
| `CLAUDE_CODE_MAX_CONTEXT_TOKENS` env（OS 环境变量） | 不生效 |
| `MAX_CONTEXT_TOKENS` env | 不生效 |
| 移除 `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` | 无效果 |

## 待尝试

1. **读完 `claude-code-settings.schema.json`** — 找到真正的 context window 配置字段名（可能是 `maxContextTokens`、`contextWindow`、`maxTokens` 或其他名字）

2. **查看 `autoCompactWindow`** — 确认这个字段是否就是上下文窗口上限，还仅是自动压缩阈值

3. **CC v2.1 是否通过 API 响应确定上下文窗口** — 即 CC 是否根据模型返回的 `usage` 或其他字段来推算上限

4. **模型名称映射** — CC 可能对已知模型名有内置的上下文窗口表，自定义模型（如 `goplan/deepseek-v4-pro`）默认用 200k。是否可以伪装成已知模型名

5. **`--settings` CLI 参数** — 测试直接指定 settings 文件能否覆盖某些值

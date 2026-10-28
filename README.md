# dev-workflow-mcp

> 一个把「需求处理流程」变成强制状态机的 MCP server：`clarify → awaiting_confirm → implementing → review → done`，用工具调用而不是自觉来约束 AI 什么时候能改文件。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![mcp](https://img.shields.io/badge/MCP-stdio-8A2BE2)

## 这是什么

AI 编码助手最容易出问题的地方，不是不会写代码，而是**没搞清楚需求就动手改文件**。

`dev-workflow-mcp` 把需求处理拆成五个阶段，并且用 `canModifyFiles` 标记每个阶段是否允许写文件。AI 每次调用 `edit` / `write` 之前必须先问一次 `assert_can_modify()`，不通过就得停下来，先回去梳理需求、等用户确认。

状态持久化在本地 JSON 文件里，跨会话、跨重启都不丢。

## 状态机

| # | 步骤 | 含义 | 允许改文件 |
|---|---|---|---|
| 0 | `clarify` | 需求梳理：只读源码，输出涉及文件 / 影响面 / 方案 / 风险 | 否 |
| 1 | `awaiting_confirm` | 等待用户确认梳理结果 | 否 |
| 2 | `implementing` | 按确认后的方案修改文件 | **是** |
| 3 | `review` | 关联检查：核对改动的全部引用方，可修复发现的问题 | **是** |
| 4 | `done` | 完成 | 否 |

## 提供的工具

| 工具 | 参数 | 作用 |
|---|---|---|
| `get_current_step` | — | 返回当前步骤、序号、描述、`canModifyFiles`、更新时间 |
| `set_step` | `step`（枚举） | 切换到任意步骤，用于回退或跳步 |
| `advance` | — | 顺序进入下一步；已在最后一步时返回提示而非报错 |
| `reset` | — | 重置回 `clarify`，接到新需求时使用 |
| `assert_can_modify` | — | 写文件前的强约束断言，不允许时返回 `isError` |
| `list_workflow` | — | 列出全部步骤定义与当前所处位置 |

所有工具调用都被内部队列串行化，避免并发读写状态文件造成竞态。

## 安装

```bash
git clone https://github.com/zhouqi-7/dev-workflow-mcp.git
cd dev-workflow-mcp
npm install
```

`node_modules` 只有两个运行时依赖：`@modelcontextprotocol/sdk` 与 `zod`。

## 接入客户端

### OpenCode

编辑 `~/.config/opencode/opencode.json`（Windows 为 `C:\Users\<用户名>\.config\opencode\opencode.json`）：

```json
{
  "mcp": {
    "dev-workflow": {
      "type": "local",
      "command": ["node", "C:/Users/<用户名>/.config/opencode/workflow-mcp/index.js"]
    }
  }
}
```

### Claude Desktop

编辑 `claude_desktop_config.json`：

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["C:/Users/<用户名>/.config/opencode/workflow-mcp/index.js"]
    }
  }
}
```

重启客户端后，在工具列表里应该能看到 `dev-workflow` 的 6 个工具。

## 状态文件

运行状态写在：

```
~/.config/opencode/workflow-state.json
```

内容形如：

```json
{
  "currentStep": "clarify",
  "updatedAt": "2026-10-28T09:12:33.000Z",
  "history": [
    { "from": "clarify", "to": "awaiting_confirm", "at": "2026-10-28T09:12:33.000Z" }
  ]
}
```

`history` 最多保留最近 50 条。文件损坏时会自动回退到默认状态，不会让服务崩溃。这个文件属于使用者本地数据，已在 `.gitignore` 中排除。

## 目录结构

```
workflow-mcp/
├── index.js            # 服务入口，stdin/stdout stdio 传输
├── package.json
├── .gitignore
├── LICENSE
└── README.md
```

## License

[MIT](./LICENSE) © 2026 zhouqi-7

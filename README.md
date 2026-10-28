# dev-workflow-mcp

> 一个把「需求处理流程」变成强制状态机的 MCP server：`clarify → awaiting_confirm → implementing → review → done`，用工具调用而不是自觉来约束 AI 什么时候能改文件。
>
> 它与 `chrome-devtools-mcp` 搭配使用：**流程约束由它负责，页面效果的自动化验证交给浏览器**。

![license](https://img.shields.io/badge/license-MIT-blue.svg)
![node](https://img.shields.io/badge/node-%3E%3D18-brightgreen)
![mcp](https://img.shields.io/badge/MCP-stdio-8A2BE2)
![chrome-devtools](https://img.shields.io/badge/chrome--devtools-必需-4285F4)

## 这是什么

AI 编码助手最容易出问题的地方，不是不会写代码，而是**没搞清楚需求就动手改文件**。

`dev-workflow-mcp` 把需求处理拆成五个阶段，并且用 `canModifyFiles` 标记每个阶段是否允许写文件。AI 每次调用 `edit` / `write` 之前必须先问一次 `assert_can_modify()`，不通过就得停下来，先回去梳理需求、等用户确认。

状态持久化在本地 JSON 文件里，跨会话、跨重启都不丢。

但它只解决「什么时候可以动手」，不解决「改完到底对不对」。后者交给 `chrome-devtools-mcp`：AI 自己打开浏览器，走完整个业务流程，截图给你确认，人不用手动点任何一下。

## 状态机

| # | 步骤 | 含义 | 允许改文件 |
|---|---|---|---|
| 0 | `clarify` | 需求梳理：只读源码，输出涉及文件 / 影响面 / 方案 / 风险 | 否 |
| 1 | `awaiting_confirm` | 等待用户确认梳理结果 | 否 |
| 2 | `implementing` | 按确认后的方案修改文件 | **是** |
| 3 | `review` | 关联检查：核对改动的全部引用方，并在浏览器里跑一遍完整流程截图验证 | **是** |
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

## 配合 chrome-devtools 使用

`dev-workflow-mcp` 管的是流程纪律，它看不见页面。如果只挂这一个 MCP，`review` 阶段就只能靠读代码猜效果——这正是幻觉最喜欢钻的空子。

所以它被设计成**必须与浏览器 MCP 配合**使用，推荐 `chrome-devtools-mcp`：让 AI 在流程的每个节点都能真实地打开页面、操作界面、截图核对。

### 职责分工

| 能力 | dev-workflow-mcp | chrome-devtools-mcp |
|---|---|---|
| 推进 / 回退流程阶段 | ✅ | — |
| 拦截未确认就写文件 | ✅ | — |
| 提供「停下等人确认」的断点 | ✅ | — |
| 打开页面、导航、刷新 | — | ✅ |
| 点击按钮、填写表单、登录 | — | ✅ |
| 截图取证、读取控制台报错 | — | ✅ |

### 一次完整的需求闭环

以「给系统加一个表格字段」为例，两个 MCP 交替接管：

| 阶段 | 谁在干活 | 具体动作 |
|---|---|---|
| `clarify` | dev-workflow | AI 只读代码，输出涉及文件、影响面、方案、风险 |
| `awaiting_confirm` | chrome-devtools + dev-workflow | AI 打开页面截当前状态图，连同方案一起给你，流程停在这里等你点头 |
| `implementing` | dev-workflow | 用户批准后才允许 `edit` / `write` |
| `review` | chrome-devtools | AI 重新打开页面，自动走完整业务链路：登录 → 进入菜单 → 点新建 → 填字段 → 保存 → 查列表，逐步截图并读控制台报错 |
| `done` | dev-workflow | 截图与预期一致，收尾 |

### 浏览器全程由 AI 操作

这是这套组合最关键的一点：**验证过程没有人工介入的中间环节**。

- 打开哪个页面、点哪个按钮、填什么值，由 AI 根据 `clarify` 阶段确认过的方案自己决定；
- 遇到登录、弹窗、二次确认、异步加载，AI 通过浏览器工具自己处理，不会卡在「请手动点一下」；
- 页面出问题不看截图猜，直接读控制台日志定位，必要时用脚本读取 DOM 状态；
- 人只在 `awaiting_confirm` 看一眼截图、说一句「可以」，剩下的从执行到验收全部自动化。

带来的变化很直接：验收标准从「AI 说改好了」变成「截图在这里，整条业务流程跑通了」。

### 同时挂载两个 MCP

OpenCode（`~/.config/opencode/opencode.json`，Windows 为 `C:\Users\<用户名>\.config\opencode\opencode.json`）：

```json
{
  "mcp": {
    "dev-workflow": {
      "type": "local",
      "command": ["node", "C:/Users/<用户名>/.config/opencode/workflow-mcp/index.js"]
    },
    "chrome-devtools": {
      "type": "local",
      "command": ["npx", "-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

Claude Desktop（`claude_desktop_config.json`）：

```json
{
  "mcpServers": {
    "dev-workflow": {
      "command": "node",
      "args": ["C:/Users/<用户名>/.config/opencode/workflow-mcp/index.js"]
    },
    "chrome-devtools": {
      "command": "npx",
      "args": ["-y", "chrome-devtools-mcp@latest"]
    }
  }
}
```

`chrome-devtools-mcp` 通过 `npx` 拉取最新版，无需预装依赖，首次启动会自动下载。

## 安装

```bash
git clone https://github.com/wow-monkey/dev-workflow-mcp.git
cd dev-workflow-mcp
npm install
```

本项目自身只有两个运行时依赖：`@modelcontextprotocol/sdk` 与 `zod`。浏览器能力由 `chrome-devtools-mcp` 提供，两者互不耦合，删掉其中一个另一个仍可独立运行。

## 接入客户端

下面是最小配置，只挂流程约束。要与浏览器验证配合使用，参考上一节的完整版本。

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

[MIT](./LICENSE) © 2026 wow-monkey
